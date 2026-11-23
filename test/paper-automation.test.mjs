/**
 * 模拟盘自动化纯逻辑测试（v2.12.0）
 * ---------------------------------------------------------------
 * 覆盖：委托（部分成交/到期/撤单）、T+1 锁仓、涨跌停与停牌校验、
 * 条件单判定、网格档位、定投排期、分红除权入账、日终权益快照、
 * 周期收益与最大回撤、复盘指标、跟单取整。
 *
 * 全部不碰网络：行情用固定 quote 对象，日期用固定字符串。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../src/services/paper-automation.js');
const L = require('../src/services/paper-ledger.js');

const NOW_AM = Date.parse('2026-11-24T10:00:00+08:00'); // 周二上午（交易中）
const TODAY = '2026-11-24';

function quote(secid, price, extra = {}) {
  return { secid, code: secid.split('.')[1], name: '测试股', price, prevClose: price, priceMode: 'live', ...extra };
}

function emptyAcc(cash = 1000000) {
  return L.normalizeAccount({ initial: cash, cash }, { globalInitial: cash });
}

/* ---------------- 涨跌停 / 停牌 ---------------- */

test('校验：涨停不能买、跌停不能卖，涨停可以卖、跌停可以买', () => {
  const up = { price: 11, prevClose: 10, code: '600519', name: '贵州茅台', priceMode: 'live' };
  const down = { price: 9, prevClose: 10, code: '600519', name: '贵州茅台', priceMode: 'live' };
  const ctx = { limitCheck: true, limitRatio: 0.1, suspend: true };
  assert.equal(A.tradeGuard({ quote: up, side: 'buy', ctx }).code, 'limitUp');
  assert.equal(A.tradeGuard({ quote: up, side: 'sell', ctx }).blocked, false);
  assert.equal(A.tradeGuard({ quote: down, side: 'sell', ctx }).code, 'limitDown');
  assert.equal(A.tradeGuard({ quote: down, side: 'buy', ctx }).blocked, false);
  // 关掉校验就都放过
  assert.equal(A.tradeGuard({ quote: up, side: 'buy', ctx: { ...ctx, limitCheck: false } }).blocked, false);
});

test('校验：没有实时成交价（停牌 / 未开盘）不成交，关掉开关则放过', () => {
  const q = { price: 10, prevClose: 10, code: '600519', priceMode: 'prevClose' };
  assert.equal(A.tradeGuard({ quote: q, side: 'buy', ctx: { suspend: true } }).code, 'suspended');
  assert.equal(A.tradeGuard({ quote: q, side: 'buy', ctx: { suspend: false } }).blocked, false);
  assert.equal(A.tradeGuard({ quote: { price: 0 }, side: 'buy', ctx: {} }).code, 'noPrice');
});

test('校验：创业板 20% / ST 5% 的涨停价按昨收 + 比例算', () => {
  const q = { price: 12, prevClose: 10, code: '300750', name: '宁德时代', priceMode: 'live' };
  const r = A.tradeGuard({ quote: q, side: 'buy', ctx: { limitCheck: true, limitRatio: 0.2 } });
  assert.equal(r.limitUp, 12);
  assert.equal(r.code, 'limitUp');
  const st = { price: 10.5, prevClose: 10, code: '600001', name: '*ST测试', priceMode: 'live' };
  assert.equal(A.tradeGuard({ quote: st, side: 'buy', ctx: { limitCheck: true, limitRatio: 0.05 } }).code, 'limitUp');
});

/* ---------------- T+1 锁仓 ---------------- */

