/* 基金分析服务纯函数回归（v2.10.0）
   覆盖：涨跌分布分档、主题连涨天数、主题等权指数、场外基金榜排序 / 份额去重 / 热度分。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  fundPctBucketIndex,
  bucketFundPct,
  themeStreakFromSeries,
  themeStreakSigned,
  buildThemeIndex,
  dailyPctFromIndex,
  compoundLastN,
  dedupeFundShares,
  hotFundScore,
  sortBoardItems,
  createFundAnalytics,
} = require(join(ROOT, 'src', 'services', 'fund-analytics.js'));

/* ---------------- 涨跌分档 ---------------- */

test('分档：边界值落在约定档位', () => {
  assert.equal(fundPctBucketIndex(-5), 1, '-5 归「-5~-3%」');
  assert.equal(fundPctBucketIndex(-5.01), 0);
  assert.equal(fundPctBucketIndex(-3), 2);
  assert.equal(fundPctBucketIndex(-1), 4, '-1 归「-1~0%」');
  assert.equal(fundPctBucketIndex(-1.01), 3);
  assert.equal(fundPctBucketIndex(-0.01), 4);
  assert.equal(fundPctBucketIndex(0), 5);
  assert.equal(fundPctBucketIndex(0.01), 6);
  assert.equal(fundPctBucketIndex(1), 6);
  assert.equal(fundPctBucketIndex(1.01), 7);
  assert.equal(fundPctBucketIndex(3), 8, '3 归「2~3%」');
  assert.equal(fundPctBucketIndex(3.01), 9);
  assert.equal(fundPctBucketIndex(5), 9, '5 归「3~5%」');
  assert.equal(fundPctBucketIndex(5.01), 10);
  assert.equal(fundPctBucketIndex(Number.NaN), -1);
  assert.equal(fundPctBucketIndex(null), -1);
});

test('分档：上涨 / 下跌 / 平盘家数与占比', () => {
  const dist = bucketFundPct([-6, -4, -1, 0, 0, 1, 4, 6, null, 'x']);
  assert.equal(dist.total, 8);
  assert.equal(dist.up, 3);
  assert.equal(dist.down, 3);
  assert.equal(dist.flat, 2);
  assert.equal(dist.upRatio, 37.5);
  assert.equal(dist.buckets[0].count, 1);
  assert.equal(dist.buckets[5].count, 2);
  assert.equal(dist.buckets[10].count, 1);
  const sum = dist.buckets.reduce((s, b) => s + b.count, 0);
  assert.equal(sum, dist.total, '各档合计必须等于样本数');
});

test('分档：空样本不抛错，占比为 null', () => {
  const dist = bucketFundPct([]);
  assert.equal(dist.total, 0);
  assert.equal(dist.upRatio, null);
  assert.equal(dist.buckets.length, 11);
});

/* ---------------- 连涨天数 ---------------- */

test('连涨：从最新交易日往前数连续为正的天数', () => {
  const map = new Map([
    ['2026-11-17', 1.2],
    ['2026-11-18', 0.4],
    ['2026-11-19', 2.1],
    ['2026-11-20', 0.8],
  ]);
  assert.equal(themeStreakFromSeries(map), 4);
  map.set('2026-11-17', -0.2);
  assert.equal(themeStreakFromSeries(map), 3, '中间出现下跌即中断');
});

test('连涨：最新一天为平盘 / 下跌 / 无数据', () => {
  assert.equal(themeStreakFromSeries(new Map([['2026-11-19', 1], ['2026-11-20', 0]])), 0);
  assert.equal(themeStreakFromSeries(new Map([['2026-11-19', 1], ['2026-11-20', -0.3]])), 0);
  assert.equal(themeStreakFromSeries(new Map()), null, '没有数据返回 null 而不是 0');
});

/* ---------------- 连涨 / 连跌（带符号，v2.10.4） ---------------- */

