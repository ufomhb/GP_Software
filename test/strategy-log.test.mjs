/**
 * 持仓策略：按天记录 / 次日评价 / 自动调参 回归测试（2026-11-17）
 *
 * 只测纯逻辑与状态机：判定规则、工作日推进、记录幂等、评价窗口、命中率统计、
 * 自动调参（触发条件、每天一次、可关、可回滚）。
 * 存储用注入的内存 strategyStore（不落盘），持仓用注入的假 port（不走网络）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createStrategyLog, DEFAULT_BANDS, DEFAULT_AUTOTUNE } = require('../src/services/strategy-log.js');
const { createPushService } = require('../src/services/push.js');

const pushService = createPushService({});

/** 可切换的持仓快照（所有测试共用） */
let portState = null;

function row(overrides) {
  return {
    code: '110022', name: '测试基金', held: true, shares: 1000, price: 1.5,
    marketValue: 1500, weight: 20, pct: -1.5, pctKind: 'nav', navDate: '2026-11-13',
    navPct: -1.5, pctStale: false, advice: { score: 70, rating: { label: '偏多' }, position: { text: '3 成' } },
    ...overrides,
  };
}

function makePort(rows) {
  return {
    today: '2026-11-13',
    totals: { marketValue: 5000, portfolioPct: -0.3, dayProfit: -15, profit: 100, profitPct: 2 },
    rows: rows || [
      row({ code: 'A001', name: '加仓样本', pct: -1.6, advice: { score: 72 } }),
      row({ code: 'B002', name: '减仓样本', pct: 1.2, advice: { score: 30 } }),
      row({ code: 'C003', name: '不变样本', pct: -0.5, advice: { score: 55 } }),
    ],
  };
}