test('T+1：当日买入锁定，隔日解锁；t1 关闭时不校验', () => {
  let acc = emptyAcc();
  const b = L.applyBuy(acc, { quote: quote('0.000001', 10), shares: 100, today: TODAY });
  assert.ok(!b.error);
  assert.equal(b.account.positions['0.000001'].lockedShares, 100);
  assert.equal(b.account.positions['0.000001'].lockedDate, TODAY);
  assert.equal(L.availableShares(b.account, '0.000001', TODAY), 0);
  assert.equal(L.availableShares(b.account, '0.000001', '2026-11-25'), 100);
  const blocked = L.applySell(b.account, { quote: quote('0.000001', 11), shares: 100, t1: true, today: TODAY });
  assert.match(blocked.error.message, /T\+1/);
  const okNoT1 = L.applySell(b.account, { quote: quote('0.000001', 11), shares: 100, t1: false, today: TODAY });
  assert.ok(!okNoT1.error, '关掉 T+1 后当日可卖');
});

test('T+1：隔日再买会重置锁定日期，只锁当天新买的那部分', () => {
  let acc = emptyAcc();
  acc = L.applyBuy(acc, { quote: quote('0.000001', 10), shares: 100, today: '2026-11-24' }).account;
  acc = L.applyBuy(acc, { quote: quote('0.000001', 11), shares: 100, today: '2026-11-25' }).account;
  assert.equal(L.availableShares(acc, '0.000001', '2026-11-25'), 100);
  assert.equal(acc.positions['0.000001'].lockedShares, 100);
  assert.equal(acc.positions['0.000001'].lockedDate, '2026-11-25');
});

/* ---------------- 委托：撮合 / 部分成交 / 到期 / 撤单 ---------------- */

test('委托：限价没触及时保持挂单，触及后按现价成交', () => {
  const acc = emptyAcc(100000);
  const order = A.newOrder({ secid: '1.600519', side: 'buy', type: 'limit', limitPrice: 15, shares: 100, todayKey: TODAY, at: NOW_AM });
  let r = A.matchOrder({ account: acc, order, quote: quote('1.600519', 16), ctx: { now: NOW_AM, todayKey: TODAY, fees: {} } });
  assert.equal(r.blocked, 'priceNotTouched');
  assert.equal(r.order.status, 'pending');
  r = A.matchOrder({ account: acc, order, quote: quote('1.600519', 14.5), ctx: { now: NOW_AM, todayKey: TODAY, fees: {} } });
  assert.ok(r.trade, '到价应成交');
  assert.equal(r.order.status, 'filled');
  assert.equal(r.trade.price, 14.5, '按现价成交，不是按限价');
});

test('委托：资金不够时部分成交，剩余继续挂单，状态为 partial', () => {
  // 现价 100 元，每手 100 股 = 10000 元；只给 15000 元只能买 100 股
  const acc = emptyAcc(15000);
  const order = A.newOrder({ secid: '1.600519', side: 'buy', type: 'limit', limitPrice: 100, shares: 200, todayKey: TODAY, at: NOW_AM });
  const r = A.matchOrder({ account: acc, order, quote: quote('1.600519', 100), ctx: { now: NOW_AM, todayKey: TODAY, fees: {} } });
  assert.equal(r.trade.shares, 100);
  assert.equal(r.order.status, 'partial');
  assert.equal(r.order.filledShares, 100);
  const view = A.orderView(r.order, { todayKey: TODAY });
  assert.equal(view.remainingShares, 100);
  assert.equal(view.canCancel, true);
  // 又追加了资金（增量资金）→ 剩下的也能成交
  const topped = { ...r.account, cash: r.account.cash + 20000 };
  const r2 = A.matchOrder({ account: topped, order: r.order, quote: quote('1.600519', 100), ctx: { now: NOW_AM + 60000, todayKey: TODAY, fees: {} } });
  assert.equal(r2.order.status, 'filled');
  assert.equal(r2.order.filledShares, 200);
  // 成交均价 = 两笔都是 100 元
  assert.equal(r2.order.avgPrice, 100);
});

