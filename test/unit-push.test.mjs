import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createPushService } = require(join(ROOT, 'src', 'services', 'push.js'));

// 纯函数不依赖注入项，空依赖即可
const push = createPushService({});

const SLOTS = [
  { key: 'strategy', label: '持仓策略', time: '14:30', enabled: true },
  { key: 'valuation', label: '净值/估值', time: '19:30', enabled: true },
];
const cfg = (over = {}) => ({
  enabled: true,
  weekdaysOnly: true,
  slots: SLOTS.map((s) => ({ ...s })),
  lastSent: {},
  ...over,
});
// 2026-11-16 是周一，2026-11-14 是周六、15 是周日
const at = (iso) => push.pushClock(new Date(iso));

test('push：pushClock 按东八区换算（日期/分钟/星期）', () => {
  const monday1430 = at('2026-11-16T06:30:00Z');
  assert.equal(monday1430.day, '2026-11-16');
  assert.equal(monday1430.minutes, 870); // 14*60+30
  assert.equal(monday1430.weekday, 1); // 周一

  const sunday = at('2026-11-15T12:00:00Z'); // HKT 20:00
  assert.equal(sunday.day, '2026-11-15');
  assert.equal(sunday.minutes, 1200);
  assert.equal(sunday.weekday, 0);

  // 跨日：UTC 16:30 = 次日 00:30（东八区）
  const crossDay = at('2026-11-15T16:30:00Z');
  assert.equal(crossDay.day, '2026-11-16');
  assert.equal(crossDay.minutes, 30);
});

test('push：slotMinutes 解析 HH:MM', () => {
  assert.equal(push.slotMinutes({ time: '14:30' }), 870);
  assert.equal(push.slotMinutes({ time: '19:30' }), 1170);
  assert.equal(push.slotMinutes({ time: '00:00' }), 0);
  assert.equal(push.slotMinutes(null), 0);
  assert.equal(push.slotMinutes({}), 0);
});

test('push：dueSlots 只在该发的时刻返回（含周末与幂等）', () => {
  // 总开关关闭
  assert.deepEqual(push.dueSlots(cfg({ enabled: false }), at('2026-11-16T06:30:00Z')), []);
  // 周末跳过（weekdaysOnly）
  assert.deepEqual(push.dueSlots(cfg(), at('2026-11-14T06:30:00Z')), []);
  // 周末不跳过
  assert.equal(push.dueSlots(cfg({ weekdaysOnly: false }), at('2026-11-14T06:30:00Z')).length, 1);
  // 差一分钟不发
  assert.deepEqual(push.dueSlots(cfg(), at('2026-11-16T06:29:00Z')), []);
  // 到点发 strategy
  assert.deepEqual(push.dueSlots(cfg(), at('2026-11-16T06:30:00Z')).map((s) => s.key), ['strategy']);
  // 已发过当天的不再发（幂等）
  assert.deepEqual(push.dueSlots(cfg({ lastSent: { strategy: '2026-11-16' } }), at('2026-11-16T06:30:00Z')), []);
  // 19:30 两个时段都该发（strategy 还没发）
  assert.deepEqual(push.dueSlots(cfg(), at('2026-11-16T11:30:00Z')).map((s) => s.key), ['strategy', 'valuation']);
  // 单个时段被禁用
  const disabled = cfg();
  disabled.slots[1].enabled = false;
  assert.deepEqual(push.dueSlots(disabled, at('2026-11-16T11:30:00Z')).map((s) => s.key), ['strategy']);
});

test('push：normalizePushConfig 补齐默认值与旧字段迁移', () => {
  const empty = push.normalizePushConfig(null);
  assert.equal(empty.enabled, false);
  assert.equal(empty.channel, 'serverchan');
  assert.equal(empty.weekdaysOnly, true);
  assert.equal(empty.slots.length, 2);
  assert.deepEqual(empty.funds, []);
  assert.deepEqual(empty.holdings, {});
  assert.deepEqual(empty.lastSent, {});

  // 旧的单时段 time 迁移到第一个时段
  const legacy = push.normalizePushConfig({ time: '15:00' });
  assert.equal(legacy.slots[0].time, '15:00');

  // 字符串 lastSent 归一成对象；非法 slots 回落到默认两段
  const messy = push.normalizePushConfig({ lastSent: '2026-01-01', slots: 'oops' });
  assert.deepEqual(messy.lastSent, {});
  assert.equal(messy.slots.length, 2);

  // 非法 time 用默认值兜底
  const badTime = push.normalizePushConfig({ slots: [{ key: 'strategy', time: '25:99' }] });
  assert.equal(badTime.slots[0].time, '14:30');
});

