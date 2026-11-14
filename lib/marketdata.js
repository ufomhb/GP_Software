'use strict';

/**
 * 各数据源的具体实现。
 * 所有函数返回与 server.js 中原有结构一致的数据，便于无缝切换。
 */

const fs = require('node:fs');
const path = require('node:path');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const EM_HEADERS = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/', Accept: '*/*' };
const SINA_HEADERS = { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/', Accept: '*/*' };
const TX_HEADERS = { 'User-Agent': UA, Referer: 'https://gu.qq.com/', Accept: '*/*' };

const BOARDS_FILE = path.join(__dirname, '..', 'data', 'boards.json');

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

async function fetchBuffer(url, headers, timeout = 10000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchJson(url, headers, timeout = 10000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('上游返回格式异常');
  }
}

async function fetchGbk(url, headers, timeout = 10000) {
  const buf = await fetchBuffer(url, headers, timeout);
  return new TextDecoder('gbk').decode(buf);
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

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function baseQuote(extra) {
  return {
    group: '',
    secid: '',
    code: '',
    market: '',
    name: '',
    price: null,
    pct: null,
    change: null,
    volume: null,
    amount: null,
    amountYi: null,
    turnover: null,
    pe: null,
    high: null,
    low: null,
    open: null,
    prevClose: null,
    mktCap: null,
    mktCapYi: null,
    floatCap: null,
    main: null,
    mainYi: null,
    mainPct: null,
    industry: '',
    up: null,
    down: null,
    flat: null,
    ...extra,
  };
}

/* =========================================================
   行情快照
   ========================================================= */

function emNormalizeQuote(d, group) {
  const amount = num(d.f6);
  const main = num(d.f62);
  return baseQuote({
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
  });
}

async function emQuotes(secids, group) {
  const unique = [...new Set(secids)];
  const batches = await mapLimit(chunk(unique, 50), 3, async (part) => {
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=' +
      'f2,f3,f4,f5,f6,f8,f9,f12,f13,f14,f15,f16,f17,f18,f20,f21,f62,f100,f104,f105,f106,f184' +
      `&secids=${part.join(',')}`;
    return fetchJson(url, EM_HEADERS, 9000);
  });
  const map = new Map();
  for (const json of batches) {
    for (const d of json?.data?.diff || []) map.set(`${d.f13}.${d.f12}`, emNormalizeQuote(d, group));
  }
  return unique.map((id) => map.get(id)).filter(Boolean);
}

/* ------------------------- 腾讯 ------------------------- */

const TENCENT_MAP = {
  '100.HSI': 'hkHSI',
  '100.HSCEI': 'hkHSCEI',
  '124.HSTECH': 'hkHSTECH',
  '100.DJIA': 'usDJI',
  '100.SPX': 'usINX',
  '100.NDX': 'usNDX',
  '100.NDX100': 'usNDX',
};

function tencentSymbol(secid) {
  if (TENCENT_MAP[secid]) return TENCENT_MAP[secid];
  const [market, code] = String(secid).split('.');
  if (!code) return null;
  if (market === '1') return `sh${code}`;
  if (market === '0') return code.startsWith('899') ? `bj${code}` : `sz${code}`;
  return null;
}

function secidFromTencent(symbol) {
  if (symbol.startsWith('sh')) return `1.${symbol.slice(2)}`;
  if (symbol.startsWith('sz')) return `0.${symbol.slice(2)}`;
  if (symbol.startsWith('bj')) return `0.${symbol.slice(2)}`;
  if (symbol.startsWith('hk')) return `100.${symbol.slice(2)}`;
  if (symbol.startsWith('us')) return `105.${symbol.slice(2)}`;
  return '';
}

function parseTencentQuote(symbol, raw, group) {
  const f = raw.split('~');
  if (f.length < 35) return null;
  const isCn = /^(sh|sz|bj)/.test(symbol);
  const isIndex = /^(sh000|sh999|sz399|bj899)/.test(symbol);
  const name = f[1] || '';
  const price = num(f[3]);
  const prevClose = num(f[4]);
  const open = num(f[5]);
  const change = num(f[31]);
  const pct = num(f[32]);
  const high = num(f[33]);
  const low = num(f[34]);
  let volume = null;
  let amount = null;
  let turnover = null;
  let pe = null;
  let mktCapYi = null;
  let floatCapYi = null;

  if (isCn) {
    volume = num(f[6]);
    // 成交额统一在 37 字段（万元），换手率 / 市盈率仅个股有。
    const wan = num(f[37]);
    amount = wan === null ? null : wan * 1e4;
    if (!isIndex) {
      turnover = num(f[38]);
      pe = num(f[39]);
    }
    floatCapYi = num(f[44]);
    mktCapYi = num(f[45]);
  } else {
    volume = num(f[36]);
    const wan = num(f[37]);
    amount = wan === null ? null : wan * 1e4;
  }

  return baseQuote({
    group,
    secid: secidFromTencent(symbol),
    code: isCn ? symbol.slice(2) : String(f[2] || symbol.replace(/^[a-z]+/, '')),
    market: symbol.startsWith('sh') ? 1 : 0,
    name,
    price,
    pct,
    change,
    volume,
    amount,
    amountYi: amount === null ? null : round(amount / 1e8, 2),
    turnover,
    pe,
    high,
    low,
    open,
    prevClose,
    mktCap: mktCapYi === null ? null : mktCapYi * 1e8,
    mktCapYi,
    floatCap: floatCapYi === null ? null : floatCapYi * 1e8,
    main: null,
    mainYi: null,
    mainPct: null,
    industry: '',
    up: null,
    down: null,
    flat: null,
  });
}

async function tencentQuotes(secids, group) {
  const unique = [...new Set(secids)];
  const pairs = unique
    .map((id) => [id, tencentSymbol(id)])
    .filter(([, symbol]) => symbol);
  if (!pairs.length) {
    const err = new Error('腾讯行情不支持这些品种');
    err.soft = true;
    throw err;
  }
  const symbolToSecid = new Map(pairs.map(([id, symbol]) => [symbol, id]));
  const batches = await mapLimit(chunk(pairs.map(([, s]) => s), 60), 3, async (symbols) => {
    const text = await fetchGbk(`https://qt.gtimg.cn/q=${symbols.join(',')}`, TX_HEADERS, 9000);
    const map = new Map();
    for (const m of text.matchAll(/v_([A-Za-z0-9_]+)="([^"]*)"/g)) {
      if (!m[2] || m[2] === '1') continue;
      const q = parseTencentQuote(m[1], m[2], group);
      if (q && q.secid) map.set(m[1], q);
    }
    return map;
  });
  const merged = new Map();
  for (const m of batches) for (const [k, v] of m) merged.set(k, v);
  const out = pairs
    .map(([secid, symbol]) => {
      const q = merged.get(symbol);
      if (!q) return null;
      return { ...q, secid, group, code: secid.split('.')[1], market: secid.split('.')[0] };
    })
    .filter(Boolean);
  if (!out.length) throw new Error('腾讯行情未返回数据');
  return out;
}