test('委托：到期自动失效；撤单只能撤未结委托', () => {
  const acc = emptyAcc();
  const order = A.newOrder({ secid: '1.600519', side: 'buy', type: 'limit', limitPrice: 1, shares: 100, todayKey: TODAY, at: NOW_AM, validDays: 1 });
  const expired = A.matchOrder({ account: acc, order, quote: quote('1.600519', 100), ctx: { now: order.expiresAt + 1000, todayKey: TODAY, fees: {} } });
  assert.equal(expired.order.status, 'expired');
  const c1 = A.cancelOrder([order], order.id, { at: NOW_AM });
  assert.equal(c1.order.status, 'cancelled');
  const c2 = A.cancelOrder([c1.order], order.id, { at: NOW_AM });
  assert.equal(c2.error.status, 400, '已结束的委托不能再撤');
  assert.equal(A.cancelOrder([order], 'nope').error.status, 404);
});

test('委托：收盘后下的单顺延到下一个交易日 15:00', () => {
  const at = Date.parse('2026-11-24T22:00:00+08:00'); // 周二晚上（收盘后）
  const order = A.newOrder({ secid: '1.600519', side: 'buy', type: 'limit', limitPrice: 10, shares: 100, todayKey: '2026-11-24', at, validDays: 1 });
  assert.equal(L.shanghaiDateKey(order.expiresAt), '2026-11-25');
});

test('委托：非法数据被丢弃，未结最多 30 笔、历史保留 60 条', () => {
  assert.equal(A.sanitizeOrder({ secid: 'bad', shares: 100 }), null);
  assert.equal(A.sanitizeOrder({ secid: '1.600519', shares: 0 }), null);
  const many = [];
  for (let i = 0; i < 40; i += 1) {
    many.push({ id: `o${i}`, secid: '1.600519', side: 'buy', type: 'limit', limitPrice: 10, shares: 100, status: 'pending', createdAt: i });
  }
  for (let i = 0; i < 80; i += 1) {
    many.push({ id: `f${i}`, secid: '1.600519', side: 'buy', type: 'market', shares: 100, status: 'filled', createdAt: i });
  }
  const list = A.sanitizeOrders(many);
  const activeList = list.filter((o) => o.status === 'pending');
  const doneList = list.filter((o) => o.status !== 'pending');
  assert.equal(activeList.length, 30);
  assert.equal(doneList.length, 60);
});

/* ---------------- 条件单 ---------------- */

test('条件单：止盈止损按持仓收益率判定，没持仓不触发', () => {
  const pos = { shares: 100, cost: 10 };
  assert.equal(A.evalCondition({ cond: { kind: 'takeProfit', value: 8, status: 'active' }, quote: { price: 11 }, pos }).hit, true);
  assert.equal(A.evalCondition({ cond: { kind: 'takeProfit', value: 8, status: 'active' }, quote: { price: 10.5 }, pos }).hit, false);
  assert.equal(A.evalCondition({ cond: { kind: 'stopLoss', value: 5, status: 'active' }, quote: { price: 9.4 }, pos }).hit, true);
  assert.equal(A.evalCondition({ cond: { kind: 'takeProfit', value: 8, status: 'active' }, quote: { price: 11 }, pos: null }).hit, false);
  assert.equal(A.evalCondition({ cond: { kind: 'priceAbove', value: 11, status: 'active' }, quote: { price: 12 }, pos: null }).hit, true);
  assert.equal(A.evalCondition({ cond: { kind: 'priceBelow', value: 9, status: 'active' }, quote: { price: 8.5 }, pos: null }).hit, true);
});

test('条件单：股数 0 表示可用全部；买入按可用资金', () => {
  const acc = emptyAcc(100000);
  acc.positions['1.600519'] = { shares: 500, cost: 10, code: '600519', name: 'x' };
  const cond = { secid: '1.600519', side: 'sell', shares: 0, kind: 'takeProfit', value: 5, status: 'active' };
  assert.equal(A.conditionShares({ cond, quote: quote('1.600519', 20), account: acc, todayKey: TODAY, fees: {}, t1: false }), 500);
  const buyCond = { secid: '1.600519', side: 'buy', shares: 0, kind: 'priceBelow', value: 9, status: 'active' };
  assert.ok(A.conditionShares({ cond: buyCond, quote: quote('1.600519', 10), account: acc, todayKey: TODAY, fees: {}, t1: true }) > 0);
});