test('push：maskPushConfig 隐藏 SendKey 与 webhook', () => {
  const masked = push.maskPushConfig({ token: 'SCT1234567890abcdef', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef123456' });
  assert.match(masked.token, /\*\*\*\*/);
  assert.ok(!masked.token.includes('1234567890'));
  assert.match(masked.webhook, /\*\*\*\*/);
  assert.equal(push.maskPushConfig({}).token, '');
});

test('push：pushChannelLabel 中文名', () => {
  assert.equal(push.pushChannelLabel('serverchan'), 'Server酱');
  assert.equal(push.pushChannelLabel('pushplus'), 'PushPlus');
  assert.equal(push.pushChannelLabel('wecom'), '企业微信群机器人');
  assert.equal(push.pushChannelLabel('custom'), '自定义 webhook');
  assert.equal(push.pushChannelLabel('unknown'), 'unknown');
});

test('push：决策口径只用 15:00 估值，真实净值只作展示', async () => {
  const service = createPushService({
    store: { loadPushConfig: () => ({}), savePushConfig: () => {} },
    loadUsers: () => ({ users: [{ primary: true }] }),
    loadPortfolio: () => ({ funds: [{ code: '000001' }], holdings: { '000001': { shares: 1000, cost: 1 } } }),
    market: {
      shanghaiToday: () => '2026-11-17',
      getFundWatch: async () => ({
        items: [{
          code: '000001', name: '样本', type: 'open', price: 1.1,
          pct: -6.36, pctKind: 'nav', navDate: '2026-11-17', navPct: -6.36,
          estimatePct: -5.98, estimateKind: 'holdings', estimateFrozen: true,
          date: '2026-11-17', estimateTime: '',
        }],
      }),
    },
  });
  const port = await service.collectPortfolio();
  const row = port.rows[0];
  assert.equal(row.pct, -6.36, '真实净值保留给当日盈亏展示');
  assert.equal(row.decisionPct, -5.98, '决策只认 15:00 估值');
  assert.equal(row.decisionKind, 'holdings');
  const cls = service.classifyPortfolio(port, service.DEFAULT_STRATEGY_RULES, null);
  const items = [...cls.add, ...cls.cut, ...cls.hold];
  assert.equal(items.length, 1);
  assert.equal(items[0].pct, -5.98);
  assert.equal(cls.pending.length, 0);
});

test('push：没有 15:00 估值时不拿真净值决策，记 pending', async () => {
  const service = createPushService({
    store: { loadPushConfig: () => ({}), savePushConfig: () => {} },
    loadUsers: () => ({ users: [{ primary: true }] }),
    loadPortfolio: () => ({ funds: [{ code: '000001' }], holdings: { '000001': { shares: 1000, cost: 1 } } }),
    market: {
      shanghaiToday: () => '2026-11-17',
      getFundWatch: async () => ({
        items: [{
          code: '000001', name: '样本', type: 'open', price: 1.1,
          pct: -6.36, pctKind: 'nav', navDate: '2026-11-17', navPct: -6.36,
          estimatePct: null, estimateKind: '', date: '2026-11-17', estimateTime: '',
        }],
      }),
    },
  });
  const port = await service.collectPortfolio();
  assert.equal(port.rows[0].decisionPct, null);
  const cls = service.classifyPortfolio(port, service.DEFAULT_STRATEGY_RULES, null);
  assert.equal(cls.add.length + cls.cut.length + cls.hold.length, 0);
  assert.equal(cls.pending.length, 1);
});

test('push：handleDueSlot 错过超过 6 小时只记账不补发', async () => {
  const calls = [];
  const service = createPushService({
    store: {
      loadPushConfig: () => ({ lastSent: {} }),
      savePushConfig: (patch) => { calls.push(patch); },
    },
  });
  // HKT 21:00，距 14:30 已 390 分钟（> 360）→ 跳过并记账，不生成报告
  const late = at('2026-11-16T13:00:00Z');
  await service.handleDueSlot({ lastSent: {} }, { key: 'strategy', time: '14:30' }, late);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lastSent.strategy, '2026-11-16');
});
