/* 自选基金盈亏计算（v2.10.0，从 app.js 抽出）
   ---------------------------------------------------------------
   只做纯计算，不碰 DOM、不发请求。全部导出，供 app.js 与测试直接调用：
   - computeFundDailyPnl：逐日盈亏（按份额、从建仓日起算，天然不受申赎/加仓的市值跳变影响）
   - computeFundPnl：兼容 v2.8.0 的输出结构（rows / todayPnl / m1 / ytd / y1 / monthly）
   - fundCalendarBuckets：盈亏日历（日：周一到周五 × 1~31；月：1~12；年）
   - portfolioVsIndex：组合 vs 上证（本周 / 本月 / 今年 / 全部）
   - fundTopMovers：今日盈亏 TOP5 / 亏损 TOP5
   口径：份额按当前录入值静态加权；不含申赎费；今日盈亏用「我的持仓」同一份实时/估值价。 */
import { state, LEGACY_ADDED_DATE } from '../core.js?v=2.15.0';
import { fundHoldingRow } from './funds.js?v=2.15.0';

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** 上海时区下把时间戳 / 日期串 → YYYY-MM-DD */
function shanghaiDateKey(input = Date.now()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (k) => (parts.find((p) => p.type === k) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 上海时区下把 YYYY-MM-DD 平移 N 天（toISOString 会按 UTC 差一天，不能用） */
function shanghaiDateShift(dstr, days) {
  const base = new Date(`${String(dstr).slice(0, 10)}T12:00:00+08:00`).getTime();
  if (!Number.isFinite(base)) return String(dstr).slice(0, 10);
  return shanghaiDateKey(base + days * 86400000);
}

/** 某天是星期几：0=周日 … 6=周六（按上海时区） */
function shanghaiWeekday(dstr) {
  const t = new Date(`${String(dstr).slice(0, 10)}T12:00:00+08:00`).getTime();
  if (!Number.isFinite(t)) return 0;
  return new Date(t + 8 * 3600000).getUTCDay();
}

function normalizePoints(points) {
  return (Array.isArray(points) ? points : [])
    .map((p) => ({ d: String(p && p.d).slice(0, 10), c: Number(p && p.c) }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.d) && Number.isFinite(p.c) && p.c > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
}

function holdingStartDate(h) {
  const t = Number(h && h.addedAt);
  // v2.10.7：v2.10.0 之前的老持仓没有建仓日，统一按 2026-11-01 起算（用户 2026-11-22 要求）；
  // 以前这里返回空串 = 不做裁剪，会把建仓之前的涨跌算进盈亏，也导致盈亏日历起步日期不对。
  if (!Number.isFinite(t) || t <= 0) return LEGACY_ADDED_DATE;
  return shanghaiDateKey(t);
}

/**
 * 逐日盈亏（金额）。
 * 对每只基金：当日盈亏 = 份额 ×（当日净值 − 上一可用净值），只统计建仓日之后的日期；
 * 组合当日基准 = 上一日「已持有部分」的市值，所以新加一只基金不会把它整笔本金算成收益。
 */
function computeFundDailyPnl(seriesList, holdings) {
  const held = Object.entries(holdings || {}).filter(([, h]) => h && Number(h.shares) > 0);
  if (!held.length) return null;
  const byCode = new Map((Array.isArray(seriesList) ? seriesList : []).map((s) => [String(s.code), normalizePoints(s.points)]));
  const funds = [];
  let costValue = 0;
  for (const [code, h] of held) {
    const points = byCode.get(String(code)) || [];
    if (points.length < 2) continue;
    funds.push({
      code: String(code),
      shares: Number(h.shares),
      cost: Number(h.cost) || 0,
      start: holdingStartDate(h),
      points,
    });
    if (Number(h.cost) > 0) costValue += Number(h.cost) * Number(h.shares);
  }
  if (!funds.length) return null;
  const dates = [...new Set(funds.flatMap((f) => f.points.map((p) => p.d)))].sort();
  const maps = funds.map((f) => new Map(f.points.map((p) => [p.d, p.c])));
  const lastClose = funds.map(() => null);
  const rows = [];
  let startDate = '';
  for (const d of dates) {
    let pnl = 0;
    let mv = 0;
    let base = 0;
    let active = 0;
    funds.forEach((f, i) => {
      const inRange = !f.start || d >= f.start;
      const c = maps[i].get(d);
      const prev = lastClose[i];
      if (Number.isFinite(c)) {
        if (inRange && Number.isFinite(prev)) {
          pnl += f.shares * (c - prev);
          base += f.shares * prev;
        }
        lastClose[i] = c;
      }
      if (inRange && Number.isFinite(lastClose[i])) {
        mv += f.shares * lastClose[i];
        active += 1;
      }
    });
    if (!active) continue;
    if (!startDate) startDate = d;
    rows.push({
      d,
      pnl: round2(pnl),
      pct: base > 0 ? round2((pnl / base) * 100) : null,
      mv: round2(mv),
      base: round2(base),
      active,
    });
  }
  if (!rows.length) {
    // v2.10.6：建仓日之后还没有任何「已公布净值」（当晚录入 / 周末 / QDII 滞后 / 后台恢复持仓
    // 把建仓日原样写回）时，以前这里直接返回 null，前端会永远停在「正在计算盈亏日历…」。
    // 现在返回带 pending 的汇总：界面可以明确说「建仓后暂无新净值」，同时仍然只统计建仓日之后，
    // 绝不把建仓之前的涨跌算进盈亏。
    const lastNavDate = funds.map((f) => f.points[f.points.length - 1].d).sort().pop() || '';
    const starts = funds.map((f) => f.start).filter(Boolean).sort();
    const mv = funds.reduce((s, f) => s + f.shares * f.points[f.points.length - 1].c, 0);
    return {
      rows: [],
      funds,
      startDate: '',
      endDate: lastNavDate,
      marketValue: round2(mv),
      costValue: costValue > 0 ? round2(costValue) : null,
      holdings: funds.length,
      pending: true,
      pendingStart: starts[0] || '',
      lastNavDate,
    };
  }
  const last = rows[rows.length - 1];
  return {
    rows,
    funds,
    startDate,
    endDate: last.d,
    marketValue: last.mv,
    costValue: costValue > 0 ? round2(costValue) : null,
    holdings: funds.length,
  };
}

/** 今日实时点：用 /api/funds/watch 的实时/估值价接在序列末尾（与「我的持仓」同一时点） */
function liveFundPoint(seriesList, holdings) {
  const items = (state.fundWatchData && state.fundWatchData.items) || [];
  const byCode = new Map(items.map((x) => [String(x.code), x]));
  let total = 0;
  let covered = 0;
  for (const [code, h] of Object.entries(holdings || {})) {
    if (!h || !(Number(h.shares) > 0)) continue;
    const x = byCode.get(String(code));
    if (!x) continue;
    const price = Number(x.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    total += price * Number(h.shares);
    covered += 1;
  }
  if (!covered || !(total > 0)) return null;
  return { d: shanghaiDateKey(Date.now()), v: round2(total), covered };
}

/** 区间盈亏：从 startDate 之后（不含起点当天）累加逐日盈亏 */
function sumPnlAfter(rows, startDate) {
  let pnl = 0;
  let base = 0;
  for (const r of rows) {
    if (r.d <= startDate) continue;
    pnl += Number(r.pnl) || 0;
    if (!base && Number(r.base) > 0) base = Number(r.base);
  }
  return { pnl: round2(pnl), base };
}

/**
 * 兼容 v2.8.0 的输出结构（组合市值曲线 + 今日/近1月/今年/近1年 + 月度盈亏），
 * 但所有区间盈亏都改成「逐日盈亏累加」，不再用「期末市值 − 期初市值」（会被加仓/申赎污染）。
 */
function computeFundPnl(data, group) {
  const holdings = (group && group.holdings) || state.fundHoldings || {};
  const items = (data && data.items) || [];
  const daily = computeFundDailyPnl(items, holdings);
  // v2.10.6：daily 现在可能只有 pending（建仓后还没有新净值、没有逐日行），这种没有曲线可画
  if (!daily || !daily.rows.length) return null;
  const rows = daily.rows.map((r) => ({ d: r.d, v: r.mv }));
  // 今日实时点：净值已更新到今天 → 覆盖最后一根；否则追加一根
  const live = liveFundPoint(items, holdings);
  let liveAppended = false;
  if (live) {
    const tail = rows[rows.length - 1];
    if (tail && tail.d === live.d) rows[rows.length - 1] = { d: live.d, v: live.v };
    else if (live.d > tail.d) {
      rows.push({ d: live.d, v: live.v });
      liveAppended = true;
    }
  }
  const last = rows[rows.length - 1];
  const prevRow = rows[rows.length - 2] || null;
  const dailyLast = daily.rows[daily.rows.length - 1];
  let todayPnl = null;
  let todayPct = null;
  if (liveAppended && prevRow) {
    todayPnl = round2(live.v - prevRow.v);
    todayPct = prevRow.v > 0 ? round2((todayPnl / prevRow.v) * 100) : null;
  } else if (dailyLast) {
    todayPnl = dailyLast.pnl;
    todayPct = dailyLast.pct;
  }
  const m1Base = shanghaiDateShift(last.d, -30);
  const ytdBase = `${String(last.d).slice(0, 4)}-01-01`;
  const y1Base = shanghaiDateShift(last.d, -365);
  const m1 = sumPnlAfter(daily.rows, m1Base);
  const ytd = sumPnlAfter(daily.rows, shanghaiDateShift(ytdBase, -1));
  const y1 = sumPnlAfter(daily.rows, y1Base);
  // 月度盈亏：直接把逐日盈亏按月求和（不会把加仓当收益）
  const monthMap = new Map();
  for (const r of daily.rows) {
    const key = r.d.slice(0, 7);
    monthMap.set(key, (monthMap.get(key) || 0) + (Number(r.pnl) || 0));
  }
  const monthly = [...monthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, pnl]) => ({ label: key.slice(5), month: key, pnl: round2(pnl) }))
    .slice(-12);
  const costValue = daily.costValue;
  const firstDate = new Date(`${rows[0].d}T12:00:00+08:00`).getTime();
  const lastDate = new Date(`${last.d}T12:00:00+08:00`).getTime();
  return {
    rows,
    daily,
    costValue,
    todayPnl,
    todayPct,
    m1Pnl: m1.pnl,
    m1Pct: m1.base > 0 ? round2((m1.pnl / m1.base) * 100) : null,
    ytdPnl: ytd.pnl,
    ytdPct: ytd.base > 0 ? round2((ytd.pnl / ytd.base) * 100) : null,
    y1Pnl: y1.pnl,
    y1Pct: y1.base > 0 ? round2((y1.pnl / y1.base) * 100) : null,
    cumulative: costValue !== null ? round2(last.v - costValue) : null,
    cumulativePct: costValue ? round2(((last.v - costValue) / costValue) * 100) : null,
    monthly,
    asOf: last.d,
    marketValue: last.v,
    holdings: daily.holdings,
    missingCount: ((data && data.missing) || []).length,
    rangeDays: Math.max(0, Math.round((lastDate - firstDate) / 86400000)),
    startDate: daily.startDate,
  };
}

/**
 * 「建仓日之后还没有已公布净值」时的说明信息（有逐日数据、或没有持仓就返回 null）。
 * 供渲染层区分「净值历史不足 / 还在加载」和「确实还没到第一个净值日」。
 */
function fundPnlPending(holdings, seriesList) {
  const daily = computeFundDailyPnl(seriesList, holdings);
  return daily && daily.pending ? daily : null;
}

/* ---------------- 盈亏日历 ---------------- */

function daysInMonth(year, month) {
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

function monthKeyOf(dstr) {
  return String(dstr).slice(0, 7);
}

/**
 * 盈亏日历分桶。
 * unit='day'：按月返回「周一到周五 × 1~31 日」的格子（周末不占列）；
 * unit='month'：一年 12 个格子；unit='year'：每年一个格子。
 * metric='amount' 时给金额，'rate' 时给「当期盈亏 / 当期起点市值」。
 */
function fundCalendarBuckets(dailyRows, { unit = 'day', yearMonth = '', year = '', metric = 'amount' } = {}) {
  const rows = (Array.isArray(dailyRows) ? dailyRows : []).filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.d)));
  const pickValue = (pnl, base) => (metric === 'rate'
    ? (Number(base) > 0 ? round2((Number(pnl) / Number(base)) * 100) : null)
    : round2(pnl));
  if (unit === 'month') {
    const y = String(year || (rows.length ? rows[rows.length - 1].d.slice(0, 4) : ''));
    const tiles = Array.from({ length: 12 }, (_, i) => {
      const key = `${y}-${String(i + 1).padStart(2, '0')}`;
      const inMonth = rows.filter((r) => r.d.startsWith(key));
      const pnl = inMonth.reduce((s, r) => s + (Number(r.pnl) || 0), 0);
      const base = inMonth.length ? Number(inMonth[0].base) || 0 : 0;
      return {
        label: `${i + 1} 月`,
        month: key,
        pnl: round2(pnl),
        value: inMonth.length ? pickValue(pnl, base) : null,
        hasData: inMonth.length > 0,
      };
    });
    return { unit, year: y, tiles, years: availableYears(rows) };
  }
  if (unit === 'year') {
    const years = availableYears(rows);
    const tiles = years.map((y) => {
      const inYear = rows.filter((r) => r.d.startsWith(y));
      const pnl = inYear.reduce((s, r) => s + (Number(r.pnl) || 0), 0);
      const base = inYear.length ? Number(inYear[0].base) || 0 : 0;
      return { label: `${y} 年`, year: y, pnl: round2(pnl), value: inYear.length ? pickValue(pnl, base) : null, hasData: inYear.length > 0 };
    });
    return { unit, tiles, years };
  }
  const ym = String(yearMonth || (rows.length ? rows[rows.length - 1].d.slice(0, 7) : ''));
  const [yy, mm] = ym.split('-').map((x) => Number(x));
  const total = yy && mm ? daysInMonth(yy, mm) : 0;
  const byDay = new Map();
  for (const r of rows) if (r.d.startsWith(ym)) byDay.set(r.d, r);
  const weeks = [];
  let week = new Array(5).fill(null);
  let col = 0;
  for (let day = 1; day <= total; day += 1) {
    const dstr = `${ym}-${String(day).padStart(2, '0')}`;
    const weekday = shanghaiWeekday(dstr); // 0=周日
    if (weekday === 0 || weekday === 6) continue;
    col = weekday - 1; // 周一=0 … 周五=4
    const row = byDay.get(dstr);
    const cell = {
      day,
      d: dstr,
      isRest: false,
      hasData: Boolean(row),
      pnl: row ? round2(row.pnl) : null,
      value: row ? pickValue(row.pnl, row.base) : null,
    };
    week[col] = cell;
    if (col === 4) {
      weeks.push(week);
      week = new Array(5).fill(null);
    }
  }
  if (week.some(Boolean)) weeks.push(week);
  const monthRows = rows.filter((r) => r.d.startsWith(ym));
  const pnl = monthRows.reduce((s, r) => s + (Number(r.pnl) || 0), 0);
  const base = monthRows.length ? Number(monthRows[0].base) || 0 : 0;
  return {
    unit,
    yearMonth: ym,
    weeks,
    totalPnl: round2(pnl),
    totalValue: monthRows.length ? pickValue(pnl, base) : null,
    years: availableYears(rows),
    months: availableMonths(rows),
  };
}