/* ------------------------- 新浪 ------------------------- */

const SINA_MAP = {
  '100.HSI': 'rt_hkHSI',
  '100.HSCEI': 'rt_hkHSCEI',
  '100.DJIA': 'int_dji',
  '100.SPX': 'int_sp500',
  '100.NDX': 'int_nasdaq',
  '100.NDX100': 'int_nasdaq',
  '100.N225': 'int_nikkei',
  '100.FTSE': 'int_ftse',
  '101.GC00Y': 'hf_GC',
  '101.SI00Y': 'hf_SI',
  '101.HG00Y': 'hf_CAD',
  '102.CL00Y': 'hf_CL',
  '122.XAU': 'hf_XAU',
  '122.XAG': 'hf_XAG',
  '133.USDCNH': 'fx_susdcnh',
  '119.USDJPY': 'fx_susdjpy',
  '119.EURUSD': 'fx_seurusd',
  '119.USDHKD': 'fx_susdhkd',
  '119.USDGBP': 'fx_susdgbp',
};

function sinaSymbol(secid) {
  if (SINA_MAP[secid]) return SINA_MAP[secid];
  const [market, code] = String(secid).split('.');
  if (!code) return null;
  if (market === '1') return `sh${code}`;
  if (market === '0') return code.startsWith('899') ? `bj${code}` : `sz${code}`;
  return null;
}

