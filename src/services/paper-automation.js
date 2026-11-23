'use strict';
/**
 * 模拟盘自动化（v2.12.0）
 * ---------------------------------------------------------------
 * 纯逻辑：委托（限价/挂单/撤单/部分成交）、条件单（止盈止损）、
 * 网格、定投、公司行为（分红除权）、日终权益快照、周期收益与回撤、复盘指标。
 *
 * 这里同样不做 I/O、不取行情：server.js 负责取价与存取，
 * 账本记账复用 src/services/paper-ledger.js（唯一口径）。
 *
 * 设计取舍（都写进界面说明，避免"看起来像 bug"）：
 * - 挂单不冻结资金：成交那一刻才校验可用资金/可卖股数，钱不够就部分成交，
 *   剩下的留到到期或手动撤单 —— 和"冻结"相比不容易出现"撤单后钱回不来"；
 * - 撮合在服务端每分钟 tick + 用户打开页面时触发，不依赖前端常开；
 * - 网格/定投按"上海日期"推进，只做交易日，不做节假日日历（周末跳过）；
 * - 分红除权由管理员录入事件（data/paper-dividends.json），除权日入账，
 *   不猜、不自动编造数据。
 */

const L = require('./paper-ledger');

const {
  round2, round3, round4, roundPct, num, feeOf, taxOf, maxBuyShares, lotOf,
  shanghaiDateKey, normalizeFees, slippagePrice, availableShares,
} = L;

const PAPER_ORDER_ACTIVE_MAX = 30;
const PAPER_ORDER_HISTORY_KEEP = 60;
const PAPER_CONDITION_MAX = 24;
const PAPER_PLAN_MAX = 12;
const PAPER_EQUITY_KEEP = 1500;
const PAPER_CORPORATE_KEEP = 200;
const PAPER_FOLLOW_MAX = 5;
const CONDITION_KINDS = ['takeProfit', 'stopLoss', 'priceAbove', 'priceBelow'];
const PLAN_KINDS = ['grid', 'dca'];
const DCA_FREQS = ['daily', 'weekly', 'monthly'];
const ORDER_STATUSES = ['pending', 'partial', 'filled', 'cancelled', 'expired', 'rejected'];

/* ---------------- 上海日期工具（全部基于日期字符串，可单测） ---------------- */

