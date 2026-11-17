#!/usr/bin/env node
/**
 * 数据库结构迁移（2026-11-17，方案 A）
 *
 * 服务启动时会自动迁移（lib/store.js 的 migrateOnOpen），这个脚本用于：
 *   - 推送流程里**重启前**先把库升好（早失败早发现，服务还在跑旧代码）；
 *   - 手动查询状态 / 排查失败原因。
 *
 * 用法：
 *   node scripts/migrate.mjs --status   # 只看版本、待执行迁移、结构漂移
 *   node scripts/migrate.mjs            # 执行迁移（幂等，已是最新则什么都不做）
 * 退出码：0 成功/无需迁移；1 失败；2 无法检查
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = require(join(ROOT, 'lib', 'store.js'));
const statusOnly = process.argv.includes('--status');

function describe(status) {
  if (!status.hasDb) {
    console.log(`没有 SQLite 库（模式 ${status.mode}，${status.dbFile}），无需迁移`);
    return;
  }
  console.log(`库：${status.dbFile}`);
  console.log(`版本：v${status.currentVersion} → 期望 v${status.targetVersion}`);
  if (status.pending.length) {
    for (const m of status.pending) console.log(`  待执行：v${m.version} ${m.name || ''}`);
  } else {
    console.log('  没有待执行的迁移');
  }
  const { missingTables, missingColumns, extraColumns } = status.drift;
  if (missingTables.length || missingColumns.length) {
    console.log('结构漂移（这些是代码要、库里没有的）：');
    for (const t of missingTables) console.log(`  缺表：${t}`);
    for (const c of missingColumns) console.log(`  缺列：${c.table}.${c.column}`);
  }
  if (extraColumns.length) {
    console.log(`多余历史列 ${extraColumns.length} 个（无害）`);
  }
}

let status;
try {
  status = store.schemaStatus();
} catch (err) {
  console.error(`无法检查数据库：${err && err.message ? err.message : err}`);
  process.exit(2);
}

describe(status);

if (statusOnly) {
  process.exit(status.currentVersion < status.targetVersion || status.drift.missingColumns.length || status.drift.missingTables.length ? 1 : 0);
}

if (!status.hasDb) process.exit(0);
if (!status.pending.length && status.currentVersion >= status.targetVersion) {
  console.log('已是最新版本，无需迁移');
  process.exit(0);
}

try {
  // openDb 内部会跑 migrateOnOpen：认领版本 + 按版本号依次执行迁移
  store.openDb();
  const after = store.schemaStatus();
  console.log(`迁移完成：现在 v${after.currentVersion}（期望 v${after.targetVersion}）`);
  const { missingTables, missingColumns } = after.drift;
  if (missingTables.length || missingColumns.length) {
    console.error('迁移后仍有结构差异，请检查 MIGRATIONS 是否漏了改动：');
    for (const t of missingTables) console.error(`  缺表：${t}`);
    for (const c of missingColumns) console.error(`  缺列：${c.table}.${c.column}`);
    store.close();
    process.exit(1);
  }
  store.close();
  process.exit(0);
} catch (err) {
  console.error(`迁移失败：${err && err.message ? err.message : err}`);
  try { store.close(); } catch { /* 已关闭 */ }
  process.exit(1);
}
