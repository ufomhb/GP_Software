#!/usr/bin/env node
/**
 * P0 安全基线自测（可重复运行，不动线上数据）
 *
 * 做法：把 server.js / lib / public 复制到系统临时目录，配一个空 data/，
 * 在随机端口起一个隔离实例，跑完检查后关掉并清理。
 *
 * 用法：node scripts/selfcheck-p0.mjs
 * 退出码：0 全通过；1 有失败。
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const work = mkdtempSync(join(tmpdir(), 'gp-selfcheck-'));
const DATA = join(work, 'data');

for (const name of ['server.js', 'package.json']) {
  cpSync(join(ROOT, name), join(work, name));
}
for (const dir of ['lib', 'src', 'public']) {
  cpSync(join(ROOT, dir), join(work, dir), { recursive: true });
}
mkdirSync(DATA, { recursive: true });

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}${extra ? `  ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? `  ${extra}` : ''}`);
  }
}
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, { redirect: 'manual', ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, headers: res.headers, text, json };
}
const H = (r, k) => r.headers.get(k) || '';

async function waitReady(child) {
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return () => logs;
    } catch { /* 还没起来 */ }
  }
  throw new Error(`隔离实例启动超时：\n${logs}`);
}

const child = spawn(process.execPath, ['server.js', `--port=${PORT}`, '--host=127.0.0.1'], {
  cwd: work,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});

