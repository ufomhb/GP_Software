/**
 * 模拟盘自动化接口测试（v2.12.0）
 * ---------------------------------------------------------
 * 走隔离实例（临时目录 + 随机端口），验证：
 * 后台费率 / 规则 / 委托有效期、限价委托与撤单、T+1 开关的实际效果、
 * 条件单、网格 / 定投、跟单、持仓预警、复盘、分红除权、更新履历拆分。
 *
 * 涉及实时行情的用例取不到行情时跳过（不把网络当测试前提）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers/app.mjs';

async function withUsers(fn, { count = 1 } = {}) {
  const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
  const clients = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const c = app.client();
      const r = await c.post('/api/auth/register', { username: `papi${i}`, password: `papi-pw-${i}00` });
      assert.ok([200, 201].includes(r.status), `注册失败：${r.status} ${JSON.stringify(r.body)}`);
      clients.push(c);
    }
    return await fn(clients[0], clients, app);
  } finally {
    await app.stop();
  }
}

/** 取不到实时行情时给一个明确的跳过原因（返回 null 表示跳过） */
async function liveQuote(c, secid = '1.600519') {
  const r = await c.get(`/api/quotes?secids=${encodeURIComponent(secid)}`);
  const q = (r.body && r.body.items || [])[0];
  if (!q || !(Number(q.price) > 0) || (q.priceMode && q.priceMode !== 'live')) return null;
  return q;
}

/* ---------------- 后台配置：费率 / 规则 / 委托有效期 ---------------- */

test('后台配置：费率、T+1/涨跌停/停牌开关、委托有效期都能读回并被夹取', async () => {
  await withUsers(async (admin) => {
    const set = await admin.post('/api/admin/paper/config', {
      fees: { rate: 0.0003, min: 6, taxRate: 0.0006, slippageBps: 8 },
      trading: { t1: false, limitCheck: true, suspend: false },
      order: { validDays: 3 },
    });
    assert.equal(set.status, 200);
    assert.equal(set.body.config.fees.rate, 0.0003);
    assert.equal(set.body.config.fees.slippageBps, 8);
    assert.equal(set.body.config.trading.t1, false);
    assert.equal(set.body.config.trading.suspend, false);
    assert.equal(set.body.config.trading.limitCheck, true);
    assert.equal(set.body.config.order.validDays, 3);

    // 越界值夹取
    const clamp = await admin.post('/api/admin/paper/config', {
      fees: { rate: 0.5, min: -3, taxRate: 9, slippageBps: 9999 },
      order: { validDays: 99 },
    });
    assert.equal(clamp.status, 200);
    assert.equal(clamp.body.config.fees.rate, 0.01);
    assert.equal(clamp.body.config.fees.min, 0);
    assert.equal(clamp.body.config.fees.taxRate, 0.02);
    assert.equal(clamp.body.config.fees.slippageBps, 100);
    assert.equal(clamp.body.config.order.validDays, 30);

    // 客户端能拿到 rules（旧字段兼容 + 新字段）
    const paper = await admin.get('/api/paper');
    assert.equal(paper.status, 200);
    assert.ok(Number.isFinite(paper.body.rules.feeRate));
    assert.ok(paper.body.rules.fees && paper.body.rules.trading && paper.body.rules.order);
    assert.ok(Array.isArray(paper.body.orders));
    assert.ok(Array.isArray(paper.body.conditions));
    assert.ok(Array.isArray(paper.body.plans));
    assert.ok(paper.body.periods && 'todayPct' in paper.body.periods);
    assert.equal(paper.body.rules.order.validDays, 30);
  });
});

/* ---------------- 限价委托 / 撤单 / 部分成交 ---------------- */