function availableYears(rows) {
  return [...new Set(rows.map((r) => String(r.d).slice(0, 4)))].sort();
}

function availableMonths(rows) {
  return [...new Set(rows.map((r) => String(r.d).slice(0, 7)))].sort();
}

/* ---------------- 组合 vs 上证 ---------------- */

function indexPointsOf(data) {
  return normalizePoints(((data && data.index && data.index.points) || []).map((p) => ({ d: p.d, c: p.c })));
}

const RANGE_LABEL = { today: '当日', week: '本周', month: '本月', year: '今年', all: '全部' };

function rangeBaseDate(dailyRows, lastDate, range) {
  const rows = Array.isArray(dailyRows) ? dailyRows : [];
  if (!rows.length || !lastDate) return '';
  const first = rows[0].d;
  if (range === 'all') return first;
  if (range === 'week') {
    const weekday = shanghaiWeekday(lastDate); // 0=周日
    const offset = weekday === 0 ? 6 : weekday - 1;
    const monday = shanghaiDateShift(lastDate, -offset);
    const before = rows.filter((r) => r.d < monday).map((r) => r.d);
    return before.length ? before[before.length - 1] : first;
  }
  if (range === 'month') {
    const monthStart = `${lastDate.slice(0, 7)}-01`;
    const before = rows.filter((r) => r.d < monthStart).map((r) => r.d);
    return before.length ? before[before.length - 1] : first;
  }
  if (range === 'year') {
    const yearStart = `${lastDate.slice(0, 4)}-01-01`;
    const before = rows.filter((r) => r.d < yearStart).map((r) => r.d);
    return before.length ? before[before.length - 1] : first;
  }
  return first;
}

