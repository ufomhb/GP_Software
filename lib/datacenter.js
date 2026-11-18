'use strict';

/**
 * 数据中心取数层（阶段 2/3）
 * ---------------------------------------------------------------
 * 把「不属于实时行情、但属于研究/复盘」的数据集中在这里，供 server.js 直接调用：
 *   - 东方财富 datacenter 报表：龙虎榜、限售解禁、分红送转、可转债基本信息
 *   - 新浪 Market_Center：全市场快照（选股器用）
 *   - 腾讯行情：港股报价 / 港股日 K / 港股分时、可转债报价
 *   - 东财 F10：公司概况、主要财务指标、股东研究、分红融资
 *
 * 设计约定：
 *   1) 自成一体（自带 fetch + TTL 缓存），不 import server.js，便于单测；
 *   2) 每个函数失败只抛错，由调用方决定降级文案，不在这里吞错；
 *   3) 单位统一：金额类内部按「元」取数，对外给 *Yi（亿元）字段由调用方格式化，
 *      datacenter 里本来就是「万」的（解禁市值等）在这一层换成元再算。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ---------------- 基础设施 ---------------- */

const CACHE = new Map();

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expireAt) {
    CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  CACHE.set(key, { value, expireAt: Date.now() + ttlMs });
  // 简单的容量上限，避免长期运行把缓存撑爆
  if (CACHE.size > 400) {
    const first = CACHE.keys().next().value;
    if (first !== undefined) CACHE.delete(first);
  }
}

/** 带缓存执行；同 key 并发请求共享同一个 Promise，避免打爆上游 */
function withCache(key, ttlMs, loader) {
  const hit = cacheGet(key);
  if (hit) return Promise.resolve(hit);
  if (PENDING.has(key)) return PENDING.get(key);
  const p = Promise.resolve()
    .then(loader)
    .then((value) => {
      cacheSet(key, value, ttlMs);
      return value;
    })
    .finally(() => PENDING.delete(key));
  PENDING.set(key, p);
  return p;
}

const PENDING = new Map();

async function fetchText(url, { referer, timeout = 15000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
  return res.text();
}

async function fetchJSON(url, opts) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    // 新浪有些接口返回的是 JS 数组字面量（键没有引号），这里补一层宽松解析
    try {
      return JSON.parse(text.replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":'));
    } catch {
      throw new Error('上游返回格式无法解析');
    }
  }
}

/**
 * 腾讯 qt.gtimg.cn 返回的是 **GBK** 编码，直接 res.text() 会得到乱码（如「腾讯控股」变问号）。
 * Node 自带 full-icu，TextDecoder('gbk') 可用；万一环境不支持就退回 UTF-8 文本。
 */
async function fetchTextGbk(url, { referer, timeout = 15000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return Buffer.from(buf).toString('utf8');
  }
}

