'use strict';
/**
 * 模拟交易账本（v2.11.0，从 server.js 抽出的纯逻辑）
 * ---------------------------------------------------------
 * 这里不做 I/O、不取行情、不读文件，server.js 负责取价/存取，
 * 这样账本规则（费用、整手、已实现、增量资金、逐日盈亏）可以直接单测。
 *
 * 口径（全项目唯一）：
 * - 买入：现金 −(成交额 + 佣金)，佣金摊进每股成本（保留 4 位）；
 * - 卖出：现金 +(成交额 − 佣金 − 印花税)，已实现 = 卖出净额 − 卖出股数 × 每股成本；
 * - 个股累计收益率 = 累计已实现 / 累计已卖出成本（清仓后账本仍保留，重买继续累计）；
 * - 本金 = initial + 累计追加资金；累计盈亏 = 总资产 − 本金；
 * - 逐日盈亏 = 当日收盘总资产 − 上一可用日总资产 − 当日入金（入金不算收益）。
 */

const FEES = Object.freeze({ rate: 0.00025, min: 5, taxRate: 0.0005 });
const PAPER_TRADES_KEEP = 1000;
const PAPER_PNL_MAX_SECIDS = 20;
const PAPER_DAYS_MIN = 60;
const PAPER_DAYS_MAX = 1500;
const CASH_EPS = 0.005;
const MAX_SHARES_PER_ORDER = 1000000;

/* ---------------- 基础数字工具 ---------------- */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // 去掉 -0（JSON / 页面会显示成 "-0.00"）
  return Math.round(n * 100) / 100 || 0;
}