try {
  const readLogs = await waitReady(child);

  console.log('\n1. 安全响应头');
  const health = await req('/api/health');
  ok('health 200', health.status === 200);
  ok('health 已精简（无 uptime/port）', !!health.json && health.json.ok === true && !('uptime' in health.json) && !('port' in health.json));
  ok('X-Content-Type-Options: nosniff', H(health, 'x-content-type-options') === 'nosniff');
  ok('X-Frame-Options: DENY', H(health, 'x-frame-options') === 'DENY');
  ok('Referrer-Policy', H(health, 'referrer-policy') === 'strict-origin-when-cross-origin');
  ok('Permissions-Policy', H(health, 'permissions-policy').includes('geolocation=()'));
  ok('CSP 以 Report-Only 下发', H(health, 'content-security-policy-report-only').includes("default-src 'self'"));
  ok('http 下不发 HSTS', H(health, 'strict-transport-security') === '');
  ok('已移除 Access-Control-Allow-Origin: *', H(health, 'access-control-allow-origin') === '');

  console.log('\n2. 页面鉴权与静态目录');
  const root = await req('/');
  ok('/ 未登录 302 → /login.html', root.status === 302 && H(root, 'location') === '/login.html');
  ok('/admin.html 未登录 302 → /login.html', (await req('/admin.html')).status === 302);
  ok('/login.html 公开', (await req('/login.html')).status === 200);
  const trav = await req('/..%2fserver.js');
  ok('路径穿越 /..%2fserver.js → 403', trav.status === 403, String(trav.status));

  console.log('\n3. 注册与会话');
  const reg1 = await req('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'selfcheck_admin', password: 'selfcheck123' }),
  });
  ok('空库时首个账号可注册（bootstrap）', reg1.status === 200 && reg1.json?.user?.role === 'admin');
  const cookie = (H(reg1, 'set-cookie') || '').split(';')[0];
  ok('http 下 Cookie 无 Secure', !H(reg1, 'set-cookie').includes('Secure'));
  ok('Cookie HttpOnly + SameSite=Lax', H(reg1, 'set-cookie').includes('HttpOnly') && H(reg1, 'set-cookie').includes('SameSite=Lax'));
  const reg2 = await req('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'selfcheck_second', password: 'selfcheck123' }),
  });
  ok('第二个账号被拒（注册默认关闭）', reg2.status === 403, reg2.json?.error || '');

  const sessions = JSON.parse(readFileSync(join(DATA, 'sessions.json'), 'utf8'));
  const keys = Object.keys(sessions);
  const rawToken = cookie.split('=')[1];
  ok('sessions.json 键为 sha256', keys.length === 1 && keys.every((k) => /^[0-9a-f]{64}$/.test(k)));
  ok('sessions.json 不含明文 token', !keys.includes(rawToken) && !JSON.stringify(sessions).includes(rawToken));
  ok('落盘无残留 .tmp 文件', !keys.length || !readFileSync(join(DATA, 'sessions.json'), 'utf8').includes('tmp'));

  console.log('\n4. 登录 / 限流 / HTTPS Cookie');
  const loginHttps = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ username: 'selfcheck_admin', password: 'selfcheck123' }),
  });
  ok('HTTPS 下登录 200', loginHttps.status === 200);
  ok('HTTPS 下 Cookie 带 Secure', H(loginHttps, 'set-cookie').includes('Secure'));
  const adminCookie = (H(loginHttps, 'set-cookie') || '').split(';')[0];

  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i}` },
      body: JSON.stringify({ username: 'selfcheck_admin', password: 'wrong-pass' }),
    });
    statuses.push(r.status);
  }
  ok('伪造 X-Forwarded-For 仍会锁定', statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 429, statuses.join(','));

  console.log('\n5. 同源校验（CSRF）');
  const csrf = await req('/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com', Cookie: adminCookie },
  });
  ok('跨站 Origin POST → 403', csrf.status === 403);
  const same = await req('/api/push/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: adminCookie },
    body: JSON.stringify({ enabled: false }),
  });
  ok('同源 Origin POST 放行', same.status === 200, String(same.status));

  console.log('\n6. 角色与后台页');
  ok('管理员可打开 /admin.html', (await req('/admin.html', { headers: { Cookie: adminCookie } })).status === 200);
  const usersFile = join(DATA, 'users.json');
  const store = JSON.parse(readFileSync(usersFile, 'utf8'));
  store.users.push({ ...store.users[0], id: 'selfcheck_user01', username: 'selfcheck_user', primary: false, role: 'user' });
  writeFileSync(usersFile, JSON.stringify(store, null, 2), 'utf8');
  const userLogin = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'selfcheck_user', password: 'selfcheck123' }),
  });
  const userCookie = (H(userLogin, 'set-cookie') || '').split(';')[0];
  ok('普通用户可登录', userLogin.status === 200);
  const adminAsUser = await req('/admin.html', { headers: { Cookie: userCookie } });
  ok('普通用户打开 /admin.html → 302 /', adminAsUser.status === 302 && H(adminAsUser, 'location') === '/');
  ok('普通用户调管理接口 → 403', (await req('/api/admin/users', { headers: { Cookie: userCookie } })).status === 403);

  console.log('\n7. 出站地址校验 / OPTIONS');
  const options = await req('/api/auth/login', { method: 'OPTIONS' });
  ok('OPTIONS 204 且无 ACAO', options.status === 204 && H(options, 'access-control-allow-origin') === '');
  const ssrfLoop = await req('/api/push/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: adminCookie },
    body: JSON.stringify({ channel: 'custom', webhook: 'https://127.0.0.1/send' }),
  });
  ok('webhook 指向回环被拒（400 + 原因）', ssrfLoop.status === 400 && String(ssrfLoop.json?.error || '').includes('内网'), `${ssrfLoop.status} ${ssrfLoop.json?.error || ''}`);
  const ssrfHttp = await req('/api/push/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: adminCookie },
    body: JSON.stringify({ channel: 'custom', webhook: 'http://example.com/send' }),
  });
  ok('webhook 非 https 被拒', ssrfHttp.status === 400 && String(ssrfHttp.json?.error || '').includes('https'));

  console.log('\n8. 日志脱敏');
  await req('/api/funds/watch?codes=510300&token=SUPERSECRET', { headers: { Cookie: adminCookie } });
  await new Promise((r) => setTimeout(r, 200));
  const logs = readLogs();
  ok('日志里 token 已打码', logs.includes('token=***'), logs.split('\n').filter((l) => l.includes('funds/watch')).slice(-1)[0] || '');
  ok('日志里没有明文 token', !logs.includes('SUPERSECRET'));

  console.log('\n9. 后台日志（logs/ + data/crash.log）');
  const logAnon = await req('/api/admin/logs');
  ok('未登录读日志 → 401', logAnon.status === 401, String(logAnon.status));
  const logAdmin = await req('/api/admin/logs?lines=80', { headers: { Cookie: adminCookie } });
  ok('管理员读日志 → 200', logAdmin.status === 200 && logAdmin.json?.ok === true, String(logAdmin.status));
  ok('日志文件列表非空', Array.isArray(logAdmin.json?.files) && logAdmin.json.files.length > 0, `files=${logAdmin.json?.files?.length}`);
  ok('日志内容可读且含此前的请求行', Array.isArray(logAdmin.json?.lines)
    && logAdmin.json.lines.some((l) => l.includes('/api/admin/')), `lines=${logAdmin.json?.lines?.length}`);
  const logEvil = await req('/api/admin/logs?file=../../data/users.json', { headers: { Cookie: adminCookie } });
  ok('非法 file 参数回落当前日志', logEvil.json?.id === 'server' && !String(logEvil.text || '').includes('"hash"'), String(logEvil.json?.id));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败（隔离实例 :${PORT}）`);
} catch (err) {
  fail += 1;
  console.error('\n自测异常：', err && err.message ? err.message : err);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  process.exit(fail ? 1 : 0);
}