function num(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

/** 日期统一成 YYYY-MM-DD（datacenter 返回 '2026-11-18 00:00:00'） */
function dayText(v) {
  const s = String(v || '');
  return s.slice(0, 10);
}

/** 元 → 亿 */
function toYi(v) {
  const n = num(v);
  return n === null ? null : round(n / 1e8, 2);
}

/** datacenter 里以「万」为单位的数 → 元 */
function wanToYuan(v) {
  const n = num(v);
  return n === null ? null : n * 1e4;
}

/* ---------------- 东财 datacenter 报表 ---------------- */

/**
 * 通用报表查询。
 * @param {string} reportName 报表名，如 RPT_DAILYBILLBOARD_DETAILSNEW
 * @param {object} opts columns / pageSize / pageNumber / sortColumns / sortTypes / filter
 */
async function report(reportName, opts = {}) {
  const {
    columns = 'ALL', pageSize = 50, pageNumber = 1, sortColumns, sortTypes, filter,
  } = opts;
  const params = new URLSearchParams({
    reportName,
    columns,
    pageNumber: String(pageNumber),
    pageSize: String(pageSize),
    source: 'WEB',
    client: 'WEB',
  });
  if (sortColumns) params.set('sortColumns', sortColumns);
  if (sortTypes) params.set('sortTypes', sortTypes);
  if (filter) params.set('filter', filter);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${params.toString()}`;
  const json = await fetchJSON(url, { referer: 'https://data.eastmoney.com/' });
  if (!json || json.success === false || !json.result) {
    throw new Error((json && json.message) || '数据中心暂无数据');
  }
  return {
    rows: Array.isArray(json.result.data) ? json.result.data : [],
    pages: num(json.result.pages) || 1,
  };
}

/* ---------------- 龙虎榜 ---------------- */

/** 归一化一条龙虎榜记录 */
function normLonghuRow(r) {
  const buy = num(r.BILLBOARD_BUY_AMT);
  const sell = num(r.BILLBOARD_SELL_AMT);
  const net = buy !== null && sell !== null ? buy - sell : null;
  return {
    date: dayText(r.TRADE_DATE),
    code: String(r.SECURITY_CODE || ''),
    secucode: String(r.SECUCODE || ''),
    name: String(r.SECURITY_NAME_ABBR || ''),
    close: num(r.CLOSE_PRICE),
    pct: num(r.CHANGE_RATE),
    turnover: num(r.TURNOVERRATE),
    buyYi: toYi(buy),
    sellYi: toYi(sell),
    netYi: toYi(net),
    dealYi: toYi(r.BILLBOARD_DEAL_AMT),
    dealRatio: num(r.DEAL_AMOUNT_RATIO),
    reason: String(r.EXPLANATION || ''),
    seatNote: String(r.EXPLAIN || ''),
  };
}

/**
 * 每日龙虎榜。
 * @param {object} opts date（YYYY-MM-DD，缺省取最近一个交易日）limit
 */
async function longhuBoard(opts = {}) {
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 40));
  const key = `longhu:${opts.date || 'latest'}:${limit}`;
  return withCache(key, 300000, async () => {
    const filter = opts.date ? `(TRADE_DATE='${String(opts.date).slice(0, 10)}')` : '';
    // 先按交易日倒序取一页，确定「最近交易日」；再按净买额排序取完整清单
    if (!opts.date) {
      const probe = await report('RPT_DAILYBILLBOARD_DETAILSNEW', { pageSize: 1, sortColumns: 'TRADE_DATE', sortTypes: '-1', filter });
      const latest = probe.rows.length ? dayText(probe.rows[0].TRADE_DATE) : '';
      if (!latest) throw new Error('龙虎榜暂无数据');
      return longhuBoard({ date: latest, limit });
    }
    const { rows } = await report('RPT_DAILYBILLBOARD_DETAILSNEW', {
      pageSize: limit,
      sortColumns: 'BILLBOARD_DEAL_AMT,TRADE_DATE',
      sortTypes: '-1,-1',
      filter,
    });
    const items = rows.map(normLonghuRow).filter((x) => x.code);
    const total = items.reduce((s, x) => s + (x.netYi || 0), 0);
    return {
      date: opts.date,
      items,
      count: items.length,
      netTotalYi: round(total, 2),
      note: '龙虎榜为交易所公开的席位成交披露，买卖金额是上榜席位合计，不等于全部成交。',
    };
  });
}

/** 某只股票的龙虎榜上榜历史（按交易日倒序） */
async function longhuStock(code, opts = {}) {
  const c = String(code || '').replace(/[^0-9]/g, '');
  if (!c) throw new Error('缺少股票代码');
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 12));
  return withCache(`longhus:${c}:${limit}`, 600000, async () => {
    const { rows } = await report('RPT_DAILYBILLBOARD_DETAILSNEW', {
      pageSize: limit,
      sortColumns: 'TRADE_DATE',
      sortTypes: '-1',
      filter: `(SECURITY_CODE="${c}")`,
    });
    const items = rows.map(normLonghuRow).filter((x) => x.date);
    return {
      code: c,
      name: items.length ? items[0].name : '',
      items,
      count: items.length,
    };
  });
}

/* ---------------- 财经日历：解禁 / 分红 / 可转债 ---------------- */

/** 限售解禁（只看今天及之后的解禁，按解禁日升序） */
async function calendarLift(opts = {}) {
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 30));
  // 不传日期时用「今天」，避免按 FREE_DATE 升序把 2010 年的历史解禁排在前面
  const since = String(opts.since || new Date().toISOString().slice(0, 10));
  return withCache(`lift:${limit}:${since}`, 900000, async () => {
    const { rows } = await report('RPT_LIFT_STAGE', {
      pageSize: limit,
      sortColumns: 'FREE_DATE',
      sortTypes: '1',
      filter: `(FREE_DATE>='${since}')`,
    });
    const items = rows.map((r) => {
      const sharesWan = num(r.FREE_SHARES);
      const price = num(r.NEW);
      // 报表的 LIFT_MARKET_CAP 有时为空或口径不一，能用「份额 × 价格」时以它为准
      const calcYi = sharesWan !== null && price !== null ? round((sharesWan * price) / 10000, 2) : null;
      return {
        code: String(r.SECURITY_CODE || ''),
        secucode: String(r.SECUCODE || ''),
        name: String(r.SECURITY_NAME_ABBR || ''),
        date: dayText(r.FREE_DATE),
        sharesWan,
        ableSharesWan: num(r.ABLE_FREE_SHARES),
        marketYi: calcYi !== null ? calcYi : toYi(wanToYuan(r.LIFT_MARKET_CAP)),
        freeRatio: num(r.FREE_RATIO),
        totalRatio: num(r.TOTAL_RATIO),
        type: String(r.FREE_SHARES_TYPE || ''),
        market: String(r.MARKET_TYPE || ''),
        price,
      };
    }).filter((x) => x.code && x.date);
    return { items, count: items.length, since, note: '解禁市值按「解禁份额 × 最新价」估算；能解禁的份额与全部份额不同，不等于可立即抛售的量。' };
  });
}

/** 分红送转（按公告日倒序） */
async function calendarBonus(opts = {}) {
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 30));
  return withCache(`bonus:${limit}`, 900000, async () => {
    const { rows } = await report('RPT_SHAREBONUS_DET', {
      pageSize: limit,
      sortColumns: 'NOTICE_DATE',
      sortTypes: '-1',
    });
    const items = rows.map((r) => ({
      code: String(r.SECURITY_CODE || ''),
      name: String(r.SECURITY_NAME_ABBR || ''),
      plan: String(r.IMPL_PLAN_PROFILE || ''),
      cashPer10: num(r.PRETAX_BONUS_RMB),
      bonusPer10: num(r.BONUS_IT_RATIO),
      progress: String(r.ASSIGN_PROGRESS || ''),
      noticeDate: dayText(r.NOTICE_DATE || r.PLAN_NOTICE_DATE),
      recordDate: dayText(r.EQUITY_RECORD_DATE),
      exDate: dayText(r.EX_DIVIDEND_DATE),
      reportDate: dayText(r.REPORT_DATE),
    })).filter((x) => x.code);
    return { items, count: items.length, note: '现金分红为税前每 10 股派息；实施进度以公司公告为准。' };
  });
}

/** 可转债列表（基本信息，按上市日倒序） */
async function convertibleList(opts = {}) {
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 40));
  return withCache(`cb:${limit}`, 900000, async () => {
    const { rows } = await report('RPT_BOND_CB_LIST', {
      pageSize: limit,
      sortColumns: 'LISTING_DATE',
      sortTypes: '-1',
    });
    const items = rows.map((r) => ({
      code: String(r.SECURITY_CODE || ''),
      secucode: String(r.SECUCODE || ''),
      name: String(r.SECURITY_NAME_ABBR || ''),
      stockCode: String(r.CONVERT_STOCK_CODE || ''),
      rating: String(r.RATING || ''),
      listingDate: dayText(r.LISTING_DATE),
      expireDate: dayText(r.EXPIRE_DATE),
      delistDate: dayText(r.DELIST_DATE),
      issueYi: num(r.ACTUAL_ISSUE_SCALE),
      issuePrice: num(r.ISSUE_PRICE),
      // 报表没有实时价格，调用方需要配合 convertibleQuotes 才有行情
      price: null,
      pct: null,
    })).filter((x) => {
      // 只留沪深挂牌的存续可转债：NQ/退市债/没有上市日的都不要
      if (!x.code || !/\.(SH|SZ)$/i.test(x.secucode)) return false;
      if (!/^(11|12)/.test(x.code)) return false;
      if (x.delistDate || !x.listingDate) return false;
      if (/退/.test(x.name)) return false;
      return true;
    });
    return { items, count: items.length, note: '可转债列表来自东财数据中心，价格由腾讯行情补全；已剔除退市债与银行间/NQ 品种。' };
  });
}

/** 用腾讯行情补可转债报价（一次最多 30 只） */
async function convertibleQuotes(codes) {
  const list = [...new Set((codes || []).map((c) => String(c).trim()).filter((c) => /^\d{6}$/.test(c)))].slice(0, 30);
  if (!list.length) return {};
  const sinaCodes = list.map((c) => (String(c).startsWith('11') ? `sh${c}` : `sz${c}`));
  return withCache(`cbq:${list.join(',')}`, 30000, async () => {
    // 腾讯 gtimg 是 GBK，必须按 GBK 解码，否则名称会变成乱码
    const text = await fetchTextGbk(`https://qt.gtimg.cn/q=${sinaCodes.join(',')}`, { referer: 'https://gu.qq.com/' });
    const map = {};
    for (const line of String(text).split(';')) {
      const m = /v_([a-z]{2}\d{6})="([^"]*)"/.exec(line.trim());
      if (!m) continue;
      const parts = m[2].split('~');
      const code = parts[2];
      if (!code) continue;
      map[code] = {
        code,
        name: parts[1],
        price: num(parts[3]),
        prevClose: num(parts[4]),
        pct: num(parts[32]) !== null ? num(parts[32]) : null,
        volume: num(parts[6]),
        amountWan: num(parts[37]),
      };
    }
    return map;
  });
}