function parseSinaQuote(symbol, raw, group, secid) {
  const f = raw.split(',');
  if (!f.length || !raw) return null;

  if (/^(sh|sz|bj)/.test(symbol)) {
    const price = num(f[3]);
    const prevClose = num(f[2]);
    const volume = num(f[8]);
    const amount = num(f[9]);
    const pct = price !== null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;
    return baseQuote({
      group,
      secid,
      code: symbol.slice(2),
      market: symbol.startsWith('sh') ? 1 : 0,
      name: f[0] || '',
      price,
      prevClose,
      open: num(f[1]),
      high: num(f[4]),
      low: num(f[5]),
      change: price !== null && prevClose !== null ? round(price - prevClose, 2) : null,
      pct: pct === null ? null : round(pct, 2),
      volume: volume === null ? null : round(volume / 100, 0),
      amount,
      amountYi: amount === null ? null : round(amount / 1e8, 2),
    });
  }

  if (symbol.startsWith('rt_hk')) {
    const price = num(f[6]);
    const prevClose = num(f[3]);
    const amount = num(f[11]);
    return baseQuote({
      group,
      secid,
      code: symbol.slice(6),
      market: 100,
      name: f[1] || f[0] || '',
      price,
      prevClose,
      open: num(f[2]),
      high: num(f[4]),
      low: num(f[5]),
      change: num(f[7]),
      pct: num(f[8]),
      volume: num(f[12]),
      amount,
      amountYi: amount === null ? null : round(amount / 1e8, 2),
    });
  }

  if (symbol.startsWith('gb_')) {
    const price = num(f[1]);
    const prevClose = num(f[26]);
    return baseQuote({
      group,
      secid,
      code: symbol.slice(3).toUpperCase(),
      market: 105,
      name: f[0] || '',
      price,
      prevClose,
      open: num(f[5]),
      high: num(f[6]),
      low: num(f[7]),
      change: num(f[4]),
      pct: num(f[2]),
      volume: num(f[10]),
    });
  }

  if (symbol.startsWith('int_')) {
    const price = num(f[1]);
    const change = num(f[2]);
    return baseQuote({
      group,
      secid,
      code: symbol.slice(4).toUpperCase(),
      market: 100,
      name: f[0] || '',
      price,
      change,
      pct: num(f[3]),
      prevClose: price !== null && change !== null ? round(price - change, 2) : null,
    });
  }

  if (symbol.startsWith('hf_')) {
    const price = num(f[0]);
    const prevClose = num(f[7]);
    const pct = price !== null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;
    return baseQuote({
      group,
      secid,
      code: symbol.slice(3),
      market: 101,
      name: f[13] || symbol.slice(3),
      price,
      prevClose,
      open: num(f[8]),
      high: num(f[4]),
      low: num(f[5]),
      change: price !== null && prevClose !== null ? round(price - prevClose, 2) : null,
      pct: pct === null ? null : round(pct, 2),
    });
  }

  if (symbol.startsWith('fx_s')) {
    const price = num(f[8]);
    const change = num(f[11]);
    return baseQuote({
      group,
      secid,
      code: symbol.slice(4).toUpperCase(),
      market: 133,
      name: f[9] || symbol.slice(4),
      price,
      change,
      pct: num(f[10]),
      prevClose: price !== null && change !== null ? round(price - change, 5) : null,
    });
  }

  return null;
}

async function sinaQuotes(secids, group) {
  const unique = [...new Set(secids)];
  const pairs = unique.map((id) => [id, sinaSymbol(id)]).filter(([, s]) => s);
  if (!pairs.length) {
    const err = new Error('新浪行情不支持这些品种');
    err.soft = true;
    throw err;
  }
  const secidBySymbol = new Map(pairs.map(([id, s]) => [s, id]));
  const batches = await mapLimit(chunk(pairs.map(([, s]) => s), 60), 3, async (symbols) => {
    const text = await fetchGbk(`https://hq.sinajs.cn/list=${symbols.join(',')}`, SINA_HEADERS, 9000);
    const map = new Map();
    for (const m of text.matchAll(/var hq_str_([A-Za-z0-9_]+)="([^"]*)"/g)) {
      const secid = secidBySymbol.get(m[1]);
      if (!secid || !m[2]) continue;
      const q = parseSinaQuote(m[1], m[2], group, secid);
      if (q) map.set(secid, q);
    }
    return map;
  });
  const merged = new Map();
  for (const m of batches) for (const [k, v] of m) merged.set(k, v);
  const out = unique.map((id) => merged.get(id)).filter(Boolean);
  if (!out.length) throw new Error('新浪行情未返回数据');
  return out;
}