/* ---------------- 网格 / 定投 ---------------- */

test('网格：价位等分、初始化只记位置、跌破买一格、涨过卖一格', () => {
  const plan = { secid: '1.600519', lower: 10, upper: 20, grids: 5, sharesPerGrid: 100, gridIndex: null };
  assert.deepEqual(A.gridLevels(plan), [10, 12, 14, 16, 18, 20]);
  assert.equal(A.gridIndexFor(plan, 14.5), 2);
  assert.equal(A.gridIndexFor(plan, 9), -1);
  assert.equal(A.gridIndexFor(plan, 25), 5);
  const init = A.gridAction({ plan, price: 15, cash: 100000, pos: null });
  assert.equal(init.action, 'init');
  const buy = A.gridAction({ plan: { ...plan, gridIndex: 3 }, price: 14, cash: 100000, pos: null, fees: {} });
  assert.equal(buy.action, 'buy');
  assert.equal(buy.newIndex, 2);
  const sell = A.gridAction({ plan: { ...plan, gridIndex: 2 }, price: 16.5, pos: { shares: 300, cost: 10 }, available: 300, fees: {} });
  assert.equal(sell.action, 'sell');
  assert.equal(sell.newIndex, 3);
  // T+1 锁住时卖不出：不动
  const locked = A.gridAction({ plan: { ...plan, gridIndex: 2 }, price: 16.5, pos: { shares: 300, cost: 10 }, available: 0, fees: {} });
  assert.equal(locked.action, 'hold');
  // 资金不足买不了：不动
  const noCash = A.gridAction({ plan: { ...plan, gridIndex: 3 }, price: 14, cash: 100, pos: null, fees: {} });
  assert.equal(noCash.action, 'hold');
});

test('定投：排期只走交易日，周末跳过；到期判断按日期字符串', () => {
  // 2026-11-27 是周五；从周四开始排「每周一」
  assert.equal(A.dcaNextDate({ freq: 'weekly', weekday: 1, fromKey: '2026-11-26' }), '2026-11-30');
  assert.equal(A.dcaNextDate({ freq: 'daily', fromKey: '2026-11-27' }), '2026-11-30', '周五之后是下周一');
  assert.equal(A.dcaNextDate({ freq: 'monthly', dayOfMonth: 12, fromKey: '2026-11-24' }), '2026-12-14', '12-12 是周六 → 顺延到周一');
  assert.equal(A.dcaDue({ plan: { kind: 'dca', status: 'active', nextDateKey: '2026-11-24' }, todayKey: '2026-11-24' }), true);
  assert.equal(A.dcaDue({ plan: { kind: 'dca', status: 'active', nextDateKey: '2026-11-21' }, todayKey: '2026-11-21' }), false, '周六不执行');
  assert.equal(A.dcaDue({ plan: { kind: 'dca', status: 'paused', nextDateKey: '2026-11-24' }, todayKey: '2026-11-24' }), false);
});

test('计划归一化：网格必须下界 < 上界、定投每期 ≥ 1000 元', () => {
  assert.equal(A.sanitizePlan({ kind: 'grid', secid: '1.600519', lower: 20, upper: 10, grids: 5, sharesPerGrid: 100 }), null);
  assert.equal(A.sanitizePlan({ kind: 'dca', secid: '1.600519', amount: 500, freq: 'weekly' }), null);
  const ok = A.sanitizePlan({ kind: 'dca', secid: '1.600519', amount: 5000, freq: 'weekly', weekday: 9 });
  assert.equal(ok.weekday, 5, '周几被夹到 1~5');
});

/* ---------------- 分红除权 ---------------- */