/* ---------------- 新浪全市场（选股器） ---------------- */

/** hs_a 全市场股票数量 */
async function sinaStockCount(node = 'hs_a') {
  return withCache(`sinacount:${node}`, 600000, async () => {
    try {
      const text = await fetchText(
        `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=${node}`,
        { referer: 'https://finance.sina.com.cn/' },
      );
      const n = num(String(text).replace(/[^\d.]/g, ''));
      return n || null;
    } catch {
      return null;
    }
  });
}

/** 新浪一页全市场快照 */
async function sinaMarketPage(page = 1, pageSize = 80, sort = 'amount', asc = 0, node = 'hs_a') {
  const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
    + `?page=${page}&num=${pageSize}&sort=${sort}&asc=${asc}&node=${node}&symbol=&_s_r_a=page`;
  const rows = await fetchJSON(url, { referer: 'https://finance.sina.com.cn/' });
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    code: String(r.code || ''),
    symbol: String(r.symbol || ''),
    name: String(r.name || ''),
    price: num(r.trade),
    change: num(r.pricechange),
    pct: num(r.changepercent),
    volume: num(r.volume),
    amountYi: toYi(r.amount),
    turnover: num(r.turnoverratio),
    pe: num(r.per),
    pb: num(r.pb),
    // 新浪 mktcap / nmc 单位是「万元」
    mktCapYi: toYi(wanToYuan(r.mktcap)),
    floatCapYi: toYi(wanToYuan(r.nmc)),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
  })).filter((x) => x.code && x.price !== null);
}

