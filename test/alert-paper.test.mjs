/**
 * 服务端预警（2.4）与模拟交易（3.3）的接口级测试
 *
 * 用隔离实例（临时目录 + 随机端口）跑真实的 HTTP 流程，不碰仓库 data/。
 * 约定：涉及实时行情的用例（买入成交）在取不到行情时跳过，而不是把测试判红——
 * 这两块的核心是"规则存储 / 校验 / 账本记账"，不应该被上游网络绑死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.mjs';

async function withApp(fn) {
  const app = await startApp();
  const c = app.client();
  try {
    const r = await c.req('/api/auth/register', {
      method: 'POST',
      json: { username: 'alertpaper', password: 'alert-paper-pw-1' },
    });
    assert.ok([200, 201].includes(r.status), `注册失败：${r.status} ${JSON.stringify(r.body)}`);
    return await fn(c);
  } finally {
    await app.stop();
  }
}

/* ---------------- 2.4 服务端预警 ---------------- */

test('预警：默认关闭，POST 后能读回，非法规则被丢弃', async () => {
  await withApp(async (c) => {
    const before = await c.req('/api/alerts');
    assert.equal(before.status, 200);
    assert.equal(before.body.enabled, false, '默认不开云端预警');
    assert.deepEqual(before.body.items, []);

    const saved = await c.req('/api/alerts', {
      method: 'POST',
      json: {
        enabled: true,
        items: [
          { id: 'a1', secid: '1.600519', code: '600519', name: '贵州茅台', kind: 'price', op: 'above', value: 1600 },
          { id: 'bad1', secid: '', kind: 'price', op: 'above', value: 1 },
          { id: 'a2', secid: '0.000001', code: '000001', name: '平安银行', kind: 'price', op: 'above', value: 'abc' },
        ],
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.enabled, true);
    assert.equal(saved.body.items.length, 1, '只有合法规则被接受');
    assert.equal(saved.body.items[0].kind, 'price');
    assert.equal(saved.body.items[0].value, 1600);

    const read = await c.req('/api/alerts');
    assert.equal(read.body.enabled, true);
    assert.equal(read.body.items.length, 1);
    assert.equal(read.body.items[0].id, 'a1');
  });
});

test('预警：v1 的 {type,price} 结构在服务端也会被迁移成 v2', async () => {
  await withApp(async (c) => {
    const saved = await c.req('/api/alerts', {
      method: 'POST',
      json: { enabled: true, items: [{ id: 'old', secid: '1.600519', code: '600519', name: '贵州茅台', type: 'below', price: 1500 }] },
    });
    assert.equal(saved.status, 200);
    const item = saved.body.items[0];
    assert.equal(item.kind, 'price', 'type 应映射成 kind');
    assert.equal(item.op, 'below');
    assert.equal(item.value, 1500);
  });
});

test('预警：趋势类规则不存数值，非法 kind 回落成价格规则', async () => {
  await withApp(async (c) => {
    const saved = await c.req('/api/alerts', {
      method: 'POST',
      json: {
        enabled: true,
        items: [
          { id: 'm1', secid: '1.600519', code: '600519', name: '茅台', kind: 'macd', op: 'above', value: 999 },
          // 未知 kind 但没有 price：没有可判定的数值，只能丢弃
          { id: 'x0', secid: '1.600519', code: '600519', name: '茅台', kind: 'rsi', op: 'above', value: 70 },
          // 未知 kind 但带了 v1 的 price：按价格规则接住
          { id: 'x1', secid: '1.600519', code: '600519', name: '茅台', kind: 'rsi', op: 'above', price: 1600 },
        ],
      },
    });
    assert.equal(saved.status, 200);
    const macd = saved.body.items.find((x) => x.id === 'm1');
    assert.equal(macd.kind, 'macd');
    assert.equal(macd.value, null, '趋势类没有数值');
    assert.equal(macd.op, 'golden', 'above 在趋势类里归一成金叉');
    assert.equal(saved.body.items.find((x) => x.id === 'x0'), undefined, '没有数值的未知规则应被丢弃');
    const unknown = saved.body.items.find((x) => x.id === 'x1');
    assert.equal(unknown.kind, 'price', '带 price 的未知 kind 回落价格规则');
    assert.equal(unknown.value, 1600);
  });
});

test('预警：未登录不能写规则，读也要 401', async () => {
  const app = await startApp();
  try {
    const c = app.client(); // 不注册，无会话
    const r = await c.req('/api/alerts', { method: 'POST', json: { enabled: true, items: [] } });
    assert.equal(r.status, 401);
    const read = await c.req('/api/alerts');
    assert.equal(read.status, 401, '全局鉴权会挡住匿名读');
    assert.equal(read.body.needAuth, true);
  } finally {
    await app.stop();
  }
});

/* ---------------- 3.3 模拟交易 ---------------- */

test('模拟交易：初始 100 万、空仓、无成交', async () => {
  await withApp(async (c) => {
    const r = await c.req('/api/paper');
    assert.equal(r.status, 200);
    assert.equal(r.body.initial, 1000000);
    assert.equal(r.body.cash, 1000000);
    assert.equal(r.body.total, 1000000);
    assert.deepEqual(r.body.positions, []);
    assert.deepEqual(r.body.trades, []);
    assert.equal(r.body.profit, 0);
  });
});

test('模拟交易：股数校验在取行情之前就拦下（不依赖网络）', async () => {
  await withApp(async (c) => {
    const bad1 = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'buy', shares: 150 } });
    assert.equal(bad1.status, 400, 'A 股必须 100 股整数倍');
    assert.match(String(JSON.stringify(bad1.body)), /100/);

    const bad2 = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'buy', shares: 0 } });
    assert.equal(bad2.status, 400);

    const bad3 = await c.req('/api/paper/trade', { method: 'POST', json: { secid: 'not-a-secid', side: 'buy', shares: 100 } });
    assert.equal(bad3.status, 400, '标的不合法要拒绝');

    const sell = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'sell', shares: 100 } });
    assert.equal(sell.status, 400, '空仓不能卖');
  });
});

