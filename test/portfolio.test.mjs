import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, bootstrapAdmin } from './helpers/app.mjs';

test('持仓：写入后读取一致（含顺序、金额、自选股）', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');

  const funds = [
    { code: '510300', name: '沪深300ETF', type: 'etf' },
    { code: '005825', name: '华夏中证500ETF联接A', type: 'open' },
  ];
  const holdings = {
    '510300': { shares: 1000, cost: 3.85 },
    '005825': { shares: 2000, cost: 1.42 },
  };
  const watchlist = [{ secid: '1.600519', code: '600519', name: '贵州茅台' }];

  const saved = await c.post('/api/portfolio', { funds, holdings, watchlist });
  assert.equal(saved.status, 200);

  const got = await c.get('/api/portfolio');
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.funds, funds);
  assert.deepEqual(got.body.holdings, holdings);
  assert.deepEqual(got.body.watchlist, watchlist);
  assert.ok(got.body.updatedAt, 'updatedAt 应有值');
});

test('持仓：脏数据被清洗（非法份额、缺 code、超长列表）', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');

  const dirty = {
    funds: [
      ...Array.from({ length: 40 }, (_, i) => ({ code: `F${i}`, name: `基金${i}`, type: 'open' })),
      { name: '没有代码' },
      null,
    ],
    holdings: {
      '510300': { shares: -5, cost: 3.8 }, // 负数份额 → 丢弃
      '159915': { shares: 100, cost: 2.0 }, // 正常
      '512880': 'not-an-object',
      '': { shares: 10 },
    },
    watchlist: [
      { secid: '1.600519', code: '600519', name: '贵州茅台' },
      { code: '000001', name: '没有 secid' },
    ],
  };
  const saved = await c.post('/api/portfolio', dirty);
  assert.equal(saved.status, 200);

  const got = await c.get('/api/portfolio');
  assert.equal(got.body.funds.length, 30, '自选基金上限 30 只');
  assert.ok(got.body.funds.every((f) => f.code));
  assert.deepEqual(Object.keys(got.body.holdings), ['159915']);
  assert.equal(got.body.watchlist.length, 1);
});

test('持仓：账号之间互相隔离，普通用户看不到别人的数据', async (t) => {
  const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
  t.after(() => app.stop());

  const alice = app.client();
  await alice.post('/api/auth/register', { username: 'alice', password: 'alice12345' });
  const bob = app.client();
  await bob.post('/api/auth/register', { username: 'bob', password: 'bob123456' });

  await alice.post('/api/portfolio', {
    funds: [{ code: '510300', name: '沪深300ETF', type: 'etf' }],
    holdings: { '510300': { shares: 100, cost: 3.9 } },
    watchlist: [],
  });
  await bob.post('/api/portfolio', {
    funds: [{ code: '005827', name: '易方达蓝筹', type: 'open' }],
    holdings: {},
    watchlist: [],
  });

  const aliceView = await alice.get('/api/portfolio');
  const bobView = await bob.get('/api/portfolio');
  assert.deepEqual(aliceView.body.funds.map((f) => f.code), ['510300']);
  assert.deepEqual(bobView.body.funds.map((f) => f.code), ['005827']);
  assert.deepEqual(Object.keys(aliceView.body.holdings), ['510300']);
  assert.deepEqual(Object.keys(bobView.body.holdings), []);
});

test('持仓：推送同步接口只写自己的数据', async (t) => {
  const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
  t.after(() => app.stop());
  const alice = app.client();
  await alice.post('/api/auth/register', { username: 'alice', password: 'alice12345' });

  const synced = await alice.post('/api/push/sync', {
    funds: [{ code: '110022', name: '易方达消费行业', type: 'open' }],
    holdings: { '110022': { shares: 300, cost: 2.11 } },
  });
  assert.equal(synced.status, 200);
  const got = await alice.get('/api/portfolio');
  assert.deepEqual(got.body.funds.map((f) => f.code), ['110022']);
  assert.equal(got.body.holdings['110022'].shares, 300);
});

test('持仓：SQLite 模式下同样可读写', async (t) => {
  const app = await startApp({ mode: 'sqlite' });
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');

  const saved = await c.post('/api/portfolio', {
    funds: [{ code: '510300', name: '沪深300ETF', type: 'etf' }],
    holdings: { '510300': { shares: 500, cost: 3.75 } },
    watchlist: [{ secid: '1.600519', code: '600519', name: '贵州茅台' }],
  });
  assert.equal(saved.status, 200);

  const got = await c.get('/api/portfolio');
  assert.deepEqual(got.body.funds.map((f) => f.code), ['510300']);
  assert.equal(got.body.holdings['510300'].shares, 500);
  assert.equal(got.body.watchlist.length, 1);
});

test('持仓：条目时间戳合并——拿旧副本提交不会覆盖新改动', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');
  const now = Date.now();

  await c.post('/api/portfolio', {
    funds: [],
    watchlist: [],
    holdings: { 510300: { shares: 1000, cost: 3.8, updatedAt: now } },
  });
  // 另一台设备/旧标签页拿着更早的时间戳提交（模拟「昨天改的今天被回滚」）
  await c.post('/api/portfolio', {
    holdings: { 510300: { shares: 100, cost: 3.8, updatedAt: now - 600000 } },
  });
  const got = await c.get('/api/portfolio');
  assert.equal(got.body.holdings['510300'].shares, 1000, '较新的份额必须保留');
});