/**
 * 组合 vs 上证（日线档）。
 * 组合收益率用「逐日盈亏率」链式复合（加仓当天不会把新本金算成收益），
 * 上证用区间首尾收盘比；两者都从同一基准日开始，超额 = 我的 − 上证（百分点）。
 */
function portfolioVsIndex(data, range = 'all') {
  const calc = data ? computeFundDailyPnl(data.items || [], state.fundHoldings) : null;
  const rows = (calc && calc.rows) || [];
  if (!rows.length) return null;
  const lastDate = rows[rows.length - 1].d;
  const baseDate = rangeBaseDate(rows, lastDate, range);
  const idx = indexPointsOf(data);
  const idxBase = (() => {
    if (!idx.length) return null;
    const before = idx.filter((p) => p.d <= baseDate);
    return before.length ? before[before.length - 1] : idx[0];
  })();
  // 组合：逐日涨跌率链式复合（起点为 baseDate，之后才计入），避免加仓把本金算成收益
  const after = rows.filter((r) => r.d > baseDate);
  const prefix = new Map(); // d → 截至该日的累计收益率（%）
  let acc = 1;
  prefix.set(baseDate, 0);
  for (const r of after) {
    acc *= 1 + (Number(r.pct) || 0) / 100;
    prefix.set(r.d, Math.round((acc - 1) * 10000) / 100);
  }
  const points = [];
  let lastMe = 0;
  for (const p of idx) {
    if (idxBase && p.d < idxBase.d) continue;
    let me = lastMe;
    for (const r of after) {
      if (r.d <= p.d) me = prefix.get(r.d) ?? me;
      else break;
    }
    lastMe = me;
    const idxPct = idxBase && idxBase.c > 0 ? round2((p.c / idxBase.c - 1) * 100) : null;
    points.push({ d: p.d, me, index: idxPct, excess: idxPct === null ? null : round2(me - idxPct) });
  }
  if (!points.length) {
    // 上证取不到时至少给「我的」一条线
    for (const r of after) {
      points.push({ d: r.d, me: prefix.get(r.d) ?? 0, index: null, excess: null });
    }
  }
  const last = points[points.length - 1];
  const startRow = rows.find((r) => r.d === baseDate) || null;
  return {
    range,
    rangeLabel: RANGE_LABEL[range] || '区间',
    baseDate,
    baseValue: startRow ? startRow.mv : null,
    points,
    myPct: last ? last.me : null,
    indexPct: last ? last.index : null,
    excess: last ? last.excess : null,
    indexName: (data && data.index && data.index.name) || '上证指数',
    startDate: rows[0].d,
    endDate: lastDate,
  };
}