/** 内存 strategyStore + 可控时钟 */
function makeHarness({ today = '2026-11-13', rules = {}, bands = {}, autoTune = {} } = {}) {
  const state = {
    today,
    meta: { rules, bands, tunes: [], autoTune },
    records: new Map(),
  };
  const strategyStore = {
    loadRecords: () => [...state.records.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    saveRecord: (rec) => state.records.set(rec.date, JSON.parse(JSON.stringify(rec))),
    loadMeta: () => JSON.parse(JSON.stringify(state.meta)),
    saveMeta: (meta) => { state.meta = JSON.parse(JSON.stringify(meta)); },
  };
  const log = createStrategyLog({
    strategyStore,
    collectPortfolio: async () => portState,
    classifyPortfolio: pushService.classifyPortfolio,
    normalizeStrategyRules: pushService.normalizeStrategyRules,
    defaultRules: pushService.DEFAULT_STRATEGY_RULES,
    todayKey: () => state.today,
  });
  return { log, state, setToday: (d) => { state.today = d; } };
}

/** 直接塞一批已评价的记录（用于统计/调参测试，跳过行情） */
function seedEvaluated(harness, date, items) {
  const verdicts = { right: 0, wrong: 0, flat: 0, skipped: 0 };
  for (const it of items) verdicts[it.verdict] = (verdicts[it.verdict] || 0) + 1;
  const decided = verdicts.right + verdicts.wrong;
  harness.state.records.set(date, {
    date,
    slotTime: '14:30',
    source: 'manual',
    createdAt: Date.now(),
    items,
    pending: [],
    snapshot: { counts: { add: 0, cut: 0, hold: 0, pending: 0 } },
    eval: { items, summary: { ...verdicts, decided, hitRate: decided ? verdicts.right / decided : null } },
  });
}

test('判定：加仓/减仓/不变的对错标准', () => {
  const { log } = makeHarness();
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
  const { log } = makeHarness();
  assert.deepEqual(log.nextWeekdayKeys('2026-11-13', 2), ['2026-11-16', '2026-11-17']);
  assert.deepEqual(log.nextWeekdayKeys('2026-11-16', 1), ['2026-11-17']);
});

test('记录：同一天不会重复记录，force 可覆盖', async () => {
  portState = makePort();
  const { log, state } = makeHarness({ today: '2026-11-13' });
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
  assert.equal(state.records.size, 1, 'force 应覆盖而不是追加');
});

test('评价：完整链路（隔日评价三组各一条）', async () => {
  portState = makePort();
  const { log, setToday } = makeHarness({ today: '2026-11-13' });
  await log.recordNow();

  setToday('2026-11-16');
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
  assert.equal(snap.stats.overall.hitRate, 1);
});

test('评价：次日净值还没出时保持不变，等下次再评', async () => {
  portState = makePort();
  const { log, setToday } = makeHarness({ today: '2026-11-13' });
  await log.recordNow();

  setToday('2026-11-16');
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
  portState = makePort();
  const { log, setToday } = makeHarness({ today: '2026-11-13' });
  await log.recordNow();

  setToday('2026-11-25'); // 远超 3 个工作日窗口
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
  const { log } = makeHarness({ today: '2026-11-16' });
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
  const { log } = makeHarness();
  const suggestions = log.buildSuggestions(stats, rules);
  const addTip = suggestions.find((s) => s.key === 'addScore');
  assert.ok(addTip, '应给出加仓门槛建议');
  assert.equal(addTip.level, 'warn');
});

/* ---------------- 自动调参 ---------------- */

test('自动调参：命中率过低时上调加仓门槛并留痕', () => {
  const harness = makeHarness({ today: '2026-11-16' });
  // 加仓 6 条里只对 1 条，减仓正常
  seedEvaluated(harness, '2026-11-13', [
    { action: 'add', verdict: 'right', score: 70 },
    { action: 'add', verdict: 'wrong', score: 70 },
    { action: 'add', verdict: 'wrong', score: 72 },
    { action: 'add', verdict: 'wrong', score: 68 },
    { action: 'add', verdict: 'wrong', score: 66 },
    { action: 'add', verdict: 'wrong', score: 69 },
    { action: 'cut', verdict: 'right', score: 30 },
    { action: 'cut', verdict: 'right', score: 28 },
  ]);
  const res = harness.log.runAutoTune({ force: true });
  assert.equal(res.tuned, true);
  const add = res.tune.changes.find((c) => c.field === 'addScore');
  assert.ok(add, '应调整加仓门槛');
  assert.equal(add.from, pushService.DEFAULT_STRATEGY_RULES.addScore);
  assert.equal(add.to, add.from + DEFAULT_AUTOTUNE.step);

  const snap = harness.log.snapshot();
  assert.equal(snap.rules.addScore, add.to, '参数应已生效');
  assert.equal(snap.tunes.length, 1, '应留下调参历史');
});

test('自动调参：命中率达标时不放宽参数', () => {
  const harness = makeHarness({ today: '2026-11-16' });
  seedEvaluated(harness, '2026-11-13', [
    { action: 'add', verdict: 'right', score: 70 },
    { action: 'add', verdict: 'right', score: 72 },
    { action: 'add', verdict: 'right', score: 68 },
    { action: 'add', verdict: 'wrong', score: 66 },
    { action: 'add', verdict: 'right', score: 69 },
    { action: 'cut', verdict: 'right', score: 30 },
  ]);
  const res = harness.log.runAutoTune({ force: true });
  assert.equal(res.tuned, false);
  assert.equal(harness.log.snapshot().rules.addScore, pushService.DEFAULT_STRATEGY_RULES.addScore,
    '命中率好时不应自动放宽门槛');
});

test('自动调参：样本不足时不动', () => {
  const harness = makeHarness({ today: '2026-11-16' });
  seedEvaluated(harness, '2026-11-13', [
    { action: 'add', verdict: 'wrong', score: 70 },
    { action: 'add', verdict: 'wrong', score: 70 },
  ]);
  const res = harness.log.runAutoTune({ force: true });
  assert.equal(res.tuned, false);
  assert.equal(res.reason, 'no-change');
});

test('自动调参：关闭后不执行', () => {
  const harness = makeHarness({ today: '2026-11-16', autoTune: { enabled: false } });
  seedEvaluated(harness, '2026-11-13', new Array(6).fill({ action: 'add', verdict: 'wrong', score: 70 }));
  const res = harness.log.runAutoTune({ force: false });
  assert.equal(res.tuned, false);
  assert.equal(res.reason, 'disabled');
});

test('自动调参：同一天只自动调一次', () => {
  const harness = makeHarness({ today: '2026-11-16' });
  seedEvaluated(harness, '2026-11-13', new Array(6).fill({ action: 'add', verdict: 'wrong', score: 70 }));
  const first = harness.log.runAutoTune({ force: false });
  assert.equal(first.tuned, true);
  const second = harness.log.runAutoTune({ force: false });
  assert.equal(second.tuned, false);
  assert.equal(second.reason, 'already-tuned-today');
});

test('自动调参：可回滚到上一次之前的值', () => {
  const harness = makeHarness({ today: '2026-11-16' });
  seedEvaluated(harness, '2026-11-13', new Array(6).fill({ action: 'add', verdict: 'wrong', score: 70 }));
  const tuned = harness.log.runAutoTune({ force: true });
  const tunedTo = tuned.tune.changes[0].to;
  const before = tuned.tune.changes[0].from;

  const res = harness.log.rollbackLastTune();
  assert.equal(res.ok, true);
  assert.equal(res.rules.addScore, before, '应回到调参前的门槛');
  assert.notEqual(tunedTo, before);
  assert.equal(harness.log.snapshot().tunes[0].rolledBackAt !== undefined, true, '回滚应留痕');
});