test('模拟交易：重置账户清空持仓与成交', async () => {
  await withApp(async (c) => {
    const r = await c.req('/api/paper/reset', { method: 'POST', json: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.initial, 1000000);
    const after = await c.req('/api/paper');
    assert.equal(after.body.cash, 1000000);
    assert.deepEqual(after.body.positions, []);
  });
});

test('模拟交易：能拿到行情时买入会扣钱建仓，卖出后仓位归零', async (t) => {
  await withApp(async (c) => {
    const buy = await c.req('/api/paper/trade', {
      method: 'POST',
      json: { secid: '1.600519', side: 'buy', shares: 100, note: '测试买入' },
    });
    if (buy.status !== 200) {
      // 离线/上游不可达时不判红：这块的真实约束是账本记账，不是行情可用性
      t.diagnostic(`跳过：买入需要实时行情（${buy.status} ${JSON.stringify(buy.body)}）`);
      return;
    }
    const acc = buy.body.account;
    assert.equal(acc.positions.length, 1, '应有 1 个持仓');
    assert.equal(acc.positions[0].shares, 100);
    assert.ok(acc.cash < 1000000, '买入后现金减少');
    assert.equal(acc.trades.length, 1, '应记录 1 笔成交');
    assert.equal(acc.trades[0].side, 'buy');
    assert.equal(acc.trades[0].note, '测试买入');
    assert.ok(acc.trades[0].fee > 0, '成交要有费用');
    // 信号留痕：成交时若有大盘评分就带上
    if (acc.trades[0].signal) assert.ok(Number.isFinite(Number(acc.trades[0].signal.score)));

    const sell = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'sell', shares: 100 } });
    assert.equal(sell.status, 200, '持仓足够应能卖出');
    const after = sell.body.account;
    assert.equal(after.positions.length, 0, '清仓后没有持仓');
    assert.equal(after.trades.length, 2, '两笔成交');
    assert.ok(after.cash > 0);
  });
});

test('模拟交易：未登录不能下单', async () => {
  const app = await startApp();
  try {
    const c = app.client();
    const r = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'buy', shares: 100 } });
    assert.equal(r.status, 401);
    const get = await c.req('/api/paper');
    assert.equal(get.status, 401);
  } finally {
    await app.stop();
  }
});

/* ---------------- 3.6 个股资讯 ---------------- */

test('个股资讯：缺代码时明确报错', async () => {
  await withApp(async (c) => {
    const r = await c.req('/api/stock/news');
    assert.equal(r.status, 400, '没给 code 应当是 400');
  });
});

