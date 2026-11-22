'use strict';
/**
 * 基金分析服务（v2.10.0）
 * ---------------------------------------------------------------
 * 从 server.js 抽出的「基金页新增子页」取数与纯计算：
 *   1. 基金涨跌分布      getFundDistribution(scope)
 *   2. 板块总览（主题）  getFundThemeOverview() / getFundThemeDetail({ sector })
 *   3. 场外基金四个榜    getFundBoard({ tab, type, limit })
 *   4. 当日组合 vs 上证  getFundIntradaySeries({ codes, indexSecid })
 *
 * 约定：
 * - 所有上游能力（K 线 / ETF 宇宙 / 基金榜 / 持仓穿透公式）都由 server.js 注入，
 *   本模块不直接读文件、不自己发 HTTP 请求（方便单测注入假数据）；
 * - 纯函数（分档 / 连涨天数 / 主题等权指数 / 热度分）单独导出，测试直接调。
 */

/* ---------------- 纯函数：基金涨跌分档 ---------------- */

const FUND_PCT_BUCKETS = [
  { label: '≤-5%', from: -Infinity, to: -5, tone: 'down' },
  { label: '-5~-3%', from: -5, to: -3, tone: 'down' },
  { label: '-3~-2%', from: -3, to: -2, tone: 'down' },
  { label: '-2~-1%', from: -2, to: -1, tone: 'down' },
  { label: '-1~0%', from: -1, to: 0, tone: 'down' },
  { label: '0%（平盘）', from: 0, to: 0, tone: 'flat' },
  { label: '0~1%', from: 0, to: 1, tone: 'up' },
  { label: '1~2%', from: 1, to: 2, tone: 'up' },
  { label: '2~3%', from: 2, to: 3, tone: 'up' },
  { label: '3~5%', from: 3, to: 5, tone: 'up' },
  { label: '≥5%', from: 5, to: Infinity, tone: 'up' },
];

/** 单个涨跌幅 → 分档下标（边界口径：-5 归「-5~-3%」，5 归「3~5%」，0 单独一档） */
function fundPctBucketIndex(pct) {
  const v = Number(pct);
  if (!Number.isFinite(v)) return -1;
  if (v < -5) return 0;
  if (v < -3) return 1;
  if (v < -2) return 2;
  if (v < -1) return 3;
  if (v < 0) return 4;
  if (v === 0) return 5;
  if (v <= 1) return 6;
  if (v <= 2) return 7;
  if (v <= 3) return 8;
  if (v <= 5) return 9;
  return 10;
}

function bucketFundPct(values) {
  const buckets = FUND_PCT_BUCKETS.map((b) => ({ label: b.label, tone: b.tone, count: 0 }));
  let up = 0;
  let down = 0;
  let flat = 0;
  let total = 0;
  for (const raw of Array.isArray(values) ? values : []) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const idx = fundPctBucketIndex(v);
    if (idx < 0) continue;
    buckets[idx].count += 1;
    total += 1;
    if (v > 0) up += 1;
    else if (v < 0) down += 1;
    else flat += 1;
  }
  return {
    buckets,
    up,
    down,
    flat,
    total,
    upRatio: total ? Math.round((up / total) * 1000) / 10 : null,
  };
}

/* ---------------- 纯函数：主题连涨天数 / 等权指数 ---------------- */

/**
 * 连涨天数：从最新一个交易日往前数「等权涨跌 > 0」的天数。
 * 最新一天没有任何标的行情（未知）时返回 null，而不是 0——避免把「没数据」显示成「没连涨」。
 */
function themeStreakFromSeries(dailyPctByDate, maxDays = 30) {
  const entries = dailyPctByDate instanceof Map
    ? [...dailyPctByDate.entries()]
    : Object.entries(dailyPctByDate || {});
  const rows = entries
    .map(([d, v]) => [String(d), Number(v)])
    .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}/.test(d) && Number.isFinite(v))
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  if (!(Number(last[1]) > 0)) return 0;
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && streak < maxDays; i -= 1) {
    if (Number(rows[i][1]) > 0) streak += 1;
    else break;
  }
  return streak;
}