test('限价委托：挂单 → 出现在委托列表 → 撤单成功（无行情则跳过）', async (t) => {
  await withUsers(async (c) => {
    const q = await liveQuote(c);
    if (!q) { t.diagnostic('跳过：需要实时行情'); return; }
    const limitPrice = Math.max(0.01, Math.round(Number(q.price) * 0.5 * 100) / 100);
    const place = await c.post('/api/paper/trade', {
      secid: '1.600519', side: 'buy', orderType: 'limit', limitPrice, shares: 100, validDays: 1,
    });
    if (place.status !== 200) { t.diagnostic(`跳过：下单返回 ${place.status} ${JSON.stringify(place.body)}`); return; }
    assert.equal(place.body.pending, true, '远低于现价的限价单应当挂着');
    assert.equal(place.body.order.status, 'pending');
    assert.equal(place.body.order.limitPrice, limitPrice);
    assert.ok(place.body.order.expiresAt > Date.now(), '到期时间应在未来');

    const paper = await c.get('/api/paper');
    const order = paper.body.orders.find((o) => o.id === place.body.order.id);
    assert.ok(order, '委托应出现在列表里');
    assert.equal(order.canCancel, true);
    assert.equal(order.remainingShares, 100);

    const cancel = await c.post('/api/paper/order/cancel', { orderId: place.body.order.id });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.order.status, 'cancelled');
    const again = await c.post('/api/paper/order/cancel', { orderId: place.body.order.id });
    assert.equal(again.status, 400, '已结束的委托不能重复撤单');
    const missing = await c.post('/api/paper/order/cancel', { orderId: 'not-exist' });
    assert.equal(missing.status, 404);
  });
});

test('限价委托：卖价高于现价时挂着不成交；限价超出涨停价被拒（无行情则跳过）', async (t) => {
  await withUsers(async (c) => {
    const q = await liveQuote(c);
    if (!q) { t.diagnostic('跳过：需要实时行情'); return; }
    // 先用市价买 100 股（T+1 关掉，后面才有持仓可卖）
    await c.post('/api/admin/paper/config', { trading: { t1: false } });
    const buy = await c.post('/api/paper/trade', { secid: '1.600519', side: 'buy', shares: 100 });
    if (buy.status !== 200) { t.diagnostic(`跳过：买入返回 ${buy.status}`); return; }
    const sellLimit = Math.round(Number(q.price) * 1.5 * 100) / 100;
    const sell = await c.post('/api/paper/trade', {
      secid: '1.600519', side: 'sell', orderType: 'limit', limitPrice: sellLimit, shares: 100,
    });
    assert.equal(sell.status, 200);
    assert.equal(sell.body.pending, true, '高于现价的卖出限价单应挂着');
    assert.equal(sell.body.trade, null);

    // 涨停价校验：买入限价设成明显高于涨停价 → 400
    const prevClose = Number(q.prevClose);
    if (prevClose > 0) {
      const over = await c.post('/api/paper/trade', {
        secid: '1.600519', side: 'buy', orderType: 'limit', limitPrice: prevClose * 3, shares: 100,
      });
      assert.equal(over.status, 400);
      assert.match(String(JSON.stringify(over.body)), /涨停价/);
    }
  });
});

/* ---------------- T+1 强校验 ---------------- */

test('T+1：默认开，当日买入当日卖出被拒；关掉后可以卖（无行情则跳过）', async (t) => {
  await withUsers(async (c) => {
    const q = await liveQuote(c);
    if (!q) { t.diagnostic('跳过：需要实时行情'); return; }
    const buy = await c.post('/api/paper/trade', { secid: '1.600519', side: 'buy', shares: 100 });
    if (buy.status !== 200) { t.diagnostic(`跳过：买入返回 ${buy.status}`); return; }
    const pos = buy.body.account.positions.find((p) => p.secid === '1.600519');
    assert.equal(pos.available, 0, '当日买入的可卖应为 0');
    assert.equal(pos.locked, 100);
    assert.ok(pos.limitUp > 0, '应带涨停价');

    const blocked = await c.post('/api/paper/trade', { secid: '1.600519', side: 'sell', shares: 100 });
    assert.equal(blocked.status, 400);
    assert.match(String(JSON.stringify(blocked.body)), /T\+1/);

    await c.post('/api/admin/paper/config', { trading: { t1: false } });
    const ok = await c.post('/api/paper/trade', { secid: '1.600519', side: 'sell', shares: 100 });
    assert.equal(ok.status, 200, '关掉 T+1 后可以当日卖出');
    assert.equal(ok.body.account.positions.length, 0);
  });
});

/* ---------------- 条件单 ---------------- */

