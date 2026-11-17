#!/usr/bin/env node
/**
 * 数据库结构核对（2026-11-17，配合后台「部署到 NAS」使用）
 *
 * 判定逻辑统一在 lib/store.js 的 schemaDrift()（把 SCHEMA 在 :memory: 库里建一遍，
 * 与线上库逐表逐列对比），这里只负责取库、输出、给退出码，避免两处口径分叉。
 *
 * 用法：node scripts/check-schema.mjs [--db=<路径>] [--json]
 * 退出码：0 结构一致（或多出来的历史列，仅告警）；1 缺表/缺列，需要迁移；2 无法检查
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = require(join(ROOT, 'lib', 'store.js'));
const asJson = process.argv.includes('--json');
// --db=<路径>：核对指定库文件（默认线上库）。测试与排查时用。
const dbArg = process.argv.find((a) => a.startsWith('--db='));
const DB_FILE = dbArg ? dbArg.slice('--db='.length) : store.DB_FILE;

function finish(code, result) {
  if (asJson) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`库：${result.dbFile}`);
    console.log(`版本：v${result.currentVersion}（代码期望 v${result.targetVersion}）`);
    if (code === 0) {
      console.log(`结构一致${result.extraColumns.length ? `（另有 ${result.extraColumns.length} 个历史多余列，无害）` : ''}`);
      for (const item of result.extraColumns) console.log(`  提示：${item.table}.${item.column} 是历史遗留列，可忽略`);
    } else {
      console.log('数据库结构需要迁移：');
      for (const t of result.missingTables) console.log(`  缺少表：${t}`);
      for (const c of result.missingColumns) {
        const tag = c.notNull && !c.hasDefault ? '（NOT NULL 且无默认值，插入会失败）' : '';
        console.log(`  缺少列：${c.table}.${c.column}${tag}`);
      }
      console.log('\n处理：node scripts/migrate.mjs 执行迁移；数据库快照已由推送流程自动生成，可回滚。');
    }
  }
  process.exit(code);
}

if (!existsSync(DB_FILE)) {
  // JSON 模式或尚未迁移到 SQLite：没有库就没有结构问题
  finish(0, {
    mode: store.mode,
    dbFile: DB_FILE,
    ok: true,
    currentVersion: 0,
    targetVersion: store.SCHEMA_VERSION,
    missingTables: [],
    missingColumns: [],
    extraColumns: [],
  });
}

let probe;
let drift;
let currentVersion = 0;
try {
  const { DatabaseSync } = require('node:sqlite');
  probe = new DatabaseSync(DB_FILE, { readOnly: true });
  currentVersion = Number(probe.prepare('PRAGMA user_version').get()?.user_version) || 0;
  drift = store.schemaDrift(probe);
} catch (err) {
  console.error(`无法打开数据库进行核对：${err && err.message ? err.message : err}`);
  process.exit(2);
} finally {
  try { probe?.close(); } catch { /* 已关闭 */ }
}

const result = {
  mode: store.mode,
  dbFile: DB_FILE,
  ok: drift.missingTables.length === 0 && drift.missingColumns.length === 0,
  currentVersion,
  targetVersion: store.SCHEMA_VERSION,
  missingTables: drift.missingTables,
  missingColumns: drift.missingColumns,
  extraColumns: drift.extraColumns,
};
finish(result.ok ? 0 : 1, result);
