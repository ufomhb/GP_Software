#!/usr/bin/env node
/**
 * 导出某个账号的持仓（v2.9.2）
 *
 * 用途：本机 ⇄ 线上 NAS 持仓互通时，由服务端/运维脚本调用，产出一份
 * 与存储模式无关的 JSON（docVersion=2），再由另一侧 import。
 *
 * 用法：
 *   node scripts/portfolio-export.mjs --user=<账号id或用户名>
 *   node scripts/portfolio-export.mjs --user=meng-haibo --out=/tmp/gp-portfolio.json
 *   node scripts/portfolio-export.mjs --user=meng-haibo --store=sqlite
 *
 * 退出码：0 成功；1 失败（参数/账号/文件问题）
 */
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
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

// 存储模式：显式 --store 优先；否则按 data/gp.sqlite 是否存在推断（与部署脚本的口径一致）
const storeArg = argOf('store');
if (storeArg === 'sqlite' || storeArg === 'json') process.env.STORE = storeArg;
else if (existsSync(join(ROOT, 'data', 'gp.sqlite'))) process.env.STORE = 'sqlite';

const store = require(join(ROOT, 'lib', 'store.js'));
const { buildPortfolioDoc, summarizePortfolio } = require(join(ROOT, 'src', 'lib', 'portfolio-transfer.js'));

try {
  store.init();
  const who = argOf('user').trim();
  if (!who) throw new Error('缺少 --user=<账号 id 或用户名>');
  const users = store.loadUsers().users || [];
  const user = users.find((u) => String(u.id) === who)
    || users.find((u) => String(u.username).toLowerCase() === who.toLowerCase());
  if (!user) throw new Error(`找不到账号：${who}`);

  const doc = buildPortfolioDoc({
    user,
    portfolio: store.loadPortfolio(user),
    source: { host: 'script', store: store.mode },
    storeMode: store.mode,
  });
  const text = JSON.stringify(doc, null, 2);
  const out = argOf('out');
  if (out) {
    writeFileSync(out, text, 'utf8');
    const counts = summarizePortfolio(doc);
    console.log(`已导出 ${user.username}（${user.id}）→ ${out} · 基金 ${counts.funds} / 持仓 ${counts.holdings} / 组合 ${counts.groups} / 自选股 ${counts.watchlist} · 存储 ${store.mode}`);
  } else {
    process.stdout.write(text);
  }
} catch (err) {
  console.error(`导出失败：${err && err.message ? err.message : err}`);
  process.exit(1);
}