test('条件单：价格条件能新增/取消，止盈止损没持仓被拒，非法值被拒', async () => {
  await withUsers(async (c) => {
    const add = await c.post('/api/paper/condition', {
      secid: '1.600519', code: '600519', name: '贵州茅台', kind: 'priceBelow', value: 1, side: 'buy', shares: 100,
    });
    assert.equal(add.status, 200);
    assert.equal(add.body.condition.status, 'active');
    const list = (await c.get('/api/paper')).body.conditions;
    assert.equal(list.filter((x) => x.status === 'active').length, 1);

    const cancel = await c.post('/api/paper/condition/cancel', { id: add.body.condition.id });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.conditions.find((x) => x.id === add.body.condition.id).status, 'cancelled');
    const missing = await c.post('/api/paper/condition/cancel', { id: 'nope' });
    assert.equal(missing.status, 404);

    // 没有持仓不能挂止盈止损
    const tp = await c.post('/api/paper/condition', {
      secid: '1.600519', kind: 'takeProfit', value: 8, side: 'sell',
    });
    assert.equal(tp.status, 400);
    assert.match(String(JSON.stringify(tp.body)), /持有/);

    // 触发值非法
    const bad = await c.post('/api/paper/condition', {
      secid: '1.600519', kind: 'priceAbove', value: 0,
    });
    assert.equal(bad.status, 400);
    // 非法标的
    const bad2 = await c.post('/api/paper/condition', { secid: 'xx', kind: 'priceAbove', value: 10 });
    assert.equal(bad2.status, 400);
  });
});

/* ---------------- 网格 / 定投 ---------------- */

test('网格与定投：创建、暂停/启用、删除；非法参数被拒', async () => {
  await withUsers(async (c) => {
    const grid = await c.post('/api/paper/plan', {
      kind: 'grid', secid: '1.600519', code: '600519', name: '贵州茅台',
      lower: 1000, upper: 2000, grids: 5, sharesPerGrid: 100,
    });
    assert.equal(grid.status, 200);
    assert.deepEqual(grid.body.plan.levels, [1000, 1200, 1400, 1600, 1800, 2000]);
    const dca = await c.post('/api/paper/plan', {
      kind: 'dca', secid: '1.600519', amount: 5000, freq: 'weekly', weekday: 3,
    });
    assert.equal(dca.status, 200);
    assert.match(String(dca.body.plan.nextDateKey), /^\d{4}-\d{2}-\d{2}$/);

    const plans = (await c.get('/api/paper')).body.plans;
    assert.equal(plans.length, 2);
    assert.equal(plans[0].kind, 'grid');
    assert.ok(Array.isArray(plans[0].levels), '网格要带档位给前端画图');

    const paused = await c.post('/api/paper/plan/update', { id: grid.body.plan.id, status: 'paused' });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.plans.find((p) => p.id === grid.body.plan.id).status, 'paused');
    const resumed = await c.post('/api/paper/plan/update', { id: grid.body.plan.id, status: 'active' });
    assert.equal(resumed.status, 200);

    const del = await c.post('/api/paper/plan/delete', { id: dca.body.plan.id });
    assert.equal(del.status, 200);
    assert.equal((await c.get('/api/paper')).body.plans.length, 1);
    const delMissing = await c.post('/api/paper/plan/delete', { id: 'nope' });
    assert.equal(delMissing.status, 404);

    // 下界不小于上界 / 每期金额太小 / 非法标的
    assert.equal((await c.post('/api/paper/plan', { kind: 'grid', secid: '1.600519', lower: 20, upper: 10, sharesPerGrid: 100 })).status, 400);
    assert.equal((await c.post('/api/paper/plan', { kind: 'dca', secid: '1.600519', amount: 100 })).status, 400);
    assert.equal((await c.post('/api/paper/plan', { kind: 'grid', secid: 'bad', lower: 1, upper: 2, sharesPerGrid: 100 })).status, 400);
  });
});

/* ---------------- 跟单 ---------------- */

