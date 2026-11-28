import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const security = require(join(ROOT, 'src', 'lib', 'security.js'));
const netSafety = require(join(ROOT, 'src', 'lib', 'net-safety.js'));

function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
  };
}
function fakeReq({ headers = {}, encrypted = false } = {}) {
  return { headers, socket: { encrypted } };
}

test('security：HTTPS 判定（直连 TLS / X-Forwarded-Proto / 明文）', () => {
  assert.equal(security.requestIsHttps(fakeReq({ encrypted: true })), true);
  assert.equal(security.requestIsHttps(fakeReq({ headers: { 'x-forwarded-proto': 'https' } })), true);
  assert.equal(security.requestIsHttps(fakeReq({ headers: { 'x-forwarded-proto': 'HTTPS, http' } })), true);
  assert.equal(security.requestIsHttps(fakeReq({ headers: { 'x-forwarded-proto': 'http' } })), false);
  assert.equal(security.requestIsHttps(fakeReq()), false);
});

test('security：安全响应头（Report-Only / 强制 / HSTS 只在 HTTPS）', () => {
  const plain = fakeRes();
  security.setSecurityHeaders(fakeReq(), plain);
  assert.equal(plain.headers['x-content-type-options'], 'nosniff');
  assert.equal(plain.headers['x-frame-options'], 'DENY');
  assert.equal(plain.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.match(plain.headers['permissions-policy'], /geolocation=\(\)/);
  assert.equal(plain.headers['cross-origin-opener-policy'], 'same-origin');
  assert.ok(plain.headers['content-security-policy-report-only']);
  assert.equal(plain.headers['content-security-policy'], undefined);
  assert.equal(plain.headers['strict-transport-security'], undefined);

  const enforced = fakeRes();
  security.setSecurityHeaders(fakeReq({ headers: { 'x-forwarded-proto': 'https' } }), enforced, true);
  assert.ok(enforced.headers['content-security-policy']);
  assert.equal(enforced.headers['content-security-policy-report-only'], undefined);
  assert.match(enforced.headers['strict-transport-security'], /max-age=31536000/);
});

test('security：查询串脱敏', () => {
  assert.equal(security.redactQuery('?codes=510300&token=abc123'), '?codes=510300&token=***');
  assert.equal(security.redactQuery('?a=1&webhook=https%3A%2F%2Fx&b=2'), '?a=1&webhook=***&b=2');
  assert.equal(security.redactQuery('?password=p1&passwd=p2'), '?password=***&passwd=***');
  assert.equal(security.redactQuery(''), '');
});

test('security：同源校验', () => {
  const host = 'gp.example.com';
  assert.equal(security.isSameOriginRequest(fakeReq({ headers: { origin: 'https://gp.example.com', host } })), true);
  assert.equal(security.isSameOriginRequest(fakeReq({ headers: { origin: 'https://evil.com', host } })), false);
  assert.equal(security.isSameOriginRequest(fakeReq({ headers: { origin: 'null', host } })), false);
  assert.equal(security.isSameOriginRequest(fakeReq({ headers: { origin: 'not a url', host } })), false);
  assert.equal(security.isSameOriginRequest(fakeReq({ headers: { 'sec-fetch-site': 'same-origin', host } })), true);
  assert.equal(security.isSameOriginRequest(fakeReq({ headers: { 'sec-fetch-site': 'cross-site', host } })), false);
  // 没有 Origin / Sec-Fetch-Site 的脚本客户端放行
  assert.equal(security.isSameOriginRequest(fakeReq({ headers: { host } })), true);
});

test('security：会话键是 sha256 且稳定', () => {
  const a = security.sessionKey('abc');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, security.sessionKey('abc'));
  assert.notEqual(a, security.sessionKey('abd'));
  assert.match(security.sessionKey(''), /^[0-9a-f]{64}$/);
});

test('security：邀请码比较（空=放行，等值通过，不等拒绝，长度不同也不抛）', () => {
  assert.equal(security.inviteMatches('anything', ''), true);
  assert.equal(security.inviteMatches('sesame', 'sesame'), true);
  assert.equal(security.inviteMatches('sesame', 'sesamf'), false);
  assert.equal(security.inviteMatches('a', 'a-much-longer-secret'), false);
  assert.equal(security.inviteMatches(undefined, 'sesame'), false);
});

test('security：会话 Cookie（HTTPS 才加 Secure，同时下发 Expires）', () => {
  const http = security.sessionCookie({ name: 'gp_sid', token: 't', maxAgeSec: 100, secure: false });
  assert.match(http, /^gp_sid=t; Path=\/; HttpOnly; SameSite=Lax; Max-Age=100; Expires=.+GMT$/);
  assert.doesNotMatch(http, /Secure/);
  // Expires 应约等于 100 秒后（个别 iOS PWA 只认 Expires）
  const expires = http.match(/Expires=([^;]+)$/)[1];
  const delta = new Date(expires).getTime() - Date.now();
  assert.ok(delta > 90000 && delta <= 101000, `Expires 应约为 100 秒后，实际 ${delta}ms`);
  const https = security.sessionCookie({ name: 'gp_sid', token: 't', maxAgeSec: 100, secure: true });
  assert.match(https, /; Secure$/);
  const cleared = security.sessionCookie({ name: 'gp_sid', token: '', maxAgeSec: 0, secure: true });
  assert.match(cleared, /Max-Age=0/);
  // 删除 Cookie 时 Expires 要落在过去，否则浏览器可能不删
  assert.ok(new Date(cleared.match(/Expires=([^;]+)/)[1]).getTime() < Date.now());
  assert.equal(security.sessionCookie({ name: 'x', token: 'y', secure: false }), 'x=y; Path=/; HttpOnly; SameSite=Lax');
});

test('net-safety：内网地址识别', () => {
  const yes = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.31.175',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::3',
    'fe80::1', '::ffff:127.0.0.1'];
  const no = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2001:4860:4860::8888'];
  for (const ip of yes) assert.equal(netSafety.isPrivateAddress(ip), true, `${ip} 应判为内网`);
  for (const ip of no) assert.equal(netSafety.isPrivateAddress(ip), false, `${ip} 应判为公网`);
  assert.equal(netSafety.isPrivateAddress(''), true);
  assert.equal(netSafety.isPrivateAddress('not-an-ip'), true);
});

test('net-safety：出站地址校验', async () => {
  const cases = [
    ['http://example.com/hook', /https/],
    ['https://127.0.0.1/hook', /内网/],
    ['https://192.168.31.10/hook', /内网/],
    ['https://169.254.169.254/latest', /内网/],
    ['https://localhost/hook', /内网/],
    ['https://printer.local/hook', /内网/],
    ['https://[::1]/hook', /内网/],
    ['not-a-url', /格式/],
    ['', /格式/],
  ];
  for (const [url, pattern] of cases) {
    await assert.rejects(() => netSafety.assertSafeOutboundUrl(url), pattern, `${url} 应被拒绝`);
  }
  // 公网字面 IP 不需要 DNS 解析，直接通过
  await assert.doesNotReject(() => netSafety.assertSafeOutboundUrl('https://1.1.1.1/hook'));
  // 错误带 400，前端能拿到原因
  await assert.rejects(
    () => netSafety.assertSafeOutboundUrl('http://example.com/hook'),
    (err) => err.status === 400 && /https/.test(err.message),
  );
});
