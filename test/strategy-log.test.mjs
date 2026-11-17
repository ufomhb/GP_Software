/**
 * 持仓策略按天记录与次日评价回归测试（2026-11-17）
 *
 * 只测纯逻辑：判定规则、工作日推进、次日净值匹配窗口、命中率统计、调参建议。
 * 存储用注入的内存读写，不落盘；持仓用注入的假 port，不走网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createStrategyLog, DEFAULT_BANDS } = require('../src/services/strategy-log.js');
const { createPushService } = require('../src/services/push.js');

const pushService = createPushService({});

/** 内存版存储，替代 dataStore 的文件读写 */
function makeLog({ today = '2026-11-16' } = {}) {
  const mem = new Map();
  return createStrategyLog({
    fs: null,
    path: { join: (...parts) => parts.join('/') },
    dataDir: '/tmp',
    readJsonFile: (file, fallback) => (mem.has(file) ? JSON.parse(mem.get(file)) : fallback),
    writeJsonFile: (file, data) => mem.set(file, JSON.stringify(data)),
    collectPortfolio: async () => currentPort(),
    classifyPortfolio: pushService.classifyPortfolio,
    normalizeStrategyRules: pushService.normalizeStrategyRules,
    defaultRules: pushService.DEFAULT_STRATEGY_RULES,
    todayKey: () => today,
    __mem: mem,
  });
}

/** 可切换的持仓快照 */
let portState = null;
function currentPort() {
  return portState;
}

function row(overrides) {
  return {
    code: '110022', name: '测试基金', held: true, shares: 1000, price: 1.5,
    marketValue: 1500, weight: 20, pct: -1.5, pctKind: 'nav', navDate: '2026-11-13',
    navPct: -1.5, pctStale: false, advice: { score: 70, rating: { label: '偏多' }, position: { text: '3 成' } },
    ...overrides,
  };
}

function makePort(rows) {
  const items = rows || [
    row({ code: 'A001', name: '加仓样本', pct: -1.6, advice: { score: 72 } }),      // 加仓
    row({ code: 'B002', name: '减仓样本', pct: 1.2, advice: { score: 30 } }),       // 减仓
    row({ code: 'C003', name: '不变样本', pct: -0.5, advice: { score: 55 } }),      // 不变
  ];
  return {
    today: '2026-11-13',
    totals: { marketValue: 5000, portfolioPct: -0.3, dayProfit: -15, profit: 100, profitPct: 2 },
    rows: items,
  };
}

test('判定：加仓/减仓/不变的对错标准', () => {
  const log = makeLog();
  const bands = DEFAULT_BANDS;
  assert.equal(log.judge('add', 1.2, bands).verdict, 'right');
  assert.equal(log.judge('add', -1.2, bands).verdict, 'wrong');
  assert.equal(log.judge('add', 0, bands).verdict, 'flat');
  assert.equal(log.judge('cut', -1.2, bands).verdict, 'right');
  assert.equal(log.judge('cut', 1.2, bands).verdict, 'wrong');
  assert.equal(log.judge('cut', 0, bands).verdict, 'flat');
  assert.equal(log.judge('hold', 0.5, bands).verdict, 'right');
  assert.equal(log.judge('hold', 2, bands).verdict, 'flat');
  assert.equal(log.judge('add', null, bands).verdict, 'skipped');
});

test('日期：次日工作日推进（周五→周一）', () => {
  const log = makeLog();
  assert.deepEqual(log.nextWeekdayKeys('2026-11-13', 2), ['2026-11-16', '2026-11-17']);
  assert.deepEqual(log.nextWeekdayKeys('2026-11-16', 1), ['2026-11-17']);
});

test('记录：同一天不会重复记录，force 可覆盖', async () => {
  portState = makePort();
  const log = makeLog({ today: '2026-11-13' });
  const first = await log.recordNow();
  assert.equal(first.recorded, true);
  assert.equal(first.items, 3);
  assert.equal(first.counts.add, 1);
  assert.equal(first.counts.cut, 1);
  assert.equal(first.counts.hold, 1);

  const second = await log.recordNow();
  assert.equal(second.recorded, false, '同一天默认不重复记录');

  const forced = await log.recordNow({ force: true });
  assert.equal(forced.recorded, true);
  const snap = log.snapshot();
  assert.equal(snap.records.filter((r) => r.date === '2026-11-13').length, 1, 'force 应覆盖而不是追加');
});

test('评价：完整链路（隔日评价三组各一条）', async () => {
  portState = makePort();
  const mem = new Map();
  let today = '2026-11-13';
  const log = createStrategyLog({
    fs: null,
    path: { join: (...parts) => parts.join('/') },
    dataDir: '/tmp',
    readJsonFile: (file, fallback) => (mem.has(file) ? JSON.parse(mem.get(file)) : fallback),
    writeJsonFile: (file, data) => mem.set(file, JSON.stringify(data)),
    collectPortfolio: async () => currentPort(),
    classifyPortfolio: pushService.classifyPortfolio,
    normalizeStrategyRules: pushService.normalizeStrategyRules,
    defaultRules: pushService.DEFAULT_STRATEGY_RULES,
    todayKey: () => today,
  });

  await log.recordNow();

  today = '2026-11-16';
  portState = makePort([
    row({ code: 'A001', name: '加仓样本', pct: 1.8, pctKind: 'nav', navDate: '2026-11-16' }),
    row({ code: 'B002', name: '减仓样本', pct: -0.9, pctKind: 'nav', navDate: '2026-11-16' }),
    row({ code: 'C003', name: '不变样本', pct: 0.2, pctKind: 'nav', navDate: '2026-11-16' }),
  ]);
  const res = await log.evaluateNow();
  assert.equal(res.evaluated, 1);

  const snap = log.snapshot();
  const rec = snap.records.find((r) => r.date === '2026-11-13');
  assert.ok(rec && rec.eval, '应已生成评价');
  const byAction = Object.fromEntries(rec.eval.items.map((it) => [it.action, it]));
  assert.equal(byAction.add.verdict, 'right', '加仓后涨了应算合理');
  assert.equal(byAction.cut.verdict, 'right', '减仓后跌了应算合理');
  assert.equal(byAction.hold.verdict, 'right', '不变且波动小应算合理');

  assert.equal(snap.stats.overall.right, 3);
  assert.equal(snap.stats.overall.wrong, 0);
  assert.equal(snap.stats.overall.hitRate, 1);
});