/**
 * 多只标的 → 等权指数（起点 100）。
 * 每个交易日：取「当天有收盘且前一天也有收盘」的标的，算等权平均日涨跌，再链式累乘。
 * 这样即使某只 ETF 上市晚 / 某天缺数据，也不会把整条曲线拉平。
 */
function buildThemeIndex(seriesList) {
  const list = (Array.isArray(seriesList) ? seriesList : [])
    .map((s) => ({
      code: String((s && s.code) || ''),
      candles: ((s && s.candles) || [])
        .map((c) => ({ d: String(c.d).slice(0, 10), c: Number(c.c) }))
        .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.d) && Number.isFinite(c.c) && c.c > 0)
        .sort((a, b) => a.d.localeCompare(b.d)),
    }))
    .filter((s) => s.candles.length >= 2);
  if (!list.length) return [];
  const dates = [...new Set(list.flatMap((s) => s.candles.map((c) => c.d)))].sort();
  const byCode = list.map((s) => new Map(s.candles.map((c) => [c.d, c.c])));
  const prevClose = list.map(() => null);
  let index = 100;
  const points = [];
  for (const d of dates) {
    const rets = [];
    byCode.forEach((map, i) => {
      const c = map.get(d);
      if (!Number.isFinite(c)) return;
      const prev = prevClose[i];
      if (Number.isFinite(prev) && prev > 0) rets.push(c / prev - 1);
      prevClose[i] = c;
    });
    if (rets.length) {
      const avg = rets.reduce((s, v) => s + v, 0) / rets.length;
      index *= 1 + avg;
    }
    points.push({ d, v: Math.round(index * 100) / 100 });
  }
  return points;
}

/** 等权指数 → 日涨跌 Map（用于连涨天数与近N日） */
function dailyPctFromIndex(points) {
  const out = new Map();
  const rows = (Array.isArray(points) ? points : []).filter((p) => Number.isFinite(Number(p.v)) && Number(p.v) > 0);
  for (let i = 1; i < rows.length; i += 1) {
    const prev = Number(rows[i - 1].v);
    const cur = Number(rows[i].v);
    if (!(prev > 0)) continue;
    out.set(String(rows[i].d).slice(0, 10), Math.round(((cur - prev) / prev) * 10000) / 100);
  }
  return out;
}

/** 区间累计涨跌（%）：最近 n 个交易日，逐日复合 */
function compoundLastN(dailyPctByDate, n) {
  const rows = [...(dailyPctByDate instanceof Map ? dailyPctByDate.entries() : Object.entries(dailyPctByDate || {}))]
    .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}/.test(String(d)) && Number.isFinite(Number(v)))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .slice(-n);
  if (!rows.length) return null;
  let acc = 1;
  for (const [, v] of rows) acc *= 1 + Number(v) / 100;
  return Math.round((acc - 1) * 10000) / 100;
}

/* ---------------- 纯函数：场外基金榜 ---------------- */

/** 同一个基金的不同份额（A/C/E/人民币…）只留一只 */
function dedupeFundShares(items, scoreKey = 'week') {
  const best = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.code) continue;
    const key = String(item.baseName || item.name || item.code);
    const score = Number(item[scoreKey]);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, item);
      continue;
    }
    const prevScore = Number(prev[scoreKey]);
    if ((Number.isFinite(score) ? score : -Infinity) > (Number.isFinite(prevScore) ? prevScore : -Infinity)) {
      best.set(key, item);
    }
  }
  return [...best.values()];
}

/** 热门榜热度分：短期动量加权（无官方人气数据，页面会写明是热度代理） */
function hotFundScore(item) {
  const w = Number(item && item.week);
  const m = Number(item && item.month);
  const d = Number(item && item.day);
  return (Number.isFinite(w) ? w : 0) * 0.5
    + (Number.isFinite(m) ? m : 0) * 0.3
    + (Number.isFinite(d) ? d : 0) * 0.2;
}

