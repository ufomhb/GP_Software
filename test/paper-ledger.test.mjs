/**
 * 模拟交易账本（v2.11.0）纯函数测试
 *
 * 不依赖行情/网络/HTTP：直接测 src/services/paper-ledger.js 的费用、整手、
 * 最大可买、买卖记账、已实现累计、增量资金与逐日盈亏重建。
 * 前端 paperMaxBuyShares 的同口径断言在 test/dom-smoke.test.mjs。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../src/services/paper-ledger.js');

const QUOTE = (secid, price, code, name) => ({
  secid, code: code || secid.split('.')[1], name: name || '测试标的', price,
});
const TS = (s) => Date.parse(`${s}T10:00:00+08:00`);
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `${a} ≉ ${b}`);

function acc(over = {}) {
  return L.normalizeAccount({ initial: 10000, cash: 10000, ...over }, { globalInitial: 10000 });
}

/* ---------------- 费用 / 整手 / 最大可买 ---------------- */

test('最大可买：按整手向下取整、预留佣金、最低 5 元边界', () => {
  assert.deepEqual(L.maxBuyShares({ price: 10, cash: 100000, lot: 100 }), {
    shares: 9900, amount: 99000, fee: 24.75, cost: 99024.75,
  });
  // 10 万元 ÷ 10.0025 ≈ 9997.5 股 → 整手 9900；再算 1005 元只够 100 股
  assert.equal(L.maxBuyShares({ price: 10, cash: 1005, lot: 100 }).shares, 100);
  assert.equal(L.maxBuyShares({ price: 10, cash: 1004.9, lot: 100 }).shares, 0);
  // lot=1 时最低佣金 5 元会挤掉最后几股
  assert.equal(L.maxBuyShares({ price: 3, cash: 100, lot: 1 }).shares, 31);
  assert.equal(L.maxBuyShares({ price: 0, cash: 10000, lot: 100 }).shares, 0);
  assert.equal(L.maxBuyShares({ price: 10, cash: 0, lot: 100 }).shares, 0);
  // A 股 / 场内 ETF 判定
  assert.equal(L.lotOf('1.600519'), 100);
  assert.equal(L.lotOf('0.159915'), 100);
  assert.equal(L.lotOf('105.AAPL'), 1);
});

/* ---------------- 买入 ---------------- */

test('买入：佣金摊进成本，现金扣减，资金不足返回错误且账户不变', () => {
  const a = acc();
  const ok = L.applyBuy(a, { quote: QUOTE('1.600519', 10, '600519', '贵州茅台'), shares: 100 });
  assert.equal(ok.error, undefined);
  assert.equal(ok.account.cash, 8995);
  near(ok.account.positions['1.600519'].cost, 10.05, 0.0001);
  assert.equal(ok.trade.amount, 1000);
  assert.equal(ok.trade.fee, 5);
  assert.equal(ok.trade.commission, 5);
  assert.equal(ok.trade.tax, 0);
  assert.equal(ok.trade.side, 'buy');

  const before = { cash: a.cash, positions: { ...a.positions }, trades: a.trades.length };
  const bad = L.applyBuy(a, { quote: QUOTE('1.600519', 100), shares: 100 });
  assert.ok(bad.error, '资金不足必须拒绝');
  assert.match(bad.error.message, /可用资金不足/);
  assert.equal(a.cash, before.cash, '拒绝时不能修改账户');
  assert.equal(Object.keys(a.positions).length, 0);
  assert.equal(a.trades.length, before.trades);
});

test('买入：整手校验与加仓后的移动加权成本', () => {
  const a = acc();
  const lotErr = L.applyBuy(a, { quote: QUOTE('1.600519', 10), shares: 150 });
  assert.match(lotErr.error.message, /100 股整数倍/);

  let r = L.applyBuy(a, { quote: QUOTE('1.600519', 10), shares: 100 });
  r = L.applyBuy(r.account, { quote: QUOTE('1.600519', 20), shares: 100 });
  assert.equal(r.account.positions['1.600519'].shares, 200);
  // (100×10 + 5 + 100×20 + 5) / 200 = 15.05
  near(r.account.positions['1.600519'].cost, 15.05, 0.0001);
});