/** 分页并发扫描全市场（选股器用；结果缓存 10 分钟） */
async function sinaAllStocks(opts = {}) {
  const maxPages = Math.min(80, Math.max(1, Number(opts.maxPages) || 70));
  const pageSize = Math.min(100, Math.max(40, Number(opts.pageSize) || 80));
  return withCache(`sinaall:${maxPages}:${pageSize}`, 600000, async () => {
    const items = [];
    let cursor = 1;
    const workers = Array.from({ length: 4 }, async () => {
      while (cursor <= maxPages) {
        const page = cursor++;
        try {
          const rows = await sinaMarketPage(page, pageSize);
          if (rows.length) items.push(...rows);
          if (rows.length < pageSize) cursor = maxPages + 1; // 最后一页之后不再翻
        } catch {
          // 单页失败不影响整体：少几页只是样本略小，页面上会标出实际样本量
        }
      }
    });
    await Promise.all(workers);
    return items;
  });
}

/** 选股条件归一化 + 过滤（纯函数，便于单测） */
function screenStocks(items, conds = {}) {
  const c = conds || {};
  const inRange = (v, min, max) => {
    if (min !== null && min !== undefined && (v === null || v === undefined || v < Number(min))) return false;
    if (max !== null && max !== undefined && (v === null || v === undefined || v > Number(max))) return false;
    return true;
  };
  const numOr = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const result = (items || []).filter((x) => {
    if (c.excludeSt !== false && /ST|退/i.test(x.name)) return false;
    if (c.board && !String(x.code).startsWith(c.board)) return false;
    if (!inRange(x.pct, numOr(c.pctMin), numOr(c.pctMax))) return false;
    if (!inRange(x.turnover, numOr(c.turnoverMin), numOr(c.turnoverMax))) return false;
    if (!inRange(x.amountYi, numOr(c.amountMinYi), numOr(c.amountMaxYi))) return false;
    if (!inRange(x.mktCapYi, numOr(c.capMinYi), numOr(c.capMaxYi))) return false;
    if (!inRange(x.floatCapYi, numOr(c.floatCapMinYi), numOr(c.floatCapMaxYi))) return false;
    // PE / PB：负数与缺失都视为「无法评估」，只有当条件里明确要 PE 区间时才剔除
    const peMin = numOr(c.peMin);
    const peMax = numOr(c.peMax);
    if (peMin !== null || peMax !== null) {
      if (x.pe === null || x.pe <= 0) return false;
      if (peMin !== null && x.pe < peMin) return false;
      if (peMax !== null && x.pe > peMax) return false;
    }
    const pbMin = numOr(c.pbMin);
    const pbMax = numOr(c.pbMax);
    if (pbMin !== null || pbMax !== null) {
      if (x.pb === null || x.pb <= 0) return false;
      if (pbMin !== null && x.pb < pbMin) return false;
      if (pbMax !== null && x.pb > pbMax) return false;
    }
    if (c.priceMin !== null && c.priceMin !== undefined && x.price < Number(c.priceMin)) return false;
    if (c.priceMax !== null && c.priceMax !== undefined && x.price > Number(c.priceMax)) return false;
    return true;
  });
  const sort = c.sort || 'pct';
  const dir = c.sortDir === 'asc' ? 1 : -1;
  const keyOf = { pct: 'pct', amount: 'amountYi', turnover: 'turnover', cap: 'mktCapYi', pe: 'pe', pb: 'pb' }[sort] || 'pct';
  result.sort((a, b) => {
    const av = a[keyOf] === null ? -Infinity : a[keyOf];
    const bv = b[keyOf] === null ? -Infinity : b[keyOf];
    return (av - bv) * dir;
  });
  return result;
}