function round3(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

function round4(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

function roundPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100 || 0;
}

/** 上海时区 YYYY-MM-DD（与 lib/engine.shanghaiToday 同口径） */
function shanghaiDateKey(input = Date.now()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (k) => (parts.find((p) => p.type === k) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/* ---------------- 费用 / 整手 / 最大可买 ---------------- */

function normalizeFees(fees) {
  const src = fees && typeof fees === 'object' ? fees : {};
  return {
    rate: Number.isFinite(Number(src.rate)) && Number(src.rate) >= 0 ? Number(src.rate) : FEES.rate,
    min: Number.isFinite(Number(src.min)) && Number(src.min) >= 0 ? Number(src.min) : FEES.min,
    taxRate: Number.isFinite(Number(src.taxRate)) && Number(src.taxRate) >= 0 ? Number(src.taxRate) : FEES.taxRate,
  };
}

/** A 股 / 场内 ETF（0./1. + 6 位）按 100 股整手；其它标的 1 股起 */
function lotOf(secid) {
  return /^[01]\.\d{6}$/.test(String(secid || '')) ? 100 : 1;
}

/** 佣金：万 2.5，最低 5 元 */
function feeOf(amount, fees) {
  const f = normalizeFees(fees);
  return Math.max(f.min, num(amount) * f.rate);
}

/** 印花税：卖出万 5 */
function taxOf(amount, fees) {
  return num(amount) * normalizeFees(fees).taxRate;
}

/** 买入总成本（成交额 + 佣金） */
function buyCostOf(amount, fees) {
  return num(amount) + feeOf(amount, fees);
}

/** 卖出净收入（成交额 − 佣金 − 印花税） */
function sellProceedsOf(amount, fees) {
  return num(amount) - feeOf(amount, fees) - taxOf(amount, fees);
}

/**
 * 当前资金最多能买多少股（含佣金预留，按整手向下取整）。
 * 前端 app.js 的 paperMaxBuyShares 必须与这里同口径（有两处同值断言）。
 * 返回 { shares, amount, fee, cost }；资金不足一手时 shares=0。
 */
function maxBuyShares({ price, cash, lot = 100, fees } = {}) {
  const p = num(price);
  const c = Math.max(0, num(cash));
  const step = Number.isFinite(Number(lot)) && Number(lot) > 0 ? Number(lot) : 1;
  const f = normalizeFees(fees);
  if (!(p > 0) || !(c > 0)) return { shares: 0, amount: 0, fee: 0, cost: 0 };
  let shares = Math.floor(c / (p * (1 + f.rate)) / step) * step;
  if (!Number.isFinite(shares) || shares < 0) shares = 0;
  const costOf = (n) => p * n + Math.max(f.min, p * n * f.rate);
  // 逐手回退：最低佣金 5 元对低价 / 小资金更敏感，只算一次可能仍然差几毛
  let guard = 0;
  while (shares > 0 && costOf(shares) > c + CASH_EPS && guard < 100000) {
    shares -= step;
    guard += 1;
  }
  if (shares < 0) shares = 0;
  if (shares === 0) return { shares: 0, amount: 0, fee: 0, cost: 0 };
  const amount = p * shares;
  const fee = feeOf(amount, f);
  return {
    shares,
    amount: round2(amount),
    fee: round2(fee),
    cost: round2(amount + fee),
  };
}

/* ---------------- 账户归一化 / 已实现回填 ---------------- */

function emptyAccount(globalInitial) {
  const initial = Number.isFinite(Number(globalInitial)) && Number(globalInitial) > 0
    ? Number(globalInitial) : 1000000;
  return {
    initial,
    cash: initial,
    positions: {},
    trades: [],
    realized: {},
    capital: { injected: 0, events: [] },
    updatedAt: null,
  };
}

function sanitizePositions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [secid, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    const shares = Math.floor(num(p.shares));
    if (!(shares > 0)) continue;
    out[secid] = {
      code: String(p.code || secid.split('.')[1] || '').slice(0, 16),
      name: String(p.name || '').slice(0, 40),
      shares,
      cost: Math.max(0, round4(p.cost)),
    };
  }
  return out;
}

function sanitizeCapital(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const injected = Math.max(0, round2(src.injected));
  const events = (Array.isArray(src.events) ? src.events : [])
    .map((e) => ({
      at: Number(e && e.at) || 0,
      amount: Math.max(0, round2(e && e.amount)),
      note: String((e && e.note) || '').slice(0, 60),
      by: String((e && e.by) || '').slice(0, 40),
    }))
    .filter((e) => e.amount > 0 && e.at > 0)
    .slice(-50);
  return { injected, events };
}

function sanitizeLedgerEntry(secid, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const sellShares = Math.floor(num(src.sellShares));
  return {
    secid,
    code: String(src.code || secid.split('.')[1] || '').slice(0, 16),
    name: String(src.name || '').slice(0, 40),
    sellShares: sellShares > 0 ? sellShares : 0,
    sellAmount: Math.max(0, round2(src.sellAmount)),
    costBasis: Math.max(0, round2(src.costBasis)),
    realized: round2(src.realized),
    lastAt: Number(src.lastAt) || 0,
    rounds: Math.max(1, Math.floor(num(src.rounds, 1))),
    incomplete: src.incomplete === true,
  };
}

function sanitizeTrades(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t === 'object' && String(t.secid || '') && (t.side === 'buy' || t.side === 'sell'))
    .slice(-PAPER_TRADES_KEEP)
    .map((t) => ({
      ...t,
      ts: Number(t.ts) || 0,
      price: num(t.price),
      shares: Math.floor(num(t.shares)),
      amount: round2(t.amount),
      fee: round2(t.fee),
    }));
}

/**
 * 老账户没有 realized 字段时，用成交流水按同一成本算法回填。
 * 卖出股数超过回放可用买入（老版本只保留 200 笔、更早的买入丢了）的标的，
 * 标 incomplete 并**不给数字**（返回前从账本里删掉），避免展示假收益。
 */
function backfillRealized(trades) {
  const list = (Array.isArray(trades) ? trades : [])
    .filter((t) => t && t.ts > 0 && t.price > 0 && t.shares > 0)
    .slice()
    .sort((a, b) => a.ts - b.ts);
  const replay = {};
  const ledger = {};
  const incomplete = new Set();
  for (const t of list) {
    const secid = String(t.secid);
    const shares = Math.floor(num(t.shares));
    const amount = num(t.price) * shares;
    const fee = num(t.fee) >= 0 && t.fee !== undefined && t.fee !== null
      ? num(t.fee)
      : feeOf(amount);
    if (t.side === 'buy') {
      const pos = replay[secid];
      if (pos) {
        const newShares = pos.shares + shares;
        const newCost = (pos.cost * pos.shares + amount + fee) / newShares;
        replay[secid] = { shares: newShares, cost: round4(newCost) };
      } else {
        replay[secid] = { shares, cost: round4((amount + fee) / shares) };
      }
      continue;
    }
    const pos = replay[secid];
    if (!pos || pos.shares < shares) { incomplete.add(secid); continue; }
    const costBasis = round2(pos.cost * shares);
    const realized = round2((amount - fee) - costBasis);
    const cur = ledger[secid] || {
      secid, code: String(t.code || ''), name: String(t.name || ''),
      sellShares: 0, sellAmount: 0, costBasis: 0, realized: 0, lastAt: 0, rounds: 1, incomplete: false,
    };
    cur.sellShares += shares;
    cur.sellAmount = round2(cur.sellAmount + amount);
    cur.costBasis = round2(cur.costBasis + costBasis);
    cur.realized = round2(cur.realized + realized);
    cur.lastAt = t.ts;
    cur.code = String(t.code || cur.code || '');
    cur.name = String(t.name || cur.name || '');
    ledger[secid] = cur;
    const remain = pos.shares - shares;
    if (remain <= 0) delete replay[secid];
    else replay[secid] = { ...pos, shares: remain };
  }
  for (const secid of incomplete) {
    delete ledger[secid];
  }
  return { ledger, incomplete: [...incomplete] };
}

/**
 * 账户归一化（读取即兼容）：
 * - 缺 initial / cash / positions / trades / capital 的老账户回退到安全默认；
 * - realized 字段不存在时按成交流水回填；
 * - 成交保留最近 PAPER_TRADES_KEEP 笔（展示仍只给最近 50 笔）。
 */
function normalizeAccount(raw, { globalInitial = 1000000 } = {}) {
  const base = emptyAccount(globalInitial);
  if (!raw || typeof raw !== 'object') return base;
  const initial = Number.isFinite(Number(raw.initial)) && Number(raw.initial) > 0
    ? Number(raw.initial) : base.initial;
  const cash = Number.isFinite(Number(raw.cash)) ? Number(raw.cash) : initial;
  const positions = sanitizePositions(raw.positions);
  const trades = sanitizeTrades(raw.trades);
  const capital = sanitizeCapital(raw.capital);
  let realized = {};
  let incomplete = [];
  if (raw.realized && typeof raw.realized === 'object' && !Array.isArray(raw.realized)) {
    for (const [secid, entry] of Object.entries(raw.realized)) {
      if (!entry || typeof entry !== 'object') continue;
      const row = sanitizeLedgerEntry(secid, entry);
      // 只保留「有卖出记录」或「已不止一轮」的账本，空壳不进数据
      if (row.sellShares > 0 || row.rounds > 1) realized[secid] = row;
    }
  } else {
    const back = backfillRealized(trades);
    realized = back.ledger;
    incomplete = back.incomplete;
  }
  return {
    initial,
    cash,
    positions,
    trades,
    realized,
    capital,
    updatedAt: Number(raw.updatedAt) || null,
    realizedIncomplete: incomplete,
  };
}

function cloneAccount(account) {
  return {
    initial: account.initial,
    cash: account.cash,
    positions: { ...(account.positions || {}) },
    trades: [...(account.trades || [])],
    realized: { ...(account.realized || {}) },
    capital: {
      injected: num((account.capital || {}).injected),
      events: [...(((account.capital || {}).events) || [])],
    },
    updatedAt: account.updatedAt || null,
    realizedIncomplete: [...(account.realizedIncomplete || [])],
  };
}

/* ---------------- 成交 ---------------- */

function makeTradeId(ts = Date.now()) {
  return `t-${ts}-${Math.floor(Math.random() * 9999)}`;
}

function newLedgerEntry(secid, code, name, rounds = 1) {
  return {
    secid,
    code: String(code || secid.split('.')[1] || ''),
    name: String(name || ''),
    sellShares: 0,
    sellAmount: 0,
    costBasis: 0,
    realized: 0,
    lastAt: 0,
    rounds: Math.max(1, rounds),
    incomplete: false,
  };
}

/**
 * 买入（调用方已取到 live 报价并校验过 lot / shares）。
 * 资金不足返回 { error }，绝不修改入参账户。
 */
function applyBuy(account, { quote, shares: rawShares, note = '', signal = null, ratio, clientOrderId, fees, at } = {}) {
  const acc = cloneAccount(account);
  const secid = String((quote && quote.secid) || '');
  const price = num(quote && quote.price);
  const shares = Math.floor(num(rawShares));
  if (!secid || !(price > 0)) return { error: { status: 400, message: '取不到最新价，稍后再试' } };
  if (!(shares > 0)) return { error: { status: 400, message: '股数必须是正整数' } };
  if (shares > MAX_SHARES_PER_ORDER) return { error: { status: 400, message: '单笔股数过大' } };
  const f = normalizeFees(fees);
  const lot = lotOf(secid);
  if (shares % lot !== 0) return { error: { status: 400, message: `A 股 / 场内 ETF 买入需 ${lot} 股整数倍` } };
  const ts = Number(at) || Date.now();
  const amount = price * shares;
  const commission = feeOf(amount, f);
  const cost = amount + commission;
  if (cost > acc.cash + CASH_EPS) {
    const max = maxBuyShares({ price, cash: acc.cash, lot, fees: f });
    return {
      error: {
        status: 400,
        message: max.shares > 0
          ? `可用资金不足（需要 ${round2(cost).toFixed(2)} 元，现有 ${round2(acc.cash).toFixed(2)} 元），最多可买 ${max.shares} 股`
          : `可用资金不足一手（现价 ${round3(price)} 元，每手约 ${round2(price * lot).toFixed(0)} 元）`,
      },
    };
  }
  acc.cash = Math.max(0, round2(acc.cash - cost));
  const code = String((quote && quote.code) || secid.split('.')[1] || '');
  const name = String((quote && quote.name) || '');
  const pos = acc.positions[secid];
  if (pos) {
    const newShares = pos.shares + shares;
    const newCost = (pos.cost * pos.shares + amount + commission) / newShares;
    acc.positions[secid] = { ...pos, code: code || pos.code, name: name || pos.name, shares: newShares, cost: round4(newCost) };
  } else {
    acc.positions[secid] = { code, name, shares, cost: round4((amount + commission) / shares) };
    // 重新建仓：保留历史已实现账本（累计收益跨轮次累计），只把轮次 +1
    const ledger = acc.realized[secid];
    if (ledger) {
      acc.realized[secid] = {
        ...ledger,
        code: code || ledger.code,
        name: name || ledger.name,
        rounds: Math.max(1, num(ledger.rounds, 1) + 1),
      };
    } else {
      acc.realized[secid] = newLedgerEntry(secid, code, name, 1);
    }
  }
  const trade = {
    id: makeTradeId(ts),
    ts,
    secid,
    code,
    name,
    side: 'buy',
    price: round3(price),
    shares,
    amount: round2(amount),
    fee: round2(commission),
    commission: round2(commission),
    tax: 0,
    costBasis: null,
    realized: null,
    realizedPct: null,
    note: String(note || '').slice(0, 80),
    ...(ratio ? { ratio: Number(ratio) } : {}),
    ...(clientOrderId ? { clientOrderId: String(clientOrderId).slice(0, 64) } : {}),
    signal: signal && typeof signal === 'object' ? signal : null,
  };
  acc.trades = [...acc.trades, trade].slice(-PAPER_TRADES_KEEP);
  acc.updatedAt = ts;
  return { account: acc, trade };
}

/**
 * 卖出（调用方已校验持仓与整手规则）。
 * 已实现写进成交记录 + 按标的累计账本；清仓保留账本，重买继续累计。
 */
function applySell(account, { quote, shares: rawShares, note = '', signal = null, ratio, clientOrderId, fees, at } = {}) {
  const acc = cloneAccount(account);
  const secid = String((quote && quote.secid) || '');
  const price = num(quote && quote.price);
  const shares = Math.floor(num(rawShares));
  if (!secid || !(price > 0)) return { error: { status: 400, message: '取不到最新价，稍后再试' } };
  if (!(shares > 0)) return { error: { status: 400, message: '股数必须是正整数' } };
  const pos = acc.positions[secid];
  if (!pos || pos.shares < shares) return { error: { status: 400, message: '持仓不足，无法卖出' } };
  const f = normalizeFees(fees);
  const ts = Number(at) || Date.now();
  const amount = price * shares;
  const commission = feeOf(amount, f);
  const tax = taxOf(amount, f);
  const proceeds = amount - commission - tax;
  const costBasis = round2(pos.cost * shares);
  const realized = round2(proceeds - costBasis);
  const realizedPct = costBasis > 0 ? roundPct((realized / costBasis) * 100) : null;
  acc.cash = Math.max(0, round2(acc.cash + proceeds));
  const remain = pos.shares - shares;
  if (remain <= 0) delete acc.positions[secid];
  else acc.positions[secid] = { ...pos, shares: remain };
  const code = String((quote && quote.code) || pos.code || '');
  const name = String((quote && quote.name) || pos.name || '');
  const cur = acc.realized[secid] || newLedgerEntry(secid, code, name, 1);
  acc.realized[secid] = {
    ...cur,
    secid,
    code: code || cur.code,
    name: name || cur.name,
    sellShares: cur.sellShares + shares,
    sellAmount: round2(cur.sellAmount + amount),
    costBasis: round2(cur.costBasis + costBasis),
    realized: round2(cur.realized + realized),
    lastAt: ts,
  };
  const trade = {
    id: makeTradeId(ts),
    ts,
    secid,
    code,
    name,
    side: 'sell',
    price: round3(price),
    shares,
    amount: round2(amount),
    fee: round2(commission + tax),
    commission: round2(commission),
    tax: round2(tax),
    costBasis,
    realized,
    realizedPct,
    note: String(note || '').slice(0, 80),
    ...(ratio ? { ratio: Number(ratio) } : {}),
    ...(clientOrderId ? { clientOrderId: String(clientOrderId).slice(0, 64) } : {}),
    signal: signal && typeof signal === 'object' ? signal : null,
  };
  acc.trades = [...acc.trades, trade].slice(-PAPER_TRADES_KEEP);
  acc.updatedAt = ts;
  return { account: acc, trade };
}

/** 增量资金：现金与累计追加同步增加；本金口径由此变化，但不产生盈亏。 */
function applyCapitalInjection(account, { amount, at, note = '', by = '' } = {}) {
  const acc = cloneAccount(account);
  const amt = round2(amount);
  if (!(amt > 0)) return { error: { status: 400, message: '增量资金必须大于 0' } };
  const ts = Number(at) || Date.now();
  acc.cash = round2(acc.cash + amt);
  acc.capital = {
    injected: round2(acc.capital.injected + amt),
    events: [
      ...acc.capital.events,
      { at: ts, amount: amt, note: String(note || '').slice(0, 60), by: String(by || '').slice(0, 40) },
    ].slice(-50),
  };
  acc.updatedAt = ts;
  return { account: acc, event: acc.capital.events[acc.capital.events.length - 1] };
}

/* ---------------- 汇总 / 持仓行 ---------------- */

function quotePriceOf(quote, cost) {
  const price = num(quote && quote.price);
  if (price > 0) return { price, priceMode: quote && quote.priceMode === 'prevClose' ? 'prevClose' : 'live' };
  const c = num(cost);
  if (c > 0) return { price: c, priceMode: 'cost' };
  return { price: 0, priceMode: 'missing' };
}

function positionRows(account, quoteMap) {
  const qmap = quoteMap instanceof Map ? quoteMap : new Map(Object.entries(quoteMap || {}));
  return Object.entries(account.positions || {}).map(([secid, p]) => {
    const q = qmap.get(secid) || null;
    const priced = quotePriceOf(q, p.cost);
    const price = priced.price;
    const shares = num(p.shares);
    const cost = num(p.cost);
    const mv = price * shares;
    const cv = cost * shares;
    const prevClose = num(q && q.prevClose);
    const ledger = account.realized && account.realized[secid];
    return {
      secid,
      code: p.code || String(secid.split('.')[1] || ''),
      name: p.name || '',
      shares,
      cost,
      price: round3(price),
      priceMode: priced.priceMode,
      pct: q && Number.isFinite(Number(q.pct)) ? Number(q.pct) : null,
      prevClose: prevClose > 0 ? round3(prevClose) : null,
      dayPnl: prevClose > 0 ? round2((price - prevClose) * shares) : null,
      marketValue: round2(mv),
      costValue: round2(cv),
      profit: round2(mv - cv),
      profitPct: cv > 0 ? roundPct(((mv - cv) / cv) * 100) : null,
      realizedAmount: ledger ? round2(ledger.realized) : null,
      realizedPct: ledger && ledger.costBasis > 0 ? roundPct((ledger.realized / ledger.costBasis) * 100) : null,
    };
  }).sort((a, b) => b.marketValue - a.marketValue);
}

/** 账户汇总：本金 = initial + 累计追加；累计盈亏不含追加资金。 */
function accountTotals(account, quoteMap) {
  const positions = positionRows(account, quoteMap);
  let marketValue = 0;
  let costValue = 0;
  let prevCloseCount = 0;
  for (const p of positions) {
    marketValue += p.marketValue;
    costValue += p.costValue;
    if (p.priceMode === 'prevClose') prevCloseCount += 1;
  }
  const injected = num(account.capital && account.capital.injected);
  const principal = round2(num(account.initial) + injected);
  const total = round2(num(account.cash) + marketValue);
  const profit = round2(total - principal);
  const positionProfit = round2(marketValue - costValue);
  return {
    cash: round2(account.cash),
    initial: round2(account.initial),
    injected,
    principal,
    marketValue: round2(marketValue),
    costValue: round2(costValue),
    total,
    profit,
    profitPct: principal > 0 ? roundPct((profit / principal) * 100) : 0,
    positionProfit,
    realizedProfit: round2(profit - positionProfit),
    anyPrevClose: prevCloseCount > 0,
    prevCloseCount,
    positions,
  };
}

/** 个股累计收益表：清仓后仍保留；仍持仓时补「含浮盈总盈亏」。 */
function realizedRows(account, quoteMap) {
  const qmap = quoteMap instanceof Map ? quoteMap : new Map(Object.entries(quoteMap || {}));
  return Object.values(account.realized || {})
    .filter((r) => r && r.sellShares > 0)
    .map((r) => {
      const pos = account.positions && account.positions[r.secid];
      const holding = Boolean(pos && num(pos.shares) > 0);
      let unrealized = null;
      if (holding) {
        const q = qmap.get(r.secid) || null;
        const priced = quotePriceOf(q, pos.cost);
        unrealized = round2((priced.price - num(pos.cost)) * num(pos.shares));
      }
      return {
        secid: r.secid,
        code: r.code || String(r.secid.split('.')[1] || ''),
        name: r.name || '',
        sellShares: r.sellShares,
        sellAmount: round2(r.sellAmount),
        costBasis: round2(r.costBasis),
        realized: round2(r.realized),
        realizedPct: r.costBasis > 0 ? roundPct((r.realized / r.costBasis) * 100) : null,
        avgSellPrice: r.sellShares > 0 ? round3(r.sellAmount / r.sellShares) : null,
        avgCost: r.sellShares > 0 ? round3(r.costBasis / r.sellShares) : null,
        lastAt: r.lastAt || 0,
        rounds: r.rounds || 1,
        holding,
        holdingShares: holding ? num(pos.shares) : 0,
        unrealized,
        totalProfit: holding && unrealized !== null ? round2(r.realized + unrealized) : round2(r.realized),
        incomplete: r.incomplete === true,
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

/* ---------------- 逐日盈亏（盈亏日历 / 资产曲线） ---------------- */

function normalizeBars(list) {
  return (Array.isArray(list) ? list : [])
    .map((c) => ({ d: String((c && c.d) || '').slice(0, 10), c: num(c && c.c) }))
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.d) && c.c > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
}

function clampDays(days) {
  const n = Math.floor(num(days, 800));
  return Math.min(PAPER_DAYS_MAX, Math.max(PAPER_DAYS_MIN, n));
}

/**
 * 从成交流水 + 日线收盘价重建逐日账户盈亏。
 *
 * 关键口径：
 * - 当日盈亏 = 当日收盘总资产 − 上一可用日总资产 − 当日入金（增量资金不算收益）；
 * - 买入当天按「成交后持仓 + 当日收盘」估值，现金按实际成交额/费用推进；
 * - 缺当日 K 线的标的沿用上一收盘；整段没有 K 线的标的按成本价估值并列入 missing；
 * - 只从首笔成交日开始，绝不把开户前的历史算进来。
 */
function reconstructDailyPnl({ account, barsBySecid, days = 800, today } = {}) {
  const acc = account || emptyAccount();
  const todayKey = /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) ? String(today) : shanghaiDateKey();
  const limit = clampDays(days);
  const barMaps = {};
  const missing = [];
  let estimated = false;
  for (const [secid, list] of Object.entries(barsBySecid || {})) {
    const bars = normalizeBars(list);
    if (bars.length) {
      barMaps[secid] = new Map(bars.map((b) => [b.d, b.c]));
    } else if (acc.positions && acc.positions[secid]) {
      missing.push(secid);
      estimated = true;
    }
  }
  for (const secid of Object.keys(acc.positions || {})) {
    if (!barMaps[secid] && !missing.includes(secid)) {
      missing.push(secid);
      estimated = true;
    }
  }
  const trades = (acc.trades || [])
    .filter((t) => t && t.ts > 0 && (t.side === 'buy' || t.side === 'sell') && num(t.shares) > 0 && num(t.price) > 0)
    .slice()
    .sort((a, b) => a.ts - b.ts);
  const injections = (((acc.capital || {}).events) || [])
    .filter((e) => e && e.at > 0 && num(e.amount) > 0)
    .slice()
    .sort((a, b) => a.at - b.at);
  const injectionByDate = new Map();
  for (const e of injections) {
    const d = shanghaiDateKey(e.at);
    injectionByDate.set(d, round2((injectionByDate.get(d) || 0) + num(e.amount)));
  }
  const todayFlow = round2(injectionByDate.get(todayKey) || 0);
  if (!trades.length) {
    return {
      rows: [],
      empty: true,
      startDate: '',
      endDate: todayKey,
      todayFlow,
      missing,
      estimated,
      truncated: false,
      days: limit,
      costValue: null,
      marketValue: null,
      principal: round2(num(acc.initial) + num((acc.capital || {}).injected)),
    };
  }
  const firstTs = trades[0].ts;
  const firstDate = shanghaiDateKey(firstTs);
  const dateSet = new Set();
  for (const t of trades) dateSet.add(shanghaiDateKey(t.ts));
  for (const e of injections) {
    const d = shanghaiDateKey(e.at);
    if (d >= firstDate) dateSet.add(d);
  }
  for (const map of Object.values(barMaps)) {
    for (const d of map.keys()) {
      if (d >= firstDate && d <= todayKey) dateSet.add(d);
    }
  }
  let grid = [...dateSet].filter((d) => d >= firstDate && d <= todayKey).sort();
  const truncated = grid.length > limit;
  if (truncated) grid = grid.slice(-limit);
  // 首个交易日之前的入金只抬基准、不算当日盈亏（日历从首笔成交开始）
  let baseline = num(acc.initial);
  for (const e of injections) {
    if (shanghaiDateKey(e.at) < firstDate) baseline += num(e.amount);
  }
  baseline = round2(baseline);
  let cash = baseline;
  const shares = {};
  const avgCost = {};
  for (const [secid, p] of Object.entries(acc.positions || {})) {
    // 当前持仓只作为成本兜底；股数/成本由回放决定
    avgCost[secid] = num(p.cost);
  }
  const lastClose = {};
  let tradeIdx = 0;
  let injIdx = 0;
  while (injIdx < injections.length && shanghaiDateKey(injections[injIdx].at) < firstDate) injIdx += 1;
  let prevEquity = baseline;
  let lastCostBasis = 0;
  const rows = [];
  for (const d of grid) {
    let flow = 0;
    while (tradeIdx < trades.length && shanghaiDateKey(trades[tradeIdx].ts) <= d) {
      const t = trades[tradeIdx];
      const secid = String(t.secid);
      const price = num(t.price);
      const qty = Math.floor(num(t.shares));
      const amount = price * qty;
      if (t.side === 'buy') {
        cash -= amount + Math.max(5, amount * FEES.rate);
        shares[secid] = (shares[secid] || 0) + qty;
      } else {
        cash += amount - Math.max(5, amount * FEES.rate) - amount * FEES.taxRate;
        shares[secid] = (shares[secid] || 0) - qty;
        if (shares[secid] <= 0) { shares[secid] = 0; delete avgCost[secid]; }
      }
      tradeIdx += 1;
    }
    while (injIdx < injections.length && shanghaiDateKey(injections[injIdx].at) <= d) {
      const e = injections[injIdx];
      cash += num(e.amount);
      if (shanghaiDateKey(e.at) === d) flow += num(e.amount);
      injIdx += 1;
    }
    let mv = 0;
    let costBasis = 0;
    for (const [secid, qty] of Object.entries(shares)) {
      if (!(qty > 0)) continue;
      const barMap = barMaps[secid];
      let price = barMap ? barMap.get(d) : null;
      if (Number.isFinite(price) && price > 0) lastClose[secid] = price;
      else if (Number.isFinite(lastClose[secid])) price = lastClose[secid];
      else if (Number.isFinite(avgCost[secid]) && avgCost[secid] > 0) { price = avgCost[secid]; estimated = true; }
      else price = 0;
      mv += price * qty;
      costBasis += num(avgCost[secid]) * qty;
    }
    const equity = cash + mv;
    lastCostBasis = costBasis;
    const pnl = equity - prevEquity - flow;
    const base = prevEquity;
    rows.push({
      d,
      pnl: round2(pnl),
      pct: base > 0 ? roundPct((pnl / base) * 100) : null,
      mv: round2(equity),
      base: round2(base),
      flow: round2(flow),
    });
    prevEquity = equity;
  }
  const last = rows[rows.length - 1] || null;
  return {
    rows,
    empty: false,
    startDate: rows.length ? rows[0].d : firstDate,
    endDate: last ? last.d : todayKey,
    todayFlow,
    missing,
    estimated,
    truncated,
    days: limit,
    costValue: round2(lastCostBasis),
    marketValue: last ? round2(last.mv - cash) : null,
    cash: round2(cash),
    principal: round2(num(acc.initial) + num((acc.capital || {}).injected)),
  };
}

module.exports = {
  FEES,
  PAPER_TRADES_KEEP,
  PAPER_PNL_MAX_SECIDS,
  PAPER_DAYS_MIN,
  PAPER_DAYS_MAX,
  CASH_EPS,
  normalizeFees,
  lotOf,
  feeOf,
  taxOf,
  buyCostOf,
  sellProceedsOf,
  maxBuyShares,
  normalizeAccount,
  backfillRealized,
  applyBuy,
  applySell,
  applyCapitalInjection,
  positionRows,
  accountTotals,
  realizedRows,
  reconstructDailyPnl,
  shanghaiDateKey,
  round2,
  round3,
  round4,
  roundPct,
  clampDays,
};
