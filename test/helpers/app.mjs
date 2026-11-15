/**
 * 测试脚手架：把代码复制到临时目录，起一个隔离实例（不碰仓库里的 data/）。
 *
 * 用法：
 *   const app = await startApp();                  // 默认 json 存储
 *   const app = await startApp({ mode: 'sqlite' }); // 先迁移再起 sqlite
 *   const c = app.client();                         // 带 cookie 的简易客户端
 *   await app.stop();
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let portCursor = 19000 + Math.floor(Math.random() * 400);

export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async req(path, { method = 'GET', json, headers = {}, cookie } = {}) {
    const h = { ...headers };
    if (json !== undefined) h['Content-Type'] = 'application/json';
    const useCookie = cookie === undefined ? this.cookie : cookie;
    if (useCookie) h.Cookie = useCookie;
    const res = await fetch(`${this.base}${path}`, {
      method,
      redirect: 'manual',
      headers: h,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON */ }
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && cookie === undefined) {
      const first = setCookie.split(';')[0];
      this.cookie = first.endsWith('=') ? '' : first;
    }
    return { status: res.status, headers: res.headers, text, body };
  }

  get(path, opts) { return this.req(path, opts); }
  post(path, json, opts = {}) { return this.req(path, { ...opts, method: 'POST', json }); }
}

export async function startApp(opts = {}) {
  const {
    mode = 'json',
    env = {},
    seed = {}, // { users: [...], pushConfig: {...}, userdata: { userId: {...} } }
  } = opts;

  const work = mkdtempSync(join(tmpdir(), 'gp-test-'));
  for (const name of ['server.js', 'package.json']) {
    cpSync(join(ROOT, name), join(work, name));
  }
  for (const dir of ['lib', 'src', 'public', 'scripts']) {
    if (existsSync(join(ROOT, dir))) cpSync(join(ROOT, dir), join(work, dir), { recursive: true });
  }
  const dataDir = join(work, 'data');
  mkdirSync(dataDir, { recursive: true });

  if (seed.users) {
    writeFileSync(join(dataDir, 'users.json'), JSON.stringify({ users: seed.users }, null, 2));
  }
  if (seed.pushConfig) {
    writeFileSync(join(dataDir, 'push-config.json'), JSON.stringify(seed.pushConfig, null, 2));
  }
  for (const [userId, payload] of Object.entries(seed.userdata || {})) {
    const dir = join(dataDir, 'userdata');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${userId}.json`), JSON.stringify(payload, null, 2));
  }

  if (mode === 'sqlite') {
    const store = require(join(work, 'lib', 'store.js'));
    const report = store.migrateFromJson({ verify: true });
    if (report.verify && !report.verify.ok) {
      throw new Error(`测试数据迁移校验失败：${JSON.stringify(report.verify.problems)}`);
    }
    store.close();
  }

  const port = portCursor++;
  const child = spawn(process.execPath, ['server.js', `--port=${port}`, '--host=127.0.0.1'], {
    cwd: work,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      ...(mode === 'sqlite' ? { STORE: 'sqlite' } : { STORE: 'json' }),
      ...env,
    },
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) { ready = true; break; }
    } catch { /* 还没起来 */ }
  }
  if (!ready) {
    child.kill();
    throw new Error(`实例启动超时（:${port}）\n${logs}`);
  }

  return {
    base,
    work,
    dataDir,
    logs: () => logs,
    client: (cookie) => {
      const c = new Client(base);
      if (cookie) c.cookie = cookie;
      return c;
    },
    readData: (name) => readFileSync(join(dataDir, name), 'utf8'),
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 250));
      try { rmSync(work, { recursive: true, force: true }); } catch { /* 清理失败不影响测试结果 */ }
    },
  };
}

/** 注册第一个账号（空库时允许），返回已带 cookie 的客户端 */
export async function bootstrapAdmin(app, username = 'testadmin', password = 'testpass123') {
  const c = app.client();
  const res = await c.post('/api/auth/register', { username, password });
  if (res.status !== 200) throw new Error(`注册首个账号失败：${res.status} ${res.text}`);
  return c;
}

export function makeUser(overrides = {}) {
  return {
    id: 'utest0001',
    username: 'user1',
    salt: 'c0ffee',
    hash: 'deadbeef',
    primary: false,
    role: 'user',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}