/* ---------------- 港股（腾讯） ---------------- */

function hkCode(code) {
  const s = String(code || '').toUpperCase().replace(/[^0-9]/g, '');
  if (!s) throw new Error('缺少港股代码');
  return `hk${s.padStart(5, '0')}`;
}

/** 港股报价（腾讯 gtimg，GBK 编码；字段位置与 A 股同一套） */
async function hkQuote(code) {
  const sym = hkCode(code);
  return withCache(`hkq:${sym}`, 20000, async () => {
    const text = await fetchTextGbk(`https://qt.gtimg.cn/q=${sym}`, { referer: 'https://gu.qq.com/' });
    const m = /v_hk\d+="([^"]*)"/.exec(text);
    if (!m) throw new Error('未获取到港股报价');
    const p = m[1].split('~');
    return {
      code: String(code).replace(/[^0-9]/g, ''),
      symbol: sym,
      market: 'HK',
      name: p[1],
      price: num(p[3]),
      prevClose: num(p[4]),
      open: num(p[5]),
      change: num(p[31]),
      pct: num(p[32]),
      high: num(p[33]),
      low: num(p[34]),
      amountYi: toYi(num(p[37]) === null ? null : Number(p[37]) * 1e4),
      updatedAt: Date.now(),
    };
  });
}

/** 港股日 K（腾讯 hkfqkline，支持前复权） */
async function hkKline(code, opts = {}) {
  const sym = hkCode(code);
  const limit = Math.min(320, Math.max(20, Number(opts.limit) || 160));
  const tag = opts.fqt === 2 ? 'hfq' : opts.fqt === 0 ? '' : 'qfq';
  return withCache(`hkk:${sym}:${limit}:${tag}`, 180000, () => fetchHkKline(sym, limit, tag));
}

