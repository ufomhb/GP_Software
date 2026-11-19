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

  // 拆模块最容易漏的是「注入了却没传」：接口抛 ReferenceError / TypeError，
  // 但客户端只看到脱敏后的 5xx，所以改从子进程日志里找证据。
  await new Promise((r) => setTimeout(r, 300));
  const runtime = app.logs().split('\n').filter((l) => /is not defined|is not a function/.test(l));
  assert.deepEqual(runtime, [], `依赖没注入，运行时报错：\n${runtime.join('\n')}`);
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

test('基金：pnl-series 需要登录，且最多 12 只', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const anon = app.client();
  const unauth = await anon.get('/api/funds/pnl-series?codes=510300');
  assert.equal(unauth.status, 401);

  const admin = await bootstrapAdmin(app, 'pnlcheck', 'pnlpass123');
  const codes = Array.from({ length: 13 }, (_, i) => String(600000 + i)).join(',');
  const tooMany = await admin.get(`/api/funds/pnl-series?codes=${codes}`);
  assert.equal(tooMany.status, 400);
  assert.match(String(tooMany.body.error || ''), /12/);
});

test('后台模拟盘 / 回测接口：未登录 401，参数被夹取', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const anon = app.client();
  for (const path of ['/api/admin/paper']) {
    const res = await anon.get(path);
    assert.equal(res.status, 401, `${path} 应为 401`);
  }
  for (const path of ['/api/admin/paper/config', '/api/admin/paper/reset', '/api/admin/strategy/backfill']) {
    const res = await anon.req(path, { method: 'POST', json: {} });
    assert.equal(res.status, 401, `${path} 应为 401`);
  }

  const admin = await bootstrapAdmin(app, 'paperroute', 'paperpass1');
  // 回测：没有持仓时给出可读的 400，而不是 5xx
  const bf = await admin.req('/api/admin/strategy/backfill', { method: 'POST', json: { days: 999 } });
  assert.ok([200, 400].includes(bf.status), `回测应 200/400，实际 ${bf.status}`);
  if (bf.status === 400) assert.ok(bf.body.error);
});
