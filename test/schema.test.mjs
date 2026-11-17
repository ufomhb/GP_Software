/**
 * 数据库结构核对脚本回归测试（2026-11-17）
 *
 * 背景：后台「部署到 NAS」只推代码、不推 data/gp.sqlite。如果改了已有表结构
 * （加列/改约束），线上旧库不会自动跟上，新代码读写新列会 no such column。
 * check-schema.mjs 就是把这个隐患变成一次明确结论，这里验证它的三种判断：
 *  - 结构一致 → 退出 0
 *  - 缺列     → 退出 1，并列出缺哪一列
 *  - 多列     → 退出 0（无害），但记录在 extraColumns
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const store = require('../lib/store.js');
const { DatabaseSync } = require('node:sqlite');

function runCheck(dbFile) {
  const res = spawnSync(process.execPath, ['scripts/check-schema.mjs', '--json', `--db=${dbFile}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  let json = null;
  try { json = JSON.parse(String(res.stdout || '').trim()); } catch { /* 非 JSON 输出 */ }
  return { code: res.status, json, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** 按当前 SCHEMA 建一个全新库，可选再改结构 */
function makeDb(dir, name, mutate) {
  const file = join(dir, name);
  const db = new DatabaseSync(file);
  db.exec(store.SCHEMA);
  if (mutate) mutate(db);
  db.close();
  return file;
}

test('结构核对：全新库与 SCHEMA 一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp-schema-ok-'));
  try {
    const file = makeDb(dir, 'gp.sqlite');
    const out = runCheck(file);
    assert.equal(out.code, 0, `应通过：${out.stdout}${out.stderr}`);
    assert.equal(out.json?.ok, true);
    assert.deepEqual(out.json?.missingTables, []);
    assert.deepEqual(out.json?.missingColumns, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('结构核对：线上库缺列时必须报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp-schema-miss-'));
  try {
    const file = makeDb(dir, 'gp.sqlite', (db) => {
      db.exec('ALTER TABLE users DROP COLUMN login_count');
    });
    const out = runCheck(file);
    assert.equal(out.code, 1, `缺列应失败：${out.stdout}${out.stderr}`);
    assert.equal(out.json?.ok, false);
    const missing = (out.json?.missingColumns || []).map((c) => `${c.table}.${c.column}`);
    assert.ok(missing.includes('users.login_count'), `实际缺列：${missing.join('、')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('结构核对：多出来的历史列只告警不失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp-schema-extra-'));
  try {
    const file = makeDb(dir, 'gp.sqlite', (db) => {
      db.exec('ALTER TABLE users ADD COLUMN legacy_flag TEXT');
    });
    const out = runCheck(file);
    assert.equal(out.code, 0, `多余列不该失败：${out.stdout}${out.stderr}`);
    const extra = (out.json?.extraColumns || []).map((c) => `${c.table}.${c.column}`);
    assert.ok(extra.includes('users.legacy_flag'), `应记录多余列：${extra.join('、')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('结构核对：库文件不存在时视为 JSON 模式（不报错）', () => {
  const out = runCheck(join(tmpdir(), 'gp-no-such-db.sqlite'));
  assert.equal(out.code, 0);
  assert.equal(out.json?.ok, true);
});
