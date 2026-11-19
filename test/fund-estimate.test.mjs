/**
 * 场外基金「当日估值」公式（src/services/fund-estimate.js）回归测试（2026-11-20，v2.9.0）
 *
 * 这段公式同时被实盘 estimateFundDayPctBatch 与历史回测 estimateFundHistPctBatch 使用，
 * 所以必须钉住：覆盖门槛（≥4 只且合计权重 ≥15%）、股票仓位缩放（>20% 才缩放）、
 * ETF 联接穿透、QDII / 无持仓不出数。路由判定 fundEstimateRoute 的测试仍在 daypct.test.mjs。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { estimateFromProfile } = require('../src/services/fund-estimate.js');

/** 造一份「前十大重仓」：weights 与 pcts 一一对应 */
function profile(weights, pcts, extra = {}) {
  const stocks = weights.map((w, i) => ({ code: `60000${i}`, name: `重仓${i}`, weight: w }));
  const pctByCode = new Map(stocks.map((s, i) => [s.code, pcts[i]]));
  return { stocks, pctByCode, ...extra };
}

test('重仓穿透：按权重加权，并按股票仓位（>20%）缩放', () => {
  const { stocks, pctByCode } = profile([10, 8, 6, 4, 3, 2], [1, -2, 3, 0.5, -1, 2]);
  const p = { stocks, etfCode: '', etfName: '' };
  const plain = estimateFromProfile({ route: 'holdings', profile: p, stockRatio: null, pctByCode });
  assert.equal(plain.pct, 0.15, 'contrib = (10*1 + 8*-2 + 6*3 + 4*0.5 + 3*-1 + 2*2)/100 = 0.15');
  assert.equal(plain.kind, 'holdings');
  assert.equal(plain.covered, 6);
  assert.equal(plain.weight, 33);

  const scaled = estimateFromProfile({ route: 'holdings', profile: p, stockRatio: 66, pctByCode });
  assert.equal(scaled.pct, 0.3, '股票仓位 66% / 重仓合计 33% → 放大 2 倍');
  assert.equal(scaled.stockRatio, 66);
});

test('重仓穿透：股票仓位 ≤20% 不缩放（避免把零头仓位放大成满仓）', () => {
  const { stocks, pctByCode } = profile([6, 5, 4, 4], [2, 2, 2, 2]);
  const p = { stocks, etfCode: '', etfName: '' };
  const r = estimateFromProfile({ route: 'holdings', profile: p, stockRatio: 12, pctByCode });
  assert.equal(r.pct, 0.38, '(6+5+4+4)*2/100 = 0.38，未缩放');
  assert.match(r.note, /直接按权重加总/);
});

test('重仓穿透：覆盖不足（<4 只 或 合计 <15%）不给估值', () => {
  const few = profile([10, 8, 6], [1, 1, 1]);
  const r1 = estimateFromProfile({
    route: 'holdings', profile: { stocks: few.stocks }, stockRatio: null, pctByCode: few.pctByCode,
  });
  assert.equal(r1.pct, null);
  assert.equal(r1.covered, 3);

  const light = profile([5, 4, 3, 2], [1, 1, 1, 1]);
  const r2 = estimateFromProfile({
    route: 'holdings', profile: { stocks: light.stocks }, stockRatio: null, pctByCode: light.pctByCode,
  });
  assert.equal(r2.pct, null);
  assert.equal(r2.weight, 14);
});

test('重仓穿透：当天取不到某只重仓行情时不计入覆盖（不拿 0% 冒充）', () => {
  const { stocks, pctByCode } = profile([10, 8, 6, 4], [1, 1, 1, 1]);
  // 去掉最后一只的行情：覆盖 3 只 → 不出数
  pctByCode.delete('600003');
  const r = estimateFromProfile({ route: 'holdings', profile: { stocks }, stockRatio: null, pctByCode });
  assert.equal(r.pct, null);
  assert.equal(r.covered, 3);
});

test('ETF 联接：直接取目标 ETF 场内涨跌，权重按 100% 记', () => {
  const r = estimateFromProfile({
    route: 'etf',
    profile: { stocks: [{ code: '600000', weight: 0.5 }], etfCode: '515700', etfName: '新能车ETF' },
    stockRatio: null,
    pctByCode: new Map([['515700', 1.23]]),
  });
  assert.equal(r.pct, 1.23);
  assert.equal(r.kind, 'etf');
  assert.equal(r.weight, 100);
  assert.match(r.note, /515700/);
});

test('ETF 联接：目标 ETF 行情缺失时不出数', () => {
  const r = estimateFromProfile({
    route: 'etf',
    profile: { stocks: [], etfCode: '515700', etfName: '' },
    stockRatio: null,
    pctByCode: new Map(),
  });
  assert.equal(r.pct, null);
  assert.match(r.note, /行情不可用/);
});

test('QDII / 无持仓：不出估值，并给出原因', () => {
  const q = estimateFromProfile({ route: 'qdii', profile: { stocks: [] }, pctByCode: new Map() });
  assert.equal(q.pct, null);
  assert.match(q.note, /QDII/);
  const n = estimateFromProfile({ route: 'none', profile: { stocks: [] }, pctByCode: new Map() });
  assert.equal(n.pct, null);
  assert.match(n.note, /未披露持仓/);
  const missing = estimateFromProfile({ route: 'holdings', profile: null, pctByCode: new Map() });
  assert.equal(missing.pct, null);
  assert.match(missing.note, /重仓数据不可用/);
});
