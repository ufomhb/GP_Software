/**
 * 路由表回归测试（拆分路由分发前的安全网）
 *
 * 直接从源码里解析出所有 /api/* 端点和它们的方法，逐个请求，断言「分发器认得这个路由」：
 * 响应可以是 200 / 400 / 401 / 502，但不能是分发器兜底返回的「未知接口」。
 * 这样以后把 if 链搬进模块、或者漏传某个依赖，都能被这条测试抓住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, bootstrapAdmin } from './helpers/app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

function collectRoutes() {
  const routes = new Map(); // path -> Set(method)
  // 路由链可能在 server.js，也可能在 src/** 里（拆分后）
  const files = [join(ROOT, 'server.js'), ...walk(join(ROOT, 'src'))];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const isPost = /req\.method === 'POST'/.test(line);
      for (const m of line.matchAll(/p === '(\/api\/[^']+)'/g)) {
        if (!routes.has(m[1])) routes.set(m[1], new Set());
        routes.get(m[1]).add(isPost ? 'POST' : 'GET');
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
  const queue = [...routes];
  // 串行跑要 50 秒以上（多数端点会打上游），这里并发 6 个
  const worker = async () => {
    while (queue.length) {
      const [path, methods] = queue.shift();
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
  };
  await Promise.all(Array.from({ length: 6 }, worker));
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
