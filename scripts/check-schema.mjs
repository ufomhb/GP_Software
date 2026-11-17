#!/usr/bin/env node
/**
 * 数据库结构核对（2026-11-17，配合后台「部署到 NAS」使用）
 *
 * 作用：代码推送只覆盖 .js，不会动 NAS 上的 data/gp.sqlite。如果本次改动新增了表
 * 或改了已有表的列，旧库结构不会自动跟上，新代码读写新列时会报 no such column。
 * 这个脚本把「代码期望的结构」（用 lib/store.js 的 SCHEMA 在 :memory: 库里建一遍）
 * 与「线上实际结构」逐表逐列对照，提前把问题暴露成明确结论，而不是等接口 500。
 *
 * 用法：node scripts/check-schema.mjs [--json]
 * 退出码：0 结构一致（或多余列，仅告警）；1 缺表/缺列，需要迁移；2 无法检查
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

function tablesOf(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

function finish(code, result) {
  if (asJson) {
    console.log(JSON.stringify(result));
  } else if (code === 0) {
    console.log(`结构一致${result.extraColumns.length ? `（库里有 ${result.extraColumns.length} 个多余列，无害）` : ''}`);
    for (const item of result.extraColumns) console.log(`  提示：${item.table}.${item.column} 是历史遗留列，可忽略`);
  } else {
    console.log('数据库结构需要迁移：');
    for (const t of result.missingTables) console.log(`  缺少表：${t}`);
    for (const c of result.missingColumns) {
      const tag = c.notNull && !c.hasDefault ? '（NOT NULL 且无默认值，插入会失败）' : '';
      console.log(`  缺少列：${c.table}.${c.column}${tag}`);
    }
    console.log('\n处理：先在后台「输出」里确认，再执行迁移或回滚代码；备份已由推送流程自动生成。');
  }
  process.exit(code);
}

if (!existsSync(DB_FILE)) {
  // JSON 模式或尚未迁移到 SQLite：没有库就没有结构问题
  finish(0, { mode: 'json', dbFile: DB_FILE, ok: true, missingTables: [], missingColumns: [], extraColumns: [] });
}

let expected;
let live;
try {
  const { DatabaseSync } = require('node:sqlite');
  expected = new DatabaseSync(':memory:');
  expected.exec(store.SCHEMA);

  live = new DatabaseSync(DB_FILE, { readOnly: true });
} catch (err) {
  console.error(`无法打开数据库进行核对：${err && err.message ? err.message : err}`);
  process.exit(2);
}

const expTables = tablesOf(expected);
const liveTables = tablesOf(live);
const missingTables = expTables.filter((t) => !liveTables.includes(t));

const missingColumns = [];
const extraColumns = [];
for (const table of expTables) {
  if (!liveTables.includes(table)) continue;
  const expCols = columnsOf(expected, table);
  const liveCols = columnsOf(live, table);
  const notNull = new Map();
  for (const row of expected.prepare(`PRAGMA table_info(${table})`).all()) {
    notNull.set(String(row.name), { notNull: Boolean(row.notnull), hasDefault: row.dflt_value !== null && row.dflt_value !== undefined });
  }
  for (const column of expCols) {
    if (!liveCols.includes(column)) {
      const meta = notNull.get(column) || { notNull: false, hasDefault: true };
      missingColumns.push({ table, column, notNull: meta.notNull, hasDefault: meta.hasDefault });
    }
  }
  for (const column of liveCols) {
    if (!expCols.includes(column)) extraColumns.push({ table, column });
  }
}

expected.close();
live.close();

const result = {
  mode: store.mode,
  dbFile: DB_FILE,
  ok: missingTables.length === 0 && missingColumns.length === 0,
  missingTables,
  missingColumns,
  extraColumns,
};
finish(result.ok ? 0 : 1, result);