/* ---------------- 卖出 / 已实现累计 ---------------- */

test('卖出：单笔已实现与收益率（含佣金与印花税）', () => {
  const a = acc();
  const bought = L.applyBuy(a, { quote: QUOTE('1.600519', 10), shares: 100 });
  const sold = L.applySell(bought.account, { quote: QUOTE('1.600519', 12), shares: 100 });
  assert.equal(sold.error, undefined);
  assert.equal(sold.account.positions['1.600519'], undefined, '清仓后删除持仓');
  near(sold.account.cash, 10189.4, 0.01);
  assert.equal(sold.trade.realized, 189.4);
  assert.equal(sold.trade.realizedPct, 18.85);
  assert.equal(sold.trade.costBasis, 1005);
  const ledger = sold.account.realized['1.600519'];
  assert.equal(ledger.sellShares, 100);
  assert.equal(ledger.costBasis, 1005);
  assert.equal(ledger.realized, 189.4);
  assert.equal(sold.trade.fee, 5.6, '卖出费用 = 佣金 5 + 印花税 0.6');
  assert.equal(sold.trade.tax, 0.6);
});

test('卖出：部分卖出保留成本，清仓后账本保留，重买继续累计', () => {
  const a = acc();
  const r1 = L.applyBuy(a, { quote: QUOTE('0.000001', 10), shares: 200 });
  const r2 = L.applySell(r1.account, { quote: QUOTE('0.000001', 10.5), shares: 100 });
  assert.equal(r2.account.positions['0.000001'].shares, 100);
  near(r2.account.positions['0.000001'].cost, 10.025, 0.0001);
  near(r2.trade.realized, 41.98, 0.02);
  const r3 = L.applySell(r2.account, { quote: QUOTE('0.000001', 9), shares: 100 });
  // 累计：41.98 + (894.55 - 1002.5) = -66
  near(r3.account.realized['0.000001'].realized, -66, 0.05);
  assert.equal(r3.account.realized['0.000001'].sellShares, 200);
  near(r3.account.realized['0.000001'].costBasis, 2005, 0.02);
  assert.equal(r3.account.positions['0.000001'], undefined);

  // 清仓后重买：账本保留、轮次 +1，卖出后继续在旧累计上叠加
  const r4 = L.applyBuy(r3.account, { quote: QUOTE('0.000001', 8), shares: 100 });
  assert.equal(r4.account.realized['0.000001'].rounds, 2);
  assert.equal(r4.account.realized['0.000001'].realized, r3.account.realized['0.000001'].realized);
  const r5 = L.applySell(r4.account, { quote: QUOTE('0.000001', 9), shares: 100 });
  near(r5.account.realized['0.000001'].realized, -66 + 89.55, 0.06);
  assert.equal(r5.account.realized['0.000001'].sellShares, 300);
});

test('卖出：超过持仓被拒，账户不变', () => {
  const a = acc();
  const r = L.applyBuy(a, { quote: QUOTE('1.600519', 10), shares: 100 });
  const before = r.account.cash;
  const bad = L.applySell(r.account, { quote: QUOTE('1.600519', 12), shares: 200 });
  assert.match(bad.error.message, /持仓不足/);
  assert.equal(r.account.cash, before);
});

/* ---------------- 老账户归一 / 已实现回填 ---------------- */

test('归一：老账户按成交流水回填已实现；历史被截断的标的标 incomplete', () => {
  const raw = {
    initial: 10000,
    cash: 9000,
    positions: {},
    trades: [
      { ts: TS('2026-11-19'), secid: '1.600519', code: '600519', side: 'buy', price: 10, shares: 100, amount: 1000, fee: 5 },
      { ts: TS('2026-11-20'), secid: '1.600519', code: '600519', side: 'sell', price: 12, shares: 100, amount: 1200, fee: 5.6 },
    ],
  };
  const a = L.normalizeAccount(raw, { globalInitial: 10000 });
  assert.equal(a.realized['1.600519'].realized, 189.4);
  assert.equal(a.realized['1.600519'].costBasis, 1005);
  assert.equal(a.realizedIncomplete.length, 0);

  // 只有卖出、没有对应买入（老版本只保留最近 200 笔时会被截断）
  const broken = L.normalizeAccount({
    initial: 10000, cash: 10000, positions: {}, trades: [
      { ts: TS('2026-11-20'), secid: '0.300750', side: 'sell', price: 200, shares: 100, amount: 20000, fee: 5.6 },
    ],
  }, { globalInitial: 10000 });
  assert.equal(broken.realized['0.300750'], undefined, '不能给假数字');
  assert.deepEqual(broken.realizedIncomplete, ['0.300750']);
});

