/* 「当日涨跌」取值口径的回归测试（2026-11-17 v2.1.3 起）。
   口径：只要有一期准确净值就显示；只有「今天是交易日 + 已过 15:00 + 今日净值还没出」才留空。
   做法：从 server.js 里抽出 fundDayPctView 的真实源码执行，用可控时钟注入 zonedParts/CN_CLOSE_MINUTES/num，
   这样测的就是线上那份逻辑，不会与实现脱节。 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'server.js'), 'utf8');
const start = src.indexOf('function fundDayPctView(');
const end = src.indexOf('function resolveFundPctPair(');

function build(clock) {
  assert.ok(start > 0 && end > start, 'server.js 里找不到 fundDayPctView');
  const fnText = src.slice(start, end);
  const CN_CLOSE_MINUTES = 15 * 60;
  const zonedParts = () => ({ ...clock });
  const num = (v) => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : null; };
  return new Function('zonedParts', 'CN_CLOSE_MINUTES', 'num', `${fnText}\nreturn fundDayPctView;`)(zonedParts, CN_CLOSE_MINUTES, num);
}

const TODAY = '2026-11-17';

test('交易日未到 15:00：显示最近一期已公布净值，并标记不是今天', () => {
  const fn = build({ weekday: 2, minutes: 2 * 60 + 5 });
  const r = fn({ navDate: '2026-11-16', navPct: -4.45, today: TODAY });
  assert.equal(r.pct, -4.45);
  assert.equal(r.isToday, false);
  assert.equal(r.date, '2026-11-16');
});

test('交易日盘中：显示最近一期已公布净值', () => {
  const fn = build({ weekday: 2, minutes: 10 * 60 });
  assert.equal(fn({ navDate: '2026-11-16', navPct: -0.93, today: TODAY }).pct, -0.93);
});

test('交易日已过 15:00 且今日净值未出：留空，不拿昨天冒充今天', () => {
  const fn = build({ weekday: 2, minutes: 16 * 60 + 30 });
  const r = fn({ navDate: '2026-11-16', navPct: -7.96, today: TODAY });
  assert.equal(r.pct, null);
  assert.equal(r.isToday, false);
});

test('交易日已过 15:00 且今日净值已出：显示今日净值', () => {
  const fn = build({ weekday: 2, minutes: 16 * 60 + 30 });
  const r = fn({ navDate: TODAY, navPct: 1.23, today: TODAY });
  assert.equal(r.pct, 1.23);
  assert.equal(r.isToday, true);
});

test('周末休市：即使过了 15:00 也显示最近一期净值', () => {
  const fn = build({ weekday: 6, minutes: 16 * 60 + 30 });
  const r = fn({ navDate: '2026-11-20', navPct: 0.5, today: '2026-11-21' });
  assert.equal(r.pct, 0.5);
  assert.equal(r.isToday, false);
});

test('缺净值日期或缺涨跌幅：留空（不能因为 Number(null)===0 显示成 0%）', () => {
  const fn = build({ weekday: 2, minutes: 2 * 60 + 5 });
  assert.equal(fn({ navDate: '', navPct: 1, today: TODAY }).pct, null);
  assert.equal(fn({ navDate: '2026-11-16', navPct: null, today: TODAY }).pct, null);
  assert.equal(fn({ navDate: '2026-11-16', navPct: undefined, today: TODAY }).pct, null);
  assert.equal(fn({ navDate: '2026-11-16', navPct: '', today: TODAY }).pct, null);
});

test('涨跌幅为 0 是合法值，必须显示 0', () => {
  const fn = build({ weekday: 2, minutes: 10 * 60 });
  assert.equal(fn({ navDate: '2026-11-16', navPct: 0, today: TODAY }).pct, 0);
});