/** 榜单排序：gain 降序 / loss 升序 / hot 热度分降序 / etf 涨跌降序（缺值一律排最后） */
function sortBoardItems(items, tab) {
  const list = Array.isArray(items) ? items.filter((x) => x && x.code) : [];
  const has = (x) => {
    const v = x && x.day;
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  };
  if (tab === 'hot') {
    return list.slice().sort((a, b) => hotFundScore(b) - hotFundScore(a));
  }
  const descending = tab !== 'loss';
  return list.slice().sort((a, b) => {
    const av = has(a);
    const bv = has(b);
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return descending ? Number(b.day) - Number(a.day) : Number(a.day) - Number(b.day);
  });
}

/* ---------------- 服务工厂 ---------------- */

function createFundAnalytics(deps = {}) {
  const {
    cached = (key, ttl, fn) => fn(),
    mapLimit = async (items, limit, fn) => Promise.all(items.map((x, i) => fn(x, i))),
    round = (v, d = 2) => Math.round(Number(v) * 10 ** d) / 10 ** d,
    num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null),
    today = () => new Date().toISOString().slice(0, 10),
    fundBaseName = (n) => String(n || ''),
    getKline,
    fetchEastmoneyTrends,
    getIntraday,
    getEtfUniverse,
    getEtfFlow,
    getAllEquityFunds,
    fetchFundHoldingsProfile,
    fetchFundStockRatio,
    estimateFromProfile,
    fundSecid,
    classifyFundSector,
    isEtfLike,
    fundEstimateRoute,
    STOCK_FUND_TYPES = {},
  } = deps;

  /* ---------- 基金涨跌分布 ---------- */

  async function getFundDistribution(scope = 'equity') {
    const kind = scope === 'etf' ? 'etf' : 'equity';
    return cached(`funddist:${kind}`, 300000, async () => {
      const base = { scope: kind, updatedAt: Date.now() };
      let rows = [];
      if (kind === 'etf') {
        const universe = await getEtfUniverse().catch(() => []);
        rows = (universe || [])
          .filter((x) => x && x.category !== 'money' && x.category !== 'bond' && Number.isFinite(Number(x.pct)))
          .map((x) => ({ code: x.code, name: x.name, pct: Number(x.pct), date: today() }));
      } else {
        const equity = await getAllEquityFunds().catch(() => ({ items: [] }));
        rows = (equity.items || [])
          .filter((x) => Number.isFinite(Number(x.day)))
          .map((x) => ({ code: x.code, name: x.name, pct: Number(x.day), date: String(x.date || '') }));
      }
      if (!rows.length) {
        return {
          ...base,
          unavailable: true,
          up: 0,
          down: 0,
          flat: 0,
          total: 0,
          upRatio: null,
          buckets: [],
          date: '',
          note: kind === 'etf'
            ? 'ETF 场内行情暂不可用，稍后刷新重试'
            : '基金净值榜暂不可用（东方财富排行接口异常），稍后刷新重试',
        };
      }
      const dist = bucketFundPct(rows.map((x) => x.pct));
      // 净值日取「出现次数最多」的日期：场外基金净值日并不完全统一（QDII 会滞后）
      const dateCount = new Map();
      for (const row of rows) {
        const d = String(row.date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        dateCount.set(d, (dateCount.get(d) || 0) + 1);
      }
      let date = '';
      let max = -1;
      for (const [d, n] of dateCount) {
        if (n > max) { max = n; date = d; }
      }
      return {
        ...base,
        ...dist,
        date: date || today(),
        sample: rows.length,
        note: kind === 'etf'
          ? 'ETF 为场内实时涨跌，样本为名称/类别可识别的 ETF（剔除货币与债券 ETF）。'
          : '按每只场外基金「最新一期已公布净值」的日涨跌幅分档；涨跌幅缺失或净值未更新的基金不计入。',
      };
    });
  }

  /* ---------- 板块总览（基金主题） ---------- */

  /** 主题原始池（ETF + 场外权益基金按名称关键词归类），5 分钟缓存 */
  function themeUniverse() {
    return cached('fundtheme:universe', 300000, async () => {
      const [equity, universe] = await Promise.all([
        getAllEquityFunds().catch(() => ({ items: [] })),
        getEtfUniverse().catch(() => []),
      ]);
      const groups = new Map();
      const ensure = (sector) => {
        const key = sector || '其他主题';
        if (!groups.has(key)) groups.set(key, { sector: key, etfs: [], funds: [] });
        return groups.get(key);
      };
      for (const etf of universe || []) {
        if (!etf || !etf.code || etf.category === 'money' || etf.category === 'bond') continue;
        ensure(classifyFundSector(etf.name)).etfs.push(etf);
      }
      for (const fund of equity.items || []) {
        if (!fund || !fund.code) continue;
        ensure(fund.sector || classifyFundSector(fund.name)).funds.push(fund);
      }
      for (const g of groups.values()) {
        g.etfs.sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
        g.funds.sort((a, b) => (Number(b.day) || -999) - (Number(a.day) || -999));
      }
      return {
        groups: [...groups.values()],
        etfCount: (universe || []).filter((x) => x && x.category !== 'money' && x.category !== 'bond').length,
        stockCount: (equity.items || []).length,
        updatedAt: Date.now(),
      };
    });
  }

  /** 代表 ETF 日线 → 主题等权日涨跌 / 连涨天数 / 指数 */
  async function themeSeries(group, days = 40) {
    const reps = (group.etfs || []).slice(0, 3);
    if (!reps.length) return { index: [], daily: new Map() };
    const klines = await mapLimit(reps, 3, async (etf) => {
      try {
        const secid = fundSecid(etf.code);
        if (!secid) return null;
        const k = await getKline(secid, 101, days);
        return k && Array.isArray(k.candles) && k.candles.length >= 2
          ? { code: etf.code, candles: k.candles }
          : null;
      } catch {
        return null;
      }
    });
    const valid = klines.filter(Boolean);
    const index = buildThemeIndex(valid);
    return { index, daily: dailyPctFromIndex(index), covered: valid.length };
  }

  async function getFundThemeOverview() {
    return cached('fundtheme:overview', 600000, async () => {
      const uni = await themeUniverse();
      if (!uni.groups.length) {
        return {
          unavailable: true,
          themes: [],
          fundCount: 0,
          etfCount: 0,
          stockCount: 0,
          date: '',
          updatedAt: Date.now(),
          note: '基金主题数据暂不可用（基金榜 / ETF 清单接口异常），稍后刷新重试',
        };
      }
      const themes = await mapLimit(uni.groups, 2, async (group) => {
        const { index, daily, covered } = await themeSeries(group, 40);
        const etfPct = group.etfs.map((x) => Number(x.pct)).filter((v) => Number.isFinite(v));
        const fundDay = group.funds.map((x) => Number(x.day)).filter((v) => Number.isFinite(v));
        const fundWeek = group.funds.map((x) => Number(x.week)).filter((v) => Number.isFinite(v));
        const fundMonth = group.funds.map((x) => Number(x.month)).filter((v) => Number.isFinite(v));
        const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
        const etfAvg = avg(etfPct);
        const fundAvgDay = avg(fundDay);
        const streak = themeStreakFromSeries(daily);
        const pcts = [...etfPct, ...fundDay];
        return {
          sector: group.sector,
          etfCount: group.etfs.length,
          fundCount: group.funds.length,
          upCount: pcts.filter((v) => v > 0).length,
          downCount: pcts.filter((v) => v < 0).length,
          avgDay: round(etfAvg !== null ? etfAvg : (fundAvgDay === null ? 0 : fundAvgDay), 2),
          avgWeek: avg(fundWeek) === null ? null : round(avg(fundWeek), 2),
          avgMonth: avg(fundMonth) === null ? null : round(avg(fundMonth), 2),
          streak,
          day5: compoundLastN(daily, 5),
          day20: compoundLastN(daily, 20),
          repEtfs: group.etfs.slice(0, 3).map((x) => ({
            code: x.code, name: x.name, pct: num(x.pct), amountYi: num(x.amountYi),
          })),
          seriesCovered: covered,
          leaderEtf: group.etfs[0] ? {
            code: group.etfs[0].code, name: group.etfs[0].name, pct: num(group.etfs[0].pct),
          } : null,
          leaderStock: group.funds[0] ? {
            code: group.funds[0].code, name: group.funds[0].name, day: num(group.funds[0].day),
            month: num(group.funds[0].month), year: num(group.funds[0].year),
          } : null,
          history: [...daily.entries()]
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
            .slice(-20)
            .map(([, v]) => round(v, 2)),
        };
      });
      const dateCount = new Map();
      for (const f of uni.groups.flatMap((g) => g.funds)) {
        const d = String(f.date || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dateCount.set(d, (dateCount.get(d) || 0) + 1);
      }
      let date = '';
      let max = -1;
      for (const [d, n] of dateCount) {
        if (n > max) { max = n; date = d; }
      }
      return {
        themes: themes.filter((t) => t.fundCount + t.etfCount > 0),
        fundCount: uni.stockCount,
        etfCount: uni.etfCount,
        stockCount: uni.stockCount,
        date: date || today(),
        updatedAt: Date.now(),
        note: '主题按基金名称关键词近似归类（不代表基金合同中的官方行业分类）；当日涨跌优先取组内 ETF 等权，连涨天数按代表 ETF 等权日涨跌连续为正的天数。',
      };
    });
  }

  async function getFundThemeDetail({ sector, days = 120 } = {}) {
    const name = String(sector || '').trim();
    if (!name) throw Object.assign(new Error('缺少板块名称'), { status: 400 });
    const span = Math.max(60, Math.min(250, Number(days) || 120));
    return cached(`fundtheme:detail:${name}:${span}`, 300000, async () => {
      const uni = await themeUniverse();
      const group = uni.groups.find((g) => g.sector === name);
      if (!group) throw Object.assign(new Error('没有这个基金主题'), { status: 404 });
      const reps = group.etfs.slice(0, 3);
      const series = reps.length
        ? (await mapLimit(reps, 3, async (etf) => {
            try {
              const secid = fundSecid(etf.code);
              if (!secid) return null;
              const k = await getKline(secid, 101, span);
              return k && Array.isArray(k.candles) && k.candles.length >= 2
                ? { code: etf.code, candles: k.candles }
                : null;
            } catch {
              return null;
            }
          })).filter(Boolean)
        : [];
      const index = buildThemeIndex(series);
      const daily = dailyPctFromIndex(index);
      const etfPct = group.etfs.map((x) => Number(x.pct)).filter((v) => Number.isFinite(v));
      const fundDay = group.funds.map((x) => Number(x.day)).filter((v) => Number.isFinite(v));
      const fundMonth = group.funds.map((x) => Number(x.month)).filter((v) => Number.isFinite(v));
      const avg = (arr) => (arr.length ? round(arr.reduce((s, v) => s + v, 0) / arr.length, 2) : null);
      const leader = group.etfs[0] || null;
      let intraday = null;
      if (leader && fundSecid(leader.code)) {
        const secid = fundSecid(leader.code);
        try {
          const got = await getIntraday(secid, today());
          if (got && Array.isArray(got.candles) && got.candles.length >= 2) {
            intraday = {
              secid,
              name: got.name || leader.name || '',
              preClose: num(got.preClose),
              pct: num(got.pct),
              source: got.source || '',
              points: got.points || [],
              candles: got.candles,
            };
          }
        } catch {
          intraday = null;
        }
      }
      const etfs = group.etfs
        .slice()
        .sort((a, b) => (Number(b.pct) || -999) - (Number(a.pct) || -999))
        .slice(0, 10)
        .map((x) => ({
          code: x.code, name: x.name, price: num(x.price), pct: num(x.pct),
          amountYi: num(x.amountYi), mainYi: null,
        }));
      const funds = group.funds
        .slice()
        .sort((a, b) => (Number(b.day) || -999) - (Number(a.day) || -999))
        .slice(0, 10)
        .map((x) => ({
          code: x.code, name: x.name, nav: num(x.nav), day: num(x.day),
          month: num(x.month), year: num(x.year),
        }));
      return {
        sector: name,
        date: today(),
        rangeLabel: span >= 200 ? '近1年' : span >= 100 ? '近半年' : '近季度',
        summary: {
          avgDay: round(avg(etfPct) !== null ? avg(etfPct) : (avg(fundDay) || 0), 2),
          avgMonth: avg(fundMonth),
          streak: themeStreakFromSeries(daily),
          day5: compoundLastN(daily, 5),
          day20: compoundLastN(daily, 20),
          etfCount: group.etfs.length,
          fundCount: group.funds.length,
          stockCount: group.funds.length,
        },
        index,
        intraday,
        etfs,
        funds,
        updatedAt: Date.now(),
        note: series.length
          ? `历史走势由 ${series.length} 只代表 ETF 等权合成（起点 100），仅用于观察主题趋势。`
          : '该主题暂无可用 ETF 日线，历史走势留空；当日涨跌仍按组内基金净值均值给出。',
      };
    });
  }

  /* ---------- 场外基金四个榜 ---------- */

  async function getFundBoard({ tab = 'gain', type = 'all', limit = 50 } = {}) {
    const boardTab = ['gain', 'loss', 'hot', 'etf'].includes(tab) ? tab : 'gain';
    const fundType = ['gp', 'zs', 'hh'].includes(type) ? type : 'all';
    const n = Math.max(1, Math.min(100, Number(limit) || 50));
    return cached(`fundboard:${boardTab}:${fundType}:${n}`, 120000, async () => {
      const base = { tab: boardTab, type: fundType, updatedAt: Date.now() };
      if (boardTab === 'etf') {
        const [universe, flow] = await Promise.all([
          getEtfUniverse().catch(() => []),
          getEtfFlow('inflow', 500).catch(() => ({ items: [] })),
        ]);
        const flowMap = new Map(((flow && flow.items) || []).map((x) => [String(x.code), x]));
        const items = sortBoardItems(
          (universe || [])
            .filter((x) => x && x.code && x.category !== 'money' && x.category !== 'bond')
            .map((x) => {
              const f = flowMap.get(String(x.code));
              return {
                code: x.code,
                name: x.name,
                type: 'etf',
                typeLabel: 'ETF',
                price: num(x.price),
                nav: null,
                day: num(x.pct),
                week: null,
                month: null,
                year: null,
                amountYi: num(x.amountYi),
                mainYi: f ? num(f.mainYi) : null,
                sector: classifyFundSector(x.name),
              };
            }),
          'etf',
        ).slice(0, n);
        return {
          ...base,
          items,
          count: items.length,
          date: today(),
          note: 'ETF 榜为场内实时涨跌（剔除货币与债券 ETF）；关联板块按名称关键词近似归类。',
        };
      }
      const equity = await getAllEquityFunds().catch(() => ({ items: [] }));
      let rows = (equity.items || [])
        .filter((x) => x && x.code && Number.isFinite(Number(x.day)))
        .filter((x) => (fundType === 'all' ? true : x.typeKey === fundType))
        .map((x) => ({
          code: x.code,
          name: x.name,
          baseName: fundBaseName(x.name),
          type: 'open',
          typeLabel: STOCK_FUND_TYPES[x.typeKey] || x.type || '场外',
          nav: num(x.nav),
          day: num(x.day),
          week: num(x.week),
          month: num(x.month),
          year: num(x.year),
          sector: x.sector || classifyFundSector(x.name),
          date: String(x.date || '').slice(0, 10),
        }));
      if (boardTab === 'hot') {
        // 热度代理：份额去重 + 同主题最多 2 只 + 短期动量加权
        const deduped = dedupeFundShares(rows, 'week');
        const perSector = new Map();
        const picked = [];
        for (const item of deduped.slice().sort((a, b) => hotFundScore(b) - hotFundScore(a))) {
          const key = item.sector || '其他主题';
          const used = perSector.get(key) || 0;
          if (used >= 2) continue;
          perSector.set(key, used + 1);
          picked.push(item);
          if (picked.length >= n) break;
        }
        rows = picked;
      } else {
        rows = sortBoardItems(rows, boardTab).slice(0, n);
      }
      const dateCount = new Map();
      for (const row of rows) {
        const d = String(row.date || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dateCount.set(d, (dateCount.get(d) || 0) + 1);
      }
      let date = '';
      let max = -1;
      for (const [d, c] of dateCount) {
        if (c > max) { max = c; date = d; }
      }
      return {
        ...base,
        items: rows,
        count: rows.length,
        date: date || today(),
        note: boardTab === 'hot'
          ? '没有官方人气数据：热门榜用「近1周涨幅（50%）+ 近1月（30%）+ 当日（20%）」做热度代理，并剔除同一基金的不同份额、同主题最多 2 只。'
          : '按最新一期已公布净值的日涨跌幅排序；场外基金净值 T+1，QDII 可能更滞后。',
      };
    });
  }

  /* ---------- 当日组合 vs 上证（盘中估算序列） ---------- */

  const TREND_TTL = 60000;
  const trendCache = new Map();

  async function trendsFor(secid) {
    const key = String(secid || '');
    if (!key) return null;
    const hit = trendCache.get(key);
    if (hit && Date.now() - hit.at < TREND_TTL) return hit.val;
    let val = null;
    try {
      const got = await fetchEastmoneyTrends(key, 1);
      if (got && got.preClose > 0 && Array.isArray(got.points) && got.points.length >= 2) {
        val = {
          secid: key,
          name: got.name || '',
          preClose: Number(got.preClose),
          points: got.points
            .map((p) => ({ t: String(p.t || '').slice(0, 5), v: Math.round((Number(p.p) / Number(got.preClose) - 1) * 10000) / 100 }))
            .filter((p) => /^\d{2}:\d{2}$/.test(p.t) && Number.isFinite(p.v)),
        };
      }
    } catch {
      val = hit ? hit.val : null;
    }
    trendCache.set(key, { at: Date.now(), val });
    if (trendCache.size > 200) {
      const first = trendCache.keys().next().value;
      trendCache.delete(first);
    }
    return val;
  }

  async function getFundIntradaySeries({ codes = [], indexSecid = '1.000001' } = {}) {
    const list = [...new Set((Array.isArray(codes) ? codes : []).map((c) => String(c || '').trim()).filter(Boolean))].slice(0, 8);
    if (!list.length) return { ok: true, index: null, funds: [], updatedAt: Date.now(), note: '没有持仓基金' };
    return cached(`fundintraday:${list.join(',')}:${indexSecid}`, 60000, async () => {
      const indexTrend = await trendsFor(String(indexSecid || '1.000001')).catch(() => null);
      // 先把所有需要的底层 secid 收齐，避免同一只股票被多只基金重复请求
      const plans = await mapLimit(list, 3, async (code) => {
        if (isEtfLike(code, '')) {
          return { code, route: 'etf-self', secid: fundSecid(code), profile: null };
        }
        try {
          const profile = await fetchFundHoldingsProfile(code);
          if (!profile) return { code, route: 'none', profile: null };
          const stockWeight = round(profile.stocks.reduce((s, x) => s + (Number(x.weight) || 0), 0), 2);
          const route = fundEstimateRoute({ stockWeight, etfCode: profile.etfCode, etfName: profile.etfName, name: '' });
          return { code, route, profile, stockWeight };
        } catch {
          return { code, route: 'none', profile: null };
        }
      });
      const secids = new Set();
      for (const plan of plans) {
        if (!plan.profile) {
          if (plan.secid) secids.add(plan.secid);
          continue;
        }
        if (plan.route === 'etf' && plan.profile.etfCode) {
          const sid = fundSecid(plan.profile.etfCode);
          if (sid) secids.add(sid);
        } else if (plan.route === 'holdings') {
          for (const s of plan.profile.stocks) {
            if (['0', '1', '105', '106', '107', '116'].includes(String(s.market))) secids.add(`${s.market}.${s.code}`);
          }
        }
      }
      const capped = [...secids].slice(0, 60);
      const trendMap = new Map();
      await mapLimit(capped, 6, async (sid) => {
        const t = await trendsFor(sid).catch(() => null);
        if (t) trendMap.set(sid, t);
      });
      const funds = [];
      for (const plan of plans) {
        // 场内 ETF：直接用自身分时
        if (plan.route === 'etf-self') {
          const t = trendMap.get(plan.secid);
          funds.push({
            code: plan.code,
            route: 'etf',
            name: (t && t.name) || '',
            points: t ? t.points : null,
            coverage: t ? 100 : 0,
            note: t ? '场内 ETF 实时分时' : 'ETF 分时暂不可用',
          });
          continue;
        }
        const profile = plan.profile;
        if (!profile || plan.route === 'none') {
          funds.push({ code: plan.code, route: 'none', name: '', points: null, coverage: 0, note: profile ? '未披露持仓，无法穿透估算' : '持仓数据不可用' });
          continue;
        }
        if (plan.route === 'qdii') {
          funds.push({ code: plan.code, route: 'qdii', name: '', points: null, coverage: 0, note: 'QDII 净值滞后一交易日，不做盘中估算' });
          continue;
        }
        if (plan.route === 'etf') {
          const sid = fundSecid(profile.etfCode);
          const t = sid ? trendMap.get(sid) : null;
          funds.push({
            code: plan.code,
            route: 'etf',
            name: (t && t.name) || profile.etfName || '',
            points: t ? t.points : null,
            coverage: t ? 100 : 0,
            note: t ? `按目标 ETF ${profile.etfCode} 分时穿透` : `目标 ETF ${profile.etfCode || '--'} 分时不可用`,
          });
          continue;
        }
        // holdings：逐分钟按重仓权重加权
        const stocks = profile.stocks || [];
        const series = stocks.map((s) => {
          const sid = `${s.market}.${s.code}`;
          return { code: String(s.code), weight: Number(s.weight) || 0, trend: trendMap.get(sid) || null };
        }).filter((x) => x.trend && x.trend.points.length);
        if (!series.length) {
          funds.push({ code: plan.code, route: 'holdings', name: '', points: null, coverage: 0, note: '重仓股分时不可用' });
          continue;
        }
        const alloc = await fetchFundStockRatio(plan.code).catch(() => null);
        const gatedRatio = alloc && Number.isFinite(Number(alloc.stockRatio)) && Number(alloc.stockRatio) > 20
          ? Number(alloc.stockRatio)
          : null;
        const times = [...new Set(series.flatMap((x) => x.trend.points.map((p) => p.t)))].sort();
        const maps = series.map((x) => new Map(x.trend.points.map((p) => [p.t, p.v])));
        const points = [];
        for (const t of times) {
          const pctByCode = new Map();
          series.forEach((x, i) => {
            const v = maps[i].get(t);
            if (Number.isFinite(v)) pctByCode.set(x.code, v);
          });
          const est = estimateFromProfile({
            route: 'holdings',
            profile,
            stockRatio: gatedRatio,
            pctByCode,
          });
          if (Number.isFinite(Number(est.pct))) points.push({ t, v: Number(est.pct) });
        }
        funds.push({
          code: plan.code,
          route: 'holdings',
          name: '',
          points: points.length >= 2 ? points : null,
          coverage: points.length ? Math.min(100, Math.round((series.length / Math.max(1, stocks.length)) * 100)) : 0,
          note: points.length ? `前 ${series.length} 大重仓分时穿透加权` : '重仓股分时不足，无法估算',
        });
      }
      return {
        ok: true,
        index: indexTrend ? { code: String(indexSecid || '1.000001'), name: indexTrend.name || '上证指数', points: indexTrend.points } : null,
        funds,
        updatedAt: Date.now(),
        note: '当日曲线为盘中估值序列（ETF/联接按目标 ETF 分时，重仓型按前十大重仓分时加权），QDII 与未披露持仓按 0% 平线处理；不是官方净值。',
      };
    });
  }

  return {
    getFundDistribution,
    getFundThemeOverview,
    getFundThemeDetail,
    getFundBoard,
    getFundIntradaySeries,
  };
}

module.exports = {
  createFundAnalytics,
  FUND_PCT_BUCKETS,
  fundPctBucketIndex,
  bucketFundPct,
  themeStreakFromSeries,
  buildThemeIndex,
  dailyPctFromIndex,
  compoundLastN,
  dedupeFundShares,
  hotFundScore,
  sortBoardItems,
};
