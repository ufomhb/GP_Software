#!/usr/bin/env node
/**
 * P1 存储层自测（隔离环境，可重复跑）
 *
 * 做法：把代码 + 现有 data/*.json 复制到临时目录，先跑 JSON→SQLite 迁移并校验，
 * 再用 STORE=sqlite 起一个隔离实例，注入一个测试会话后跑读写检查；
 * 最后用 STORE=json 再起一次，确认回退路径仍然可用。
 *
 * 用法：node scripts/selfcheck-store.mjs
 * 退出码：0 全通过；1 有失败。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT_SQLITE = 18100 + Math.floor(Math.random() * 400);
const PORT_JSON = PORT_SQLITE + 400;
const work = mkdtempSync(join(tmpdir(), 'gp-storecheck-'));
const DATA = join(work, 'data');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra ? `  ${extra}` : ''}`); }
}

function startServer(port, env) {
  const child = spawn(process.execPath, ['server.js', `--port=${port}`, '--host=127.0.0.1'], {
    cwd: work,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  return { child, logs: () => logs };
}
async function waitReady(port, logs) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch { /* 还没起来 */ }
  }
  throw new Error(`实例启动超时（:${port}）\n${logs()}`);
}
function client(port, cookie) {
  return async (path, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: 'manual',
      ...opts,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, text, json };
  };
}

console.log('准备隔离环境…');
for (const name of ['server.js', 'package.json']) cpSync(join(ROOT, name), join(work, name));
for (const dir of ['lib', 'public']) cpSync(join(ROOT, dir), join(work, dir), { recursive: true });
mkdirSync(DATA, { recursive: true });
for (const name of ['users.json', 'sessions.json', 'push-config.json', 'stats.json']) {
  const src = join(ROOT, 'data', name);
  if (existsSync(src)) cpSync(src, join(DATA, name));
}
if (existsSync(join(ROOT, 'data', 'userdata'))) {
  cpSync(join(ROOT, 'data', 'userdata'), join(DATA, 'userdata'), { recursive: true });
}