/* ------------------------- 同花顺 ------------------------- */

const THS_HEADERS = { 'User-Agent': UA, Referer: 'http://stockpage.10jqka.com.cn/', Accept: '*/*' };

// 同花顺的指数代码与 A 股代码规则不同，这里只映射终端实际使用的几个指数。
const THS_INDEX_MAP = {
  '1.000001': 'zs_1A0001',
  '1.000300': 'zs_1B0300',
  '1.000688': 'zs_1B0688',
  '0.399001': 'zs_399001',
  '0.399006': 'zs_399006',
};

function thsSymbol(secid) {
  if (THS_INDEX_MAP[secid]) return THS_INDEX_MAP[secid];
  const [market, code] = String(secid).split('.');
  if (market === '1' || market === '0') {
    if (code === '899050') return null; // 北证 50 在同花顺免费接口里没有对应代码
    return `hs_${code}`;
  }
  return null;
}

function parseThsJsonp(text) {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) throw new Error('同花顺返回格式异常');
  return JSON.parse(text.slice(start + 1, end));
}

function thsNum(v) {
  const n = num(v);
  return n === null || n < 0 ? null : n;
}

function parseThsQuote(secid, symbol, items, group) {
  if (!items || !items['10']) return null;
  const price = num(items['10']);
  if (price === null) return null;
  const isIndex = symbol.startsWith('zs_');
  const volumeRaw = num(items['13']);
  const amount = num(items['19']);
  const total = isIndex ? thsNum(items['37']) : null;
  const up = isIndex ? thsNum(items['38']) : null;
  const down = isIndex ? thsNum(items['39']) : null;
  const flat = total !== null && up !== null && down !== null ? Math.max(0, total - up - down) : null;
  const mktCap = num(items['3475914']);
  const floatCap = num(items['3541450']);

  return baseQuote({
    group,
    secid,
    code: secid.split('.')[1],
    market: Number(secid.split('.')[0]),
    name: items.name || '',
    price,
    pct: num(items['199112']),
    change: num(items['264648']),
    volume: volumeRaw === null ? null : round(volumeRaw / 100, 0),
    amount,
    amountYi: amount === null ? null : round(amount / 1e8, 2),
    turnover: isIndex ? null : thsNum(items['1968584']),
    pe: isIndex ? null : (thsNum(items['2034120']) ?? thsNum(items['3153'])),
    high: num(items['8']),
    low: num(items['9']),
    open: num(items['7']),
    prevClose: num(items['6']),
    mktCap,
    mktCapYi: mktCap === null ? null : round(mktCap / 1e8, 1),
    floatCap,
    main: null,
    mainYi: null,
    mainPct: null,
    up,
    down,
    flat,
    total,
  });
}

async function thsQuotes(secids, group) {
  const unique = [...new Set(secids)];
  const pairs = unique.map((id) => [id, thsSymbol(id)]).filter(([, symbol]) => symbol);
  if (!pairs.length) {
    const err = new Error('同花顺不支持这些品种');
    err.soft = true;
    throw err;
  }
  const batches = await mapLimit(chunk(pairs, 12), 3, async (part) =>
    Promise.all(
      part.map(async ([secid, symbol]) => {
        const text = await fetchGbk(
          `https://d.10jqka.com.cn/v6/realhead/${symbol}/defer/last.js`,
          THS_HEADERS,
          8000,
        );
        const json = parseThsJsonp(text);
        return parseThsQuote(secid, symbol, json.items, group);
      }),
    ),
  );
  const out = batches.flat().filter(Boolean);
  if (!out.length) throw new Error('同花顺行情未返回数据');
  return out;
}

/* =========================================================
   板块
   ========================================================= */

