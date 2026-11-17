/**
 * 持仓策略接口集成测试（2026-11-17）
 *
 * 用真实启动的实例跑 HTTP 往返：确认路由接线、鉴权、参数保存与回读一致。
 * 只覆盖不依赖行情的路径（GET 快照 / POST 参数）；记录与评价要打行情接口，
 * 逻辑部分已在 test/strategy-log.test.mjs 里用注入数据覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { startApp, makeUser } from './helpers/app.mjs';

async function loginSuper(username, password) {
  const salt = 'c0ffee1234567890';
  const users = [makeUser({
    id: 'ustrategy01',
    username,
    salt,
    hash: scryptSync(password, salt, 64).toString('hex'),
    primary: true,
    role: 'super',
  })];
  const app = await startApp({ seed: { users } });
  const client = app.client();
  const res = await client.post('/api/auth/login', { username, password });
  assert.equal(res.status, 200, `super 登录失败：${res.status} ${res.text}`);
  return { app, client };
}

test('策略接口：未登录被拒绝', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const anon = app.client();
  const res = await anon.req('/api/admin/strategy');
  assert.equal(res.status, 401);
});

test('策略接口：快照字段完整，参数保存后可回读', async (t) => {
  const { app, client } = await loginSuper('stsup', 'stsuppass1');
  t.after(() => app.stop());

  const snap = await client.req('/api/admin/strategy');
  assert.equal(snap.status, 200, `快照失败：${snap.text}`);
  const data = snap.body || {};
  assert.equal(data.ok, true);
  assert.ok(data.today, '应返回今天的日期');
  assert.equal(typeof data.isWeekday, 'boolean');
  assert.ok(data.rules && typeof data.rules.addScore === 'number', '应返回规则参数');
  assert.ok(data.bands && typeof data.bands.holdBand === 'number', '应返回评价口径');
  assert.ok(Array.isArray(data.records), 'records 应是数组');
  assert.ok(data.stats && data.stats.byAction, '应返回命中率统计');
  assert.ok(Array.isArray(data.suggestions), '应返回改进建议');
  assert.equal(data.todayRecord, null, '新建实例当天还没有记录');

  // 保存参数 → 回读一致
  const saved = await client.req('/api/admin/strategy/config', {
    method: 'POST',
    json: { rules: { addScore: 70 }, bands: { holdBand: 1.1, evalWindow: 2 } },
  });
  assert.equal(saved.status, 200, `保存失败：${saved.text}`);
  assert.equal(saved.body?.rules?.addScore, 70);
  assert.equal(saved.body?.bands?.holdBand, 1.1);

  const again = await client.req('/api/admin/strategy');
  assert.equal(again.body?.rules?.addScore, 70, '参数应已持久化');
  assert.equal(again.body?.bands?.evalWindow, 2);

  // 非法值应被夹取，而不是原样写入
  const clamped = await client.req('/api/admin/strategy/config', {
    method: 'POST',
    json: { rules: { addScore: 999 }, bands: { evalWindow: 99 } },
  });
  assert.ok(clamped.body?.rules?.addScore <= 100);
  assert.ok(clamped.body?.bands?.evalWindow <= 10);
});