test('持仓：删除墓碑能跨端生效，且不会出现在接口返回里', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');
  const now = Date.now();

  await c.post('/api/portfolio', {
    holdings: { 510300: { shares: 500, cost: 3.8, updatedAt: now - 1000 } },
  });
  // 删除 = shares 0 + 更新的时间戳
  await c.post('/api/portfolio', {
    holdings: { 510300: { shares: 0, cost: 0, updatedAt: now } },
  });
  const got = await c.get('/api/portfolio');
  assert.deepEqual(Object.keys(got.body.holdings), [], '删除后不应再返回该条目');

  // 更旧的「还有 500 份」不能再把墓碑顶掉
  await c.post('/api/portfolio', {
    holdings: { 510300: { shares: 500, cost: 3.8, updatedAt: now - 5000 } },
  });
  const again = await c.get('/api/portfolio');
  assert.deepEqual(Object.keys(again.body.holdings), [], '墓碑比旧数据新，仍应保持删除');
});

test('持仓：baseRev 过期且内容不同时返回冲突标记与服务器快照', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');

  const first = await c.post('/api/portfolio', {
    funds: [{ code: '510300', name: '沪深300ETF', type: 'etf' }],
    holdings: { 510300: { shares: 100, cost: 3.8 } },
    watchlist: [],
  });
  const revA = first.body.rev;
  assert.ok(revA > 0, '写入后应返回 rev');

  // 另一台设备先改了自选基金
  const second = await c.post('/api/portfolio', {
    funds: [
      { code: '510300', name: '沪深300ETF', type: 'etf' },
      { code: '000960', name: '招商医药健康产业股票', type: 'open' },
    ],
    baseRev: revA,
  });
  assert.equal(second.body.conflict, false);

  // 这台设备还拿着 revA 提交另一份自选 → 必须被拦下
  const conflict = await c.post('/api/portfolio', {
    funds: [{ code: '000001', name: '华夏成长混合', type: 'open' }],
    baseRev: revA,
  });
  assert.equal(conflict.body.conflict, true, '过期 baseRev 应返回冲突');
  assert.ok(Array.isArray(conflict.body.server.funds), '冲突时带上服务器快照供前端对齐');
  assert.equal(conflict.body.server.funds.length, 2, '服务器数据不能被过期提交覆盖');

  // 带着正确 rev 再提交就正常
  const fresh = await c.get('/api/portfolio');
  const ok = await c.post('/api/portfolio', {
    funds: [{ code: '000001', name: '华夏成长混合', type: 'open' }],
    baseRev: fresh.body.rev,
  });
  assert.equal(ok.body.conflict, false);
});

test('持仓：每次写入都留审计行与历史快照，可在后台恢复', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');

  await c.post('/api/portfolio', {
    funds: [],
    watchlist: [],
    holdings: { 510300: { shares: 1000, cost: 3.8 } },
  });
  const view = await c.get('/api/portfolio');
  const uid = view.body.user.id;
  await c.post('/api/portfolio', { holdings: { 510300: { shares: 1800, cost: 3.8 } } });

  const auditText = app.readData('portfolio-writes.jsonl');
  const rows = auditText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(rows.length >= 2, `审计行数应 >= 2，实际 ${rows.length}`);
  const last = rows[rows.length - 1];
  assert.equal(last.userId, uid);
  assert.ok(Array.isArray(last.changed) && last.changed.some((x) => x.code === '510300'), '审计里应有变更摘要');

  const historyDir = join(app.dataDir, 'portfolio-history', uid);
  const snaps = readdirSync(historyDir).filter((f) => f.endsWith('.json'));
  assert.ok(snaps.length >= 1, '至少有一份持仓快照');

  const list = await c.get(`/api/admin/portfolio/history?userId=${encodeURIComponent(uid)}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length >= 1);
  const target = list.body.items[list.body.items.length - 1]; // 最早那一版（1000 份）

  const restored = await c.post('/api/admin/portfolio/restore', { userId: uid, rev: target.rev });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.counts.holdings, 1);
  const after = await c.get('/api/portfolio');
  assert.equal(after.body.holdings['510300'].shares, 1000, '恢复后应回到快照里的份额');
  const snapBody = JSON.parse(readFileSync(join(historyDir, `${target.rev}.json`), 'utf8'));
  assert.equal(snapBody.user.id, uid);
});

test('持仓：SQLite 模式下同样按时间戳合并与留快照', async (t) => {
  const app = await startApp({ mode: 'sqlite' });
  t.after(() => app.stop());
  const c = await bootstrapAdmin(app, 'alice', 'alice12345');
  const now = Date.now();

  await c.post('/api/portfolio', {
    funds: [],
    watchlist: [],
    holdings: { 510300: { shares: 900, cost: 3.7, updatedAt: now } },
  });
  await c.post('/api/portfolio', {
    holdings: { 510300: { shares: 90, cost: 3.7, updatedAt: now - 600000 } },
  });
  const got = await c.get('/api/portfolio');
  assert.equal(got.body.holdings['510300'].shares, 900);
  const audit = readFileSync(join(app.dataDir, 'portfolio-writes.jsonl'), 'utf8');
  assert.ok(audit.includes('510300'));
});