test('归一：已有 realized 字段（含 0 卖出的新仓位）不覆盖、不丢轮次', () => {
  const raw = {
    initial: 10000, cash: 5000, positions: {},
    realized: { '1.600519': { code: '600519', name: '茅台', sellShares: 100, sellAmount: 1200, costBasis: 1005, realized: 189.4, rounds: 3, lastAt: 1 } },
    trades: [{ ts: 1, secid: '1.600519', side: 'buy', price: 10, shares: 100, amount: 1000, fee: 5 }],
  };
  const a = L.normalizeAccount(raw, { globalInitial: 10000 });
  assert.equal(a.realized['1.600519'].realized, 189.4);
  assert.equal(a.realized['1.600519'].rounds, 3);
});

test('归一：空账户用全局初始资金，现金缺省等于 initial', () => {
  const a = L.normalizeAccount(null, { globalInitial: 500000 });
  assert.equal(a.initial, 500000);
  assert.equal(a.cash, 500000);
  assert.deepEqual(a.positions, {});
  assert.deepEqual(a.capital, { injected: 0, events: [] });
});

/* ---------------- 增量资金 / 本金口径 ---------------- */

test('增量资金：现金与本金同步增加，加钱当天不产生盈亏', () => {
  const a = acc();
  const r = L.applyCapitalInjection(a, { amount: 5000, at: TS('2026-11-23'), note: '加仓', by: 'admin' });
  assert.equal(r.account.cash, 15000);
  assert.equal(r.account.capital.injected, 5000);
  assert.equal(r.account.capital.events.length, 1);
  assert.equal(r.account.capital.events[0].amount, 5000);

  const t0 = L.accountTotals(r.account, new Map());
  assert.equal(t0.principal, 15000);
  assert.equal(t0.total, 15000);
  assert.equal(t0.profit, 0, '加钱不算收益');
  assert.equal(t0.profitPct, 0);

  const bought = L.applyBuy(r.account, { quote: QUOTE('1.600519', 10), shares: 100 });
  const qmap = new Map([['1.600519', { secid: '1.600519', price: 11 }]]);
  const t1 = L.accountTotals(bought.account, qmap);
  assert.equal(t1.total, 15095); // 13995 现金 + 1100 市值
  assert.equal(t1.profit, 95);
  near(t1.profitPct, 0.63, 0.01);
});

test('个股累计收益行：清仓后保留、仍持仓时含浮盈', () => {
  const a = acc();
  const r1 = L.applyBuy(a, { quote: QUOTE('1.600519', 10), shares: 200 });
  const r2 = L.applySell(r1.account, { quote: QUOTE('1.600519', 12), shares: 100 });
  const qmap = new Map([['1.600519', { secid: '1.600519', price: 13 }]]);
  const rows = L.realizedRows(r2.account, qmap);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].holding, true);
  assert.equal(rows[0].sellShares, 100);
  assert.equal(rows[0].realized, 191.9);
  assert.equal(rows[0].realizedPct, 19.14);
  assert.equal(rows[0].unrealized, 297.5); // (13 - 10.025) × 100
  assert.equal(rows[0].totalProfit, Math.round((191.9 + 297.5) * 100) / 100);
  // 全部卖出后 holding=false，unrealized=null
  const r3 = L.applySell(r2.account, { quote: QUOTE('1.600519', 12), shares: 100 });
  const rows2 = L.realizedRows(r3.account, qmap);
  assert.equal(rows2[0].holding, false);
  assert.equal(rows2[0].unrealized, null);
  assert.equal(rows2[0].sellShares, 200);
});

/* ---------------- 逐日盈亏 ---------------- */