/** 当日组合 vs 上证：用盘中估算序列（/api/funds/intraday-series）按份额加权 */
function intradayVsIndex(intradayData, holdings) {
  if (!intradayData || !Array.isArray(intradayData.funds)) return null;
  const held = Object.entries(holdings || {}).filter(([, h]) => h && Number(h.shares) > 0);
  if (!held.length) return null;
  const byCode = new Map(intradayData.funds.map((f) => [String(f.code), f]));
  const weightMap = [];
  let totalWeight = 0;
  let uncovered = 0;
  for (const [code, h] of held) {
    const f = byCode.get(String(code));
    if (!f || !Array.isArray(f.points) || !f.points.length) {
      uncovered += 1;
      continue;
    }
    const w = Number(h.shares);
    if (!(w > 0)) continue;
    weightMap.push({ code: String(code), w, points: new Map(f.points.map((p) => [String(p.t), Number(p.v)])) });
    totalWeight += w;
  }
  if (!weightMap.length) return null;
  const times = [...new Set(weightMap.flatMap((x) => [...x.points.keys()]))].sort();
  const points = [];
  for (const t of times) {
    let acc = 0;
    for (const item of weightMap) {
      const v = item.points.get(t);
      if (Number.isFinite(v)) acc += v * item.w;
    }
    points.push({ t, v: round2(acc / totalWeight) });
  }
  const index = intradayData.index && Array.isArray(intradayData.index.points)
    ? intradayData.index.points.map((p) => ({ t: String(p.t), v: Number(p.v) })).filter((p) => Number.isFinite(p.v))
    : [];
  const lastMe = points.length ? points[points.length - 1].v : null;
  const lastIdx = index.length ? index[index.length - 1].v : null;
  return {
    points,
    indexPoints: index,
    myPct: lastMe,
    indexPct: lastIdx,
    excess: Number.isFinite(lastMe) && Number.isFinite(lastIdx) ? round2(lastMe - lastIdx) : null,
    coverage: held.length ? round2(((held.length - uncovered) / held.length) * 100) : 0,
    uncovered,
    endTime: points.length ? points[points.length - 1].t : '',
    indexName: (intradayData.index && intradayData.index.name) || '上证指数',
  };
}

