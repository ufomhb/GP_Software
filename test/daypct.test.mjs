/* 「当日涨跌 / 当日估值」口径的回归测试（v2.1.4 起）。
   做法：从 server.js 抽取真实函数源码，注入可控时钟与冻结存储，测的就是线上那份逻辑，
   避免测试副本与实现脱节。覆盖：
   1. 当日涨跌：有净值就显示；普通基金交易日 15:00 后等当日净值时留空；QDII/滞后披露基金回退显示
   2. 当日估值：与「今日净值是否已公布」解耦——净值公布后估值必须保留，供两列对比 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'server.js'), 'utf8');

function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark, a + 1);
  assert.ok(a > 0 && b > a, `server.js 里找不到片段：${startMark}`);
  return src.slice(a, b);
}

const isQdiiText = slice('function isQdiiFund(', 'async function fetchFundStockRatio(');
const viewText = slice('function fundNavLagTradingDays(', 'function resolveFundTodayPct(');

let CLOCK = { weekday: 2, minutes: 125 };
let FROZEN = {};

function build() {
  FROZEN = {};
  const CN_CLOSE_MINUTES = 15 * 60;
  const zonedParts = () => ({ ...CLOCK, date: '2026-11-17', text: '00:00' });
  const num = (v) => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : null; };
  const frozenFundEstimate = (code) => FROZEN[code] || null;
  const freezeFundEstimate = (code, today, live) => {
    const rec = { pct: live.pct, at: live.at || '', nav: live.nav ?? null, kind: live.kind || 'official' };
    FROZEN[code] = rec;
    return rec;
  };
  return new Function(
    'zonedParts', 'CN_CLOSE_MINUTES', 'num', 'frozenFundEstimate', 'freezeFundEstimate',
    `${isQdiiText}\n${viewText}\nreturn { fundDayPctView, fundNavLagTradingDays, resolveFundPctPair, isQdiiFund };`,
  )(zonedParts, CN_CLOSE_MINUTES, num, frozenFundEstimate, freezeFundEstimate);
}

const TODAY = '2026-11-17'; // 周二

/* ---------------- 当日涨跌 ---------------- */

test('交易日未到 15:00：显示最近一期已公布净值，并标记不是今天', () => {
  CLOCK = { weekday: 2, minutes: 2 * 60 + 5 };
  const r = build().fundDayPctView({ navDate: '2026-11-16', navPct: -4.45, today: TODAY, name: '华夏成长混合' });
  assert.equal(r.pct, -4.45);
  assert.equal(r.isToday, false);
  assert.equal(r.date, '2026-11-16');
});

test('交易日已过 15:00 且今日净值未出：普通基金留空，不拿昨天冒充今天', () => {
  CLOCK = { weekday: 2, minutes: 16 * 60 + 30 };
  const r = build().fundDayPctView({ navDate: '2026-11-16', navPct: -7.96, today: TODAY, name: '浦银数字经济混合C' });
  assert.equal(r.pct, null);
  assert.equal(r.lagging, false);
});

test('交易日已过 15:00 且今日净值已出：显示今日净值', () => {
  CLOCK = { weekday: 2, minutes: 16 * 60 + 30 };
  const r = build().fundDayPctView({ navDate: TODAY, navPct: 1.23, today: TODAY, name: '华夏成长混合' });
  assert.equal(r.pct, 1.23);
  assert.equal(r.isToday, true);
});

test('QDII 基金（名称判定）收盘后回退显示最近一期净值，不再显示 --', () => {
  CLOCK = { weekday: 2, minutes: 16 * 60 + 30 };
  const r = build().fundDayPctView({ navDate: '2026-11-16', navPct: -1.5, today: TODAY, name: '华夏纳斯达克100ETF联接(QDII)A' });
  assert.equal(r.pct, -1.5, 'QDII 应回退显示最近一期净值');
  assert.equal(r.lagging, true);
});

test('净值滞后 >= 2 个交易日（数据比市场慢一拍）同样回退显示', () => {
  CLOCK = { weekday: 2, minutes: 16 * 60 + 30 };
  // 11-13 是周五，到 11-17 周二隔了 2 个交易日
  const r = build().fundDayPctView({ navDate: '2026-11-13', navPct: 0.8, today: TODAY, name: '某海外精选' });
  assert.equal(r.pct, 0.8);
  assert.equal(r.lagging, true);
});

test('周末休市：即使过了 15:00 也显示最近一期净值', () => {
  CLOCK = { weekday: 6, minutes: 16 * 60 + 30 };
  const r = build().fundDayPctView({ navDate: '2026-11-20', navPct: 0.5, today: '2026-11-21', name: '普通基金' });
  assert.equal(r.pct, 0.5);
  assert.equal(r.isToday, false);
});

