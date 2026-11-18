/**
 * 技术指标单测：KDJ(9,3,3) 与 BOLL(20,2)
 *
 * v2.4.0 把 KDJ / BOLL 加进 lib/indicators.js 并随 /api/kline 下发，
 * 前端副图直接用这些序列。这里锁死三件事：
 *   1. 区间对齐（与 K 线等长、预热期是 null，不会产生 NaN）
 *   2. KDJ 的初值与平滑递推符合教科书公式
 *   3. BOLL 中轨 = MA20、上下轨以中轨对称、标准差为 0 时三线重合
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { kdj, boll, sma, computeSeries } from '../lib/indicators.js';

/** 造一根 K 线：收盘价由 close 决定，上下影固定 */
function candle(close, { vol = 100 } = {}) {
  return { d: '2026-01-01', o: close - 0.1, c: close, h: close + 0.5, l: close - 0.6, v: vol };
}

/** 连续上涨 N 天，每天 +1 */
function rising(n, start = 10) {
  return Array.from({ length: n }, (_, i) => candle(start + i));
}

test('KDJ：序列与 K 线等长，预热期是 null 而不是 NaN', () => {
  const candles = rising(30);
  const out = kdj(candles);
  assert.equal(out.k.length, 30);
  assert.equal(out.d.length, 30);
  assert.equal(out.j.length, 30);
  for (let i = 0; i < 8; i += 1) {
    assert.equal(out.k[i], null, `第 ${i} 根还不满 9 日，K 应为 null`);
    assert.equal(out.d[i], null);
    assert.equal(out.j[i], null);
  }
  for (let i = 8; i < 30; i += 1) {
    assert.ok(Number.isFinite(out.k[i]), `第 ${i} 根 K 应有效`);
    assert.ok(!Number.isNaN(out.k[i]), '不能出现 NaN');
  }
});

test('KDJ：初值与平滑递推符合公式（RSV=100 时 K=66.67、D=55.56）', () => {
  // 连涨 9 天且上影为 0：9 日窗口内收盘就是最高价 → RSV = 100
  const candles = Array.from({ length: 9 }, (_, i) => {
    const c = 10 + i;
    return { d: '2026-01-01', o: c, c, h: c, l: c - 1, v: 100 };
  });
  const out = kdj(candles);
  // K = (前K*(3-1) + RSV)/3，前 K 初值 50 → (50*2+100)/3
  assert.ok(Math.abs(out.k[8] - 66.6667) < 1e-3, `K 应为 66.67，实际 ${out.k[8]}`);
  // D = (前D*2 + K)/3，前 D 初值 50
  assert.ok(Math.abs(out.d[8] - 55.5556) < 1e-3, `D 应为 55.56，实际 ${out.d[8]}`);
  // J = 3K - 2D
  assert.ok(Math.abs(out.j[8] - (3 * out.k[8] - 2 * out.d[8])) < 1e-9);
});

test('KDJ：RSV=0（一路下跌）时 K/D 收敛到低位且不超过 [0,100]', () => {
  // 连跌 20 天且下影为 0：收盘始终是窗口最低价 → RSV = 0
  const falling = Array.from({ length: 20 }, (_, i) => {
    const c = 30 - i;
    return { d: '2026-01-01', o: c, c, h: c + 1, l: c, v: 100 };
  });
  const out = kdj(falling);
  const k = out.k[19];
  const d = out.d[19];
  assert.ok(k >= 0 && k <= 100, `K 应在 0~100，实际 ${k}`);
  assert.ok(d >= 0 && d <= 100, `D 应在 0~100，实际 ${d}`);
  assert.ok(k < 5, `一路下跌 K 应贴近 0，实际 ${k}`);
  assert.ok(Math.abs(out.j[19] - (3 * k - 2 * d)) < 1e-9);
});

test('KDJ：横盘（最高=最低）时不产生 NaN，按上一根延续', () => {
  const flat = Array.from({ length: 15 }, () => ({ d: '2026-01-01', o: 10, c: 10, h: 10, l: 10, v: 100 }));
  const out = kdj(flat);
  for (let i = 8; i < 15; i += 1) {
    assert.ok(Number.isFinite(out.k[i]), '零振幅也要有有限值');
    assert.ok(!Number.isNaN(out.k[i]), '不允许 NaN');
  }
});

test('KDJ：数据不足一个周期时全部为 null', () => {
  const out = kdj(rising(5));
  assert.deepEqual(out.k, [null, null, null, null, null]);
  assert.deepEqual(out.d, [null, null, null, null, null]);
});

test('BOLL：中轨就是 MA20，上下轨对中轨严格对称', () => {
  const closes = rising(40).map((c) => c.c);
  const out = boll(closes);
  const ma20 = sma(closes, 20);
  for (let i = 19; i < 40; i += 1) {
    assert.ok(Math.abs(out.mid[i] - ma20[i]) < 1e-9, `第 ${i} 根中轨应等于 MA20`);
    const up = out.upper[i];
    const low = out.lower[i];
    const mid = out.mid[i];
    assert.ok(Number.isFinite(up) && Number.isFinite(low));
    assert.ok(up > mid && mid > low, '上涨趋势中上轨 > 中轨 > 下轨');
    // 对称性：上轨到中轨的距离 == 中轨到下轨的距离
    assert.ok(Math.abs((up - mid) - (mid - low)) < 1e-9, '上下轨必须对中轨对称');
  }
});

test('BOLL：价格完全不动时标准差为 0，三线重合', () => {
  const closes = new Array(30).fill(12.5);
  const out = boll(closes);
  const i = 29;
  assert.ok(Math.abs(out.upper[i] - 12.5) < 1e-9);
  assert.ok(Math.abs(out.mid[i] - 12.5) < 1e-9);
  assert.ok(Math.abs(out.lower[i] - 12.5) < 1e-9);
});

test('BOLL：预热期是 null，数据不足时整段 null', () => {
  const out = boll(rising(25).map((c) => c.c));
  for (let i = 0; i < 19; i += 1) {
    assert.equal(out.mid[i], null, `第 ${i} 根不满 20 日应为 null`);
    assert.equal(out.upper[i], null);
    assert.equal(out.lower[i], null);
  }
  assert.deepEqual(boll([1, 2, 3]).upper, [null, null, null]);
});

test('computeSeries：把 KDJ / BOLL 一起下发，字段齐全且长度对齐', () => {
  const candles = rising(60);
  const s = computeSeries(candles);
  for (const key of [
    'ma5', 'ma10', 'ma20', 'ma60', 'volMa5', 'rsi14', 'dif', 'dea', 'macd', 'atr14',
    'kdjK', 'kdjD', 'kdjJ', 'bollMid', 'bollUpper', 'bollLower',
  ]) {
    assert.ok(Array.isArray(s[key]), `缺少序列 ${key}`);
    assert.equal(s[key].length, candles.length, `${key} 长度必须与 K 线一致`);
  }
});