/* ---------------- 今日盈亏 TOP5 / 亏损 TOP5 ---------------- */

function fundTopMovers(items, holdings, n = 5) {
  const list = Array.isArray(items) ? items : [];
  const totalMv = list.reduce((s, x) => {
    if (!getHoldingOf(holdings, x.code)) return s;
    const r = fundHoldingRow(x);
    return s + (Number(r.marketValue) || 0);
  }, 0);
  const rows = [];
  for (const x of list) {
    if (!getHoldingOf(holdings, x.code)) continue;
    const r = fundHoldingRow(x);
    if (r.dayProfit === null || r.dayProfit === undefined) continue;
    rows.push({
      code: String(x.code),
      name: x.name || String(x.code),
      type: x.type || 'open',
      dayProfit: round2(r.dayProfit),
      dayPct: Number.isFinite(Number(x.pct)) ? Number(x.pct) : null,
      marketValue: r.marketValue,
      weight: totalMv > 0 && Number.isFinite(Number(r.marketValue)) ? round2((Number(r.marketValue) / totalMv) * 100) : null,
    });
  }
  const winners = rows.filter((r) => r.dayProfit > 0).sort((a, b) => b.dayProfit - a.dayProfit).slice(0, n);
  const losers = rows.filter((r) => r.dayProfit < 0).sort((a, b) => a.dayProfit - b.dayProfit).slice(0, n);
  return {
    winners,
    losers,
    hasWinners: winners.length > 0,
    total: rows.length,
    pending: Math.max(0, Object.values(holdings || {}).filter((h) => h && Number(h.shares) > 0).length - rows.length),
  };
}

function getHoldingOf(holdings, code) {
  const h = holdings && holdings[String(code)];
  if (!h) return null;
  const shares = Number(h.shares);
  return shares > 0 ? h : null;
}

// v2.11.0：rangeBaseDate / sumPnlAfter 供模拟盘盈亏日历复用同一套区间口径
export {
  round2,
  shanghaiDateKey,
  shanghaiDateShift,
  shanghaiWeekday,
  computeFundDailyPnl,
  computeFundPnl,
  fundPnlPending,
  liveFundPoint,
  fundCalendarBuckets,
  portfolioVsIndex,
  intradayVsIndex,
  fundTopMovers,
  holdingStartDate,
  rangeBaseDate,
  sumPnlAfter,
};