test('分红除权：现金分红进现金、成本摊薄、送转股增加股数、重复入账幂等', () => {
  const acc = emptyAcc(10000);
  acc.positions['1.600519'] = { shares: 100, cost: 20, code: '600519', name: '茅台', lockedShares: 100, lockedDate: TODAY };
  const events = [{ id: 'div-1', secid: '1.600519', exDate: '2026-11-20', cashPerShare: 2, shareRatio: 1 }];
  const r1 = A.applyCorporateActions({ account: acc, events, todayKey: TODAY, at: NOW_AM });
  assert.equal(r1.applied.length, 1);
  assert.equal(acc.cash, 10200, '100 股 × 2 元 = 200 元现金');
  assert.equal(acc.positions['1.600519'].shares, 110, '10 送 1');
  // 总成本 2000 - 现金 200 = 1800，除以 110 股 ≈ 16.3636
  assert.equal(acc.positions['1.600519'].cost, 16.3636);
  const r2 = A.applyCorporateActions({ account: acc, events, todayKey: TODAY, at: NOW_AM });
  assert.equal(r2.applied.length, 0, '同一天再跑不会重复入账');
  // 除权日还没到：不入账
  const acc2 = emptyAcc(10000);
  acc2.positions['1.600519'] = { shares: 100, cost: 20 };
  const r3 = A.applyCorporateActions({ account: acc2, events, todayKey: '2026-11-19', at: NOW_AM });
  assert.equal(r3.applied.length, 0);
  // 没持仓：不入账
  const acc3 = emptyAcc(10000);
  assert.equal(A.applyCorporateActions({ account: acc3, events, todayKey: TODAY }).applied.length, 0);
});

test('分红除权：逐日盈亏重建会在除权日补上现金分红', () => {
  const acc = {
    initial: 10000, cash: 2000, positions: { '1.600519': { shares: 100, cost: 20, code: '600519', name: '茅台' } },
    trades: [
      { id: 't1', ts: Date.parse('2026-11-19T10:00:00+08:00'), secid: '1.600519', code: '600519', name: '茅台', side: 'buy', price: 20, shares: 100, amount: 2000, fee: 5 },
    ],
    realized: {}, capital: { injected: 0, events: [] },
  };
  const bars = { '1.600519': [{ d: '2026-11-19', c: 20 }, { d: '2026-11-20', c: 18.2 }, { d: '2026-11-23', c: 18.5 }] };
  const noDiv = L.reconstructDailyPnl({ account: acc, barsBySecid: bars, today: '2026-11-23' });
  const withDiv = L.reconstructDailyPnl({
    account: acc, barsBySecid: bars, today: '2026-11-23',
    dividends: [{ secid: '1.600519', exDate: '2026-11-20', cashPerShare: 2, shareRatio: 0 }],
  });
  // 除权日：价格从 20 掉到 18.2（-180 元），但拿回 200 元现金分红 → 当日应为正
  const rowNo = noDiv.rows.find((r) => r.d === '2026-11-20');
  const rowDiv = withDiv.rows.find((r) => r.d === '2026-11-20');
  assert.ok(rowNo.pnl < -170, '不算分红时除权日是大额浮亏');
  assert.ok(rowDiv.pnl > 0, '算上分红后除权日不再是浮亏');
});

/* ---------------- 权益快照 / 周期收益 / 回撤 ---------------- */

test('周期收益：按日终快照算今日 / 本周 / 本月 / 今年，入金不算收益', () => {
  const acc = {
    initial: 100000, cash: 100000, positions: {}, trades: [], realized: {},
    capital: { injected: 0, events: [] },
    equity: {
      '2026-11-20': 100000, // 上周五
      '2026-11-23': 102000, // 本周一
      '2026-11-24': 103000,
    },
  };
  const s = A.periodStats({ account: acc, totalNow: 103000, todayKey: '2026-11-24' });
  // 今日：基准是昨天收盘 102000 → +0.98%
  assert.equal(s.todayPct, 0.98);
  // 本周：上周五收盘 100000 → +3%
  assert.equal(s.weekPct, 3);
  assert.equal(s.monthPct, 3);
  assert.equal(s.yearPct, 3);
  assert.equal(s.totalPct, 3);
  // 今天加 1000 元：收益率不该被抬高
  const withInjection = {
    ...acc,
    capital: { injected: 1000, events: [{ at: Date.parse('2026-11-24T09:00:00+08:00'), amount: 1000 }] },
  };
  const s2 = A.periodStats({ account: withInjection, totalNow: 104000, todayKey: '2026-11-24' });
  assert.equal(s2.todayPct, 0.98, '剔除入金后今日收益率不变');
  assert.equal(s2.totalPct, 2.97, '本金变成 101000，收益率 2.97%');
});

