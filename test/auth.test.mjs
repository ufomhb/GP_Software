import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, bootstrapAdmin } from './helpers/app.mjs';

test('账号：首个账号可注册并自动成为管理员', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = app.client();
  const res = await c.post('/api/auth/register', { username: 'alice', password: 'alice12345' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin');
  assert.equal(res.body.user.primary, true);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  // http 下不能带 Secure，否则本机登录不上
  assert.doesNotMatch(setCookie, /Secure/);
});

test('账号：默认关闭注册，第二个账号被拒', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await bootstrapAdmin(app);
  const c = app.client();
  const res = await c.post('/api/auth/register', { username: 'bob', password: 'bob123456' });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /注册已关闭/);
});

test('账号：ALLOW_REGISTER=1 时允许注册，但需要邀请码的话必须带上', async (t) => {
  const app = await startApp({ env: { ALLOW_REGISTER: '1', INVITE_CODE: 'open-sesame' } });
  t.after(() => app.stop());
  await bootstrapAdmin(app);
  const c = app.client();
  const noCode = await c.post('/api/auth/register', { username: 'bob', password: 'bob123456' });
  assert.equal(noCode.status, 403);
  assert.match(noCode.body.error, /邀请码/);
  const withCode = await c.post('/api/auth/register', { username: 'bob', password: 'bob123456', invite: 'open-sesame' });
  assert.equal(withCode.status, 200);
  assert.equal(withCode.body.user.role, 'user');
  assert.equal(withCode.body.user.primary, false);
});

test('账号：用户名/密码格式校验', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = app.client();
  const badName = await c.post('/api/auth/register', { username: 'a', password: 'abcdefg' });
  assert.equal(badName.status, 400);
  const badPass = await c.post('/api/auth/register', { username: 'alice', password: '123' });
  assert.equal(badPass.status, 400);
});

test('账号：登录失败累计后锁定（伪造 X-Forwarded-For 无效）', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await bootstrapAdmin(app, 'alice', 'alice12345');
  const c = app.client();
  const codes = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await c.post('/api/auth/login', { username: 'alice', password: 'wrong-pass' }, {
      headers: { 'X-Forwarded-For': `203.0.113.${i}` },
    });
    codes.push(res.status);
  }
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[5], 429);
});

test('账号：登录 → me → 改密后旧会话失效 → 重新登录', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await bootstrapAdmin(app, 'alice', 'alice12345');

  const login = app.client();
  const ok = await login.post('/api/auth/login', { username: 'alice', password: 'alice12345' });
  assert.equal(ok.status, 200);
  const me = await login.get('/api/auth/me');
  assert.equal(me.body.user.username, 'alice');

  // 改密：需要旧密码，成功后该账号所有旧会话失效
  const changed = await login.post('/api/auth/password', {
    username: 'alice',
    oldPassword: 'alice12345',
    newPassword: 'alice67890',
  });
  assert.equal(changed.status, 200);

  const afterChange = await login.get('/api/auth/me');
  assert.equal(afterChange.body.user, null, '改密后旧会话应失效');

  const relogin = app.client();
  const reloginRes = await relogin.post('/api/auth/login', { username: 'alice', password: 'alice67890' });
  assert.equal(reloginRes.status, 200);
  const meAgain = await relogin.get('/api/auth/me');
  assert.equal(meAgain.body.user.username, 'alice');
});

test('账号：退出登录后接口回到未登录', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');
  const out = await c.post('/api/auth/logout', {});
  assert.equal(out.status, 200);
  const me = await c.get('/api/auth/me');
  assert.equal(me.body.user, null);
  const guarded = await c.get('/api/portfolio');
  assert.equal(guarded.status, 401);
});

test('账号：会话文件里不出现明文 token', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');
  const raw = c.cookie.split('=')[1];
  assert.ok(raw && raw.length >= 32);
  const sessions = JSON.parse(app.readData('sessions.json'));
  assert.ok(!Object.keys(sessions).includes(raw), 'sessions.json 不应以明文 token 为键');
  assert.ok(Object.keys(sessions).every((k) => /^[0-9a-f]{64}$/.test(k)));
});

test('账号：会话按上海自然日失效（昨天创建的会话必须重新登录）', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');
  const me = await c.get('/api/auth/me');
  assert.equal(me.body.user.username, 'alice');

  // 把会话的 createdAt 改成「昨天」，模拟跨 0 点（服务端用 createdAt 推导登录日）
  const file = JSON.parse(app.readData('sessions.json'));
  const keys = Object.keys(file);
  assert.equal(keys.length, 1);
  file[keys[0]].createdAt = Date.now() - 26 * 3600 * 1000;
  writeFileSync(join(app.dataDir, 'sessions.json'), JSON.stringify(file, null, 2));

  const after = await c.get('/api/auth/me');
  assert.equal(after.body.user, null, '跨日会话应失效');
  const guarded = await c.get('/api/portfolio');
  assert.equal(guarded.status, 401, '跨日会话访问受保护接口应 401');

  // 重新登录：Cookie 的 Max-Age 不能超过一天（到下一个上海 0 点）
  const relogin = await c.post('/api/auth/login', { username: 'alice', password: 'alice12345' });
  assert.equal(relogin.status, 200);
  const maxAge = Number((relogin.headers.get('set-cookie') || '').match(/Max-Age=(\d+)/)?.[1]);
  assert.ok(maxAge > 0 && maxAge <= 86400, `Max-Age 应在 (0, 86400]，实际 ${maxAge}`);
});

test('账号：勾选「7 天免登录」后跨日仍有效，且后台记录能看到这次登录', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await bootstrapAdmin(app, 'alice', 'alice12345');

  const c = app.client();
  const login = await c.post('/api/auth/login', { username: 'alice', password: 'alice12345', remember: true });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie') || '';
  const maxAge = Number(cookie.match(/Max-Age=(\d+)/)?.[1]);
  assert.equal(maxAge, 7 * 86400, `勾选后 Cookie 应为 7 天，实际 ${maxAge}`);

  const file = JSON.parse(app.readData('sessions.json'));
  const keys = Object.keys(file);
  assert.ok(keys.length >= 1);
  const rememberKey = keys.find((k) => file[k] && file[k].remember === true);
  assert.ok(rememberKey, '会话应标记 remember');
  const session = file[rememberKey];
  const days = (Number(session.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days <= 7.01, `会话有效期应约 7 天，实际 ${days.toFixed(2)} 天`);

  // 把创建时间改成「昨天」：普通会话会失效，勾了 7 天免登录的必须仍然有效
  session.createdAt = Date.now() - 26 * 3600 * 1000;
  writeFileSync(join(app.dataDir, 'sessions.json'), JSON.stringify(file, null, 2));
  const me = await c.get('/api/auth/me');
  assert.equal(me.body.user && me.body.user.username, 'alice', '7 天免登录的会话跨日不应失效');
  const guarded = await c.get('/api/portfolio');
  assert.equal(guarded.status, 200, '跨日后受保护接口仍可用');

  // 后台登录记录：说明列标「7 天免登录」（走接口读内存里的 statsStore，避免等落盘）
  const logs = await c.get('/api/admin/logins?limit=20');
  assert.equal(logs.status, 200);
  const hit = (logs.body.logins || []).filter((x) => x.username === 'alice' && x.ok && x.reason === '7 天免登录');
  assert.ok(hit.length >= 1, '登录记录应标注「7 天免登录」');
});