test('跟单：A 跟 B → 双向订阅；不能跟自己；重复跟单 409；取消后两边都清理', async () => {
  await withUsers(async (a, clients) => {
    const b = clients[1];
    const f1 = await a.post('/api/paper/follow', { username: 'papi1', ratio: 0.5 });
    assert.equal(f1.status, 200);
    assert.equal(f1.body.following.length, 1);
    assert.equal(f1.body.following[0].ratio, 0.5);

    const mine = await a.get('/api/paper');
    assert.equal(mine.body.following.length, 1);
    const theirs = await b.get('/api/paper');
    assert.equal(theirs.body.followers.length, 1, '被跟单人应看到订阅者');
    assert.equal(theirs.body.followers[0].target, 'papi0');

    assert.equal((await a.post('/api/paper/follow', { username: 'papi0' })).status, 400, '不能跟自己');
    assert.equal((await a.post('/api/paper/follow', { username: 'papi1' })).status, 409, '重复跟单');
    assert.equal((await a.post('/api/paper/follow', { username: 'nobody' })).status, 404);

    // 对方关掉跟单权限 → 403
    await b.post('/api/paper/follow/allow', { allow: false });
    assert.equal((await a.post('/api/paper/unfollow', { username: 'papi1' })).status, 200);
    const denied = await a.post('/api/paper/follow', { username: 'papi1' });
    assert.equal(denied.status, 403);
    assert.equal((await b.get('/api/paper')).body.allowFollow, false);
    assert.equal((await b.get('/api/paper')).body.followers.length, 0, '取消跟单后订阅者被清掉');
  }, { count: 2 });
});

/* ---------------- 持仓条件预警 ---------------- */

test('持仓预警：存在独立的 paper_alerts 盒子里，与自选股预警互不覆盖', async () => {
  await withUsers(async (c) => {
    const post = await c.post('/api/paper/alerts', {
      enabled: true,
      items: [
        { id: 'pa1', secid: '1.600519', code: '600519', name: '贵州茅台', kind: 'holdingPct', op: 'above', value: 8 },
        { id: 'pa2', kind: 'accountPct', op: 'below', value: -10 },
        { id: 'bad', secid: '', kind: 'holdingPct', op: 'above', value: 'x' },
      ],
    });
    assert.equal(post.status, 200);
    assert.equal(post.body.items.length, 2, '非法规则被丢弃');
    assert.equal(post.body.items[0].scope, 'paper');

    const read = await c.get('/api/paper/alerts');
    assert.equal(read.body.enabled, true);
    assert.equal(read.body.items.length, 2);
    // 账户级规则允许没有 secid
    assert.equal(read.body.items.find((x) => x.id === 'pa2').secid, '');

    // 自选股预警仍是空的（两套不混）
    const stock = await c.get('/api/alerts');
    assert.equal(stock.body.enabled, false);
    assert.deepEqual(stock.body.items, []);
  });
});

/* ---------------- 复盘 ---------------- */

test('复盘：没有成交时指标为空但接口可用；字段齐全', async () => {
  await withUsers(async (c) => {
    const r = await c.get('/api/paper/review');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    for (const key of ['winRate', 'payoffRatio', 'profitFactor', 'mdd', 'topWeight', 'hhi', 'trades', 'realizedTotal', 'curve', 'totalPct']) {
      assert.ok(key in r.body, `缺少字段 ${key}`);
    }
    assert.equal(r.body.trades, 0);
    assert.equal(r.body.winRate, null, '没有卖出不给 0%');
    assert.ok(Array.isArray(r.body.curve));
    // 排行榜详情也带复盘摘要
    const det = await c.get('/api/paper/ranking/detail?username=papi0');
    assert.equal(det.status, 200);
    assert.ok(det.body.review && det.body.periods);
  });
});

/* ---------------- 分红除权 ---------------- */