test('带符号连涨连跌：上涨为正、下跌为负、平盘 0、没数据 null', () => {
  const up = new Map([
    ['2026-11-17', 1.2],
    ['2026-11-18', 0.4],
    ['2026-11-19', 2.1],
    ['2026-11-20', 0.8],
  ]);
  assert.equal(themeStreakSigned(up), 4, '连涨 4 天显示 +4');
  const down = new Map([
    ['2026-11-17', 1.2],
    ['2026-11-18', -0.4],
    ['2026-11-19', -2.1],
    ['2026-11-20', -0.8],
  ]);
  assert.equal(themeStreakSigned(down), -3, '最近三天连跌显示 -3');
  down.set('2026-11-17', -0.2);
  assert.equal(themeStreakSigned(down), -4, '四天连跌显示 -4');
  assert.equal(themeStreakSigned(new Map([['2026-11-19', 1], ['2026-11-20', 0]])), 0, '平盘 0');
  assert.equal(themeStreakSigned(new Map()), null, '没数据 null');
  assert.equal(themeStreakFromSeries(down), 0, '旧的连涨函数语义不变（仍返回 0）');
});

/* ---------------- 主题等权指数 ---------------- */

test('等权指数：两点起算、按日复合，起点接近 100', () => {
  const idx = buildThemeIndex([
    { code: 'A', candles: [{ d: '2026-11-17', c: 100 }, { d: '2026-11-18', c: 110 }, { d: '2026-11-19', c: 99 }] },
    { code: 'B', candles: [{ d: '2026-11-17', c: 200 }, { d: '2026-11-18', c: 200 }, { d: '2026-11-19', c: 202 }] },
  ]);
  assert.equal(idx.length, 3);
  assert.equal(idx[0].v, 100, '第一个交易日为起点 100（当天没有涨跌）');
  // 11-18：A +10%、B 0% → 等权 +5%
  assert.equal(idx[1].v, 105);
  // 11-19：A -10%、B +1% → 等权 -4.5% → 105*0.955 = 100.275 → 100.28
  assert.equal(idx[2].v, 100.28);
});

test('等权指数：某只标的后上市不影响早期曲线', () => {
  const idx = buildThemeIndex([
    { code: 'A', candles: [{ d: '2026-11-17', c: 10 }, { d: '2026-11-18', c: 11 }, { d: '2026-11-19', c: 12 }] },
    { code: 'C', candles: [{ d: '2026-11-19', c: 50 }, { d: '2026-11-20', c: 55 }] },
  ]);
  assert.equal(idx[0].v, 100);
  assert.equal(idx[1].v, 110, '只有 A 有数据时按 A 自己算');
  assert.equal(idx[2].v, 120, '11-19 A +9.09%（C 首日无涨跌）');
  assert.equal(idx[3].v, 132, '11-20 只有 C：+10% → 132');
});

test('连涨 + 区间：由指数序列还原日涨跌并算近 5 日', () => {
  const daily = dailyPctFromIndex([
    { d: '2026-11-14', v: 100 },
    { d: '2026-11-17', v: 101 },
    { d: '2026-11-18', v: 102 },
  ]);
  assert.equal(daily.get('2026-11-17'), 1);
  assert.equal(compoundLastN(daily, 5), 2);
});

/* ---------------- 场外基金榜 ---------------- */

test('热门榜：份额去重只留动量最高的一只', () => {
  const items = [
    { code: 'A1', name: '华夏成长混合A', week: 1.2 },
    { code: 'A2', name: '华夏成长混合C', week: 3.4 },
    { code: 'B1', name: '易方达蓝筹', week: 2.2 },
  ];
  const out = dedupeFundShares(items, 'week', (x) => String(x.name || '').replace(/[A-Z]$/, ''));
  assert.equal(out.length, 2);
  assert.ok(out.some((x) => x.code === 'A2'), 'A 类份额应被 C 类里动量更高的替换');
  assert.ok(out.some((x) => x.code === 'B1'));
});

