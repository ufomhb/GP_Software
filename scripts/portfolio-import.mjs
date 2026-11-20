#!/usr/bin/env node
/**
 * 导入持仓（v2.9.2）
 *
 * 用途：本机 ⇄ 线上 NAS 持仓互通时，把另一侧导出的 JSON 写进当前这份 data/。
 * 写入前会先把当前持仓备份到 data/portfolio-history/<账号>/<时间戳>.preimport.json。
 *
 * 用法：
 *   node scripts/portfolio-import.mjs <文件> [--user=<id>] [--mode=merge|replace] [--dry]
 *   node scripts/portfolio-import.mjs /tmp/gp-portfolio.json --mode=merge
 *
 * 说明：
 *   - 文件里带账号 ID；不传 --user 时按文件里的账号导入，传了则要求两者一致（防串号）。
 *   - mode=merge（默认）：自选/持仓求并集，文件里的份额覆盖当前值；
 *     mode=replace：完全以文件为准。
 * 退出码：0 成功；1 失败
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name, fallback = '') => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : '';
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const storeArg = argOf('store');
if (storeArg === 'sqlite' || storeArg === 'json') process.env.STORE = storeArg;
else if (existsSync(join(ROOT, 'data', 'gp.sqlite'))) process.env.STORE = 'sqlite';

const store = require(join(ROOT, 'lib', 'store.js'));
const {
  validatePortfolioDoc,
  applyPortfolioImport,
  summarizePortfolio,
} = require(join(ROOT, 'src', 'lib', 'portfolio-transfer.js'));

try {
  store.init();
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) throw new Error('缺少持仓文件路径');
  const mode = argOf('mode') === 'replace' ? 'replace' : 'merge';
  const dryRun = hasFlag('dry');

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const doc = validatePortfolioDoc(raw);

  const users = store.loadUsers().users || [];
  const wanted = argOf('user').trim();
  if (wanted && wanted !== doc.user.id) {
    throw new Error(`文件里的账号（${doc.user.id} ${doc.user.username}）与 --user=${wanted} 不一致，已中止`);
  }
  const user = users.find((u) => String(u.id) === doc.user.id);
  if (!user) throw new Error(`当前实例里没有这个账号：${doc.user.id}（${doc.user.username}）`);

  const current = store.loadPortfolio(user);
  const next = applyPortfolioImport(doc, current, { mode });
  const before = summarizePortfolio(current);
  const after = summarizePortfolio(next);
  const summary = `账号 ${user.username}（${user.id}）· 导入前 基金 ${before.funds}/持仓 ${before.holdings}/自选股 ${before.watchlist}`
    + ` → 导入后 基金 ${after.funds}/持仓 ${after.holdings}/自选股 ${after.watchlist}`;

  if (dryRun) {
    console.log(`[预检] ${summary}（未写入，存储 ${store.mode}）`);
  } else {
    const dir = join(ROOT, 'data', 'portfolio-history', String(user.id).replace(/[^a-zA-Z0-9_-]/g, ''));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${Date.now()}.preimport.json`), JSON.stringify({
      savedAt: Date.now(),
      action: 'preimport',
      source: file,
      user: { id: user.id, username: user.username },
      funds: current.funds || [],
      holdings: current.holdings || {},
      watchlist: current.watchlist || [],
    }, null, 2), 'utf8');
    store.savePortfolio(user, next);
    console.log(`[已写入] ${summary}（存储 ${store.mode}，导入文件导出时间 ${new Date(doc.exportedAt || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}）`);
  }
} catch (err) {
  console.error(`导入失败：${err && err.message ? err.message : err}`);
  process.exit(1);
}