test('评价：次日净值还没出时保持不变，等下次再评', async () => {
  const mem = new Map();
  let today = '2026-11-13';
  portState = makePort();
  const log = createStrategyLog({
    fs: null,
    path: { join: (...parts) => parts.join('/') },
    dataDir: '/tmp',
    readJsonFile: (file, fallback) => (mem.has(file) ? JSON.parse(mem.get(file)) : fallback),
    writeJsonFile: (file, data) => mem.set(file, JSON.stringify(data)),
    collectPortfolio: async () => currentPort(),
    classifyPortfolio: pushService.classifyPortfolio,
    normalizeStrategyRules: pushService.normalizeStrategyRules,
    defaultRules: pushService.DEFAULT_STRATEGY_RULES,
    todayKey: () => today,
  });
  await log.recordNow();

  today = '2026-11-16';
  // 只有盘中估算，没有已公布净值
  portState = makePort([
    row({ code: 'A001', name: '加仓样本', pct: 1.8, pctKind: 'estimate', navDate: '2026-11-13' }),
    row({ code: 'B002', name: '减仓样本', pct: -0.9, pctKind: 'estimate', navDate: '2026-11-13' }),
    row({ code: 'C003', name: '不变样本', pct: 0.2, pctKind: 'estimate', navDate: '2026-11-13' }),
  ]);
  const res = await log.evaluateNow();
  assert.equal(res.evaluated, 0, '估算不算数，应保持待评价');
  const rec = log.snapshot().records.find((r) => r.date === '2026-11-13');
  assert.equal(rec.eval, null);
});

test('评价：超出窗口才拿不到净值 → 记 skipped', async () => {
  const mem = new Map();
  let today = '2026-11-13';
  portState = makePort();
  const log = createStrategyLog({
    fs: null,
    path: { join: (...parts) => parts.join('/') },
    dataDir: '/tmp',
    readJsonFile: (file, fallback) => (mem.has(file) ? JSON.parse(mem.get(file)) : fallback),
    writeJsonFile: (file, data) => mem.set(file, JSON.stringify(data)),
    collectPortfolio: async () => currentPort(),
    classifyPortfolio: pushService.classifyPortfolio,
    normalizeStrategyRules: pushService.normalizeStrategyRules,
    defaultRules: pushService.DEFAULT_STRATEGY_RULES,
    todayKey: () => today,
  });
  await log.recordNow();

  today = '2026-11-25'; // 远超 3 个工作日窗口
  portState = makePort([
    row({ code: 'A001', name: '加仓样本', pct: 1.8, pctKind: 'nav', navDate: '2026-11-25' }),
    row({ code: 'B002', name: '减仓样本', pct: -0.9, pctKind: 'nav', navDate: '2026-11-25' }),
    row({ code: 'C003', name: '不变样本', pct: 0.2, pctKind: 'nav', navDate: '2026-11-25' }),
  ]);
  const res = await log.evaluateNow();
  assert.equal(res.evaluated, 1);
  const rec = log.snapshot().records.find((r) => r.date === '2026-11-13');
  assert.ok(rec.eval.items.every((it) => it.verdict === 'skipped'), '超窗应全部标未评价');
  assert.equal(rec.eval.summary.decided, 0);
});

test('参数：保存后马上生效并被夹到合理区间', () => {
  const log = makeLog({ today: '2026-11-16' });
  const res = log.saveConfig({ rules: { addScore: 999, cutScore: 1 }, bands: { holdBand: -5, evalWindow: 99 } });
  assert.ok(res.rules.addScore <= 100);
  assert.ok(res.rules.cutScore >= 5);
  assert.ok(res.bands.holdBand > 0);
  assert.ok(res.bands.evalWindow <= 10);
});

test('建议：加仓命中率过低时给出提高门槛的具体建议', () => {
  const rules = { ...pushService.DEFAULT_STRATEGY_RULES };
  const stats = {
    days: 5,
    byAction: {
      add: { n: 6, right: 1, wrong: 5, flat: 0, skipped: 0, decided: 6, hitRate: 1 / 6 },
      cut: { n: 5, right: 3, wrong: 2, flat: 0, skipped: 0, decided: 5, hitRate: 0.6 },
      hold: { n: 12, right: 7, wrong: 0, flat: 5, skipped: 0, decided: 7, hitRate: 1 },
    },
  };
  const log = makeLog();
  const suggestions = log.buildSuggestions(stats, rules);
  const addTip = suggestions.find((s) => s.key === 'addScore');
  assert.ok(addTip, '应给出加仓门槛建议');
  assert.match(addTip.text, /加仓命中率/);
  assert.equal(addTip.level, 'warn');
});
