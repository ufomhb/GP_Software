/**
 * 日志落盘与后台日志接口（2026-11-15）
 *
 * 两段：
 * 1) 单元：轮转、末尾读取、关键词过滤、路径白名单；
 * 2) 接口：/api/admin/logs 需要管理员鉴权，且不接受任意路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startApp, bootstrapAdmin, ROOT } from './helpers/app.mjs';

const require = createRequire(import.meta.url);
const { createLogFiles } = require(join(ROOT, 'src', 'lib', 'log-files.js'));

test('日志文件：追加、轮转、末尾读取、关键词过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp-logs-'));
  try {
    const logs = createLogFiles({ dir, name: 'server', maxBytes: 120, keep: 2 });
    for (let i = 1; i <= 12; i += 1) logs.write(`line-${i} ${'x'.repeat(10)}`);

    const files = logs.list();
    assert.ok(files.length >= 2, `应该有轮转文件，实际 ${files.length}`);
    assert.equal(files[0].id, 'server');
    assert.ok(readdirSync(dir).includes('server.log'));

    const tail = logs.tail({ id: 'server', lines: 5 });
    assert.equal(tail.lines.length, 5);
    assert.ok(tail.lines[tail.lines.length - 1].includes('line-12'), '最后一行应为最新写入');
    assert.equal(tail.truncated, true);

    const hit = logs.tail({ id: 'server', lines: 50, filter: 'line-12' });
    assert.equal(hit.matched, 1);
    assert.ok(hit.lines[0].includes('line-12'));

    // 旧文件也能按 id 读，且里面是被轮转出去的老内容
    const older = logs.tail({ id: 'server.1', lines: 200 });
    assert.equal(older.id, 'server.1');
    assert.ok(older.lines.join('\n').includes('line-1 '), '第一行应已被轮转进 server.1');

    // 不存在的 id 回落到当前文件，不会抛
    assert.equal(logs.tail({ id: '../../etc/passwd' }).id, 'server');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('日志文件：console tee 落盘且不影响原输出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp-logs-'));
  const fake = { lines: [], log(...a) { this.lines.push(['log', a.join(' ')]); }, error(...a) { this.lines.push(['error', a.join(' ')]); }, warn() {}, info() {} };
  try {
    const logs = createLogFiles({ dir, name: 'tee' });
    const off = logs.installConsoleTee(fake);
    fake.log('hello', 1);
    fake.error('boom');
    off();
    fake.log('after-off');

    const view = logs.tail({ id: 'tee', lines: 10 });
    const text = view.lines.join('\n');
    assert.ok(text.includes('hello 1'), '普通输出应落盘');
    assert.ok(text.includes('ERROR boom'), '错误输出应带 ERROR 级别');
    assert.ok(!text.includes('after-off'), '卸载后不再落盘');
    assert.equal(fake.lines.length, 3, '原 console 行为保持不变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接口：/api/admin/logs 需要管理员，且只返回尾部内容', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const anon = app.client();
  assert.equal((await anon.get('/api/admin/logs')).status, 401, '未登录应 401');

  const admin = await bootstrapAdmin(app, 'logcheck', 'logpass123');
  await admin.get('/api/health');

  const res = await admin.get('/api/admin/logs?lines=50');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.files) && res.body.files.length > 0, '应能列出日志文件');
  assert.equal(res.body.files[0].id, 'server');
  assert.ok(Array.isArray(res.body.lines) && res.body.lines.length > 0, '应有日志内容');
  assert.ok(res.body.lines.some((l) => l.includes('/api/health')), '请求日志应被落盘');
  assert.ok(res.body.lines.length <= 50);

  // 关键词过滤
  const filtered = await admin.get('/api/admin/logs?lines=200&q=/api/health');
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.matched >= 1);
  assert.ok(filtered.body.lines.every((l) => l.includes('/api/health')));

  // 不允许用 file 参数越权读任意文件
  const evil = await admin.get('/api/admin/logs?file=../../data/users.json');
  assert.equal(evil.status, 200);
  assert.equal(evil.body.id, 'server', '非法文件 id 应回落到当前日志');
  assert.ok(!evil.text.includes('"hash"'), '不能读到账号数据');
});
