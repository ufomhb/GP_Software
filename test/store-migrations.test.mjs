/**
 * Schema 版本与增量迁移回归测试（2026-11-17，方案 A）
 *
 * 覆盖四种必须成立的行为：
 *  1. 新库 / 结构完整的老库 → 认领为当前 SCHEMA_VERSION；
 *  2. 结构有缺的老库 → 不写版本号（让部署核对继续报错，不被版本号掩盖）；
 *  3. 有待执行迁移 → 按版本号依次执行，结构跟上；
 *  4. 迁移中途失败 → 整条回滚（版本号与结构都不留痕），下次启动可重试。
 *
 * 这里只测 runMigrations（纯函数式，传自己的库句柄），不去碰 data/gp.sqlite。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const store = require('../lib/store.js');
const { DatabaseSync } = require('node:sqlite');

function withDb(name, mutate, fn) {
  const dir = mkdtempSync(join(tmpdir(), `gp-mig-${name}-`));
  const file = join(dir, 'gp.sqlite');
  const db = new DatabaseSync(file);
  db.exec(store.SCHEMA);
  if (mutate) mutate(db);
  try {
    return fn(db, file);
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

function version(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name)).includes(column);
}

test('迁移：全新库直接认领为当前版本', () => {
  withDb('fresh', null, (db) => {
    const report = store.runMigrations(db);
    assert.equal(report.adopted, true, '新库应被认领');
    assert.equal(version(db), store.SCHEMA_VERSION);
    assert.equal(report.warnings.length, 0);
  });
});

test('迁移：结构完整的老库（版本号仍为 0）被认领', () => {
  withDb('legacy', null, (db) => {
    assert.equal(version(db), 0, '建表后版本号应为 0');
    const report = store.runMigrations(db);
    assert.equal(report.adopted, true);
    assert.equal(version(db), store.SCHEMA_VERSION);
  });
});

test('迁移：结构有缺的老库不写版本号', () => {
  withDb('drift', (db) => {
    db.exec('ALTER TABLE users DROP COLUMN login_count');
  }, (db) => {
    const report = store.runMigrations(db);
    assert.equal(report.adopted, false, '有结构漂移时不应认领版本');
    assert.equal(version(db), 0, '版本号必须保持 0，让部署核对继续报错');
    assert.ok(report.warnings.length > 0);
    assert.match(report.warnings.join(' '), /漂移/);
  });
});

test('迁移：按版本号依次执行待迁移项', () => {
  withDb('apply', null, (db) => {
    // 先认领到 v1
    store.runMigrations(db);
    assert.equal(version(db), 1);

    const migrations = [
      { version: 3, name: 'v3 不该在这一步执行', sql: ['ALTER TABLE users ADD COLUMN c3 TEXT'] },
      { version: 2, name: '给 users 加 note 列', sql: ["ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT ''"] },
    ];
    const report = store.runMigrations(db, { migrations, targetVersion: 3 });
    assert.deepEqual(report.applied.map((a) => a.version), [2, 3], '应按版本号升序执行');
    assert.equal(version(db), 3);
    assert.ok(hasColumn(db, 'users', 'note'));
    assert.ok(hasColumn(db, 'users', 'c3'));
    // 注意：这里只加了迁移、没改 SCHEMA，于是线上库相对 SCHEMA 多出两列。
    // 结构对照会把它归为「多余列（无害）」——也正是下面那条守卫测试要防的疏漏。
    const extra = store.schemaDrift(db).extraColumns.map((c) => `${c.table}.${c.column}`);
    assert.ok(extra.includes('users.note'), `应被识别为多余列：${extra.join('、')}`);
  });
});

test('迁移：每条迁移加的列都必须同时出现在 SCHEMA 里', () => {
  // 防「改了 MIGRATIONS 忘了改 SCHEMA」：否则老库升级后能跑，全新安装反而缺列。
  const { DatabaseSync } = require('node:sqlite');
  const probe = new DatabaseSync(':memory:');
  probe.exec(store.SCHEMA);
  try {
    for (const migration of store.MIGRATIONS) {
      const statements = Array.isArray(migration.sql) ? migration.sql : migration.sql ? [migration.sql] : [];
      for (const sql of statements) {
        const m = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)/i.exec(String(sql));
        if (!m) continue;
        const [, table, column] = m;
        const cols = probe.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
        assert.ok(
          cols.includes(column),
          `迁移 v${migration.version} 给 ${table} 加了列 ${column}，但 SCHEMA 里没有它（全新安装会缺这一列）`,
        );
      }
    }
  } finally {
    probe.close();
  }
});

test('迁移：中途失败整条回滚，版本号不动', () => {
  withDb('fail', null, (db) => {
    store.runMigrations(db);
    assert.equal(version(db), 1);

    const migrations = [{
      version: 2,
      name: '故意失败',
      sql: ['CREATE TABLE tmp_probe (x INTEGER)'],
      run: () => { throw new Error('boom'); },
    }];

    assert.throws(() => store.runMigrations(db, { migrations, targetVersion: 2 }), /boom/);
    assert.equal(version(db), 1, '失败后版本号必须保持不变');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    assert.ok(!tables.includes('tmp_probe'), '失败迁移里建的表必须被回滚掉');
  });
});

test('迁移：库版本高于代码期望时只告警不降级', () => {
  withDb('ahead', (db) => {
    db.exec('PRAGMA user_version = 9');
  }, (db) => {
    const report = store.runMigrations(db, { targetVersion: 5 });
    assert.equal(report.applied.length, 0);
    assert.equal(version(db), 9, '不应把版本号往下改');
    assert.match(report.warnings.join(' '), /高于/);
  });
});

test('状态查询：库文件存在就报告 hasDb（不受 STORE 环境变量影响）', () => {
  // 回归：曾经按 MODE==='json' 短路，导致 SSH 会话里跑迁移脚本时
  // 明明 NAS 上有库却被判成「没有库、无需迁移」，迁移被静默跳过。
  const dir = mkdtempSync(join(tmpdir(), 'gp-schema-status-'));
  const file = join(dir, 'gp.sqlite');
  const db = new DatabaseSync(file);
  db.exec(store.SCHEMA);
  db.close();
  try {
    assert.equal(store.mode, 'json', '测试进程本身是 json 模式，正好复现 NAS SSH 会话的处境');
    const status = store.schemaStatus(file);
    assert.equal(status.hasDb, true, '库文件存在时必须报告 hasDb');
    assert.equal(status.currentVersion, 0, '新建库版本号为 0，等待认领');
    assert.equal(status.targetVersion, store.SCHEMA_VERSION);
    assert.equal(status.pending.length, 0, '没有跨版本的迁移项要执行');
    assert.deepEqual(status.drift.missingColumns, [], '全新库不应有缺列');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态查询：库文件不存在时 hasDb 为 false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp-schema-nodb-'));
  try {
    const status = store.schemaStatus(join(dir, 'nope.sqlite'));
    assert.equal(status.hasDb, false);
    assert.equal(status.currentVersion, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