test('热度分：周权重最高、空值按 0 处理', () => {
  assert.ok(hotFundScore({ week: 1 }) > hotFundScore({ month: 1 }), '周权重 > 月权重');
  assert.ok(hotFundScore({ month: 1 }) > hotFundScore({ day: 1 }), '月权重 > 日权重');
  assert.equal(hotFundScore({}), 0);
});

test('榜单排序：涨幅降序 / 跌幅升序 / ETF 降序，空值排最后', () => {
  const rows = [
    { code: 'a', day: 1.2 },
    { code: 'b', day: null },
    { code: 'c', day: -2.5 },
    { code: 'd', day: 3 },
  ];
  assert.deepEqual(sortBoardItems(rows, 'gain').map((x) => x.code), ['d', 'a', 'c', 'b']);
  assert.deepEqual(sortBoardItems(rows, 'loss').map((x) => x.code), ['c', 'a', 'd', 'b']);
  assert.deepEqual(sortBoardItems(rows, 'etf').map((x) => x.code), ['d', 'a', 'c', 'b']);
  assert.deepEqual(sortBoardItems([], 'gain'), []);
});

/* ---------------- 工厂：注入假数据也能跑通 ---------------- */

function fakeAnalytics(overrides = {}) {
  return createFundAnalytics({
    cached: (key, ttl, fn) => fn(),
    mapLimit: async (items, limit, fn) => Promise.all(items.map((x, i) => fn(x, i))),
    round: (v, d = 2) => Math.round(Number(v) * 10 ** d) / 10 ** d,
    num: (v) => (Number.isFinite(Number(v)) ? Number(v) : null),
    today: () => '2026-11-21',
    fundBaseName: (n) => String(n || '').replace(/[A-Z]$/, ''),
    getKline: async () => ({
      candles: [
        { d: '2026-11-17', c: 10 }, { d: '2026-11-18', c: 10.2 },
        { d: '2026-11-19', c: 10.4 }, { d: '2026-11-20', c: 10.5 },
      ],
    }),
    fetchEastmoneyTrends: async (secid) => ({
      name: secid,
      preClose: 100,
      points: [{ t: '09:30', p: 100 }, { t: '10:00', p: 101 }, { t: '10:30', p: 102 }],
    }),
    getIntraday: async () => null,
    getEtfUniverse: async () => ([
      { code: '510300', name: '沪深300ETF', pct: 1.1, amount: 1e9, amountYi: 10, category: 'equity', price: 4 },
      { code: '512690', name: '酒ETF', pct: -0.8, amount: 5e8, amountYi: 5, category: 'equity', price: 1 },
      { code: '511990', name: '货币ETF', pct: 0.01, amount: 2e8, amountYi: 2, category: 'money', price: 100 },
    ]),
    getEtfFlow: async () => ({ items: [{ code: '510300', mainYi: 2.5 }] }),
    getAllEquityFunds: async () => ({
      items: [
        { code: '000001', name: '华夏成长混合A', nav: 1.2, date: '2026-11-20', day: 1.5, week: 2, month: 3, year: 10, typeKey: 'hh', sector: '混合均衡' },
        { code: '000002', name: '华夏成长混合C', nav: 1.1, date: '2026-11-20', day: -0.5, week: 1, month: 2, year: 9, typeKey: 'hh', sector: '混合均衡' },
        { code: '001595', name: '天弘银行ETF联接C', nav: 1.9, date: '2026-11-19', day: 1.2, week: 3, month: 6.5, year: 8, typeKey: 'zs', sector: '金融' },
      ],
    }),
    fetchFundHoldingsProfile: async () => { throw new Error('no network'); },
    fetchFundStockRatio: async () => null,
    estimateFromProfile: () => ({ pct: 1.23, kind: 'holdings', covered: 5, weight: 30 }),
    fundSecid: (code) => (/^5/.test(code) ? `1.${code}` : `0.${code}`),
    classifyFundSector: (name) => (/银行/.test(name) ? '金融' : (/酒/.test(name) ? '大消费' : '混合均衡')),
    isEtfLike: (code) => /^5/.test(code),
    fundEstimateRoute: () => 'none',
    STOCK_FUND_TYPES: { gp: '股票型', zs: '指数型', hh: '混合型' },
    ...overrides,
  });
}

