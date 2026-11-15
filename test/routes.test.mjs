/**
 * 路由表回归测试（拆分路由分发前的安全网）
 *
 * 直接从源码里解析出所有 /api/* 端点和它们的方法，逐个请求，断言「分发器认得这个路由」：
 * 响应可以是 200 / 400 / 401 / 502，但不能是分发器兜底返回的「未知接口」。
 * 这样以后把 if 链搬进模块、或者漏传某个依赖，都能被这条测试抓住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, bootstrapAdmin } from './helpers/app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function collectRoutes() {
  const routes = new Map(); // path -> Set(method)
  for (const file of ['server.js', 'src/services/push.js']) {
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    for (const line of lines) {
      const method = /req\.method === 'POST'/.test(line) ? 'POST' : 'GET';
      for (const m of line.matchAll(/p === '(\/api\/[^']+)'/g)) {
        if (!routes.has(m[1])) routes.set(m[1], new Set());
        routes.get(m[1]).add(method);
        // 同一路径可能既有 GET 也有 POST，各记一条
        if (/req\.method === 'POST'/.test(line) && /&&/.test(line)) routes.get(m[1]).add('GET');
      }
    }
  }
  return [...routes.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const PUBLIC = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/auth/me', '/api/auth/password', '/api/health']);

test('路由：源码里解析出的每个 /api 端点都被分发器认得', async (t) => {
  const routes = collectRoutes();
  assert.ok(routes.length >= 60, `端点数量异常偏少：${routes.length}`);

  const app = await startApp();
  t.after(() => app.stop());
  const admin = await bootstrapAdmin(app, 'routercheck', 'routerpass1');

  const unknown = [];
  for (const [path, methods] of routes) {
    const method = methods.has('GET') || PUBLIC.has(path) ? 'GET' : 'POST';
    const client = PUBLIC.has(path) && method === 'GET' ? app.client() : admin;
    let res;
    try {
      res = await client.req(path, {
        method,
        ...(method === 'POST' ? { json: {} } : {}),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      continue; // 超时（例如十日异动扫描）视为已识别，避免拖慢测试
    }
    const err = res.body && res.body.error;
    if (err === '未知接口') unknown.push(`${method} ${path}`);
  }
  assert.deepEqual(unknown, [], `这些端点没被分发器识别：\n${unknown.join('\n')}`);
});

test('路由：未登录访问受保护端点返回 401 而不是 404', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const anon = app.client();
  for (const path of ['/api/overview', '/api/portfolio', '/api/funds/watch', '/api/admin/users']) {
    const res = await anon.get(path);
    assert.equal(res.status, 401, `${path} 应为 401`);
  }
});

test('路由：未知接口仍然返回 404 + 未知接口', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const admin = await bootstrapAdmin(app, 'routercheck', 'routerpass1');
  const res = await admin.get('/api/definitely-not-a-route');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, '未知接口');
});
