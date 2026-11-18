/**
 * 数据中心取数层（lib/datacenter.js）的纯函数与字段口径测试（v2.7.0 新增）
 *
 * 分两类：
 *   1. 纯函数（席位归一化、时区日期）—— 必跑；
 *   2. 真实上报（新股/转债申购日历、席位明细）—— 上游不可达时 skip，
 *      不把网络问题当成代码问题（接口级行为另由 routes.test.mjs 覆盖分发）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dc = require('../lib/datacenter.js');
const { normSeatRow, todayText } = dc._internals;

/* ---------------- 席位归一化 ---------------- */

test('席位：只有买入的一侧，净额 = 买入', () => {
  const s = normSeatRow({ OPERATEDEPT_NAME: '国泰海通证券股份有限公司长宁区江苏路证券营业部', BUY: 27425613.44, SELL: null });
  assert.equal(s.dept, '国泰海通证券股份有限公司长宁区江苏路证券营业部');
  assert.equal(s.buyYi, 0.27);
  assert.equal(s.sellYi, null);
  assert.equal(s.netYi, 0.27);
  assert.equal(s.isOrg, false);
  assert.equal(s.isNorth, false);
});

test('席位：只有卖出的一侧，净额为负', () => {
  const s = normSeatRow({ OPERATEDEPT_NAME: '某某证券营业部', BUY: null, SELL: 150000000 });
  assert.equal(s.netYi, -1.5);
  assert.equal(s.buyYi, null);
});

test('席位：买卖都有时净额 = 买 - 卖', () => {
  const s = normSeatRow({ OPERATEDEPT_NAME: '机构专用', BUY: 200000000, SELL: 75000000 });
  assert.equal(s.buyYi, 2);
  assert.equal(s.sellYi, 0.75);
  assert.equal(s.netYi, 1.25);
  assert.equal(s.isOrg, true, '「机构专用」要识别成机构席位');
});

test('席位：沪深股通与「机构」分类要分别打标（科创板披露的是投资者分类）', () => {
  assert.deepEqual(
    ['沪股通专用', '深股通专用', '机构', '中小投资者', '其他自然人']
      .map((dept) => {
        const s = normSeatRow({ OPERATEDEPT_NAME: dept, BUY: 100, SELL: null });
        return [s.isOrg, s.isNorth];
      }),
    [[false, true], [false, true], [true, false], [false, false], [false, false]],
  );
});

test('席位：缺名称或全空值不会产生脏数据', () => {
  const s = normSeatRow({ BUY: null, SELL: null });
  assert.equal(s.dept, '');
  assert.equal(s.netYi, null);
});

/* ---------------- 时区日期 ---------------- */

test('todayText：返回 YYYY-MM-DD，且按东八区取「今天」', () => {
  const t = todayText();
  assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
  // 直接比较：东八区日期应当与 UTC 日期相等或晚一天（UTC 16:00 之后即为第二天）
  const utc = new Date().toISOString().slice(0, 10);
  assert.ok(t === utc || t > utc, `东八区日期(${t})不应早于 UTC 日期(${utc})`);
});

/* ---------------- 真实上报（网络不可用时跳过） ---------------- */

test('日历：新股申购能取到字段完整的条目，且申购日不早于 since', async (t) => {
  let data;
  try {
    data = await dc.calendarIpo({ limit: 5 });
  } catch (err) {
    t.skip(`东财数据中心不可达：${err.message}`);
    return;
  }
  assert.ok(Array.isArray(data.items), 'items 应为数组');
  assert.match(data.since, /^\d{4}-\d{2}-\d{2}$/, '应带 since 供前端展示');
  for (const x of data.items) {
    assert.match(x.code, /^\d{6}$/, `股票代码异常：${x.code}`);
    assert.ok(x.name, '缺少股票名称');
    assert.match(x.applyDate, /^\d{4}-\d{2}-\d{2}$/, '缺少申购日');
    assert.ok(x.applyDate >= data.since, `申购日 ${x.applyDate} 早于 ${data.since}`);
    // 未定价时必须保持 null（前端显示「待定」），不能拿预测价冒充发行价
    assert.ok(x.issuePrice === null || typeof x.issuePrice === 'number');
  }
});

test('日历：转债申购与可转债看板同源，字段可渲染', async (t) => {
  let data;
  try {
    data = await dc.calendarCbApply({ limit: 5 });
  } catch (err) {
    t.skip(`东财数据中心不可达：${err.message}`);
    return;
  }
  assert.ok(Array.isArray(data.items));
  for (const x of data.items) {
    assert.match(x.code, /^\d{6}$/);
    assert.match(x.applyDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(x.applyDate >= data.since);
    assert.equal(typeof x.name, 'string');
  }
});

test('席位明细：按上榜日分组，机构净额与分组内净额一致', async (t) => {
  let data;
  try {
    // 600519 历史上有过机构专用席位上榜，样本稳定
    data = await dc.longhuSeats('600519', { limit: 60 });
  } catch (err) {
    t.skip(`东财数据中心不可达：${err.message}`);
    return;
  }
  assert.ok(Array.isArray(data.items));
  const dates = data.items.map((g) => g.date);
  assert.deepEqual(dates, [...dates].sort((a, b) => (a < b ? 1 : -1)), '应按上榜日倒序');
  for (const g of data.items) {
    assert.match(g.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(g.seats.length > 0, '每个上榜日至少一个席位');
    for (const s of g.seats) {
      assert.ok(s.dept, '席位名不能为空');
      assert.ok(s.buyYi !== null || s.sellYi !== null, '买卖至少有一边有值');
      assert.equal(s.netYi, Math.round(((s.buyYi || 0) - (s.sellYi || 0)) * 100) / 100);
    }
    const orgSeats = g.seats.filter((s) => s.isOrg);
    if (orgSeats.length) {
      const sum = Math.round(orgSeats.reduce((n, s) => n + (s.netYi || 0), 0) * 100) / 100;
      assert.equal(g.orgNetYi, sum, '机构净额应是机构席位净额之和');
    } else {
      assert.equal(g.orgNetYi, null, '没有机构席位时机构净额应为 null');
    }
  }
});