test('分布接口：返回分档、家数与净值日，ETF 剔除货币', async () => {
  const svc = fakeAnalytics();
  const eq = await svc.getFundDistribution('equity');
  assert.equal(eq.scope, 'equity');
  assert.equal(eq.total, 3);
  assert.equal(eq.up, 2);
  assert.equal(eq.down, 1);
  assert.equal(eq.date, '2026-11-20', '净值日取出现次数最多的那天');
  const etf = await svc.getFundDistribution('etf');
  assert.equal(etf.total, 2, '货币 ETF 不计入');
});

test('主题总览：按主题聚合，连涨天数来自代表 ETF 日线', async () => {
  const svc = fakeAnalytics();
  const data = await svc.getFundThemeOverview();
  assert.ok(data.themes.length >= 2);
  const mixed = data.themes.find((t) => t.sector === '混合均衡');
  assert.ok(mixed, '缺少混合均衡主题');
  assert.equal(mixed.streak, 3, '代表 ETF 最近三天连涨（10→10.2→10.4→10.5）');
  assert.equal(mixed.etfCount, 1);
  assert.ok(data.date);
});

test('主题总览：代表 ETF 连跌时 streak 为负数（连跌天数）', async () => {
  const svc = fakeAnalytics({
    getKline: async () => ({
      candles: [
        { d: '2026-11-17', c: 10 }, { d: '2026-11-18', c: 9.8 },
        { d: '2026-11-19', c: 9.6 }, { d: '2026-11-20', c: 9.5 },
      ],
    }),
  });
  const data = await svc.getFundThemeOverview();
  const mixed = data.themes.find((t) => t.sector === '混合均衡');
  assert.ok(mixed, '缺少混合均衡主题');
  assert.equal(mixed.streak, -3, '10→9.8→9.6→9.5 连续三天下跌，应返回 -3');
});

test('主题详情：缺板块名报 400；不存在的主题报 404', async () => {
  const svc = fakeAnalytics();
  await assert.rejects(() => svc.getFundThemeDetail({ sector: '' }), (err) => err.status === 400);
  await assert.rejects(() => svc.getFundThemeDetail({ sector: '不存在的主题' }), (err) => err.status === 404);
});

test('场外基金榜：热门榜去重份额且同主题最多两只', async () => {
  const svc = fakeAnalytics();
  const hot = await svc.getFundBoard({ tab: 'hot', type: 'all', limit: 10 });
  const codes = hot.items.map((x) => x.code);
  assert.ok(!(codes.includes('000001') && codes.includes('000002')), '同一基金不同份额只留一只');
  const etf = await svc.getFundBoard({ tab: 'etf', type: 'all', limit: 10 });
  assert.equal(etf.items[0].code, '510300');
  assert.equal(etf.items[0].mainYi, 2.5, 'ETF 榜要带主力净流入');
});

test('当日序列：ETF 走自身分时，无法穿透的基金给 null 并标覆盖率', async () => {
  const svc = fakeAnalytics();
  const data = await svc.getFundIntradaySeries({ codes: ['510300', '000001'], indexSecid: '1.000001' });
  assert.ok(data.index, '应返回上证指数分时');
  assert.equal(data.funds.length, 2);
  const etf = data.funds.find((x) => x.code === '510300');
  assert.equal(etf.coverage, 100);
  assert.ok(Array.isArray(etf.points) && etf.points.length >= 2);
  const open = data.funds.find((x) => x.code === '000001');
  assert.equal(open.points, null);
  assert.equal(open.coverage, 0);
});