function readBoards() {
  try {
    const raw = JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8'));
    return {
      industry: Array.isArray(raw.industry) ? raw.industry : [],
      concept: Array.isArray(raw.concept) ? raw.concept : [],
    };
  } catch {
    return { industry: [], concept: [] };
  }
}

function emNormalizeSector(d) {
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
    codeSource: 'eastmoney',
  };
}

async function emSectors(type = 'industry') {
  const boards = readBoards();
  const rawList = type === 'concept' ? boards.concept : boards.industry;
  if (!rawList.length) throw new Error('缺少板块清单缓存');
  const list = type === 'industry' ? rawList.filter((b) => !/[ⅡⅢ]$/.test(b.name)) : rawList;
  const fields = 'f2,f3,f6,f12,f13,f14,f20,f62,f66,f69,f72,f75,f78,f81,f84,f87,f104,f105,f184';
  const batches = await mapLimit(chunk(list.map((b) => `90.${b.code}`), 50), 3, async (part) => {
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=' + fields + `&secids=${part.join(',')}`;
    return fetchJson(url, EM_HEADERS, 9000);
  });
  const map = new Map();
  for (const json of batches) {
    for (const d of json?.data?.diff || []) map.set(String(d.f12), emNormalizeSector(d));
  }
  const items = list
    .map((b) => map.get(b.code) || null)
    .filter(Boolean)
    .sort((a, b) => b.main - a.main);
  const inflowCount = items.filter((s) => s.main > 0).length;
  return {
    type,
    total: items.length,
    rawTotal: rawList.length,
    items,
    inflowCount,
    outflowCount: items.length - inflowCount,
    netInflow: round(items.reduce((sum, s) => sum + s.main, 0), 1),
    updatedAt: Date.now(),
    source: 'eastmoney',
    stale: false,
  };
}

function parseSinaSectorList(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('板块清单格式异常');
  const json = JSON.parse(text.slice(start, end + 1));
  const out = [];
  for (const raw of Object.values(json)) {
    const f = String(raw).split(',');
    if (f.length < 13) continue;
    out.push({
      sinaCode: f[0],
      name: f[1],
      count: num(f[2]),
      price: num(f[3]),
      pct: num(f[5]),
      amount: num(f[7]),
      leader: { name: f[12], symbol: f[8], pct: num(f[11]) },
    });
  }
  return out;
}

async function sinaSectors(type = 'industry') {
  const listUrl =
    type === 'concept'
      ? 'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class'
      : 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php';
  const flowUrl =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk' +
    `?page=1&num=200&sort=netamount&asc=0&fenlei=${type === 'concept' ? 1 : 0}`;

  const [listText, flowRows] = await Promise.all([
    fetchGbk(listUrl, SINA_HEADERS, 12000),
    fetchJson(flowUrl, SINA_HEADERS, 12000).then((rows) => (Array.isArray(rows) ? rows : [])),
  ]);
  const list = parseSinaSectorList(listText);
  if (!list.length) throw new Error('新浪板块清单为空');

  const boards = readBoards();
  const nameToCode = new Map(
    (type === 'concept' ? boards.concept : boards.industry).map((b) => [b.name, b.code]),
  );
  const flowByName = new Map(flowRows.map((r) => [r.name, r]));

  const items = list.map((s) => {
    const flow = flowByName.get(s.name) || null;
    const net = flow ? num(flow.netamount) : null;
    const gross = flow ? (num(flow.inamount) || 0) + (num(flow.outamount) || 0) : s.amount;
    return {
      code: nameToCode.get(s.name) || s.sinaCode,
      name: s.name,
      price: s.price,
      pct: flow && num(flow.avg_changeratio) !== null ? round(num(flow.avg_changeratio) * 100, 2) : s.pct,
      amount: gross,
      amountYi: gross === null ? null : round(gross / 1e8, 1),
      mktCapYi: null,
      main: net === null ? 0 : round(net / 1e8, 2),
      mainPct: flow && num(flow.ratioamount) !== null ? round(num(flow.ratioamount) * 100, 2) : null,
      super: null,
      large: null,
      medium: null,
      small: null,
      up: null,
      down: null,
      leader: s.leader,
      codeSource: nameToCode.has(s.name) ? 'eastmoney' : 'sina',
    };
  });
  items.sort((a, b) => b.main - a.main);
  const inflowCount = items.filter((s) => s.main > 0).length;
  return {
    type,
    total: items.length,
    rawTotal: list.length,
    items,
    inflowCount,
    outflowCount: items.length - inflowCount,
    netInflow: round(items.reduce((sum, s) => sum + s.main, 0), 1),
    updatedAt: Date.now(),
    source: 'sina',
    note: '新浪板块为独立口径，板块走势与成分股明细需切回东方财富',
    stale: false,
  };
}

