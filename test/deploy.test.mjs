/**
 * 「推送代码到 NAS」功能回归测试（2026-11-17）
 *
 * 只测不依赖网络的部分：
 *  - 部署引擎的步骤表与快照结构；
 *  - 鉴权与确认位闸门（防止误触发真实推送、防止未登录调用）。
 * 真正的推送流程需要 NAS 可连，交给手工验证，不放进自动测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, bootstrapAdmin } from './helpers/app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const nasDeploy = require('../src/lib/nas-deploy.js');

test('部署模块：7 步流程与快照结构', () => {
  assert.equal(nasDeploy.STEPS.length, 7);
  const ids = nasDeploy.STEPS.map((s) => s.id);
  assert.deepEqual(ids, ['preflight', 'package', 'backup', 'upload', 'extract', 'restart', 'health']);
  assert.ok(nasDeploy.STEPS.every((s) => typeof s.weight === 'number' && s.weight > 0));
  assert.equal(nasDeploy.STEPS.reduce((sum, s) => sum + s.weight, 0), 100, '步骤权重应合计 100%');

  const engine = nasDeploy.createDeployToNas({ rootDir: ROOT, version: 'test-version' });
  const snap = engine.snapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.localVersion, 'test-version');
  assert.equal(snap.supported, process.platform === 'win32');
  assert.equal(snap.job, null, '未推送时不应有任务');
  if (snap.supported) {
    assert.ok(snap.pending.totalFiles > 0, '应能扫描到本地代码文件');
    assert.equal(typeof snap.pending.changedCount, 'number');
  }
});

test('推送接口：未登录被拒绝', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  await bootstrapAdmin(app, 'depowner', 'depownerpass1');
  const anon = app.client();
  const res = await anon.req('/api/admin/deploy/start', { method: 'POST', json: { confirm: true } });
  assert.equal(res.status, 401, '未登录必须被拒绝');
});

test('推送接口：缺少 confirm 时不触发推送', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const admin = await bootstrapAdmin(app, 'depadmin', 'depadminpass1');
  const res = await admin.req('/api/admin/deploy/start', { method: 'POST', json: {} });
  assert.equal(res.status, 400, '没有 confirm=true 必须拒绝');
  const data = await res.json();
  assert.match(String(data.error || ''), /confirm/i);
});