test('最大回撤：按剔除入金后的净值曲线算峰谷与日期', () => {
  const acc = {
    initial: 100000, cash: 100000, positions: {}, trades: [], realized: {},
    capital: { injected: 0, events: [] },
    equity: {
      '2026-11-02': 100000,
      '2026-11-03': 110000,
      '2026-11-04': 99000,
      '2026-11-05': 105000,
    },
  };
  const s = A.periodStats({ account: acc, totalNow: 105000, todayKey: '2026-11-05' });
  // 峰值 110000 → 谷底 99000，回撤 10%
  assert.equal(s.mdd, 10);
  assert.equal(s.mddFrom, '2026-11-03');
  assert.equal(s.mddTo, '2026-11-04');
  assert.equal(s.equityDays, 4);
});

test('最大回撤：谷底之后又创新高时，起点仍是产生回撤的那次峰顶（不能出现起点晚于终点）', () => {
  const acc = {
    initial: 100000, cash: 100000, positions: {}, trades: [], realized: {},
    capital: { injected: 0, events: [] },
    equity: {
      '2026-11-02': 100000,
      '2026-11-03': 110000,
      '2026-11-04': 99000,
      '2026-11-05': 120000,
      '2026-11-06': 118000,
    },
  };
  const s = A.periodStats({ account: acc, totalNow: 118000, todayKey: '2026-11-06' });
  assert.equal(s.mdd, 10);
  assert.equal(s.mddFrom, '2026-11-03', '起点必须是 11-03 的峰顶，而不是之后的 11-05 新高');
  assert.equal(s.mddTo, '2026-11-04');
  assert.ok(s.mddFrom < s.mddTo, '起点日期必须早于终点');
});

test('最大回撤：一路新高（无回撤）时不返回峰谷日期', () => {
  const acc = {
    initial: 100000, cash: 100000, positions: {}, trades: [], realized: {},
    capital: { injected: 0, events: [] },
    equity: { '2026-11-02': 100000, '2026-11-03': 102000, '2026-11-04': 105000 },
  };
  const s = A.periodStats({ account: acc, totalNow: 105000, todayKey: '2026-11-04' });
  assert.equal(s.mdd, 0);
  assert.equal(s.mddFrom, '');
  assert.equal(s.mddTo, '');
});

test('权益快照：同一天覆盖、最多保留 1500 天、非法值不入库', () => {
  let acc = emptyAcc();
  acc = A.recordEquity(acc, '2026-11-24', 100000);
  acc = A.recordEquity(acc, '2026-11-24', 101000);
  assert.equal(acc.equity['2026-11-24'], 101000);
  assert.equal(A.recordEquity(acc, '2026-11-24', 0).equity['2026-11-24'], 101000, '0 不入库');
  const many = {};
  for (let i = 0; i < 1600; i += 1) {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    many[d] = 100000;
  }
  const trimmed = A.sanitizeEquity(many);
  assert.equal(Object.keys(trimmed).length, 1500);
});

/* ---------------- 复盘指标 ---------------- */