test('个股资讯：能取到时返回带 url 的条目，取不到也不 500', async (t) => {
  await withApp(async (c) => {
    const r = await c.req('/api/stock/news?code=600519&limit=3');
    if (r.status !== 200) {
      t.diagnostic(`跳过：资讯源不可达（${r.status}）`);
      return;
    }
    assert.ok(Array.isArray(r.body.items));
    for (const item of r.body.items) {
      assert.ok(item.title, '条目要有标题');
      assert.match(item.url, /^https?:\/\//, 'URL 必须是 http(s)，前端还要再过 safeUrl');
    }
  });
});

/* ---------------- 3.4 模拟账户排行榜（v2.8.0） ---------------- */

test('排行榜：未登录 401', async () => {
  await withApp(async (c) => {
    const anon = await c.req('/api/paper/ranking', { cookie: '' });
    assert.equal(anon.status, 401);
  });
});

test('排行榜：本系统所有账号互相可见，且不透出账号 ID', async (t) => {
  const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
  t.after(() => app.stop());
  const a = app.client();
  const regA = await a.post('/api/auth/register', { username: 'paperA', password: 'paper-pw-111' });
  assert.equal(regA.status, 200);
  const b = app.client();
  const regB = await b.post('/api/auth/register', { username: 'paperB', password: 'paper-pw-222' });
  assert.equal(regB.status, 200);

  // A 尝试下一笔（行情取不到就只验证账户结构，排行榜仍应存在）
  const buy = await a.post('/api/paper/trade', { secid: '1.600519', side: 'buy', shares: 100 });
  assert.ok([200, 400].includes(buy.status), `下单返回 ${buy.status}`);

  const rank = await b.get('/api/paper/ranking');
  assert.equal(rank.status, 200);
  assert.equal(rank.body.ok, true);
  assert.equal(rank.body.items.length, 2, '两个账号都应在榜上');
  assert.deepEqual(rank.body.items.map((x) => x.username).sort(), ['paperA', 'paperB']);
  for (const item of rank.body.items) {
    assert.ok(!('userId' in item), '排行榜不应透出 userId');
    assert.ok(Number.isFinite(item.total), '总资产应为数字');
    assert.ok(Number.isInteger(item.rank) && item.rank >= 1);
    assert.ok(Array.isArray(item.positions));
    assert.ok(Number.isFinite(item.profitPct));
  }
  assert.equal(rank.body.items[0].rank, 1);
  assert.ok(rank.body.items[0].total >= rank.body.items[1].total, '默认按总资产降序');
});

/* ---------------- v2.9.0 模拟盘：比例下单 / 后台控制 ---------------- */

test('模拟交易：比例参数非法时在取行情之前就拒绝', async () => {
  await withApp(async (c) => {
    const over = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'buy', ratio: 2 } });
    assert.equal(over.status, 400);
    assert.match(String(JSON.stringify(over.body)), /0~1/);

    const zero = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'buy', ratio: 0 } });
    assert.equal(zero.status, 400);

    const negative = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'buy', ratio: -0.5 } });
    assert.equal(negative.status, 400);

    // 空仓时按比例卖出：明确提示（或取不到行情），不能 500
    const sell = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'sell', ratio: 1 } });
    assert.equal(sell.status, 400);
    assert.match(String(JSON.stringify(sell.body)), /持仓|行情/);
  });
});

test('模拟交易：按比例买入成交在整手，按「全部」能一次卖光（无行情则跳过）', async (t) => {
  await withApp(async (c) => {
    const buy = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'buy', ratio: 0.25 } });
    if (buy.status !== 200) {
      t.diagnostic(`跳过：比例买入需要实时行情（${buy.status} ${JSON.stringify(buy.body)}）`);
      return;
    }
    const acc = buy.body.account;
    assert.equal(acc.positions.length, 1);
    assert.equal(acc.positions[0].shares % 100, 0, 'A 股按 100 股整手');
    assert.ok(acc.positions[0].shares > 0);
    assert.ok(acc.cash < 1000000, '买入后现金减少');
    assert.equal(buy.body.trade.ratio, 0.25, '成交记录保留比例，便于复盘');

    const sellAll = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'sell', ratio: 1 } });
    assert.equal(sellAll.status, 200, '「全部」卖出应成功');
    assert.equal(sellAll.body.account.positions.length, 0, '清仓后没有持仓');
  });
});

test('模拟交易：卖出零股只允许「全部」，部分卖出仍要求整手', async () => {
  await withApp(async (c) => {
    const partial = await c.req('/api/paper/trade', { method: 'POST', json: { secid: '1.600519', side: 'sell', shares: 150 } });
    assert.equal(partial.status, 400);
    assert.match(String(JSON.stringify(partial.body)), /100 股/);
  });
});

