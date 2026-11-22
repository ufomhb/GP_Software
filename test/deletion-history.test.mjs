/* 持仓删除历史（v2.10.5）
   覆盖：
   - 删除一个 TAB（例如 TEST 只有 1 只基金）时，后台只记录被删的那个 TAB；
   - 详情数据（funds / tabHoldings）与恢复：按原名称重建 TAB，保留份额 / 成本 / 建仓日；
   - 单只删除只记录该基金，恢复时只补缺、不动仍持有的；
   - 用户手动加回来后自动标记已恢复；
   - v2.10.4 之前的逐条删除记录会补成 TAB 事件。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, bootstrapAdmin } from './helpers/app.mjs';

async function userIdOf(c) {
  const me = await c.get('/api/auth/me');
  return me.body.user.id;
}

for (const mode of ['json', 'sqlite']) {
  const label = mode === 'sqlite' ? 'SQLite' : 'JSON';

  test(`删除历史（${label}）：删除 TEST 只记录这个 TAB（1 只），可详情 / 恢复`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);
    const addedAt = Date.UTC(2026, 4, 6);
    const created = await c.post('/api/portfolio/groups', { action: 'create', name: 'TEST' });
    const gid = created.body.portfolios.find((g) => !g.isDefault).id;
    await c.post('/api/portfolio', {
      funds: [{ code: '021277', name: '广发全球精选股票(QDII)人民币C', type: 'open' }],
      portfolios: [{ id: gid, name: 'TEST', holdings: { '021277': { shares: 10000, cost: 4.5, addedAt } } }],
    });
    const removed = await c.post('/api/portfolio/groups', { action: 'delete', id: gid });
    assert.equal(removed.status, 200, removed.text);

    const uid = await userIdOf(c);
    const list = await c.get(`/api/admin/portfolio/deletions?userId=${encodeURIComponent(uid)}`);
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.items.length, 1, '一次 TAB 删除只留一条记录');
    const ev = list.body.items[0];
    assert.equal(ev.portfolioName, 'TEST');
    assert.equal(ev.tabDeleted, true);
    assert.equal(ev.funds.length, 1, '只记录被删的那个 TAB 的 1 只基金');
    assert.equal(ev.funds[0].code, '021277');
    assert.equal(ev.funds[0].shares, 10000);
    assert.equal(ev.tabHoldings.length, 1, '删除时该 TAB 下只有这 1 只');
    assert.equal(ev.restoredAt, 0, '刚删完是待恢复');

    const out = await c.post('/api/admin/portfolio/deletions/restore', { userId: uid, id: ev.id });
    assert.equal(out.status, 200, out.text);
    assert.equal(out.body.restored, 1);
    assert.equal(out.body.recreated, true, '原 TAB 已删除，需按原名称重建');
    assert.equal(out.body.portfolioName, 'TEST');
    const got = await c.get('/api/portfolio');
    const tab = got.body.portfolios.find((g) => g.name === 'TEST');
    assert.ok(tab, '应按原名称重建 TEST');
    const holding = tab.holdings['021277'];
    assert.equal(holding.shares, 10000);
    assert.equal(holding.cost, 4.5);
    assert.equal(holding.addedAt, addedAt, '建仓日必须原样恢复，盈亏统计不能提前');
    const after = await c.get(`/api/admin/portfolio/deletions?userId=${encodeURIComponent(uid)}`);
    assert.ok(after.body.items[0].restoredAt > 0, '恢复后状态转为已恢复');
  });

  test(`删除历史（${label}）：单只删除只记录该基金，恢复只补缺`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);
    const addedAt = Date.UTC(2026, 3, 8);
    await c.post('/api/portfolio', {
      funds: [
        { code: '510300', name: '沪深300ETF', type: 'etf' },
        { code: '110022', name: '易方达消费行业', type: 'open' },
      ],
      holdings: {
        '510300': { shares: 1000, cost: 3.8, addedAt },
        '110022': { shares: 500, cost: 2, addedAt },
      },
    });
    await c.post('/api/portfolio', {
      holdings: { '510300': { shares: 0, cost: 0, updatedAt: Date.now() } },
    });

    const uid = await userIdOf(c);
    const list = await c.get(`/api/admin/portfolio/deletions?userId=${encodeURIComponent(uid)}`);
    assert.equal(list.body.items.length, 1, '只删一只基金也只留一条记录');
    const ev = list.body.items[0];
    assert.equal(ev.portfolioId, 'default');
    assert.equal(ev.funds.length, 1, 'funds 只含被删的那只');
    assert.equal(ev.funds[0].code, '510300');
    assert.equal(ev.tabHoldings.length, 2, 'tabHoldings 是该 TAB 删除时的全部持仓');

    const out = await c.post('/api/admin/portfolio/deletions/restore', { userId: uid, id: ev.id });
    assert.equal(out.status, 200, out.text);
    assert.equal(out.body.restored, 1, '只补回被删的那只');
    assert.equal(out.body.skipped.length, 1, '仍在持有的那只跳过');
    assert.equal(out.body.recreated, false, '主持仓不需要重建');
    const got = await c.get('/api/portfolio');
    assert.equal(got.body.portfolios[0].holdings['510300'].shares, 1000);
    assert.equal(got.body.portfolios[0].holdings['510300'].addedAt, addedAt, '建仓日保留');
    assert.equal(got.body.portfolios[0].holdings['110022'].shares, 500, '原有持仓不能被覆盖');
  });

  test(`删除历史（${label}）：用户手动加回来后自动标记为已恢复`, async (t) => {
    const app = await startApp({ mode });
    t.after(() => app.stop());
    const c = await bootstrapAdmin(app);
    const created = await c.post('/api/portfolio/groups', { action: 'create', name: 'T2' });
    const gid = created.body.portfolios.find((g) => !g.isDefault).id;
    await c.post('/api/portfolio', {
      portfolios: [{ id: gid, name: 'T2', holdings: { '161725': { shares: 500, cost: 1.5 } } }],
    });
    await c.post('/api/portfolio', {
      portfolios: [{ id: gid, holdings: { '161725': { shares: 0, cost: 0, updatedAt: Date.now() } } }],
    });
    const uid = await userIdOf(c);
    let list = await c.get(`/api/admin/portfolio/deletions?userId=${encodeURIComponent(uid)}`);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].restoredAt, 0, '刚删完仍是待恢复');

    // 用户后来自己又加回来（比如从服务端恢复或手动补录）
    await c.post('/api/portfolio', {
      portfolios: [{ id: gid, holdings: { '161725': { shares: 200, cost: 1.6, updatedAt: Date.now() } } }],
    });
    list = await c.get(`/api/admin/portfolio/deletions?userId=${encodeURIComponent(uid)}`);
    const ev = list.body.items[0];
    assert.ok(ev.restoredAt > 0, '数据回来了就不再显示待恢复');
    assert.equal(ev.restoredBy, 'detected');
    assert.equal(ev.funds[0].shares, 500, '删除时的快照仍然是原来的 500 份');
  });
}

test('删除历史：v2.10.4 之前的逐条删除记录会补成 TAB 事件', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app);
  const uid = await userIdOf(c);
  const addedAt = Date.UTC(2026, 4, 6);
  const now = Date.now();
  const extrasFile = join(app.dataDir, 'userdata', `${uid}.extras.json`);
  mkdirSync(join(app.dataDir, 'userdata'), { recursive: true });
  writeFileSync(extrasFile, JSON.stringify({
    fund_holding_trash: [{
      id: 'htlegacy1',
      code: '021277',
      name: '广发全球精选股票(QDII)人民币C',
      type: 'open',
      portfolioId: 'p-legacy',
      portfolioName: 'TEST',
      shares: 10000,
      cost: 4.5,
      addedAt,
      tabSnapshot: [{ code: '021277', name: '广发全球精选股票(QDII)人民币C', type: 'open', shares: 10000, cost: 4.5, addedAt }],
      tabHoldingCount: 1,
      tabDeleted: true,
      deletedAt: now,
      rev: now,
      action: 'group-delete',
      source: 'web',
      ip: '',
    }],
  }), 'utf8');
  const list = await c.get(`/api/admin/portfolio/deletions?userId=${encodeURIComponent(uid)}`);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.items.length, 1, '旧记录应补成一条 TAB 事件');
  const ev = list.body.items[0];
  assert.equal(ev.portfolioName, 'TEST');
  assert.equal(ev.funds.length, 1);
  assert.equal(ev.tabHoldings[0].shares, 10000);
  assert.equal(ev.restoredAt, 0, 'TEST 现在不在持仓里，所以是待恢复');
});

test('删除历史：旧记录没有建仓日时，恢复统一按 2026-11-01 写回（v2.10.7）', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app);
  const uid = await userIdOf(c);
  const now = Date.now();
  const legacy = Date.parse('2026-11-01T00:00:00+08:00');
  const extrasFile = join(app.dataDir, 'userdata', `${uid}.extras.json`);
  mkdirSync(join(app.dataDir, 'userdata'), { recursive: true });
  writeFileSync(extrasFile, JSON.stringify({
    fund_holding_trash: [{
      id: 'htlegacy2',
      code: '021277',
      name: '广发全球精选股票(QDII)人民币C',
      type: 'open',
      portfolioId: 'p-legacy',
      portfolioName: 'OLD',
      shares: 10000,
      cost: 4.5,
      // 没有 addedAt：v2.10.0 之前的老记录本来就记不了建仓日
      tabSnapshot: [{ code: '021277', name: '广发全球精选股票(QDII)人民币C', type: 'open', shares: 10000, cost: 4.5 }],
      tabHoldingCount: 1,
      tabDeleted: true,
      deletedAt: now,
      rev: now,
      action: 'group-delete',
      source: 'web',
      ip: '',
    }],
  }), 'utf8');
  const list = await c.get(`/api/admin/portfolio/deletions?userId=${encodeURIComponent(uid)}`);
  assert.equal(list.status, 200, list.text);
  const ev = list.body.items[0];
  assert.equal(ev.funds[0].addedAt, 0, '旧记录本身没有建仓日');
  const out = await c.post('/api/admin/portfolio/deletions/restore', { userId: uid, id: ev.id });
  assert.equal(out.status, 200, out.text);
  const got = await c.get('/api/portfolio');
  const tab = got.body.portfolios.find((g) => g.name === 'OLD');
  assert.ok(tab, '按原名称重建组合');
  assert.equal(tab.holdings['021277'].shares, 10000);
  assert.equal(tab.holdings['021277'].addedAt, legacy, '老记录没有建仓日的按 2026-11-01 恢复');
});

test('删除历史：原 TAB 删除后用户又建了同名 TAB，恢复并入而不是重建 TEST-2', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app);
  const addedAt = Date.UTC(2026, 4, 6);
  const created = await c.post('/api/portfolio/groups', { action: 'create', name: 'TEST' });
  const gid = created.body.portfolios.find((g) => !g.isDefault).id;
  await c.post('/api/portfolio', {
    portfolios: [{ id: gid, name: 'TEST', holdings: { '021277': { shares: 10000, cost: 4.5, addedAt } } }],
  });
  await c.post('/api/portfolio/groups', { action: 'delete', id: gid });
  const uid = await userIdOf(c);
  const list = await c.get(`/api/admin/portfolio/deletions?userId=${encodeURIComponent(uid)}`);
  const ev = list.body.items[0];
  assert.equal(ev.restoredAt, 0, '刚删完是待恢复');

  // 用户手动重建同名 TAB，并加回同一只基金（份额不同）
  const again = await c.post('/api/portfolio/groups', { action: 'create', name: 'TEST' });
  const gid2 = again.body.portfolios.find((g) => g.name === 'TEST').id;
  await c.post('/api/portfolio', {
    portfolios: [{ id: gid2, name: 'TEST', holdings: { '021277': { shares: 300, cost: 4.2, updatedAt: Date.now() } } }],
  });
  const after = await c.get(`/api/admin/portfolio/deletions?userId=${encodeURIComponent(uid)}`);
  assert.ok(after.body.items[0].restoredAt > 0, '同名 TAB 里的数据回来了也算已恢复');

  const out = await c.post('/api/admin/portfolio/deletions/restore', { userId: uid, id: ev.id });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.body.restored, 0, '数据都在，不需要再写回');
  const got = await c.get('/api/portfolio');
  const tabs = got.body.portfolios.filter((g) => String(g.name || '').startsWith('TEST'));
  assert.equal(tabs.length, 1, '不能多出 TEST-2');
  assert.equal(tabs[0].holdings['021277'].shares, 300, '现有持仓不被旧快照覆盖');
});