test('复盘：胜率 / 盈亏比 / 利润因子 / 集中度 / 平均持有天数', () => {
  const day = 86400000;
  const trades = [
    { ts: NOW_AM - 10 * day, secid: '1.600519', side: 'buy', shares: 100, price: 10, realized: null },
    { ts: NOW_AM - 8 * day, secid: '1.600519', side: 'sell', shares: 100, price: 12, realized: 195 },
    { ts: NOW_AM - 6 * day, secid: '0.000001', side: 'buy', shares: 100, price: 10, realized: null },
    { ts: NOW_AM - 3 * day, secid: '0.000001', side: 'sell', shares: 100, price: 9, realized: -105 },
  ];
  const acc = {
    initial: 100000, cash: 50000, positions: {}, trades, realized: {}, capital: { injected: 0, events: [] },
    equity: { '2026-11-23': 100000, '2026-11-24': 100500 },
  };
  const r = A.reviewMetrics({
    account: acc, totalNow: 100500, todayKey: TODAY,
    positions: [{ name: '茅台', marketValue: 40000 }, { name: '平安', marketValue: 10500 }],
  });
  assert.equal(r.sells, 2);
  assert.equal(r.winCount, 1);
  assert.equal(r.winRate, 50);
  assert.equal(r.avgWin, 195);
  assert.equal(r.avgLoss, -105);
  assert.equal(r.payoffRatio, 1.86);
  assert.equal(r.profitFactor, 1.86);
  assert.equal(r.realizedTotal, 90);
  // 最大持仓 40000 / 100500 = 39.8%
  assert.equal(r.topWeight, 39.8);
  // 两个卖出的持有天数分别 2 天、3 天 → 平均 2.5
  assert.equal(r.avgHoldDays, 2.5);
});

test('复盘：没有卖出时胜率为空，不编造 0%', () => {
  const acc = { initial: 100000, cash: 100000, positions: {}, trades: [], realized: {}, capital: { injected: 0, events: [] } };
  const r = A.reviewMetrics({ account: acc, totalNow: 100000, todayKey: TODAY, positions: [] });
  assert.equal(r.winRate, null);
  assert.equal(r.realizedTotal, 0);
  assert.equal(r.mdd, null);
});

/* ---------------- 跟单 ---------------- */

test('跟单：按比例取整手，资金 / 持仓 / 上限都会夹住', () => {
  const trade = { side: 'buy', shares: 1000 };
  assert.equal(A.followShares({ trade, ratio: 0.5, lot: 100, cash: 1e9, price: 10, fees: {} }), 500);
  assert.equal(A.followShares({ trade, ratio: 0.25, lot: 100, cash: 1e9, price: 10, fees: {} }), 200, '250 股向下取整到 200');
  assert.equal(A.followShares({ trade, ratio: 1, lot: 100, cash: 1e9, price: 10, fees: {}, maxShares: 300 }), 300);
  const sellTrade = { side: 'sell', shares: 1000 };
  assert.equal(A.followShares({ trade: sellTrade, ratio: 1, lot: 100, held: 400 }), 400, '卖出不能超过持仓');
  // 资金不够一手
  assert.equal(A.followShares({ trade, ratio: 1, lot: 100, cash: 500, price: 10, fees: {} }), 0);
});

test('跟单：订阅归一化去重、最多 5 个', () => {
  const list = A.sanitizeFollows([
    { target: 'A', ratio: 0.5 }, { target: 'a', ratio: 0.5 }, { target: 'B', ratio: 2 },
    { target: '', ratio: 1 }, { target: 'C' }, { target: 'D' }, { target: 'E' }, { target: 'F' },
  ]);
  assert.equal(list.length, 5);
  assert.equal(list[0].ratio, 0.5);
  assert.equal(list.find((x) => x.target === 'B').ratio, 0.5, '比例超范围回退到 0.5');
});

/* ---------------- 日期工具 ---------------- */

test('日期工具：加减日 / 工作日 / 到期时间', () => {
  assert.equal(A.dateAddDays('2026-11-30', 1), '2026-12-01');
  assert.equal(A.weekdayOf('2026-11-24'), 2, '周二');
  assert.equal(A.isWorkday('2026-11-28'), false, '周六');
  assert.equal(A.nextWorkday('2026-11-28'), '2026-11-30');
  assert.equal(L.shanghaiDateKey(Date.parse('2026-11-24T15:00:00+08:00')), '2026-11-24');
});
