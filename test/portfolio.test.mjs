import test from 'node:test';
import assert from 'node:assert/strict';
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