/* =========================================================
   资金流
   ========================================================= */

async function emStockFlow(secid) {
  const url =
    'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=' +
    encodeURIComponent(secid) +
    '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63&klt=1&lmt=0';
  const json = await fetchJson(url, EM_HEADERS, 10000);
  const data = json?.data || {};
  const points = (data.klines || [])
    .map((line) => {
      const p = line.split(',');
      const t = p[0] && p[0].includes(' ') ? p[0].split(' ')[1] : p[0];
      return {
        t,
        main: round(num(p[1]) / 1e8, 2),
        small: round(num(p[2]) / 1e8, 2),
        medium: round(num(p[3]) / 1e8, 2),
        large: round(num(p[4]) / 1e8, 2),
        super: round(num(p[5]) / 1e8, 2),
      };
    })
    .filter((p) => p.main !== null);
  const periods = data?.tradePeriods?.periods || [];
  const first = periods[0]?.b ? String(periods[0].b) : '';
  const date =
    first.length >= 8 ? `${first.slice(0, 4)}-${first.slice(4, 6)}-${first.slice(6, 8)}` : null;
  return {
    secid,
    name: data.name || '',
    date,
    points,
    last: points.length ? points[points.length - 1].main : null,
    source: 'eastmoney',
    updatedAt: Date.now(),
  };
}

function shanghaiDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts;
}

async function sinaStockFlow(secid) {
  const [market, code] = String(secid).split('.');
  if (market !== '1' && market !== '0') throw new Error('新浪资金流仅支持 A 股与 ETF');
  const symbol = market === '1' ? `sh${code}` : code.startsWith('899') ? `bj${code}` : `sz${code}`;
  const url =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssi_ssfx_flzjtj' +
    `?daima=${symbol}`;
  const json = await fetchJson(url, SINA_HEADERS, 10000);
  if (!json || !json.r0_in) throw new Error('新浪资金流无数据');
  const net = (a, b) => round((num(a) || 0) - (num(b) || 0), 0);
  const superNet = net(json.r0_in, json.r0_out) / 1e8;
  const largeNet = net(json.r1_in, json.r1_out) / 1e8;
  const mediumNet = net(json.r2_in, json.r2_out) / 1e8;
  const smallNet = net(json.r3_in, json.r3_out) / 1e8;
  const total = num(json.netamount) === null ? null : round(num(json.netamount) / 1e8, 2);
  return {
    secid,
    name: json.name || '',
    date: shanghaiDate(),
    points: [],
    last: round(superNet + largeNet, 2),
    snapshot: {
      main: round(superNet + largeNet, 2),
      super: round(superNet, 2),
      large: round(largeNet, 2),
      medium: round(mediumNet, 2),
      small: round(smallNet, 2),
      total,
      turnover: num(json.turnover),
    },
    source: 'sina',
    degraded: true,
    note: '新浪仅提供当日资金结构快照，没有分时曲线',
    updatedAt: Date.now(),
  };
}

/* =========================================================
   排行
   ========================================================= */

const EM_RANK_FID = { gain: 'f3', loss: 'f3', amount: 'f6', inflow: 'f62', outflow: 'f62' };

async function emRank(type = 'gain', limit = 20) {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const fid = EM_RANK_FID[type] || 'f3';
  const po = type === 'loss' || type === 'outflow' ? 0 : 1;
  const url =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=' + n + '&po=' + po + '&np=1&fltt=2&invt=2' +
    `&fid=${fid}&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=` +
    'f2,f3,f4,f5,f6,f8,f12,f13,f14,f15,f16,f17,f18,f20,f21,f62,f100,f184';
  const json = await fetchJson(url, EM_HEADERS, 9000);
  const items = (json?.data?.diff || []).map((d) => emNormalizeQuote(d, 'stock'));
  return { type, items, updatedAt: Date.now(), source: 'eastmoney' };
}

