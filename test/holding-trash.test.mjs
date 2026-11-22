/* 持仓回收站回归（v2.10.3）
   覆盖：
   - 删除持仓（shares=0 墓碑）时后台留档原份额 / 成本 / 建仓日 / 组合；
   - 后台按原值恢复，已重新持有的条目跳过、不覆盖；
   - 删除整份组合时，组合下的持仓一并留档；原组合不在了就恢复到主持仓；
   - 权限：未登录 401、普通用户 403。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, bootstrapAdmin } from './helpers/app.mjs';

async function userIdOf(c) {
  const me = await c.get('/api/auth/me');
  return me.body.user.id;
}

for (const mode of ['json', 'sqlite']) {
  const label = mode === 'sqlite' ? 'SQLite' : 'JSON';

  test(`回收站（${label}）：删除持仓留档原值，后台可恢复`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);
    const addedAt = Date.UTC(2026, 3, 8);
    await c.post('/api/portfolio', {
      funds: [{ code: '510300', name: '沪深300ETF', type: 'etf' }],
      holdings: { '510300': { shares: 1000, cost: 3.8, addedAt } },
    });
    // 删除 = 写 shares=0 墓碑（前端「我的持仓」删除按钮就是这么做的）
    const del = await c.post('/api/portfolio', {
      holdings: { '510300': { shares: 0, cost: 0, updatedAt: Date.now() } },
    });
    assert.equal(del.status, 200, del.text);
    let got = await c.get('/api/portfolio');
    assert.deepEqual(got.body.holdings, {}, '删除后不该再持有');

    const uid = await userIdOf(c);
    const trash = await c.get(`/api/admin/portfolio/trash?userId=${encodeURIComponent(uid)}`);
    assert.equal(trash.status, 200, trash.text);
    assert.equal(trash.body.items.length, 1, '删除的持仓必须出现在回收站');
    const item = trash.body.items[0];
    assert.equal(item.code, '510300');
    assert.equal(item.name, '沪深300ETF', '要带上基金名，后台好认');
    assert.equal(item.shares, 1000, '留档原份额');
    assert.equal(item.cost, 3.8, '留档原成本净值');
    assert.equal(item.addedAt, addedAt, '留档原建仓日');
    assert.equal(item.portfolioId, 'default');
    assert.equal(item.portfolioName, '主持仓');

    const restored = await c.post('/api/admin/portfolio/trash/restore', { userId: uid, ids: [item.id] });
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.body.restored, 1);
    got = await c.get('/api/portfolio');
    const entry = got.body.portfolios[0].holdings['510300'];
    assert.ok(entry, '恢复后应该重新持有');
    assert.equal(entry.shares, 1000);
    assert.equal(entry.cost, 3.8);
    assert.equal(entry.addedAt, addedAt, '建仓日也要原样恢复');

    const pending = await c.get(`/api/admin/portfolio/trash?userId=${encodeURIComponent(uid)}`);
    assert.equal(pending.body.items.length, 0, '恢复后不再出现在待恢复列表');
    const all = await c.get(`/api/admin/portfolio/trash?userId=${encodeURIComponent(uid)}&all=1`);
    assert.equal(all.body.items.length, 1);
    assert.ok(all.body.items[0].restoredAt > 0, '勾选「含已恢复」能看到恢复时间');
  });

  test(`回收站（${label}）：已重新持有的基金恢复时跳过，不覆盖新数据`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);
    await c.post('/api/portfolio', { holdings: { '110022': { shares: 1000, cost: 2 } } });
    await c.post('/api/portfolio', { holdings: { '110022': { shares: 0, cost: 0, updatedAt: Date.now() } } });
    // 用户后来又买回来了
    await c.post('/api/portfolio', { holdings: { '110022': { shares: 200, cost: 2.4, updatedAt: Date.now() } } });
    const uid = await userIdOf(c);
    const trash = await c.get(`/api/admin/portfolio/trash?userId=${encodeURIComponent(uid)}`);
    assert.equal(trash.body.items.length, 1);
    const out = await c.post('/api/admin/portfolio/trash/restore', { userId: uid, ids: [trash.body.items[0].id] });
    assert.equal(out.status, 200, out.text);
    assert.equal(out.body.restored, 0, '已持有就不能再写一遍');
    assert.equal(out.body.skipped.length, 1);
    assert.equal(out.body.skipped[0].status, 'exists');
    const got = await c.get('/api/portfolio');
    assert.equal(got.body.holdings['110022'].shares, 200, '现有持仓不能被旧数据覆盖');
    assert.equal(got.body.holdings['110022'].cost, 2.4);
    const still = await c.get(`/api/admin/portfolio/trash?userId=${encodeURIComponent(uid)}`);
    assert.equal(still.body.items.length, 1, '跳过的条目留在回收站，方便用户先清仓再恢复');
  });

  test(`回收站（${label}）：删除整份组合会留档，恢复时回到主持仓`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);
    const created = await c.post('/api/portfolio/groups', { action: 'create', name: '待删组合' });
    const gid = created.body.portfolios.find((g) => !g.isDefault).id;
    await c.post('/api/portfolio', {
      funds: [{ code: '161725', name: '招商中证白酒', type: 'open' }],
      portfolios: [{ id: gid, name: '待删组合', holdings: { '161725': { shares: 500, cost: 1.5 } } }],
    });
    const removed = await c.post('/api/portfolio/groups', { action: 'delete', id: gid });
    assert.equal(removed.status, 200, removed.text);

    const uid = await userIdOf(c);
    const trash = await c.get(`/api/admin/portfolio/trash?userId=${encodeURIComponent(uid)}`);
    assert.equal(trash.body.items.length, 1, '删组合时组合下的持仓要留档');
    const item = trash.body.items[0];
    assert.equal(item.code, '161725');
    assert.equal(item.shares, 500);
    assert.equal(item.portfolioId, gid);
    assert.equal(item.portfolioName, '待删组合');

    const out = await c.post('/api/admin/portfolio/trash/restore', { userId: uid, ids: [item.id] });
    assert.equal(out.status, 200, out.text);
    assert.equal(out.body.restored, 1);
    const got = await c.get('/api/portfolio');
    assert.equal(got.body.portfolioId, undefined);
    assert.equal(got.body.portfolios.length, 1, '原组合已删除，不该被偷偷重建');
    assert.equal(got.body.portfolios[0].id, 'default');
    assert.equal(got.body.holdings['161725'].shares, 500, '恢复到主持仓');
  });
}

test('回收站：未登录 401、普通用户 403', async (t) => {
  const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
  t.after(() => app.stop());
  const admin = await bootstrapAdmin(app);
  const bob = app.client();
  await bob.post('/api/auth/register', { username: 'bob', password: 'bobpass123' });
  const me = await bob.get('/api/auth/me');
  assert.equal(me.body.user.role, 'user');

  const anon = app.client();
  const anonRes = await anon.get('/api/admin/portfolio/trash');
  assert.equal(anonRes.status, 401);
  const bobRes = await bob.get('/api/admin/portfolio/trash');
  assert.equal(bobRes.status, 403);

  // 管理员查询缺 userId 时是 400，而不是把「全部账号的删除记录」端出来
  const noId = await admin.get('/api/admin/portfolio/trash');
  assert.equal(noId.status, 400);
});