async function fetchHkKline(sym, limit, tag) {
  const param = `${sym},day,,,${limit},${tag}`;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=${encodeURIComponent(param)}`;
  const json = await fetchJSON(url, { referer: 'https://gu.qq.com/' });
  const node = json && json.data ? json.data[sym] : null;
  const rows = node ? (node.qfqday || node.hfqday || node.day) : null;
  if (!Array.isArray(rows) || !rows.length) throw new Error('暂无港股 K 线数据');
  const candles = rows.map((r) => ({
    d: String(r[0]),
    o: num(r[1]),
    c: num(r[2]),
    h: num(r[3]),
    l: num(r[4]),
    v: num(r[5]),
  })).filter((c) => c.c !== null).slice(-limit);
  if (!candles.length) throw new Error('港股 K 线数据不完整');
  return { symbol: sym, limit, candles, tag: tag || 'bfq', updatedAt: Date.now() };
}

/** 港股分时（腾讯 minute/query，09:30–16:00） */
async function hkMinute(code) {
  const sym = hkCode(code);
  return withCache(`hkm:${sym}`, 30000, async () => {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(sym)}`;
    const json = await fetchJSON(url, { referer: 'https://gu.qq.com/' });
    const node = json && json.data ? json.data[sym] : null;
    const raw = node && node.data && Array.isArray(node.data.data) ? node.data.data : [];
    const points = raw.map((line) => {
      const parts = String(line).trim().split(/\s+/);
      if (parts.length < 2) return null;
      const t = String(parts[0]).padStart(4, '0');
      const price = num(parts[1]);
      if (price === null) return null;
      return [`${t.slice(0, 2)}:${t.slice(2, 4)}`, price];
    }).filter(Boolean);
    return {
      symbol: sym,
      points,
      prevClose: node && node.qt ? num(node.qt[sym] && node.qt[sym][4]) : null,
      updatedAt: Date.now(),
    };
  });
}

/* ---------------- 东财 F10 ---------------- */

/** secid → F10 需要的 SH600519 / SZ000001 形式 */
function f10CodeFromSecid(secid, code) {
  const c = String(code || '').replace(/[^0-9]/g, '') || String(secid || '').split('.')[1] || '';
  if (!c) throw new Error('缺少股票代码');
  const market = String(secid || '').startsWith('1.') ? 'SH' : 'SZ';
  return `${market}${c}`;
}

async function fetchF10Json(path, f10Code, referer = 'https://emweb.securities.eastmoney.com/') {
  const text = await fetchText(`https://emweb.securities.eastmoney.com/PC_HSF10/${path}`, { referer, timeout: 15000 });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('F10 返回格式异常');
  }
}

/** 公司概况 */
async function f10Survey(secid, code) {
  const c = f10CodeFromSecid(secid, code);
  return withCache(`f10s:${c}`, 3600000, async () => {
    const json = await fetchF10Json(`CompanySurvey/PageAjax?code=${c}`, c);
    const base = (json && json.jbzl && json.jbzl[0]) || {};
    return {
      code: c.slice(2),
      f10Code: c,
      name: String(base.ORG_NAME_ABBR || base.SECURITY_NAME_ABBR || ''),
      fullName: String(base.ORG_NAME || ''),
      industry: String(base.EM2016 || base.INDUSTRYCSRC1 || ''),
      area: String(base.REGION || ''),
      listDate: dayText(base.LISTING_DATE),
      chairman: String(base.CHAIRMAN || ''),
      website: String(base.ORG_WEB || ''),
      profile: String(base.ORG_PROFILE || '').slice(0, 600),
      business: String(base.MAIN_BUSINESS || ''),
    };
  });
}