function sinaSecidFromSymbol(symbol) {
  const s = String(symbol || '');
  const code = s.replace(/^(sh|sz|bj)/, '');
  return { secid: `${s.startsWith('sh') ? 1 : 0}.${code}`, code, market: s.startsWith('sh') ? 1 : 0 };
}

async function sinaRank(type = 'gain', limit = 20) {
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  if (type === 'inflow' || type === 'outflow') {
    const asc = type === 'outflow' ? 1 : 0;
    const url =
      'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_ssggzj' +
      `?page=1&num=${n}&sort=netamount&asc=${asc}&bankuai=hs_a`;
    const rows = await fetchJson(url, SINA_HEADERS, 9000);
    const items = (rows || [])
      .map((d) => {
        const ids = sinaSecidFromSymbol(d.symbol);
        const price = num(d.trade);
        const pct = num(d.changeratio) === null ? null : num(d.changeratio) * 100;
        const amount = num(d.amount);
        const main = num(d.netamount);
        return baseQuote({
          group: 'stock',
          ...ids,
          name: d.name || '',
          price,
          pct,
          change: price !== null && pct !== null ? (price * (pct / 100)) / (1 + pct / 100) : null,
          amount,
          amountYi: amount === null ? null : round(amount / 1e8, 2),
          main,
          mainYi: main === null ? null : round(main / 1e8, 2),
          mainPct: num(d.ratioamount) === null ? null : num(d.ratioamount) * 100,
        });
      })
      .filter((q) => q.price !== null);
    return { type, items, updatedAt: Date.now(), source: 'sina' };
  }

  const sort = type === 'amount' ? 'amount' : 'changepercent';
  const asc = type === 'loss' ? 1 : 0;
  const url =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
    `?page=1&num=${n}&sort=${sort}&asc=${asc}&node=hs_a&symbol=&_s_r_a=page`;
  const rows = await fetchJson(url, SINA_HEADERS, 9000);
  const items = (rows || [])
    .map((d) => {
      const ids = sinaSecidFromSymbol(d.symbol);
      const price = num(d.trade);
      return baseQuote({
        group: 'stock',
        ...ids,
        name: d.name || '',
        price,
        pct: num(d.changepercent),
        change: num(d.pricechange),
        amount: num(d.amount),
        amountYi: num(d.amount) === null ? null : round(num(d.amount) / 1e8, 2),
        high: num(d.high),
        low: num(d.low),
        open: num(d.open),
        prevClose: num(d.settlement),
        turnover: num(d.turnoverratio),
      });
    })
    .filter((q) => q.price !== null);
  return { type, items, updatedAt: Date.now(), source: 'sina' };
}

/* =========================================================
   快讯
   ========================================================= */

async function emNews(limit = 40) {
  const url =
    'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724' +
    `&fastColumn=102&sortEnd=&pageSize=${Math.min(50, limit)}&req_trace=gp${Date.now()}`;
  const json = await fetchJson(url, EM_HEADERS, 9000);
  const items = (json?.data?.fastNewsList || []).map((n) => ({
    id: n.code,
    title: n.title || '',
    summary: n.summary || '',
    time: n.showTime || '',
    stocks: n.stockList || [],
    url: n.code ? `https://finance.eastmoney.com/a/${n.code}.html` : '',
  }));
  return { items, source: 'eastmoney' };
}

async function sinaNews(limit = 40) {
  const url =
    'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=' +
    Math.min(50, limit) +
    `&page=1&r=${Date.now()}`;
  const json = await fetchJson(url, SINA_HEADERS, 9000);
  const rows = json?.result?.data || [];
  const items = rows.map((n) => ({
    id: String(n.docid || n.oid || ''),
    title: n.title || '',
    summary: n.intro || '',
    time: n.ctime ? new Date(Number(n.ctime) * 1000).toISOString() : '',
    stocks: [],
    url: n.url || '',
  }));
  return { items, source: 'sina' };
}

module.exports = {
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
  emNormalizeQuote,
  tencentSymbol,
  sinaSymbol,
  thsSymbol,
  readBoards,
};
