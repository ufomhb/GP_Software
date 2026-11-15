'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exec } = require('node:child_process');
const crypto = require('node:crypto');

const { computeSeries } = require('./lib/indicators');
const { analyze, stockAdvice, marketAdvice, aggregateNews, shanghaiToday, nf, pctText } = require('./lib/engine');
const {
  CAPABILITIES: SOURCE_CAPABILITIES,
  register: registerSource,
  run: runSource,
  runProvider: runSourceProvider,
  status: sourceStatus,
  probe: probeSource,
  getConfig: getSourceConfig,
  saveConfig: saveSourceConfig,
  labelFor: sourceLabel,
} = require('./lib/source');
const {
  emQuotes,
  tencentQuotes,
  sinaQuotes,
  thsQuotes,
  emSectors,
  sinaSectors,
  emStockFlow,
  sinaStockFlow,
  emRank,
  sinaRank,
  emNews,
  sinaNews,
} = require('./lib/marketdata');

const PORT = Number(
  (process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || process.env.PORT || 8090,
);
// 默认监听所有网卡：这样手机连同一个 Wi-Fi 就能直接打开。只想本机访问时用 --host=127.0.0.1。
const HOST =
  (process.argv.find((a) => a.startsWith('--host=')) || '').split('=')[1] || process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = '1.5.0';

// 局域网访问用：列出本机所有非内网回环的 IPv4，手机连同一个 Wi-Fi 就能打开。
function lanAddresses() {
  const out = [];
  let ifaces = {};
  try { ifaces = os.networkInterfaces() || {}; } catch { return out; }
  for (const [name, list] of Object.entries(ifaces)) {
    for (const item of list || []) {
      if (!item || item.internal) continue;
      const family = typeof item.family === 'string' ? item.family : `IPv${item.family}`;
      if (family !== 'IPv4') continue;
      if (/^(127\.|169\.254\.)/.test(item.address)) continue;
      out.push({ name, address: item.address });
    }
  }
  return out;
}

function accessUrls() {
  const urls = [`http://127.0.0.1:${PORT}`];
  if (HOST === '0.0.0.0' || HOST === '::' || HOST === '') {
    for (const a of lanAddresses()) urls.push(`http://${a.address}:${PORT}`);
  } else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    urls.push(`http://${HOST}:${PORT}`);
  }
  return [...new Set(urls)];
}

const EM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
  Accept: '*/*',
};

const GROUPS = {
  cn: ['1.000001', '0.399001', '0.399006', '1.000688', '0.899050', '1.000300'],
  global: [
    '100.HSI', '100.HSCEI', '124.HSTECH', '100.N225', '100.KS11', '100.TWII', '100.GDAXI', '100.FTSE',
    '100.FCHI', '100.SX5E', '100.DJIA', '100.SPX', '100.NDX', '100.NDX100', '100.TSX',
    '100.AS51', '100.SENSEX', '100.BVSP', '100.XIN9', '100.UDI', '100.HSAHP',
  ],
  commodities: [
    '101.GC00Y', '101.SI00Y', '101.HG00Y', '102.CL00Y', '102.PL00Y', '112.B00Y',
    '112.M00Y', '113.aum', '113.agm', '113.cum', '113.rbm', '118.AU9999', '118.AGTD',
    '122.XAU', '122.XAG', '104.CN00Y',
  ],
  fx: ['133.USDCNH', '119.USDJPY', '119.EURUSD', '119.USDHKD', '119.USDGBP'],
};

const cache = new Map();
const inflight = new Map();

// 东方财富接口在高并发下容易瞬时断开；用全局并发闸门 + 指数退避降低失败率。
const MAX_UPSTREAM = 6;
let upstreamActive = 0;
const upstreamQueue = [];

function acquireUpstream() {
  if (upstreamActive < MAX_UPSTREAM) {
    upstreamActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => upstreamQueue.push(resolve));
}

function releaseUpstream() {
  upstreamActive = Math.max(0, upstreamActive - 1);
  const next = upstreamQueue.shift();
  if (next) {
    upstreamActive += 1;
    next();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

async function fetchJSON(url, timeout = 12000, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await acquireUpstream();
    try {
      const res = await fetch(url, {
        headers: EM_HEADERS,
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) await sleep(300 * (attempt + 1) + Math.floor(Math.random() * 180));
    } finally {
      releaseUpstream();
    }
  }
  throw lastError || new Error('上游请求失败');
}

function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.val);
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    try {
      const val = await fn();
      cache.set(key, { at: Date.now(), val });
      return val;
    } catch (err) {
      if (hit) return { ...hit.val, stale: true, staleReason: err.message };
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

function normalizeQuote(d, group) {
  const amount = num(d.f6);
  const main = num(d.f62);
  return {
    group,
    secid: `${d.f13}.${d.f12}`,
    code: String(d.f12),
    market: d.f13,
    name: d.f14 || '',
    price: num(d.f2),
    pct: num(d.f3),
    change: num(d.f4),
    volume: num(d.f5),
    amount,
    amountYi: amount === null ? null : round(amount / 1e8, 2),
    turnover: num(d.f8),
    pe: num(d.f9),
    high: num(d.f15),
    low: num(d.f16),
    open: num(d.f17),
    prevClose: num(d.f18),
    mktCap: num(d.f20),
    mktCapYi: num(d.f20) === null ? null : round(num(d.f20) / 1e8, 1),
    floatCap: num(d.f21),
    main,
    mainYi: main === null ? null : round(main / 1e8, 2),
    mainPct: num(d.f184),
    industry: d.f100 || '',
    up: num(d.f104),
    down: num(d.f105),
    flat: num(d.f106),
  };
}

const QUOTE_SOURCE = new Map();

async function fetchQuoteList(secids, group) {
  const unique = [...new Set(secids)];
  if (!unique.length) return [];
  const { data, source } = await runSource('quotes', [unique, group]);
  QUOTE_SOURCE.set(group, source);
  const merged = new Map(data.map((q) => [q.secid, q]));
  let missing = unique.filter((id) => !merged.has(id));
  if (!missing.length) return unique.map((id) => merged.get(id)).filter(Boolean);
  // 单一数据源常常只覆盖部分品种（如腾讯只覆盖 6 个全球指数），
  // 这里用其它数据源补齐缺的那些，行情页不至于大面积空白。
  for (const provider of ['eastmoney', 'tencent', 'sina']) {
    if (provider === source) continue;
    missing = unique.filter((id) => !merged.has(id));
    if (!missing.length) break;
    try {
      const extra = await runSourceProvider('quotes', provider, [missing, group]);
      for (const q of extra.data) merged.set(q.secid, q);
    } catch { /* 该源不支持这些品种时忽略 */ }
  }
  return unique.map((id) => merged.get(id)).filter(Boolean);
}

function zonedParts(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekdays[parts.weekday],
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    text: `${parts.hour}:${parts.minute}`,
  };
}

function sessionStatus(timeZone, segments) {
  const p = zonedParts(timeZone);
  if (p.weekday === 0 || p.weekday === 6) {
    return { state: 'closed', label: '周末休市', local: p.text, timeZone };
  }
  for (const seg of segments) {
    if (p.minutes >= seg[0] && p.minutes < seg[1]) {
      return { state: 'open', label: '交易中', local: p.text, timeZone };
    }
  }
  if (p.minutes < segments[0][0]) {
    return { state: 'pre', label: '未开盘', local: p.text, timeZone };
  }
  if (p.minutes >= segments[segments.length - 1][1]) {
    return { state: 'closed', label: '已收盘', local: p.text, timeZone };
  }
  return { state: 'break', label: '休市', local: p.text, timeZone };
}

function futuresStatus() {
  const p = zonedParts('America/New_York');
  if (p.weekday === 6) return { state: 'closed', label: '周末休市', local: p.text, timeZone: 'America/New_York' };
  if (p.weekday === 0 && p.minutes < 18 * 60) {
    return { state: 'closed', label: '周末休市', local: p.text, timeZone: 'America/New_York' };
  }
  if (p.weekday === 5 && p.minutes >= 17 * 60) {
    return { state: 'closed', label: '已收盘', local: p.text, timeZone: 'America/New_York' };
  }
  if (p.minutes >= 17 * 60 && p.minutes < 18 * 60) {
    return { state: 'break', label: '结算休市', local: p.text, timeZone: 'America/New_York' };
  }
  return { state: 'open', label: '交易中', local: p.text, timeZone: 'America/New_York' };
}

function getSessions() {
  return {
    cn: sessionStatus('Asia/Shanghai', [[570, 690], [780, 900]]),
    hk: sessionStatus('Asia/Hong_Kong', [[570, 720], [780, 960]]),
    us: sessionStatus('America/New_York', [[570, 960]]),
    eu: sessionStatus('Europe/London', [[480, 990]]),
    futures: futuresStatus(),
  };
}

/* 全球指数所属市场的交易时段：用于逐行显示 未开盘 / 交易中 / 已收盘。
   时间为当地分钟数，[开盘, 收盘)；跨午休的市场拆成两段。 */
const INDEX_SESSIONS = {
  HSI: { tz: 'Asia/Hong_Kong', segs: [[570, 720], [780, 960]] },
  HSCEI: { tz: 'Asia/Hong_Kong', segs: [[570, 720], [780, 960]] },
  HSTECH: { tz: 'Asia/Hong_Kong', segs: [[570, 720], [780, 960]] },
  N225: { tz: 'Asia/Tokyo', segs: [[540, 690], [750, 900]] },
  KS11: { tz: 'Asia/Seoul', segs: [[540, 930]] },
  TWII: { tz: 'Asia/Taipei', segs: [[540, 810]] },
  AS51: { tz: 'Australia/Sydney', segs: [[600, 960]] },
  SENSEX: { tz: 'Asia/Kolkata', segs: [[555, 930]] },
  GDAXI: { tz: 'Europe/Berlin', segs: [[540, 1050]] },
  FTSE: { tz: 'Europe/London', segs: [[480, 990]] },
  FCHI: { tz: 'Europe/Paris', segs: [[540, 1050]] },
  SX5E: { tz: 'Europe/Berlin', segs: [[540, 1050]] },
  DJIA: { tz: 'America/New_York', segs: [[570, 960]] },
  SPX: { tz: 'America/New_York', segs: [[570, 960]] },
  NDX: { tz: 'America/New_York', segs: [[570, 960]] },
  NDX100: { tz: 'America/New_York', segs: [[570, 960]] },
  TSX: { tz: 'America/Toronto', segs: [[570, 960]] },
  BVSP: { tz: 'America/Sao_Paulo', segs: [[600, 1020]] },
};

function indexSession(code) {
  if (code === 'XIN9') return futuresStatus();
  const conf = INDEX_SESSIONS[code];
  if (!conf) return null;
  return sessionStatus(conf.tz, conf.segs);
}

async function getFlow(secid) {
  return cached(`flow:${secid}`, 15000, async () => {
    const { data } = await runSource('stockFlow', [secid]);
    return { ...data, secid, updatedAt: Date.now() };
  });
}

async function getOverview() {
  return cached('overview', 9000, async () => {
    const [cn, global, commodities, fx, marketFlow] = await Promise.all([
      fetchQuoteList(GROUPS.cn, 'cn'),
      fetchQuoteList(GROUPS.global, 'global'),
      fetchQuoteList(GROUPS.commodities, 'commodities'),
      fetchQuoteList(GROUPS.fx, 'fx'),
      getFlow('1.000001').catch(() => ({ points: [], last: 0, date: null })),
    ]);
    // 只统计沪、深、北三个全市场口径指数，避免沪深300/创业板等重叠样本重复计数。
    const breadthCodes = new Set(['000001', '399001', '899050']);
    const breadthRows = cn.filter(
      (q) => breadthCodes.has(q.code) && q.up !== null && q.up !== undefined,
    );
    let breadth;
    if (breadthRows.length) {
      breadth = breadthRows.reduce(
        (acc, q) => {
          acc.up += Number(q.up) || 0;
          acc.down += Number(q.down) || 0;
          acc.flat += Number(q.flat) || 0;
          return acc;
        },
        { up: 0, down: 0, flat: 0 },
      );
      breadth.total = breadth.up + breadth.down + breadth.flat;
      breadth.available = true;
    } else {
      // 腾讯 / 新浪的快照不含涨跌家数；同花顺的指数快照带「总家数 / 上涨 / 下跌」，
      // 用它补出沪市 + 深市口径的涨跌家数（不含北交所）。
      breadth = {
        up: null,
        down: null,
        flat: null,
        total: 0,
        available: false,
        note: '当前数据源不提供涨跌家数，切换至东方财富后恢复',
      };
      try {
        const { data } = await runSourceProvider('quotes', 'ths', [['1.000001', '0.399001'], 'cn']);
        const rows = data.filter((q) => q.up !== null && q.up !== undefined);
        if (rows.length) {
          breadth = rows.reduce(
            (acc, q) => {
              acc.up += Number(q.up) || 0;
              acc.down += Number(q.down) || 0;
              acc.flat += Number(q.flat) || 0;
              return acc;
            },
            { up: 0, down: 0, flat: 0 },
          );
          breadth.total = breadth.up + breadth.down + breadth.flat;
          breadth.available = true;
          breadth.source = 'ths';
          breadth.note = '同花顺沪市 + 深市口径，不含北交所';
        }
      } catch { /* 同花顺不可用时仍显示占位符 */ }
    }
    return {
      updatedAt: Date.now(),
      serverTime: new Date().toISOString(),
      dataDate: marketFlow.date,
      cn,
      global: global.map((q) => ({ ...q, session: indexSession(String(q.secid || '').split('.')[1] || q.code) })),
      commodities,
      fx,
      breadth,
      marketFlow,
      sessions: getSessions(),
      stale: Boolean(marketFlow.stale),
      source: `行情快照: ${[...new Set(['cn', 'global', 'commodities', 'fx']
        .map((g) => QUOTE_SOURCE.get(g))
        .filter(Boolean))]
        .map(sourceLabel)
        .join('/') || '东方财富'} · 个股资金流: ${sourceLabel(marketFlow.source || 'eastmoney')}`,
    };
  });
}

const DIST_BUCKETS = [
  { key: 'up10', label: '>10%', tone: 'up' },
  { key: 'up7_10', label: '7~10%', tone: 'up' },
  { key: 'up5_7', label: '5~7%', tone: 'up' },
  { key: 'up3_5', label: '3~5%', tone: 'up' },
  { key: 'up0_3', label: '0~3%', tone: 'up' },
  { key: 'flat', label: '平盘', tone: 'flat' },
  { key: 'down0_3', label: '0~-3%', tone: 'down' },
  { key: 'down3_5', label: '-3~-5%', tone: 'down' },
  { key: 'down5_7', label: '-5~-7%', tone: 'down' },
  { key: 'down7_10', label: '-7~-10%', tone: 'down' },
  { key: 'down10', label: '<-10%', tone: 'down' },
];

function bucketDistribution(pcts) {
  const buckets = DIST_BUCKETS.map((b) => ({ ...b, count: 0 }));
  const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const pct of pcts) {
    const p = Number(pct);
    if (!Number.isFinite(p)) continue;
    if (p > 0) up += 1;
    else if (p < 0) down += 1;
    else flat += 1;
    if (p > 10) byKey.up10.count += 1;
    else if (p >= 7) byKey.up7_10.count += 1;
    else if (p >= 5) byKey.up5_7.count += 1;
    else if (p >= 3) byKey.up3_5.count += 1;
    else if (p > 0) byKey.up0_3.count += 1;
    else if (p === 0) byKey.flat.count += 1;
    else if (p >= -3) byKey.down0_3.count += 1;
    else if (p >= -5) byKey.down3_5.count += 1;
    else if (p >= -7) byKey.down5_7.count += 1;
    else if (p >= -10) byKey.down7_10.count += 1;
    else byKey.down10.count += 1;
  }
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const avgPct = pcts.length ? pcts.reduce((s, p) => s + (Number(p) || 0), 0) / pcts.length : null;
  return { buckets, total, up, down, flat, avgPct: round(avgPct, 2) };
}

function latestUsTradingDate() {
  const p = zonedParts('America/New_York');
  const d = new Date(`${p.date}T12:00:00Z`);
  const day = d.getUTCDay();
  if (day === 0) d.setUTCDate(d.getUTCDate() - 2);
  else if (day === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (p.minutes < 570) d.setUTCDate(d.getUTCDate() - (day === 1 ? 3 : 1));
  return d.toISOString().slice(0, 10);
}

async function fetchSinaUSPage(page) {
  const url =
    'https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20x=/' +
    `US_CategoryService.getList?page=${page}&num=20&sort=volume&asc=0&market=`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`新浪美股 HTTP ${res.status}`);
  const text = await res.text();
  const m = text.match(/var\s+x=\(([\s\S]*)\);?\s*$/);
  if (!m) throw new Error('新浪美股数据格式异常');
  const data = JSON.parse(m[1]);
  return Array.isArray(data.data) ? data.data : [];
}

async function getUSHotStocks() {
  return cached('ushot', 30000, async () => {
    const pages = Array.from({ length: 20 }, (_, i) => i + 1);
    const batches = await mapLimit(pages, 5, (p) => fetchSinaUSPage(p).catch(() => []));
    const seen = new Set();
    const rows = [];
    for (const d of batches.flat()) {
      const symbol = String(d.symbol || '').toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      const market = String(d.market || '');
      if (!/NASDAQ|NYSE|AMEX/i.test(market)) continue;
      const displayName = d.cname || d.name || symbol;
      if (/ETF|ETN|Trust|Fund|2X|3X|做多|做空|每日|指数/i.test(`${displayName} ${d.name || ''}`)) continue;
      const price = num(d.price);
      const pct = num(d.chg);
      const volume = num(d.volume);
      if (price === null || price < 1 || pct === null || !volume) continue;
      seen.add(symbol);
      rows.push({
        symbol,
        name: displayName,
        enName: d.name || '',
        market,
        price,
        pct,
        change: num(d.diff),
        volume,
        dollarVolume: price * volume,
        dollarVolumeYi: round((price * volume) / 1e8, 1),
        marketCapYi: num(d.mktcap) === null ? null : round(num(d.mktcap) / 1e8, 1),
      });
    }
    rows.sort((a, b) => b.dollarVolume - a.dollarVolume);
    return {
      items: rows.slice(0, 100).map((x, i) => ({ ...x, rank: i + 1 })),
      updatedAt: Date.now(),
      source: 'sina',
      note: '按最近交易日成交额排序，成交额越高视为关注度越高。',
    };
  });
}

/* =========================================================
   美股盘前 / 盘中 / 盘后
   盘前 04:00–09:30、盘中 09:30–16:00、盘后 16:00–20:00（美东）。
   延时时段没有统一的批量接口：新浪美股快照带最近一次延时成交明细，
   CNBC 带当前延时时段快照，Nasdaq 补最近一次完整盘后的收盘值。
   每个交易日的盘前/盘后收盘值写入 data/us-sessions.json，重启后仍可回看。
   ========================================================= */
const US_EXT_SESSIONS = {
  pre: { label: '盘前', start: 240, end: 570 },
  regular: { label: '盘中', start: 570, end: 960 },
  post: { label: '盘后', start: 960, end: 1200 },
};
const US_MONTH_INDEX = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};
const US_SESSION_FILE = path.join(__dirname, 'data', 'us-sessions.json');
const US_SINA_HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' };
const US_CNBC_HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.cnbc.com/' };
const US_NASDAQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shiftUsDay(iso, delta) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function shiftUsTradingDay(iso, delta = -1) {
  let day = iso;
  for (let i = 0; i < 12; i += 1) {
    day = shiftUsDay(day, delta);
    const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return day;
  }
  return day;
}

// 当前所属的最近美股交易日：04:00 之前仍按上一交易日算。
function usTradingDayNow() {
  const p = zonedParts('America/New_York');
  if (p.weekday === 0) return shiftUsDay(p.date, -2);
  if (p.weekday === 6) return shiftUsDay(p.date, -1);
  if (p.minutes < US_EXT_SESSIONS.pre.start) return shiftUsTradingDay(p.date, -1);
  return p.date;
}

function usTradingClock() {
  const p = zonedParts('America/New_York');
  let phase = 'closed';
  if (p.weekday >= 1 && p.weekday <= 5) {
    if (p.minutes >= US_EXT_SESSIONS.pre.start && p.minutes < US_EXT_SESSIONS.pre.end) phase = 'pre';
    else if (p.minutes >= US_EXT_SESSIONS.regular.start && p.minutes < US_EXT_SESSIONS.regular.end) phase = 'regular';
    else if (p.minutes >= US_EXT_SESSIONS.post.start && p.minutes < US_EXT_SESSIONS.post.end) phase = 'post';
  }
  return {
    phase,
    date: p.date,
    weekday: p.weekday,
    minutes: p.minutes,
    local: p.text,
    day: usTradingDayNow(),
  };
}

function usPhaseLabel(clock) {
  if (clock.phase === 'pre') return '盘前';
  if (clock.phase === 'regular') return '盘中';
  if (clock.phase === 'post') return '盘后';
  return clock.weekday === 0 || clock.weekday === 6 ? '周末休市' : '已收盘';
}

// 最近一次已经结束（或正在进行）的盘后时段所属交易日。
function usLatestPostDay(clock) {
  if (clock.date === clock.day && clock.minutes < US_EXT_SESSIONS.post.end) {
    return shiftUsTradingDay(clock.day, -1);
  }
  return clock.day;
}

// 新浪延时行情时间形如 "Nov 02 07:55AM EST"。
function parseSinaUsExtTime(text) {
  const m = String(text || '').match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  const key = m[1].slice(0, 1).toUpperCase() + m[1].slice(1, 3).toLowerCase();
  const month = US_MONTH_INDEX[key];
  if (!month) return null;
  const day = Number(m[2]);
  const hour = (Number(m[3]) % 12) + (/^p/i.test(m[5]) ? 12 : 0);
  const minutes = hour * 60 + Number(m[4]);
  const now = zonedParts('America/New_York');
  let year = Number(now.date.slice(0, 4));
  const nowMonth = Number(now.date.slice(5, 7));
  if (month - nowMonth > 6) year -= 1; // 跨年：1 月初看到的是上一年 12 月的数据
  return {
    day: `${year}-${pad2(month)}-${pad2(day)}`,
    minutes,
    hhmm: `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`,
  };
}

// 延时成交分钟数落在哪个时段；09:30–16:00 之间的「延时」值不可用于盘前/盘后。
function usExtSessionKey(minutes) {
  if (!Number.isFinite(minutes)) return null;
  if (minutes < US_EXT_SESSIONS.pre.end) return 'pre';
  if (minutes >= US_EXT_SESSIONS.post.start) return 'post';
  return null;
}

function etPartsOfDate(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

function usNumText(value) {
  return num(String(value === null || value === undefined ? '' : value).replace(/[$,%+]/g, ''));
}

// 新浪美股批量快照：一次请求覆盖上百只股票，返回最新价与最近一次延时成交。
async function fetchSinaUSQuotes(symbols) {
  const list = symbols.map((s) => `gb_${String(s).toLowerCase()}`).join(',');
  const res = await fetch(`https://hq.sinajs.cn/list=${list}`, {
    headers: US_SINA_HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`新浪美股行情 HTTP ${res.status}`);
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/hq_str_gb_([A-Za-z0-9.\-_]+)="([^"]*)"/);
    if (!m || !m[2]) continue;
    const f = m[2].split(',');
    const symbol = m[1].toUpperCase();
    const extTime = parseSinaUsExtTime(f[24]);
    const regTime = parseSinaUsExtTime(f[25]);
    const extPrice = num(f[21]);
    const extVolume = num(f[27]);
    const session = extTime ? usExtSessionKey(extTime.minutes) : null;
    out.set(symbol, {
      regular: {
        symbol,
        price: num(f[1]),
        pct: num(f[2]),
        change: num(f[4]),
        volume: num(f[10]),
        at: regTime ? `${regTime.day}T${regTime.hhmm}` : null,
      },
      ext: session && extPrice !== null && extPrice > 0 && (extVolume === null || extVolume > 0)
        ? {
            price: extPrice,
            pct: num(f[22]),
            change: num(f[23]),
            volume: extVolume,
            session,
            day: extTime.day,
            at: `${extTime.day}T${extTime.hhmm}`,
            source: 'sina',
          }
        : null,
    });
  }
  return out;
}

// CNBC 延时快照：一次请求覆盖上百只股票，明确标注 PRE_MKT / POST_MKT。
async function fetchCnbcUSQuotes(symbols) {
  const url = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=' +
    encodeURIComponent(symbols.join('|')) +
    '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
  const res = await fetch(url, { headers: US_CNBC_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`CNBC 行情 HTTP ${res.status}`);
  const json = await res.json();
  const list = json?.FormattedQuoteResult?.FormattedQuote || [];
  const out = new Map();
  for (const d of list) {
    const symbol = String(d.symbol || '').toUpperCase();
    if (!symbol) continue;
    const raw = d.ExtendedMktQuote;
    let ext = null;
    if (raw && /PRE_MKT|POST_MKT/i.test(String(raw.type || ''))) {
      const price = num(String(raw.last || '').replace(/[$,]/g, ''));
      const when = raw.last_time
        ? new Date(String(raw.last_time).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
        : null;
      const et = when && !Number.isNaN(when.getTime()) ? etPartsOfDate(when) : null;
      if (price !== null && price > 0) {
        ext = {
          price,
          pct: usNumText(raw.change_pct),
          change: usNumText(raw.change),
          volume: num(String(raw.volume || '').replace(/,/g, '')),
          session: /PRE_MKT/i.test(String(raw.type)) ? 'pre' : 'post',
          day: et ? et.day : null,
          at: et ? `${et.day}T${et.hhmm}` : null,
          source: 'cnbc',
        };
      }
    }
    out.set(symbol, {
      regular: {
        symbol,
        price: num(String(d.last || '').replace(/[$,]/g, '')),
        pct: usNumText(d.change_pct),
        change: usNumText(d.change),
        volume: num(String(d.volume || '').replace(/,/g, '')),
        at: null,
      },
      ext,
    });
  }
  return out;
}

// Nasdaq 延时页面：盘后时段结束后仍保留最近一次盘后的收盘值。
async function fetchNasdaqPostSession(symbol) {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/extended-trading?assetclass=stocks&markettype=post&time=1`;
  const res = await fetch(url, { headers: US_NASDAQ_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Nasdaq 盘后 HTTP ${res.status}`);
  const json = await res.json();
  const row = json?.data?.infoTable?.rows?.[0];
  if (!row) return null;
  const price = num(String(row.consolidated || '').replace(/[$,]/g, '').split(/\s+/)[0]);
  if (price === null || price <= 0) return null;
  return { price, volume: num(String(row.volume || '').replace(/,/g, '')) };
}

const usSessMemo = new Map();
let usSessMemoLoaded = false;
let usSessSaveTimer = null;

function loadUsSessMemo() {
  if (usSessMemoLoaded) return;
  usSessMemoLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(US_SESSION_FILE, 'utf8'));
    for (const [sym, val] of Object.entries(raw?.rows || {})) {
      if (!val || typeof val !== 'object') continue;
      usSessMemo.set(String(sym).toUpperCase(), { pre: val.pre || null, post: val.post || null });
    }
  } catch { /* 首次运行没有历史快照 */ }
}

function saveUsSessMemo() {
  usSessSaveTimer = null;
  const rows = {};
  for (const [sym, val] of usSessMemo) {
    if (val && (val.pre || val.post)) rows[sym] = val;
  }
  try {
    fs.mkdirSync(path.dirname(US_SESSION_FILE), { recursive: true });
    fs.writeFileSync(US_SESSION_FILE, JSON.stringify({ updatedAt: Date.now(), rows }), 'utf8');
  } catch { /* 快照写入失败不影响行情 */ }
}

function scheduleUsSessSave() {
  if (usSessSaveTimer) return;
  usSessSaveTimer = setTimeout(saveUsSessMemo, 4000);
  if (typeof usSessSaveTimer.unref === 'function') usSessSaveTimer.unref();
}

function putUsSessSnapshot(symbol, session, val) {
  if (!symbol || !session || !val || !(Number(val.price) > 0)) return;
  const key = String(symbol).toUpperCase();
  const current = usSessMemo.get(key) || { pre: null, post: null };
  const old = current[session];
  if (old && old.at && (!val.at || val.at < old.at)) return;
  current[session] = val;
  usSessMemo.set(key, current);
  scheduleUsSessSave();
}

function compactUsSession(val) {
  if (!val || !(Number(val.price) > 0)) return null;
  return {
    price: round(Number(val.price), 4),
    pct: val.pct === null || val.pct === undefined ? null : round(Number(val.pct), 2),
    change: val.change === null || val.change === undefined ? null : round(Number(val.change), 4),
    at: val.at || null,
    source: val.source || null,
  };
}

let usPostBackfillAt = 0;
let usPostBackfillRunning = false;

// 首次启动 / 重启后补最近一次盘后收盘：只在盘前与收盘后触发，
// 这时「最新价」就是该盘后时段对应的正式收盘价，涨跌幅才对得上。
function queueUsPostBackfill(items, clock) {
  if (clock.phase === 'regular') return;
  const postDay = usLatestPostDay(clock);
  const missing = items.filter((item) => {
    const post = usSessMemo.get(item.symbol)?.post;
    return !post || !post.day || post.day < postDay;
  });
  if (missing.length < 10) return;
  if (usPostBackfillRunning || Date.now() - usPostBackfillAt < 15 * 60 * 1000) return;
  usPostBackfillRunning = true;
  usPostBackfillAt = Date.now();
  (async () => {
    try {
      await mapLimit(missing, 3, async (item) => {
        const snap = await fetchNasdaqPostSession(item.symbol).catch(() => null);
        if (!snap) return;
        const ref = Number(item.price);
        putUsSessSnapshot(item.symbol, 'post', {
          price: snap.price,
          pct: ref > 0 ? round(((snap.price - ref) / ref) * 100, 2) : null,
          change: ref > 0 ? round(snap.price - ref, 4) : null,
          volume: snap.volume,
          day: postDay,
          at: `${postDay}T20:00`,
          source: 'nasdaq',
        });
        await sleep(120);
      });
    } finally {
      usPostBackfillRunning = false;
    }
  })();
}

async function enrichUSHotSessions(items) {
  if (!items.length) return items;
  const clock = usTradingClock();
  loadUsSessMemo();
  const symbols = items.map((x) => x.symbol);
  // 新浪一批就能覆盖上百只；只有它整体不可用、或盘前/盘后覆盖率明显偏低时才补 CNBC，
  // 避免每次刷新都多等一次跨网请求。
  const sina = await fetchSinaUSQuotes(symbols).catch(() => null);
  let cnbc = null;
  if (!sina) {
    cnbc = await fetchCnbcUSQuotes(symbols).catch(() => null);
  } else if (clock.phase === 'pre' || clock.phase === 'post') {
    const covered = [...sina.values()].filter((row) => row.ext).length;
    if (covered < symbols.length * 0.5) cnbc = await fetchCnbcUSQuotes(symbols).catch(() => null);
  }
  const regular = new Map();
  const fresh = new Map();
  const addExt = (sym, ext) => {
    if (!ext || !ext.session) return;
    const prev = fresh.get(sym);
    if (!prev || (ext.at && (!prev.at || ext.at > prev.at))) fresh.set(sym, ext);
  };
  for (const [sym, row] of sina || []) {
    if (row.regular && row.regular.price !== null) regular.set(sym, row.regular);
    addExt(sym, row.ext);
  }
  for (const [sym, row] of cnbc || []) {
    if (!regular.has(sym) && row.regular && row.regular.price !== null) regular.set(sym, row.regular);
    addExt(sym, row.ext);
  }
  for (const [sym, ext] of fresh) putUsSessSnapshot(sym, ext.session, ext);

  for (const item of items) {
    const sym = item.symbol;
    const live = regular.get(sym);
    const reg = live && live.price !== null
      ? live
      : (Number.isFinite(Number(item.price)) ? { price: item.price, pct: item.pct, change: item.change, at: null } : null);
    const memo = usSessMemo.get(sym) || {};
    item.sessions = {
      pre: compactUsSession(memo.pre),
      regular: compactUsSession(reg),
      post: compactUsSession(memo.post),
    };
  }
  queueUsPostBackfill(items, clock);
  return items;
}

async function fetchNasdaqScreener(exchange, download = false) {
  const url =
    'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=5000&offset=0' +
    `&exchange=${encodeURIComponent(exchange)}${download ? '&download=true' : ''}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json, text/plain, */*',
          Origin: 'https://www.nasdaq.com',
          Referer: 'https://www.nasdaq.com/',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`Nasdaq HTTP ${res.status}`);
      const json = await res.json();
      // download=true 时 rows 直接挂在 data 下；普通模式在 data.table.rows。
      return json?.data?.table?.rows || json?.data?.rows || [];
    } catch (err) {
      lastError = err;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastError || new Error('Nasdaq 列表请求失败');
}

/* =========================================================
   美股全市场快照（纳斯达克筛选器，带行业字段）
   同一份数据同时用于：全美涨跌分布、热门股所属板块、美股板块资金。
   ========================================================= */
const US_SECTOR_CN = {
  Technology: '信息技术',
  'Health Care': '医疗保健',
  Finance: '金融',
  'Consumer Discretionary': '可选消费',
  'Consumer Staples': '必需消费',
  Industrials: '工业',
  Energy: '能源',
  Utilities: '公用事业',
  'Real Estate': '房地产',
  'Basic Materials': '基础材料',
  Telecommunications: '电信服务',
  Miscellaneous: '综合',
};

function parseUsMoney(text) {
  return num(String(text == null ? '' : text).replace(/[$,%+\s]/g, '').replace(/,/g, ''));
}

async function getUsScreenerUniverse() {
  return cached('us:screener:v2', 10 * 60 * 1000, async () => {
    const exchanges = ['NASDAQ', 'NYSE', 'AMEX'];
    const batches = await mapLimit(exchanges, 3, (ex) => fetchNasdaqScreener(ex, true).catch(() => []));
    if (!batches.some((rows) => rows.length)) throw new Error('美股全市场列表暂不可用');
    const seen = new Set();
    const rows = [];
    batches.forEach((list, i) => {
      for (const d of list) {
        const symbol = String(d.symbol || '').toUpperCase();
        if (!symbol || seen.has(symbol)) continue;
        const pct = parseUsMoney(d.pctchange);
        const price = parseUsMoney(d.lastsale);
        if (pct === null || price === null || price <= 0) continue;
        const volume = parseUsMoney(d.volume) || 0;
        seen.add(symbol);
        rows.push({
          symbol,
          name: String(d.name || symbol),
          exchange: exchanges[i],
          price,
          pct,
          volume,
          dollarVolume: price * volume,
          marketCap: parseUsMoney(d.marketCap) || 0,
          sector: String(d.sector || '').trim() || 'Miscellaneous',
          industry: String(d.industry || '').trim(),
        });
      }
    });
    return { rows, updatedAt: Date.now(), exchanges: exchanges.map((ex, i) => ({ exchange: ex, rows: batches[i].length })) };
  });
}

function usSectorLabel(en) {
  return US_SECTOR_CN[en] || en || '其他';
}

/** 美股板块资金：成交额、成交额加权涨跌幅、涨跌家数、资金流估算（成交额 × 涨跌幅）。 */
function buildUsSectorFlow(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!(r.dollarVolume >= 200000)) continue;
    const key = r.sector || 'Miscellaneous';
    let s = map.get(key);
    if (!s) {
      s = {
        sector: key,
        name: usSectorLabel(key),
        count: 0,
        amount: 0,
        weightedPct: 0,
        up: 0,
        down: 0,
        flat: 0,
        flow: 0,
        leaders: [],
      };
      map.set(key, s);
    }
    s.count += 1;
    s.amount += r.dollarVolume;
    s.weightedPct += r.pct * r.dollarVolume;
    s.flow += (r.pct / 100) * r.dollarVolume;
    if (r.pct > 0.0001) s.up += 1;
    else if (r.pct < -0.0001) s.down += 1;
    else s.flat += 1;
    s.leaders.push({ symbol: r.symbol, name: r.name, pct: r.pct, price: r.price, amount: r.dollarVolume });
  }
  const items = [...map.values()].map((s) => ({
    sector: s.sector,
    name: s.name,
    count: s.count,
    amountYi: round(s.amount / 1e8, 1),
    pct: s.amount ? round(s.weightedPct / s.amount, 2) : 0,
    flowYi: round(s.flow / 1e8, 2),
    up: s.up,
    down: s.down,
    flat: s.flat,
    leaders: s.leaders
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3)
      .map((x) => ({ symbol: x.symbol, name: x.name, pct: round(x.pct, 2), price: x.price, amountYi: round(x.amount / 1e8, 1) })),
  }));
  const totalAmount = items.reduce((sum, x) => sum + x.amountYi, 0);
  const totalFlow = items.reduce((sum, x) => sum + x.flowYi, 0);
  items.sort((a, b) => b.amountYi - a.amountYi);
  return {
    items,
    totalAmountYi: round(totalAmount, 1),
    totalFlowYi: round(totalFlow, 2),
    note: '资金流估算 = Σ(成交额 × 涨跌幅)，用价格变动与成交额刻画板块资金方向，不是交易所披露的真实净流入。',
    updatedAt: Date.now(),
  };
}

async function getUSDistribution() {
  return cached('distribution:us', 300000, async () => {
    const universe = await getUsScreenerUniverse();
    const dist = bucketDistribution(universe.rows.map((r) => r.pct));
    return {
      ...dist,
      market: 'us',
      date: latestUsTradingDate(),
      exchanges: universe.exchanges,
      updatedAt: Date.now(),
      source: 'nasdaq-screener',
    };
  });
}

async function getUSHotSectors() {
  const universe = await getUsScreenerUniverse();
  return buildUsSectorFlow(universe.rows);
}

/* =========================================================
   美股分时（盘前 / 盘中 / 盘后）
   CNBC 的 1D 分钟图天然覆盖 04:00–20:00（美东）全部时段，
   一次请求即可切出盘前 / 盘中 / 盘后三段并保留最近两个交易日，
   因此盘前、盘后也能画真实成交曲线，而不是只有一个收盘价。
   ========================================================= */
async function fetchCnbcMinuteDays(symbol) {
  const url =
    'https://ts-api.cnbc.com/harmony/app/charts/1D.json' +
    `?symbol=${encodeURIComponent(symbol)}&interval=1&events=1&extended=1`;
  const res = await fetch(url, {
    headers: US_CNBC_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`CNBC 分时 HTTP ${res.status}`);
  const json = await res.json();
  const bars = json?.barData?.priceBars;
  if (!Array.isArray(bars) || !bars.length) throw new Error('CNBC 未返回分时数据');
  const days = new Map();
  for (const b of bars) {
    const t = String(b.tradeTime || '');
    if (t.length < 12) continue;
    const price = num(b.close);
    if (price === null) continue;
    const day = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    const hhmm = `${t.slice(8, 10)}:${t.slice(10, 12)}`;
    const minute = Number(t.slice(8, 10)) * 60 + Number(t.slice(10, 12));
    let d = days.get(day);
    if (!d) {
      d = { day, pre: [], regular: [], post: [] };
      days.set(day, d);
    }
    const point = [hhmm, price];
    if (minute < 570) d.pre.push(point);
    else if (minute < 960) d.regular.push(point);
    else d.post.push(point);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function usMinuteSummary(symbol, days) {
  const latest = days[days.length - 1] || null;
  const prev = days[days.length - 2] || null;
  const prevClose = prev && prev.regular.length ? prev.regular[prev.regular.length - 1][1] : null;
  const pickLast = (d) => {
    if (!d) return null;
    const seg = d.post.length ? d.post : d.regular.length ? d.regular : d.pre;
    return seg.length ? seg[seg.length - 1][1] : null;
  };
  const last = pickLast(latest);
  const pct = prevClose && last ? round(((last - prevClose) / prevClose) * 100, 2) : null;
  return {
    symbol,
    day: latest ? latest.day : null,
    days: days.slice(-2),
    prevClose,
    last,
    pct,
  };
}

async function getUsMinutes(symbols) {
  const list = [...new Set(symbols.map((s) => String(s || '').toUpperCase()).filter(Boolean))].slice(0, US_TOP_CARDS);
  if (!list.length) return { items: [], updatedAt: Date.now() };
  return cached(`usmin:${list.join(',')}`, 120000, async () => {
    const items = await mapLimit(list, 4, async (symbol) => {
      try {
        return usMinuteSummary(symbol, await fetchCnbcMinuteDays(symbol));
      } catch (err) {
        // 部分代码在新浪用 BRK.B、在 CNBC 用 BRK-B，失败时换一种写法再试一次。
        const alt = symbol.includes('.') ? symbol.replace(/\./g, '-') : null;
        if (alt) {
          try {
            return usMinuteSummary(symbol, await fetchCnbcMinuteDays(alt));
          } catch { /* 仍然失败则返回空 */ }
        }
        return { symbol, days: [], error: err.message };
      }
    });
    return {
      items,
      updatedAt: Date.now(),
      source: 'cnbc',
      windows: { pre: '04:00–09:30', regular: '09:30–16:00', post: '16:00–20:00' },
      note: 'CNBC 1 分钟成交价，包含盘前 04:00 起与盘后至 20:00 的延时交易；单位美元，美东时间。',
    };
  });
}

async function getChinaDistribution() {
  return cached('distribution:cn', 300000, async () => {
    const pages = Array.from({ length: 60 }, (_, i) => i + 1);
    const batches = await mapLimit(pages, 8, async (page) => {
      const url =
        'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
        `?page=${page}&num=100&sort=changepercent&asc=0&node=hs_a&symbol=&_s_r_a=page`;
      return fetchSinaJSON(url).catch(() => []);
    });
    const pcts = [];
    for (const d of batches.flat()) {
      const price = num(d.trade);
      const pct = num(d.changepercent);
      if (pct === null || price === null || price <= 0) continue;
      pcts.push(pct);
    }
    const dist = bucketDistribution(pcts);
    const overview = await getOverview().catch(() => null);
    return {
      ...dist,
      market: 'cn',
      date: overview?.dataDate || shanghaiToday(),
      updatedAt: Date.now(),
      source: 'sina',
    };
  });
}

const CSI300_ETF_HINTS = [
  '510300', '510310', '510330', '159919', '515330', '510360', '515380',
  '510350', '159925', '159673', '515390', '159300', '510380', '515130',
];

async function getCsi300FundRatio(top = 10) {
  const n = Math.max(3, Math.min(20, Number(top) || 10));
  return cached(`csi300ratio:${n}`, 300000, async () => {
    const [overview, universe, kline] = await Promise.all([
      getOverview(),
      getEtfUniverse(),
      getKline('1.000300', 101, 130).catch(() => null),
    ]);
    const index = (overview.cn || []).find((q) => q.code === '000300');
    if (!index || !Number.isFinite(Number(index.floatCap)) || Number(index.floatCap) <= 0) {
      throw new Error('暂未获取到沪深300流通市值');
    }
    const universeMap = new Map((universe || []).map((x) => [x.code, x]));
    for (const code of CSI300_ETF_HINTS) {
      if (!universeMap.has(code)) universeMap.set(code, { code, name: '', price: null, pct: null });
    }
    const candidates = [...universeMap.values()].filter((x) => {
      const name = String(x.name || '');
      if (CSI300_ETF_HINTS.includes(x.code)) return true;
      return /沪深300|300ETF/.test(name) &&
        !/价值|成长|红利|低波|ESG|增强|质量|医药|非银|银行|消费|科技|可选|A500|中证300/.test(name);
    });
    const basicRows = await mapLimit(candidates, 5, async (etf) => {
      const basic = await fetchFundBasic(etf.code).catch(() => null);
      const size = num(basic?.ENDNAV);
      const name = basic?.SHORTNAME || etf.name || '';
      if (!size || size <= 0 || !/沪深300/.test(name) || /价值|成长|红利|低波|ESG|增强|质量|医药|非银|银行|消费|科技|可选/.test(name)) return null;
      return {
        code: etf.code,
        name,
        size,
        sizeYi: round(size / 1e8, 1),
        price: etf.price,
        pct: etf.pct,
      };
    });
    const funds = basicRows
      .filter(Boolean)
      .sort((a, b) => b.size - a.size)
      .slice(0, n);
    const totalSize = funds.reduce((s, x) => s + x.size, 0);
    const floatCap = Number(index.floatCap);
    const currentClose = Number(index.price) || kline?.candles?.at(-1)?.c || null;
    const history = currentClose && kline?.candles
      ? kline.candles.slice(-130).map((c) => {
          const capAt = floatCap * (Number(c.c) / currentClose);
          return {
            d: c.d,
            close: round(c.c, 2),
            ratio: capAt > 0 ? round((totalSize / capAt) * 100, 3) : null,
          };
        }).filter((x) => x.ratio !== null)
      : [];
    return {
      indexName: index.name || '沪深300',
      indexCode: index.code,
      floatCap,
      floatCapYi: round(floatCap / 1e8, 1),
      fundCount: funds.length,
      totalSize,
      totalSizeYi: round(totalSize / 1e8, 1),
      ratio: round((totalSize / floatCap) * 100, 3),
      funds,
      history,
      date: overview.dataDate || shanghaiToday(),
      updatedAt: Date.now(),
      note: `头部 ${funds.length} 只纯沪深300 ETF 的基金规模合计，除以沪深300指数流通市值；曲线中的基金规模使用最新披露值，流通市值按指数收盘点位回溯。`,
    };
  });
}

// 「24H 热门美股」实时分时卡片的数量：与页面标题一致（12 只）。
const US_TOP_CARDS = 12;

async function getUSDashboard() {
  return cached('usdashboard', 30000, async () => {
    const clock = usTradingClock();
    const [indices, hot, distribution, sectorFlow] = await Promise.all([
      fetchQuoteList(['100.NDX', '100.NDX100', '100.SPX', '100.DJIA'], 'global').catch(() => []),
      getUSHotStocks().catch(() => ({ items: [], note: '' })),
      getUSDistribution().catch(() => null),
      getUSHotSectors().catch(() => null),
    ]);
    const hotItems = await enrichUSHotSessions(hot.items || []).catch(() => hot.items || []);
    // 把纳斯达克筛选器里的行业字段补到热门股上，取前 12 只作为分时卡片。
    const sectorMap = new Map();
    try {
      const universe = await getUsScreenerUniverse();
      for (const r of universe.rows) sectorMap.set(r.symbol, r);
    } catch { /* 行业信息不可用时不影响热门榜 */ }
    for (const item of hotItems) {
      const u = sectorMap.get(item.symbol);
      item.sector = u ? u.sector : '';
      item.sectorName = u ? usSectorLabel(u.sector) : '';
      item.industry = u ? u.industry : '';
    }
    return {
      indices,
      hot: hotItems,
      topHot: hotItems.slice(0, US_TOP_CARDS),
      hotNote: hot.note || '',
      distribution,
      sectorFlow,
      sessions: { ...getSessions().us, state: clock.phase, label: usPhaseLabel(clock), local: clock.local },
      usBoard: {
        phase: clock.phase,
        label: usPhaseLabel(clock),
        day: clock.day,
        local: clock.local,
        postDay: usLatestPostDay(clock),
        windows: {
          pre: '04:00–09:30',
          regular: '09:30–16:00',
          post: '16:00–20:00',
        },
      },
      updatedAt: Date.now(),
      source: '东方财富 / 新浪财经 / CNBC / Nasdaq',
    };
  });
}

const KLINE_META = {
  '1.000001': '上证指数', '0.399001': '深证成指', '0.399006': '创业板指',
  '1.000688': '科创50', '0.899050': '北证50', '1.000300': '沪深300',
  '1.000016': '上证50', '1.000905': '中证500', '1.000852': '中证1000',
  '100.HSI': '恒生指数', '100.HSCEI': '国企指数', '124.HSTECH': '恒生科技指数', '100.N225': '日经225',
  '100.KS11': '韩国KOSPI', '100.TWII': '台湾加权', '100.GDAXI': '德国DAX30',
  '100.FTSE': '英国富时100', '100.FCHI': '法国CAC40', '100.SX5E': '欧洲斯托克50',
  '100.DJIA': '道琼斯', '100.SPX': '标普500', '100.NDX': '纳斯达克',
  '100.NDX100': '纳斯达克100', '100.TSX': '加拿大S&P/TSX', '100.AS51': '澳大利亚标普200',
  '100.SENSEX': '印度孟买SENSEX', '100.BVSP': '巴西BOVESPA', '100.XIN9': '富时中国A50',
  '100.UDI': '美元指数', '100.HSAHP': 'AH股溢价',
  '101.GC00Y': 'COMEX黄金', '101.SI00Y': 'COMEX白银', '101.HG00Y': 'COMEX铜',
  '102.CL00Y': 'NYMEX原油', '102.PL00Y': 'NYMEX铂金', '112.B00Y': '布伦特原油',
  '112.M00Y': '天然气', '122.XAU': '伦敦金', '122.XAG': '伦敦银',
  '104.CN00Y': '富时中国A50期货', '113.aum': '沪金主连', '113.agm': '沪银主连',
  '113.cum': '沪铜主连', '113.rbm': '螺纹钢主连', '118.AU9999': '黄金9999',
};

const TENCENT_KLINE = {
  '100.HSI': { symbol: 'hkHSI', endpoint: 'hkfqkline' },
  '124.HSTECH': { symbol: 'hkHSTECH', endpoint: 'hkfqkline' },
  '100.DJIA': { symbol: 'usDJI', endpoint: 'usfqkline' },
  '100.NDX': { symbol: 'usIXIC', endpoint: 'usfqkline' },
  '100.NDX100': { symbol: 'usNDX', endpoint: 'usfqkline' },
  '100.SPX': { symbol: 'usINX', endpoint: 'usfqkline' },
};

const SINA_FUTURES_KLINE = {
  '101.GC00Y': { symbol: 'GC', type: 'global' },
  '101.SI00Y': { symbol: 'SI', type: 'global' },
  '101.HG00Y': { symbol: 'HG', type: 'global' },
  '102.CL00Y': { symbol: 'CL', type: 'global' },
  '112.B00Y': { symbol: 'OIL', type: 'global' },
  '122.XAU': { symbol: 'XAU', type: 'global' },
  '122.XAG': { symbol: 'XAG', type: 'global' },
  '104.CN00Y': { symbol: 'CHA50CFD', type: 'global' },
};

async function fetchSinaText(url, timeout = 20000) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': EM_HEADERS['User-Agent'],
      Referer: 'https://finance.sina.com.cn/',
      Accept: '*/*',
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`新浪行情 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new TextDecoder('gbk').decode(buf);
}

function parseJSONP(text) {
  const start = text.indexOf('([');
  const end = text.lastIndexOf('])');
  if (start < 0 || end < 0) throw new Error('新浪期货数据格式异常');
  return JSON.parse(text.slice(start + 1, end + 1));
}

function sinaAshareSymbol(secid) {
  const [market, code] = secid.split('.');
  if (market === '1') return `sh${code}`;
  if (market === '0') {
    if (/^[489]/.test(code)) return `bj${code}`;
    return `sz${code}`;
  }
  return null;
}

function buildCandles(rows, map) {
  const out = [];
  for (const row of rows) {
    const o = num(row[map.o]);
    const c = num(row[map.c]);
    const h = num(row[map.h]);
    const l = num(row[map.l]);
    if (![o, c, h, l].every(Number.isFinite)) continue;
    out.push({
      d: row[map.d],
      o,
      c,
      h,
      l,
      v: num(row[map.v]) || 0,
      a: map.a ? num(row[map.a]) : null,
    });
  }
  return finishCandles(out);
}

function finishCandles(candles) {
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = i > 0 ? candles[i - 1].c : c.o;
    c.change = prev ? c.c - prev : 0;
    c.pct = prev ? ((c.c - prev) / prev) * 100 : 0;
    c.amplitude = prev ? ((c.h - c.l) / prev) * 100 : 0;
    c.turnover = null;
  }
  return candles;
}

function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr.slice(0, 10)}T12:00:00+08:00`);
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = target - firstThursday;
  const week = 1 + Math.round(diff / 604800000);
  return `${target.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function aggregateCandles(candles, period) {
  if (period !== 'week' && period !== 'month') return candles;
  const groups = new Map();
  for (const c of candles) {
    const key = period === 'week' ? isoWeekKey(c.d) : c.d.slice(0, 7);
    if (!groups.has(key)) {
      groups.set(key, { ...c });
    } else {
      const g = groups.get(key);
      g.c = c.c;
      g.h = Math.max(g.h, c.h);
      g.l = Math.min(g.l, c.l);
      g.v += c.v;
      g.a = g.a === null || c.a === null ? null : g.a + c.a;
      g.d = c.d;
    }
  }
  return finishCandles([...groups.values()]);
}

function sohuAshareCode(secid) {
  const [market, code] = String(secid).split('.');
  const indexCodes = {
    '000001': 'zs_000001',
    '399001': 'zs_399001',
    '399006': 'zs_399006',
    '000300': 'zs_000300',
    '000688': 'zs_000688',
    '000016': 'zs_000016',
    '000905': 'zs_000905',
    '000852': 'zs_000852',
    '899050': 'zs_899050',
  };
  if (indexCodes[code]) return indexCodes[code];
  if (market === '1') return `cn_${code}`;
  if (market === '0') return `cn_${code}`;
  return null;
}

async function fetchSohuAshare(secid, limit = 2600, period = 'd') {
  const code = sohuAshareCode(secid);
  if (!code) throw new Error('暂无该 A 股历史数据');
  const candles = await cached(`sohu:${code}:${period}`, 300000, async () => {
    const end = shanghaiToday().replace(/-/g, '');
    const start = `${Number(end.slice(0, 4)) - 10}${end.slice(4)}`;
    const url =
      'https://q.stock.sohu.com/hisHq?code=' + encodeURIComponent(code) +
      `&start=${start}&end=${end}&stat=1&order=D&period=${period}&rt=json`;
    let rows = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://q.stock.sohu.com/' },
          signal: AbortSignal.timeout(25000),
        });
        if (!res.ok) throw new Error(`搜狐历史 HTTP ${res.status}`);
        const json = await res.json();
        rows = Array.isArray(json) ? json[0]?.hq : null;
        if (Array.isArray(rows) && rows.length >= (period === 'd' ? 2000 : 200)) break;
      } catch {
        rows = null;
      }
      await sleep(300 * (attempt + 1));
    }
    if (!Array.isArray(rows) || !rows.length) throw new Error('未获取到 A 股历史 K 线');
    return buildCandles(rows.slice().reverse(), {
      d: 0, o: 1, c: 2, h: 6, l: 5, v: 7, a: 8,
    }).filter((c) => c.c !== null);
  });
  return candles.slice(-limit);
}

async function fetchTencentAshareLong(symbol, limit = 2600) {
  const now = new Date();
  const endYear = now.getFullYear();
  const startYear = endYear - 10;
  const ranges = [];
  for (let y = startYear; y <= endYear; y += 2) {
    ranges.push([`${y}-01-01`, `${Math.min(y + 1, endYear)}-12-31`]);
  }
  const batches = await mapLimit(ranges, 3, async ([start, end]) => {
    const param = `${symbol},day,${start},${end},1000,qfq`;
    const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=${encodeURIComponent(param)}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://gu.qq.com/', Accept: '*/*' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return [];
      const json = await res.json();
      const node = json?.data?.[symbol];
      return node?.qfqday || node?.day || [];
    } catch {
      return [];
    }
  });
  const map = new Map();
  for (const row of batches.flat()) {
    if (Array.isArray(row) && row[0]) map.set(String(row[0]), row);
  }
  const rows = [...map.values()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (!rows.length) throw new Error('未获取到 A 股长周期 K 线');
  return buildCandles(rows, { d: 0, o: 1, c: 2, h: 3, l: 4, v: 5 });
}

async function fetchAshareSina(secid, klt, limit) {
  const symbol = sinaAshareSymbol(secid);
  if (!symbol) throw new Error('不支持的 A 股代码');
  if ([101, 102, 103].includes(klt)) {
    try {
      const daily = await fetchSohuAshare(secid, Math.max(2600, limit), 'd');
      if (daily.length >= 500) {
        if (klt === 101) return daily.slice(-limit);
        return aggregateCandles(daily, klt === 102 ? 'week' : 'month').slice(-limit);
      }
    } catch {
      // 搜狐历史失败时继续尝试腾讯，再回退新浪
    }
    try {
      const daily = await fetchTencentAshareLong(symbol, Math.max(2600, limit));
      if (daily.length >= 200) {
        if (klt === 101) return daily.slice(-limit);
        const aggregated = aggregateCandles(daily, klt === 102 ? 'week' : 'month');
        return aggregated.slice(-limit);
      }
    } catch {
      // 腾讯长周期失败时回退到新浪的短周期日线
    }
  }
  const scale = klt === 101 ? 240 : [60, 30, 15, 5, 1].includes(klt) ? klt : 240;
  const need = klt === 102 ? Math.max(limit * 5, 300) : klt === 103 ? Math.max(limit * 22, 600) : limit;
  const url =
    'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData' +
    `?symbol=${symbol}&scale=${scale}&ma=no&datalen=${Math.min(1000, need)}`;
  const text = await fetchSinaText(url);
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error('新浪 K 线返回格式异常'); }
  if (!Array.isArray(rows) || !rows.length) throw new Error('未获取到 K 线数据');
  let candles = buildCandles(rows, { d: 'day', o: 'open', c: 'close', h: 'high', l: 'low', v: 'volume', a: 'amount' });
  if (klt === 1 && candles.length) {
    const lastDay = String(candles[candles.length - 1].d).slice(0, 10);
    candles = candles.filter((c) => String(c.d).slice(0, 10) === lastDay);
  }
  if (klt === 102) candles = aggregateCandles(candles, 'week');
  if (klt === 103) candles = aggregateCandles(candles, 'month');
  return candles.slice(-limit);
}

async function fetchTencentKline(secid, limit) {
  const conf = TENCENT_KLINE[secid];
  if (!conf) throw new Error('暂无该市场 K 线数据');
  const url =
    `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/${conf.endpoint}/get` +
    `?param=${conf.symbol},day,,,${Math.min(320, limit)},qfq`;
  const res = await fetch(url, {
    headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://gu.qq.com/', Accept: '*/*' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`腾讯行情 HTTP ${res.status}`);
  const json = await res.json();
  const node = json?.data?.[conf.symbol];
  const rows = node?.day;
  if (!Array.isArray(rows) || !rows.length) throw new Error('暂无该市场 K 线数据');
  return buildCandles(rows, { d: 0, o: 1, c: 2, h: 3, l: 4, v: 5 }).slice(-limit);
}

async function fetchEastmoneyKline(secid, klt = 101, limit = 200) {
  const kltMap = { 1: 1, 5: 5, 15: 15, 30: 30, 60: 60, 101: 101, 102: 102, 103: 103 };
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    `?secid=${encodeURIComponent(secid)}&klt=${kltMap[klt] || 101}&fqt=1` +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    `&lmt=${Math.max(1, limit)}`;
  const json = await fetchJSON(url, 20000);
  const rows = json?.data?.klines;
  if (!Array.isArray(rows) || !rows.length) throw new Error('未获取到 K 线数据');
  return buildCandles(rows.map((line) => String(line).split(',')), {
    d: 0, o: 1, c: 2, h: 3, l: 4, v: 5, a: 6,
  });
}

async function fetchSinaFuturesKline(secid, limit) {
  const conf = SINA_FUTURES_KLINE[secid];
  if (!conf) throw new Error('暂无该品种 K 线数据');
  const url = conf.type === 'domestic'
    ? `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_${conf.symbol}=/InnerFuturesNewService.getDailyKLine?symbol=${conf.symbol}`
    : `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_${conf.symbol}=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${conf.symbol}&_=${Date.now()}`;
  const text = await fetchSinaText(url, 25000);
  const rows = parseJSONP(text);
  if (!Array.isArray(rows) || !rows.length) throw new Error('暂无该品种 K 线数据');
  const global = conf.type === 'global';
  return buildCandles(rows, {
    d: global ? 'date' : 'd',
    o: global ? 'open' : 'o',
    c: global ? 'close' : 'c',
    h: global ? 'high' : 'h',
    l: global ? 'low' : 'l',
    v: global ? 'volume' : 'v',
  }).slice(-limit);
}

/* =========================================================
   金银分时（伦敦金 / 伦敦银 / 上海金）1 分钟明细
   新浪全球期货分钟线：07:00 起连续 1 分钟点，自带「均价」列（官方口径）；
   新浪内盘分钟线：沪金 / 沪银主连，带均价与持仓量；
   东财 trends2：上海金现货 Au99.99 的分钟点，夜盘 20:00 起可用，
   点数不足时退回沪金主连（清晰标注，二者存在基差）。
   ========================================================= */
const METAL_INTRADAY_DEFS = {
  XAU: { name: '伦敦金', unit: 'USD/oz', sinaType: 'global', sinaSymbol: 'XAU' },
  XAG: { name: '伦敦银', unit: 'USD/oz', sinaType: 'global', sinaSymbol: 'XAG' },
  AU9999: { name: '上海金', unit: 'CNY/g', eastmoneySecid: '118.AU9999', sinaType: 'inner', sinaSymbol: 'AU0' },
};

async function fetchSinaMinuteSeries(type, symbol) {
  const url = type === 'inner'
    ? 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_m=/InnerFuturesNewService.getMinLine' +
      `?symbol=${encodeURIComponent(symbol)}`
    : 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_m=/GlobalFuturesService.getGlobalFuturesMinLine' +
      `?symbol=${encodeURIComponent(symbol)}`;
  const text = await fetchSinaText(url, 20000);
  // 新浪 jsonp 两种写法：var _m=([...]) 与 var _m=({"minLine_1d":[...]})，统一取括号里的 JSON。
  const eq = text.lastIndexOf('=(');
  let raw = null;
  if (eq >= 0) {
    const close = text.lastIndexOf(')');
    if (close > eq + 2) raw = text.slice(eq + 2, close);
  }
  if (!raw) {
    const start = text.indexOf('([');
    const end = text.lastIndexOf('])');
    if (start >= 0 && end > start) raw = text.slice(start + 1, end + 1);
  }
  if (!raw) throw new Error('新浪分时返回格式异常');
  let rows;
  try { rows = JSON.parse(raw); } catch { throw new Error('新浪分时返回格式异常'); }
  if (rows && !Array.isArray(rows) && Array.isArray(rows.minLine_1d)) rows = rows.minLine_1d;
  if (!Array.isArray(rows) || !rows.length) throw new Error('新浪分时暂无数据');
  const points = [];
  let day = '';
  let preClose = null;
  for (const r of rows) {
    if (!Array.isArray(r) || !r.length) continue;
    if (type === 'inner') {
      const t = String(r[0] || '');
      const p = num(r[1]);
      if (r.length >= 7) {
        preClose = preClose === null ? num(r[5]) : preClose;
        day = day || String(r[6] || '').slice(0, 10);
      }
      if (!/^\d{2}:\d{2}$/.test(t) || p === null) continue;
      points.push({ t, p, avg: num(r[2]), v: num(r[3]) || 0, oi: num(r[4]) });
    } else if (r.length >= 10) {
      // 全球期货首行是表头：[日期, 昨收, 交易所, '', 时间, 价格, 量, '', 均价, 时间戳]
      day = day || String(r[0] || '').slice(0, 10);
      preClose = preClose === null ? num(r[1]) : preClose;
      const t = String(r[4] || '');
      const p = num(r[5]);
      if (!/^\d{2}:\d{2}$/.test(t) || p === null) continue;
      points.push({ t, p, avg: num(r[8]), v: num(r[6]) || 0 });
    } else {
      const t = String(r[0] || '');
      const p = num(r[1]);
      if (!/^\d{2}:\d{2}$/.test(t) || p === null) continue;
      points.push({ t, p, avg: num(r[4]), v: num(r[2]) || 0 });
    }
  }
  if (points.length < 2) throw new Error('新浪分时暂无数据');
  return { day: day || shanghaiToday(), preClose, points };
}

async function fetchEastmoneyTrends(secid, ndays = 1) {
  const url =
    'https://push2.eastmoney.com/api/qt/stock/trends2/get' +
    `?secid=${encodeURIComponent(secid)}` +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=${ndays}&iscr=0&iscca=0`;
  const json = await fetchJSON(url, 15000);
  const data = json?.data;
  if (!data || !Array.isArray(data.trends) || data.trends.length < 2) {
    throw new Error(`${secid.split('.')[1] || secid} 暂无分时点`);
  }
  const points = [];
  let day = '';
  for (const line of data.trends) {
    const f = String(line).split(',');
    const stamp = String(f[0] || '');
    const p = num(f[2]);
    if (p === null) continue;
    day = day || stamp.slice(0, 10);
    points.push({ t: stamp.slice(11, 16), p, avg: num(f[7]), v: num(f[5]) || 0, a: num(f[6]) || 0 });
  }
  return { day: day || shanghaiToday(), preClose: num(data.preClose), points, name: data.name };
}

function buildMetalIntraday(code, def, got, source, sourceLabel, note = '') {
  const points = got.points || [];
  const prices = points.map((p) => p.p);
  const avgList = points.map((p) => (Number.isFinite(p.avg) && p.avg > 0 ? p.avg : null));
  const hasAvg = avgList.some((v) => v !== null);
  const preClose = Number.isFinite(Number(got.preClose)) && Number(got.preClose) > 0 ? Number(got.preClose) : null;
  const last = prices.length ? prices[prices.length - 1] : null;
  const candles = points.map((p) => ({
    d: `${got.day || '1970-01-01'} ${p.t}:00`,
    o: p.p,
    c: p.p,
    h: p.p,
    l: p.p,
    v: p.v || 0,
    a: Number.isFinite(p.a) && p.a > 0 ? p.a : (p.v ? p.p * p.v : 0),
  }));
  return {
    code,
    name: def.name,
    unit: def.unit,
    source,
    sourceLabel,
    note,
    day: got.day || '',
    preClose,
    first: prices[0] ?? null,
    last,
    high: prices.length ? round(Math.max(...prices), 3) : null,
    low: prices.length ? round(Math.min(...prices), 3) : null,
    avgLine: hasAvg ? avgList : null,
    change: preClose && last !== null ? round(last - preClose, 3) : null,
    pct: preClose && last !== null ? round(((last - preClose) / preClose) * 100, 2) : null,
    amplitude: preClose && prices.length
      ? round(((Math.max(...prices) - Math.min(...prices)) / preClose) * 100, 2)
      : null,
    volume: points.reduce((s, p) => s + (p.v || 0), 0),
    points: points.map((p) => [p.t, p.p]),
    candles,
    updatedAt: Date.now(),
  };
}

async function getMetalsIntraday(codes) {
  const wanted = (codes && codes.length ? codes : ['XAU', 'XAG', 'AU9999'])
    .map((c) => String(c || '').toUpperCase())
    .filter((c) => METAL_INTRADAY_DEFS[c]);
  const list = [...new Set(wanted)].slice(0, 4);
  return cached(`metals:${list.join(',')}`, 30000, async () => {
    const items = await mapLimit(list, 3, async (code) => {
      const def = METAL_INTRADAY_DEFS[code];
      const errors = [];
      if (def.eastmoneySecid) {
        try {
          const got = await fetchEastmoneyTrends(def.eastmoneySecid, 1);
          if (got.points.length >= 30) {
            return buildMetalIntraday(code, def, got, 'eastmoney', `${def.name} · 上海黄金交易所 Au99.99`);
          }
          errors.push('东财现货分时点不足');
        } catch (err) { errors.push(err.message); }
      }
      try {
        const got = await fetchSinaMinuteSeries(def.sinaType, def.sinaSymbol);
        const inner = def.sinaType === 'inner';
        return buildMetalIntraday(
          code, def, got, 'sina',
          inner ? `${def.name} · 沪金主连（上期所 1 分钟）` : `${def.name} · 1 分钟分时`,
          inner ? '上海金现货 Au99.99 的公开分钟线暂缺，图中为沪金主连（上期所），与现货存在基差。' : '',
        );
      } catch (err) { errors.push(err.message); }
      return {
        code, name: def.name, unit: def.unit,
        points: [], candles: [], error: errors.join(' / ') || '暂无分时数据',
        updatedAt: Date.now(),
      };
    });
    return { items, updatedAt: Date.now(), note: '分钟点来自新浪公开行情，可能有 1 分钟级延迟。' };
  });
}

function intradayPeriodLabel(period) {
  if (period === 1) return '1分钟分时';
  if (period === 5) return '5分钟分时';
  if (period === 15) return '15分钟分时';
  if (period === 30) return '30分钟分时';
  if (period === 60) return '60分钟分时';
  return '分时';
}

function calendarAgeDays(date) {
  const target = new Date(`${date}T12:00:00+08:00`).valueOf();
  const today = new Date(`${shanghaiToday()}T12:00:00+08:00`).valueOf();
  if (!Number.isFinite(target)) return 9999;
  return Math.max(0, Math.round((today - target) / 86400000));
}

async function fetchTencentDayMinute(symbol, date) {
  const url =
    'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/day/query' +
    `?code=${encodeURIComponent(symbol)}&date=${encodeURIComponent(date)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://gu.qq.com/', Accept: '*/*' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`腾讯分时 HTTP ${res.status}`);
  const json = await res.json();
  const node = json?.data?.[symbol];
  const target = String(date).replace(/-/g, '');
  const rows = Array.isArray(node?.data)
    ? node.data
        .filter((block) => String(block?.date || '') === target)
        .flatMap((block) => (Array.isArray(block?.data) ? block.data : []))
    : [];
  let prevVol = 0;
  let prevAmount = 0;
  const candles = [];
  for (const line of rows) {
    const parts = String(line).trim().split(/\s+/);
    if (parts.length < 3) continue;
    const t = parts[0];
    const price = num(parts[1]);
    const cumVol = num(parts[2]) || 0;
    const cumAmount = num(parts[3]) || 0;
    if (price === null) continue;
    const time = `${t.slice(0, 2)}:${t.slice(2, 4)}`;
    const volume = Math.max(0, cumVol - prevVol);
    const amount = Math.max(0, cumAmount - prevAmount);
    prevVol = cumVol;
    prevAmount = cumAmount;
    candles.push({
      d: `${date} ${time}:00`,
      o: price, c: price, h: price, l: price,
      v: volume, a: amount,
      change: null, pct: null, amplitude: null, turnover: null,
    });
  }
  return { candles, qt: node?.qt?.[symbol] || null };
}

async function fetchEastmoneyMinute(secid, date, period) {
  const compact = date.replace(/-/g, '');
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    `?secid=${encodeURIComponent(secid)}` +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
    `&klt=${period}&fqt=0&beg=${compact}&end=${compact}&lmt=1000`;
  const json = await fetchJSON(url, 20000);
  const rows = json?.data?.klines;
  if (!Array.isArray(rows)) return [];
  const candles = [];
  for (const line of rows) {
    const p = String(line).split(',');
    if (p.length < 6) continue;
    const time = String(p[0]);
    if (time.slice(0, 10) !== date) continue;
    const o = num(p[1]);
    const c = num(p[2]);
    const h = num(p[3]);
    const l = num(p[4]);
    if ([o, c, h, l].some((v) => v === null)) continue;
    candles.push({
      d: `${time}:00`,
      o, c, h, l,
      v: num(p[5]) || 0,
      a: num(p[6]),
      change: null, pct: null, amplitude: null, turnover: null,
    });
  }
  return candles;
}

async function fetchSinaMinute(symbol, date, scale) {
  const url =
    'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData' +
    `?symbol=${encodeURIComponent(symbol)}&scale=${scale}&ma=no&datalen=1023`;
  const text = await fetchSinaText(url, 25000);
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error('新浪分时返回格式异常'); }
  if (!Array.isArray(rows)) return [];
  const candles = [];
  for (const r of rows) {
    const day = String(r?.day || '');
    if (day.slice(0, 10) !== date) continue;
    const o = num(r.open);
    const c = num(r.close);
    const h = num(r.high);
    const l = num(r.low);
    if ([o, c, h, l].some((v) => v === null)) continue;
    candles.push({
      d: day.length === 16 ? `${day}:00` : day,
      o, c, h, l,
      v: num(r.volume) || 0,
      a: num(r.amount),
      change: null, pct: null, amplitude: null, turnover: null,
    });
  }
  return candles;
}

async function fetchIntradayDaily(secid) {
  try {
    return await fetchAshareSina(secid, 101, 3000);
  } catch {
    return [];
  }
}

function buildIntradayResult({ secid, date, period, candles, daily, fallbackPreClose, source }) {
  const dayIndex = daily.findIndex((c) => String(c.d).slice(0, 10) === date);
  const prev = dayIndex > 0 ? daily[dayIndex - 1] : null;
  const preClose = prev ? Number(prev.c) : (Number.isFinite(Number(fallbackPreClose)) ? Number(fallbackPreClose) : null);
  const first = Number(candles[0].c);
  const last = Number(candles[candles.length - 1].c);
  const change = preClose ? last - preClose : null;
  const pct = preClose ? (change / preClose) * 100 : null;
  const points = candles.map((c) => ({ t: String(c.d).slice(11, 16), p: c.c }));
  return {
    secid,
    date,
    name: KLINE_META[secid] || '',
    period,
    periodLabel: intradayPeriodLabel(period),
    points,
    candles,
    preClose,
    first,
    last,
    change: change === null ? null : round(change, 2),
    pct: pct === null ? null : round(pct, 2),
    updatedAt: Date.now(),
    source,
  };
}

async function getIntraday(secid, date) {
  const symbol = sinaAshareSymbol(secid);
  if (!symbol) throw new Error('不支持的 A 股代码');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('日期格式应为 YYYY-MM-DD');
  const key = `intraday:${secid}:${date}`;
  const ttl = date === shanghaiToday() ? 30000 : 3600000;
  return cached(key, ttl, async () => {
    const daily = await fetchIntradayDaily(secid);
    const age = calendarAgeDays(date);
    const attempts = [];
    if (age <= 8) {
      attempts.push({ period: 1, source: 'tencent', run: async () => {
        const { candles, qt } = await fetchTencentDayMinute(symbol, date);
        return { candles, preClose: num(qt?.[4]) };
      } });
    }
    if (age <= 30) {
      attempts.push({ period: 5, source: 'eastmoney', run: async () => ({ candles: await fetchEastmoneyMinute(secid, date, 5) }) });
    }
    if (age <= 45) {
      attempts.push({ period: 5, source: 'sina', run: async () => ({ candles: await fetchSinaMinute(symbol, date, 5) }) });
    }
    if (age <= 120) {
      attempts.push({ period: 15, source: 'sina', run: async () => ({ candles: await fetchSinaMinute(symbol, date, 15) }) });
    }
    if (age <= 220) {
      attempts.push({ period: 30, source: 'sina', run: async () => ({ candles: await fetchSinaMinute(symbol, date, 30) }) });
    }
    if (age <= 430) {
      attempts.push({ period: 60, source: 'sina', run: async () => ({ candles: await fetchSinaMinute(symbol, date, 60) }) });
    }
    let lastError = null;
    for (const attempt of attempts) {
      try {
        const got = await attempt.run();
        if (Array.isArray(got.candles) && got.candles.length >= 2) {
          return buildIntradayResult({
            secid, date,
            period: attempt.period,
            candles: got.candles,
            daily,
            fallbackPreClose: got.preClose,
            source: attempt.source,
          });
        }
      } catch (err) {
        lastError = err;
      }
    }
    const dayIndex = daily.findIndex((c) => String(c.d).slice(0, 10) === date);
    if (dayIndex >= 0) {
      const row = daily[dayIndex];
      const prev = dayIndex > 0 ? daily[dayIndex - 1] : null;
      const preClose = prev ? Number(prev.c) : Number(row.o);
      const pct = preClose ? ((Number(row.c) - preClose) / preClose) * 100 : null;
      return {
        secid,
        date,
        name: KLINE_META[secid] || '',
        period: 'day',
        periodLabel: '日线摘要',
        points: [
          { t: '09:30', p: row.o },
          { t: '15:00', p: row.c },
        ],
        candles: [{ ...row, change: null, pct: null, amplitude: null, turnover: null }],
        preClose,
        first: Number(row.o),
        last: Number(row.c),
        change: Number(row.c) - preClose,
        pct: round(pct, 2),
        high: Number(row.h),
        low: Number(row.l),
        volume: row.v,
        amount: row.a === null || row.a === undefined ? null : Number(row.a) * 1e4,
        updatedAt: Date.now(),
        source: 'daily',
        note: '免费分钟数据最多回溯约 1 年，该日期展示日线摘要。',
      };
    }
    throw new Error(lastError ? `未获取到 ${date} 的分时数据` : `未找到 ${date} 的行情数据，请选择交易日`);
  });
}

async function getIndexCompare(days = 250) {
  const n = Math.max(30, Math.min(500, Number(days) || 250));
  return cached(`indexcompare:${n}`, 300000, async () => {
    const defs = [
      ['1.000001', '上证指数'],
      ['0.399001', '深证成指'],
      ['0.399006', '创业板指'],
      ['1.000300', '沪深300'],
      ['1.000688', '科创50'],
    ];
    const series = await mapLimit(defs, 3, async ([secid, name]) => {
      const k = await getKline(secid, 101, n).catch(() => null);
      if (!k || !Array.isArray(k.candles) || k.candles.length < 2) return null;
      const base = Number(k.candles[0].c);
      if (!base) return null;
      const lastCandle = k.candles[k.candles.length - 1];
      const closes = k.candles.map((c) => Number(c.c)).filter((v) => Number.isFinite(v));
      return {
        secid,
        code: k.code || secid.split('.')[1],
        name,
        first: round(base, 2),
        last: round(Number(lastCandle.c), 2),
        dayPct: round(Number(lastCandle.pct) || 0, 2),
        changePct: round(((Number(lastCandle.c) - base) / base) * 100, 2),
        high: round(Math.max(...closes), 2),
        low: round(Math.min(...closes), 2),
        data: k.candles.map((c) => [c.d, round(Number(c.c), 2)]),
      };
    });
    return {
      items: series.filter(Boolean),
      days: n,
      updatedAt: Date.now(),
      note: '五大指数各自独立坐标展示近一年走势，避免高波动指数压缩其他指数。',
    };
  });
}

// 分时 K 线的「昨收」基准：不能拿倒数第二根分钟线充数（那是 14:59 的收盘价），
// 否则早盘下跌、午后拉回时整条曲线的红绿会跟顶部涨跌幅对不上。
async function resolveIntradayPreClose(secid, date) {
  try {
    const ov = await getOverview();
    const pool = [
      ...(ov.cn || []), ...(ov.global || []),
      ...(ov.commodities || []), ...(ov.fx || []),
    ];
    const hit = pool.find((q) => q && q.secid === secid);
    if (hit && Number.isFinite(Number(hit.prevClose)) && Number(hit.prevClose) > 0) {
      return Number(hit.prevClose);
    }
  } catch { /* 快照不可用时回退到日线 */ }
  try {
    const daily = await getKline(secid, 101, 40);
    const prior = (daily.candles || []).filter((c) => String(c.d).slice(0, 10) < date);
    const prev = prior[prior.length - 1];
    if (prev && Number.isFinite(Number(prev.c))) return Number(prev.c);
  } catch { /* 日线也不可用时返回 null，前端会退回快照昨收 */ }
  return null;
}

/* =========================================================
   A股指数多周期涨跌（近1周 / 1月 / 3月 / 6月）
   用日线收盘价做「N 个交易日前收盘 → 最新收盘」的区间涨跌幅，
   与行情终端里的「阶段涨幅」口径一致，避免按自然日算错交易日。
   ========================================================= */
const A_PERIOD_DEFS = [
  { key: 'w1', label: '近1周', days: 5 },
  { key: 'm1', label: '近1月', days: 20 },
  { key: 'm3', label: '近3月', days: 60 },
  { key: 'm6', label: '近6月', days: 120 },
];

const A_PERIOD_INDICES = [
  ['1.000001', '上证指数'],
  ['0.399001', '深证成指'],
  ['0.399006', '创业板指'],
  ['1.000688', '科创50'],
  ['1.000300', '沪深300'],
  ['1.000016', '上证50'],
  ['1.000905', '中证500'],
  ['1.000852', '中证1000'],
  ['0.899050', '北证50'],
];

async function getIndexPeriods() {
  return cached('indexperiods', 180000, async () => {
    const need = Math.max(...A_PERIOD_DEFS.map((p) => p.days)) + 60;
    const items = await mapLimit(A_PERIOD_INDICES, 3, async ([secid, name]) => {
      const k = await getKline(secid, 101, need).catch(() => null);
      const candles = (k && Array.isArray(k.candles)) ? k.candles : [];
      if (candles.length < 22) return null;
      const lastCandle = candles[candles.length - 1];
      const lastClose = Number(lastCandle.c);
      const prevClose = Number(candles[candles.length - 2].c);
      if (!Number.isFinite(lastClose) || lastClose <= 0) return null;
      const pctOf = (base) => (Number.isFinite(base) && base > 0
        ? round(((lastClose - base) / base) * 100, 2)
        : null);
      const periods = {};
      const bases = {};
      for (const p of A_PERIOD_DEFS) {
        const idx = candles.length - 1 - p.days;
        const base = idx >= 0 ? Number(candles[idx].c) : null;
        bases[p.key] = Number.isFinite(base) ? round(base, 2) : null;
        periods[p.key] = pctOf(base);
      }
      return {
        secid,
        code: k.code || secid.split('.')[1],
        name: k.name || name,
        close: round(lastClose, 2),
        date: String(lastCandle.d).slice(0, 10),
        todayPct: pctOf(prevClose),
        periods,
        bases,
      };
    });
    const rows = items.filter(Boolean);
    if (!rows.length) throw new Error('暂未获取到指数多周期数据');
    const avg = (key) => {
      const vals = rows.map((r) => r.periods[key]).filter((v) => Number.isFinite(v));
      return vals.length ? round(vals.reduce((s, v) => s + v, 0) / vals.length, 2) : null;
    };
    return {
      items: rows,
      periods: A_PERIOD_DEFS,
      average: Object.fromEntries(A_PERIOD_DEFS.map((p) => [p.key, avg(p.key)])),
      upCount: Object.fromEntries(A_PERIOD_DEFS.map((p) => [p.key, rows.filter((r) => Number(r.periods[p.key]) > 0).length])),
      total: rows.length,
      updatedAt: Date.now(),
      note: '区间涨跌按交易日计：近1周=5个交易日，1月=20，3月=60，6月=120；基准为对应交易日的收盘点位。',
    };
  });
}

async function getKline(secid, klt = 101, limit = 160) {
  const key = `kline:${secid}:${klt}:${limit}`;
  // 当天分时是「实时」视图，缓存必须足够短，否则用户看到的是一分钟前的曲线。
  const ttl = klt === 1 ? 12000 : klt === 5 || klt === 15 || klt === 30 || klt === 60 ? 60000 : 180000;
  return cached(key, ttl, async () => {
    let candles;
    let source = 'sina';
    if (SINA_FUTURES_KLINE[secid]) {
      candles = await fetchSinaFuturesKline(secid, limit);
      source = 'sina-futures';
    } else if (TENCENT_KLINE[secid]) {
      candles = await fetchTencentKline(secid, limit);
      source = 'tencent';
    } else if (/^\d+\.\d{6}$/.test(secid)) {
      candles = await fetchAshareSina(secid, klt, limit);
      source = 'sina';
    } else {
      candles = await fetchEastmoneyKline(secid, klt, limit);
      source = 'eastmoney';
    }
    if (!candles || !candles.length) throw new Error('未获取到 K 线数据');
    const metaName = KLINE_META[secid] || '';
    const last = candles[candles.length - 1];
    const intradayBars = [1, 5, 15, 30, 60].includes(klt);
    const sameSessionDay = intradayBars && candles.length > 1
      && String(candles[0].d).slice(0, 10) === String(last.d).slice(0, 10);
    let preClose;
    if (sameSessionDay) {
      preClose = await resolveIntradayPreClose(secid, String(last.d).slice(0, 10));
      if (!Number.isFinite(Number(preClose)) || Number(preClose) <= 0) {
        // 兜底：用当日开盘价当作基准，避免整条曲线被误判成「上涨」。
        preClose = Number(last.o) || null;
      }
    } else {
      preClose = candles.length > 1 ? candles[candles.length - 2].c : last.o;
    }
    return {
      secid,
      code: secid.split('.')[1] || secid,
      name: metaName,
      decimal: 2,
      preClose,
      candles,
      series: computeSeries(candles),
      updatedAt: Date.now(),
      source,
    };
  });
}

function normalizeSector(d) {
  return {
    code: d.f12,
    name: d.f14 || '',
    price: num(d.f2),
    pct: num(d.f3),
    amount: num(d.f6),
    amountYi: num(d.f6) === null ? null : round(num(d.f6) / 1e8, 1),
    mktCapYi: num(d.f20) === null ? null : round(num(d.f20) / 1e8, 1),
    main: num(d.f62) === null ? 0 : round(num(d.f62) / 1e8, 2),
    mainPct: num(d.f184),
    super: num(d.f66) === null ? 0 : round(num(d.f66) / 1e8, 2),
    large: num(d.f72) === null ? 0 : round(num(d.f72) / 1e8, 2),
    medium: num(d.f78) === null ? 0 : round(num(d.f78) / 1e8, 2),
    small: num(d.f84) === null ? 0 : round(num(d.f84) / 1e8, 2),
    up: num(d.f104),
    down: num(d.f105),
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const BOARDS_FILE = path.join(__dirname, 'data', 'boards.json');
let boardsCache = null;

async function getBoards() {
  if (boardsCache) return boardsCache;
  try {
    boardsCache = JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8'));
    return boardsCache;
  } catch { /* 文件缺失时从东方财富页面解析 */ }
  const html = await (await fetch('https://data.eastmoney.com/bkzj/hy.html', {
    headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://data.eastmoney.com/' },
  })).text();
  const parts = html.split(/<div class="pop-cont"/).slice(1);
  const keys = ['industry', 'concept', 'region'];
  const parsed = { updatedAt: new Date().toISOString() };
  parts.forEach((part, i) => {
    const section = part.split('</div>')[0];
    parsed[keys[i]] = [...section.matchAll(/<a href="\/bkzj\/(BK\d+)\.html">([^<]+)<\/a>/g)]
      .map((m) => ({ code: m[1], name: m[2] }));
  });
  boardsCache = parsed;
  try {
    fs.mkdirSync(path.dirname(BOARDS_FILE), { recursive: true });
    fs.writeFileSync(BOARDS_FILE, JSON.stringify(parsed, null, 2));
  } catch { /* 忽略写入失败 */ }
  return parsed;
}

async function fetchBoardQuotes(secids) {
  const unique = [...new Set(secids)];
  const chunks = [];
  for (let i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50));
  const responses = await mapLimit(chunks, 3, async (chunk) => {
    const fields = 'f2,f3,f6,f12,f13,f14,f20,f62,f66,f69,f72,f75,f78,f81,f84,f87,f104,f105,f184';
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=' +
      fields +
      `&secids=${chunk.join(',')}`;
    return fetchJSON(url);
  });
  const map = new Map();
  for (const json of responses) {
    for (const d of json?.data?.diff || []) map.set(`${d.f13}.${d.f12}`, normalizeSector(d));
  }
  return unique.map((id) => map.get(id)).filter(Boolean);
}

async function getSectors(type = 'industry') {
  return cached(`sectors:${type}`, 45000, async () => {
    const { data } = await runSource('sectors', [type]);
    return { ...data, updatedAt: Date.now() };
  });
}

/* =========================================================
   板块资金 · 多周期
   今日 / 近3日 / 近5日 / 近2周 / 近1月 的热门板块排行，
   并给出「当前周期 vs 上一等长周期」的 TOP10 对比数据。
   ========================================================= */
const SECTOR_FS = { industry: 'm:90+t:2', concept: 'm:90+t:3' };
const SECTOR_PERIODS = {
  today: { label: '今日', stat: 1, days: 1, mainField: 'f62', mainPctField: 'f184', pctField: 'f3', main: 'f62' },
  '3d': { label: '近3日', stat: 3, days: 3, mainField: 'f267', mainPctField: 'f268', pctField: 'f127', main: 'f267' },
  '5d': { label: '近5日', stat: 5, days: 5, mainField: 'f164', mainPctField: 'f165', pctField: 'f109', main: 'f164' },
  '10d': { label: '近2周', stat: 10, days: 10, mainField: 'f174', mainPctField: 'f175', pctField: 'f160', main: 'f174' },
  '20d': { label: '近1月', stat: 20, days: 20, mainField: 'f178', mainPctField: 'f179', pctField: 'f161', main: 'f178' },
};

function sectorPeriodConf(period) {
  return SECTOR_PERIODS[period] || SECTOR_PERIODS.today;
}

// 东财板块接口被限流时的熔断时间点，避免每个周期各自等满超时。
let emClistBlockedUntil = 0;
let boardFlowBlockedUntil = 0;

const EM_SECTOR_FIELDS =
  'f2,f3,f6,f12,f13,f14,f20,f62,f104,f105,f184,f267,f268,f127,f164,f165,f109,f174,f175,f160,f161,f178,f179';

function parseSectorFlowRow(d, conf) {
  const main = num(d[conf.mainField]);
  const pct = num(d[conf.pctField]);
  const mainPct = num(d[conf.mainPctField]);
  return {
    code: String(d.f12),
    name: String(d.f14 || ''),
    price: num(d.f2),
    pct: pct === null ? num(d.f3) : pct,
    main: main === null ? null : round(main / 1e8, 2),
    mainPct: mainPct === null ? num(d.f184) : mainPct,
    amountYi: num(d.f6) === null ? null : round(num(d.f6) / 1e8, 1),
    up: num(d.f104),
    down: num(d.f105),
  };
}

/** 用板块清单批量取快照：一次拿回今日 / 3日 / 5日 / 10日等多周期字段，覆盖全部板块。 */
async function fetchEmSectorUlist(type) {
  if (Date.now() < emClistBlockedUntil) throw new Error('东方财富板块资金接口暂不可用');
  const boards = await getBoards();
  const list = type === 'concept'
    ? boards.concept || []
    : (boards.industry || []).filter((b) => !/[ⅡⅢ]$/.test(b.name));
  if (!list.length) throw new Error('缺少板块清单缓存');
  const chunks = [];
  for (let i = 0; i < list.length; i += 50) chunks.push(list.slice(i, i + 50));
  let batches;
  try {
    batches = await mapLimit(chunks, 3, (part) => {
      const url =
        'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=' +
        EM_SECTOR_FIELDS +
        `&secids=${part.map((b) => `90.${b.code}`).join(',')}`;
      return fetchJSON(url, 9000, 2);
    });
  } catch (err) {
    emClistBlockedUntil = Date.now() + 90000;
    throw err;
  }
  const map = new Map();
  for (const json of batches) {
    for (const d of json?.data?.diff || []) map.set(String(d.f12), d);
  }
  if (!map.size) throw new Error('板块资金榜暂不可用');
  return map;
}

async function fetchEmSectorFlowRank(type, conf) {
  const rows = await fetchEmSectorUlist(type);
  const items = [...rows.values()]
    .map((d) => parseSectorFlowRow(d, conf))
    .filter((x) => x.name && x.main !== null);
  if (items.length) return items;

  // ulist 不带该周期字段时，退回 clist 的 stat 排行接口。
  const fields = EM_SECTOR_FIELDS;
  const url =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2' +
    `&fid=${conf.mainField}&fs=${SECTOR_FS[type]}&stat=${conf.stat}&fields=${fields}`;
  let json;
  try {
    json = await fetchJSON(url, 9000, 2);
  } catch (err) {
    emClistBlockedUntil = Date.now() + 90000;
    throw err;
  }
  const diff = json?.data?.diff;
  const list = Array.isArray(diff) ? diff : Object.values(diff || {});
  return list
    .map((d) => parseSectorFlowRow(d, conf))
    .filter((x) => x.name && x.main !== null);
}

/** 单个板块的每日主力净额历史（东财资金流日线），单位亿元。 */
async function fetchBoardFlowHistory(code, days = 60) {
  if (Date.now() < boardFlowBlockedUntil) throw new Error('板块资金历史暂不可用');
  const key = `boardflow:${code}:${days}`;
  return cached(key, 30 * 60 * 1000, async () => {
    const url =
      'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get' +
      `?lmt=${days}&klt=101&secid=90.${encodeURIComponent(code)}&fields1=f1,f2,f3,f7` +
      '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
    let json;
    try {
      json = await fetchJSON(url, 8000, 2);
    } catch (err) {
      boardFlowBlockedUntil = Date.now() + 120000;
      throw err;
    }
    const lines = json?.data?.klines;
    if (!Array.isArray(lines) || !lines.length) throw new Error('板块资金历史暂不可用');
    return lines
      .map((line) => {
        const p = String(line).split(',');
        const main = num(p[1]);
        if (main === null) return null;
        return { date: p[0], mainYi: round(main / 1e8, 2), mainPct: num(p[6]) };
      })
      .filter(Boolean);
  });
}

function sumArray(list) {
  return list.reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
}

async function getSectorPeriod(type = 'industry', period = 'today') {
  const t = SECTOR_FS[type] ? type : 'industry';
  const conf = sectorPeriodConf(period);
  return cached(`sectorperiod:${t}:${period}`, 60000, async () => {
    let items = [];
    let source = 'eastmoney';
    let sampleLimited = false;
    let fallbackNote = '';
    try {
      items = await fetchEmSectorFlowRank(t, conf);
    } catch (err) {
      if (period !== 'today') {
        // 多周期榜依赖东财；失败时不直接报错，先留空走下面的历史累加兜底。
        items = [];
      } else {
        const base = await getSectors(t);
        source = base.source || 'sina';
        items = (base.items || []).map((x) => ({
          code: String(x.code),
          name: x.name,
          price: x.price,
          pct: x.pct,
          main: x.main,
          mainPct: x.mainPct,
          amountYi: x.amountYi,
          up: x.up,
          down: x.down,
        })).filter((x) => x.main !== null && Number.isFinite(x.main));
        fallbackNote = '东方财富板块资金接口不可用，今日视图已切换到备用数据源，历史对比图暂缺。';
      }
    }

    // 东财没有该周期榜单（如近1月）或接口不可用时：
    // 用近2周活跃板块的每日主力净额历史逐日累加，得到样本内排行。
    if (!items.length && period !== 'today') {
      // 只读已缓存的其它周期，避免多周期互相 await 形成环。
      let base = { items: [] };
      for (const candidate of ['10d', '5d', '3d']) {
        if (candidate === period) continue;
        const hit = cache.get(`sectorperiod:${t}:${candidate}`);
        if (hit && hit.val && Array.isArray(hit.val.items) && hit.val.items.length) {
          base = hit.val;
          break;
        }
      }
      if (!base.items.length) {
        base = await getSectors(t).catch(() => ({ items: [] }));
      }
      const candidates = [...(base.items || [])].sort((a, b) => (b.main || 0) - (a.main || 0)).slice(0, 60);
      const calculated = await mapLimit(candidates, 4, async (x) => {
        try {
          const hist = await fetchBoardFlowHistory(x.code, Math.min(120, conf.days * 2 + 10));
          const values = hist.map((h) => h.mainYi);
          if (values.length < conf.days) return null;
          const sum = round(sumArray(values.slice(-conf.days)), 2);
          return { ...x, main: sum, pct: x.pct };
        } catch {
          return null;
        }
      });
      items = calculated.filter(Boolean);
      if (items.length) {
        sampleLimited = true;
        fallbackNote = `${conf.label}榜单由近2周活跃板块的每日主力净额逐日累加得出，样本外板块未参与排名。`;
      }
    }

    const sorted = [...items].sort((a, b) => b.main - a.main);
    if (!sorted.length) {
      return {
        type: t,
        period,
        periodLabel: conf.label,
        days: conf.days,
        items: [],
        topIn: [],
        topOut: [],
        stats: { netInflow: 0, inflowCount: 0, outflowCount: 0, total: 0 },
        compare: { inflow: [], outflow: [] },
        error: period === 'today'
          ? '板块资金接口暂不可用，稍后重试'
          : `${conf.label}板块资金需要东方财富板块资金接口，当前接口不可用`,
        note: '',
        sampleLimited: false,
        source,
        updatedAt: Date.now(),
      };
    }
    const topIn = sorted.slice(0, 10);
    const topOut = [...sorted].reverse().slice(0, 10);
    const focus = [...topIn, ...topOut];

    // TOP10 的逐日主力净额历史，用于「与昨日/上一周期比较」和 sparkline。
    const need = Math.min(120, Math.max(conf.days * 2 + 4, 8));
    const historyMap = new Map();
    if (source === 'eastmoney') {
      await mapLimit(focus, 5, async (x) => {
        try {
          historyMap.set(x.code, await fetchBoardFlowHistory(x.code, need));
        } catch { /* 单个板块失败不影响整体 */ }
      });
    }

    const enrich = (x) => {
      const hist = historyMap.get(x.code) || [];
      const n = conf.days;
      const values = hist.map((h) => h.mainYi);
      const periodMain = values.length >= n ? round(sumArray(values.slice(-n)), 2) : x.main;
      const prevMain = values.length >= n * 2 ? round(sumArray(values.slice(-n * 2, -n)), 2) : null;
      return {
        ...x,
        periodMain,
        prevMain,
        changeVsPrev: prevMain === null ? null : round(periodMain - prevMain, 2),
        history: values.slice(-6).map((v) => round(v, 2)),
      };
    };

    const topInEnriched = topIn.map(enrich);
    const topOutEnriched = topOut.map(enrich);
    const netInflow = round(sumArray(sorted.map((x) => x.main)), 2);
    const inflowCount = sorted.filter((x) => x.main > 0).length;
    const outflowCount = sorted.filter((x) => x.main < 0).length;
    const byPct = [...items].filter((x) => Number.isFinite(x.pct)).sort((a, b) => b.pct - a.pct);

    return {
      type: t,
      period,
      periodLabel: conf.label,
      days: conf.days,
      items: sorted,
      topIn: topInEnriched,
      topOut: topOutEnriched,
      compare: {
        currentLabel: conf.days === 1 ? '今日' : '本期',
        previousLabel: conf.days === 1 ? '昨日' : '上期',
        flowLabel: conf.days === 1 ? '今日主力净额' : `${conf.label}主力净额`,
        inflow: topInEnriched.map((x) => ({ code: x.code, name: x.name, current: x.periodMain, previous: x.prevMain })),
        outflow: topOutEnriched.map((x) => ({ code: x.code, name: x.name, current: x.periodMain, previous: x.prevMain })),
      },
      stats: {
        netInflow,
        inflowCount,
        outflowCount,
        total: sorted.length,
        topPct: byPct[0] ? { name: byPct[0].name, pct: byPct[0].pct } : null,
        worstPct: byPct.length ? { name: byPct[byPct.length - 1].name, pct: byPct[byPct.length - 1].pct } : null,
      },
      sampleLimited,
      note: fallbackNote,
      source,
      updatedAt: Date.now(),
    };
  });
}

function sinaSecid(symbol) {
  const s = String(symbol || '');
  const code = s.replace(/^(sh|sz|bj)/, '');
  const prefix = s.slice(0, 2);
  const market = prefix === 'sh' ? 1 : 0;
  return { secid: `${market}.${code}`, code, market };
}

async function fetchSinaJSON(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': EM_HEADERS['User-Agent'],
      Referer: 'https://finance.sina.com.cn/',
      Accept: '*/*',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`新浪接口 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = new TextDecoder('gbk').decode(buf);
  const json = JSON.parse(text);
  if (json && json.__ERROR) throw new Error(json.__ERRORMSG || '新浪接口返回错误');
  return json;
}

async function getRank(type = 'gain', limit = 20) {
  return cached(`rank:${type}:${limit}`, 15000, async () => {
    const { data } = await runSource('rank', [type, Math.min(50, Math.max(1, limit))]);
    return data;
  });
}

/* =========================================================
   基金 / ETF 数据
   ========================================================= */
const FUND_FALLBACK = [
  ['510300', '沪深300ETF华泰柏瑞', 1],
  ['510500', '中证500ETF南方', 1],
  ['510050', '上证50ETF华夏', 1],
  ['588000', '科创50ETF华夏', 1],
  ['159915', '创业板ETF易方达', 0],
  ['159919', '沪深300ETF嘉实', 0],
  ['512690', '酒ETF鹏华', 1],
  ['512880', '证券ETF国泰', 1],
  ['512480', '半导体ETF国联安', 1],
  ['515790', '光伏ETF华泰柏瑞', 1],
  ['513100', '纳指ETF国泰', 1],
  ['518880', '黄金ETF华安', 1],
];

let etfUniverseCache = null;

function isEtfLike(code, name = '') {
  if (/ETF|LOF/i.test(String(name))) return true;
  return /^(51|56|58|15|16|18)/.test(String(code));
}

function fundSecid(code) {
  const c = String(code);
  if (/^5/.test(c)) return `1.${c}`;
  if (/^(15|16|18)/.test(c)) return `0.${c}`;
  return null;
}

function fundCategory(name) {
  const n = String(name || '');
  if (/货币|添益|快线|现金|日利|保证金|理财/.test(n)) return 'money';
  if (/债|国债|城投|信用|短融|政金|金融债/.test(n)) return 'bond';
  if (/黄金|白银|有色|原油|豆粕|商品|能源化工/.test(n)) return 'commodity';
  return 'equity';
}

async function fetchFundJSON(url, referer = 'https://fund.eastmoney.com/') {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: referer,
      Accept: 'application/json,text/plain,*/*',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`基金接口 HTTP ${res.status}`);
  return res.json();
}

async function fetchFundText(url, timeout = 25000) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await acquireUpstream();
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': EM_HEADERS['User-Agent'],
          Referer: 'https://fund.eastmoney.com/',
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`基金数据接口 HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < 2) await sleep(400 * (attempt + 1) + Math.floor(Math.random() * 200));
    } finally {
      releaseUpstream();
    }
  }
  throw lastError || new Error('基金数据接口请求失败');
}

async function fetchFundQuotes(secids) {  const unique = [...new Set(secids)];
  const chunks = [];
  for (let i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50));
  const responses = await mapLimit(chunks, 3, async (chunk) => {
    const fields = 'f2,f3,f5,f6,f12,f13,f14,f15,f16,f17,f18,f62,f184';
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=' +
      fields +
      `&secids=${chunk.join(',')}`;
    return fetchJSON(url);
  });
  const map = new Map();
  for (const json of responses) {
    for (const d of json?.data?.diff || []) {
      const q = normalizeQuote(d, 'fund');
      q.type = 'etf';
      q.mainYi = q.main === null ? null : round(q.main / 1e8, 2);
      map.set(q.secid, q);
    }
  }
  return unique.map((id) => map.get(id)).filter(Boolean);
}

async function getEtfUniverse() {  if (etfUniverseCache && Date.now() - etfUniverseCache.at < 600000) {
    return etfUniverseCache.items;
  }
  let items = [];
  try {
    const pages = await mapLimit([1, 2, 3, 4], 2, async (page) => {
      const url =
        'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
        `?page=${page}&num=100&sort=amount&asc=0&node=etf_hq_fund&symbol=&_s_r_a=page`;
      const rows = await fetchSinaJSON(url);
      return (Array.isArray(rows) ? rows : []).map((d) => {
        const symbol = String(d.symbol || '');
        const market = symbol.startsWith('sh') ? 1 : 0;
        const code = String(d.code || symbol.replace(/^(sh|sz)/, ''));
        return {
          code,
          name: d.name || '',
          market,
          secid: `${market}.${code}`,
          price: num(d.trade),
          pct: num(d.changepercent),
          amount: num(d.amount),
          amountYi: num(d.amount) === null ? null : round(num(d.amount) / 1e8, 2),
          high: num(d.high),
          low: num(d.low),
          open: num(d.open),
          prevClose: num(d.settlement),
          volume: num(d.volume),
          type: 'etf',
          category: fundCategory(d.name),
        };
      });
    });
    items = pages.flat();
  } catch { /* 使用内置样本 */ }

  const dedup = new Map();
  for (const item of items) if (item.code) dedup.set(item.code, item);
  if (!dedup.size) {
    for (const [code, name, market] of FUND_FALLBACK) {
      dedup.set(code, {
        code, name, market, secid: `${market}.${code}`,
        price: null, pct: null, amount: null, amountYi: null,
        high: null, low: null, open: null, prevClose: null, volume: null, type: 'etf',
        category: fundCategory(name),
      });
    }
  }
  const sorted = [...dedup.values()].sort((a, b) => (b.amount || 0) - (a.amount || 0));
  etfUniverseCache = { at: Date.now(), items: sorted };
  return sorted;
}

async function getEtfFlow(type = 'inflow', limit = 30, category = 'all') {
  return cached(`etfFlow:${type}:${limit}:${category}`, 60000, async () => {
    try {
      const { data } = await runSource('etfFlow', [type, limit, category]);
      return data;
    } catch (err) {
      // ETF 资金流只有东方财富提供，接口不可用时返回可读的降级结果，避免整页报错。
      return {
        type,
        category,
        items: [],
        universe: 0,
        totalNet: null,
        inflowCount: 0,
        outflowCount: 0,
        categories: [],
        unavailable: true,
        reason: err.message || 'ETF 资金流暂无可用数据源',
        updatedAt: Date.now(),
        source: 'none',
      };
    }
  });
}

async function buildEtfFlow(type = 'inflow', limit = 30, category = 'all') {
  return cached(`fundflow:${type}:${limit}:${category}`, 60000, async () => {
    const universe = await getEtfUniverse();
    const quotes = await fetchFundQuotes(universe.map((x) => x.secid));
    const qmap = new Map(quotes.map((q) => [q.code, q]));
    const all = universe.map((u) => {
      const q = qmap.get(u.code);
      if (!q) return null;
      return {
        ...u,
        ...q,
        name: q.name || u.name,
        type: 'etf',
        category: u.category || fundCategory(q.name || u.name),
        mainYi: Number.isFinite(q.mainYi) ? q.mainYi : null,
      };
    }).filter((x) => x && Number.isFinite(x.mainYi));

    const categoryMap = new Map([
      ['equity', { key: 'equity', label: '股票 ETF', net: 0, count: 0 }],
      ['bond', { key: 'bond', label: '债券 ETF', net: 0, count: 0 }],
      ['commodity', { key: 'commodity', label: '商品 ETF', net: 0, count: 0 }],
      ['money', { key: 'money', label: '货币 ETF', net: 0, count: 0 }],
    ]);
    for (const item of all) {
      const c = categoryMap.get(item.category) || categoryMap.get('equity');
      c.net += item.mainYi;
      c.count += 1;
    }

    const filtered = category === 'all' ? all : all.filter((x) => x.category === category);
    filtered.sort((a, b) => type === 'outflow' ? a.mainYi - b.mainYi : b.mainYi - a.mainYi);
    const topInflow = [...filtered].sort((a, b) => b.mainYi - a.mainYi)[0] || null;
    const topOutflow = [...filtered].sort((a, b) => a.mainYi - b.mainYi)[0] || null;
    const totalNet = filtered.reduce((s, x) => s + x.mainYi, 0);
    const inflowCount = filtered.filter((x) => x.mainYi > 0).length;
    let date = null;
    try { date = (await getFlow('1.000001')).date; } catch { /* 忽略 */ }
    return {
      type,
      category,
      items: filtered.slice(0, Math.min(500, limit)),
      topInflow,
      topOutflow,
      universe: filtered.length,
      totalNet: round(totalNet, 1),
      inflowCount,
      outflowCount: filtered.length - inflowCount,
      categories: [...categoryMap.values()].map((c) => ({ ...c, net: round(c.net, 1) })),
      date,
      updatedAt: Date.now(),
      source: 'sina+eastmoney',
    };
  });
}

async function fetchFundNav(code, pages = 1) {
  const pageList = Array.from({ length: Math.max(1, pages) }, (_, i) => i + 1);
  const results = await mapLimit(pageList, 3, async (pageIndex) => {
    const url =
      'https://api.fund.eastmoney.com/f10/lsjz' +
      `?fundCode=${encodeURIComponent(code)}&pageIndex=${pageIndex}&pageSize=20&startDate=&endDate=&_=${Date.now()}`;
    return fetchFundJSON(url, 'https://fundf10.eastmoney.com/');
  });
  const rows = [];
  for (const json of results) {
    for (const row of json?.Data?.LSJZList || []) rows.push(row);
  }
  const seen = new Set();
  return rows
    .filter((r) => {
      if (!r.FSRQ || seen.has(r.FSRQ)) return false;
      seen.add(r.FSRQ);
      return true;
    })
    .sort((a, b) => String(b.FSRQ).localeCompare(String(a.FSRQ)));
}

async function getFundSearch(q) {
  const query = String(q || '').trim();
  if (!query) return { items: [] };
  const url =
    'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' +
    encodeURIComponent(query);
  const json = await fetchFundJSON(url);
  const mapped = (json?.Datas || []).slice(0, 12).map((d) => {
    const code = String(d.CODE || d.FundBaseInfo?.FCODE || '');
    const name = d.NAME || d.FundBaseInfo?.SHORTNAME || '';
    const type = isEtfLike(code, name) ? 'etf' : 'open';
    return {
      code,
      name,
      type,
      secid: type === 'etf' ? fundSecid(code) : null,
      ftype: d.FundBaseInfo?.FTYPE || '',
      category: d.CATEGORYDESC || '基金',
    };
  }).filter((x) => x.code);

  // 场外基金搜索通常不会把同名 ETF 排在前面，这里用 ETF 样本补一层匹配。
  let etfMatches = [];
  try {
    const universe = await getEtfUniverse();
    const lower = query.toLowerCase();
    etfMatches = universe
      .filter((e) => e.code === query || e.name.toLowerCase().includes(lower))
      .slice(0, 4)
      .map((e) => ({
        code: e.code,
        name: e.name,
        type: 'etf',
        secid: e.secid,
        ftype: '场内 ETF',
        category: '基金',
      }));
  } catch { /* 忽略 ETF 补全失败 */ }

  const seen = new Set();
  const items = [...etfMatches, ...mapped].filter((x) => {
    if (seen.has(x.code)) return false;
    seen.add(x.code);
    return true;
  }).slice(0, 15);
  return { items };
}

async function getFundWatch(codes, risk = 'balanced') {
  const list = [...new Set(codes.filter(Boolean))].slice(0, 20);
  if (!list.length) return { items: [], updatedAt: Date.now() };
  return cached(`fundwatch:${list.join(',')}:${risk}`, 30000, async () => {
    const today = shanghaiToday();
    const etfCodes = list.filter((c) => isEtfLike(c, ''));
    const openCodes = list.filter((c) => !isEtfLike(c, ''));
    const etfQuotes = etfCodes.length
      ? await fetchQuoteList(etfCodes.map((c) => fundSecid(c)).filter(Boolean), 'fund')
      : [];
    const infoRows = openCodes.length ? await fetchFundMNFInfo(openCodes).catch(() => []) : [];
    const infoMap = new Map(infoRows.map((r) => [r.FCODE, r]));
    // 已经有「今天」口径的场外基金不必再算；其余用场内穿透估算补上当日涨跌。
    const hasTodayInfo = (info) => {
      const gzToday =
        Number(info.GSZ) > 0 && Number.isFinite(num(info.GSZZL)) && String(info.GZTIME || '').startsWith(today);
      return gzToday || String(info.PDATE || '') === today;
    };
    const needEst = openCodes.filter((code) => {
      const info = infoMap.get(code);
      return !info || !hasTodayInfo(info);
    });
    const estMap = needEst.length
      ? await estimateFundDayPctBatch(
        needEst.map((code) => ({ code, name: (infoMap.get(code) || {}).SHORTNAME || '' })),
      ).catch(() => new Map())
      : new Map();
    const openItems = await mapLimit(openCodes, 3, async (code) => {
      const info = infoMap.get(code);
      const est = estMap.get(code) || null;
      if (info) {
        const nav = num(info.NAV);
        const navPct = num(info.NAVCHGRT);
        const navDate = String(info.PDATE || '');
        const r = resolveFundTodayPct({
          navDate,
          navPct,
          gsz: num(info.GSZ),
          gszzl: num(info.GSZZL),
          gzTime: info.GZTIME,
          est,
          today,
        });
        let price = nav;
        if (r.kind === 'estimate') price = num(info.GSZ) ?? nav;
        else if ((r.kind === 'etf' || r.kind === 'holdings') && nav && Number.isFinite(r.pct)) {
          price = round(nav * (1 + r.pct / 100), 4);
        }
        return {
          code,
          name: info.SHORTNAME || '',
          type: 'open',
          secid: null,
          price,
          nav,
          navAcc: num(info.ACCNAV),
          navDate,
          navPct,
          pct: r.pct,
          pctKind: r.kind,
          pctDate: r.date,
          pctLabel: r.label,
          pctNote: r.note,
          pctStale: r.kind === 'stale',
          date: navDate,
          estimateTime: r.kind === 'estimate' ? (info.GZTIME || '') : '',
          mainYi: null,
          mainPct: null,
          amountYi: null,
        };
      }
      try {
        const rows = await fetchFundNav(code, 1);
        const latest = rows[0];
        if (!latest) return null;
        const navDate = String(latest.FSRQ || '');
        const navPct = num(latest.JZZZL);
        const nav = num(latest.DWJZ);
        const r = resolveFundTodayPct({ navDate, navPct, gsz: 0, gszzl: null, gzTime: '', est, today });
        let price = nav;
        if ((r.kind === 'etf' || r.kind === 'holdings') && nav && Number.isFinite(r.pct)) {
          price = round(nav * (1 + r.pct / 100), 4);
        }
        return {
          code,
          name: '',
          type: 'open',
          secid: null,
          price,
          nav,
          navAcc: num(latest.LJJZ),
          navDate,
          navPct,
          pct: r.pct,
          pctKind: r.kind,
          pctDate: r.date,
          pctLabel: r.label,
          pctNote: r.note,
          pctStale: r.kind === 'stale',
          date: navDate,
          mainYi: null,
          mainPct: null,
          amountYi: null,
        };
      } catch { return null; }
    });
    const map = new Map();
    for (const q of etfQuotes) {
      map.set(q.code, {
        ...q,
        pctKind: 'market',
        pctDate: today,
        pctLabel: '场内实时',
        pctNote: '',
        pctStale: false,
        navDate: today,
        navPct: q.pct,
        date: today,
      });
    }
    for (const q of openItems) if (q) map.set(q.code, q);
    const items = list.map((c) => map.get(c)).filter(Boolean);
    // 自选基金与自选股保持同一套展示口径：主力净流入 + 技术评分 + 评级/仓位。
    await mapLimit(items, 3, async (item) => {
      try {
        if (item.type === 'etf' && item.secid) {
          const kline = await getKline(item.secid, 101, 120);
          item.advice = stockAdvice(
            { name: item.name || item.code, price: item.price, pct: item.pct, mainPct: item.mainPct },
            kline.candles,
            { risk },
          );
          return;
        }
        // 场外基金按最近净值序列计算均线 / RSI / MACD 技术评分。
        const rows = await fetchFundNav(item.code, 4);
        const candles = rows
          .slice()
          .reverse()
          .map((r) => {
            const c = num(r.DWJZ);
            return { d: r.FSRQ, o: c, h: c, l: c, c, v: 0, pct: num(r.JZZZL) };
          })
          .filter((x) => Number.isFinite(x.c));
        // 把当日估算补进序列：评分要反映「今天」，而不是停在最近一次公布的净值。
        const lastBar = candles[candles.length - 1];
        if (lastBar && Number.isFinite(item.pct) && item.pctKind !== 'nav' && String(lastBar.d || '') !== today) {
          const lastClose = lastBar.c;
          const close = round(lastClose * (1 + item.pct / 100), 4);
          candles.push({
            d: today,
            o: lastClose,
            h: Math.max(lastClose, close),
            l: Math.min(lastClose, close),
            c: close,
            v: 0,
            pct: item.pct,
            est: true,
          });
        }
        if (candles.length >= 20) {
          item.advice = stockAdvice(
            { name: item.name || item.code, price: item.price, pct: item.pct },
            candles,
            { risk },
          );
          if (item.advice && item.advice.analysis) item.advice.analysis.includesToday = Boolean(candles[candles.length - 1].est);
        } else {
          item.advice = null;
        }
      } catch {
        item.advice = null;
      }
    });
    return {
      items,
      today,
      updatedAt: Date.now(),
    };
  });
}

async function getFundDetail(code, type) {
  const kind = type === 'open' || type === 'etf' ? type : (isEtfLike(code, '') ? 'etf' : 'open');
  return cached(`funddetail:${kind}:${code}`, 60000, async () => {
    if (kind === 'etf') {
      const secid = fundSecid(code);
      if (!secid) throw new Error('无法识别该 ETF 的市场');
      const [quote, kline, flow] = await Promise.all([
        fetchQuoteList([secid], 'fund').then((items) => items[0] || null),
        getKline(secid, 101, 150).catch(() => null),
        getFlow(secid).catch(() => null),
      ]);
      if (!quote && !kline) throw new Error('未获取到该 ETF 数据');
      return { type: 'etf', code, quote, kline, flow, updatedAt: Date.now() };
    }
    const rows = await fetchFundNav(code, 6);
    if (!rows.length) throw new Error('未获取到该基金净值');
    const infoRows = await fetchFundMNFInfo([code]).catch(() => []);
    const info = infoRows[0] || null;
    const latest = rows[0];
    return {
      type: 'open',
      code,
      latest: {
        date: latest.FSRQ,
        nav: num(latest.DWJZ),
        navAcc: num(latest.LJJZ),
        pct: num(latest.JZZZL),
        subscribe: latest.SGZT,
        redeem: latest.SHZT,
        estimate: info && num(info.GSZ) > 0 ? num(info.GSZ) : null,
        estimatePct: info && num(info.GSZ) > 0 ? num(info.GSZZL) : null,
        estimateTime: info && num(info.GSZ) > 0 ? info.GZTIME : '',
      },
      history: rows
        .slice()
        .reverse()
        .map((r) => ({ d: r.FSRQ, c: num(r.DWJZ), pct: num(r.JZZZL) }))
        .filter((x) => Number.isFinite(x.c)),
      updatedAt: Date.now(),
    };
  });
}

/* =========================================================
   基金多周期表现 / 风险指标 / 持仓结构（基金详情页增强）
   阶段涨幅与同类排名来自天天基金 FundMNPeriodIncrease，
   夏普、最大回撤、波动率来自基金档案里的近 1/2/3 年指标，
   ETF 没有这些字段时按日线收盘价自行计算。
   ========================================================= */
const FUND_PERIOD_LABELS = {
  Z: '近1周',
  Y: '近1月',
  '3Y': '近3月',
  '6Y': '近6月',
  '1N': '近1年',
  '2N': '近2年',
  '3N': '近3年',
  '5N': '近5年',
  JN: '今年以来',
  LN: '成立以来',
};

async function fetchFundPeriodIncrease(code) {
  const url =
    'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNPeriodIncrease' +
    `?FCODE=${encodeURIComponent(code)}&deviceid=globalpulse&plat=Android&product=EFund` +
    `&version=6.2.8&appType=ttjj&_=${Date.now()}`;
  const json = await fetchFundJSON(url);
  return Array.isArray(json?.Datas) ? json.Datas : [];
}

function periodReturnsFromCloses(closes) {
  const n = closes.length;
  const last = n ? closes[n - 1] : null;
  const pctOf = (back) => {
    const idx = n - 1 - back;
    if (!Number.isFinite(last) || idx < 0 || !Number.isFinite(closes[idx]) || closes[idx] <= 0) return null;
    return round(((last - closes[idx]) / closes[idx]) * 100, 2);
  };
  return { w1: pctOf(5), m1: pctOf(20), m3: pctOf(60), m6: pctOf(120), y1: pctOf(250) };
}

function riskFromCloses(closes) {
  const rets = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }
  if (rets.length < 20) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(250) * 100;
  let peak = -Infinity;
  let mdd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    if (peak > 0) mdd = Math.max(mdd, ((peak - c) / peak) * 100);
  }
  const annReturn = mean * 250 * 100;
  const sharpe = vol > 0 ? (annReturn - 2) / vol : null;
  return {
    vol: round(vol, 2),
    mdd: round(mdd, 2),
    sharpe: sharpe === null ? null : round(sharpe, 4),
    annReturn: round(annReturn, 2),
    samples: rets.length,
  };
}

function buildIndustryMix(holdings) {
  const map = new Map();
  for (const h of holdings) {
    const key = h.industry || '未分类';
    map.set(key, round((map.get(key) || 0) + (Number(h.pct) || 0), 2));
  }
  return [...map.entries()]
    .map(([name, pct]) => ({ name, pct }))
    .sort((a, b) => b.pct - a.pct);
}

async function getFundMetrics(code, type) {
  const kind = type === 'open' || type === 'etf' ? type : (isEtfLike(code, '') ? 'etf' : 'open');
  return cached(`fundmetrics:${kind}:${code}`, 120000, async () => {
    if (kind === 'etf') {
      const secid = fundSecid(code);
      if (!secid) throw new Error('无法识别该 ETF 的市场');
      const kline = await getKline(secid, 101, 260).catch(() => null);
      const candles = (kline && kline.candles) || [];
      const closes = candles.map((c) => Number(c.c)).filter((v) => Number.isFinite(v) && v > 0);
      if (closes.length < 25) throw new Error('未获取到足够的 ETF 历史数据');
      const rets = periodReturnsFromCloses(closes);
      return {
        code,
        type: 'etf',
        name: (kline && kline.name) || '',
        periods: [
          { key: 'w1', label: '近1周', pct: rets.w1 },
          { key: 'm1', label: '近1月', pct: rets.m1 },
          { key: 'm3', label: '近3月', pct: rets.m3 },
          { key: 'm6', label: '近6月', pct: rets.m6 },
          { key: 'y1', label: '近1年', pct: rets.y1 },
        ],
        risk: riskFromCloses(closes),
        profile: {
          type: 'ETF',
          sizeYi: null,
          estabDate: candles.length ? String(candles[0].d).slice(0, 10) : '',
        },
        holdings: [],
        industryMix: [],
        nav: candles.slice(-120).map((c) => ({ d: c.d, c: round(Number(c.c), 3) })),
        updatedAt: Date.now(),
        note: 'ETF 阶段涨幅与风险指标由日线收盘价计算。',
      };
    }
    const [periodRows, basic, holdings, navRows] = await Promise.all([
      fetchFundPeriodIncrease(code).catch(() => []),
      fetchFundBasic(code).catch(() => null),
      fetchFundPositions(code).catch(() => []),
      fetchFundNav(code, 6).catch(() => []),
    ]);
    const info = basic || {};
    const periods = periodRows
      .filter((r) => r && r.title)
      .map((r) => {
        const total = num(r.sc);
        const rank = num(r.rank);
        const avg = num(r.avg);
        const bench = num(r.hs300);
        return {
          key: r.title,
          label: FUND_PERIOD_LABELS[r.title] || r.title,
          pct: num(r.syl),
          avg: Number.isFinite(avg) && avg !== 0 ? avg : null,
          bench: Number.isFinite(bench) && bench !== 0 ? bench : null,
          rank: Number.isFinite(rank) && rank > 0 ? rank : null,
          total: Number.isFinite(total) && total > 0 ? total : null,
          percentile: Number.isFinite(rank) && rank > 0 && Number.isFinite(total) && total > 0
            ? round((rank / total) * 100, 1)
            : null,
        };
      });
    const pick = (v) => {
      const n = num(v);
      return Number.isFinite(n) ? n : null;
    };
    const holdingItems = (Array.isArray(holdings) ? holdings : []).slice(0, 12).map((h) => ({
      code: String(h.GPDM || ''),
      name: h.GPJC || '',
      pct: num(h.JZBL),
      industry: h.INDEXNAME || '',
      chgType: h.PCTNVCHGTYPE || '',
      chg: num(h.PCTNVCHG),
      secid: h.NEWTEXCH === '1' ? `1.${h.GPDM}` : h.NEWTEXCH === '0' ? `0.${h.GPDM}` : null,
    }));
    return {
      code,
      type: 'open',
      name: info.SHORTNAME || '',
      periods,
      risk: {
        sharpe: pick(info.SHARP1),
        sharpe2: pick(info.SHARP2),
        sharpe3: pick(info.SHARP3),
        mdd: pick(info.MAXRETRA1),
        vol: pick(info.STDDEV1),
        vol2: pick(info.STDDEV2),
        vol3: pick(info.STDDEV3),
      },
      profile: {
        name: info.SHORTNAME || '',
        type: info.FTYPE || '',
        company: info.JJGS || '',
        sizeYi: num(info.ENDNAV) === null ? null : round(num(info.ENDNAV) / 1e8, 2),
        estabDate: info.ESTABDATE || '',
        riskLevel: info.RISKLEVEL || '',
        rate: info.RATE || '',
        sourceRate: info.SOURCERATE || '',
        minBuy: info.MINSG || '',
        buyable: info.BUY === true,
        navDate: info.FSRQ || '',
      },
      holdings: holdingItems,
      industryMix: buildIndustryMix(holdingItems),
      nav: navRows
        .slice()
        .reverse()
        .map((r) => ({ d: r.FSRQ, c: num(r.DWJZ) }))
        .filter((x) => Number.isFinite(x.c)),
      updatedAt: Date.now(),
      note: '阶段涨幅与同类排名为天天基金口径；夏普、最大回撤、波动率为近 1 年指标；重仓股为最近一期季报披露。',
    };
  });
}

/* =========================================================
   股票型基金情报
   ========================================================= */
const STOCK_FUND_TYPES = {
  gp: '股票型',
  zs: '指数型',
  hh: '混合型',
  zq: '债券型',
};

const FUND_SORT_MAP = {
  day: 'rzdf',
  week: 'zzf',
  month: '1yzf',
  month3: '3yzf',
  month6: '6yzf',
  year: '1nzf',  year3: '3nzf',
};

async function fetchFundMNFInfo(codes) {
  const list = [...new Set(codes.filter(Boolean))].slice(0, 50);
  if (!list.length) return [];
  const body = new URLSearchParams({
    pageIndex: '1',
    pageSize: String(list.length),
    appType: 'ttjj',
    product: 'EFund',
    plat: 'Android',
    deviceid: 'globalpulse',
    Version: '1',
    Fcodes: list.join(','),
  });
  const res = await fetch('https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo', {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://fund.eastmoney.com/',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`基金估值接口 HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json?.Datas) ? json.Datas : [];
}

async function fetchFundBasic(code) {
  const url =
    'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNNBasicInformation' +
    `?version=6.2.4&plat=Android&appType=ttjj&FCODE=${encodeURIComponent(code)}` +
    '&onFundCache=3&product=EFund&deviceid=globalpulse';
  const json = await fetchFundJSON(url);
  return json?.Datas || null;
}

async function fetchFundPositions(code) {
  const url =
    'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition' +
    `?FCODE=${encodeURIComponent(code)}&deviceid=globalpulse&plat=Android&product=EFund&version=6.2.8&appType=ttjj`;
  const json = await fetchFundJSON(url);
  return Array.isArray(json?.Datas?.fundStocks) ? json.Datas.fundStocks : [];
}

/* =========================================================
   场外基金「当日」估值
   天天基金的盘中估值接口（fundgz / FundMNFInfo 的 GSZ/GSZZL）已经不再返回数据，
   于是过去一旦估值为空就退回「上一交易日净值涨跌」，看起来就像在用昨天的数据。
   这里改成自己算：用基金披露的重仓股（场内穿透）× 个股当日实时涨跌，
   再按最新股票仓位缩放；ETF 联接基金直接用目标 ETF 的场内涨跌。
   ========================================================= */
const FUND_ALLOC_TTL = 6 * 3600 * 1000;
const FUND_ALLOC_CACHE = new Map();

function isQdiiFund(name) {
  return /QDII|全球|海外|美元|纳指|纳斯达克|标普|道琼斯|日经|德国|法国|印度|越南|欧洲|新兴市场/i.test(String(name || ''));
}

async function fetchFundStockRatio(code) {
  const hit = FUND_ALLOC_CACHE.get(code);
  if (hit && Date.now() - hit.at < FUND_ALLOC_TTL) return hit.val;
  try {
    const url =
      'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNAssetAllocationNew' +
      `?FCODE=${encodeURIComponent(code)}&deviceid=globalpulse&plat=Android&product=EFund&version=6.2.8&appType=ttjj`;
    const json = await fetchFundJSON(url);
    const row = (json?.Datas || [])[0] || null;
    const val = row
      ? { stockRatio: num(row.GP), bondRatio: num(row.ZQ), cashRatio: num(row.HB), date: row.FSRQ || '' }
      : null;
    FUND_ALLOC_CACHE.set(code, { at: Date.now(), val });
    return val;
  } catch {
    return hit ? hit.val : null;
  }
}

async function fetchFundHoldingsProfile(code) {
  return cached(`fundholdprofile:${code}`, 6 * 3600 * 1000, async () => {
    const url =
      'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition' +
      `?FCODE=${encodeURIComponent(code)}&deviceid=globalpulse&plat=Android&product=EFund&version=6.2.8&appType=ttjj`;
    const json = await fetchFundJSON(url);
    const d = json?.Datas || {};
    const stocks = (Array.isArray(d.fundStocks) ? d.fundStocks : [])
      .slice(0, 10)
      .map((p) => ({
        code: String(p.GPDM || ''),
        name: p.GPJC || '',
        weight: num(p.JZBL),
        market: String(p.NEWTEXCH ?? p.TEXCH ?? '0'),
      }))
      .filter((p) => p.code && Number.isFinite(p.weight) && p.weight > 0);
    return {
      stocks,
      etfCode: d.ETFCODE ? String(d.ETFCODE) : '',
      etfName: d.ETFSHORTNAME || '',
    };
  });
}

// 批量估算：一次性把需要的美股/港股/A股重仓行情取回来，避免每只基金单独打接口。
async function estimateFundDayPctBatch(list) {
  const out = new Map();
  const funds = (list || []).filter((x) => x && x.code);
  if (!funds.length) return out;
  const profiles = await mapLimit(funds, 4, async (f) => {
    try {
      return { ...f, profile: await fetchFundHoldingsProfile(f.code) };
    } catch {
      return { ...f, profile: null };
    }
  });
  const wantSecids = [];
  for (const f of profiles) {
    const p = f.profile;
    if (!p) continue;
    if (!p.stocks.length && p.etfCode) {
      const secid = fundSecid(p.etfCode);
      if (secid) wantSecids.push(secid);
    }
    for (const s of p.stocks) {
      if (s.market === '0' || s.market === '1' || s.market === '105' || s.market === '106' || s.market === '107' || s.market === '116') {
        wantSecids.push(`${s.market}.${s.code}`);
      }
    }
  }
  let qmap = new Map();
  if (wantSecids.length) {
    try {
      const quotes = await fetchQuoteList(wantSecids, 'stock');
      qmap = new Map(quotes.map((q) => [q.code, q]));
    } catch { /* 行情取不到时下游按缺失处理 */ }
  }
  const allocMap = new Map(
    await mapLimit(
      profiles.filter((f) => f.profile && f.profile.stocks.length),
      4,
      async (f) => [f.code, await fetchFundStockRatio(f.code).catch(() => null)],
    ),
  );
  for (const f of profiles) {
    const p = f.profile;
    const base = { asOf: shanghaiToday(), kind: null, pct: null, covered: 0, weight: 0, stockRatio: null, note: '' };
    if (!p) { out.set(f.code, { ...base, note: '重仓数据不可用' }); continue; }
    if (isQdiiFund(f.name) || isQdiiFund(p.etfName)) {
      out.set(f.code, { ...base, note: 'QDII 净值滞后一交易日，不做盘中估算' });
      continue;
    }
    // ETF 联接基金：直接看目标 ETF 的场内涨跌
    if (!p.stocks.length && p.etfCode) {
      const q = qmap.get(p.etfCode);
      if (q && Number.isFinite(q.pct)) {
        out.set(f.code, {
          ...base,
          pct: q.pct,
          kind: 'etf',
          covered: 1,
          weight: 100,
          note: `按目标 ETF ${p.etfName || p.etfCode}（${p.etfCode}）场内涨跌穿透`,
        });
      } else {
        out.set(f.code, { ...base, note: `目标 ETF ${p.etfCode} 行情不可用` });
      }
      continue;
    }
    // 普通场外基金：重仓股权重 × 个股当日涨跌，再按股票仓位缩放
    let weight = 0;
    let contrib = 0;
    let covered = 0;
    for (const s of p.stocks) {
      const q = qmap.get(s.code);
      if (!q || !Number.isFinite(q.pct)) continue;
      weight += s.weight;
      contrib += (s.weight * q.pct) / 100;
      covered += 1;
    }
    if (covered < 4 || weight < 15) {
      out.set(f.code, { ...base, covered, weight, note: '重仓覆盖率不足，无法穿透估算' });
      continue;
    }
    let alloc = allocMap.get(f.code) || null;
    const stockRatio = alloc && Number.isFinite(alloc.stockRatio) && alloc.stockRatio > 20 ? alloc.stockRatio : null;
    const scale = stockRatio ? stockRatio / weight : 1;
    out.set(f.code, {
      ...base,
      pct: round(contrib * scale, 2),
      kind: 'holdings',
      covered,
      weight: round(weight, 2),
      stockRatio,
      note: `前 ${covered} 大重仓（合计 ${round(weight, 2)}%）${stockRatio ? `按股票仓位 ${stockRatio}% 缩放` : '未取到股票仓位，直接按权重加总'}${alloc && alloc.date ? `，仓位数据 ${alloc.date}` : ''}`,
    });
  }
  return out;
}

// 决定「今天」这一只基金用哪个涨跌口径。优先级：
// 天天基金盘中估值（若哪天恢复）> 当日官方净值 > 场内穿透估算 > 无（标为未更新）。
function resolveFundTodayPct({ navDate, navPct, gsz, gszzl, gzTime, est, today }) {
  // 注意 Number(null) === 0：缺数据时必须显式判空，否则会被当成「0% 涨跌」。
  const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const gzToday = fin(gsz) && Number(gsz) > 0 && fin(gszzl) && String(gzTime || '').startsWith(today);
  if (gzToday) {
    return { pct: Number(gszzl), kind: 'estimate', date: today, label: '盘中估值', note: gzTime || '' };
  }
  if (String(navDate || '') === today && fin(navPct)) {
    return { pct: Number(navPct), kind: 'nav', date: today, label: '今日净值', note: '' };
  }
  if (est && fin(est.pct)) {
    return {
      pct: Number(est.pct),
      kind: est.kind === 'etf' ? 'etf' : 'holdings',
      date: today,
      label: est.kind === 'etf' ? '穿透估算·ETF' : '穿透估算·重仓',
      note: est.note || '',
    };
  }
  return {
    pct: null,
    kind: 'stale',
    date: String(navDate || ''),
    label: '当日未更新',
    note: (est && est.note) || '',
  };
}

async function fetchFundManagerName(code) {
  try {
    const res = await fetch(`https://fundf10.eastmoney.com/jjjl_${encodeURIComponent(code)}.html`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fundf10.eastmoney.com/' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    const match = html.match(/基金经理([^的<]{1,40})的信息/);
    return match ? match[1].replace(/&nbsp;/g, ' ').trim() : '';
  } catch {
    return '';
  }
}

function parseRankRows(text) {
  const match = String(text).match(/datas:\s*(\[[\s\S]*?\])\s*,\s*allRecords\s*:\s*(\d+)/);
  if (!match) throw new Error('基金排行数据格式异常');
  return {
    datas: JSON.parse(match[1]),
    allRecords: Number(match[2]) || 0,
  };
}

async function getStockFundRank(ft = 'gp', sort = 'year', limit = 30, sector = '') {
  const type = STOCK_FUND_TYPES[ft] ? ft : 'gp';
  const sortKey = FUND_SORT_MAP[sort] ? sort : 'year';
  const sc = FUND_SORT_MAP[sortKey];
  const n = Math.min(50, Math.max(5, limit));
  return cached(`stockfundrank:${type}:${sortKey}:${n}:${sector || 'all'}`, 60000, async () => {
    if (sector && sector !== 'all') {
      const all = await getStockFundsAll(type);
      const list = all.items
        .filter((x) => x.sector === sector)
        .sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));
      return {
        type,
        typeLabel: STOCK_FUND_TYPES[type],
        sortKey,
        sector,
        count: list.length,
        date: list[0]?.date || all.items[0]?.date || shanghaiToday(),
        items: list.slice(0, n),
        updatedAt: Date.now(),
      };
    }
    const end = shanghaiToday();
    const startDate = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const url =
      'https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf' +
      `&ft=${type}&rs=&gs=0&sc=${sc}&st=desc&sd=${startDate}&ed=${end}` +
      `&qdii=&tabSubtype=,,,,,&pi=1&pn=${n}&dx=1`;
    const text = await (await fetch(url, {
      headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://fund.eastmoney.com/' },
      signal: AbortSignal.timeout(20000),
    })).text();
    const parsed = parseRankRows(text);
    const rows = Array.isArray(parsed?.datas) ? parsed.datas : [];
    const items = rows.map((line, index) => {
      const p = String(line).split(',');
      if (p.length < 12) return null;
      return {
        rank: index + 1,
        code: p[0],
        name: p[1],
        pinyin: p[2],
        date: p[3],
        nav: num(p[4]),
        accNav: num(p[5]),
        day: num(p[6]),
        week: num(p[7]),
        month: num(p[8]),
        month3: num(p[9]),
        month6: num(p[10]),
        year: num(p[11]),
        year2: num(p[12]),
        year3: num(p[13]),
        thisYear: num(p[14]),
        since: num(p[15]),
        establish: p[16] || '',
        fee: p[19] || '',
        type: STOCK_FUND_TYPES[type],
        typeKey: type,
      };
    }).filter(Boolean);
    return {
      type,
      typeLabel: STOCK_FUND_TYPES[type],
      sortKey,
      sector: 'all',
      count: parsed?.allRecords || items.length,
      date: items[0]?.date || end,
      items,
      updatedAt: Date.now(),
    };
  });
}

async function getStockFundDetail(code) {
  return cached(`stockfund:${code}`, 60000, async () => {
    const [info, basic, positions, history, managerName, holdingsHistory] = await Promise.all([
      fetchFundMNFInfo([code]).then((rows) => rows[0] || null),
      fetchFundBasic(code).catch(() => null),
      fetchFundPositions(code).catch(() => []),
      fetchFundNav(code, 6).catch(() => []),
      fetchFundManagerName(code),
      getFundHoldingsHistory(code).catch(() => []),
    ]);
    if (!info && !basic) {
      throw new Error('未获取到该基金情报');
    }

    const top = positions.slice(0, 10);
    const secids = top
      .map((p) => {
        const market = String(p.NEWTEXCH ?? p.TEXCH ?? '0');
        return market === '1' ? `1.${p.GPDM}` : `0.${p.GPDM}`;
      })
      .filter(Boolean);
    let quotes = [];
    try { quotes = await fetchQuoteList(secids, 'stock'); } catch { /* 忽略重仓股行情失败 */ }
    const qmap = new Map(quotes.map((q) => [q.code, q]));

    return {
      type: 'stock',
      code,
      info: info ? {
        name: info.SHORTNAME,
        date: info.PDATE,
        nav: num(info.NAV),
        accNav: num(info.ACCNAV),
        dayPct: num(info.NAVCHGRT),
        estimate: num(info.GSZ) > 0 ? num(info.GSZ) : null,
        estimatePct: num(info.GSZ) > 0 ? num(info.GSZZL) : null,
        estimateTime: info.GZTIME,
        marketPrice: num(info.NEWPRICE) > 0 ? num(info.NEWPRICE) : null,
        marketPct: num(info.CHANGERATIO),
      } : null,
      basic: basic ? {
        name: basic.SHORTNAME,
        fullName: basic.FULLNAME,
        ftype: basic.FTYPE,
        manager: managerName || basic.JJJL || '',
        company: basic.JJGS || '',
        size: num(basic.ENDNAV),
        sizeDate: basic.FEGMRQ || '',
        establish: basic.ESTABDATE || '',
        risk: basic.RISKLEVEL || '',
        benchmark: basic.BENCH || '',
        subscribe: basic.SGZT || '',
        redeem: basic.SHZT || '',
        fee: basic.RATE || '',
        minBuy: basic.MINSG || '',
        theme: basic.TTYPENAME || '',
        indexName: basic.INDEXNAME || '',
        sharpe1: num(basic.SHARP1),
        maxDrawdown: num(basic.MAXRETRA1),
      } : null,
      positions: top.map((p) => ({
        code: p.GPDM,
        name: p.GPJC,
        weight: num(p.JZBL),
        changeType: p.PCTNVCHGTYPE || '',
        change: num(p.PCTNVCHG),
        industry: p.INDEXNAME || '',
        pct: qmap.get(p.GPDM)?.pct ?? null,
        price: qmap.get(p.GPDM)?.price ?? null,
      })),
      history: history.slice().reverse().map((r) => ({
        d: r.FSRQ,
        c: num(r.DWJZ),
        pct: num(r.JZZZL),
      })).filter((x) => Number.isFinite(x.c)),
      holdingsHistory,
      updatedAt: Date.now(),
    };
  });
}

async function fetchFundPeriodPerformance(code) {
  const url =
    'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNPeriodIncrease' +
    `?FCODE=${encodeURIComponent(code)}&deviceid=globalpulse&plat=Android&product=EFund&version=6.2.8&appType=ttjj`;
  const json = await fetchFundJSON(url);
  const map = {
    Z: 'week',
    Y: 'month',
    '3Y': 'month3',
    '6Y': 'month6',
    '1N': 'year',
    '2N': 'year2',
    '3N': 'year3',
    JN: 'thisYear',
    LN: 'since',
  };
  const out = {};
  for (const row of json?.Datas || []) {
    const key = map[row.title];
    if (!key) continue;
    out[key] = {
      value: num(row.syl),
      avg: num(row.avg),
      hs300: num(row.hs300),
      rank: num(row.rank),
      total: num(row.sc),
      diff: num(row.diff),
    };
  }
  return out;
}

function parseHoldingsArchive(text) {
  const blocks = String(text || '').split(/<div class='boxitem w790'>/).slice(1);
  const quarters = [];
  for (const block of blocks) {
    const qm = block.match(/(\d{4})年(\d)季度/);
    if (!qm) continue;
    const dm = block.match(/截止至：<font[^>]*>([^<]+)/);
    const stocks = [];
    for (const tr of block.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const row = tr[1];
      const code = row.match(/<td><a[^>]*>(\d{6})<\/a><\/td>/);
      if (!code) continue;
      const name = row.match(/<td class='tol'><a[^>]*>([^<]+)<\/a><\/td>/);
      const weight = row.match(/class='tor'>([\d.]+)%<\/td>/);
      stocks.push({
        code: code[1],
        name: name ? name[1].replace(/\s+/g, '') : '',
        weight: weight ? num(weight[1]) : null,
      });
    }
    quarters.push({
      quarter: `${qm[1]}Q${qm[2]}`,
      reportDate: dm ? dm[1] : '',
      stocks,
    });
  }
  return quarters.sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)));
}

function attachHoldingChanges(quarters) {
  return quarters.map((q, i) => {
    const prev = quarters[i + 1];
    if (!prev) {
      return { ...q, changes: { new: [], exit: [], increase: [], decrease: [] } };
    }
    const currMap = new Map(q.stocks.map((s) => [s.code, s]));
    const prevMap = new Map(prev.stocks.map((s) => [s.code, s]));
    const added = q.stocks.filter((s) => !prevMap.has(s.code));
    const exited = prev.stocks.filter((s) => !currMap.has(s.code));
    const increased = [];
    const decreased = [];
    for (const s of q.stocks) {
      const old = prevMap.get(s.code);
      if (!old || !Number.isFinite(s.weight) || !Number.isFinite(old.weight)) continue;
      const delta = s.weight - old.weight;
      if (delta > 0.1) increased.push({ code: s.code, name: s.name, delta: round(delta, 2) });
      if (delta < -0.1) decreased.push({ code: s.code, name: s.name, delta: round(delta, 2) });
    }
    return {
      ...q,
      changes: {
        new: added.map((s) => ({ code: s.code, name: s.name, weight: s.weight })),
        exit: exited.map((s) => ({ code: s.code, name: s.name, weight: s.weight })),
        increase: increased,
        decrease: decreased,
      },
    };
  });
}

async function getFundHoldingsHistory(code) {
  return cached(`fundholdings:${code}`, 600000, async () => {
    const year = new Date().getFullYear();
    const years = [year, year - 1];
    const results = await mapLimit(years, 2, async (y) => {
      const url =
        'https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc' +
        `&code=${encodeURIComponent(code)}&topline=10&year=${y}&month=&rt=${Date.now()}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fundf10.eastmoney.com/' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      return parseHoldingsArchive(await res.text());
    });
    const seen = new Set();
    const quarters = results.flat()
      .filter((q) => {
        if (!q.reportDate || seen.has(q.quarter)) return false;
        seen.add(q.quarter);
        return true;
      })
      .sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)))
      .slice(0, 8);
    return attachHoldingChanges(quarters);
  });
}

function classifyFundSector(name) {
  const n = String(name || '');
  if (/医药|医疗|生物|创新药|疫苗|CXO/i.test(n)) return '医药医疗';
  if (/半导体|芯片|电子|集成电路|消费电子|面板/i.test(n)) return '半导体电子';
  if (/新能源|光伏|储能|锂电|电池|风电|碳中和/i.test(n)) return '新能源';
  if (/白酒|酒|消费|食品|饮料|家电|零售|旅游|养殖|农业|种业/i.test(n)) return '大消费';
  if (/军工|国防|航天|航空|船舶/i.test(n)) return '军工国防';
  if (/证券|银行|金融|保险|非银/i.test(n)) return '金融';
  if (/地产|基建|建筑|建材|水泥/i.test(n)) return '地产基建';
  if (/港股|海外|QDII|纳斯达克|标普|恒生|全球|纳指|日经|德国|法国|美国/i.test(n)) return '海外QDII';
  if (/互联网|传媒|游戏|人工智能|AI|科技|软件|计算机|通信/i.test(n)) return '科技互联网';
  if (/汽车|智能车|汽车零部件/i.test(n)) return '汽车';
  if (/有色|黄金|稀土|资源|煤炭|石油|化工/i.test(n)) return '资源周期';
  if (/红利|价值|低波|股息/i.test(n)) return '红利价值';
  if (/沪深300|中证500|中证1000|上证50|创业板|科创|宽基/i.test(n)) return '宽基指数';
  if (/量化|对冲/i.test(n)) return '量化';
  if (/混合|灵活|平衡|均衡/i.test(n)) return '混合均衡';
  return '其他主题';
}

async function getStockFundsAll(ft = 'gp') {
  const type = STOCK_FUND_TYPES[ft] ? ft : 'gp';
  return cached(`stockfundall:${type}`, 300000, async () => {
    const end = shanghaiToday();
    const startDate = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const url =
      'https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf' +
      `&ft=${type}&rs=&gs=0&sc=1nzf&st=desc&sd=${startDate}&ed=${end}` +
      '&qdii=&tabSubtype=,,,,,&pi=1&pn=10000&dx=1';
    const text = await (await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fund.eastmoney.com/' },
      signal: AbortSignal.timeout(25000),
    })).text();
    const parsed = parseRankRows(text);
    const items = (parsed?.datas || []).map((line) => {
      const p = String(line).split(',');
      if (p.length < 12) return null;
      return {
        code: p[0],
        name: p[1],
        nav: num(p[4]),
        date: p[3],
        day: num(p[6]),
        week: num(p[7]),
        month: num(p[8]),
        month3: num(p[9]),
        month6: num(p[10]),
        year: num(p[11]),
        year2: num(p[12]),
        year3: num(p[13]),
        thisYear: num(p[14]),
        since: num(p[15]),
        establish: p[16] || '',
        sector: classifyFundSector(p[1]),
        type: STOCK_FUND_TYPES[type],
        typeKey: type,
      };
    }).filter(Boolean);
    return { type, typeLabel: STOCK_FUND_TYPES[type], count: items.length, items, updatedAt: Date.now() };
  });
}

async function getStockFundSectors(ft = 'gp', sort = 'day') {
  const sortKey = ['day', 'week', 'month', 'month3', 'year'].includes(sort) ? sort : 'day';
  return cached(`stocksectors:${ft}:${sortKey}`, 120000, async () => {
    const data = await getStockFundsAll(ft);
    const groups = new Map();
    for (const item of data.items) {
      if (!groups.has(item.sector)) groups.set(item.sector, []);
      groups.get(item.sector).push(item);
    }
    const sectors = [...groups.entries()].map(([sector, list]) => {
      const n = list.length;
      const avg = (key) => list.reduce((s, x) => s + (Number(x[key]) || 0), 0) / n;
      const sorted = [...list].sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));
      return {
        sector,
        count: n,
        avgDay: round(avg('day'), 2),
        avgWeek: round(avg('week'), 2),
        avgMonth: round(avg('month'), 2),
        avgYear: round(avg('year'), 2),
        leader: sorted[0] ? {
          code: sorted[0].code,
          name: sorted[0].name,
          value: sorted[0][sortKey],
          nav: sorted[0].nav,
        } : null,
        items: sorted.slice(0, 5),
      };
    });
    const avgKey = { day: 'avgDay', week: 'avgWeek', month: 'avgMonth', year: 'avgYear' }[sortKey] || 'avgMonth';
    sectors.sort((a, b) => (Number(b[avgKey]) || 0) - (Number(a[avgKey]) || 0));
    return { type: ft, typeLabel: STOCK_FUND_TYPES[ft] || '股票型', sortKey, sectors, updatedAt: Date.now() };
  });
}

async function getFundCompare(codes) {
  const list = [...new Set(codes.filter(Boolean))].slice(0, 4);
  if (list.length < 2) throw new Error('至少选择 2 只基金进行对比');
  return cached(`fundcompare:${list.join(',')}`, 120000, async () => {
    const items = await mapLimit(list, 3, async (code) => {
      const [info, basic, period, positions, managerName] = await Promise.all([
        fetchFundMNFInfo([code]).then((rows) => rows[0] || null).catch(() => null),
        fetchFundBasic(code).catch(() => null),
        fetchFundPeriodPerformance(code).catch(() => ({})),
        fetchFundPositions(code).catch(() => []),
        fetchFundManagerName(code),
      ]);
      if (!info && !basic) return null;
      return {
        code,
        name: basic?.SHORTNAME || info?.SHORTNAME || code,
        type: basic?.FTYPE || '',
        manager: managerName || basic?.JJJL || '',
        company: basic?.JJGS || '',
        size: num(basic?.ENDNAV),
        risk: basic?.RISKLEVEL || '',
        fee: basic?.RATE || '',
        nav: num(info?.NAV),
        estimate: num(info?.GSZ) > 0 ? num(info.GSZ) : null,
        day: num(info?.NAVCHGRT),
        week: period.week?.value ?? null,
        month: period.month?.value ?? null,
        month3: period.month3?.value ?? null,
        month6: period.month6?.value ?? null,
        year: period.year?.value ?? null,
        year2: period.year2?.value ?? null,
        year3: period.year3?.value ?? null,
        maxDrawdown: num(basic?.MAXRETRA1),
        sharpe: num(basic?.SHARP1),
        holdings: positions.slice(0, 10).map((p) => ({ code: p.GPDM, name: p.GPJC, weight: num(p.JZBL) })),
      };
    });
    const valid = items.filter(Boolean);
    const baseCodes = new Set((valid[0]?.holdings || []).map((h) => h.code));
    valid.forEach((item) => {
      const overlap = item.holdings.filter((h) => baseCodes.has(h.code)).length;
      item.overlap = baseCodes.size ? Math.round((overlap / baseCodes.size) * 100) : null;
    });
    return { items: valid, count: valid.length, updatedAt: Date.now() };
  });
}

function fundBaseName(name) {
  return String(name || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/[A-Za-z]人民币$/, '')
    .replace(/人民币$/, '')
    .replace(/[A-Za-z]$/, '');
}

async function getHotFunds() {
  return cached('fundhot', 120000, async () => {
    const [equityData, etfFlow] = await Promise.all([
      getAllEquityFunds().catch(() => ({ items: [] })),
      getEtfFlow('inflow', 20).catch(() => ({ items: [] })),
    ]);
    const seen = new Set();
    const seenSector = new Set();
    const stocks = equityData.items
      .filter((x) => (Number(x.year) || 0) > 0 && (Number(x.month) || 0) > 0)
      .sort((a, b) => (Number(b.month) * 0.6 + Number(b.year) * 0.4) - (Number(a.month) * 0.6 + Number(a.year) * 0.4))
      .filter((x) => {
        const key = fundBaseName(x.name);
        if (seen.has(key)) return false;
        if (seenSector.has(x.sector)) return false;
        seen.add(key);
        seenSector.add(x.sector);
        return true;
      })
      .slice(0, 3)
      .map((x) => ({
        code: x.code,
        name: x.name,
        type: 'stock',
        nav: x.nav,
        day: x.day,
        month: x.month,
        year: x.year,
        reason: `近1月 ${pctText(x.month)}，近1年 ${pctText(x.year)}，短期与中期动量同时为正`,
      }));
    const etfs = (etfFlow.items || [])
      .filter((x) => x.mainYi > 0 && x.pct > 0 && x.category !== 'money' && x.category !== 'bond')
      .sort((a, b) => b.mainYi - a.mainYi)
      .slice(0, 3)
      .map((x) => ({
        code: x.code,
        name: x.name,
        type: 'etf',
        nav: x.price,
        day: x.pct,
        mainYi: x.mainYi,
        reason: `主力净流入 ${nf(x.mainYi, 1)} 亿，日涨 ${pctText(x.pct)}`,
      }));
    return {
      stocks,
      etfs,
      updatedAt: Date.now(),
      note: '按阶段涨幅与资金流规则筛选，仅作关注线索，不构成推荐。',
    };
  });
}

async function getFundWarnings() {
  return cached('fundwarnings', 120000, async () => {
    const [equityData, etfFlow] = await Promise.all([
      getAllEquityFunds().catch(() => ({ items: [] })),
      getEtfFlow('outflow', 20).catch(() => ({ items: [] })),
    ]);
    const seen = new Set();
    const stocks = equityData.items
      .filter((x) => (Number(x.month) || 0) < -8 || (Number(x.year) || 0) < -20)
      .sort((a, b) => (Number(a.month) || 0) - (Number(b.month) || 0))
      .filter((x) => {
        const key = fundBaseName(x.name);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3)
      .map((x) => ({
        code: x.code,
        name: x.name,
        type: 'stock',
        day: x.day,
        month: x.month,
        year: x.year,
        reason: `近1月 ${pctText(x.month)}，近1年 ${pctText(x.year)}，处于弱势区间，需警惕继续回撤`,
      }));
    const etfs = (etfFlow.items || [])
      .filter((x) => x.mainYi < 0 && x.pct < 0 && x.category !== 'money' && x.category !== 'bond')
      .sort((a, b) => a.mainYi - b.mainYi)
      .slice(0, 3)
      .map((x) => ({
        code: x.code,
        name: x.name,
        type: 'etf',
        day: x.pct,
        mainYi: x.mainYi,
        reason: `主力净流出 ${nf(Math.abs(x.mainYi), 1)} 亿，日跌 ${pctText(x.pct)}，短期资金持续撤离`,
      }));
    return {
      stocks,
      etfs,
      updatedAt: Date.now(),
      note: '基于公开数据与固定规则筛选，仅作风险提醒，不构成对基金的管理能力评价。',
    };
  });
}

async function getAllEquityFunds() {
  return cached('allequityfunds', 300000, async () => {
    const types = ['gp', 'zs', 'hh'];
    const batches = await mapLimit(types, 3, (type) => getStockFundsAll(type).catch(() => ({ items: [] })));
    const map = new Map();
    for (const batch of batches) {
      for (const item of batch.items || []) {
        if (!map.has(item.code)) map.set(item.code, item);
      }
    }
    return { count: map.size, items: [...map.values()], types: STOCK_FUND_TYPES };
  });
}

async function getFundSectorFlow() {
  return cached('fundsectorflow', 60000, async () => {
    const [etfFlow, equityData] = await Promise.all([
      getEtfFlow('inflow', 500),
      getAllEquityFunds().catch(() => ({ items: [] })),
    ]);
    const map = new Map();
    const ensure = (sector) => {
      if (!map.has(sector)) {
        map.set(sector, {
          sector,
          etfCount: 0,
          etfNet: 0,
          etfPctSum: 0,
          etfAmount: 0,
          stockCount: 0,
          stockDaySum: 0,
          stockMonthSum: 0,
          stockYearSum: 0,
          etfs: [],
          stocks: [],
        });
      }
      return map.get(sector);
    };

    for (const etf of etfFlow.items || []) {
      if (etf.category === 'money' || etf.category === 'bond') continue;
      const item = ensure(classifyFundSector(etf.name));
      item.etfCount += 1;
      item.etfNet += Number(etf.mainYi) || 0;
      item.etfPctSum += Number(etf.pct) || 0;
      item.etfAmount += Number(etf.amountYi) || 0;
      item.etfs.push(etf);
    }
    for (const fund of equityData.items || []) {
      const item = ensure(classifyFundSector(fund.name));
      item.stockCount += 1;
      item.stockDaySum += Number(fund.day) || 0;
      item.stockMonthSum += Number(fund.month) || 0;
      item.stockYearSum += Number(fund.year) || 0;
      item.stocks.push(fund);
    }

    const sectors = [...map.values()].map((s) => {
      const etfs = [...s.etfs].sort((a, b) => b.mainYi - a.mainYi);
      const stocks = [...s.stocks].sort((a, b) => (Number(b.month) || 0) - (Number(a.month) || 0));
      return {
        sector: s.sector,
        etfCount: s.etfCount,
        stockCount: s.stockCount,
        fundCount: s.etfCount + s.stockCount,
        etfNet: s.etfCount ? round(s.etfNet, 1) : null,
        etfAvgPct: s.etfCount ? round(s.etfPctSum / s.etfCount, 2) : null,
        etfAmount: s.etfCount ? round(s.etfAmount, 1) : null,
        stockAvgDay: s.stockCount ? round(s.stockDaySum / s.stockCount, 2) : null,
        stockAvgMonth: s.stockCount ? round(s.stockMonthSum / s.stockCount, 2) : null,
        stockAvgYear: s.stockCount ? round(s.stockYearSum / s.stockCount, 2) : null,
        leaderEtf: etfs[0] ? {
          code: etfs[0].code, name: etfs[0].name, pct: etfs[0].pct, mainYi: etfs[0].mainYi,
        } : null,
        leaderStock: stocks[0] ? {
          code: stocks[0].code, name: stocks[0].name, day: stocks[0].day, month: stocks[0].month,
        } : null,
        etfs: etfs.slice(0, 10).map((x) => ({
          code: x.code, name: x.name, price: x.price, pct: x.pct, mainYi: x.mainYi, amountYi: x.amountYi,
        })),
        stocks: stocks.slice(0, 6).map((x) => ({
          code: x.code, name: x.name, nav: x.nav, day: x.day, month: x.month, year: x.year,
        })),
      };
    }).sort((a, b) => b.etfNet - a.etfNet);

    return {
      sectors,
      netInflow: round(sectors.reduce((sum, s) => sum + (Number(s.etfNet) || 0), 0), 1),
      inflowCount: sectors.filter((s) => s.etfNet > 0).length,
      outflowCount: sectors.filter((s) => s.etfNet < 0).length,
      etfCount: etfFlow.items.filter((x) => x.category !== 'money' && x.category !== 'bond').length,
      stockCount: equityData.items?.length || 0,
      date: etfFlow.date,
      updatedAt: Date.now(),
    };
  });
}

/* =========================================================
   场外基金资金流（基金季报申购 / 赎回）
   ========================================================= */
function openFundCategory(name = '') {
  const s = String(name);
  if (/货币|现金|添益|快线|日利|理财|保证金|活期|日鑫|安鑫|天天宝|现金宝/.test(s)) return 'money';
  if (/黄金|白银|有色|原油|豆粕|贵金属|能源化工|商品期货|商品ETF/.test(s)) return 'commodity';
  if (/债券|纯债|信用债|利率债|短债|中短债|转债|债/.test(s)) return 'bond';
  if (/混合|灵活|平衡|配置/.test(s) && !/指数|ETF联接|联接/.test(s)) return 'mixed';
  if (/指数|ETF联接|联接|沪深300|中证|上证50|创业板|科创|北证|MSCI|A500|A50|纳指|标普|恒生|日经|德国|法国|美国/.test(s)) return 'index';
  if (/回报|优选|成长|价值|精选|全球|海外|QDII|中概/.test(s)) return 'mixed';
  if (/股票/.test(s)) return 'equity';
  return 'mixed';
}

const OPEN_FUND_CATEGORIES = new Set(['all', 'equity', 'mixed', 'index', 'bond', 'money', 'commodity']);

function parseGmbdRows(text) {
  const source = String(text || '');
  const dataMatch = source.match(/data:\s*(\[[\s\S]*?\])\s*,\s*record:/);
  if (!dataMatch) return { data: [], record: 0 };
  try {
    const data = JSON.parse(dataMatch[1]);
    const record = Number((source.match(/record:"(\d+)"/) || [])[1]) || data.length;
    return { data: Array.isArray(data) ? data : [], record };
  } catch {
    return { data: [], record: 0 };
  }
}

async function fetchGmbdPage(period, page, sort = 'qmzfe') {
  const url =
    'https://fund.eastmoney.com/data/FundDataPortfolio_Interface.aspx' +
    `?dt=8&t=${encodeURIComponent(period)}&pn=2000&pi=${page}&mc=hypzDetail&st=desc&sc=${sort}`;
  return parseGmbdRows(await fetchFundText(url));
}

async function getGmbdLatestPeriod() {
  try {
    const text = await fetchFundText(
      'https://fund.eastmoney.com/data/FundDataPortfolio_Interface.aspx?dt=13&collname=Gmbd&mc=quarterlist',
    );
    const m = String(text).match(/data:\s*(\[[^\]]*\])/);
    if (m) {
      const list = JSON.parse(m[1]);
      if (Array.isArray(list) && list.length) return String(list[0]);
    }
  } catch { /* 回退到按当前季度推算 */ }
  const now = new Date();
  const year = now.getFullYear();
  const quarter = Math.max(1, Math.ceil((now.getMonth() + 1) / 3) - 1) || 1;
  return `${year}_${quarter}`;
}

function gmbdPeriodLabel(period) {
  const [year, quarter] = String(period || '').split('_');
  return year && quarter ? `${year}Q${quarter}` : String(period || '--');
}

function isExchangeTradedFund(code, name = '') {
  const s = String(name || '');
  if (/LOF/i.test(s)) return true;
  // ETF 联接基金是场外基金，名称里同样带 ETF，需要保留。
  if (/ETF/i.test(s) && !/ETF\s*联接|联接基金|联接/i.test(s)) return true;
  return /^(51|56|58|15|16|18)/.test(String(code));
}

async function loadOpenFundFlowRaw() {
  return cached('openfundflow:raw', 6 * 60 * 60 * 1000, async () => {
    const period = await getGmbdLatestPeriod();
    const first = await fetchGmbdPage(period, 1);
    if (!first.data.length) throw new Error('基金季度规模数据暂不可用');
    const pageCount = Math.max(1, Math.ceil(first.record / 2000));
    const rest = pageCount > 1
      ? await mapLimit(Array.from({ length: pageCount - 1 }, (_, i) => i + 2), 4, (page) => fetchGmbdPage(period, page))
      : [];
    const rows = [...first.data, ...rest.flatMap((p) => p.data)];
    const toNum = (v) => {
      const s = String(v == null ? '' : v).replace(/,/g, '').trim();
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    const map = new Map();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const [code, name, subRaw, redRaw, shareRaw, sizeRaw] = row;
      if (!code || !name) continue;
      // 场外口径：剔除 ETF / LOF 等场内基金，保留 ETF 联接基金。
      if (isExchangeTradedFund(code, name)) continue;
      const sub = toNum(subRaw);
      const red = toNum(redRaw);
      const share = toNum(shareRaw);
      const size = toNum(sizeRaw);
      if (![sub, red, share, size].every((v) => v !== null)) continue;
      if (share <= 0 || size <= 0) continue;
      const nav = size / share;
      if (!Number.isFinite(nav) || nav <= 0 || nav > 50) continue;
      const netShare = sub - red;
      map.set(String(code), {
        code: String(code),
        name: String(name),
        category: openFundCategory(name),
        subYi: round(sub, 2),
        redYi: round(red, 2),
        netShareYi: round(netShare, 2),
        nav: round(nav, 3),
        netYi: round(netShare * nav, 2),
        sizeYi: round(size, 2),
      });
    }
    return {
      period,
      periodLabel: gmbdPeriodLabel(period),
      items: [...map.values()],
      updatedAt: Date.now(),
    };
  });
}

async function getOpenFundFlow(category = 'all', limit = 50) {
  const cat = OPEN_FUND_CATEGORIES.has(category) ? category : 'all';
  const n = Math.min(100, Math.max(10, Number(limit) || 50));
  const raw = await loadOpenFundFlowRaw();
  const items = cat === 'all' ? raw.items : raw.items.filter((x) => x.category === cat);
  const inflow = items.filter((x) => x.netYi > 0).sort((a, b) => b.netYi - a.netYi);
  const outflow = items.filter((x) => x.netYi < 0).sort((a, b) => a.netYi - b.netYi);
  const sum = (rows) => round(rows.reduce((s, x) => s + x.netYi, 0), 1);
  return {
    period: raw.period,
    periodLabel: raw.periodLabel,
    category: cat,
    sample: items.length,
    inflowCount: inflow.length,
    outflowCount: outflow.length,
    inflowTotal: sum(inflow),
    outflowTotal: sum(outflow),
    inflow: inflow.slice(0, n),
    outflow: outflow.slice(0, n),
    updatedAt: Date.now(),
  };
}

/* =========================================================
   场外基金每日代理榜（目标 ETF 实时主力流 × 规模占比）
   ========================================================= */
const FUND_PROVIDERS = [
  '华泰柏瑞', '易方达', '华夏', '嘉实', '南方', '广发', '天弘', '富国', '汇添富', '招商',
  '工银瑞信', '工银', '国泰', '鹏华', '银华', '建信', '中欧', '兴全', '兴证全球', '博时',
  '前海开源', '景顺长城', '交银施罗德', '交银', '大成', '万家', '国联安', '华安', '海富通',
  '平安', '兴业', '中银', '永赢', '国投瑞银', '泰康', '新华', '方正富邦', '中信保诚', '中信建投',
  '中金', '申万菱信', '东方', '光大保德信', '长城', '长盛', '诺安', '宝盈', '摩根', '中邮',
  '华商', '金鹰', '汇安', '创金合信', '西部利得', '圆信永丰', '中庚', '睿远', '泉果', '路博迈',
  '贝莱德', '施罗德', '联博', '摩根士丹利', '宏利', '安联', '惠理', '惠升', '国新国证',
  '华润元大', '兴华', '明亚', '易米', '百嘉', '东财', '西藏东财', '国寿安保', '泰达宏利',
  '中加', '中融', '国联', '国金', '国海', '华宝', '华富', '华泰', '汇丰晋信', '浙商',
  '德邦', '财通', '东海', '东吴', '国都', '恒越', '弘毅远方', '华宸未来', '汇泉', '江信',
  '九泰', '凯石', '民生加银', '南华', '前海联合', '人保资产', '瑞达', '上银', '尚正', '太平',
  '天治', '同泰', '先锋', '湘财', '新沃', '信达澳亚', '兴银', '益民', '英大', '友邦',
  '长安', '中航', '中科沃土', '朱雀', '博道', '博远', '淳厚', '达诚', '东方红', '东兴',
  '蜂巢', '富荣', '格林', '华泰保兴', '金信', '诺德', '中海', '中银证券', '国联证券',
  '长江资管', '国君资管', '海通资管', '浙商资管', '光证资管', '中泰资管', '银河金汇',
  '渤海汇金', '广发资管', '齐鲁资管', '国信证券', '平安证券', '申万宏源', '中信证券',
  '中金公司', '华融', '信达', '东方资产', '长城资产',
];

const FUND_THEME_ALIASES = {
  证券: ['券商'],
  券商: ['证券'],
  酒: ['白酒'],
  白酒: ['酒'],
  半导体: ['芯片'],
  芯片: ['半导体'],
  医疗: ['医药'],
  医药: ['医疗'],
  国防: ['军工'],
  军工: ['国防'],
  纳斯达克: ['纳指'],
  纳指: ['纳斯达克'],
  标普500: ['标普'],
  标普: ['标普500'],
  恒生: ['港股'],
  港股: ['恒生'],
  新能源: ['新能源车', '新能车'],
  新能源车: ['新能源'],
  人工智能: ['AI'],
  AI: ['人工智能'],
};

function normalizeFundTheme(name) {
  let s = String(name || '');
  for (const p of FUND_PROVIDERS) s = s.split(p).join('');
  s = s
    .replace(/ETF联接|ETF\s*联接|联接基金|联接|ETF/gi, '')
    .replace(/交易型开放式指数证券投资基金|证券投资基金|基金/g, '')
    .replace(/指数增强|指数|增强|发起式|LOF|QDII/gi, '')
    .replace(/人民币|美元|现汇|现钞|持有期|定期开放|定开|个月|年/g, '')
    .replace(/[（）()\s·\-—_,，]/g, '');
  s = s.replace(/[ABCEI]$/, '');
  return s;
}

function fundThemeVariants(token) {
  const out = new Set([token]);
  for (const [key, vals] of Object.entries(FUND_THEME_ALIASES)) {
    if (!token.includes(key)) continue;
    for (const v of vals) out.add(token.split(key).join(v));
  }
  return [...out].filter((v) => v.length >= 2);
}

async function fetchTencentEtfSizes(codes) {
  const list = [...new Set((codes || []).filter(Boolean))];
  const symbols = list
    .map((code) => (/^5/.test(code) ? `sh${code}` : /^(15|16|18)/.test(code) ? `sz${code}` : null))
    .filter(Boolean);
  if (!symbols.length) return new Map();
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 50) chunks.push(symbols.slice(i, i + 50));
  const responses = await mapLimit(chunks, 2, async (chunk) => {
    const res = await fetch(`https://qt.gtimg.cn/q=${chunk.join(',')}`, {
      headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`腾讯行情 HTTP ${res.status}`);
    return new TextDecoder('gbk').decode(Buffer.from(await res.arrayBuffer()));
  });
  const map = new Map();
  for (const text of responses) {
    for (const line of String(text).split(';')) {
      const m = line.match(/v_(?:sh|sz)(\d{6})="([^"]*)"/);
      if (!m) continue;
      const fields = m[2].split('~');
      const total = num(fields[45]);
      const float = num(fields[44]);
      const sizeYi = total && total > 0 ? total : (float && float > 0 ? float : null);
      const price = num(fields[3]);
      if (sizeYi === null || sizeYi <= 0) continue;
      map.set(m[1], { sizeYi, price, name: fields[1] || '' });
    }
  }
  return map;
}

let etfFlowBlockedUntil = 0;
let push2hisChain = Promise.resolve();
let lastPush2hisAt = 0;

// push2his 对并发和频率很敏感：串行 + 至少 1.2 秒间隔，避免再次触发 IP 级限流。
function schedulePush2his(task) {
  const run = push2hisChain.then(async () => {
    const wait = Math.max(0, 1200 - (Date.now() - lastPush2hisAt));
    if (wait) await sleep(wait);
    lastPush2hisAt = Date.now();
    return task();
  });
  push2hisChain = run.catch(() => {});
  return run;
}

async function fetchEtfDailyFlow(code) {
  if (Date.now() < etfFlowBlockedUntil) throw new Error('ETF 每日资金流暂不可用');
  return cached(`etfdayflow:${code}`, 30 * 60 * 1000, async () => {
    const secid = fundSecid(code);
    if (!secid) return null;
    const url =
      'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get' +
      `?lmt=2&klt=101&secid=${secid}&fields1=f1,f2,f3,f7` +
      '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
    return schedulePush2his(async () => {
      try {
        const res = await fetch(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`ETF 资金流 HTTP ${res.status}`);
        const json = await res.json();
        const lines = json?.data?.klines || [];
        const last = lines[lines.length - 1];
        if (!last) return null;
        const p = String(last).split(',');
        const main = num(p[1]);
        if (main === null) return null;
        return {
          date: p[0],
          mainYi: round(main / 1e8, 2),
          mainPct: num(p[6]),
        };
      } catch (err) {
        // 上游被限流时不要连续重试，30 分钟内直接快速失败。
        etfFlowBlockedUntil = Date.now() + 30 * 60 * 1000;
        throw err;
      }
    });
  });
}

async function getDailyProxyBoard(limit = 50) {
  return cached('funddailproxy:v2', 5 * 60 * 1000, async () => {
    let etfUniverse;
    let openRaw;
    try {
      etfUniverse = await getEtfUniverse();
    } catch {
      return {
        unavailable: true,
        note: 'ETF 列表暂不可用，稍后重试',
        updatedAt: Date.now(),
        matched: 0,
        etfCount: 0,
        inflow: [],
        outflow: [],
        total: 0,
      };
    }
    try {
      openRaw = await loadOpenFundFlowRaw();
    } catch {
      return {
        unavailable: true,
        note: '场外基金季报规模暂不可用，稍后重试',
        updatedAt: Date.now(),
        matched: 0,
        etfCount: 0,
        inflow: [],
        outflow: [],
        total: 0,
      };
    }
    const etfs = (etfUniverse || [])
      .filter((x) => x.name && x.price !== null && x.category !== 'money' && x.category !== 'bond')
      .map((x) => ({ ...x, theme: normalizeFundTheme(x.name) }))
      .filter((x) => x.theme);
    const openFunds = (openRaw.items || [])
      .filter((x) => x.sizeYi > 0)
      .filter((x) => x.category === 'index' || /指数|ETF联接|联接/.test(x.name));

    const matched = [];
    for (const fund of openFunds) {
      const theme = normalizeFundTheme(fund.name);
      if (!theme) continue;
      let best = null;
      for (const etf of etfs) {
        for (const variant of fundThemeVariants(etf.theme)) {
          if (variant.length < 2) continue;
          const idx = theme.indexOf(variant);
          if (idx < 0) continue;
          const after = theme[idx + variant.length] || '';
          if (/\d$/.test(variant) && /\d/.test(after)) continue;
          const len = variant.length;
          if (!best || len > best.len || (len === best.len && (etf.amountYi || 0) > (best.etf.amountYi || 0))) {
            best = { etf, len };
          }
          break;
        }
      }
      if (best) matched.push({ fund, etf: best.etf });
    }
    if (!matched.length) {
      return {
        updatedAt: Date.now(),
        matched: 0,
        etfCount: 0,
        inflow: [],
        outflow: [],
        total: 0,
        note: '没有匹配到可用的目标 ETF',
      };
    }
    // 代理值按场外基金规模分摊，规模最大的基金决定榜单；限制候选数量，避免对上游发起过多请求。
    matched.sort((a, b) => b.fund.sizeYi - a.fund.sizeYi);
    const candidates = matched.slice(0, 200);
    const targetCodes = [...new Set(candidates.map((m) => m.etf.code))].slice(0, 20);
    const probe = await fetchEtfDailyFlow(targetCodes[0]).catch(() => null);
    if (!probe) {
      return {
        unavailable: true,
        note: '目标 ETF 规模或每日资金流暂不可用，稍后重试',
        updatedAt: Date.now(),
        matched: 0,
        etfCount: 0,
        inflow: [],
        outflow: [],
        total: 0,
      };
    }
    const [etfSizes, dailyFlows] = await Promise.all([
      fetchTencentEtfSizes(targetCodes).catch(() => new Map()),
      mapLimit(targetCodes, 2, (code) => fetchEtfDailyFlow(code).catch(() => null)),
    ]);
    const flowMap = new Map(targetCodes.map((code, i) => [code, dailyFlows[i]]));
    const rows = [];
    for (const { fund, etf } of candidates) {
      if (!flowMap.has(etf.code)) continue;
      const etfSize = etfSizes.get(etf.code);
      const flow = flowMap.get(etf.code);
      if (!etfSize || etfSize.sizeYi <= 0 || !flow || !Number.isFinite(flow.mainYi)) continue;
      const ratio = Math.max(0, Math.min(1, fund.sizeYi / etfSize.sizeYi));
      const proxyYi = flow.mainYi * ratio;
      if (!Number.isFinite(proxyYi) || Math.abs(proxyYi) < 0.001) continue;
      rows.push({
        code: fund.code,
        name: fund.name,
        category: fund.category,
        sizeYi: fund.sizeYi,
        targetCode: etf.code,
        targetName: etf.name,
        targetMainYi: flow.mainYi,
        targetPct: flow.mainPct,
        targetDate: flow.date,
        targetSizeYi: etfSize.sizeYi,
        ratio: round(ratio * 100, 2),
        proxyYi: round(proxyYi, 2),
      });
    }
    if (!rows.length) {
      return {
        unavailable: true,
        note: '目标 ETF 规模或每日资金流暂不可用，稍后重试',
        updatedAt: Date.now(),
        matched: 0,
        etfCount: 0,
        inflow: [],
        outflow: [],
        total: 0,
      };
    }
    const inflow = rows.filter((x) => x.proxyYi > 0).sort((a, b) => b.proxyYi - a.proxyYi);
    const outflow = rows.filter((x) => x.proxyYi < 0).sort((a, b) => a.proxyYi - b.proxyYi);
    const dates = rows.map((x) => x.targetDate).filter(Boolean).sort();
    return {
      updatedAt: Date.now(),
      matched: rows.length,
      etfCount: new Set(rows.map((x) => x.targetCode)).size,
      flowDate: dates[dates.length - 1] || null,
      inflow: inflow.slice(0, limit),
      outflow: outflow.slice(0, limit),
      inflowTotal: round(inflow.reduce((s, x) => s + x.proxyYi, 0), 1),
      outflowTotal: round(outflow.reduce((s, x) => s + x.proxyYi, 0), 1),
      total: rows.length,
    };
  });
}

async function getNews(limit = 40) {
  return cached(`news:${limit}`, 90000, async () => {
    const { data } = await runSource('news', [limit]);
    const sentiment = aggregateNews(data.items);
    return {
      items: sentiment.items,
      sentiment: {
        score: sentiment.score,
        label: sentiment.label,
        positive: sentiment.positive,
        negative: sentiment.negative,
      },
      source: data.source,
      updatedAt: Date.now(),
    };
  });
}

async function getSearch(query) {
  const q = String(query || '').trim();
  if (!q) return { items: [] };
  const url =
    'https://searchapi.eastmoney.com/api/suggest/get?input=' +
    encodeURIComponent(q) +
    '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10';
  const json = await fetchJSON(url, 7000);
  const items = (json?.QuotationCodeTable?.Data || [])
    .filter((d) => d.QuoteID)
    .map((d) => ({
      code: d.Code,
      name: d.Name,
      secid: d.QuoteID,
      market: d.MktNum,
      type: d.SecurityTypeName,
      pinyin: d.PinYin,
      classify: d.Classify,
    }))
    .sort((a, b) => (a.classify === 'AStock' ? -1 : 0) - (b.classify === 'AStock' ? -1 : 0));
  return { items };
}

async function getStock(secid, risk = 'balanced') {
  return cached(`stock:${secid}:${risk}`, 30000, async () => {
    const [quotes, kline] = await Promise.all([
      fetchQuoteList([secid], 'stock'),
      getKline(secid, 101, 160),
    ]);
    const quote = quotes[0];
    if (!quote) throw new Error('未找到该标的');
    if (quote.main === null || quote.main === undefined) {
      // 腾讯 / 新浪快照不含主力净流入，个股详情页单独补一次新浪当日资金结构。
      try {
        const flow = await sinaStockFlow(secid);
        if (flow && flow.snapshot) {
          quote.main = Math.round(flow.snapshot.main * 1e8);
          quote.mainYi = flow.snapshot.main;
          quote.mainPct = null;
          quote.flowSnapshot = flow.snapshot;
          quote.flowSource = 'sina';
        }
      } catch { /* 忽略，详情页仍展示价格数据 */ }
    }
    kline.name = quote.name || kline.name;
    kline.code = quote.code || kline.code;
    const advice = stockAdvice(quote, kline.candles, { risk });
    return { quote, kline, advice, updatedAt: Date.now() };
  });
}

async function getWatchlist(secids, risk = 'balanced') {
  const unique = [...new Set(secids.filter(Boolean))].slice(0, 12);
  if (!unique.length) return { items: [], updatedAt: Date.now() };
  const quotes = await fetchQuoteList(unique, 'stock');
  const settled = await mapLimit(quotes, 4, async (quote) => {
    try {
      const kline = await getKline(quote.secid, 101, 120);
      return { quote, advice: stockAdvice(quote, kline.candles, { risk }) };
    } catch {
      return { quote, advice: null };
    }
  });
  return { items: settled, updatedAt: Date.now() };
}

async function getAdvice(risk = 'balanced') {
  return cached(`advice:${risk}`, 120000, async () => {
    const fallbackSectors = { type: 'industry', total: 0, items: [], inflowCount: 0, outflowCount: 0, netInflow: 0 };
    const fallbackNews = { items: [], sentiment: { score: 0, label: '中性', positive: 0, negative: 0 } };
    const [overview, sse, szse, cyb, hs300, sectors, news] = await Promise.all([
      getOverview(),
      getKline('1.000001', 101, 180).catch(() => null),
      getKline('0.399001', 101, 180).catch(() => null),
      getKline('0.399006', 101, 180).catch(() => null),
      getKline('1.000300', 101, 180).catch(() => null),
      getSectors('industry').catch(() => fallbackSectors),
      getNews(40).catch(() => fallbackNews),
    ]);
    return marketAdvice({
      overview: { ...overview, risk },
      klines: { sse, szse, cyb, hs300 },
      sectors,
      news,
    });
  });
}

/* =========================================================
   智能策略 · 作战中心
   涨停池 / 板块确认 / 资金异动 / 连板梯队 / 十日异动 / 时间轴
   ========================================================= */
const PUSH2EX_BASE = 'https://push2ex.eastmoney.com';
const POOL_UT = '7eea3edcaed734bea9cbfc24409ed989';
const BATTLE_STOCK_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
const BATTLE_MOVE_FIELDS = 'f2,f3,f4,f5,f6,f8,f10,f11,f12,f13,f14,f15,f16,f17,f18,f22,f62,f100,f184';

// 东方财富 clist 在部分网络环境会被上游直接拒绝；失败后短时冷却，
// 后续请求直接用新浪 / 腾讯回退，避免每次刷新都重试 4 次、拖慢整页。
let clistCoolingUntil = 0;
async function clistJSON(url, timeout = 12000) {
  if (Date.now() < clistCoolingUntil) throw new Error('东方财富 clist 冷却中');
  try {
    return await fetchJSON(url, timeout);
  } catch (err) {
    clistCoolingUntil = Date.now() + 3 * 60 * 1000;
    throw err;
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function shanghaiDateKey(offsetDays = 0) {
  const p = zonedParts('Asia/Shanghai');
  const d = new Date(`${p.date}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function shiftDateKey(key, days) {
  const d = new Date(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function dateKeyText(key) {
  const s = String(key || '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

function clockText(value) {
  const s = String(value || '0').padStart(6, '0');
  if (!/^\d{6}$/.test(s) || s === '000000') return '--';
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

function clockMinutes(value) {
  const s = String(value || '0').padStart(6, '0');
  if (!/^\d{6}$/.test(s)) return null;
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
}

function limitRatioOf(code, name) {
  const c = String(code || '');
  const n = String(name || '');
  if (/^(N|C)/.test(n)) return null;
  if (/ST/i.test(n)) return /^(30|68)/.test(c) ? 0.2 : 0.05;
  if (/^(30|68)/.test(c)) return 0.2;
  if (/^[489]/.test(c)) return 0.3;
  return 0.1;
}

async function fetchPoolRaw(kind, dateKey) {
  const sort = kind === 'DT' ? 'fund:asc' : 'fbt:asc';
  const url =
    `${PUSH2EX_BASE}/getTopic${kind}Pool?ut=${POOL_UT}&dpt=wz.ztzt` +
    `&Pageindex=0&pagesize=500&sort=${sort}&date=${dateKey}`;
  const json = await fetchJSON(url, 12000);
  const data = json && json.data;
  return {
    date: data && data.qdate ? String(data.qdate) : dateKey,
    total: data && Number(data.tc) ? Number(data.tc) : 0,
    pool: data && Array.isArray(data.pool) ? data.pool : [],
  };
}

function normalizePoolItem(r, kind) {
  const price = num(r.p);
  const fbt = num(r.fbt);
  const lbt = num(r.lbt);
  return {
    code: String(r.c || ''),
    market: Number(r.m),
    secid: `${r.m}.${r.c}`,
    name: r.n || '',
    price: price === null ? null : round(price / 1000, 2),
    pct: round(num(r.zdp), 2),
    amountYi: num(r.amount) === null ? null : round(num(r.amount) / 1e8, 2),
    floatCapYi: num(r.ltsz) === null ? null : round(num(r.ltsz) / 1e8, 1),
    turnover: round(num(r.hs), 2),
    boards: Number(r.lbc) || 1,
    firstSeal: clockText(fbt),
    firstMin: clockMinutes(fbt),
    lastSeal: clockText(lbt),
    lastMin: clockMinutes(lbt),
    sealFundYi: num(r.fund) === null ? null : round(num(r.fund) / 1e8, 2),
    breakCount: Number(r.zbc) || 0,
    statDays: r.zttj && Number(r.zttj.days) ? Number(r.zttj.days) : null,
    statBoards: r.zttj && Number(r.zttj.ct) ? Number(r.zttj.ct) : null,
    industry: r.hybk || '',
    days: Number(r.days) || null,
    oneWord: kind === 'ZT' && fbt !== null && fbt <= 92500 && (Number(r.zbc) || 0) === 0,
    kind,
  };
}

let poolDateHint = '';

async function getPools() {
  return cached('battle:pools', 15000, async () => {
    const today = shanghaiDateKey();
    let dateKey = poolDateHint || today;
    let zt = null;
    for (let i = 0; i < 10; i += 1) {
      try {
        zt = await fetchPoolRaw('ZT', dateKey);
      } catch {
        zt = null;
      }
      if (zt && zt.pool.length) break;
      dateKey = shiftDateKey(dateKey, -1);
    }
    if (!zt) zt = { date: dateKey, total: 0, pool: [] };
    const realDate = zt.date || dateKey;
    poolDateHint = realDate;
    const [zb, dt] = await Promise.all([
      fetchPoolRaw('ZB', realDate).catch(() => ({ date: realDate, total: 0, pool: [] })),
      fetchPoolRaw('DT', realDate).catch(() => ({ date: realDate, total: 0, pool: [] })),
    ]);
    const ztItems = zt.pool.map((r) => normalizePoolItem(r, 'ZT')).sort((a, b) => b.boards - a.boards || (a.firstMin || 9999) - (b.firstMin || 9999));
    const zbItems = zb.pool.map((r) => normalizePoolItem(r, 'ZB')).sort((a, b) => (a.firstMin || 9999) - (b.firstMin || 9999));
    const dtItems = dt.pool.map((r) => normalizePoolItem(r, 'DT')).sort((a, b) => (a.lastMin || 9999) - (b.lastMin || 9999));
    const maxBoards = ztItems.reduce((m, x) => Math.max(m, x.boards || 1), 0);
    const breakRate = zt.total + zb.total ? zb.total / (zt.total + zb.total) : 0;
    return {
      dateKey: realDate,
      date: dateKeyText(realDate),
      updatedAt: Date.now(),
      zt: { total: zt.total || ztItems.length, items: ztItems },
      zb: { total: zb.total || zbItems.length, items: zbItems },
      dt: { total: dt.total || dtItems.length, items: dtItems },
      maxBoards,
      breakRate: round(breakRate * 100, 1),
    };
  });
}

function sealHistogram(pools) {
  const bins = [{ label: '竞价', min: 565, max: 570 }];
  for (let m = 570; m < 900; m += 30) {
    if (m >= 690 && m < 780) continue; // 午间休市不产生封板事件
    bins.push({ label: `${String(Math.floor(m / 60)).padStart(2, '0')}:${m % 60 === 0 ? '00' : '30'}`, min: m, max: m + 30 });
  }
  const rows = bins.map((b) => ({ ...b, sealed: 0, broken: 0 }));
  const place = (min, field) => {
    if (min === null || !Number.isFinite(min)) return;
    const idx = rows.findIndex((b) => min >= b.min && min < b.max);
    if (idx >= 0) rows[idx][field] += 1;
  };
  for (const item of pools.zt.items) place(item.firstMin, 'sealed');
  for (const item of pools.zb.items) place(item.firstMin, 'broken');
  return { bins: rows, updatedAt: Date.now() };
}

/* ---------- 集合竞价开盘分布（按交易日缓存一份全市场快照） ---------- */
const auctionState = { key: '', running: false, done: 0, totalPages: 0, scanned: 0, data: null, updatedAt: 0, error: null };
const AUCTION_FILE = (key) => path.join(__dirname, 'data', `auction-${key}.json`);

async function fetchAuctionPage(page) {
  const url =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=' + page +
    '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=' + BATTLE_STOCK_FS +
    '&fields=f2,f3,f12,f13,f14,f17,f18';
  const json = await clistJSON(url, 15000);
  return {
    total: Number(json?.data?.total) || 0,
    diff: Array.isArray(json?.data?.diff) ? json.data.diff : [],
  };
}

async function fetchSinaHSPage(page) {
  const url =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
    `?page=${page}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page`;
  const res = await fetch(url, {
    headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`新浪全市场 HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.map((d) => ({
    f12: String(d.code || (d.symbol || '').slice(2)),
    f13: String(d.symbol || '').startsWith('sh') ? 1 : 0,
    f14: d.name || '',
    f17: num(d.open),
    f18: num(d.settlement),
    f2: num(d.trade),
    f3: num(d.changepercent),
  }));
}

function computeAuction(rows) {
  const defs = [
    { key: 'ge7', label: '≥7%', tone: 'up', test: (g) => g >= 7 },
    { key: '3to7', label: '3~7%', tone: 'up', test: (g) => g >= 3 && g < 7 },
    { key: '1to3', label: '1~3%', tone: 'up', test: (g) => g >= 1 && g < 3 },
    { key: '0to1', label: '0~1%', tone: 'up', test: (g) => g > 0 && g < 1 },
    { key: 'flat', label: '平开', tone: 'flat', test: (g) => g === 0 },
    { key: 'm1to0', label: '0~-1%', tone: 'down', test: (g) => g < 0 && g > -1 },
    { key: 'm3tom1', label: '-1~-3%', tone: 'down', test: (g) => g <= -1 && g > -3 },
    { key: 'm7tom3', label: '-3~-7%', tone: 'down', test: (g) => g <= -3 && g > -7 },
    { key: 'lem7', label: '≤-7%', tone: 'down', test: (g) => g <= -7 },
  ];
  const buckets = defs.map((d) => ({ ...d, count: 0 }));
  let total = 0;
  let highOpen = 0;
  let lowOpen = 0;
  let flat = 0;
  let limitUpOpen = 0;
  let limitDownOpen = 0;
  let gapSum = 0;
  const seen = new Set();
  for (const d of rows) {
    const code = String(d.f12 || '');
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const open = num(d.f17);
    const prevClose = num(d.f18);
    const name = d.f14 || '';
    if (open === null || prevClose === null || open <= 0 || prevClose <= 0) continue;
    const gap = round(((open - prevClose) / prevClose) * 100, 2);
    total += 1;
    gapSum += gap;
    if (gap > 0) highOpen += 1;
    else if (gap < 0) lowOpen += 1;
    else flat += 1;
    const bucket = buckets.find((b) => b.test(gap));
    if (bucket) bucket.count += 1;
    const ratio = limitRatioOf(code, name);
    if (ratio) {
      const up = Math.round(prevClose * (1 + ratio) * 100) / 100;
      const down = Math.round(prevClose * (1 - ratio) * 100) / 100;
      if (open >= up - 0.005) limitUpOpen += 1;
      if (open <= down + 0.005) limitDownOpen += 1;
    }
  }
  return {
    buckets,
    total,
    highOpen,
    lowOpen,
    flat,
    limitUpOpen,
    limitDownOpen,
    avgGap: total ? round(gapSum / total, 2) : null,
    updatedAt: Date.now(),
    pending: false,
  };
}

function startAuctionScan(key) {
  if (auctionState.running) return;
  auctionState.key = key;
  auctionState.running = true;
  auctionState.done = 0;
  auctionState.totalPages = 0;
  auctionState.scanned = 0;
  auctionState.data = null;
  auctionState.error = null;
  (async () => {
    try {
      let rows = [];
      try {
        const first = await fetchAuctionPage(1);
        if (!first.total || !first.diff.length) throw new Error('东方财富 clist 返回空快照');
        const totalPages = Math.max(1, Math.ceil(first.total / 100));
        auctionState.totalPages = totalPages;
        rows.push(...first.diff);
        auctionState.done = 1;
        auctionState.scanned = rows.length;
        const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
        await mapLimit(pages, 4, async (page) => {
          try {
            const got = await fetchAuctionPage(page);
            rows.push(...got.diff);
          } catch { /* 单页失败时少一条样本，不阻断整体分布 */ }
          auctionState.done += 1;
          auctionState.scanned = rows.length;
        });
      } catch {
        // 东方财富 clist 在部分网络环境会被上游拒绝；改用新浪沪深 A 股全量分页。
        const pages = Array.from({ length: 70 }, (_, i) => i + 1);
        auctionState.totalPages = pages.length;
        await mapLimit(pages, 4, async (page) => {
          try {
            const got = await fetchSinaHSPage(page);
            if (got.length) rows.push(...got);
          } catch { /* 单页失败忽略 */ }
          auctionState.done += 1;
          auctionState.scanned = rows.length;
        });
      }
      const data = computeAuction(rows);
      data.scanned = auctionState.scanned;
      data.totalPages = auctionState.totalPages;
      data.savedAt = Date.now();
      auctionState.data = data;
      auctionState.updatedAt = Date.now();
      try {
        fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
        fs.writeFileSync(AUCTION_FILE(key), JSON.stringify(data));
      } catch { /* 忽略磁盘写入失败 */ }
    } catch (err) {
      auctionState.error = err.message;
    } finally {
      auctionState.running = false;
    }
  })();
}

async function ensureAuction(key) {
  if (!key) return { pending: true, progress: 0 };
  if (auctionState.key === key) {
    if (auctionState.data) return { ...auctionState.data, pending: false };
    if (auctionState.running) {
      const progress = auctionState.totalPages
        ? Math.round((auctionState.done / auctionState.totalPages) * 100)
        : 0;
      return {
        pending: true,
        progress,
        scanned: auctionState.scanned,
        totalPages: auctionState.totalPages,
        error: auctionState.error,
      };
    }
  }
  if (auctionState.running) {
    return {
      pending: true,
      progress: auctionState.totalPages
        ? Math.round((auctionState.done / auctionState.totalPages) * 100)
        : 0,
      scanned: auctionState.scanned,
      totalPages: auctionState.totalPages,
    };
  }
  auctionState.key = key;
  auctionState.data = null;
  try {
    const raw = fs.readFileSync(AUCTION_FILE(key), 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.buckets)) {
      auctionState.data = { ...data, pending: false };
      auctionState.updatedAt = data.savedAt || Date.now();
      return auctionState.data;
    }
  } catch { /* 无缓存时后台扫全市场 */ }
  startAuctionScan(key);
  return { pending: true, progress: 0, scanned: 0, totalPages: 0 };
}

/* ---------- 板块确认 ---------- */
const SECTOR_MEMBER_FILE = path.join(__dirname, 'data', 'sector-members.json');
let memberCache = null;
let memberSaveTimer = null;
const memberScan = { running: false, done: 0, total: 0, queue: new Map(), lastAt: 0, lastError: null };

function loadMemberCache() {
  if (memberCache) return memberCache;
  memberCache = { updatedAt: Date.now(), map: {} };
  try {
    const raw = fs.readFileSync(SECTOR_MEMBER_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.map && typeof parsed.map === 'object') memberCache = parsed;
  } catch { /* 首次运行没有缓存 */ }
  return memberCache;
}

function persistMemberCache(force = false) {
  if (!force && memberSaveTimer) return;
  memberSaveTimer = setTimeout(() => {
    memberSaveTimer = null;
    try {
      memberCache.updatedAt = Date.now();
      fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
      fs.writeFileSync(SECTOR_MEMBER_FILE, JSON.stringify(memberCache));
    } catch { /* 忽略磁盘写入失败 */ }
  }, 1200);
}

async function fetchBoardMembersPage(code, page, fields = 'f12,f13,f14,f3') {
  const url =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=' + page +
    '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3' +
    `&fs=b:${encodeURIComponent(code)}&fields=${fields}`;
  const json = await clistJSON(url, 12000);
  return {
    total: Number(json?.data?.total) || 0,
    diff: Array.isArray(json?.data?.diff) ? json.data.diff : [],
  };
}

async function fetchBoardTopMembers(code, name, type = 'concept') {
  try {
    const got = await fetchBoardMembersPage(code, 1);
    const items = got.diff
      .map((d) => ({ code: String(d.f12 || ''), market: Number(d.f13), name: d.f14 || '', pct: num(d.f3) }))
      .filter((d) => d.code);
    if (items.length) return { total: got.total, items, at: Date.now(), source: 'eastmoney' };
  } catch { /* 东方财富 clist 被拒时回退到新浪板块节点 */ }
  const node = await findSinaNode(type, name);
  if (!node) return { total: 0, items: [], at: Date.now(), source: 'none' };
  const items = await fetchSinaNodeMembers(node.node, Math.min(node.count, 100));
  return {
    total: node.count,
    items: items.slice(0, 100),
    at: Date.now(),
    source: 'sina',
    node: node.node,
  };
}

let sinaNodeCache = { at: 0, industry: new Map(), concept: new Map() };

async function fetchGbkText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://finance.sina.com.cn/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`新浪接口 HTTP ${res.status}`);
  return new TextDecoder('gbk').decode(Buffer.from(await res.arrayBuffer()));
}

async function getSinaNodeMap(type) {
  const key = type === 'industry' ? 'industry' : 'concept';
  if (Date.now() - sinaNodeCache.at < 3600000 && sinaNodeCache[key].size) return sinaNodeCache[key];
  const url = key === 'concept'
    ? 'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class'
    : 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php';
  const text = await fetchGbkText(url);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('新浪板块清单格式异常');
  const json = JSON.parse(text.slice(start, end + 1));
  const map = new Map();
  for (const [node, raw] of Object.entries(json)) {
    const f = String(raw).split(',');
    if (!f[1]) continue;
    map.set(f[1], { node, name: f[1], count: Number(f[2]) || 0 });
  }
  sinaNodeCache[key] = map;
  sinaNodeCache.at = Date.now();
  return map;
}

async function findSinaNode(type, name) {
  let map;
  try {
    map = await getSinaNodeMap(type);
  } catch {
    return null;
  }
  if (map.has(name)) return map.get(name);
  const norm = (s) => String(s || '').replace(/概念|板块|指数|\s+/g, '');
  const target = norm(name);
  for (const [key, node] of map) {
    if (norm(key) === target) return node;
  }
  for (const [key, node] of map) {
    const k = norm(key);
    if (k && (k.includes(target) || target.includes(k))) return node;
  }
  return null;
}

async function fetchSinaNodeMembers(node, totalCount) {
  const pages = Math.max(1, Math.min(8, Math.ceil((Number(totalCount) || 100) / 100)));
  const batches = await mapLimit(Array.from({ length: pages }, (_, i) => i + 1), 2, async (page) => {
    const url =
      'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
      `?page=${page}&num=100&sort=changepercent&asc=0&node=${encodeURIComponent(node)}&symbol=&_s_r_a=page`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://finance.sina.com.cn/' },
        signal: AbortSignal.timeout(12000),
      });
      const rows = await res.json();
      if (!Array.isArray(rows)) return [];
      return rows.map((d) => {
        const symbol = String(d.symbol || '');
        return {
          code: String(d.code || symbol.slice(2)),
          market: symbol.startsWith('sh') ? 1 : 0,
          name: d.name || '',
          pct: num(d.changepercent),
        };
      });
    } catch {
      return [];
    }
  });
  const seen = new Set();
  return batches.flat().filter((x) => x.code && !seen.has(x.code) && seen.add(x.code));
}

function memberEntry(code) {
  const cache = loadMemberCache();
  const entry = cache.map[code];
  if (!entry || !Array.isArray(entry.items)) return null;
  if (Date.now() - (entry.at || 0) > 7 * 24 * 3600 * 1000) return null;
  return entry;
}

function queueMemberScan(boards) {
  const cache = loadMemberCache();
  for (const b of boards) {
    if (!b || !b.code || memberEntry(b.code)) continue;
    memberScan.queue.set(b.code, { code: b.code, name: b.name, type: b.type || 'concept' });
  }
  if (!memberScan.running && memberScan.queue.size) runMemberScan();
}

async function runMemberScan() {
  if (memberScan.running) return;
  if (Date.now() - memberScan.lastAt < 120000 && memberScan.done > 0 && memberScan.queue.size) {
    // 刚结束一轮扫描仍失败时，避免每次刷新都重试上游。
    memberScan.queue.clear();
    return;
  }
  memberScan.running = true;
  memberScan.total = memberScan.queue.size;
  memberScan.done = 0;
  const list = [...memberScan.queue.values()];
  memberScan.queue.clear();
  const cache = loadMemberCache();
  await mapLimit(list, 2, async (board) => {
    try {
      const got = await fetchBoardTopMembers(board.code, board.name, board.type);
      if (got.items.length) cache.map[board.code] = got;
    } catch (err) {
      memberScan.lastError = err.message;
    }
    memberScan.done += 1;
    if (memberScan.done % 10 === 0) persistMemberCache();
    await sleep(90);
  });
  memberScan.running = false;
  memberScan.lastAt = Date.now();
  persistMemberCache(true);
  if (memberScan.queue.size) runMemberScan();
}

async function fetchTopBoards(type, limit = 100) {
  // 板块清单沿用项目已有的 ulist 批量接口（行业/概念全量），避免 clist 的
  // fs=m:90+t:2 在部分网络环境下被上游拒绝；再按成交额取流动性最好的板块。
  const data = await getSectors(type);
  const NON_THEMATIC = /昨日|今日|最近|连板|涨停|跌停|炸板|新高|新低|热股|趋势股|基金|重仓|融资融券|沪股通|深股通|陆股通|MSCI|标普|富时|HS300|上证|深证|中证|沪深300|科创50|创业板|大盘|中盘|小盘|微盘|次新|破净|茅指数|宁组合|行业龙头|权重股|机构|社保|QFII|北向|预盈|预亏|业绩|高送转|股权激励|回购|增持|减持|解禁|定增|转债|AB股|B股|H股|同花顺|东方财富|证金|汇金|参股|风格|标准普尔|央视50/;
  const pool = type === 'concept' ? (data.items || []).filter((s) => !NON_THEMATIC.test(s.name)) : (data.items || []);
  const items = pool
    .slice()
    .sort((a, b) => (b.amountYi || 0) - (a.amountYi || 0))
    .slice(0, limit)
    .map((s) => ({
      ...s,
      type,
      mainYi: Number.isFinite(s.main) ? s.main : 0,
      superYi: Number.isFinite(s.super) ? s.super : 0,
      lead: s.lead || '',
      leadPct: s.leadPct === undefined ? null : s.leadPct,
    }));
  return { total: data.total || items.length, items, source: data.source || 'eastmoney' };
}

function percentileScores(values) {
  const n = values.length;
  const scores = new Array(n).fill(50);
  if (n < 2) return scores;
  const valid = values
    .map((v, i) => ({ v: Number(v), i }))
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => a.v - b.v);
  if (valid.length < 2) return scores;
  let i = 0;
  while (i < valid.length) {
    let j = i;
    while (j + 1 < valid.length && valid[j + 1].v === valid[i].v) j += 1;
    const score = Math.round((((i + j) / 2) / (valid.length - 1)) * 100);
    for (let k = i; k <= j; k += 1) scores[valid[k].i] = score;
    i = j + 1;
  }
  return scores;
}

function sectorStatusOf(score) {
  if (score >= 78) return { key: 'strong', label: '强确认', tone: 'up' };
  if (score >= 62) return { key: 'confirmed', label: '已确认', tone: 'up' };
  if (score >= 45) return { key: 'watch', label: '观察中', tone: 'flat' };
  return { key: 'pending', label: '待确认', tone: 'down' };
}

function normBoardName(name) {
  return String(name || '')
    .replace(/[ⅡⅢⅣⅤ]/g, '')
    .replace(/概念|板块|指数|_/g, '')
    .replace(/\s+/g, '');
}

/* 概念板块没有免费的成分股全量表可用时，用涨停股的 F10“所属板块”反推涨停家数：
   一次只抓当日涨停池（约 50 只），比扫 200 个板块的成分股更轻，也更稳定。 */
const conceptZtCache = { dateKey: '', at: 0, map: new Map(), members: new Map(), ok: 0, failed: 0 };

async function getConceptZtCounts(pools) {
  if (conceptZtCache.dateKey === pools.dateKey && Date.now() - conceptZtCache.at < 600000) {
    return conceptZtCache;
  }
  const map = new Map();
  const members = new Map();
  let ok = 0;
  let failed = 0;
  await mapLimit(pools.zt.items, 4, async (item) => {
    const prefix = item.market === 1 ? 'SH' : /^[489]/.test(item.code) ? 'BJ' : 'SZ';
    try {
      const json = await fetchJSON(
        `https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=${prefix}${item.code}`,
        10000,
      );
      const rows = Array.isArray(json?.ssbk) ? json.ssbk : [];
      if (rows.length) ok += 1;
      for (const r of rows) {
        const key = normBoardName(r.BOARD_NAME);
        if (!key) continue;
        map.set(key, (map.get(key) || 0) + 1);
        if (!members.has(key)) members.set(key, []);
        const arr = members.get(key);
        if (!arr.some((x) => x.code === item.code)) {
          arr.push({
            code: item.code,
            market: item.market,
            secid: item.secid,
            name: item.name,
            pct: item.pct,
            boards: item.boards,
          });
        }
      }
    } catch {
      failed += 1;
    }
  });
  conceptZtCache.dateKey = pools.dateKey;
  conceptZtCache.at = Date.now();
  conceptZtCache.map = map;
  conceptZtCache.members = members;
  conceptZtCache.ok = ok;
  conceptZtCache.failed = failed;
  return conceptZtCache;
}

async function buildSectorConfirm() {
  const [industry, conceptRaw, pools] = await Promise.all([
    fetchTopBoards('industry', 100).catch(() => ({ total: 0, items: [] })),
    fetchTopBoards('concept', 120).catch(() => ({ total: 0, items: [] })),
    getPools(),
  ]);
  // 行业板块约 90 个，用概念板块补足到 200 个，保证“行业 + 概念 200 个板块”的口径。
  const concept = {
    ...conceptRaw,
    items: conceptRaw.items.slice(0, Math.max(0, 200 - industry.items.length)),
  };
  const rows = [...industry.items, ...concept.items];
  const conceptZt = await getConceptZtCounts(pools).catch(() => ({ map: new Map(), ok: 0 }));
  const ztItems = pools.zt.items;
  const ztSet = new Set(ztItems.map((x) => x.code));
  const ztByIndustry = new Map();
  const ztLeadByIndustry = new Map();
  for (const item of ztItems) {
    const key = normBoardName(item.industry);
    if (!key) continue;
    ztByIndustry.set(key, (ztByIndustry.get(key) || 0) + 1);
    const cur = ztLeadByIndustry.get(key);
    if (!cur || (item.boards || 1) > (cur.boards || 1)) ztLeadByIndustry.set(key, item);
  }
  for (const row of rows) {
    const boardKey = normBoardName(row.name);
    const entry = memberEntry(row.code);
    if (entry) {
      row.zt = entry.items.reduce((n, x) => n + (ztSet.has(x.code) ? 1 : 0), 0);
      row.ztScanned = true;
      row.ztSource = 'members';
    } else if (row.type === 'industry') {
      row.zt = ztByIndustry.get(boardKey) || 0;
      row.ztScanned = true;
      row.ztSource = 'industry';
    } else if (conceptZt.ok > 0) {
      row.zt = conceptZt.map.get(boardKey) || 0;
      row.ztScanned = true;
      row.ztSource = 'f10';
    } else {
      row.zt = null;
      row.ztScanned = false;
    }
    let lead = row.type === 'industry' ? ztLeadByIndustry.get(boardKey) : null;
    if (!lead && row.type === 'concept' && conceptZt.members && conceptZt.members.get(boardKey)) {
      lead = conceptZt.members.get(boardKey).slice().sort((a, b) => (b.boards || 1) - (a.boards || 1))[0];
    }
    if (!lead && entry && entry.items.length) lead = entry.items[0];
    row.lead = lead ? lead.name : '';
    row.leadPct = lead ? lead.pct : null;
    row.breadth = Number(row.up) + Number(row.down) > 0 ? Number(row.up) / (Number(row.up) + Number(row.down)) : null;
  }
  const withZt = rows.filter((x) => x.zt !== null);
  const pctScores = percentileScores(rows.map((x) => x.pct));
  const flowScores = percentileScores(rows.map((x) => x.mainYi));
  const breadthScores = percentileScores(rows.map((x) => x.breadth));
  const ztScoresFull = percentileScores(rows.map((x) => (x.zt === null ? 0 : x.zt)));
  rows.forEach((row, i) => {
    const ztKnown = row.zt !== null;
    const weights = ztKnown
      ? { pct: 0.28, flow: 0.32, breadth: 0.18, zt: 0.22 }
      : { pct: 0.36, flow: 0.41, breadth: 0.23, zt: 0 };
    const score = Math.round(
      pctScores[i] * weights.pct +
      flowScores[i] * weights.flow +
      breadthScores[i] * weights.breadth +
      ztScoresFull[i] * weights.zt,
    );
    row.score = score;
    row.status = sectorStatusOf(score);
    row.ztScore = ztKnown ? ztScoresFull[i] : null;
    row.pctScore = pctScores[i];
    row.flowScore = flowScores[i];
    row.breadthScore = breadthScores[i];
  });
  rows.sort((a, b) => b.score - a.score || b.mainYi - a.mainYi);
  rows.forEach((row, i) => { row.rank = i + 1; });
  const counts = { strong: 0, confirmed: 0, watch: 0, pending: 0 };
  for (const row of rows) counts[row.status.key] += 1;
  return {
    items: rows,
    summary: {
      total: rows.length,
      industry: industry.items.length,
      concept: concept.items.length,
      ...counts,
      confirmed: counts.strong + counts.confirmed,
    },
    universe: {
      industryTotal: industry.total,
      conceptTotal: concept.total,
      scannedMembers: Object.keys(loadMemberCache().map).length,
      conceptZtStocks: conceptZt.ok,
      ztScanned: withZt.filter((x) => x.ztScanned).length,
    },
    updatedAt: Date.now(),
  };
}

function memberScanSnapshot() {
  const cachedCount = Object.keys(loadMemberCache().map).length;
  return {
    running: memberScan.running,
    done: memberScan.done,
    total: memberScan.total,
    progress: memberScan.total ? Math.round((memberScan.done / memberScan.total) * 100) : 0,
    cached: cachedCount,
    error: memberScan.lastError,
  };
}

async function getSectorConfirm() {
  const data = await cached('battle:sectors', 15000, buildSectorConfirm);
  return { ...data, scan: memberScanSnapshot() };
}

/* ---------- 资金异动 ---------- */
const moveHist = new Map();
const moveAlertState = new Map();
let battlePoolSets = { dateKey: '', zt: new Set(), zb: new Set() };
const alertLog = [];
const alertKeys = new Set();
let alertSeq = 0;
let alertSeededDate = '';

function alertTimestamp(dateText, timeText) {
  const d = String(dateText || '').slice(0, 10);
  const t = /^\d{2}:\d{2}$/.test(String(timeText || '')) ? timeText : '09:30';
  const ts = Date.parse(`${d}T${t}:00+08:00`);
  return Number.isFinite(ts) ? ts : Date.now();
}

function pushAlert(alert) {
  const key = `${alert.dateKey || ''}:${alert.type}:${alert.code}:${alert.dedupe || alert.text}`;
  if (alertKeys.has(key)) return;
  alertKeys.add(key);
  if (alertKeys.size > 800) alertKeys.clear();
  alertSeq += 1;
  alertLog.unshift({ id: alertSeq, ...alert });
  if (alertLog.length > 240) alertLog.length = 240;
}

function seedAlerts(pools) {
  if (alertSeededDate === pools.dateKey) return;
  alertSeededDate = pools.dateKey;
  const events = [];
  for (const x of pools.zt.items) {
    if (x.lastMin !== null && x.lastMin !== x.firstMin && x.breakCount > 0) {
      events.push({ min: x.lastMin, type: 'reseal', tone: 'up', code: x.code, secid: x.secid, name: x.name, text: `回封 · ${x.boards}板 · 封单 ${x.sealFundYi === null ? '--' : x.sealFundYi.toFixed(2) + '亿'}`, time: x.lastSeal });
    } else {
      events.push({ min: x.firstMin, type: 'seal', tone: 'up', code: x.code, secid: x.secid, name: x.name, text: `封板 · ${x.boards > 1 ? x.boards + '连板' : '首板'} · 封单 ${x.sealFundYi === null ? '--' : x.sealFundYi.toFixed(2) + '亿'}`, time: x.firstSeal });
    }
  }
  for (const x of pools.zb.items) {
    events.push({ min: x.firstMin, type: 'break', tone: 'down', code: x.code, secid: x.secid, name: x.name, text: `炸板 · 炸板 ${x.breakCount} 次 · 现 ${x.pct === null ? '--' : x.pct.toFixed(2) + '%'}`, time: x.firstSeal });
  }
  for (const x of pools.dt.items) {
    events.push({ min: x.lastMin || x.firstMin, type: 'limitdown', tone: 'down', code: x.code, secid: x.secid, name: x.name, text: `跌停 · 封单 ${x.sealFundYi === null ? '--' : Math.abs(x.sealFundYi).toFixed(2) + '亿'}`, time: x.lastSeal });
  }
  events.sort((a, b) => (b.min || 0) - (a.min || 0));
  for (const ev of events.slice(0, 60)) {
    pushAlert({
      type: ev.type,
      tone: ev.tone,
      code: ev.code,
      secid: ev.secid,
      name: ev.name,
      text: ev.text,
      time: ev.time,
      dateKey: pools.dateKey,
      at: alertTimestamp(pools.date, ev.time),
      seed: true,
      dedupe: `${ev.type}:${ev.time}`,
    });
  }
}

function updatePoolSets(pools) {
  if (battlePoolSets.dateKey === pools.dateKey) return;
  battlePoolSets = {
    dateKey: pools.dateKey,
    zt: new Set(pools.zt.items.map((x) => x.code)),
    zb: new Set(pools.zb.items.map((x) => x.code)),
    dt: new Set(pools.dt.items.map((x) => x.code)),
  };
}

async function fetchMarketRank(fid, po, limit = 50) {
  const url =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=' + limit + '&po=' + po +
    '&np=1&fltt=2&invt=2&fid=' + fid + '&fs=' + BATTLE_STOCK_FS +
    '&fields=' + BATTLE_MOVE_FIELDS;
  const json = await clistJSON(url, 12000);
  return (json?.data?.diff || []).map((d) => normalizeMoveRow(d));
}

async function fetchTencentSpeed(limit = 120) {
  const url =
    'https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList' +
    `?board_code=aStock&sort_type=speed&direct=down&offset=0&count=${Math.min(300, limit)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`腾讯涨速榜 HTTP ${res.status}`);
  const json = await res.json();
  const rows = json?.data?.rank_list || [];
  return rows.map((r) => {
    const symbol = String(r.code || '');
    const code = symbol.replace(/^(sh|sz|bj)/, '');
    const market = symbol.startsWith('sh') ? 1 : 0;
    const price = num(r.zxj);
    const pct = num(r.zdf);
    const mainWan = num(r.zljlr);
    const prevClose = price !== null && pct !== null && pct > -100
      ? round(price / (1 + pct / 100), 2)
      : null;
    return {
      group: 'stock',
      secid: `${market}.${code}`,
      code,
      market,
      name: r.name || '',
      price,
      pct,
      change: num(r.zd),
      open: null,
      high: null,
      low: null,
      prevClose,
      volume: num(r.volume),
      amount: null,
      amountYi: null,
      turnover: num(r.hsl),
      pe: null,
      mktCap: null,
      mktCapYi: null,
      main: mainWan === null ? null : mainWan * 10000,
      mainYi: mainWan === null ? null : round(mainWan / 10000, 2),
      mainPct: null,
      industry: '',
      volumeRatio: num(r.lb),
      speed: num(r.speed),
      fiveMin: num(r.speed),
      tenDayPct: num(r.zdf_d10),
    };
  }).filter((q) => q.code && q.price !== null);
}

async function fetchMoveLists() {
  try {
    const [inflow, outflow, speed, gain] = await Promise.all([
      fetchMarketRank('f62', 1),
      fetchMarketRank('f62', 0),
      fetchMarketRank('f22', 1),
      fetchMarketRank('f3', 1),
    ]);
    if (inflow.length || outflow.length || speed.length || gain.length) {
      return { inflow, outflow, speed, gain, source: 'eastmoney' };
    }
    clistCoolingUntil = Date.now() + 3 * 60 * 1000;
  } catch { /* 回退到新浪资金榜 + 腾讯涨速榜 */ }
  const [inflow, outflow, gain, speed] = await Promise.all([
    getRank('inflow', 50).catch(() => ({ items: [] })),
    getRank('outflow', 50).catch(() => ({ items: [] })),
    getRank('gain', 50).catch(() => ({ items: [] })),
    fetchTencentSpeed(120).catch(() => []),
  ]);
  return {
    inflow: inflow.items || [],
    outflow: outflow.items || [],
    gain: gain.items || [],
    speed,
    source: 'sina/tencent',
  };
}

function normalizeMoveRow(d) {
  const q = normalizeQuote(d, 'stock');
  return {
    ...q,
    volumeRatio: num(d.f10),
    speed: num(d.f22),
    fiveMin: num(d.f11),
    high: num(d.f15),
    low: num(d.f16),
  };
}

function sampleBefore(hist, ts) {
  if (!hist || !hist.length) return null;
  let found = null;
  for (const s of hist) {
    if (s.at <= ts) found = s;
    else break;
  }
  return found;
}

function moveLimitDistance(q) {
  const ratio = limitRatioOf(q.code, q.name);
  if (!ratio || !isFinite(q.prevClose) || !isFinite(q.price) || q.prevClose <= 0 || q.price <= 0) {
    return { distance: null, limitUp: null };
  }
  const limitUp = Math.round(q.prevClose * (1 + ratio) * 100) / 100;
  return { distance: round(Math.max(0, ((limitUp - q.price) / q.price) * 100), 2), limitUp };
}

function buildMoveItem(q, pools, now) {
  if ((!Number.isFinite(q.prevClose) || q.prevClose <= 0) && Number.isFinite(q.price) && Number.isFinite(q.pct) && q.pct > -100) {
    q.prevClose = round(q.price / (1 + q.pct / 100), 2);
  }
  const hist = moveHist.get(q.secid) || [];
  const s1 = sampleBefore(hist, now - 60000);
  const s5 = sampleBefore(hist, now - 300000);
  const s3 = sampleBefore(hist, now - 180000);
  const delta1m = s1 && Number.isFinite(q.mainYi) && Number.isFinite(s1.main) ? round(q.mainYi - s1.main, 2) : null;
  const delta5m = s5 && Number.isFinite(q.mainYi) && Number.isFinite(s5.main) ? round(q.mainYi - s5.main, 2) : null;
  const pulse5m = s5 && Number.isFinite(q.pct) && Number.isFinite(s5.pct) ? round(q.pct - s5.pct, 2) : null;
  const prior = s1 && s3 ? round(s1.main - s3.main, 2) : null;
  const accel = delta1m !== null && prior !== null && prior > 0.02 && delta1m > 0 ? round(delta1m / prior, 2) : null;
  const { distance, limitUp } = moveLimitDistance(q);
  const inZt = pools.zt.items.find((x) => x.code === q.code);
  const inZb = pools.zb.items.find((x) => x.code === q.code);
  const inDt = pools.dt.items.find((x) => x.code === q.code);
  const state = inZt ? '封板' : inZb ? '炸板' : inDt ? '跌停' : distance !== null && distance <= 2 ? '逼近涨停' : '';
  const lastSealMin = inZt ? inZt.lastMin || inZt.firstMin : inZb ? inZb.firstMin : null;
  const tail = (lastSealMin !== null && lastSealMin >= 870) || (zonedParts('Asia/Shanghai').minutes >= 870 && zonedParts('Asia/Shanghai').minutes <= 900 && (pulse5m || 0) > 0.6);
  const tags = [];
  if (inZt) tags.push('封板');
  if (inZb) tags.push('炸板');
  if (inDt) tags.push('跌停');
  if (!inZt && distance !== null && distance <= 2) tags.push('逼近涨停');
  if ((Number.isFinite(delta1m) && delta1m >= 0.1) || (Number.isFinite(q.mainYi) && q.mainYi >= 0.5)) tags.push('主力抢筹');
  if (accel !== null && accel >= 1.5) tags.push('流入加速');
  if ((Number.isFinite(pulse5m) && pulse5m >= 0.8) || (Number.isFinite(q.speed) && q.speed >= 1.2)) tags.push('急速拉升');
  if (Number.isFinite(q.volumeRatio) && q.volumeRatio >= 1.5 && Number.isFinite(q.pct) && q.pct >= 3) tags.push('放量突破');
  if (Number.isFinite(q.mainYi) && q.mainYi <= -0.5) tags.push('主力流出');
  if (tail) tags.push('尾盘异动');

  const reasons = [];
  if (Number.isFinite(q.mainYi)) reasons.push(`主力净流入 ${q.mainYi >= 0 ? '+' : ''}${q.mainYi.toFixed(2)} 亿`);
  if (Number.isFinite(delta1m)) reasons.push(`1 分钟增量 ${delta1m >= 0 ? '+' : ''}${delta1m.toFixed(2)} 亿`);
  if (Number.isFinite(accel)) reasons.push(`流入加速 ${accel.toFixed(2)}×`);
  if (Number.isFinite(pulse5m)) reasons.push(`5 分钟脉冲 ${pulse5m >= 0 ? '+' : ''}${pulse5m.toFixed(2)}%`);
  if (Number.isFinite(q.volumeRatio)) reasons.push(`量比 ${q.volumeRatio.toFixed(2)}`);
  if (Number.isFinite(distance)) reasons.push(`距涨停 ${distance.toFixed(2)}%`);
  if (inZt) reasons.push(`封单 ${inZt.sealFundYi === null ? '--' : inZt.sealFundYi.toFixed(2) + ' 亿'} · 首封 ${inZt.firstSeal}`);
  if (inZb) reasons.push(`炸板 ${inZb.breakCount} 次`);
  if (state) reasons.push(state);

  let score = 0;
  if (Number.isFinite(q.mainYi)) score += Math.min(30, Math.abs(q.mainYi) * 4);
  if (Number.isFinite(delta1m)) score += Math.min(24, Math.abs(delta1m) * 24);
  if (Number.isFinite(q.pct)) score += Math.min(18, Math.abs(q.pct) * 2);
  if (Number.isFinite(q.volumeRatio)) score += Math.min(9, q.volumeRatio * 3);
  if (Number.isFinite(pulse5m)) score += Math.min(14, Math.abs(pulse5m) * 7);
  if (Number.isFinite(accel)) score += Math.min(12, accel * 4);
  if (state) score += 18;
  if (tail) score += 8;
  score = Math.round(clamp(score, 0, 100));
  const grade = score >= 70 ? 'A' : score >= 50 ? 'B' : score >= 30 ? 'C' : 'D';

  hist.push({ at: now, main: Number.isFinite(q.mainYi) ? q.mainYi : null, pct: Number.isFinite(q.pct) ? q.pct : null });
  while (hist.length && hist[0].at < now - 15 * 60000) hist.shift();
  moveHist.set(q.secid, hist);

  return {
    ...q,
    delta1m,
    delta5m,
    pulse5m,
    accel,
    distance,
    limitUp,
    volumeRatio: q.volumeRatio,
    state,
    tail,
    tags,
    reasons,
    score,
    grade,
    boards: inZt ? inZt.boards : null,
    sealFundYi: inZt ? inZt.sealFundYi : null,
    firstSeal: inZt ? inZt.firstSeal : inZb ? inZb.firstSeal : null,
    breakCount: inZb ? inZb.breakCount : inZt ? inZt.breakCount : 0,
    statDays: inZt ? inZt.statDays : null,
    statBoards: inZt ? inZt.statBoards : null,
  };
}

function generateLiveAlerts(items, pools, now) {
  const dateKey = pools.dateKey;
  for (const q of items) {
    const prev = moveAlertState.get(q.secid);
    const liveBase = {
      code: q.code,
      secid: q.secid,
      name: q.name,
      time: new Date(now).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5),
      dateKey,
      at: now,
      seed: false,
    };
    if (prev) {
      if (q.pct !== null && prev.pct !== null && q.pct - prev.pct >= 1.5) {
        pushAlert({ ...liveBase, type: 'pulse', tone: 'up', text: `5 分钟急速拉升 +${(q.pct - prev.pct).toFixed(2)}%`, dedupe: `pulse:${Math.floor(now / 120000)}` });
      }
      if (q.mainYi !== null && prev.main !== null && q.mainYi - prev.main >= 0.3) {
        pushAlert({ ...liveBase, type: 'inflow', tone: 'up', text: `主力抢筹 +${(q.mainYi - prev.main).toFixed(2)} 亿`, dedupe: `inflow:${Math.floor(now / 180000)}` });
      }
    }
    moveAlertState.set(q.secid, { pct: q.pct, main: q.mainYi, at: now });
  }
  if (battlePoolSets.dateKey === dateKey) {
    for (const item of pools.zt.items) {
      if (!battlePoolSets.zt.has(item.code)) {
        pushAlert({ type: 'seal', tone: 'up', code: item.code, secid: item.secid, name: item.name, text: `封板 · ${item.boards}板 · 封单 ${item.sealFundYi === null ? '--' : item.sealFundYi.toFixed(2) + '亿'}`, time: item.lastSeal !== '--' ? item.lastSeal : item.firstSeal, dateKey, at: now, seed: false, dedupe: 'seal' });
      }
    }
    for (const item of pools.zb.items) {
      if (!battlePoolSets.zb.has(item.code)) {
        pushAlert({ type: 'break', tone: 'down', code: item.code, secid: item.secid, name: item.name, text: `炸板 · 炸板 ${item.breakCount} 次`, time: item.firstSeal, dateKey, at: now, seed: false, dedupe: 'break' });
      }
    }
  }
  battlePoolSets = {
    dateKey,
    zt: new Set(pools.zt.items.map((x) => x.code)),
    zb: new Set(pools.zb.items.map((x) => x.code)),
    dt: new Set(pools.dt.items.map((x) => x.code)),
  };
}

async function getMoneyMoves() {
  return cached('battle:moves', 12000, async () => {
    const pools = await getPools();
    const board = await fetchMoveLists();
    const { inflow, outflow, speed, gain } = board;
    const now = Date.now();
    seedAlerts(pools);
    const map = new Map();
    for (const q of [...inflow, ...outflow, ...speed, ...gain]) {
      if (!q || !q.secid || map.has(q.secid)) continue;
      map.set(q.secid, buildMoveItem(q, pools, now));
    }
    const items = [...map.values()];
    const bySecid = new Map(items.map((x) => [x.secid, x]));
    const seq = (list, sorter) => {
      const ids = [];
      for (const q of list) if (q && bySecid.has(q.secid) && !ids.includes(q.secid)) ids.push(q.secid);
      return ids;
    };
    const lists = {
      inflow: seq(inflow),
      outflow: seq(outflow),
      speed: seq(speed),
      gain: seq(gain),
      all: [...items].sort((a, b) => b.score - a.score).map((x) => x.secid),
    };
    const top = [...items].sort((a, b) => b.score - a.score || Math.abs(b.mainYi || 0) - Math.abs(a.mainYi || 0)).slice(0, 12);
    generateLiveAlerts(top, pools, now);
    const counts = {
      inflow: lists.inflow.length,
      outflow: lists.outflow.length,
      speed: lists.speed.length,
      gain: lists.gain.length,
    };
    return {
      items,
      lists,
      top,
      counts,
      updatedAt: now,
      source: board.source,
      alerts: alertLog.slice(0, 40),
      summary: {
        inflowTop: items.filter((x) => x.mainYi > 0).sort((a, b) => b.mainYi - a.mainYi).slice(0, 3),
        outflowTop: items.filter((x) => x.mainYi < 0).sort((a, b) => a.mainYi - b.mainYi).slice(0, 3),
      },
    };
  });
}

/* ---------- 作战总览 ---------- */
async function getBattle() {
  return cached('battle:overview', 10000, async () => {
    const [overview, pools, sectors, moves] = await Promise.all([
      getOverview(),
      getPools(),
      getSectorConfirm().catch(() => ({ items: [], summary: { total: 0, confirmed: 0, strong: 0 }, scan: {} })),
      getMoneyMoves().catch(() => ({ items: [], top: [], counts: {}, alerts: [] })),
    ]);
    seedAlerts(pools);
    const auction = await ensureAuction(pools.dateKey);
    const cn = overview.cn || [];
    const indices = ['000001', '399001', '399006', '000300'].map((code) => {
      const q = cn.find((x) => x.code === code);
      if (!q) return null;
      return {
        code,
        name: (q.name || '').replace('指数', ''),
        price: q.price,
        pct: q.pct,
        change: q.change,
        amountYi: q.amountYi,
      };
    }).filter(Boolean);
    const sse = cn.find((x) => x.code === '000001');
    const szse = cn.find((x) => x.code === '399001');
    const totalAmountYi = (sse && sse.amountYi ? sse.amountYi : 0) + (szse && szse.amountYi ? szse.amountYi : 0);
    const breadth = overview.breadth || { up: null, down: null, flat: null, available: false };
    const upRatio = breadth.available && breadth.up + breadth.down > 0 ? breadth.up / (breadth.up + breadth.down) : 0.5;
    const dt = pools.dt.total;
    const zt = pools.zt.total;
    let temp = 50;
    temp += clamp(((zt - dt) / Math.max(8, zt + dt)) * 22, -22, 22);
    temp += clamp((pools.maxBoards - 2) * 4, -8, 16);
    temp -= clamp(((pools.breakRate / 100) - 0.25) * 50, -5, 20);
    temp += clamp((upRatio - 0.5) * 60, -15, 15);
    temp += clamp((sse && sse.pct ? sse.pct : 0) * 8, -10, 10);
    temp = Math.round(clamp(temp, 0, 100));
    const tempLabel = temp >= 78 ? '炽热' : temp >= 62 ? '偏暖' : temp >= 45 ? '中性' : temp >= 32 ? '偏冷' : '冰点';
    const tempTone = temp >= 62 ? 'up' : temp < 45 ? 'down' : 'flat';
    const leader = pools.zt.items[0] || null;
    const kpis = [
      { key: 'zt', label: '涨停', value: zt, unit: '家', sub: `封板率 ${zt + pools.zb.total ? Math.round((zt / (zt + pools.zb.total)) * 100) : 0}%`, tone: 'up' },
      { key: 'dt', label: '跌停', value: dt, unit: '家', sub: `炸板 ${pools.zb.total} 家`, tone: dt > 10 ? 'down' : 'flat' },
      { key: 'breakRate', label: '炸板率', value: pools.breakRate, unit: '%', sub: '炸板 / 触板', tone: pools.breakRate >= 30 ? 'down' : pools.breakRate >= 20 ? 'flat' : 'up' },
      { key: 'maxBoard', label: '最高板', value: pools.maxBoards, unit: '板', sub: leader ? leader.name : '暂无连板', tone: 'up' },
      { key: 'confirmed', label: '确认板块', value: sectors.summary ? sectors.summary.confirmed || 0 : 0, unit: '个', sub: `强确认 ${sectors.summary ? sectors.summary.strong || 0 : 0} 个`, tone: 'up' },
      { key: 'alerts', label: '警报', value: alertLog.length, unit: '条', sub: '封板 / 炸板 / 脉冲', tone: alertLog.some((a) => a.tone === 'down') ? 'down' : 'flat' },
    ];
    const mainline = (sectors.items || []).filter((x) => x.status && x.status.key !== 'pending').slice(0, 6);
    const sealGrid = sealHistogram(pools);
    const lastSealItems = pools.zt.items
      .filter((x) => (x.lastMin || x.firstMin || 0) >= 870)
      .slice(0, 5)
      .map((x) => ({ name: x.name, code: x.code, boards: x.boards, time: x.lastSeal, sealFundYi: x.sealFundYi }));
    return {
      date: pools.date,
      dateKey: pools.dateKey,
      updatedAt: Date.now(),
      indices,
      totalAmountYi: round(totalAmountYi, 1),
      breadth,
      upRatio: round(upRatio * 100, 1),
      kpis,
      temp: { score: temp, label: tempLabel, tone: tempTone },
      tempDims: [
        { label: '涨跌停对比', score: Math.round(clamp(50 + ((zt - dt) / Math.max(8, zt + dt)) * 50, 0, 100)) },
        { label: '连板高度', score: Math.round(clamp(pools.maxBoards * 16, 0, 100)) },
        { label: '封板质量', score: Math.round(clamp(100 - pools.breakRate * 1.8, 0, 100)) },
        { label: '市场宽度', score: Math.round(upRatio * 100) },
      ],
      pools: {
        ztTotal: zt,
        zbTotal: pools.zb.total,
        dtTotal: dt,
        maxBoards: pools.maxBoards,
        breakRate: pools.breakRate,
        leader: leader ? { name: leader.name, code: leader.code, boards: leader.boards } : null,
        tailSeal: lastSealItems,
      },
      counts: { zt, zb: pools.zb.total, dt, confirmed: sectors.summary ? sectors.summary.confirmed || 0 : 0 },
      sealGrid,
      auction,
      mainline,
      movesTop: (moves.top || []).slice(0, 8),
      movesCounts: moves.counts || {},
      alerts: alertLog.slice(0, 30),
      source: overview.source,
      stale: Boolean(overview.stale),
    };
  });
}

async function getLadder() {
  const pools = await getPools();
  // 只渲染“最高板 → 首板”之间实际存在的档位，避免空档把首板挤到屏幕外。
  const top = Math.max(1, pools.maxBoards || 1);
  const levels = [];
  for (let b = top; b >= 1; b -= 1) {
    levels.push({
      boards: b,
      label: b === 1 ? '首板' : `${b}板`,
      items: pools.zt.items.filter((x) => (x.boards || 1) === b),
    });
  }
  return {
    date: pools.date,
    dateKey: pools.dateKey,
    updatedAt: Date.now(),
    maxBoards: pools.maxBoards,
    levels,
    broken: pools.zb.items,
    limitDown: pools.dt.items,
    stats: {
      zt: pools.zt.total,
      zb: pools.zb.total,
      dt: pools.dt.total,
      breakRate: pools.breakRate,
    },
  };
}

function sampleTimeline(events, limit) {
  if (events.length <= limit) return events;
  const picked = [];
  const step = events.length / limit;
  for (let i = 0; i < limit; i += 1) picked.push(events[Math.floor(i * step)]);
  const last = events[events.length - 1];
  if (picked[picked.length - 1] !== last) picked[picked.length - 1] = last;
  return picked;
}

async function getTimelineData() {
  const pools = await getPools();
  const events = [];
  for (const x of pools.zt.items) {
    if (x.firstMin !== null) {
      events.push({
        t: x.firstSeal,
        min: x.firstMin,
        kind: 'seal',
        tone: 'up',
        label: '封板',
        name: x.name,
        code: x.code,
        secid: x.secid,
        detail: `${x.boards > 1 ? x.boards + '连板' : '首板'} · 封单 ${x.sealFundYi === null ? '--' : x.sealFundYi.toFixed(2) + '亿'}`,
      });
    }
    if (x.lastMin !== null && x.firstMin !== null && x.lastMin !== x.firstMin && x.breakCount > 0) {
      events.push({
        t: x.lastSeal,
        min: x.lastMin,
        kind: 'reseal',
        tone: 'up',
        label: '回封',
        name: x.name,
        code: x.code,
        secid: x.secid,
        detail: `炸板 ${x.breakCount} 次后回封`,
      });
    }
    if (x.breakCount > 0 && x.firstMin !== null) {
      events.push({
        t: x.firstSeal,
        min: x.firstMin,
        kind: 'touch',
        tone: 'gold',
        label: '触板',
        name: x.name,
        code: x.code,
        secid: x.secid,
        detail: `盘中炸板 ${x.breakCount} 次`,
      });
    }
  }
  for (const x of pools.zb.items) {
    if (x.firstMin === null) continue;
    events.push({
      t: x.firstSeal,
      min: x.firstMin,
      kind: 'break',
      tone: 'down',
      label: '炸板',
      name: x.name,
      code: x.code,
      secid: x.secid,
      detail: `炸板 ${x.breakCount} 次 · 现 ${x.pct === null ? '--' : x.pct.toFixed(2) + '%'}`,
    });
  }
  for (const x of pools.dt.items) {
    const min = x.lastMin || x.firstMin;
    if (min === null) continue;
    events.push({
      t: x.lastSeal !== '--' ? x.lastSeal : x.firstSeal,
      min,
      kind: 'limitdown',
      tone: 'down',
      label: '跌停',
      name: x.name,
      code: x.code,
      secid: x.secid,
      detail: `跌停封单 ${x.sealFundYi === null ? '--' : Math.abs(x.sealFundYi).toFixed(2) + '亿'}`,
    });
  }
  events.sort((a, b) => (a.min - b.min) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  const sampled = sampleTimeline(events, 120);
  const counts = sampled.reduce((m, e) => { m[e.kind] = (m[e.kind] || 0) + 1; return m; }, {});
  return {
    date: pools.date,
    dateKey: pools.dateKey,
    startMin: 565,
    endMin: 900,
    events: sampled,
    totalEvents: events.length,
    counts,
    updatedAt: Date.now(),
  };
}

/* ---------- 十日异动 ---------- */
const tenDayCache = new Map();
let tenDayJob = null;

async function fetchSinaDailyK(secid, days = 15) {
  const symbol = sinaAshareSymbol(secid);
  if (!symbol) return null;
  return cached(`sinaday:${secid}:${days}`, 300000, async () => {
    const url =
      'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData' +
      `?symbol=${symbol}&scale=240&ma=no&datalen=${days + 2}`;
    const text = await fetchSinaText(url);
    let rows;
    try { rows = JSON.parse(text); } catch { return null; }
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows
      .map((r) => ({
        d: r.day,
        o: num(r.open),
        c: num(r.close),
        h: num(r.high),
        l: num(r.low),
        v: num(r.volume),
      }))
      .filter((r) => r.d && r.c !== null);
  });
}

async function fetchSinaFlowHistory(secid, days = 14) {
  const symbol = sinaAshareSymbol(secid);
  if (!symbol || symbol.startsWith('bj')) return null;
  return cached(`sinaflow:${secid}:${days}`, 600000, async () => {
    const url =
      'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs' +
      `?page=1&num=${days}&sort=opendate&asc=0&daima=${symbol}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': EM_HEADERS['User-Agent'], Referer: 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    return rows.map((r) => ({
      date: r.opendate,
      mainYi: num(r.netamount) === null ? null : round(num(r.netamount) / 1e8, 2),
      pct: num(r.changeratio) === null ? null : round(num(r.changeratio) * 100, 2),
    }));
  });
}

async function buildTenDayUniverse() {
  const [pools, moves, gain, loss] = await Promise.all([
    getPools(),
    getMoneyMoves().catch(() => ({ items: [] })),
    getRank('gain', 40).catch(() => ({ items: [] })),
    getRank('loss', 40).catch(() => ({ items: [] })),
  ]);
  const map = new Map();
  const add = (q, source) => {
    if (!q) return;
    const secid = q.secid || (q.market !== undefined && q.code ? `${q.market}.${q.code}` : null);
    if (!secid || map.has(secid)) return;
    if (!/^\d+\.\d{6}$/.test(secid)) return;
    const code = q.code || secid.split('.')[1];
    const market = Number(secid.split('.')[0]);
    if (market === 1 && !/^(60|68)/.test(code)) return;
    if (market === 0 && !/^(00|30|8|4|9)/.test(code)) return;
    map.set(secid, { secid, code, name: q.name || '', industry: q.industry || '', pct: q.pct, source });
  };
  for (const x of pools.zt.items) add(x, '涨停');
  for (const x of pools.zb.items) add(x, '炸板');
  for (const x of pools.dt.items) add(x, '跌停');
  for (const x of moves.items || []) add(x, '异动');
  for (const x of gain.items || []) add(x, '涨幅');
  for (const x of loss.items || []) add(x, '跌幅');
  return [...map.values()].slice(0, 180);
}

async function runTenDayJob(job) {
  const universe = await buildTenDayUniverse();
  job.total = universe.length;
  const dateKey = poolDateHint || shanghaiDateKey();
  const rows = [];
  await mapLimit(universe, 4, async (stock) => {
    try {
      const [kline, flow] = await Promise.all([
        fetchSinaDailyK(stock.secid, 15).catch(() => null),
        fetchSinaFlowHistory(stock.secid, 14).catch(() => null),
      ]);
      if (kline && kline.length >= 3) {
        const candles = kline.slice(-11);
        const last = candles[candles.length - 1];
        const baseIdx = Math.max(0, candles.length - 11);
        const base = candles[baseIdx] || candles[0];
        const window = candles.slice(-10);
        const closes = window.map((c) => c.c);
        const cumPct = base && base.c ? round(((last.c - base.c) / base.c) * 100, 2) : null;
        let upDays = 0;
        let downDays = 0;
        for (let i = candles.length - 1; i > 0; i -= 1) {
          const pct = ((candles[i].c - candles[i - 1].c) / candles[i - 1].c) * 100;
          if (pct > 0.05) {
            if (downDays) break;
            upDays += 1;
          } else if (pct < -0.05) {
            if (upDays) break;
            downDays += 1;
          } else break;
        }
        const limitPct = limitRatioOf(stock.code, stock.name);
        const limitCount = limitPct
          ? candles.slice(1).filter((c, i) => ((c.c - candles[i].c) / candles[i].c) * 100 >= limitPct * 100 - 0.4).length
          : 0;
        const maxDay = candles.slice(1).reduce((m, c, i) => {
          const pct = ((c.c - candles[i].c) / candles[i].c) * 100;
          return Math.max(m, pct);
        }, -999);
        const vols = candles.map((c) => c.v || 0).filter((v) => v > 0);
        const recentVol = vols.slice(-5).reduce((a, b) => a + b, 0) / Math.max(1, vols.slice(-5).length);
        const priorVol = vols.slice(-10, -5).reduce((a, b) => a + b, 0) / Math.max(1, vols.slice(-10, -5).length);
        const volRatio = priorVol > 0 ? round(recentVol / priorVol, 2) : null;
        let flowStreak = 0;
        let flowSum = 0;
        if (Array.isArray(flow)) {
          for (const f of flow.slice(0, 10)) {
            if (f.mainYi === null) break;
            flowSum += f.mainYi;
            if (f.mainYi > 0) flowStreak += 1;
            else break;
          }
        }
        const latestPct = candles.length > 1
          ? round(((last.c - candles[candles.length - 2].c) / candles[candles.length - 2].c) * 100, 2)
          : null;
        rows.push({
          ...stock,
          price: last.c,
          latestPct,
          cumPct,
          upDays,
          downDays,
          limitCount,
          maxDay: round(maxDay, 2),
          volRatio,
          flowStreak,
          flowSumYi: round(flowSum, 2),
          spark: closes,
          startDate: window[0] && window[0].d,
          endDate: last.d,
        });
      }
    } catch { /* 单只失败不阻断整体扫描 */ }
    job.done += 1;
  });
  const dir = job.dir;
  rows.sort((a, b) => (dir === 'down' ? (a.cumPct || 0) - (b.cumPct || 0) : (b.cumPct || 0) - (a.cumPct || 0)));
  const data = {
    dir,
    date: dateKeyText(dateKey),
    scanned: rows.length,
    universe: universe.length,
    items: rows.slice(0, 80),
    updatedAt: Date.now(),
    note: '扫描池 = 涨停/炸板/跌停 + 涨幅/跌幅榜 + 资金异动；日线来自新浪，资金流来自新浪每日资金流。',
  };
  tenDayCache.set(`${dateKey}:${dir}`, { at: Date.now(), data });
  return data;
}

async function getTenDay(dir = 'up', force = false) {
  const pools = await getPools().catch(() => null);
  const dateKey = pools ? pools.dateKey : shanghaiDateKey();
  const key = `${dateKey}:${dir}`;
  if (tenDayJob) {
    return {
      pending: true,
      progress: {
        done: tenDayJob.done,
        total: tenDayJob.total,
        progress: tenDayJob.total ? Math.round((tenDayJob.done / tenDayJob.total) * 100) : 0,
        dir: tenDayJob.dir,
      },
    };
  }
  const hit = tenDayCache.get(key);
  if (hit && !force && Date.now() - hit.at < 600000) {
    return { ...hit.data, pending: false, cached: true };
  }
  const job = { key, dir, done: 0, total: 0, startedAt: Date.now() };
  tenDayJob = job;
  runTenDayJob(job)
    .catch((err) => {
      tenDayCache.set(key, {
        at: Date.now(),
        data: { dir, date: dateKeyText(dateKey), scanned: 0, universe: 0, items: [], error: err.message, note: '扫描失败，请稍后重试。' },
      });
    })
    .finally(() => {
      if (tenDayJob === job) tenDayJob = null;
    });
  return { pending: true, progress: { done: 0, total: 0, progress: 0, dir } };
}

/* ---------- 板块导出 ---------- */
async function fetchBoardAllMembers(code, name, type = 'concept') {
  try {
    const first = await fetchBoardMembersPage(code, 1, 'f12,f13,f14,f3');
    const total = first.total;
    const pages = Math.max(1, Math.ceil(total / 100));
    const rest = [];
    if (pages > 1) {
      const got = await mapLimit(Array.from({ length: pages - 1 }, (_, i) => i + 2), 3, (page) =>
        fetchBoardMembersPage(code, page, 'f12,f13,f14,f3').catch(() => ({ total, diff: [] })));
      for (const g of got) rest.push(...g.diff);
    }
    const all = [...first.diff, ...rest]
      .map((d) => ({ code: String(d.f12 || ''), market: Number(d.f13), name: d.f14 || '' }))
      .filter((x) => /^\d{6}$/.test(x.code));
    if (all.length) {
      const seen = new Set();
      return all.filter((x) => (seen.has(x.code) ? false : (seen.add(x.code), true)));
    }
  } catch { /* 回退新浪板块节点 */ }
  const node = await findSinaNode(type, name);
  if (!node) return [];
  return fetchSinaNodeMembers(node.node, node.count);
}

function ztMembersForBoard(pools, conceptZt, name, type) {
  const key = normBoardName(name);
  if (type === 'concept' && conceptZt && conceptZt.members) {
    return conceptZt.members.get(key) || [];
  }
  return pools.zt.items
    .filter((x) => normBoardName(x.industry) === key)
    .map((x) => ({ code: x.code, market: x.market, secid: x.secid, name: x.name, pct: x.pct, boards: x.boards }));
}

async function getSectorMembers(code, name = '', type = 'concept', full = false) {
  const members = await fetchBoardAllMembers(code, name, type);
  if (members.length) {
    return {
      code,
      name,
      type,
      total: members.length,
      items: full ? members : members.slice(0, 120),
      source: memberEntry(code) ? 'members' : 'live',
      partial: false,
      updatedAt: Date.now(),
      note: '',
    };
  }
  // 东方财富成分股接口被限流时，先展示该板块当日的涨停成员，避免展开后空白。
  const pools = await getPools();
  const conceptZt = type === 'concept' ? await getConceptZtCounts(pools).catch(() => null) : null;
  const fallback = ztMembersForBoard(pools, conceptZt, name, type);
  return {
    code,
    name,
    type,
    total: fallback.length,
    items: full ? fallback : fallback.slice(0, 120),
    source: 'zt',
    partial: true,
    updatedAt: Date.now(),
    note: fallback.length
      ? '成分股全量接口暂不可用，先展示本板块当日涨停成员；稍后可重试或仅导出这些涨停股。'
      : '成分股接口暂不可用，可稍后重试。',
  };
}

async function getSectorExport(code) {
  const sectors = await getSectorConfirm().catch(() => ({ items: [] }));
  const board = (sectors.items || []).find((x) => x.code === code);
  const name = board ? board.name : code;
  const type = board ? board.type : 'concept';
  const data = await getSectorMembers(code, name, type, true);
  const members = data.items || [];
  if (!members.length) throw new Error('没有取到该板块成分股，请稍后重试');
  const lines = members.map((m) => {
    const prefix = m.market === 1 ? '1' : /^[489]/.test(m.code) ? '2' : '0';
    return `${prefix}${m.code}`;
  });
  return {
    code,
    name,
    count: members.length,
    partial: Boolean(data.partial),
    content: lines.join('\r\n'),
    filename: `${name.replace(/[\\/:*?"<>|]/g, '')}_${code}.blk`,
    note: data.partial
      ? '成分股全量接口暂不可用，本文件仅包含当日涨停成员；可稍后重试导出完整成分股。'
      : '通达信板块文件：T0002/blocknew/*.blk；每行“市场前缀+代码”，1=沪市，0=深市，2=北交所。',
    updatedAt: Date.now(),
  };
}

/* =========================================================
   数据源注册与切换
   ========================================================= */
function sourceSummary(caps = ['quotes']) {
  try {
    const st = sourceStatus();
    return caps
      .map((key) => {
        const cap = st.capabilities.find((c) => c.key === key);
        if (!cap || !cap.active) return null;
        return `${cap.label}: ${sourceLabel(cap.active)}`;
      })
      .filter(Boolean)
      .join(' · ');
  } catch {
    return '';
  }
}

async function emSectorConstituents(code) {
  const fields = 'f2,f3,f6,f12,f13,f14,f62,f100,f184';
  const url =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=20&po=1&np=1&fltt=2&invt=2' +
    `&fid=f62&fs=b:${encodeURIComponent(code)}&fields=${fields}`;
  const json = await fetchJSON(url);
  return {
    code,
    items: (json?.data?.diff || []).map((d) => normalizeQuote(d, 'stock')),
    updatedAt: Date.now(),
  };
}

registerSource(
  'quotes',
  {
    eastmoney: (secids, group) => emQuotes(secids, group),
    tencent: (secids, group) => tencentQuotes(secids, group),
    ths: (secids, group) => thsQuotes(secids, group),
    sina: (secids, group) => sinaQuotes(secids, group),
  },
  [GROUPS.cn, 'cn'],
);

registerSource(
  'sectors',
  {
    eastmoney: (type) => emSectors(type),
    sina: (type) => sinaSectors(type),
  },
  ['industry'],
);

registerSource(
  'stockFlow',
  {
    eastmoney: (secid) => emStockFlow(secid),
    sina: (secid) => sinaStockFlow(secid),
  },
  ['1.000001'],
);

registerSource(
  'etfFlow',
  {
    eastmoney: (type, limit, category) => buildEtfFlow(type, limit, category),
  },
  ['inflow', 50, 'all'],
);

registerSource(
  'rank',
  {
    sina: (type, limit) => sinaRank(type, limit),
    eastmoney: (type, limit) => emRank(type, limit),
  },
  ['gain', 20],
);

registerSource(
  'news',
  {
    eastmoney: (limit) => emNews(limit),
    sina: (limit) => sinaNews(limit),
  },
  [40],
);

registerSource(
  'sectorDetail',
  {
    eastmoney: (code) => emSectorConstituents(code),
  },
  ['BK1036'],
);

function applySourceConfig(req, q) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const mode = body.mode || q.get('mode') || '';
  const strictRaw = body.strict !== undefined ? body.strict : q.get('strict');
  const overrides = {};
  if (body.cap && body.provider) overrides[body.cap] = body.provider;
  if (body.overrides && typeof body.overrides === 'object') Object.assign(overrides, body.overrides);
  for (const cap of SOURCE_CAPABILITIES) {
    const v = q.get(cap.key);
    if (v) overrides[cap.key] = v;
  }
  const doReset = body.reset === true || body.reset === '1' || q.get('reset') === '1';
  const patch = {};
  if (mode) {
    if (!['auto', 'eastmoney', 'tencent', 'ths', 'sina'].includes(mode)) throw new Error('不支持的数据源模式');
    patch.mode = mode;
  }
  if (strictRaw !== undefined && strictRaw !== null && strictRaw !== '') {
    patch.strict = strictRaw === true || strictRaw === '1' || strictRaw === 'true';
  }
  if (doReset) {
    patch.mode = 'auto';
    patch.strict = false;
    patch.overrides = {};
  } else if (Object.keys(overrides).length) {
    patch.overrides = overrides;
  }
  const config = saveSourceConfig(patch, { replaceOverrides: doReset });
  return { ok: true, config, status: sourceStatus() };
}

/* =========================================================
   微信定时推送（基金持仓策略）
   渠道：Server酱（方舟）/ PushPlus / 企业微信群机器人 / 自定义 webhook。
   自选基金与持仓由前端同步到 data/push-config.json；到点后由服务端
   生成当日策略并推送，不依赖浏览器是否打开。
   ========================================================= */
const pushNum = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '--');
const pushSigned = (v, d = 2) => (Number.isFinite(Number(v)) ? `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(d)}` : '--');
const PUSH_FILE = path.join(__dirname, 'data', 'push-config.json');
const PUSH_SLOT_DEFAULTS = [
  { key: 'strategy', label: '持仓策略（加仓/减仓/不变）', time: '14:30', enabled: true },
  { key: 'valuation', label: '当日基金净值/估值', time: '19:30', enabled: true },
];
const PUSH_DEFAULTS = {
  enabled: false,
  channel: 'serverchan',
  token: '',
  webhook: '',
  time: '14:30',
  weekdaysOnly: true,
  slots: PUSH_SLOT_DEFAULTS,
  funds: [],
  holdings: {},
  lastSent: {},
  lastResult: null,
};

// 兼容旧配置：单条 time + 字符串 lastSent 迁移成两个时段。
function normalizePushConfig(raw) {
  const cfg = { ...PUSH_DEFAULTS, ...(raw || {}) };
  if (!Array.isArray(cfg.slots) || !cfg.slots.length) {
    cfg.slots = PUSH_SLOT_DEFAULTS.map((s) => ({ ...s }));
    if (raw && raw.time) cfg.slots[0].time = String(raw.time).slice(0, 5);
  } else {
    cfg.slots = cfg.slots
      .filter((s) => s && s.key)
      .map((s) => {
        const def = PUSH_SLOT_DEFAULTS.find((d) => d.key === s.key) || {};
        return {
          key: String(s.key),
          label: s.label || def.label || String(s.key),
          time: /^\d{2}:\d{2}$/.test(String(s.time || '')) ? String(s.time).slice(0, 5) : (def.time || '19:30'),
          enabled: s.enabled !== false,
        };
      });
  }
  if (typeof cfg.lastSent === 'string') cfg.lastSent = {};
  if (!cfg.lastSent || typeof cfg.lastSent !== 'object' || Array.isArray(cfg.lastSent)) cfg.lastSent = {};
  return cfg;
}

function loadPushConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8'));
    return normalizePushConfig(raw);
  } catch {
    return normalizePushConfig({});
  }
}

function savePushConfig(patch = {}) {
  const next = { ...loadPushConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(PUSH_FILE), { recursive: true });
    fs.writeFileSync(PUSH_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    throw new Error(`推送配置写入失败：${err.message}`);
  }
  return next;
}

function pushChannelHint(cfg) {
  const key = String((cfg && cfg.token) || '');
  if ((cfg && cfg.channel) === 'serverchan') {
    if (/^sctp/i.test(key)) {
      return '这是 Server酱³ 的 SendKey（sctp 开头）：消息只会进「Server酱³」App，不会进微信。要微信推送，请到 sct.ftqq.com 用微信扫码换一个 SCT 开头的 Turbo SendKey。';
    }
    if (/^SCT/i.test(key)) {
      return 'Server酱Turbo（SCT）：消息按控制台「消息通道」投递，默认是微信服务号，需要关注「方糖」公众号并在 sc.ftqq.com 绑定微信。';
    }
  }
  if ((cfg && cfg.channel) === 'serverchan') return 'SendKey 通常以 SCT / sctp 开头，请检查是否粘贴完整。';
  return '';
}

function maskPushConfig(cfg) {
  const mask = (v) => (v ? `${String(v).slice(0, 4)}****${String(v).slice(-4)}` : '');
  return { ...cfg, token: mask(cfg.token), webhook: mask(cfg.webhook) };
}

function pushChannelLabel(ch) {
  return { serverchan: 'Server酱', pushplus: 'PushPlus', wecom: '企业微信群机器人', custom: '自定义 webhook' }[ch] || ch;
}

async function collectPortfolio() {
  const cfg = loadPushConfig();
  const codes = (cfg.funds || []).map((f) => f && f.code).filter(Boolean);
  if (!codes.length) throw new Error('还没有同步自选基金，请先在基金页添加自选后再试');
  const watch = await getFundWatch(codes, 'balanced');
  const today = shanghaiToday();
  const items = (watch.items || []).filter((x) => x && x.code);
  const holdings = cfg.holdings || {};
  const rows = [];
  let marketValue = 0;
  let costValue = 0;
  let dayProfit = 0;
  let dayValue = 0;
  for (const x of items) {
    const h = holdings[x.code];
    const shares = h ? Number(h.shares) : 0;
    const cost = h ? Number(h.cost) : 0;
    const price = Number(x.price);
    // 只有「今天」的涨跌才参与当日盈亏；昨天净值只留着展示，不能当成今天的。
    const fresh = Boolean(x.pctKind) && x.pctKind !== 'stale' && x.pct !== null && Number.isFinite(Number(x.pct));
    const pct = fresh ? Number(x.pct) : null;
    const held = shares > 0 && Number.isFinite(price);
    const mv = held ? price * shares : null;
    if (held) {
      marketValue += mv;
      if (cost > 0) costValue += cost * shares;
      if (pct !== null) {
        dayProfit += (mv * pct) / (100 + pct);
        dayValue += mv;
      }
    }
    rows.push({
      code: x.code,
      name: x.name || x.code,
      type: x.type || 'open',
      price: Number.isFinite(price) ? price : null,
      pct,
      pctKind: x.pctKind || (fresh ? 'nav' : 'stale'),
      pctDate: x.pctDate || x.date || '',
      pctLabel: x.pctLabel || '',
      pctNote: x.pctNote || '',
      navDate: x.navDate || x.date || '',
      navPct: Number.isFinite(Number(x.navPct)) ? Number(x.navPct) : null,
      pctStale: Boolean(x.pctStale) || !fresh,
      held,
      shares: held ? shares : 0,
      cost: cost > 0 ? cost : null,
      marketValue: mv,
      profit: held && cost > 0 ? mv - cost * shares : null,
      weight: null,
      dayProfit: held && pct !== null ? (mv * pct) / (100 + pct) : null,
      advice: x.advice || null,
      date: x.date || '',
      estimateTime: x.estimateTime || '',
      today,
    });
  }
  for (const r of rows) {
    r.weight = marketValue > 0 && r.marketValue ? (r.marketValue / marketValue) * 100 : null;
  }
  const profit = costValue > 0 ? marketValue - costValue : null;
  const profitPct = costValue > 0 ? (profit / costValue) * 100 : null;
  const portfolioPct = dayValue > 0 ? (dayProfit / dayValue) * 100 : null;
  const pendingRows = rows.filter((r) => r.pctStale);
  const heldRows = rows.filter((r) => r.held);
  return {
    cfg,
    rows,
    heldRows,
    pendingRows,
    freshRows: rows.filter((r) => !r.pctStale),
    staleHeld: heldRows.filter((r) => r.pctStale),
    totals: {
      marketValue,
      costValue,
      dayProfit,
      dayValue,
      profit,
      profitPct,
      portfolioPct,
      held: heldRows.length,
      covered: rows.filter((r) => !r.pctStale).length,
    },
    today,
  };
}

function pushTone(pct) {
  if (!Number.isFinite(Number(pct))) return '⚪';
  if (Number(pct) >= 1.5) return '🔴';
  if (Number(pct) <= -1.5) return '🟢';
  return '⚪';
}

// ---- 14:30 档：分组动作 + 具体份额 + 明日展望 ----

// 盘面与外围快照（用于明日展望）
async function collectMarketPulse() {
  try {
    const ov = await getOverview();
    const cn = ov.cn || [];
    const find = (arr, code) => (arr || []).find((q) => q && q.code === code) || null;
    const glob = ov.global || [];
    const comm = ov.commodities || [];
    const fx = ov.fx || [];
    const sh = find(cn, '000001');
    const sz = find(cn, '399001');
    const cyb = find(cn, '399006');
    const kc50 = find(cn, '000688');
    const hs300 = find(cn, '000300');
    const b = ov.breadth || {};
    const amountYi = (Number(sh && sh.amountYi) || 0) + (Number(sz && sz.amountYi) || 0);
    const mainYi = cn.reduce((acc, q) => acc + (Number(q && q.mainYi) || 0), 0);
    let ma = null;
    try {
      const k = await getKline('1.000001', 101, 30);
      const cs = (k && k.candles) || [];
      if (cs.length >= 20) {
        const closes = cs.map((c) => Number(c.c));
        const avg = (n) => closes.slice(-n).reduce((a2, v) => a2 + v, 0) / n;
        ma = { ma5: avg(5), ma20: avg(20), low: Number(cs[cs.length - 1].l), high: Number(cs[cs.length - 1].h) };
      }
    } catch { /* 均线不可用不影响推送 */ }
    return {
      sh, sz, cyb, kc50, hs300,
      breadth: b,
      amountYi,
      mainYi,
      ndx: find(glob, 'NDX'),
      spx: find(glob, 'SPX'),
      dji: find(glob, 'DJIA'),
      hsi: find(glob, 'HSI'),
      n225: find(glob, 'N225'),
      dxy: find(glob, 'UDI'),
      xau: find(comm, 'XAU'),
      oil: find(comm, 'CL00Y'),
      cnh: find(fx, 'USDCNH'),
      ma,
    };
  } catch {
    return null;
  }
}

function pushPct(v) {
  if (!Number.isFinite(Number(v))) return '--';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

// 规则化明日展望：不预测点位，只给倾向、观察点与仓位建议。
function buildOutlook(pulse) {
  if (!pulse) return { verdict: '待定', score: 0, lines: ['### 📅 明日走势预估', '- 行情快照暂不可用，明天开盘前再看一次。'] };
  const b = pulse.breadth || {};
  const adv = Number(b.up);
  const dec = Number(b.down);
  let score = 0;
  const facts = [];
  const notes = [];
  if (Number.isFinite(pulse.sh && pulse.sh.pct)) {
    facts.push(`上证 ${pushNum(pulse.sh.price, 2)}（${pushPct(pulse.sh.pct)}）`);
    if (pulse.sh.pct <= -1) score -= 1;
    if (pulse.sh.pct >= 1) score += 1;
  }
  if (Number.isFinite(pulse.sz && pulse.sz.pct)) facts.push(`深证 ${pushPct(pulse.sz.pct)}`);
  if (Number.isFinite(pulse.cyb && pulse.cyb.pct)) facts.push(`创业板 ${pushPct(pulse.cyb.pct)}`);
  if (Number.isFinite(pulse.kc50 && pulse.kc50.pct)) facts.push(`科创50 ${pushPct(pulse.kc50.pct)}`);
  if (adv && dec) {
    const ratio = adv / (adv + dec);
    facts.push(`涨跌 ${adv}:${dec}`);
    if (ratio >= 0.6) { score += 2; notes.push(`涨跌家数 ${adv}:${dec}，多头占优`); }
    else if (ratio <= 0.35) { score -= 2; notes.push(`涨跌家数 ${adv}:${dec}，赚钱效应差，反弹需要成交量配合`); }
    else notes.push(`涨跌家数 ${adv}:${dec}，多空分歧`);
  }
  if (pulse.amountYi) facts.push(`两市成交 ${pushNum(pulse.amountYi, 0)} 亿`);
  if (pulse.mainYi) {
    facts.push(`主力 ${pushSigned(pulse.mainYi, 0)} 亿`);
    if (pulse.mainYi >= 50) score += 1;
    if (pulse.mainYi <= -50) score -= 1;
  }
  const ext = [];
  const pushExt = (label, q) => {
    if (q && Number.isFinite(Number(q.pct))) ext.push(`${label} ${pushPct(q.pct)}`);
  };
  pushExt('纳指', pulse.ndx);
  pushExt('标普', pulse.spx);
  pushExt('道指', pulse.dji);
  pushExt('恒生', pulse.hsi);
  pushExt('日经', pulse.n225);
  if (pulse.dxy && Number.isFinite(Number(pulse.dxy.price))) ext.push(`美元指数 ${pushNum(pulse.dxy.price, 2)}${Number.isFinite(Number(pulse.dxy.pct)) ? `(${pushPct(pulse.dxy.pct)})` : ''}`);
  pushExt('伦敦金', pulse.xau);
  pushExt('原油', pulse.oil);
  if (pulse.cnh && Number.isFinite(Number(pulse.cnh.price))) ext.push(`离岸人民币 ${pushNum(pulse.cnh.price, 4)}`);
  if (pulse.ndx && Number.isFinite(Number(pulse.ndx.pct))) {
    if (pulse.ndx.pct <= -1.5) score -= 1;
    if (pulse.ndx.pct >= 1.5) score += 1;
  }
  if (pulse.dxy && Number.isFinite(Number(pulse.dxy.pct)) && pulse.dxy.pct >= 0.5) {
    score -= 1;
    notes.push('美元走强，压制外资与成长股');
  }
  if (pulse.xau && Number.isFinite(Number(pulse.xau.pct)) && pulse.xau.pct >= 1.5) {
    notes.push('黄金大涨，避险情绪升温');
  }
  const verdict = score >= 3 ? '偏多' : score <= -3 ? '偏空' : '震荡';
  const verdictEmoji = verdict === '偏多' ? '🟥' : verdict === '偏空' ? '🟩' : '⬜';
  const ma = pulse.ma;
  if (ma) {
    const above = Number(pulse.sh && pulse.sh.price) >= ma.ma20;
    notes.push(`上证 ${above ? '站上' : '位于'} 20 日线（${pushNum(ma.ma20, 2)}）${above ? '，趋势未破' : '，反弹仍受压制'}；当日区间 ${pushNum(ma.low, 2)}~${pushNum(ma.high, 2)}`);
  }
  const posAdvice = verdict === '偏多'
    ? '总仓位可保持 6~7 成，加仓分 2~3 批，优先低位宽基/行业 ETF'
    : verdict === '偏空'
      ? '总仓位压到 5~6 成以下，减仓优先执行，反弹再减、不追跌'
      : '总仓位维持现状，等方向选择，单日不追涨杀跌';
  const link = verdict === '偏空'
    ? '今天触发的加仓只做第一批（一半），剩余等明天确认；减仓按建议执行。'
    : verdict === '偏多'
      ? '加仓可分批执行完，减仓可放缓或只做集中度调整。'
      : '加仓减仓都按半仓执行，明天看方向再加码。';
  const lines = [
    '### 📅 明日走势预估（规则化推断，非点位预测）',
    facts.length ? `- 今日盘面：${facts.join(' ｜ ')}` : '',
    ext.length ? `- 外围隔夜：${ext.join(' ｜ ')}` : '',
    `- 倾向：${verdictEmoji} **${verdict}**（强度 ${score > 0 ? '+' : ''}${score}）`,
    notes.length ? `- 关注：${notes.map((n2, i) => `${i + 1}) ${n2}`).join('；')}` : '',
    `- 仓位建议：${posAdvice}`,
    `- 与今日动作的配合：${link}`,
  ];
  return { verdict, score, lines: lines.filter(Boolean) };
}

// 0.05 → 0.5 成，0.1 → 1 成
function chengText(ratio) {
  const c = Number(ratio) * 10;
  return `${Number.isInteger(c) ? c.toFixed(0) : c.toFixed(1)} 成`;
}

// 按份额给出具体加减仓数量（份额由用户自行在页面更新，这里只是建议）
function roundShares(shares, delta) {
  const base = Number(shares) || 0;
  const unit = base >= 10000 ? 500 : base >= 2000 ? 100 : 10;
  const v = Math.round(Math.abs(delta) / unit) * unit;
  return Math.max(unit, v);
}

// 涨跌口径的中文说明，用于推送正文里标注「这个数到底是哪天的」。
function pctKindLabel(kind) {
  return {
    nav: '今日净值',
    market: '场内实时',
    estimate: '盘中估值',
    etf: '穿透估算·ETF',
    holdings: '穿透估算·重仓',
    stale: '当日未更新',
  }[kind] || '';
}

// 只有「今天」的口径才算今日涨跌：官方净值、场内实时价，或我们自己的盘中穿透估算。
function isTodayPct(r) {
  return Boolean(r) && !r.pctStale && Number.isFinite(Number(r.pct)) && r.pctKind !== 'stale';
}

function buildStrategyReport(port, pulse, opts = {}) {
  const { rows, totals, today } = port;
  const slotTime = opts.slotTime || '14:30';
  const outlook = buildOutlook(pulse);
  const hold = [];
  const add = [];
  const cut = [];
  const pendingList = [];
  for (const r of rows) {
    if (!r.held) continue; // 未录入持仓的不进三组，避免干扰
    if (!isTodayPct(r) || !r.price) {
      pendingList.push(r);
      continue;
    }
    const av = r.advice;
    const score = av && Number.isFinite(Number(av.score)) ? Number(av.score) : null;
    const pct = r.pct;
    const src = r.pctKind === 'nav' ? '今日净值' : r.pctKind === 'market' ? '今日场内' : '今日穿透估算';
    // 1) 集中度强制减仓
    if (r.weight !== null && r.weight > 40 && totals.marketValue > 0) {
      const targetMv = totals.marketValue * 0.3;
      const targetShares = Math.floor(targetMv / r.price);
      const delta = Math.min(-10, targetShares - r.shares);
      if (delta < 0) {
        cut.push({ ...r, delta, ratioPct: (r.weight - 30), reason: `单只占比 ${r.weight.toFixed(1)}%，超过 40% 上限，建议降到 30% 左右（${pushNum(targetMv, 0)} 元）` });
        continue;
      }
    }
    if (score !== null && score >= 65 && pct <= -1.2) {
      const ratio = score >= 80 && pct <= -2 ? 0.1 : 0.05;
      const delta = roundShares(r.shares, r.marketValue * ratio / r.price);
      add.push({ ...r, delta, ratioPct: ratio * 100, reason: `技术评分 ${score} 偏多，${src} ${pct.toFixed(2)}% 回落，建议加 ${chengText(ratio)}（分 2 批）` });
      continue;
    }
    if (score !== null && score < 45 && (pct >= 0.8 || pct <= -1.2)) {
      const ratio = score < 35 ? 0.1 : 0.05;
      const delta = roundShares(r.shares, r.marketValue * ratio / r.price);
      cut.push({
        ...r,
        delta,
        ratioPct: ratio * 100,
        reason: score < 35
          ? `技术评分 ${score} 弱势，${src}${pct >= 0 ? '反弹' : '继续下跌'} ${Math.abs(pct).toFixed(2)}%，建议减 ${chengText(ratio)}`
          : `技术评分 ${score} 偏弱，${src}${pct >= 0 ? '反弹' : '下跌'} ${Math.abs(pct).toFixed(2)}%，建议减 ${chengText(ratio)}`,
      });
      continue;
    }
    hold.push({
      ...r,
      reason: av && av.rating && av.rating.label
        ? `评级「${av.rating.label}」${av.position ? `，参考仓位 ${av.position.text}` : ''}`
        : '无明确信号，保持现有仓位',
    });
  }

  const line = (r, sign) => {
    const delta = sign === 0 ? 0 : sign * r.delta;
    const target = r.shares + delta;
    const amount = Math.abs(delta) * r.price;
    const dir = delta > 0 ? '+' : delta < 0 ? '−' : '';
    return [
      `- ${r.name}（${r.code}）`,
      `  份额 ${pushNum(r.shares, 0)} → **${pushNum(target, 0)}**（${dir}${pushNum(Math.abs(delta), 0)} 份 ≈ ${pushNum(amount, 0)} 元）`,
      `  理由：${r.reason}`,
    ].join('\n');
  };

  const covered = rows.filter((r) => isTodayPct(r)).length;
  const kindCount = (k) => rows.filter((r) => r.pctKind === k).length;
  const summary = `市值 ${pushNum(totals.marketValue, 0)} 元 ｜ 今日 ${pushSigned(totals.portfolioPct, 2)}%（${pushSigned(totals.dayProfit, 0)} 元）${totals.profit === null ? '' : ` ｜ 累计 ${pushSigned(totals.profit, 0)} 元（${pushSigned(totals.profitPct, 2)}%）`}`;
  const caliber = [
    kindCount('nav') ? `今日净值 ${kindCount('nav')} 只` : '',
    kindCount('estimate') ? `盘中估值 ${kindCount('estimate')} 只` : '',
    kindCount('etf') || kindCount('holdings') ? `穿透估算 ${kindCount('etf') + kindCount('holdings')} 只` : '',
    pendingList.length ? `未更新 ${pendingList.length} 只` : '',
  ].filter(Boolean).join(' ｜ ');
  const lines = [
    `## 寰球智投 · 持仓策略（${today} ${slotTime}）`,
    '',
    summary,
    `口径：${caliber || '--'}${covered < rows.length ? '（未更新的不参与加减仓判断）' : ''}`,
    `分组：🔴 加仓 ${add.length} 只 ｜ 🟢 减仓 ${cut.length} 只 ｜ ⚪ 不变 ${hold.length} 只`,
    '',
    `### 🔴 加仓（${add.length}）`,
    ...(add.length ? add.map((r) => line(r, 1)) : ['- 今天没有触发加仓条件的基金']),
    '',
    `### 🟢 减仓（${cut.length}）`,
    ...(cut.length ? cut.map((r) => line(r, -1)) : ['- 今天没有触发减仓条件的基金']),
    '',
    `### ⚪ 不变（${hold.length}）`,
    ...(hold.length
      ? hold.map((r) => `- ${r.name}（${r.code}）${pushPct(r.pct)} ｜ ${pushNum(r.shares, 0)} 份 ｜ ${r.reason} ｜ ${pctKindLabel(r.pctKind)}`)
      : ['- 无']),
    ...(pendingList.length
      ? [
        '',
        `### ❔ 当日未更新（${pendingList.length}）`,
        ...pendingList.map((r) => `- ${r.name}（${r.code}）最新 ${r.navDate || '--'} 净值${r.navPct === null ? '' : ` ${pushPct(r.navPct)}`}${r.pctNote ? `（${r.pctNote}）` : ''} ｜ 当日涨跌还没出，本次不给动作`),
      ]
      : []),
    '',
    ...outlook.lines,
    '',
    '> 份额为建议值，需你自己在「基金 → 自选基金 → 仓」里手动更新；本工具不会自动改动持仓。',
    '> 数据口径：今日净值 > 场内实时 > 盘中穿透估算（重仓股当日涨跌 × 股票仓位）；估算与最终净值可能有偏差，仅供参考。',
  ];
  return {
    title: `${today.slice(5)} 策略·加${add.length}减${cut.length}不变${hold.length}·明日${outlook.verdict}${pendingList.length ? `·${pendingList.length}未更新` : ''}`,
    content: lines.join('\n'),
    summary,
    count: rows.length,
    pending: pendingList.length,
    groups: { add: add.length, cut: cut.length, hold: hold.length },
  };
}

// 19:30 档：只认官方净值 / 场内收盘价；没出的不给涨跌，等净值公布后再补发一条。
function buildValuationReport(port, opts = {}) {
  const { rows, totals, today } = port;
  const slotTime = opts.slotTime || '19:30';
  const official = (r) => (r.pctKind === 'nav' || r.pctKind === 'market') && Number.isFinite(Number(r.pct));
  const fresh = rows.filter(official).sort((a, b) => Number(b.pct) - Number(a.pct));
  const pending = rows.filter((r) => !official(r));
  const estRows = rows.filter((r) => (r.pctKind === 'holdings' || r.pctKind === 'etf') && Number.isFinite(Number(r.pct)));
  const officialHeld = fresh.filter((r) => r.held && r.dayProfit !== null);
  const officialMv = officialHeld.reduce((s, r) => s + r.marketValue, 0);
  const officialDp = officialHeld.reduce((s, r) => s + r.dayProfit, 0);
  const officialPct = officialMv > 0 ? (officialDp / officialMv) * 100 : null;
  const estHeld = estRows.filter((r) => r.held && r.dayProfit !== null);
  const estMv = estHeld.reduce((s, r) => s + r.marketValue, 0);
  const estDp = estHeld.reduce((s, r) => s + r.dayProfit, 0);
  const up = fresh.filter((r) => Number(r.pct) > 0).length;
  const down = fresh.filter((r) => Number(r.pct) < 0).length;
  const best = fresh[0];
  const worst = fresh[fresh.length - 1];
  const fmtPct = (v) => (Number.isFinite(Number(v)) ? `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%` : '--');

  const summary = fresh.length
    ? `已出当日净值 ${fresh.length}/${rows.length} 只 ｜ 当日盈亏 ${pushSigned(officialDp, 0)} 元（${pushSigned(officialPct, 2)}%）`
    : `当日净值还没出（0/${rows.length} 只），本条只报告已确认的数据`;

  const head = [
    `## 寰球智投 · 当日基金估值（${today} ${slotTime}）`,
    '',
    summary,
    `持有市值 ${pushNum(totals.marketValue, 0)} 元${totals.profit === null ? '' : ` ｜ 累计 ${pushSigned(totals.profit, 0)} 元（${pushSigned(totals.profitPct, 2)}%）`}`,
    fresh.length
      ? `涨 ${up} 只 / 跌 ${down} 只${best ? ` · 最强 ${best.name} ${fmtPct(best.pct)}` : ''}${worst && worst !== best ? ` · 最弱 ${worst.name} ${fmtPct(worst.pct)}` : ''}`
      : '',
    estMv > 0 ? `穿透估算参考（未确认）：${pushSigned((estDp / estMv) * 100, 2)}%，覆盖 ${estHeld.length} 只持有基金，等官方净值出来再算数` : '',
  ].filter(Boolean);

  const freshLines = fresh.map((r) => {
    const tone = pushTone(r.pct);
    const tail = r.held
      ? ` ｜ 市值 ${pushNum(r.marketValue, 0)} 元${r.dayProfit === null ? '' : ` ｜ 当日 ${pushSigned(r.dayProfit, 0)} 元`}${r.profit === null ? '' : ` ｜ 累计 ${pushSigned(r.profit, 0)} 元`}`
      : '';
    return `- ${tone} ${r.name}（${r.code}） ${fmtPct(r.pct)} ｜ ${pctKindLabel(r.pctKind)}${tail}`;
  });
  const pendingLines = pending.map((r) => {
    const last = r.navPct === null
      ? '最新净值未知'
      : `最新 ${r.navDate || '--'} 净值 ${fmtPct(r.navPct)}`;
    const tail = r.held ? ` ｜ 市值 ${pushNum(r.marketValue, 0)} 元（不计入当日盈亏）` : '';
    const note = r.pctNote ? `（${r.pctNote}）` : '';
    return `- ❔ ${r.name}（${r.code}） 当日涨跌未出 ｜ ${last}${note}${tail}`;
  });

  const lines = [
    ...head,
    '',
    `### 已出当日净值（${fresh.length}）`,
    ...(freshLines.length ? freshLines : ['- 暂无']),
    ...(pending.length
      ? ['', `### 当日未更新（${pending.length}）`, ...pendingLines]
      : []),
    '',
    '### 口径说明',
    '- 「今日净值」= 基金公司已公布的当日单位净值涨跌；「场内实时」= 场内 ETF 收盘价涨跌。这两类才是当日的真实涨跌。',
    '- 场外基金净值一般 19:00~21:00 陆续公布（QDII 更晚，常滞后一个交易日）；没公布的不显示涨跌、也不计入当日盈亏。',
    '- 净值出来之后，本工具会自动再发一条更新消息，把最新涨跌补齐。',
    '',
    '> 净值为基金公司披露口径，ETF 为场内收盘价；本工具仅做整理，不构成投资建议。',
  ];
  const title = pending.length
    ? `${today.slice(5)} 估值·${fresh.length}/${rows.length}已出`
    : `${today.slice(5)} 估值·${pushSigned(officialPct, 2)}%·${pushSigned(officialDp, 0)}元`;
  return {
    title,
    content: lines.join('\n'),
    summary,
    count: rows.length,
    pending: pending.length,
    fresh: fresh.length,
  };
}

async function buildReportForSlot(slotKey, opts = {}) {
  const port = await collectPortfolio();
  if (slotKey === 'valuation') return buildValuationReport(port, opts);
  const pulse = await collectMarketPulse();
  return buildStrategyReport(port, pulse, opts);
}

async function sendPushMessage({ title, content }) {
  const cfg = loadPushConfig();
  const channel = cfg.channel || 'serverchan';
  const timeout = 20000;
  if (channel === 'serverchan') {
    if (!cfg.token) throw new Error('请先填写 Server酱 SendKey');
    const key = String(cfg.token).trim();
    // Server酱³ 的 SendKey 形如 sctp<uid>xxx，端点与旧版不同；两种都试一次，取第一个成功的。
    const uid = (key.match(/^sctp(\d+)/i) || [])[1];
    const endpoints = [];
    if (uid) endpoints.push(`https://${uid}.push.ft07.com/send/${encodeURIComponent(key)}.send`);
    endpoints.push(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`);
    const body = new URLSearchParams({ title, desp: content });
    let lastErr = null;
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(timeout),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 视为失败 */ }
        if (!json) throw new Error(`Server酱返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
        const code = Number(json.code ?? json.errno);
        if (code !== 0) throw new Error(`${json.message || json.errmsg || 'Server酱拒绝推送'}（code=${json.code}）`);
        const pushid = json?.data?.pushid ?? null;
        return {
          ok: true,
          channel,
          pushid,
          endpoint: url.includes('push.ft07.com') ? 'serverchan3' : 'serverchan',
          message: json.message || 'SUCCESS',
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Server酱推送失败');
  }
  if (channel === 'pushplus') {
    if (!cfg.token) throw new Error('请先填写 PushPlus token');
    const res = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cfg.token, title, content, template: 'markdown' }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    if (!json) throw new Error(`PushPlus 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
    if (Number(json.code) !== 200) throw new Error(json.msg || `PushPlus 推送失败（code=${json.code}）`);
    return { ok: true, channel, pushid: json?.data || null };
  }
  if (channel === 'wecom') {
    if (!cfg.webhook) throw new Error('请先填写企业微信群机器人 webhook');
    const res = await fetch(cfg.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: `### ${title}\n${content}` } }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    if (!json) throw new Error(`企业微信返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
    if (Number(json.errcode) !== 0) throw new Error(json.errmsg || '企业微信推送失败');
    return { ok: true, channel };
  }
  if (!cfg.webhook) throw new Error('请先填写自定义 webhook 地址');
  const res = await fetch(cfg.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`自定义 webhook 返回 HTTP ${res.status}`);
  return { ok: true, channel: 'custom' };
}

// 双时段调度：14:30 推持仓策略（加仓/减仓/不变），19:30 推当日基金净值/估值。
// 电脑睡眠/关机错过时间点时，唤醒或开机后当天补发一次；错过超过 6 小时则跳过。
function pushClock(now = new Date()) {
  const sh = new Date(now.getTime() + 8 * 3600 * 1000);
  return {
    sh,
    day: sh.toISOString().slice(0, 10),
    minutes: sh.getUTCHours() * 60 + sh.getUTCMinutes(),
    weekday: sh.getUTCDay(),
  };
}

function slotMinutes(slot) {
  const [h, m] = String(slot && slot.time ? slot.time : '00:00').slice(0, 5).split(':').map((v) => Number(v) || 0);
  return h * 60 + m;
}

function dueSlots(cfg, clock) {
  if (!cfg.enabled) return [];
  if (cfg.weekdaysOnly && (clock.weekday === 0 || clock.weekday === 6)) return [];
  return (cfg.slots || []).filter((slot) => {
    if (!slot || slot.enabled === false) return false;
    if ((cfg.lastSent || {})[slot.key] === clock.day) return false;
    return clock.minutes >= slotMinutes(slot);
  });
}

async function handleDueSlot(cfg, slot, clock) {
  const late = clock.minutes - slotMinutes(slot);
  if (late > 360) {
    const fresh = loadPushConfig();
    savePushConfig({ lastSent: { ...(fresh.lastSent || {}), [slot.key]: clock.day } });
    console.log(`[push] ${slot.key} skipped for ${clock.day}: missed by ${late}min`);
    return;
  }
  try {
    const report = await buildReportForSlot(slot.key);
    if (late > 3) {
      report.title = `${report.title}（补发）`;
      report.content = `> 电脑睡眠或关机错过了计划时间，本消息为当天补发。\n\n${report.content}`;
    }
    const sent = await sendPushMessage(report);
    const after = loadPushConfig();
    const patch = {
      lastSent: { ...(after.lastSent || {}), [slot.key]: clock.day },
      lastResult: {
        ok: true,
        at: Date.now(),
        slot: slot.key,
        label: slot.label || slot.key,
        summary: report.summary,
        pushid: (sent && sent.pushid) || null,
        endpoint: (sent && (sent.endpoint || sent.channel)) || '',
        late: late > 3 ? late : 0,
      },
    };
    // 估值这条如果还有基金当日净值没出，记下来，等净值公布后再补一条更新。
    if (slot.key === 'valuation') {
      patch.followUp = {
        day: clock.day,
        pending: Number(report.pending) || 0,
        updates: 0,
        lastAt: Date.now(),
      };
    }
    savePushConfig(patch);
    console.log(`[push] ${slot.key} sent for ${clock.day}${late > 3 ? ` (catch-up, late ${late}min)` : ''}${sent && sent.pushid ? ` pushid=${sent.pushid}` : ''}${slot.key === 'valuation' ? ` pending=${Number(report.pending) || 0}` : ''}`);
  } catch (err) {
    savePushConfig({
      lastResult: { ok: false, at: Date.now(), slot: slot.key, label: slot.label || slot.key, error: err.message },
    });
    console.log(`[push] ${slot.key} failed: ${String(err.message || err)}`);
  }
}

const FOLLOWUP_MAX_UPDATES = 3;
const FOLLOWUP_GAP_MS = 10 * 60 * 1000;
const FOLLOWUP_END_MINUTES = 23 * 60 + 40;

// 净值陆续公布后，把「当日基金估值」补一条更新（最多 3 条，直到全部出齐）。
async function runValuationFollowUp(clock) {
  const cfg = loadPushConfig();
  if (!cfg.enabled) return;
  const fu = cfg.followUp;
  if (!fu || fu.day !== clock.day) return;
  if (!Number(fu.pending)) return; // 上次已经出齐
  if ((fu.updates || 0) >= FOLLOWUP_MAX_UPDATES) return;
  if (Date.now() - (Number(fu.lastAt) || 0) < FOLLOWUP_GAP_MS) return;
  if (clock.minutes > FOLLOWUP_END_MINUTES) return;
  const slot = (cfg.slots || []).find((x) => x.key === 'valuation');
  if (!slot || slot.enabled === false) return;
  if ((cfg.lastSent || {}).valuation !== clock.day) return;
  if (clock.minutes < slotMinutes(slot) + 5) return;
  let report;
  try {
    report = await buildReportForSlot('valuation', { slotTime: slot.time });
  } catch {
    return;
  }
  const pendingNow = Number(report.pending) || 0;
  if (pendingNow >= Number(fu.pending)) {
    // 还没有新净值出来，只更新时间戳，避免反复重建。
    savePushConfig({ followUp: { ...fu, lastAt: Date.now() } });
    return;
  }
  const prevPending = Number(fu.pending) || 0;
  report.title = `${report.title}·净值更新`;
  report.content = `> 有新的净值公布，这是「当日基金净值/估值」的补充更新：未更新数量 ${prevPending} → ${pendingNow}。\n\n${report.content}`;
  try {
    const sent = await sendPushMessage(report);
    savePushConfig({
      followUp: { day: clock.day, pending: pendingNow, updates: (Number(fu.updates) || 0) + 1, lastAt: Date.now() },
      lastResult: {
        ok: true,
        at: Date.now(),
        slot: 'valuation',
        label: '当日基金净值/估值（更新）',
        summary: report.summary,
        pushid: (sent && sent.pushid) || null,
        endpoint: (sent && (sent.endpoint || sent.channel)) || '',
        late: 0,
      },
    });
    console.log(`[push] valuation follow-up sent for ${clock.day}: pending ${prevPending} -> ${pendingNow}`);
  } catch (err) {
    savePushConfig({ followUp: { ...fu, lastAt: Date.now() } });
    console.log(`[push] valuation follow-up failed: ${String(err.message || err)}`);
  }
}

async function runPushTick() {
  const cfg = loadPushConfig();
  const clock = pushClock();
  const due = dueSlots(cfg, clock);
  for (const slot of due) {
    await handleDueSlot(cfg, slot, clock);
  }
  if (!due.length) {
    await runValuationFollowUp(clock);
  }
}

async function handlePushApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  if (p === '/api/push/config' && req.method === 'GET') {
    // 2026-11-15：推送属于全局配置，已移到后台管理，普通用户不可读。
    requireAdmin(req);
    const cfg = loadPushConfig();
    return {
      ok: true,
      config: maskPushConfig(cfg),
      channelLabel: pushChannelLabel(cfg.channel),
      hint: pushChannelHint(cfg),
      slots: cfg.slots,
    };
  }
  if (p === '/api/push/config' && req.method === 'POST') {
    // 推送配置是全局的（消息发到同一个微信），只有管理员能改，避免其它账号覆盖。
    requireAdmin(req);
    const body = req.body || {};
    const patch = {};
    for (const key of ['enabled', 'channel', 'token', 'webhook', 'weekdaysOnly', 'funds', 'holdings']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.time && /^\d{2}:\d{2}$/.test(String(body.time))) patch.time = String(body.time).slice(0, 5);
    if (Array.isArray(body.slots)) {
      const slots = body.slots
        .filter((x) => x && x.key)
        .map((x) => ({
          key: String(x.key),
          label: String(x.label || '').slice(0, 40),
          time: /^\d{2}:\d{2}$/.test(String(x.time || '')) ? String(x.time).slice(0, 5) : '19:30',
          enabled: x.enabled !== false,
        }));
      if (!slots.length) throw new Error('至少要保留一个推送时段');
      patch.slots = slots;
    }
    if (patch.channel && !['serverchan', 'pushplus', 'wecom', 'custom'].includes(patch.channel)) {
      throw new Error('不支持的推送渠道');
    }
    if (body.time && patch.time === undefined) throw new Error('推送时间格式应为 HH:MM');
    const next = savePushConfig(patch);
    return { ok: true, config: maskPushConfig(next), slots: next.slots };
  }
  if (p === '/api/push/sync' && req.method === 'POST') {
    // 兼容旧前端：自选基金/持仓仍可从这里同步，但必须落到当前账号名下，
    // 不能像以前那样直接写全局 push-config（否则任何账号都会覆盖主账号的推送数据）。
    const user = currentUser(req);
    if (!user) throw Object.assign(new Error('未登录'), { status: 401 });
    const body = req.body || {};
    const cleaned = sanitizePortfolio(body);
    const current = loadPortfolio(user);
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    savePortfolio(user, {
      funds: has('funds') ? cleaned.funds : current.funds,
      holdings: has('holdings') ? cleaned.holdings : current.holdings,
      watchlist: current.watchlist,
    });
    return { ok: true, funds: (has('funds') ? cleaned.funds : current.funds).length };
  }
  if (p === '/api/push/preview') {
    requireAdmin(req);
    const slotKey = q.get('slot') === 'valuation' ? 'valuation' : 'strategy';
    const pcfg = loadPushConfig();
    const pslot = (pcfg.slots || []).find((x) => x.key === slotKey) || {};
    const report = await buildReportForSlot(slotKey, { slotTime: pslot.time });
    return { ok: true, slot: slotKey, ...report };
  }
  if (p === '/api/push/test' && req.method === 'POST') {
    // 允许把当前表单值一起带上来，避免「改了密钥但没点保存就直接测试」。
    requireAdmin(req);
    const body = req.body || {};
    const patch = {};
    for (const key of ['channel', 'token', 'webhook', 'enabled']) {
      if (body[key] !== undefined && body[key] !== '') patch[key] = body[key];
    }
    if (Array.isArray(body.slots) && body.slots.length) {
      patch.slots = body.slots
        .filter((x) => x && x.key)
        .map((x) => ({
          key: String(x.key),
          label: String(x.label || '').slice(0, 40),
          time: /^\d{2}:\d{2}$/.test(String(x.time || '')) ? String(x.time).slice(0, 5) : '19:30',
          enabled: x.enabled !== false,
        }));
    }
    if (Object.keys(patch).length) savePushConfig(patch);
    const slot = body.slot === 'valuation' ? 'valuation' : 'strategy';
    const tcfg = loadPushConfig();
    const tslot = (tcfg.slots || []).find((x) => x.key === slot) || {};
    const report = await buildReportForSlot(slot, { slotTime: tslot.time });
    const sent = await sendPushMessage(report);
    const clock = pushClock();
    const cfg = loadPushConfig();
    savePushConfig({
      lastResult: {
        ok: true,
        at: Date.now(),
        slot,
        label: (cfg.slots || []).find((x) => x.key === slot)?.label || slot,
        summary: report.summary,
        pushid: sent.pushid || null,
        endpoint: sent.endpoint || sent.channel || '',
      },
      lastSent: { ...(cfg.lastSent || {}), [slot]: clock.day },
    });
    return { ok: true, sent, slot, title: report.title, pushid: sent.pushid || null, hint: pushChannelHint(loadPushConfig()) };
  }
  if (p === '/api/push/run' && req.method === 'POST') {
    requireAdmin(req);
    await runPushTick();
    return { ok: true, lastResult: loadPushConfig().lastResult, slots: loadPushConfig().slots };
  }
  const err = new Error('未知接口');
  err.status = 404;
  throw err;
}

/* =========================================================
   账号体系：注册 / 登录 / 会话
   - data/users.json         账号表（scrypt 加盐哈希，不存明文密码）
   - data/sessions.json      会话 token（30 天，重启不掉线）
   - data/userdata/<id>.json 每个账号自己的自选基金与持仓
   第一个注册的账号是主账号：它的持仓同时镜像到 data/push-config.json，
   保证 14:30 / 19:30 的推送用的持仓与页面看到的一致；后注册的账号数据互相隔离。
   ========================================================= */
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
const USERDATA_DIR = path.join(__dirname, 'data', 'userdata');
const SESSION_COOKIE = 'gp_sid';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_FAIL_WINDOW = 10 * 60 * 1000;
const loginFails = new Map();
// 不需要登录就能访问的接口：登录页本身、健康检查。
const PUBLIC_API = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/password',
  '/api/health',
]);
// 角色等级：super（超级管理员）> admin（管理员）> user（普通用户）
const ROLE_RANK = { user: 0, admin: 1, super: 2 };

function roleOf(user) {
  if (!user) return 'user';
  if (user.role === 'super' || user.role === 'admin' || user.role === 'user') return user.role;
  return user.primary ? 'admin' : 'user';
}

function isAdminUser(user) {
  return ROLE_RANK[roleOf(user)] >= ROLE_RANK.admin;
}

function isSuperUser(user) {
  return roleOf(user) === 'super';
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadUsers() {
  const store = readJsonSafe(USERS_FILE, { users: [] });
  if (!store || !Array.isArray(store.users)) return { users: [] };
  // 兼容旧数据：没有 role 字段时，主账号视为管理员、其余为普通用户，并落盘一次。
  let migrated = false;
  for (const user of store.users) {
    if (user.role !== 'super' && user.role !== 'admin' && user.role !== 'user') {
      user.role = user.primary ? 'admin' : 'user';
      migrated = true;
    }
  }
  if (migrated) saveUsers(store);
  return store;
}

function saveUsers(store) {
  writeJsonSafe(USERS_FILE, store);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function verifyPassword(password, salt, hash) {
  const got = Buffer.from(hashPassword(password, salt), 'hex');
  const want = Buffer.from(String(hash || ''), 'hex');
  if (!got.length || got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

function loadSessions() {
  const store = readJsonSafe(SESSIONS_FILE, {});
  return store && typeof store === 'object' && !Array.isArray(store) ? store : {};
}

function saveSessions(store) {
  writeJsonSafe(SESSIONS_FILE, store);
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[key] = part.slice(i + 1).trim();
    }
  }
  return out;
}

// 没有任何会话令牌时返回 null；过期会话顺手清掉。
function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session || !session.userId) return null;
  if (!(Number(session.expiresAt) > Date.now())) {
    delete sessions[token];
    saveSessions(sessions);
    return null;
  }
  const user = loadUsers().users.find((u) => u.id === session.userId);
  return user || null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    primary: !!user.primary,
    role: roleOf(user),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    loginCount: Number(user.loginCount) || 0,
  };
}

// 需要管理员权限的接口统一用这个校验（admin / super 都通过）
function requireAdmin(req) {
  const user = currentUser(req);
  if (!user) throw Object.assign(new Error('未登录'), { status: 401 });
  if (!isAdminUser(user)) throw Object.assign(new Error('需要管理员权限'), { status: 403 });
  return user;
}

// 只有超级管理员（以及超级管理员创建的 admin）能进入的后台能力用这个
function requireSuper(req) {
  const user = currentUser(req);
  if (!user) throw Object.assign(new Error('未登录'), { status: 401 });
  if (!isSuperUser(user)) throw Object.assign(new Error('需要超级管理员权限'), { status: 403 });
  return user;
}

// 改密码 / 强制下线后，让该账号所有旧会话立即失效。
function invalidateUserSessions(userId) {
  const sessions = loadSessions();
  let changed = false;
  for (const [token, session] of Object.entries(sessions)) {
    if (session && session.userId === userId) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) saveSessions(sessions);
  return changed;
}

function issueSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  const now = Date.now();
  for (const [k, v] of Object.entries(sessions)) {
    if (!v || !(Number(v.expiresAt) > now)) delete sessions[k];
  }
  sessions[token] = { userId: user.id, expiresAt: now + SESSION_TTL, createdAt: now };
  saveSessions(sessions);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
  );
}

function dropSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const sessions = loadSessions();
    delete sessions[token];
    saveSessions(sessions);
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function userDataFile(userId) {
  return path.join(USERDATA_DIR, `${String(userId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

function loadPortfolio(user) {
  if (!user) return { funds: [], holdings: {}, watchlist: [] };
  const data = readJsonSafe(userDataFile(user.id), null);
  const watchlist = data && Array.isArray(data.watchlist) ? data.watchlist : [];
  // 主账号的自选基金与持仓直接读推送配置：推送和页面永远是同一份。
  if (user.primary) {
    const cfg = loadPushConfig();
    return { funds: cfg.funds || [], holdings: cfg.holdings || {}, watchlist };
  }
  return {
    funds: (data && Array.isArray(data.funds) && data.funds) || [],
    holdings: (data && data.holdings && typeof data.holdings === 'object' && !Array.isArray(data.holdings))
      ? data.holdings
      : {},
    watchlist,
  };
}

function savePortfolio(user, portfolio) {
  const payload = {
    funds: Array.isArray(portfolio.funds) ? portfolio.funds : [],
    holdings: portfolio.holdings && typeof portfolio.holdings === 'object' && !Array.isArray(portfolio.holdings)
      ? portfolio.holdings
      : {},
    watchlist: Array.isArray(portfolio.watchlist) ? portfolio.watchlist : [],
    updatedAt: Date.now(),
  };
  if (user.primary) savePushConfig({ funds: payload.funds, holdings: payload.holdings });
  writeJsonSafe(userDataFile(user.id), payload);
}

// 自选股票 / 自选基金 / 持仓的统一清洗：前端传什么都在这里收敛，避免脏数据落盘。
function sanitizePortfolio(body) {
  const funds = Array.isArray(body && body.funds)
    ? body.funds
        .slice(0, 30)
        .map((f) => ({
          code: String((f && f.code) || ''),
          name: String((f && f.name) || ''),
          type: f && f.type === 'etf' ? 'etf' : 'open',
        }))
        .filter((f) => f.code)
    : [];
  const holdings = {};
  if (body && body.holdings && typeof body.holdings === 'object' && !Array.isArray(body.holdings)) {
    for (const [code, v] of Object.entries(body.holdings)) {
      const shares = Number(v && v.shares);
      if (!String(code) || !Number.isFinite(shares) || shares <= 0) continue;
      holdings[String(code)] = { shares, cost: Number(v && v.cost) || 0 };
    }
  }
  const watchlist = Array.isArray(body && body.watchlist)
    ? body.watchlist
        .slice(0, 200)
        .map((w) => ({
          secid: String((w && w.secid) || ''),
          code: String((w && w.code) || ''),
          name: String((w && w.name) || '').slice(0, 40),
        }))
        .filter((w) => w.secid)
    : [];
  return { funds, holdings, watchlist };
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* =========================================================
   使用统计（2026-11-15）
   - data/stats.json：按天 × 账号记录请求数、字节流量、使用时长、页面访问
   - 登录 / 改密 / 强制下线等事件记在 logins（最多 2000 条）
   - 写入是防抖的：请求只改内存，3 秒后落盘，避免每请求写文件
   ========================================================= */
const STATS_FILE = path.join(__dirname, 'data', 'stats.json');
const STATS_KEEP_DAYS = 120;
const STATS_LOGIN_LIMIT = 2000;
const STATS_ONLINE_WINDOW = 5 * 60 * 1000;

function shanghaiDateKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }
}

function lastDateKeys(days) {
  const count = Math.max(1, Math.min(STATS_KEEP_DAYS, Number(days) || 7));
  const out = [];
  const now = Date.now();
  for (let i = count - 1; i >= 0; i -= 1) out.push(shanghaiDateKey(new Date(now - i * 86400000)));
  return out;
}

function loadStatsStore() {
  const raw = readJsonSafe(STATS_FILE, { days: {}, logins: [] });
  const store = { days: {}, logins: [] };
  if (raw && raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) store.days = raw.days;
  if (raw && Array.isArray(raw.logins)) store.logins = raw.logins;
  const keep = new Set(lastDateKeys(STATS_KEEP_DAYS));
  for (const key of Object.keys(store.days)) {
    if (!keep.has(key)) delete store.days[key];
  }
  if (store.logins.length > STATS_LOGIN_LIMIT) store.logins = store.logins.slice(-STATS_LOGIN_LIMIT);
  return store;
}

const statsStore = loadStatsStore();
let statsFlushTimer = null;

function flushStats() {
  if (statsFlushTimer) {
    clearTimeout(statsFlushTimer);
    statsFlushTimer = null;
  }
  try {
    writeJsonSafe(STATS_FILE, statsStore);
  } catch (err) {
    console.error('[STATS] 写入失败', err.message);
  }
}

function scheduleStatsSave() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => {
    statsFlushTimer = null;
    try { writeJsonSafe(STATS_FILE, statsStore); } catch { /* 下次再写 */ }
  }, 3000);
}

function ensureStat(dayKey, user, req) {
  if (!user || !user.id) return null;
  if (!statsStore.days[dayKey] || typeof statsStore.days[dayKey] !== 'object') statsStore.days[dayKey] = {};
  let entry = statsStore.days[dayKey][user.id];
  if (!entry || typeof entry !== 'object') {
    entry = { username: user.username || '', requests: 0, api: 0, assets: 0, bytes: 0, activeMs: 0, firstSeen: Date.now(), lastSeen: 0, logins: 0, views: {}, ips: {}, ua: '' };
    statsStore.days[dayKey][user.id] = entry;
  }
  entry.username = user.username || entry.username || '';
  if (req) {
    const ua = String(req.headers['user-agent'] || '').slice(0, 180);
    if (ua) entry.ua = ua;
    const ip = clientIp(req);
    entry.ips[ip] = (Number(entry.ips[ip]) || 0) + 1;
  }
  return entry;
}

function recordTraffic(req, bytes, kind) {
  const user = req && req.gpUser;
  const size = Number(bytes) || 0;
  if (!user || size <= 0) return;
  const entry = ensureStat(shanghaiDateKey(), user, req);
  if (!entry) return;
  const isPing = String(req.gpPath || '') === '/api/activity/ping';
  if (!isPing) {
    entry.requests += 1;
    if (kind === 'api') entry.api += 1;
    else entry.assets += 1;
  }
  entry.bytes += size;
  entry.lastSeen = Date.now();
  scheduleStatsSave();
}

function recordLoginEvent(req, { user = null, username = '', ok = false, action = 'login', reason = '' } = {}) {
  statsStore.logins.push({
    at: Date.now(),
    userId: user ? user.id : null,
    username: username || (user && user.username) || '',
    ok: !!ok,
    action,
    reason: String(reason || '').slice(0, 120),
    ip: req ? clientIp(req) : '',
    ua: String((req && req.headers['user-agent']) || '').slice(0, 180),
  });
  if (statsStore.logins.length > STATS_LOGIN_LIMIT) statsStore.logins = statsStore.logins.slice(-STATS_LOGIN_LIMIT);
  if (user && ok && action === 'login') {
    const entry = ensureStat(shanghaiDateKey(), user, req);
    if (entry) entry.logins += 1;
  }
  scheduleStatsSave();
}

function recordViewPing(req, user, view, activeSec, event) {
  const entry = ensureStat(shanghaiDateKey(), user, req);
  if (!entry) return;
  entry.lastSeen = Date.now();
  const sec = Math.max(0, Math.min(180, Number(activeSec) || 0));
  if (sec) entry.activeMs += sec * 1000;
  const page = String(view || '').slice(0, 32);
  if (event === 'view' && page) entry.views[page] = (Number(entry.views[page]) || 0) + 1;
  scheduleStatsSave();
}

function statsForDayUser(dayKey, userId) {
  const day = statsStore.days[dayKey];
  return (day && day[userId]) || null;
}

function userStatsSummary(userId, days) {
  const out = { days: 0, requests: 0, bytes: 0, activeMs: 0, logins: 0, lastSeen: 0, views: {} };
  const keys = lastDateKeys(days);
  out.days = keys.length;
  for (const key of keys) {
    const entry = statsForDayUser(key, userId);
    if (!entry) continue;
    out.requests += Number(entry.requests) || 0;
    out.bytes += Number(entry.bytes) || 0;
    out.activeMs += Number(entry.activeMs) || 0;
    out.logins += Number(entry.logins) || 0;
    out.lastSeen = Math.max(out.lastSeen, Number(entry.lastSeen) || 0);
    for (const [view, count] of Object.entries(entry.views || {})) {
      out.views[view] = (Number(out.views[view]) || 0) + (Number(count) || 0);
    }
  }
  return out;
}

function topIpOf(entry) {
  const ips = Object.entries((entry && entry.ips) || {});
  if (!ips.length) return '';
  ips.sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
  return ips[0][0];
}

function handleAuth(req, res, url) {
  const p = url.pathname;
  if (p === '/api/auth/me') {
    const user = currentUser(req);
    return { ok: true, user: user ? publicUser(user) : null };
  }
  if (p === '/api/auth/register') {
    if (req.method !== 'POST') throw Object.assign(new Error('方法不允许'), { status: 405 });
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!/^[\w\u4e00-\u9fa5.-]{3,20}$/.test(username)) {
      throw Object.assign(new Error('用户名需为 3-20 位中文、字母、数字、下划线、点或横线'), { status: 400 });
    }
    if (password.length < 6 || password.length > 64) {
      throw Object.assign(new Error('密码长度需为 6-64 位'), { status: 400 });
    }
    const store = loadUsers();
    if (store.users.some((u) => String(u.username).toLowerCase() === username.toLowerCase())) {
      throw Object.assign(new Error('该用户名已被注册'), { status: 409 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: `u${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      username,
      salt,
      hash: hashPassword(password, salt),
      primary: store.users.length === 0,
      role: store.users.length === 0 ? 'admin' : 'user',
      createdAt: new Date().toISOString(),
    };
    store.users.push(user);
    saveUsers(store);
    // 主账号沿用推送配置里的持仓；其它账号从空白开始。
    if (!user.primary) writeJsonSafe(userDataFile(user.id), { funds: [], holdings: {}, updatedAt: Date.now() });
    issueSession(req, res, user);
    recordLoginEvent(req, { user, ok: true, action: 'register' });
    return { ok: true, user: publicUser(user) };
  }
  if (p === '/api/auth/login') {
    if (req.method !== 'POST') throw Object.assign(new Error('方法不允许'), { status: 405 });
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const ip = clientIp(req);
    const fail = loginFails.get(ip);
    if (fail && Number(fail.until) > Date.now()) {
      const mins = Math.ceil((fail.until - Date.now()) / 60000);
      throw Object.assign(new Error(`尝试次数过多，请 ${mins} 分钟后再试`), { status: 429 });
    }
    const store = loadUsers();
    const user = store.users.find((u) => String(u.username).toLowerCase() === username.toLowerCase());
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      const fresh = fail && fail.since > Date.now() - LOGIN_FAIL_WINDOW ? fail : { count: 0, since: Date.now() };
      fresh.count = Number(fresh.count || 0) + 1;
      fresh.until = fresh.count >= LOGIN_FAIL_LIMIT ? Date.now() + LOGIN_FAIL_WINDOW : 0;
      loginFails.set(ip, fresh);
      recordLoginEvent(req, { user: user || null, username, ok: false, action: 'login', reason: '用户名或密码错误' });
      throw Object.assign(new Error('用户名或密码错误'), { status: 401 });
    }
    loginFails.delete(ip);
    user.lastLoginAt = new Date().toISOString();
    user.lastLoginIp = ip;
    user.loginCount = (Number(user.loginCount) || 0) + 1;
    saveUsers(store);
    issueSession(req, res, user);
    recordLoginEvent(req, { user, ok: true, action: 'login' });
    return { ok: true, user: publicUser(user) };
  }
  // 登录页的「修改密码」：校验旧密码后重设，并让该账号所有旧会话失效。
  if (p === '/api/auth/password') {
    if (req.method !== 'POST') throw Object.assign(new Error('方法不允许'), { status: 405 });
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const oldPassword = String(body.oldPassword || '');
    const newPassword = String(body.newPassword || '');
    const ip = clientIp(req);
    const fail = loginFails.get(ip);
    if (fail && Number(fail.until) > Date.now()) {
      const mins = Math.ceil((fail.until - Date.now()) / 60000);
      throw Object.assign(new Error(`尝试次数过多，请 ${mins} 分钟后再试`), { status: 429 });
    }
    if (!username) throw Object.assign(new Error('请填写用户名'), { status: 400 });
    if (newPassword.length < 6 || newPassword.length > 64) {
      throw Object.assign(new Error('新密码长度需为 6-64 位'), { status: 400 });
    }
    const store = loadUsers();
    const user = store.users.find((u) => String(u.username).toLowerCase() === username.toLowerCase());
    if (!user || !verifyPassword(oldPassword, user.salt, user.hash)) {
      const fresh = fail && fail.since > Date.now() - LOGIN_FAIL_WINDOW ? fail : { count: 0, since: Date.now() };
      fresh.count = Number(fresh.count || 0) + 1;
      fresh.until = fresh.count >= LOGIN_FAIL_LIMIT ? Date.now() + LOGIN_FAIL_WINDOW : 0;
      loginFails.set(ip, fresh);
      recordLoginEvent(req, { user: user || null, username, ok: false, action: 'password', reason: '原密码不正确' });
      throw Object.assign(new Error('用户名或原密码不正确'), { status: 401 });
    }
    if (verifyPassword(newPassword, user.salt, user.hash)) {
      throw Object.assign(new Error('新密码不能与原密码相同'), { status: 400 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    user.salt = salt;
    user.hash = hashPassword(newPassword, salt);
    user.updatedAt = new Date().toISOString();
    saveUsers(store);
    invalidateUserSessions(user.id);
    loginFails.delete(ip);
    recordLoginEvent(req, { user, ok: true, action: 'password' });
    return { ok: true, username: user.username };
  }
  if (p === '/api/auth/logout') {
    dropSession(req, res);
    return { ok: true };
  }
  throw Object.assign(new Error('未知接口'), { status: 404 });
}

/* ---------------------------------------------------------
   管理员接口：用户与权限、系统（NAS）状态、版本履历
   --------------------------------------------------------- */
function shellOut(cmd, timeout = 6000) {
  return new Promise((resolve) => {
    try {
      exec(cmd, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve(String(stdout || '').trim());
      });
    } catch {
      resolve('');
    }
  });
}

async function getSystemStatus() {
  const status = {
    platform: process.platform,
    version: VERSION,
    uptime: Math.round(process.uptime()),
    repo: 'https://github.com/ufomhb/GP_Software',
    services: {},
    timers: {},
    disk: '',
    backups: [],
    deployedAt: null,
  };
  try {
    status.deployedAt = fs.statSync(path.join(__dirname, 'server.js')).mtime.toISOString();
  } catch {
    status.deployedAt = null;
  }
  if (process.platform !== 'linux') return status;
  for (const name of ['gp-terminal', 'gp-tunnel', 'gp-root-shell', 'dockerctl']) {
    status.services[name] = (await shellOut(`systemctl is-active ${name}`)) || 'unknown';
  }
  for (const name of ['gp-plugin-keep.timer', 'gp-data-backup.timer']) {
    status.timers[name] = (await shellOut(`systemctl is-active ${name}`)) || 'unknown';
  }
  status.disk = await shellOut('df -h /data 2>/dev/null | tail -1');
  status.backups = (await shellOut('ls -1t /data/backup/gp-data/data-*.tar.gz 2>/dev/null | head -7'))
    .split('\n')
    .filter(Boolean)
    .map((item) => item.split('/').pop());
  return status;
}

async function handleAdmin(req, res, url) {
  const actor = requireAdmin(req);
  const actorRank = ROLE_RANK[roleOf(actor)];
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/admin/users' && req.method === 'GET') {
    const todayKey = shanghaiDateKey();
    const cutoff = Date.now() - STATS_ONLINE_WINDOW;
    const users = loadUsers().users
      .map((u) => {
        const today = statsForDayUser(todayKey, u.id);
        const week = userStatsSummary(u.id, 7);
        return {
          ...publicUser(u),
          lastLoginIp: u.lastLoginIp || '',
          today: today
            ? {
                requests: Number(today.requests) || 0,
                bytes: Number(today.bytes) || 0,
                activeMs: Number(today.activeMs) || 0,
                logins: Number(today.logins) || 0,
                lastSeen: Number(today.lastSeen) || 0,
                ip: topIpOf(today),
              }
            : null,
          week,
          online: Boolean(today && Number(today.lastSeen) > cutoff),
        };
      })
      .sort((a, b) => {
        if (a.primary !== b.primary) return a.primary ? -1 : 1;
        if (a.role !== b.role) return ROLE_RANK[b.role] - ROLE_RANK[a.role];
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });
    return { ok: true, users, onlineWindowSec: STATS_ONLINE_WINDOW / 1000 };
  }

  if (p === '/api/admin/users/role' && req.method === 'POST') {
    const body = req.body || {};
    const id = String(body.id || '');
    const nextRole = ['user', 'admin', 'super'].includes(String(body.role)) ? String(body.role) : 'user';
    const store = loadUsers();
    const target = store.users.find((u) => u.id === id);
    if (!target) throw Object.assign(new Error('用户不存在'), { status: 404 });
    const targetRole = roleOf(target);
    if (target.id === actor.id) throw Object.assign(new Error('不能修改自己的角色'), { status: 400 });
    if (targetRole === 'super' && actorRank < ROLE_RANK.super) {
      throw Object.assign(new Error('只有超级管理员可以修改超级管理员'), { status: 403 });
    }
    if (nextRole === 'super' && actorRank < ROLE_RANK.super) {
      throw Object.assign(new Error('只有超级管理员可以授予超级管理员'), { status: 403 });
    }
    if (target.primary && nextRole === 'user') {
      throw Object.assign(new Error('主账号必须保留管理员权限'), { status: 400 });
    }
    const admins = store.users.filter((u) => ROLE_RANK[roleOf(u)] >= ROLE_RANK.admin).length;
    if (ROLE_RANK[targetRole] >= ROLE_RANK.admin && ROLE_RANK[nextRole] < ROLE_RANK.admin && admins <= 1) {
      throw Object.assign(new Error('至少要保留一个管理员'), { status: 400 });
    }
    const supers = store.users.filter((u) => roleOf(u) === 'super').length;
    if (targetRole === 'super' && nextRole !== 'super' && supers <= 1) {
      throw Object.assign(new Error('至少要保留一个超级管理员'), { status: 400 });
    }
    target.role = nextRole;
    target.updatedAt = new Date().toISOString();
    saveUsers(store);
    recordLoginEvent(req, { user: actor, ok: true, action: 'role', reason: `${target.username}: ${targetRole} -> ${nextRole}` });
    return { ok: true, user: { id: target.id, username: target.username, role: nextRole } };
  }

  // 管理员重置某个用户的密码（不需要旧密码）；重置后该用户所有会话失效。
  if (p === '/api/admin/users/password' && req.method === 'POST') {
    const body = req.body || {};
    const id = String(body.id || '');
    const password = String(body.password || '');
    if (password.length < 6 || password.length > 64) {
      throw Object.assign(new Error('密码长度需为 6-64 位'), { status: 400 });
    }
    const store = loadUsers();
    const target = store.users.find((u) => u.id === id);
    if (!target) throw Object.assign(new Error('用户不存在'), { status: 404 });
    const targetRank = ROLE_RANK[roleOf(target)];
    if (targetRank >= actorRank && !isSuperUser(actor)) {
      throw Object.assign(new Error('不能重置同级或更高级别用户的密码'), { status: 403 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    target.salt = salt;
    target.hash = hashPassword(password, salt);
    target.updatedAt = new Date().toISOString();
    saveUsers(store);
    invalidateUserSessions(target.id);
    recordLoginEvent(req, { user: actor, ok: true, action: 'reset', reason: `重置 ${target.username} 的密码` });
    return { ok: true, id: target.id, username: target.username };
  }

  // 强制下线：清掉该用户全部会话（不删账号）。
  if (p === '/api/admin/users/kick' && req.method === 'POST') {
    const body = req.body || {};
    const id = String(body.id || '');
    const target = loadUsers().users.find((u) => u.id === id);
    if (!target) throw Object.assign(new Error('用户不存在'), { status: 404 });
    const targetRank = ROLE_RANK[roleOf(target)];
    if (targetRank >= actorRank && !isSuperUser(actor)) {
      throw Object.assign(new Error('不能强制同级或更高级别用户下线'), { status: 403 });
    }
    const changed = invalidateUserSessions(target.id);
    recordLoginEvent(req, { user: actor, ok: true, action: 'kick', reason: `强制下线 ${target.username}` });
    return { ok: true, username: target.username, sessions: changed };
  }

  // 概览：今日汇总 + 最近 N 天曲线 + 当前在线 + 最近登录事件
  if (p === '/api/admin/overview' && req.method === 'GET') {
    const days = Math.max(1, Math.min(30, Number(q.get('days') || 14)));
    const keys = lastDateKeys(days);
    const series = keys.map((date) => {
      const day = statsStore.days[date] || {};
      let requests = 0;
      let bytes = 0;
      let activeMs = 0;
      let logins = 0;
      let users = 0;
      for (const entry of Object.values(day)) {
        if (!entry) continue;
        users += 1;
        requests += Number(entry.requests) || 0;
        bytes += Number(entry.bytes) || 0;
        activeMs += Number(entry.activeMs) || 0;
        logins += Number(entry.logins) || 0;
      }
      return { date, requests, bytes, activeMs, logins, users };
    });
    const todayKey = keys[keys.length - 1];
    const today = statsStore.days[todayKey] || {};
    const cutoff = Date.now() - STATS_ONLINE_WINDOW;
    const online = Object.entries(today)
      .filter(([, entry]) => entry && Number(entry.lastSeen) > cutoff)
      .map(([userId, entry]) => ({
        userId,
        username: entry.username || userId,
        lastSeen: Number(entry.lastSeen) || 0,
        ip: topIpOf(entry),
        ua: entry.ua || '',
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
    const allUsers = loadUsers().users;
    let statsBytes = 0;
    try { statsBytes = fs.statSync(STATS_FILE).size; } catch { statsBytes = 0; }
    return {
      ok: true,
      serverTime: Date.now(),
      today: series[series.length - 1],
      series,
      online,
      onlineWindowSec: STATS_ONLINE_WINDOW / 1000,
      users: {
        total: allUsers.length,
        admins: allUsers.filter((u) => roleOf(u) === 'admin').length,
        supers: allUsers.filter((u) => roleOf(u) === 'super').length,
        primary: allUsers.filter((u) => u.primary).length,
      },
      recentLogins: statsStore.logins.slice(-10).reverse(),
      statsFileBytes: statsBytes,
      statsDays: Object.keys(statsStore.days).length,
    };
  }

  // 使用统计：按天 × 用户展开
  if (p === '/api/admin/stats' && req.method === 'GET') {
    const days = Math.max(1, Math.min(30, Number(q.get('days') || 14)));
    const userId = String(q.get('userId') || '');
    const keys = lastDateKeys(days);
    const rows = [];
    for (const date of keys.slice().reverse()) {
      const day = statsStore.days[date] || {};
      for (const [id, entry] of Object.entries(day)) {
        if (userId && id !== userId) continue;
        if (!entry) continue;
        rows.push({
          date,
          userId: id,
          username: entry.username || id,
          requests: Number(entry.requests) || 0,
          api: Number(entry.api) || 0,
          assets: Number(entry.assets) || 0,
          bytes: Number(entry.bytes) || 0,
          activeMs: Number(entry.activeMs) || 0,
          logins: Number(entry.logins) || 0,
          lastSeen: Number(entry.lastSeen) || 0,
          views: entry.views || {},
          ip: topIpOf(entry),
          ua: entry.ua || '',
        });
      }
    }
    const series = keys.map((date) => {
      const day = statsStore.days[date] || {};
      const out = { date, requests: 0, bytes: 0, activeMs: 0, logins: 0, users: 0 };
      for (const [id, entry] of Object.entries(day)) {
        if (!entry) continue;
        if (userId && id !== userId) continue;
        out.users += 1;
        out.requests += Number(entry.requests) || 0;
        out.bytes += Number(entry.bytes) || 0;
        out.activeMs += Number(entry.activeMs) || 0;
        out.logins += Number(entry.logins) || 0;
      }
      return out;
    });
    const totals = series.reduce(
      (acc, item) => ({
        requests: acc.requests + item.requests,
        bytes: acc.bytes + item.bytes,
        activeMs: acc.activeMs + item.activeMs,
        logins: acc.logins + item.logins,
      }),
      { requests: 0, bytes: 0, activeMs: 0, logins: 0 },
    );
    const known = new Map();
    for (const u of loadUsers().users) known.set(u.id, u.username);
    for (const day of Object.values(statsStore.days)) {
      for (const [id, entry] of Object.entries(day || {})) {
        if (entry && entry.username && !known.has(id)) known.set(id, entry.username);
      }
    }
    return {
      ok: true,
      days,
      userId,
      series,
      rows,
      totals,
      users: [...known.entries()].map(([id, username]) => ({ id, username })).sort((a, b) => String(a.username).localeCompare(String(b.username))),
    };
  }

  // 登录 / 改密 / 强制下线等事件
  if (p === '/api/admin/logins' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(500, Number(q.get('limit') || 80)));
    const userId = String(q.get('userId') || '');
    const action = String(q.get('action') || '');
    const onlyFailed = q.get('ok') === '0';
    const list = statsStore.logins.filter((item) => {
      if (userId && item.userId !== userId) return false;
      if (action && item.action !== action) return false;
      if (onlyFailed && item.ok) return false;
      return true;
    });
    return { ok: true, total: list.length, logins: list.slice(-limit).reverse() };
  }

  if (p === '/api/admin/logins/clear' && req.method === 'POST') {
    requireSuper(req);
    const count = statsStore.logins.length;
    statsStore.logins = [];
    flushStats();
    recordLoginEvent(req, { user: actor, ok: true, action: 'clear', reason: `清空 ${count} 条登录日志` });
    return { ok: true, cleared: count };
  }

  if (p === '/api/admin/system' && req.method === 'GET') {
    const status = await getSystemStatus();
    let statsFileBytes = 0;
    try { statsFileBytes = fs.statSync(STATS_FILE).size; } catch { statsFileBytes = 0; }
    return { ...status, ok: true, statsFileBytes, statsDays: Object.keys(statsStore.days).length };
  }

  throw Object.assign(new Error('未知接口'), { status: 404 });
}

function getChangelog() {
  const list = readJsonSafe(path.join(__dirname, 'data', 'changelog.json'), []);
  return { ok: true, versions: Array.isArray(list) ? list : [] };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  if (p.startsWith('/api/auth/')) return handleAuth(req, res, url);
  if (p.startsWith('/api/admin/')) return handleAdmin(req, res, url);
  if (p === '/api/changelog') return getChangelog();
  if (p === '/api/health') {
    return { ok: true, version: VERSION, uptime: process.uptime(), port: PORT, time: new Date().toISOString() };
  }
  // 前端心跳：记录页面访问与在线时长（每 60 秒一次；切页时额外记一次 view）
  if (p === '/api/activity/ping' && req.method === 'POST') {
    const user = currentUser(req);
    if (!user) throw Object.assign(new Error('未登录'), { status: 401 });
    const body = req.body || {};
    recordViewPing(req, user, body.view, body.activeSec, body.event);
    return { ok: true };
  }
  // 手机 / 局域网访问地址（设置页「手机访问」用）
  if (p === '/api/net') {
    const urls = accessUrls();
    return {
      ok: true,
      port: PORT,
      host: HOST,
      urls,
      mobile: urls.filter((u) => !u.includes('127.0.0.1')),
      lan: lanAddresses(),
      lanEnabled: HOST === '0.0.0.0' || HOST === '::',
    };
  }
  // 自选基金 / 持仓：按当前登录账号隔离。主账号的数据同时是推送用的那一份。
  if (p === '/api/portfolio' && req.method === 'GET') {
    const user = currentUser(req);
    const portfolio = loadPortfolio(user);
    let updatedAt = null;
    try {
      updatedAt = user && user.primary
        ? fs.statSync(PUSH_FILE).mtimeMs
        : fs.statSync(userDataFile(user.id)).mtimeMs;
    } catch {
      updatedAt = null;
    }
    return {
      ok: true,
      user: user ? publicUser(user) : null,
      funds: portfolio.funds,
      holdings: portfolio.holdings,
      watchlist: portfolio.watchlist,
      updatedAt,
    };
  }
  if (p === '/api/portfolio' && req.method === 'POST') {
    const user = currentUser(req);
    if (!user) throw Object.assign(new Error('未登录'), { status: 401 });
    const body = req.body || {};
    const cleaned = sanitizePortfolio(body);
    const current = loadPortfolio(user);
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    // 只更新前端明确传上来的字段，避免某个客户端少传 watchlist 就把服务器数据清空。
    savePortfolio(user, {
      funds: has('funds') ? cleaned.funds : current.funds,
      holdings: has('holdings') ? cleaned.holdings : current.holdings,
      watchlist: has('watchlist') ? cleaned.watchlist : current.watchlist,
    });
    return {
      ok: true,
      funds: has('funds') ? cleaned.funds.length : current.funds.length,
      holdings: Object.keys(has('holdings') ? cleaned.holdings : current.holdings).length,
      watchlist: has('watchlist') ? cleaned.watchlist.length : current.watchlist.length,
    };
  }
  if (p === '/api/source/status') return sourceStatus();
  // 数据源切换属于全局配置，2026-11-15 起移到后台管理，只有管理员能改。
  if (p === '/api/source/config') {
    if (req.method === 'POST') requireAdmin(req);
    return applySourceConfig(req, q);
  }
  if (p === '/api/source/probe') return probeSource(q.get('cap') || '');
  if (p === '/api/overview') return getOverview();
  if (p === '/api/csi300-ratio') return getCsi300FundRatio(Number(q.get('top') || 10));
  if (p === '/api/us') return getUSDashboard();
  if (p === '/api/us/minutes') {
    const symbols = (q.get('symbols') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return getUsMinutes(symbols);
  }
  if (p === '/api/distribution') {
    return q.get('market') === 'us' ? getUSDistribution() : getChinaDistribution();
  }
  if (p === '/api/advice') return getAdvice(q.get('risk') || 'balanced');
  if (p === '/api/battle') return getBattle();
  if (p === '/api/sector-confirm') return getSectorConfirm();
  if (p === '/api/money-moves') return getMoneyMoves();
  if (p === '/api/ladder') return getLadder();
  if (p === '/api/timeline') return getTimelineData();
  if (p === '/api/ten-day') {
    return getTenDay(q.get('dir') === 'down' ? 'down' : 'up', q.get('force') === '1');
  }
  if (p === '/api/sector/export') {
    const code = q.get('code');
    if (!code) throw new Error('缺少板块代码');
    return getSectorExport(code);
  }
  if (p === '/api/sector/members') {
    const code = q.get('code');
    if (!code) throw new Error('缺少板块代码');
    return getSectorMembers(code, q.get('name') || '', q.get('type') === 'industry' ? 'industry' : 'concept');
  }
  if (p === '/api/intraday') {
    return getIntraday(q.get('secid') || '1.000001', q.get('date'));
  }
  if (p === '/api/metals/intraday') {
    const codes = (q.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return getMetalsIntraday(codes);
  }
  if (p === '/api/index-compare') return getIndexCompare(Number(q.get('days') || 250));
  if (p === '/api/index-periods') return getIndexPeriods();
  if (p === '/api/kline') {
    const secid = q.get('secid') || '1.000001';
    const klt = Number(q.get('klt') || 101);
    const limit = Math.max(30, Math.min(3000, Number(q.get('limit') || 160)));
    const allowed = new Set([1, 5, 15, 30, 60, 101, 102, 103]);
    if (!allowed.has(klt)) throw new Error('不支持的 K 线周期');
    const kline = await getKline(secid, klt, limit);
    let analysis = null;
    try { analysis = analyze(kline.candles); } catch { /* 数据不足时仍返回 K 线 */ }
    return { ...kline, analysis };
  }
  if (p === '/api/stock') {
    const secid = q.get('secid');
    if (!secid) throw new Error('缺少 secid');
    return getStock(secid, q.get('risk') || 'balanced');
  }
  if (p === '/api/quotes') {
    const secids = (q.get('secids') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const items = await fetchQuoteList(secids, 'stock');
    return { items, updatedAt: Date.now() };
  }
  if (p === '/api/watchlist') {
    const secids = (q.get('secids') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return getWatchlist(secids, q.get('risk') || 'balanced');
  }
  if (p === '/api/sectors') {
    return getSectors(q.get('type') === 'concept' ? 'concept' : 'industry');
  }
  if (p === '/api/sectors/period') {
    return getSectorPeriod(
      q.get('type') === 'concept' ? 'concept' : 'industry',
      SECTOR_PERIODS[q.get('period')] ? q.get('period') : 'today',
    );
  }
  if (p === '/api/sector/constituents') {
    const code = q.get('code');
    if (!code) throw new Error('缺少板块代码');
    try {
      const { data } = await runSource('sectorDetail', [code]);
      return data;
    } catch {
      // 成分股接口偶发限流时，不阻断板块走势抽屉。
      return {
        code,
        items: [],
        unavailable: true,
        note: '成分股接口暂时不可用，板块走势仍可查看',
        updatedAt: Date.now(),
      };
    }
  }
  if (p === '/api/sector/kline') {
    const code = q.get('code');
    if (!code) throw new Error('缺少板块代码');
    return getKline(`90.${code}`, 101, 120);
  }
  if (p === '/api/rank') {
    const type = ['gain', 'loss', 'inflow', 'outflow', 'amount'].includes(q.get('type'))
      ? q.get('type')
      : 'gain';
    return getRank(type, Math.min(50, Number(q.get('limit') || 20)));
  }
  if (p === '/api/news') {
    return getNews(Math.min(50, Number(q.get('limit') || 40)));
  }
  if (p === '/api/search') return getSearch(q.get('q'));
  if (p === '/api/flow') {
    const secid = q.get('secid') || '1.000001';
    return getFlow(secid);
  }
  if (p === '/api/funds/open-flow') {
    return getOpenFundFlow(q.get('category') || 'all', q.get('limit') || 50);
  }
  if (p === '/api/funds/daily-proxy') {
    return getDailyProxyBoard(Math.min(100, Math.max(10, Number(q.get('limit') || 50))));
  }
  if (p === '/api/funds/flow') {
    const type = q.get('type') === 'outflow' ? 'outflow' : 'inflow';
    const category = ['equity', 'bond', 'commodity', 'money'].includes(q.get('category'))
      ? q.get('category')
      : 'all';
    return getEtfFlow(type, Math.min(50, Number(q.get('limit') || 30)), category);
  }
  if (p === '/api/funds/search') return getFundSearch(q.get('q'));
  if (p === '/api/funds/watch') {
    const codes = (q.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return getFundWatch(codes, q.get('risk') || 'balanced');
  }
  // 穿透估算明细：排查「当日涨跌」是怎么算出来的（也用于核对是否与官方净值接近）。
  // ?asof=pre 时额外给出「假设当日净值还没公布」时 14:30 会采用的涨跌口径。
  if (p === '/api/funds/estimate') {
    const codes = (q.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (!codes.length) return { ok: true, items: [] };
    const today = shanghaiToday();
    const infoRows = await fetchFundMNFInfo(codes).catch(() => []);
    const infoMap = new Map(infoRows.map((r) => [r.FCODE, r]));
    const map = await estimateFundDayPctBatch(codes.map((code) => ({ code, name: (infoMap.get(code) || {}).SHORTNAME || '' })));
    const asIfPre = q.get('asof') === 'pre';
    return {
      ok: true,
      today,
      items: codes.map((code) => {
        const info = infoMap.get(code);
        const item = { code, name: (info && info.SHORTNAME) || '', ...(map.get(code) || {}) };
        if (asIfPre && info) {
          item.navDate = String(info.PDATE || '');
          item.navPct = num(info.NAVCHGRT);
          item.preview = resolveFundTodayPct({
            navDate: '1970-01-01',
            navPct: num(info.NAVCHGRT),
            gsz: 0,
            gszzl: null,
            gzTime: '',
            est: map.get(code) || null,
            today,
          });
        }
        return item;
      }),
    };
  }
  if (p === '/api/funds/detail') {
    const code = q.get('code');
    if (!code) throw new Error('缺少基金代码');
    return getFundDetail(code, q.get('type'));
  }
  if (p === '/api/funds/metrics') {
    const code = q.get('code');
    if (!code) throw new Error('缺少基金代码');
    return getFundMetrics(code, q.get('type'));
  }
  if (p === '/api/funds/stock-rank') {
    const ft = STOCK_FUND_TYPES[q.get('type')] ? q.get('type') : 'gp';
    const sort = FUND_SORT_MAP[q.get('sort')] ? q.get('sort') : 'year';
    return getStockFundRank(ft, sort, Math.min(50, Number(q.get('limit') || 30)), q.get('sector') || '');
  }
  if (p === '/api/funds/stock-detail') {
    const code = q.get('code');
    if (!code) throw new Error('缺少基金代码');
    return getStockFundDetail(code);
  }
  if (p === '/api/funds/holdings-history') {
    const code = q.get('code');
    if (!code) throw new Error('缺少基金代码');
    return { code, quarters: await getFundHoldingsHistory(code), updatedAt: Date.now() };
  }
  if (p === '/api/funds/compare') {
    const codes = (q.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return getFundCompare(codes);
  }
  if (p === '/api/funds/sectors') {
    const ft = STOCK_FUND_TYPES[q.get('type')] ? q.get('type') : 'gp';
    const sort = ['day', 'week', 'month', 'year'].includes(q.get('sort')) ? q.get('sort') : 'day';
    return getStockFundSectors(ft, sort);
  }
  if (p === '/api/funds/sector-flow') return getFundSectorFlow();
  if (p === '/api/funds/hot') return getHotFunds();
  if (p === '/api/funds/warnings') return getFundWarnings();
  const err = new Error('未知接口');
  err.status = 404;
  throw err;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(req, res, status, data) {
  const body = JSON.stringify(data);
  recordTraffic(req, Buffer.byteLength(body), 'api');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }
  const rel = decoded === '/' ? '/index.html' : decoded;
  const file = path.resolve(PUBLIC_DIR, `.${rel}`);
  const root = path.resolve(PUBLIC_DIR);
  if (!file.toLowerCase().startsWith(root.toLowerCase())) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    recordTraffic(req, Number(stat.size) || 0, 'static');
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
    };
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }
  req.gpPath = url.pathname;
  req.gpUser = currentUser(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // 后台管理的短地址：/admin → /admin.html（页面本身公开，数据接口仍校验角色）。
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    res.writeHead(302, { Location: '/admin.html', 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'POST') {
      try {
        req.body = await readJsonBody(req);
      } catch {
        sendJSON(req, res, 400, { error: '请求体不是合法 JSON' });
        return;
      }
    }
    // 除登录相关接口外，其它 API 一律要求已登录。
    if (!PUBLIC_API.has(url.pathname) && !req.gpUser) {
      sendJSON(req, res, 401, { error: '未登录', needAuth: true });
      return;
    }
    try {
      const data = url.pathname.startsWith('/api/push/')
        ? await handlePushApi(req, res, url)
        : await handleApi(req, res, url);
      sendJSON(req, res, 200, data);
      if (process.env.LOG_API !== '0') {
        console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${url.pathname}${url.search} 200 ${Date.now() - started}ms`);
      }
    } catch (err) {
      const status = err.status || 502;
      sendJSON(req, res, status, {
        error: err.message || '服务暂时不可用',
        path: url.pathname,
        time: new Date().toISOString(),
      });
      console.error(`[API ERROR] ${url.pathname}${url.search}`, err.message);
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }
  // 页面鉴权：css/js/图片/字体等静态资源放行，登录页 / 后台登录页放行，其余（含首页）要求登录。
  const assetPath =
    /^\/(css|js|vendor)\//.test(url.pathname) ||
    /\.(css|js|png|jpe?g|gif|svg|ico|webp|woff2?|map)$/i.test(url.pathname);
  const publicPage = url.pathname === '/login.html' || url.pathname === '/admin.html';
  if (!publicPage && !assetPath && !req.gpUser) {
    res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' });
    return res.end();
  }
  serveStatic(req, res, url.pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。请关闭占用程序，或运行: node server.js --port=8091\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const urls = accessUrls();
  const link = urls[0];
  const mobileUrls = urls.filter((u) => !u.includes('127.0.0.1'));
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║        寰球智投 · Global Pulse Terminal       ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log(`  服务已启动: ${link}`);
  for (const u of mobileUrls) console.log(`  手机访问:   ${u}   (手机连同一个 Wi-Fi 打开)`);
  if (!mobileUrls.length) {
    console.log('  手机访问:   已关闭（当前只监听本机）。需要手机打开请运行: node server.js --host=0.0.0.0');
  }
  // 每分钟检查一次是否到了基金策略推送时间（时区按东八区）。
  setInterval(() => { runPushTick().catch(() => {}); }, 60000);
  const pushCfg = loadPushConfig();
  if (pushCfg.enabled) {
    const slotsText = (pushCfg.slots || [])
      .filter((s) => s.enabled !== false)
      .map((s) => `${s.time} ${s.key}`)
      .join(' / ');
    console.log(`  Push: enabled - ${pushChannelLabel(pushCfg.channel)} - ${slotsText || 'no slot'}`);
  }
  console.log(`  数据来源: 东方财富 / 腾讯 / 新浪公开行情接口 (自动切换)`);
  console.log('  按 Ctrl+C 停止服务\n');
  if (process.argv.includes('--open')) {
    setTimeout(() => {
      exec(`start "" "${link}"`, { windowsHide: true }, () => {});
    }, 700);
  }
});

process.on('SIGINT', () => {
  console.log('\n服务已停止。');
  flushStats();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800);
});

/* =========================================================
   稳定性兜底（2026-11-14）
   2026-11-13 夜里服务在无任何错误输出、无栈的情况下静默退出（exit 1），
   导致第二天 14:30 / 19:30 的推送差点落空。这里做三件事：
   1) 未捕获异常 / 未处理的 Promise 拒绝只记录不退出（静态行情看板没有会写坏数据的状态）；
   2) 崩溃信息落盘到 data/crash.log，方便事后定位；
   3) 记住上次退出时间，配合 启动.bat 的自动重启循环使用。
   ========================================================= */
const CRASH_LOG = path.join(__dirname, 'data', 'crash.log');

function logCrash(kind, err) {
  const at = new Date().toISOString();
  const detail = err && err.stack ? err.stack : String(err);
  const line = `[${at}] ${kind}: ${detail}\n`;
  try {
    fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true });
    fs.appendFileSync(CRASH_LOG, line, 'utf8');
  } catch { /* 日志写不进去也不能让服务崩 */ }
  console.error(`[${kind}] ${detail}`);
}

process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason);
});
process.on('SIGHUP', () => {
  // 关掉终端窗口时 Windows 可能直接结束进程；至少留一条记录。
  logCrash('SIGHUP', 'process received SIGHUP (terminal closed?)');
  try { flushStats(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  process.exit(0);
});
// 正常退出 / 被强杀前，把内存里的统计落盘。
process.on('exit', () => {
  try { flushStats(); } catch { /* ignore */ }
});