test('后台模拟盘：非管理员 403，管理员可改初始资金 / 按指定金额重置', async (t) => {
  const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
  t.after(() => app.stop());
  const admin = app.client();
  const regAdmin = await admin.post('/api/auth/register', { username: 'adminA', password: 'admin-pw-111' });
  assert.equal(regAdmin.status, 200);
  const user = app.client();
  const regUser = await user.post('/api/auth/register', { username: 'userB', password: 'user-pw-222' });
  assert.equal(regUser.status, 200);

  const deny = await user.get('/api/admin/paper');
  assert.equal(deny.status, 403, '普通用户不能看后台模拟盘');
  const denySet = await user.post('/api/admin/paper/config', { initial: 200000 });
  assert.equal(denySet.status, 403);

  const set = await admin.post('/api/admin/paper/config', { initial: 500000 });
  assert.equal(set.status, 200);
  assert.equal(set.body.config.initial, 500000);

  const list = await admin.get('/api/admin/paper');
  assert.equal(list.status, 200);
  assert.equal(list.body.config.initial, 500000);
  const u = (list.body.users || []).find((x) => x.username === 'userB');
  assert.ok(u, '后台列表应包含全部账号');
  assert.ok(Array.isArray(u.positions));
  assert.ok(!('hash' in u) && !('salt' in u), '后台列表不能透出密码字段');

  // 先按 50 万开一个账户，再把全局改成 70 万：已有账户必须保留自己的 50 万
  const open = await admin.post('/api/admin/paper/reset', { id: u.id });
  assert.equal(open.status, 200);
  assert.equal(open.body.initial, 500000);
  const bumped = await admin.post('/api/admin/paper/config', { initial: 700000 });
  assert.equal(bumped.body.config.initial, 700000);
  const list2 = await admin.get('/api/admin/paper');
  const u1 = list2.body.users.find((x) => x.username === 'userB');
  assert.equal(u1.initial, 500000, '已有账户保留原初始资金（改全局不改写历史盈亏）');

  const reset = await admin.post('/api/admin/paper/reset', { id: u.id, initial: 200000 });
  assert.equal(reset.status, 200);
  const after = await admin.get('/api/admin/paper');
  const u2 = after.body.users.find((x) => x.username === 'userB');
  assert.equal(u2.initial, 200000);
  assert.equal(u2.cash, 200000);

  // 夹取：太小 / 太大都落回边界
  const tooSmall = await admin.post('/api/admin/paper/config', { initial: 1 });
  assert.equal(tooSmall.body.config.initial, 10000);
  const tooBig = await admin.post('/api/admin/paper/config', { initial: 9e12 });
  assert.equal(tooBig.body.config.initial, 100000000);
  // 重置不存在的用户 → 404
  const missing = await admin.post('/api/admin/paper/reset', { id: 'u-not-exist' });
  assert.equal(missing.status, 404);
});

test('排行榜：黑名单用户不在榜上，但仍能自己交易；隐藏数一并返回', async (t) => {
  const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
  t.after(() => app.stop());
  const admin = app.client();
  await admin.post('/api/auth/register', { username: 'rankAdmin', password: 'rank-pw-111' });
  const other = app.client();
  await other.post('/api/auth/register', { username: 'rankHidden', password: 'rank-pw-222' });

  const before = await admin.get('/api/paper/ranking');
  assert.equal(before.status, 200);
  assert.equal(before.body.items.length, 2);
  assert.equal(before.body.hidden, 0);

  const list = await admin.get('/api/admin/paper');
  const target = list.body.users.find((x) => x.username === 'rankHidden');
  const patched = await admin.post('/api/admin/paper/config', { hiddenUserIds: [target.id] });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.config.hiddenUserIds, [target.id]);

  const after = await admin.get('/api/paper/ranking');
  assert.equal(after.body.items.length, 1, '隐藏后榜上只剩 1 个账号');
  assert.equal(after.body.items[0].username, 'rankAdmin');
  assert.equal(after.body.hidden, 1, '应返回被隐藏的账号数');

  // 被隐藏的用户仍可查看自己的账户并下单（只是不进排行榜）
  const own = await other.get('/api/paper');
  assert.equal(own.status, 200);
  assert.equal(own.body.initial, 1000000);

  // 取消隐藏 → 重新出现
  await admin.post('/api/admin/paper/config', { hiddenUserIds: [] });
  const back = await admin.get('/api/paper/ranking');
  assert.equal(back.body.items.length, 2);
});
