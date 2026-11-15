import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, bootstrapAdmin } from './helpers/app.mjs';

test('安全：每个响应都带安全响应头，且不再有 ACAO:*', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const res = await app.client().get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(res.headers.get('permissions-policy'), /geolocation=\(\)/);
  assert.match(res.headers.get('content-security-policy-report-only') || '', /default-src 'self'/);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('strict-transport-security'), null, 'http 下不应发 HSTS');
});

test('安全：health 只暴露状态与版本', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const res = await app.client().get('/api/health');
  assert.deepEqual(Object.keys(res.body).sort(), ['ok', 'time', 'version']);
});

test('安全：未登录时页面跳登录、接口 401', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = app.client();
  const home = await c.get('/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login.html');
  const adminPage = await c.get('/admin.html');
  assert.equal(adminPage.status, 302);
  assert.equal((await c.get('/api/portfolio')).status, 401);
  assert.equal((await c.get('/login.html')).status, 200, '登录页应公开');
});

test('安全：静态目录不能穿越', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = app.client();
  const a = await c.get('/..%2fserver.js');
  assert.equal(a.status, 403);
  const b = await c.get('/%2e%2e/server.js');
  assert.notEqual(b.status, 200);
  assert.ok(!b.text.includes('use strict'));
  const c2 = await c.get('/login.html');
  assert.equal(c2.status, 200);
});

test('安全：跨站 POST 被拒，同源放行', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const admin = await bootstrapAdmin(app, 'alice', 'alice12345');
  const cross = await admin.req('/api/push/config', {
    method: 'POST',
    json: { enabled: false },
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(cross.status, 403);
  const same = await admin.req('/api/push/config', {
    method: 'POST',
    json: { enabled: false },
    headers: { Origin: app.base },
  });
  assert.equal(same.status, 200);
});

test('安全：OPTIONS 不再返回 CORS 放行头', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const res = await app.client().req('/api/auth/login', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('安全：webhook 只允许 https 且拒绝内网地址', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const admin = await bootstrapAdmin(app, 'alice', 'alice12345');
  const loopback = await admin.post('/api/push/config', { channel: 'custom', webhook: 'https://127.0.0.1/send' });
  assert.equal(loopback.status, 400);
  assert.match(loopback.body.error, /内网/);
  const http = await admin.post('/api/push/config', { channel: 'custom', webhook: 'http://example.com/send' });
  assert.equal(http.status, 400);
  assert.match(http.body.error, /https/);
  const privateNet = await admin.post('/api/push/config', { channel: 'custom', webhook: 'https://192.168.31.10/send' });
  assert.equal(privateNet.status, 400);
});

test('安全：推送配置里的密钥对前端打码', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const admin = await bootstrapAdmin(app, 'alice', 'alice12345');
  await admin.post('/api/push/config', { channel: 'serverchan', token: 'SCT1234567890abcdef' });
  const res = await admin.get('/api/push/config');
  assert.equal(res.status, 200);
  assert.match(res.body.config.token, /\*\*\*\*/);
  assert.ok(!res.body.config.token.includes('1234567890'));
});

test('安全：普通用户进不了后台页面与管理接口', async (t) => {
  const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
  t.after(() => app.stop());
  const admin = app.client();
  await admin.post('/api/auth/register', { username: 'alice', password: 'alice12345' });
  const user = app.client();
  await user.post('/api/auth/register', { username: 'bob', password: 'bob123456' });

  assert.equal((await admin.get('/admin.html')).status, 200);
  assert.equal((await user.get('/admin.html')).status, 302);
  assert.equal((await user.get('/admin.html')).headers.get('location'), '/');
  assert.equal((await user.get('/api/admin/users')).status, 403);
  assert.equal((await admin.get('/api/admin/users')).status, 200);
});

test('安全：错误响应不外泄内部堆栈', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const res = await app.client().get('/api/does-not-exist');
  assert.ok(res.status >= 400);
  assert.ok(!/at\s+\w+\s+\(/.test(res.text), '响应里不应出现堆栈');
});

test('安全：日志里 token 被打码', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const admin = await bootstrapAdmin(app, 'alice', 'alice12345');
  await admin.get('/api/funds/watch?codes=510300&token=SHOULD_NOT_APPEAR');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(app.logs().includes('token=***'));
  assert.ok(!app.logs().includes('SHOULD_NOT_APPEAR'));
});