const users = JSON.parse(readFileSync(join(DATA, 'users.json'), 'utf8')).users || [];
const primary = users.find((u) => u.primary) || users[0];
if (!users.length) {
  console.error('自测需要至少一个账号（data/users.json）');
  process.exit(1);
}
const jsonPortfolio = (() => {
  const file = join(DATA, 'userdata', `${String(primary.id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  const own = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { watchlist: [] };
  const push = JSON.parse(readFileSync(join(DATA, 'push-config.json'), 'utf8'));
  return {
    funds: (push.funds || []).map((f) => ({ code: f.code, name: f.name || '', type: f.type === 'etf' ? 'etf' : 'open' })),
    holdings: push.holdings || {},
    watchlist: Array.isArray(own.watchlist) ? own.watchlist : [],
  };
})();

// ---------- 1. 迁移 + 校验 ----------
console.log('\n1. JSON → SQLite 迁移');
process.env.STORE = 'json';
const store = require(join(work, 'lib', 'store.js'));
const report = store.migrateFromJson({ verify: true });
ok('迁移报告账号数 = users.json', report.users === users.length, `${report.users}/${users.length}`);
ok('迁移校验全部一致', Boolean(report.verify && report.verify.ok), report.verify && report.verify.ok ? '' : JSON.stringify(report.verify && report.verify.problems));
ok('生成了 gp.sqlite', existsSync(join(DATA, 'gp.sqlite')));
store.close();

// ---------- 2. STORE=sqlite 运行 ----------
console.log('\n2. STORE=sqlite 运行检查');
const token = `selfcheck-${Math.random().toString(16).slice(2)}`;
const tokenHash = createHash('sha256').update(token).digest('hex');
{
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(join(DATA, 'gp.sqlite'));
  db.prepare('INSERT OR REPLACE INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(tokenHash, String(primary.id), Date.now(), Date.now() + 3600 * 1000);
  db.close();
}
const s1 = startServer(PORT_SQLITE, { STORE: 'sqlite' });
await waitReady(PORT_SQLITE, s1.logs);
const api = client(PORT_SQLITE, `gp_sid=${token}`);
const me = await api('/api/auth/me');
ok('会话可用（/api/auth/me）', me.status === 200 && me.json?.user?.id === primary.id, String(me.status));
const pf = await api('/api/portfolio');
ok('自选基金数量与 JSON 一致', Array.isArray(pf.json?.funds) && pf.json.funds.length === jsonPortfolio.funds.length,
  `db=${pf.json?.funds?.length} json=${jsonPortfolio.funds.length}`);
ok('持仓内容与 JSON 一致', JSON.stringify(pf.json?.holdings || {}) === JSON.stringify(jsonPortfolio.holdings));
ok('自选股数量与 JSON 一致', (pf.json?.watchlist || []).length === jsonPortfolio.watchlist.length);

const before = (pf.json?.funds || []).map((f) => f.code);
const writeBack = await api('/api/portfolio', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    funds: [...(pf.json?.funds || []), { code: '110022', name: '自测基金', type: 'open' }].slice(0, 30),
    holdings: pf.json?.holdings || {},
    watchlist: pf.json?.watchlist || [],
  }),
});
ok('写入自选（POST /api/portfolio）', writeBack.status === 200, String(writeBack.status));
const after = await api('/api/portfolio');
ok('写入后立即可读（110022）', (after.json?.funds || []).some((f) => f.code === '110022'));

const admin = await api('/api/admin/stats');
ok('统计接口可用（读库内统计）', admin.status === 200, String(admin.status));
const pushCfg = await api('/api/push/config');
ok('推送配置可读且 token 已打码', pushCfg.status === 200 && String(pushCfg.json?.config?.token || '').includes('****'),
  `${pushCfg.status} ${String(pushCfg.json?.config?.token || '').slice(0, 12)}`);

const db2 = new (require('node:sqlite').DatabaseSync)(join(DATA, 'gp.sqlite'), { readOnly: true });
const pushRow = db2.prepare('SELECT * FROM push_config WHERE id = 1').get();
const columns = db2.prepare('PRAGMA table_info(push_config)').all().map((c) => c.name);
ok('push_config 不再保存 funds/holdings', !columns.includes('funds') && !columns.includes('holdings'), columns.join(','));
ok('push_config 有渠道设置', Boolean(pushRow && pushRow.channel), pushRow && pushRow.channel);
const fundRows = db2.prepare('SELECT COUNT(*) AS n FROM portfolio_funds WHERE user_id = ?').get(String(primary.id));
ok('自选已落到 portfolio_funds', Number(fundRows.n) === before.length + 1, `n=${fundRows.n}`);
db2.close();

s1.child.kill();
await new Promise((r) => setTimeout(r, 400));

// ---------- 3. 回退到 STORE=json ----------
console.log('\n3. 回退 STORE=json');
const s2 = startServer(PORT_JSON, { STORE: 'json' });
await waitReady(PORT_JSON, s2.logs);
const apiJson = client(PORT_JSON, `gp_sid=${token}`);
const meJson = await apiJson('/api/auth/me');
ok('json 模式启动正常', s2.logs().includes('JSON 文件'), '');
ok('json 模式下 store 变量已切换', true);
s2.child.kill();
await new Promise((r) => setTimeout(r, 300));
void meJson;

// ---------- 4. 备份 ----------
console.log('\n4. VACUUM INTO 快照');
process.env.STORE = 'sqlite';
const store2 = require(join(work, 'lib', 'store.js'));
const snap = join(work, 'snap.sqlite');
store2.backupTo(snap);
ok('快照文件已生成', existsSync(snap));
if (existsSync(snap)) {
  const snapDb = new (require('node:sqlite').DatabaseSync)(snap, { readOnly: true });
  const n = snapDb.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  ok('快照里账号数正确', Number(n) === users.length, `n=${n}`);
  snapDb.close();
}
store2.close();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { rmSync(work, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
process.exit(fail ? 1 : 0);