test('缺净值日期或缺涨跌幅：留空（不能因为 Number(null)===0 显示成 0%）', () => {
  CLOCK = { weekday: 2, minutes: 2 * 60 + 5 };
  const fn = build().fundDayPctView;
  assert.equal(fn({ navDate: '', navPct: 1, today: TODAY, name: 'x' }).pct, null);
  assert.equal(fn({ navDate: '2026-11-16', navPct: null, today: TODAY, name: 'x' }).pct, null);
  assert.equal(fn({ navDate: '2026-11-16', navPct: undefined, today: TODAY, name: 'x' }).pct, null);
  assert.equal(fn({ navDate: '2026-11-16', navPct: '', today: TODAY, name: 'x' }).pct, null);
});

test('涨跌幅为 0 是合法值，必须显示 0', () => {
  CLOCK = { weekday: 2, minutes: 10 * 60 };
  assert.equal(build().fundDayPctView({ navDate: '2026-11-16', navPct: 0, today: TODAY, name: 'x' }).pct, 0);
});

test('交易日数计算：周五到周二算 2 个交易日', () => {
  const fn = build().fundNavLagTradingDays;
  assert.equal(fn('2026-11-16', '2026-11-17'), 1);
  assert.equal(fn('2026-11-13', '2026-11-17'), 2);
  assert.equal(fn('2026-11-17', '2026-11-17'), 0);
});

/* ---------------- 当日估值（必须与净值是否已出解耦） ---------------- */

const INFO = (navDate, navPct) => ({ PDATE: navDate, NAVCHGRT: navPct, SHORTNAME: '华夏成长混合' });

test('【核心】今日净值已公布时，当日估值必须保留，不能变成 null', () => {
  CLOCK = { weekday: 2, minutes: 20 * 60 }; // 晚上，净值已公布
  const api = build();
  api.resolveFundPctPair({ code: '000001', info: INFO(TODAY, 1.23), today: TODAY, pastClose: true, est: { pct: 0.98, kind: 'holdings' } });
  // 上面这次调用已把估值冻结下来
  const pair = api.resolveFundPctPair({ code: '000001', info: INFO(TODAY, 1.23), today: TODAY, pastClose: true, est: null });
  assert.equal(pair.navPctShow, 1.23, '当日涨跌用今日净值');
  assert.equal(pair.estimatePct, 0.98, '当日估值必须保留，供与净值对比');
  assert.equal(pair.estimateFrozen, true);
  assert.equal(pair.navPctToday, 1.23);
});

test('先有估值后出净值：估值冻结值不被后续净值改写', () => {
  CLOCK = { weekday: 2, minutes: 16 * 60 }; // 15:00 后，净值还没出
  const api = build();
  const before = api.resolveFundPctPair({ code: '000002', info: INFO('2026-11-16', -0.5), today: TODAY, pastClose: true, est: { pct: 2.4, kind: 'etf' } });
  assert.equal(before.estimatePct, 2.4);
  assert.equal(before.navPctShow, null, '普通基金此时当日涨跌应为 --');
  const after = api.resolveFundPctPair({ code: '000002', info: INFO(TODAY, 2.1), today: TODAY, pastClose: true, est: null });
  assert.equal(after.estimatePct, 2.4, '冻结的估值不能被净值改写');
  assert.equal(after.navPctShow, 2.1, '净值出来后当日涨跌应有值');
});

test('盘中没有官方估值时用穿透估算，且标记未冻结', () => {
  CLOCK = { weekday: 2, minutes: 11 * 60 };
  const pair = build().resolveFundPctPair({ code: '000003', info: INFO('2026-11-16', -0.5), today: TODAY, pastClose: false, est: { pct: 1.1, kind: 'holdings' } });
  assert.equal(pair.estimatePct, 1.1);
  assert.equal(pair.estimateFrozen, false);
  assert.equal(pair.estimateKind, 'holdings');
});

test('既无官方估值也无穿透估算：估值留空（不伪造）', () => {
  CLOCK = { weekday: 2, minutes: 20 * 60 };
  const pair = build().resolveFundPctPair({ code: '000004', info: INFO(TODAY, 1.0), today: TODAY, pastClose: true, est: null });
  assert.equal(pair.estimatePct, null);
  assert.equal(pair.estimateFrozen, false);
});

test('官方盘中估值优先于穿透估算', () => {
  CLOCK = { weekday: 2, minutes: 11 * 60 };
  const info = { PDATE: '2026-11-16', NAVCHGRT: -0.5, SHORTNAME: 'x', GSZ: 1.234, GSZZL: 0.77, GZTIME: `${TODAY} 11:00` };
  const pair = build().resolveFundPctPair({ code: '000005', info, today: TODAY, pastClose: false, est: { pct: 1.1, kind: 'holdings' } });
  assert.equal(pair.estimatePct, 0.77);
  assert.equal(pair.estimateKind, 'official');
});
