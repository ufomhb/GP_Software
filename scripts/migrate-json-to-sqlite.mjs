#!/usr/bin/env node
/**
 * JSON → SQLite 迁移（P1）
 *
 *   node scripts/migrate-json-to-sqlite.mjs --dry-run   只统计会导入什么，不写库
 *   node scripts/migrate-json-to-sqlite.mjs             正式导入（幂等，可重复跑）
 *   node scripts/migrate-json-to-sqlite.mjs --verify    导入后逐项比对 json 与数据库
 *   node scripts/migrate-json-to-sqlite.mjs --force     目标库已存在时仍然导入
 *
 * 说明：
 * - 只读 data/*.json，**不修改**任何源文件，所以随时可以 STORE=json 回退。
 * - 导入的是：账号、会话、自选/持仓/自选股、推送配置（不含 funds/holdings）、使用统计。
 * - changelog.json / boards.json / sector-members.json / us-sessions.json / auction-*.json
 *   属于内容或可再生缓存，不进数据库。
 */
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = require(join(ROOT, 'lib', 'store.js'));

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const verify = argv.includes('--verify');
const force = argv.includes('--force');

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function printReport(report) {
  console.log('');
  console.log(`迁移${report.dryRun ? '预演（--dry-run，未写库）' : '完成'}`);
  console.log('────────────────────────────────────────');
  console.log(`  账号        ${report.users}`);
  console.log(`  会话        ${report.sessions}`);
  console.log(`  自选基金    ${report.funds}`);
  console.log(`  持仓        ${report.holdings}`);
  console.log(`  自选股      ${report.watchlist}`);
  console.log(`  统计天数    ${report.statsDays}`);
  console.log(`  登录事件    ${report.loginEvents}`);
  if (report.warnings && report.warnings.length) {
    console.log('');
    for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  }
  if (report.verify) {
    console.log('');
    if (report.verify.ok) {
      console.log('  校验：全部一致 ✅');
    } else {
      console.log('  校验：发现差异 ❌');
      for (const p of report.verify.problems) console.log(`    - ${p}`);
    }
  }
}

const dbFile = store.DB_FILE;
if (!dryRun && existsSync(dbFile) && !force) {
  console.error(`目标数据库已存在：${dbFile}`);
  console.error('如果只是要复核，请用 --verify；确认要重新导入请加 --force。');
  process.exit(1);
}

try {
  const report = store.migrateFromJson({ dryRun, verify });
  printReport(report);
  if (!dryRun && existsSync(dbFile)) {
    console.log('');
    console.log(`  数据库      ${dbFile}（${fmtBytes(statSync(dbFile).size)}）`);
  }
  store.close();
  if (report.verify && !report.verify.ok) process.exit(2);
  console.log('');
  console.log('下一步：');
  console.log('  1) 用 STORE=sqlite 启动：STORE=sqlite node server.js');
  console.log('  2) 冒烟：登录 → 自选 → 持仓 → 后台 → 推送预览');
  console.log('  3) 回退：去掉 STORE=sqlite 重启即可（JSON 文件未被修改）');
} catch (err) {
  console.error('迁移失败：', err && err.stack ? err.stack : err);
  process.exit(1);
}
