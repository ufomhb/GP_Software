/* 多份持仓组合回归（v2.10.0）
   覆盖：
   - 旧数据兼容：原 holdings 自动就是「主持仓」这一份组合；
   - 新建 / 改名 / 删除组合，以及「组合之间互不影响」；
   - addedAt（建仓日）能往返保存，更新份额时不会被重置；
   - 上限与非法输入；
   - 快照包含组合、恢复时能把组合一起回滚。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, bootstrapAdmin } from './helpers/app.mjs';

for (const mode of ['json', 'sqlite']) {
  const label = mode === 'sqlite' ? 'SQLite' : 'JSON';

  test(`组合（${label}）：旧 holdings 自动成为「主持仓」`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);
    await c.post('/api/portfolio', {
      holdings: { '510300': { shares: 1000, cost: 3.8, addedAt: Date.UTC(2026, 0, 5) } },
    });
    const got = await c.get('/api/portfolio');
    assert.equal(got.status, 200);
    assert.equal(got.body.portfolios.length, 1);
    assert.equal(got.body.portfolios[0].id, 'default');
    assert.equal(got.body.portfolios[0].isDefault, true);
    assert.equal(got.body.portfolios[0].holdings['510300'].shares, 1000);
    assert.equal(got.body.portfolios[0].holdings['510300'].addedAt, Date.UTC(2026, 0, 5), '建仓日必须原样返回');
    // 旧的 holdings 字段形态不变（{shares,cost}），避免打断 v2.9.2 的客户端
    assert.deepEqual(got.body.holdings['510300'], { shares: 1000, cost: 3.8 });
  });

  test(`组合（${label}）：新建 / 改名 / 删除，且持仓互不影响`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);

    const created = await c.post('/api/portfolio/groups', { action: 'create', name: '结婚基金' });
    assert.equal(created.status, 200, created.text);
    const group = created.body.portfolios.find((g) => g.name === '结婚基金');
    assert.ok(group && group.id !== 'default');
    assert.equal(created.body.portfolios.length, 2);

    // 主持仓放一只，新组合放另一只
    await c.post('/api/portfolio', { holdings: { '110022': { shares: 300, cost: 2.1 } } });
    await c.post('/api/portfolio', {
      portfolios: [{ id: group.id, name: '结婚基金', holdings: { '161725': { shares: 500, cost: 1.5 } } }],
    });
    let got = await c.get('/api/portfolio');
    const main = got.body.portfolios.find((g) => g.id === 'default');
    const g2 = got.body.portfolios.find((g) => g.id === group.id);
    assert.deepEqual(Object.keys(main.holdings), ['110022'], '主持仓不应被组合 B 影响');
    assert.deepEqual(Object.keys(g2.holdings), ['161725'], '组合 B 不应被主持仓影响');

    const renamed = await c.post('/api/portfolio/groups', { action: 'rename', id: group.id, name: '父母养老' });
    assert.equal(renamed.status, 200, renamed.text);
    assert.ok(renamed.body.portfolios.some((g) => g.id === group.id && g.name === '父母养老'));

    const removed = await c.post('/api/portfolio/groups', { action: 'delete', id: group.id });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.portfolios.length, 1);
    got = await c.get('/api/portfolio');
    assert.equal(got.body.portfolios.length, 1);
    assert.deepEqual(Object.keys(got.body.holdings), ['110022'], '删除组合不该动主持仓');
  });

  test(`组合（${label}）：addedAt 在更新份额时保持不变`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);
    const addedAt = Date.UTC(2026, 2, 9);
    await c.post('/api/portfolio', { holdings: { '000001': { shares: 100, cost: 1, addedAt, updatedAt: addedAt } } });
    // 只改份额、不带 addedAt（旧版客户端 / 另一台设备）
    await c.post('/api/portfolio', { holdings: { '000001': { shares: 200, cost: 1, updatedAt: Date.now() } } });
    const got = await c.get('/api/portfolio');
    const entry = got.body.portfolios[0].holdings['000001'];
    assert.equal(entry.shares, 200);
    assert.equal(entry.addedAt, addedAt, '建仓日一旦记下就不能被后续保存冲掉');
  });

  test(`组合（${label}）：名称重复 / 超上限 / 非法操作都被拒绝`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);
    await c.post('/api/portfolio/groups', { action: 'create', name: '组合A' });
    const dup = await c.post('/api/portfolio/groups', { action: 'create', name: '组合A' });
    assert.equal(dup.status, 409, '重名应拒绝');
    const main = await c.post('/api/portfolio/groups', { action: 'create', name: '主持仓' });
    assert.equal(main.status, 409, '不能占用「主持仓」这个名字');
    const anonymous = await c.post('/api/portfolio/groups', { action: 'create', name: '' });
    assert.equal(anonymous.status, 400, '空名称应拒绝');
    const badDelete = await c.post('/api/portfolio/groups', { action: 'delete', id: 'default' });
    assert.equal(badDelete.status, 404, '主持仓不可删除');

    // 12 组上限（含主持仓）
    for (let i = 2; i <= 11; i += 1) {
      const res = await c.post('/api/portfolio/groups', { action: 'create', name: `组合${i}` });
      assert.equal(res.status, 200, `第 ${i} 组应创建成功：${res.text}`);
    }
    const overflow = await c.post('/api/portfolio/groups', { action: 'create', name: '组合12' });
    assert.equal(overflow.status, 400, '超过 12 份组合应拒绝');
    const got = await c.get('/api/portfolio');
    assert.equal(got.body.portfolios.length, 12);
  });

  test(`组合（${label}）：未登录不能建组合`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const anon = app.client();
    const res = await anon.post('/api/portfolio/groups', { action: 'create', name: 'x' });
    assert.equal(res.status, 401);
  });

  test(`组合（${label}）：快照含组合，后台恢复能把组合一起回滚`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);
    const created = await c.post('/api/portfolio/groups', { action: 'create', name: '第一版组合' });
    const gid = created.body.portfolios.find((g) => !g.isDefault).id;
    await c.post('/api/portfolio/groups', { action: 'create', name: '第二版组合' });
    await c.post('/api/portfolio', { holdings: { '510300': { shares: 500, cost: 3.9 } } });

    const me = await c.get('/api/auth/me');
    const userId = me.body.user.id;
    const hist = await c.get(`/api/admin/portfolio/history?userId=${encodeURIComponent(userId)}&limit=10`);
    assert.equal(hist.status, 200, hist.text);
    assert.ok(hist.body.items.length >= 1);
    const latest = hist.body.items[0];
    assert.ok(latest.counts.groups >= 1, '快照摘要要包含组合数');
    assert.equal(latest.counts.groups, 2, '两份额外组合都应被快照记录');

    // 再改一次，然后恢复到「两份组合」的那一版
    await c.post('/api/portfolio/groups', { action: 'delete', id: gid });
    let got = await c.get('/api/portfolio');
    assert.equal(got.body.portfolios.length, 2, '删掉一组后应剩 主持仓 + 第二版组合');

    const restored = await c.post('/api/admin/portfolio/restore', { userId, rev: latest.rev });
    assert.equal(restored.status, 200, restored.text);
    got = await c.get('/api/portfolio');
    assert.equal(got.body.portfolios.length, 3, '恢复后应回到 主持仓 + 两份组合');
    assert.ok(got.body.portfolios.some((g) => g.name === '第一版组合'));
  });
}