function dateKeyOf(v) {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function dateAddDays(key, days) {
  const base = dateKeyOf(key);
  if (!base) return '';
  const ms = Date.UTC(
    Number(base.slice(0, 4)), Number(base.slice(5, 7)) - 1, Number(base.slice(8, 10)),
  ) + Number(days || 0) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0=周日 … 6=周六（按日期字符串，不受本机时区影响） */
function weekdayOf(key) {
  const base = dateKeyOf(key);
  if (!base) return -1;
  return new Date(`${base}T00:00:00Z`).getUTCDay();
}

function isWorkday(key) {
  const wd = weekdayOf(key);
  return wd >= 1 && wd <= 5;
}

function nextWorkday(key) {
  let k = dateKeyOf(key);
  for (let i = 0; i < 14 && k; i += 1) {
    if (isWorkday(k)) return k;
    k = dateAddDays(k, 1);
  }
  return k;
}

/** 每个交易日 15:00（东八区）委托到期；收盘后才下的单顺延到下一个交易日的 15:00 */
function expireAtOf(validDays, todayKey, now = Date.now()) {
  const days = Number.isFinite(Number(validDays)) && Number(validDays) >= 1
    ? Math.min(30, Math.floor(Number(validDays))) : 1;
  let key = dateAddDays(todayKey, days - 1);
  let at = Date.parse(`${key}T15:00:00+08:00`);
  let guard = 0;
  while (at <= Number(now) && guard < 10) {
    key = nextWorkday(dateAddDays(key, 1));
    at = Date.parse(`${key}T15:00:00+08:00`);
    guard += 1;
  }
  return at;
}

/* ---------------- 涨跌停 / 停牌强校验 ---------------- */

/**
 * 成交前置校验：停牌（无实时价）、涨停不买、跌停不卖。
 * ctx: { suspend: bool, limitCheck: bool, limitRatio: 0.1|0.2|0.05|… }
 */
function tradeGuard({ quote, side, ctx = {} } = {}) {
  const price = num(quote && quote.price);
  const priceMode = String((quote && quote.priceMode) || 'live');
  if (!(price > 0)) return { blocked: true, code: 'noPrice', message: '取不到最新价，稍后再试' };
  if (ctx.suspend !== false && priceMode !== 'live') {
    return { blocked: true, code: 'suspended', message: '停牌或未开盘：没有实时成交价，不能成交' };
  }
  if (ctx.limitCheck !== false) {
    const prevClose = num(quote && quote.prevClose);
    const ratio = num(ctx.limitRatio);
    if (prevClose > 0 && ratio > 0) {
      const up = round2(prevClose * (1 + ratio));
      const down = round2(prevClose * (1 - ratio));
      if (side === 'buy' && price >= up - 0.004) {
        return { blocked: true, code: 'limitUp', message: `已涨停（${up} 元），涨停价不能买入`, limitUp: up, limitDown: down };
      }
      if (side === 'sell' && price <= down + 0.004) {
        return { blocked: true, code: 'limitDown', message: `已跌停（${down} 元），跌停价不能卖出`, limitUp: up, limitDown: down };
      }
      return { blocked: false, limitUp: up, limitDown: down };
    }
  }
  return { blocked: false, limitUp: null, limitDown: null };
}

/* ---------------- 委托单 ---------------- */

function makeOrderId(ts = Date.now()) {
  return `o-${ts}-${Math.floor(Math.random() * 9999)}`;
}

function sanitizeFill(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const shares = Math.floor(num(src.shares));
  const price = num(src.price);
  if (!(shares > 0) || !(price > 0)) return null;
  return {
    ts: Number(src.ts) || 0,
    shares,
    price: round3(price),
    fee: round2(src.fee),
    tax: round2(src.tax),
  };
}

function sanitizeOrder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const secid = String(raw.secid || '');
  if (!/^\d+\.[0-9A-Za-z]+$/.test(secid)) return null;
  const side = raw.side === 'sell' ? 'sell' : 'buy';
  const type = raw.type === 'limit' ? 'limit' : 'market';
  const shares = Math.floor(num(raw.shares));
  if (!(shares > 0)) return null;
  const status = ORDER_STATUSES.includes(raw.status) ? raw.status : 'pending';
  const filledShares = Math.min(shares, Math.max(0, Math.floor(num(raw.filledShares))));
  const fills = (Array.isArray(raw.fills) ? raw.fills : []).map(sanitizeFill).filter(Boolean).slice(-20);
  return {
    id: String(raw.id || '').slice(0, 64) || makeOrderId(),
    clientOrderId: String(raw.clientOrderId || '').slice(0, 64),
    secid,
    code: String(raw.code || secid.split('.')[1] || '').slice(0, 16),
    name: String(raw.name || '').slice(0, 40),
    side,
    type,
    limitPrice: type === 'limit' ? round3(num(raw.limitPrice)) : null,
    shares,
    filledShares,
    avgPrice: filledShares > 0 ? round3(num(raw.avgPrice)) : null,
    status,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    expiresAt: Number(raw.expiresAt) || 0,
    cancelReason: String(raw.cancelReason || '').slice(0, 80),
    rejectReason: String(raw.rejectReason || '').slice(0, 80),
    note: String(raw.note || '').slice(0, 80),
    source: String(raw.source || 'manual').slice(0, 20),
    trigger: raw.trigger && typeof raw.trigger === 'object' ? raw.trigger : null,
    fills,
    lastCheck: raw.lastCheck && typeof raw.lastCheck === 'object' ? {
      at: Number(raw.lastCheck.at) || 0,
      price: Number.isFinite(Number(raw.lastCheck.price)) ? round3(raw.lastCheck.price) : null,
      reason: String(raw.lastCheck.reason || '').slice(0, 100),
    } : null,
  };
}

/** 保留「未结委托 + 最近 60 条已结」，未结数量超上限时拒绝新单（由调用方给出提示） */
function sanitizeOrders(raw) {
  const list = (Array.isArray(raw) ? raw : []).map(sanitizeOrder).filter(Boolean).slice(-400);
  const active = list.filter((o) => o.status === 'pending' || o.status === 'partial');
  const settled = list.filter((o) => !(o.status === 'pending' || o.status === 'partial'));
  return [...settled.slice(-PAPER_ORDER_HISTORY_KEEP), ...active.slice(-PAPER_ORDER_ACTIVE_MAX)];
}

function activeOrderCount(orders) {
  return (Array.isArray(orders) ? orders : [])
    .filter((o) => o && (o.status === 'pending' || o.status === 'partial')).length;
}

function newOrder({
  secid, code, name, side, type = 'limit', limitPrice, shares, note = '', source = 'manual',
  trigger = null, validDays = 1, at = Date.now(), todayKey, clientOrderId,
} = {}) {
  const now = Number(at) || Date.now();
  const tk = todayKey || shanghaiDateKey(now);
  return sanitizeOrder({
    id: makeOrderId(now),
    clientOrderId,
    secid,
    code,
    name,
    side,
    type,
    limitPrice: type === 'limit' ? limitPrice : null,
    shares,
    filledShares: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt: type === 'market' ? now : expireAtOf(validDays, tk, now),
    note,
    source,
    trigger,
    fills: [],
  });
}

/** 把一笔立即成交的市价单也记成「已成交委托」，保证委托列表口径一致 */
function orderFromTrade(trade, { type = 'market', limitPrice = null, note = '', source = 'manual', at } = {}) {
  if (!trade) return null;
  const ts = Number(trade.ts || at) || Date.now();
  return sanitizeOrder({
    id: `o-${ts}-${Math.floor(Math.random() * 9999)}`,
    secid: trade.secid,
    code: trade.code,
    name: trade.name,
    side: trade.side,
    type,
    limitPrice,
    shares: trade.shares,
    filledShares: trade.shares,
    avgPrice: trade.price,
    status: 'filled',
    createdAt: ts,
    updatedAt: ts,
    expiresAt: ts,
    note: note || trade.note || '',
    source,
    fills: [{ ts, shares: trade.shares, price: trade.price, fee: trade.fee, tax: trade.tax || 0 }],
  });
}

/** 追加委托（截断到上限、保留未结） */
function pushOrder(orders, order) {
  const list = sanitizeOrders([...(Array.isArray(orders) ? orders : []), order]);
  return list;
}

/** 撤单：只允许未结委托；返回 { order } 或 { error } */
function cancelOrder(orders, orderId, { at = Date.now(), reason = '手动撤单' } = {}) {
  const list = [...(Array.isArray(orders) ? orders : [])];
  const idx = list.findIndex((o) => o && String(o.id) === String(orderId));
  if (idx < 0) return { error: { status: 404, message: '委托不存在' } };
  const o = list[idx];
  if (!(o.status === 'pending' || o.status === 'partial')) {
    return { error: { status: 400, message: '该委托已结束，不能撤单' } };
  }
  const next = {
    ...o,
    status: 'cancelled',
    updatedAt: Number(at) || Date.now(),
    cancelReason: String(reason || '手动撤单').slice(0, 80),
  };
  list[idx] = next;
  return { orders: sanitizeOrders(list), order: next };
}

/** 过期扫尾：到期未成交直接失效（返回新的 orders 与本次过期的条数） */
function expireOrders(orders, { now = Date.now() } = {}) {
  let expired = 0;
  const list = (Array.isArray(orders) ? orders : []).map((o) => {
    if (!o || !(o.status === 'pending' || o.status === 'partial')) return o;
    if (!(o.expiresAt > 0) || Number(now) < o.expiresAt) return o;
    expired += 1;
    return {
      ...o,
      status: 'expired',
      updatedAt: Number(now),
      cancelReason: '委托到期自动失效（未成交部分不再保留）',
    };
  });
  return { orders: sanitizeOrders(list), expired };
}

/**
 * 撮合一笔委托（限价/市价都走这里；市价单在服务端创建时就会立即撮合一次）。
 * ctx: { now, todayKey, fees, t1, suspend, limitCheck, limitRatio }
 * 返回 { order, account, trade?, blocked?, expired? }；account 只在真成交时变化。
 */
function matchOrder({ account, order, quote, ctx = {} } = {}) {
  const now = num(ctx.now) || Date.now();
  const todayKey = ctx.todayKey || shanghaiDateKey(now);
  const fees = normalizeFees(ctx.fees);
  let o = { ...(order || {}), fills: [...(((order || {}).fills) || [])] };
  if (!o || !(o.status === 'pending' || o.status === 'partial')) return { order: o, account, settled: true };
  if (o.expiresAt > 0 && now >= o.expiresAt) {
    return {
      order: {
        ...o,
        status: 'expired',
        updatedAt: now,
        cancelReason: '委托到期自动失效（未成交部分不再保留）',
      },
      account,
      expired: true,
    };
  }
  const price = num(quote && quote.price);
  const priceMode = String((quote && quote.priceMode) || 'live');
  if (!(price > 0) || priceMode !== 'live') {
    return { order: { ...o, lastCheck: { at: now, price: price || null, reason: '停牌 / 未开盘，取不到实时成交价' } }, account, blocked: 'noPrice' };
  }
  if (o.type === 'limit') {
    const lp = num(o.limitPrice);
    if (!(lp > 0)) {
      return {
        order: { ...o, status: 'rejected', updatedAt: now, rejectReason: '限价非法' },
        account,
        blocked: 'badLimit',
      };
    }
    const touched = o.side === 'buy' ? price <= lp : price >= lp;
    if (!touched) {
      return {
        order: {
          ...o,
          lastCheck: { at: now, price: round3(price), reason: `限价 ${round3(lp)} 未触及（现价 ${round3(price)}）` },
        },
        account,
        blocked: 'priceNotTouched',
      };
    }
  }
  const guard = tradeGuard({ quote, side: o.side, ctx });
  if (guard.blocked) {
    return { order: { ...o, lastCheck: { at: now, price: round3(price), reason: guard.message } }, account, blocked: guard.code };
  }
  const lot = lotOf(o.secid);
  const remaining = Math.max(0, Math.floor(num(o.shares)) - Math.floor(num(o.filledShares)));
  if (!(remaining > 0)) return { order: { ...o, status: 'filled', updatedAt: now }, account, settled: true };
  let fill = remaining;
  if (o.side === 'buy') {
    const max = maxBuyShares({ price, cash: account.cash, lot, fees });
    fill = Math.min(remaining, max.shares);
    if (!(fill > 0)) {
      return {
        order: {
          ...o,
          lastCheck: { at: now, price: round3(price), reason: `可用资金不足（现价 ${round3(price)} 元，每手约 ${round2(price * lot).toFixed(0)} 元）` },
        },
        account,
        blocked: 'noCash',
      };
    }
  } else {
    const heldAvailable = ctx.t1 === false
      ? Math.max(0, Math.floor(num(((account.positions || {})[o.secid] || {}).shares)))
      : availableShares(account, o.secid, todayKey);
    fill = Math.min(remaining, heldAvailable);
    if (!(fill > 0)) {
      return {
        order: {
          ...o,
          lastCheck: { at: now, price: round3(price), reason: ctx.t1 === false ? '当前没有可卖持仓' : 'T+1：当日买入的股数不能当日卖出' },
        },
        account,
        blocked: 'noShares',
      };
    }
  }
  const fillQuote = { ...(quote || {}), secid: o.secid, price };
  const res = o.side === 'buy'
    ? L.applyBuy(account, {
      quote: fillQuote, shares: fill, note: o.note, fees, at: now, orderId: o.id, source: o.source, today: todayKey,
    })
    : L.applySell(account, {
      quote: fillQuote, shares: fill, note: o.note, fees, at: now, orderId: o.id, source: o.source, t1: ctx.t1 !== false, today: todayKey,
    });
  if (res.error) {
    return { order: { ...o, lastCheck: { at: now, price: round3(price), reason: res.error.message } }, account, blocked: 'applyError' };
  }
  const filledNow = Math.floor(num(res.trade.shares));
  const prevFilled = Math.floor(num(o.filledShares));
  const prevAvg = num(o.avgPrice);
  const newFilled = prevFilled + filledNow;
  o = {
    ...o,
    filledShares: newFilled,
    avgPrice: round3(newFilled > 0 ? (prevAvg * prevFilled + price * filledNow) / newFilled : price),
    status: newFilled >= o.shares ? 'filled' : 'partial',
    updatedAt: now,
    lastCheck: { at: now, price: round3(price), reason: '' },
    fills: [...o.fills, {
      ts: now, shares: filledNow, price: round3(price), fee: round2(res.trade.fee), tax: round2(res.trade.tax || 0),
    }].slice(-20),
  };
  return { order: o, account: res.account, trade: res.trade, filled: filledNow };
}

/** 委托视图（给前端）：剩余股数、进度、到期日、能否撤单 */
function orderView(order, { todayKey = shanghaiDateKey() } = {}) {
  const o = order || {};
  const shares = Math.floor(num(o.shares));
  const filled = Math.min(shares, Math.floor(num(o.filledShares)));
  const remaining = Math.max(0, shares - filled);
  const expireKey = o.expiresAt > 0 ? shanghaiDateKey(o.expiresAt) : '';
  const active = o.status === 'pending' || o.status === 'partial';
  return {
    ...o,
    remainingShares: remaining,
    progressPct: shares > 0 ? round2((filled / shares) * 100) : 0,
    canCancel: active,
    expiresDate: expireKey,
    active,
    expireLabel: o.expiresAt > 0 && expireKey === todayKey ? '当日 15:00 失效' : expireKey ? `${expireKey} 15:00 失效` : '',
  };
}

/* ---------------- 条件单（止盈止损 / 价格条件） ---------------- */

function sanitizeCondition(raw) {
    if (!raw || typeof raw !== 'object') return null;
  const secid = String(raw.secid || '');
  if (!/^\d+\.[0-9A-Za-z]+$/.test(secid)) return null;
  const kind = CONDITION_KINDS.includes(raw.kind) ? raw.kind : '';
  if (!kind) return null;
  const value = Number(raw.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const status = ['active', 'triggered', 'cancelled', 'failed'].includes(raw.status) ? raw.status : 'active';
  return {
    id: String(raw.id || '').slice(0, 64) || `c-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
    secid,
    code: String(raw.code || secid.split('.')[1] || '').slice(0, 16),
    name: String(raw.name || '').slice(0, 40),
    kind,
    // 止盈/止损的 value 是收益率百分数（8 = +8%），价格条件 value 是价格
    value: kind === 'takeProfit' || kind === 'stopLoss' ? round2(value) : round3(value),
    side: raw.side === 'buy' ? 'buy' : 'sell',
    shares: Math.max(0, Math.floor(num(raw.shares))),
    status,
    createdAt: Number(raw.createdAt) || Date.now(),
    triggeredAt: Number(raw.triggeredAt) || 0,
    note: String(raw.note || '').slice(0, 80),
    lastError: String(raw.lastError || '').slice(0, 100),
    lastCheck: raw.lastCheck && typeof raw.lastCheck === 'object'
      ? { at: Number(raw.lastCheck.at) || 0, price: round3(num(raw.lastCheck.price)), reason: String(raw.lastCheck.reason || '').slice(0, 100) }
      : null,
  };
}

function sanitizeConditions(raw) {
  return (Array.isArray(raw) ? raw : []).map(sanitizeCondition).filter(Boolean).slice(-PAPER_CONDITION_MAX * 2);
}

function conditionLabel(cond) {
  if (!cond) return '';
  const v = Number(cond.value);
  if (cond.kind === 'takeProfit') return `止盈：浮盈 ≥ ${v}%`;
  if (cond.kind === 'stopLoss') return `止损：浮亏 ≥ ${v}%`;
  if (cond.kind === 'priceAbove') return `价格 ≥ ${v} 元`;
  if (cond.kind === 'priceBelow') return `价格 ≤ ${v} 元`;
  return String(cond.kind || '');
}

/**
 * 判定一条条件单是否触发。
 * pos 传当前持仓（含 cost），没有持仓时止盈止损永不触发。
 */
function evalCondition({ cond, quote, pos, todayKey } = {}) {
  if (!cond || cond.status !== 'active') return { hit: false };
  const price = num(quote && quote.price);
  if (!(price > 0)) return { hit: false, reason: '取不到最新价' };
  const cost = num(pos && pos.cost);
  const held = Math.max(0, Math.floor(num(pos && pos.shares)));
  if (cond.kind === 'takeProfit' || cond.kind === 'stopLoss') {
    if (!(held > 0) || !(cost > 0)) return { hit: false, reason: '当前没有该标的持仓' };
    const pct = ((price - cost) / cost) * 100;
    const hit = cond.kind === 'takeProfit' ? pct >= Number(cond.value) : pct <= -Math.abs(Number(cond.value));
    return {
      hit,
      price,
      pct: round2(pct),
      reason: `现价 ${round3(price)}，持仓收益率 ${round2(pct)}%（成本 ${round3(cost)}）`,
    };
  }
  if (cond.kind === 'priceAbove') {
    return { hit: price >= Number(cond.value), price, reason: `现价 ${round3(price)}` };
  }
  if (cond.kind === 'priceBelow') {
    return { hit: price <= Number(cond.value), price, reason: `现价 ${round3(price)}` };
  }
  return { hit: false };
}

/** 条件单触发后要下的股数：0 = 全部可用（卖出）/ 按可用资金最大（买入） */
function conditionShares({ cond, quote, account, todayKey, fees, t1 }) {
  const price = num(quote && quote.price);
  if (!(price > 0)) return 0;
  const lot = lotOf(cond.secid);
  if (cond.side === 'sell') {
    const pos = (account.positions || {})[cond.secid];
    if (!pos) return 0;
    const available = t1 === false ? Math.floor(num(pos.shares)) : availableShares(account, cond.secid, todayKey);
    const want = cond.shares > 0 ? Math.min(cond.shares, available) : available;
    return Math.max(0, Math.floor(want));
  }
  if (cond.shares > 0) {
    const max = maxBuyShares({ price, cash: account.cash, lot, fees });
    return Math.min(cond.shares, max.shares);
  }
  return maxBuyShares({ price, cash: account.cash, lot, fees }).shares;
}

/* ---------------- 网格 / 定投 ---------------- */

function sanitizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const secid = String(raw.secid || '');
  if (!/^\d+\.[0-9A-Za-z]+$/.test(secid)) return null;
  const kind = PLAN_KINDS.includes(raw.kind) ? raw.kind : '';
  if (!kind) return null;
  const status = ['active', 'paused', 'stopped'].includes(raw.status) ? raw.status : 'active';
  const base = {
    id: String(raw.id || '').slice(0, 64) || `p-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
    secid,
    code: String(raw.code || secid.split('.')[1] || '').slice(0, 16),
    name: String(raw.name || '').slice(0, 40),
    kind,
    status,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || 0,
    runs: Math.max(0, Math.floor(num(raw.runs))),
    note: String(raw.note || '').slice(0, 80),
    lastAction: String(raw.lastAction || '').slice(0, 120),
    lastError: String(raw.lastError || '').slice(0, 120),
    lastErrorAt: Number(raw.lastErrorAt) || 0,
    todayRuns: Math.max(0, Math.floor(num(raw.todayRuns))),
    todayKey: dateKeyOf(raw.todayKey),
  };
  if (kind === 'grid') {
    const lower = round3(num(raw.lower));
    const upper = round3(num(raw.upper));
    const grids = Math.max(2, Math.min(30, Math.floor(num(raw.grids, 6))));
    const sharesPerGrid = Math.floor(num(raw.sharesPerGrid));
    if (!(lower > 0) || !(upper > lower) || !(sharesPerGrid > 0)) return null;
    return {
      ...base,
      lower,
      upper,
      grids,
      sharesPerGrid,
      gridIndex: Number.isFinite(Number(raw.gridIndex)) ? Math.max(-1, Math.min(grids, Math.floor(Number(raw.gridIndex)))) : null,
    };
  }
  const amount = round2(num(raw.amount));
  const freq = DCA_FREQS.includes(raw.freq) ? raw.freq : 'weekly';
  if (!(amount >= 1000)) return null;
  return {
    ...base,
    kind: 'dca',
    amount,
    freq,
    weekday: Math.max(1, Math.min(5, Math.floor(num(raw.weekday, 1)))),
    dayOfMonth: Math.max(1, Math.min(28, Math.floor(num(raw.dayOfMonth, 1)))),
    nextDateKey: dateKeyOf(raw.nextDateKey) || '',
  };
}

function sanitizePlans(raw) {
  return (Array.isArray(raw) ? raw : []).map(sanitizePlan).filter(Boolean).slice(-PAPER_PLAN_MAX * 2);
}

/** 网格价位：把 [lower, upper] 等分成 grids 段，返回 grids+1 个价位 */
function gridLevels(plan) {
  const lower = num(plan && plan.lower);
  const upper = num(plan && plan.upper);
  const grids = Math.max(2, Math.floor(num(plan && plan.grids, 6)));
  if (!(lower > 0) || !(upper > lower)) return [];
  const out = [];
  for (let i = 0; i <= grids; i += 1) {
    out.push(round3(lower + ((upper - lower) * i) / grids));
  }
  return out;
}

/** 现价落在第几格：低于下界 → -1，高于上界 → grids */
function gridIndexFor(plan, price) {
  const levels = gridLevels(plan);
  const p = num(price);
  if (!levels.length || !(p > 0)) return null;
  if (p < levels[0]) return -1;
  let idx = -1;
  for (let i = 0; i < levels.length; i += 1) {
    if (p >= levels[i]) idx = i;
  }
  return idx;
}

/**
 * 网格动作：跌破一格买一份、涨过一格卖一份（一次 tick 只做一格）。
 * 返回 { action: 'init'|'buy'|'sell'|'hold', index, newIndex, shares, message }
 */
function gridAction({ plan, price, pos, cash = 0, fees, t1, todayKey, available } = {}) {
  const levels = gridLevels(plan);
  const p = num(price);
  if (!levels.length || !(p > 0)) return { action: 'hold', message: '价格不可用' };
  const idx = gridIndexFor(plan, p);
  const rawIdx = plan && plan.gridIndex;
  const prev = rawIdx === null || rawIdx === undefined || rawIdx === ''
    ? null : (Number.isFinite(Number(rawIdx)) ? Number(rawIdx) : null);
  if (prev === null) return { action: 'init', index: idx, newIndex: idx, shares: 0, message: `初始化网格位置（第 ${idx + 1} 段）` };
  const step = Math.max(0, Math.floor(num(plan.sharesPerGrid)));
  if (idx < prev) {
    const need = maxBuyShares({ price: p, cash, lot: lotOf(plan.secid), fees });
    const shares = Math.min(step, need.shares);
    if (!(shares > 0)) return { action: 'hold', index: idx, newIndex: prev, shares: 0, message: '可用资金不足，等下一次' };
    return { action: 'buy', index: idx, newIndex: idx, shares, message: `跌到第 ${idx + 1} 段，买入 ${shares} 股` };
  }
  if (idx > prev) {
    const held = Math.max(0, Math.floor(num(pos && pos.shares)));
    const sellable = Number.isFinite(Number(available)) ? Number(available) : held;
    const shares = Math.min(step, sellable);
    if (!(shares > 0)) return { action: 'hold', index: idx, newIndex: prev, shares: 0, message: '没有可卖持仓（T+1 锁仓中）' };
    return { action: 'sell', index: idx, newIndex: idx, shares, message: `涨到第 ${idx + 1} 段，卖出 ${shares} 股` };
  }
  return { action: 'hold', index: idx, newIndex: prev, shares: 0, message: '' };
}

/** 定投下一个执行日（只排交易日，周末顺延） */
function dcaNextDate({ freq, weekday = 1, dayOfMonth = 1, fromKey } = {}) {
  const base = dateKeyOf(fromKey) || shanghaiDateKey();
  if (freq === 'daily') return nextWorkday(dateAddDays(base, 1));
  if (freq === 'weekly') {
    const target = Math.max(1, Math.min(5, Math.floor(num(weekday, 1))));
    for (let i = 1; i <= 10; i += 1) {
      const k = nextWorkday(dateAddDays(base, i));
      if (weekdayOf(k) === target) return k;
    }
    return nextWorkday(dateAddDays(base, 7));
  }
  // monthly：下个月的同一天，落到周末顺延到周一
  const y = Number(base.slice(0, 4));
  const m = Number(base.slice(5, 7));
  const day = Math.max(1, Math.min(28, Math.floor(num(dayOfMonth, 1))));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return nextWorkday(`${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

/** 定投今天该不该执行 */
function dcaDue({ plan, todayKey } = {}) {
  if (!plan || plan.kind !== 'dca' || plan.status !== 'active') return false;
  const tk = dateKeyOf(todayKey) || shanghaiDateKey();
  if (!isWorkday(tk)) return false;
  const due = dateKeyOf(plan.nextDateKey);
  return !due || tk >= due;
}

/* ---------------- 公司行为（分红除权） ---------------- */

function sanitizeCorporateEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const secid = String(raw.secid || '');
  if (!/^\d+\.[0-9A-Za-z]+$/.test(secid)) return null;
  const exDate = dateKeyOf(raw.exDate);
  if (!exDate) return null;
  const cashPerShare = Math.max(0, round4(raw.cashPerShare));
  const shareRatio = Math.max(0, round4(raw.shareRatio));
  if (!(cashPerShare > 0) && !(shareRatio > 0)) return null;
  return {
    id: String(raw.id || '').slice(0, 64) || `div-${secid}-${exDate}`,
    secid,
    code: String(raw.code || secid.split('.')[1] || '').slice(0, 16),
    name: String(raw.name || '').slice(0, 40),
    exDate,
    cashPerShare,
    // 每 10 股送转 N 股（1 = 10 送 1）
    shareRatio,
    note: String(raw.note || '').slice(0, 80),
    createdAt: Number(raw.createdAt) || Date.now(),
    createdBy: String(raw.createdBy || '').slice(0, 40),
  };
}

function sanitizeCorporateEvents(raw) {
  return (Array.isArray(raw) ? raw : []).map(sanitizeCorporateEvent).filter(Boolean).slice(-500);
}

/** 已入账记录（按标的事件 id 幂等） */
function sanitizeCorporateApplied(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const [key, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    out[String(key).slice(0, 96)] = {
      at: Number(v.at) || 0,
      eventId: String(v.eventId || '').slice(0, 64),
      secid: String(v.secid || '').slice(0, 32),
      exDate: dateKeyOf(v.exDate),
      cash: round2(v.cash),
      sharesBefore: Math.floor(num(v.sharesBefore)),
      sharesAfter: Math.floor(num(v.sharesAfter)),
      note: String(v.note || '').slice(0, 80),
    };
  }
  return out;
}

/**
 * 除权日入账：现金分红进现金、送转股增加股数（总成本按现金分红扣减，每股成本被摊薄）。
 * 只处理「今天 >= 除权日、且当前仍持有、且此前没入过账」的事件 —— 中途卖出过的不补。
 */
function applyCorporateActions({ account, events, todayKey, at = Date.now() } = {}) {
  const acc = account;
  const applied = sanitizeCorporateApplied(acc.corporate);
  const tk = dateKeyOf(todayKey) || shanghaiDateKey();
  const list = sanitizeCorporateEvents(events);
  const done = [];
  let touched = false;
  for (const ev of list) {
    if (ev.exDate > tk) continue;
    const key = `${ev.id}:${ev.secid}`;
    if (applied[key]) continue;
    const pos = (acc.positions || {})[ev.secid];
    if (!pos || !(num(pos.shares) > 0)) continue;
    const sharesBefore = Math.floor(num(pos.shares));
    const totalCost = num(pos.cost) * sharesBefore;
    const cash = round2(ev.cashPerShare * sharesBefore);
    const sharesAfter = ev.shareRatio > 0
      ? Math.max(1, Math.floor(sharesBefore * (1 + ev.shareRatio / 10)))
      : sharesBefore;
    const remainCost = Math.max(0, totalCost - cash);
    acc.cash = Math.max(0, round2(num(acc.cash) + cash));
    acc.positions[ev.secid] = {
      ...pos,
      shares: sharesAfter,
      cost: round4(remainCost / sharesAfter),
      lockedShares: Math.min(sharesAfter, Math.max(0, Math.floor(num(pos.lockedShares)))),
    };
    applied[key] = {
      at: Number(at) || Date.now(),
      eventId: ev.id,
      secid: ev.secid,
      exDate: ev.exDate,
      cash,
      sharesBefore,
      sharesAfter,
      note: ev.note,
    };
    done.push(applied[key]);
    touched = true;
  }
  if (touched) {
    acc.corporate = applied;
    acc.updatedAt = Number(at) || Date.now();
  }
  return { account: acc, applied: done };
}

/* ---------------- 日终权益快照 / 周期收益 / 回撤 ---------------- */

function sanitizeEquity(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const keys = Object.keys(src).filter((k) => dateKeyOf(k)).sort();
  for (const k of keys.slice(-PAPER_EQUITY_KEEP)) {
    const v = num(src[k]);
    if (v > 0) out[dateKeyOf(k)] = round2(v);
  }
  return out;
}

/** 记录某一天的账户总资产（同一天覆盖，最多保留 1500 天） */
function recordEquity(account, dateKey, total) {
  const tk = dateKeyOf(dateKey);
  const v = round2(total);
  if (!tk || !(v > 0)) return account;
  const equity = sanitizeEquity(account && account.equity);
  equity[tk] = v;
  return { ...account, equity };
}

function equitySeries(account) {
  const equity = sanitizeEquity(account && account.equity);
  return Object.keys(equity).sort().map((d) => ({ d, v: equity[d] }));
}

/** 截至某日（含）累计追加资金：算回撤 / 周期收益时要把入金剔掉 */
function injectedUpTo(account, dateKey) {
  const events = ((account && account.capital && account.capital.events) || []);
  const tk = dateKeyOf(dateKey);
  let sum = 0;
  for (const e of events) {
    const at = Number(e && e.at) || 0;
    if (!at) continue;
    if (tk && shanghaiDateKey(at) > tk) continue;
    sum += num(e.amount);
  }
  return round2(sum);
}

function periodStart(todayKey, unit) {
  const tk = dateKeyOf(todayKey) || shanghaiDateKey();
  if (unit === 'week') {
    const wd = weekdayOf(tk); // 0=周日
    const back = wd === 0 ? 6 : wd - 1; // 回退到本周一
    return dateAddDays(tk, -back);
  }
  if (unit === 'month') return `${tk.slice(0, 7)}-01`;
  if (unit === 'year') return `${tk.slice(0, 4)}-01-01`;
  return tk;
}

/**
 * 周期收益与最大回撤（口径：用日终总资产；周期内追加资金从"期末"里剔掉，
 * 否则一加钱收益率就虚高；回撤也按"剔除入金后"的净值曲线算）。
 */
function periodStats({ account, totalNow, todayKey } = {}) {
  const tk = dateKeyOf(todayKey) || shanghaiDateKey();
  const total = round2(totalNow);
  const series = equitySeries(account);
  if (total > 0) {
    const last = series[series.length - 1];
    if (last && last.d === tk) last.v = total;
    else series.push({ d: tk, v: total });
  }
  const principal = round2(num(account && account.initial) + num(account && account.capital && account.capital.injected));
  const valueAt = (key) => {
    let pick = null;
    for (const row of series) {
      if (row.d < key) pick = row;
      else break;
    }
    return pick;
  };
  const firstAtOrAfter = (key) => series.find((row) => row.d >= key) || null;
  const pctOf = (unit) => {
    if (!(total > 0)) return null;
    const start = periodStart(tk, unit);
    let base = valueAt(start);
    if (!base) {
      base = firstAtOrAfter(start);
      // 期初没有快照、只有今天这一天的快照时，收益率为空（不能用今天当基数）
      if (!base || base.d >= tk) return null;
    }
    const injectedSince = round2(injectedUpTo(account, tk) - injectedUpTo(account, base.d));
    const baseValue = num(base.v);
    if (!(baseValue > 0)) return null;
    return roundPct(((total - injectedSince - baseValue) / baseValue) * 100);
  };
  // 最大回撤：剔除入金后的净值曲线
  let peak = 0;
  let mdd = 0;
  let peakDate = '';
  let troughDate = '';
  for (const row of series) {
    const adj = round2(num(row.v) - injectedUpTo(account, row.d));
    if (adj <= 0) continue;
    if (adj > peak) { peak = adj; peakDate = row.d; }
    else if (peak > 0) {
      const dd = ((peak - adj) / peak) * 100;
      if (dd > mdd) { mdd = dd; troughDate = row.d; }
    }
  }
  const totalPct = principal > 0 && total > 0 ? roundPct(((total - principal) / principal) * 100) : null;
  return {
    todayPct: pctOf('today'),
    weekPct: pctOf('week'),
    monthPct: pctOf('month'),
    yearPct: pctOf('year'),
    totalPct,
    mdd: series.length > 1 ? roundPct(mdd) : null,
    mddFrom: peakDate,
    mddTo: troughDate,
    equityDays: series.length,
    firstDate: series.length ? series[0].d : '',
  };
}

/* ---------------- 复盘报告（胜率 / 盈亏比 / 回撤 / 集中度） ---------------- */

function reviewMetrics({ account, totalNow, positions, todayKey } = {}) {
  const acc = account || {};
  const trades = (Array.isArray(acc.trades) ? acc.trades : [])
    .filter((t) => t && t.ts > 0 && (t.side === 'buy' || t.side === 'sell'));
  const sells = trades.filter((t) => t.side === 'sell' && Number.isFinite(Number(t.realized)));
  const wins = sells.filter((t) => Number(t.realized) > 0);
  const losses = sells.filter((t) => Number(t.realized) < 0);
  const winSum = round2(wins.reduce((s, t) => s + Number(t.realized), 0));
  const lossSum = round2(losses.reduce((s, t) => s + Number(t.realized), 0));
  const avgWin = wins.length ? round2(winSum / wins.length) : null;
  const avgLoss = losses.length ? round2(lossSum / losses.length) : null;
  const profitFactor = lossSum !== 0 ? round2(winSum / Math.abs(lossSum)) : (winSum > 0 ? null : 0);
  const realizedTotal = round2(sells.reduce((s, t) => s + Number(t.realized), 0));
  // 持仓天数：按标的从首笔买入到「卖光那一笔」（只统计已经清仓的回合）
  const firstBuyAt = new Map();
  const bought = new Map();
  const holdingDaysList = [];
  for (const t of trades) {
    const sid = String(t.secid);
    if (t.side === 'buy') {
      if (!firstBuyAt.has(sid)) firstBuyAt.set(sid, t.ts);
      bought.set(sid, (bought.get(sid) || 0) + Math.floor(num(t.shares)));
    } else {
      const qty = Math.floor(num(t.shares));
      const remain = (bought.get(sid) || 0) - qty;
      bought.set(sid, remain);
      const start = firstBuyAt.get(sid);
      if (remain <= 0 && start && t.ts > start) {
        holdingDaysList.push(Math.max(0, Math.round((t.ts - start) / 86400000)));
        firstBuyAt.delete(sid);
      }
    }
  }
  const avgHoldDays = holdingDaysList.length
    ? round2(holdingDaysList.reduce((s, v) => s + v, 0) / holdingDaysList.length) : null;
  const stats = periodStats({ account: acc, totalNow, todayKey });
  // 集中度：单一最大持仓占「总资产」的比例 + 赫芬达尔指数（含现金）
  const total = num(totalNow) > 0 ? num(totalNow) : round2(num(acc.cash));
  let topWeight = null;
  let topName = '';
  let hhi = null;
  if (total > 0) {
    const weights = [];
    for (const p of (Array.isArray(positions) ? positions : [])) {
      const w = num(p.marketValue) / total;
      weights.push(w);
      if (topWeight === null || w > topWeight) { topWeight = w; topName = String(p.name || p.code || ''); }
    }
    weights.push(num(acc.cash) / total);
    hhi = round4(weights.reduce((s, w) => s + w * w, 0));
    topWeight = roundPct(topWeight === null ? 0 : topWeight * 100);
  }
  const best = sells.reduce((m, t) => (m === null || Number(t.realized) > Number(m.realized) ? t : m), null);
  const worst = sells.reduce((m, t) => (m === null || Number(t.realized) < Number(m.realized) ? t : m), null);
  return {
    trades: trades.length,
    buys: trades.filter((t) => t.side === 'buy').length,
    sells: sells.length,
    closedSells: sells.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: sells.length ? roundPct((wins.length / sells.length) * 100) : null,
    avgWin,
    avgLoss,
    // 盈亏比 = 平均盈利单 / 平均亏损单（亏损取绝对值）
    payoffRatio: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? round2(avgWin / Math.abs(avgLoss)) : null,
    profitFactor,
    realizedTotal,
    avgHoldDays,
    bestTrade: best ? { name: String(best.name || ''), code: String(best.code || ''), realized: round2(best.realized), at: best.ts } : null,
    worstTrade: worst ? { name: String(worst.name || ''), code: String(worst.code || ''), realized: round2(worst.realized), at: worst.ts } : null,
    mdd: stats.mdd,
    mddFrom: stats.mddFrom,
    mddTo: stats.mddTo,
    totalPct: stats.totalPct,
    todayPct: stats.todayPct,
    weekPct: stats.weekPct,
    monthPct: stats.monthPct,
    yearPct: stats.yearPct,
    equityDays: stats.equityDays,
    topWeight,
    topName,
    hhi,
  };
}

/* ---------------- 跟单 ---------------- */

function sanitizeFollow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const target = String(raw.target || raw.username || '').trim().slice(0, 40);
  if (!target) return null;
  const ratio = Number(raw.ratio);
  return {
    target,
    ratio: Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? round4(ratio) : 0.5,
    maxShares: Math.max(0, Math.floor(num(raw.maxShares, 1000))),
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

function sanitizeFollows(raw) {
  const list = (Array.isArray(raw) ? raw : []).map(sanitizeFollow).filter(Boolean);
  const seen = new Set();
  return list.filter((f) => {
    const k = f.target.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(-PAPER_FOLLOW_MAX);
}

function sanitizeFollowers(raw) {
  const list = (Array.isArray(raw) ? raw : []).map(sanitizeFollow).filter(Boolean);
  const seen = new Set();
  return list.filter((f) => {
    const k = f.target.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(-200);
}

/** 跟单股数：按比例取整手，买入不超过可用资金、卖出不超过可卖股数 */
function followShares({ trade, ratio, lot = 100, cash = 0, price = 0, fees, held = 0, maxShares = 0 } = {}) {
  const r = num(ratio);
  const base = Math.floor(num(trade && trade.shares));
  if (!(r > 0) || !(base > 0)) return 0;
  let shares = Math.floor((base * r) / Math.max(1, lot)) * Math.max(1, lot);
  if (maxShares > 0) shares = Math.min(shares, Math.floor(maxShares));
  if (trade.side === 'buy') {
    const max = maxBuyShares({ price, cash, lot, fees });
    shares = Math.min(shares, max.shares);
  } else {
    shares = Math.min(shares, Math.max(0, Math.floor(held)));
  }
  return Math.max(0, shares);
}

/* ---------------- 账户内新字段的归一化 ---------------- */

function normalizeAutomationFields(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    orders: sanitizeOrders(src.orders),
    conditions: sanitizeConditions(src.conditions),
    plans: sanitizePlans(src.plans),
    corporate: sanitizeCorporateApplied(src.corporate),
    equity: sanitizeEquity(src.equity),
    following: sanitizeFollows(src.following),
    followers: sanitizeFollowers(src.followers),
    allowFollow: src.allowFollow === false ? false : true,
  };
}

module.exports = {
  PAPER_ORDER_ACTIVE_MAX,
  PAPER_ORDER_HISTORY_KEEP,
  PAPER_CONDITION_MAX,
  PAPER_PLAN_MAX,
  PAPER_EQUITY_KEEP,
  PAPER_CORPORATE_KEEP,
  PAPER_FOLLOW_MAX,
  CONDITION_KINDS,
  PLAN_KINDS,
  DCA_FREQS,
  ORDER_STATUSES,
  dateKeyOf,
  dateAddDays,
  weekdayOf,
  isWorkday,
  nextWorkday,
  expireAtOf,
  tradeGuard,
  makeOrderId,
  sanitizeOrder,
  sanitizeOrders,
  activeOrderCount,
  newOrder,
  orderFromTrade,
  pushOrder,
  cancelOrder,
  expireOrders,
  matchOrder,
  orderView,
  sanitizeCondition,
  sanitizeConditions,
  conditionLabel,
  evalCondition,
  conditionShares,
  sanitizePlan,
  sanitizePlans,
  gridLevels,
  gridIndexFor,
  gridAction,
  dcaNextDate,
  dcaDue,
  sanitizeCorporateEvent,
  sanitizeCorporateEvents,
  sanitizeCorporateApplied,
  applyCorporateActions,
  sanitizeEquity,
  recordEquity,
  equitySeries,
  injectedUpTo,
  periodStart,
  periodStats,
  reviewMetrics,
  sanitizeFollow,
  sanitizeFollows,
  sanitizeFollowers,
  followShares,
  normalizeAutomationFields,
};