test('分红除权：管理员新增 / 列表 / 重复 409 / 删除 / 非法参数', async () => {
  await withUsers(async (admin) => {
    const add = await admin.post('/api/admin/paper/dividends', {
      secid: '1.600519', code: '600519', name: '贵州茅台', exDate: '2026-11-20', cashPerShare: 2.5, shareRatio: 0,
    });
    assert.equal(add.status, 200);
    assert.equal(add.body.events.length, 1);
    assert.equal(add.body.events[0].cashPerShare, 2.5);

    const dup = await admin.post('/api/admin/paper/dividends', {
      secid: '1.600519', code: '600519', exDate: '2026-11-20', cashPerShare: 3,
    });
    assert.equal(dup.status, 409);

    const adminPaper = await admin.get('/api/admin/paper');
    assert.equal(adminPaper.body.corporateEvents.length, 1);
    assert.equal(adminPaper.body.totals.corporate, 1);

    // 分红和送转都为 0 → 400；缺除权日 → 400
    assert.equal((await admin.post('/api/admin/paper/dividends', { secid: '1.600519', exDate: '2026-11-20', cashPerShare: 0, shareRatio: 0 })).status, 400);
    assert.equal((await admin.post('/api/admin/paper/dividends', { secid: '1.600519', cashPerShare: 2 })).status, 400);

    const del = await admin.post('/api/admin/paper/dividends/remove', { id: add.body.events[0].id });
    assert.equal(del.status, 200);
    assert.equal(del.body.events.length, 0);
  });
});

/* ---------------- 撮合 tick（手动触发） ---------------- */

test('撮合：手动触发 /api/paper/sweep 返回结构正常；权益快照随账户写入', async () => {
  await withUsers(async (c) => {
    const sweep = await c.post('/api/paper/sweep', {});
    assert.equal(sweep.status, 200);
    assert.equal(sweep.body.ok, true);
    assert.equal(typeof sweep.body.changed, 'boolean');
    const paper = await c.get('/api/paper');
    assert.ok(paper.body.periods.equityDays >= 0);
  });
});

/* ---------------- 排行榜周期字段 ---------------- */

test('排行榜：带今日/本周/本月/今年收益率与回撤，且不新增敏感字段', async () => {
  await withUsers(async (c) => {
    const rank = await c.get('/api/paper/ranking');
    assert.equal(rank.status, 200);
    const item = rank.body.items[0];
    for (const key of ['todayPct', 'weekPct', 'monthPct', 'yearPct', 'totalPct', 'mdd', 'equityDays']) {
      assert.ok(key in item, `排行榜缺少 ${key}`);
    }
    assert.ok(!('userId' in item) && !('hash' in item));
  }, { count: 2 });
});

/* ---------------- 更新履历拆分 ---------------- */

test('更新履历：客户端拿简化版，后台拿完整明细；老版本按关键词自动过滤', async () => {
  const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
  try {
    // 直接往实例的 data/ 写一份履历（真实仓库里那份不参与测试）
    writeFileSync(join(app.dataDir, 'changelog.json'), JSON.stringify([
      {
        version: '9.9.9',
        date: '2026-11-24',
        title: '测试版本',
        clientItems: ['用户能用的新功能 A', '界面优化 B'],
        items: ['server.js 里改了 paperTrade 的校验顺序', '新增单元测试 12 项', '部署到 NAS 时同步 changelog'],
      },
      {
        version: '9.9.8',
        date: '2026-11-20',
        title: '老版本',
        items: [
          '模拟交易新增「个股累计收益」面板：卖出后能看到累计金额与收益率',
          '服务端 paper-ledger.js 新增 realized 字段与回填逻辑',
          '测试：新增 15 项单元测试，npm test 331 项全过',
          '说明：版本号 2.11.0；只在本机 8090 验证，未推 NAS',
        ],
      },
    ], null, 2));
    const c = app.client();
    await c.post('/api/auth/register', { username: 'cltest', password: 'cl-pw-111' });
    const r = await c.get('/api/changelog');
    assert.equal(r.status, 200);
    assert.equal(r.body.versions.length, 2);
    assert.equal(r.body.clientVersions.length, 2);

    // 手写 clientItems 的版本：原样使用
    assert.deepEqual(r.body.clientVersions[0].items, ['用户能用的新功能 A', '界面优化 B']);
    assert.equal(r.body.versions[0].clientItems.length, 2);

    // 老版本没有 clientItems：技术条目被过滤掉，只留用户能感知的那条
    const legacy = r.body.clientVersions[1];
    assert.equal(legacy.items.length, 1, '3 条技术细节应被过滤');
    assert.match(legacy.items[0], /个股累计收益/);
    // 后台明细仍然完整
    assert.equal(r.body.versions[1].items.length, 4);
  } finally {
    await app.stop();
  }
});