test('逐日盈亏：首日佣金、卖出日盈亏、入金不计收益', () => {
  const a = L.normalizeAccount({
    initial: 10000,
    cash: 10539.725,
    positions: { '1.600519': { code: '600519', name: '茅台', shares: 50, cost: 10.05 } },
    trades: [
      { ts: TS('2026-11-19'), secid: '1.600519', side: 'buy', price: 10, shares: 100, amount: 1000, fee: 5 },
      { ts: TS('2026-11-20'), secid: '1.600519', side: 'sell', price: 11, shares: 50, amount: 550, fee: 5, tax: 0.275 },
    ],
    capital: { injected: 1000, events: [{ at: TS('2026-11-20'), amount: 1000 }] },
  }, { globalInitial: 10000 });
  const bars = { '1.600519': [{ d: '2026-11-19', c: 10 }, { d: '2026-11-20', c: 11 }, { d: '2026-11-23', c: 12 }] };
  const out = L.reconstructDailyPnl({ account: a, barsBySecid: bars, today: '2026-11-23' });
  assert.equal(out.rows.length, 3);
  assert.deepEqual(out.rows.map((r) => r.d), ['2026-11-19', '2026-11-20', '2026-11-23']);
  assert.equal(out.rows[0].pnl, -5, '买入佣金计入当日盈亏');
  equalNear(out.rows[1].pnl, 94.73, 0.02, '卖出日盈亏（入金 1000 被剔除）');
  assert.equal(out.rows[1].flow, 1000);
  assert.equal(out.rows[2].pnl, 50);
  assert.equal(out.todayFlow, 0);
  assert.equal(out.startDate, '2026-11-19');
  assert.equal(out.rows[2].mv, 11139.73);
  assert.equal(out.truncated, false);
});

test('逐日盈亏：取不到日线按成本估值；没有成交给空状态；days 截断', () => {
  const a = L.normalizeAccount({
    initial: 10000,
    cash: 8995,
    positions: { '1.600519': { code: '600519', name: '茅台', shares: 100, cost: 10.05 } },
    trades: [{ ts: TS('2026-11-19'), secid: '1.600519', side: 'buy', price: 10, shares: 100, amount: 1000, fee: 5 }],
  }, { globalInitial: 10000 });
  const miss = L.reconstructDailyPnl({ account: a, barsBySecid: { '1.600519': [] }, today: '2026-11-23' });
  assert.equal(miss.estimated, true);
  assert.deepEqual(miss.missing, ['1.600519']);
  assert.equal(miss.rows.length, 1);

  const empty = L.reconstructDailyPnl({ account: L.normalizeAccount(null), barsBySecid: {}, today: '2026-11-23' });
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.rows, []);

  const truncated = L.reconstructDailyPnl({
    account: a,
    barsBySecid: { '1.600519': [{ d: '2026-11-19', c: 10 }, { d: '2026-11-20', c: 11 }, { d: '2026-11-23', c: 12 }] },
    days: 60,
    today: '2026-11-23',
  });
  assert.equal(truncated.truncated, false, '60 天下限内不会截断 3 天');
});

test('逐日盈亏与账户汇总一致：累计盈亏 = 逐日盈亏之和（含费用）', () => {
  const a = L.normalizeAccount({
    initial: 10000,
    cash: 10189.4,
    positions: {},
    trades: [
      { ts: TS('2026-11-19'), secid: '1.600519', side: 'buy', price: 10, shares: 100, amount: 1000, fee: 5 },
      { ts: TS('2026-11-20'), secid: '1.600519', side: 'sell', price: 12, shares: 100, amount: 1200, fee: 5.6 },
    ],
  }, { globalInitial: 10000 });
  const bars = { '1.600519': [{ d: '2026-11-19', c: 10 }, { d: '2026-11-20', c: 12 }] };
  const out = L.reconstructDailyPnl({ account: a, barsBySecid: bars, today: '2026-11-20' });
  const sum = Math.round(out.rows.reduce((s, r) => s + r.pnl, 0) * 100) / 100;
  near(sum, 189.4, 0.02);
});

function equalNear(actual, expected, eps, msg) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) <= eps, `${msg || ''}：${actual} ≉ ${expected}`);
}