/** 主要财务指标（最近若干期） */
async function f10Finance(secid, code, opts = {}) {
  const c = f10CodeFromSecid(secid, code);
  const count = Math.min(12, Math.max(1, Number(opts.count) || 6));
  return withCache(`f10f:${c}:${count}`, 3600000, async () => {
    const json = await fetchF10Json(`NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${c}`, c);
    const rows = Array.isArray(json && json.data) ? json.data : [];
    const items = rows.slice(0, count).map((r) => ({
      period: dayText(r.REPORT_DATE),
      reportName: String(r.REPORT_DATE_NAME || ''),
      revenueYi: toYi(r.TOTALOPERATEREVE),
      revenueYoy: num(r.TOTALOPERATEREVETZ),
      profitYi: toYi(r.PARENTNETPROFIT),
      profitYoy: num(r.PARENTNETPROFITTZ),
      eps: num(r.EPSJB),
      bps: num(r.BPS),
      roe: num(r.ROEJQ),
      grossMargin: num(r.XSMLL),
      netMargin: num(r.XSJLL),
      debtRatio: num(r.ZCFZL),
    })).filter((x) => x.period);
    return { code: c.slice(2), items, count: items.length };
  });
}

/** 股东研究：股东户数 + 十大股东 */
async function f10Shareholders(secid, code) {
  const c = f10CodeFromSecid(secid, code);
  return withCache(`f10h:${c}`, 3600000, async () => {
    const json = await fetchF10Json(`ShareholderResearch/PageAjax?code=${c}`, c);
    const holders = Array.isArray(json && json.gdrs) ? json.gdrs : [];
    const top = Array.isArray(json && json.sdgd) ? json.sdgd : [];
    return {
      code: c.slice(2),
      holderCount: holders.slice(0, 3).map((r) => ({ date: dayText(r.END_DATE), count: num(r.HOLDER_NUM) })),
      top10: top.slice(0, 10).map((r) => ({
        date: dayText(r.END_DATE),
        name: String(r.HOLDER_NAME || ''),
        sharesWan: num(r.HOLD_NUM),
        ratio: num(r.HOLD_RATIO),
        change: String(r.HOLD_NUM_CHANGE || ''),
      })),
    };
  });
}

/** 分红融资：分红历史 */
async function f10Bonus(secid, code, opts = {}) {
  const c = f10CodeFromSecid(secid, code);
  const count = Math.min(20, Math.max(1, Number(opts.count) || 8));
  return withCache(`f10b:${c}:${count}`, 3600000, async () => {
    const json = await fetchF10Json(`BonusFinancing/PageAjax?code=${c}`, c);
    const rows = Array.isArray(json && json.fhyx) ? json.fhyx : [];
    return {
      code: c.slice(2),
      items: rows.slice(0, count).map((r) => ({
        date: dayText(r.EX_DIVIDEND_DATE || r.NOTICE_DATE),
        profile: String(r.IMPL_PLAN_PROFILE || r.PLAN_PROFILE || ''),
        cashPer10: num(r.PRETAX_BONUS_RMB),
        bonusPer10: num(r.BONUS_IT_RATIO),
        progress: String(r.ASSIGN_PROGRESS || r.PROGRESS || ''),
      })),
    };
  });
}

/** F10 聚合：一次返回概况 / 财务 / 股东 / 分红，任一块失败只影响自己 */
async function f10(secid, code) {
  const parts = await Promise.allSettled([
    f10Survey(secid, code),
    f10Finance(secid, code),
    f10Shareholders(secid, code),
    f10Bonus(secid, code),
  ]);
  const pick = (i) => (parts[i].status === 'fulfilled' ? parts[i].value : null);
  const survey = pick(0);
  return {
    code: (survey && survey.code) || String(code || '').replace(/[^0-9]/g, ''),
    survey,
    finance: pick(1),
    shareholders: pick(2),
    bonus: pick(3),
    updatedAt: Date.now(),
  };
}

module.exports = {
  // 报表
  report,
  longhuBoard,
  longhuStock,
  calendarLift,
  calendarBonus,
  convertibleList,
  convertibleQuotes,
  // 全市场 / 选股
  sinaStockCount,
  sinaMarketPage,
  sinaAllStocks,
  screenStocks,
  // 港股
  hkQuote,
  hkKline,
  hkMinute,
  // F10
  f10,
  f10Survey,
  f10Finance,
  f10Shareholders,
  f10Bonus,
  // 工具（单测用）
  _internals: { num, round, toYi, wanToYuan, dayText, normLonghuRow, screenStocks },
};
