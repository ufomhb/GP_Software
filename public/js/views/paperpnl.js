/* 模拟盘盈亏日历 / 资产曲线 / 个股累计收益（v2.11.0）
   ---------------------------------------------------------------
   只做 state → DOM 与纯计算；取数在 app.js（loadPaperPnl），账本口径在服务端
   src/services/paper-ledger.js。和自选基金共用：
   - fundCalendarBuckets：日 / 月 / 年分桶；
   - pnlcalendar.js 的 calendarGridHtml：日历网格 DOM；
   - fundPnlAreaChart / fundPnlMonthlyBars：资产曲线与月度柱。 */
import { state } from '../core.js?v=2.15.3';
import { isNum, nf, signedFmt, toneClass, cleanName, esc, timeText, setNoteTip } from '../util.js?v=2.15.3';
import { $ } from '../dom.js?v=2.15.3';
import { fundPnlAreaChart, fundPnlMonthlyBars } from '../charts.js?v=2.15.3';
import {
  round2,
  shanghaiDateKey,
  shanghaiWeekday,
  fundCalendarBuckets,
  rangeBaseDate,
  sumPnlAfter,
} from './fundpnl.js?v=2.15.3';
import { calendarGridHtml } from './pnlcalendar.js?v=2.15.3';

const CALENDAR_UNITS = ['day', 'month', 'year'];

function isWorkday(dstr) {
  const weekday = shanghaiWeekday(dstr); // 0=周日 … 6=周六
  return weekday >= 1 && weekday <= 5;
}

/**
 * 服务端逐日行（收盘口径）+ 今日实时点。
 * - 服务端已经包含今天（日线有今天的 bar）→ 用实时总资产覆盖最后一根；
 * - 服务端还没有今天 → 收盘后再补一根（工作日才补，周末不占格）。
 * paper.total 是实时总资产；pnlData.todayFlow 是今天的增量资金，不算收益。
 */
export function paperDailyRows(pnlData, paper) {
  const rows = ((pnlData && pnlData.rows) || [])
    .filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.d)))
    .map((r) => ({
      d: String(r.d),
      pnl: round2(r.pnl),
      pct: isNum(r.pct) ? round2(r.pct) : null,
      mv: round2(r.mv),
      base: round2(r.base),
      flow: round2(r.flow),
      live: false,
    }));
  if (!rows.length) return { rows, liveAppended: false, empty: true };
  const total = Number(paper && paper.total);
  if (!Number.isFinite(total)) return { rows, liveAppended: false, empty: false };
  const today = shanghaiDateKey(Date.now());
  const flow = round2((pnlData && pnlData.todayFlow) || 0);
  const last = rows[rows.length - 1];
  if (last.d === today) {
    const prev = rows[rows.length - 2] || null;
    const base = prev ? prev.mv : last.base;
    const pnl = base > 0 ? total - base - flow : last.pnl;
    last.mv = round2(total);
    last.pnl = round2(pnl);
    last.pct = base > 0 ? round2((pnl / base) * 100) : null;
    last.flow = flow;
    last.live = true;
    return { rows, liveAppended: false, empty: false };
  }
  if (today > last.d && isWorkday(today)) {
    const base = last.mv;
    const pnl = total - base - flow;
    rows.push({
      d: today,
      pnl: round2(pnl),
      pct: base > 0 ? round2((pnl / base) * 100) : null,
      mv: round2(total),
      base: round2(base),
      flow,
      live: true,
    });
    return { rows, liveAppended: true, empty: false };
  }
  return { rows, liveAppended: false, empty: false };
}

/** 日 / 月 / 年分桶（直接复用基金日历的分桶实现，行结构同为 d/pnl/base） */
export function paperCalendarBuckets(rows, options = {}) {
  return fundCalendarBuckets(rows, options);
}

/** 区间盈亏：本周 / 本月 / 今年用「区间首行基准 + 逐日累加」，避免加仓把本金算成收益 */
export function paperPnlSummary(rows, pnlData, paper) {
  const list = Array.isArray(rows) ? rows : [];
  const last = list[list.length - 1] || null;
  if (!last) {
    return { todayPnl: null, todayPct: null, weekPnl: null, weekPct: null, monthPnl: null, monthPct: null, yearPnl: null, yearPct: null, cumulative: null, cumulativePct: null };
  }
  const today = shanghaiDateKey(Date.now());
  const todayRow = list.find((r) => r.d === today) || null;
  const rangeOf = (key) => {
    const base = rangeBaseDate(list, last.d, key);
    const sum = sumPnlAfter(list, base);
    return {
      pnl: sum.pnl,
      pct: sum.base > 0 ? round2((sum.pnl / sum.base) * 100) : null,
    };
  };
  const week = rangeOf('week');
  const month = rangeOf('month');
  const year = rangeOf('year');
  const profit = Number(paper && paper.profit);
  return {
    todayPnl: todayRow ? todayRow.pnl : null,
    todayPct: todayRow ? todayRow.pct : null,
    weekPnl: week.pnl,
    weekPct: week.pct,
    monthPnl: month.pnl,
    monthPct: month.pct,
    yearPnl: year.pnl,
    yearPct: year.pct,
    cumulative: Number.isFinite(profit) ? round2(profit) : null,
    cumulativePct: isNum(paper && paper.profitPct) ? round2(paper.profitPct) : null,
  };
}

function kpiCard(label, pnl, pct, sub = '') {
  const main = pnl === null || pnl === undefined ? '--' : signedFmt(pnl, 2);
  const pctText = isNum(pct) ? `${pct >= 0 ? '+' : ''}${Number(pct).toFixed(2)}%` : '';
  const tone = pnl === null || pnl === undefined || Number(pnl) === 0 ? '' : toneClass(pnl);
  return `<div class="summary-card"><div class="sc-label">${esc(label)}</div><div class="sc-value ${tone}">${main}</div><div class="sc-sub">${esc([pctText, sub].filter(Boolean).join(' · '))}</div></div>`;
}

/** 月度盈亏柱（逐日盈亏按月求和，和基金同口径） */
export function paperMonthlyBars(rows) {
  const monthMap = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const key = String(r.d || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    monthMap.set(key, (monthMap.get(key) || 0) + (Number(r.pnl) || 0));
  }
  return [...monthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, pnl]) => ({ label: key.slice(5), month: key, pnl: round2(pnl) }))
    .slice(-12);
}

export function renderPaperPnlCalendar() {
  const box = $('#paperPnlCalendar');
  if (!box) return;
  const meta = $('#paperPnlCalendarMeta');
  const note = $('#paperPnlCalendarNote');
  const nav = $('#paperCalendarNav');
  const kpis = $('#paperPnlKpis');
  const chart = $('#paperPnlChart');
  const bars = $('#paperPnlBars');
  const paper = state.paper;
  const unit = CALENDAR_UNITS.includes(state.paperCalendarUnit) ? state.paperCalendarUnit : 'day';
  const metric = state.paperCalendarMetric === 'rate' ? 'rate' : 'amount';
  const setActive = () => {
    const u = $('#paperCalendarUnitSeg');
    if (u) [...u.querySelectorAll('[data-calendar-unit]')].forEach((b) => b.classList.toggle('is-active', b.dataset.calendarUnit === unit));
    const m = $('#paperCalendarMetricSeg');
    if (m) [...m.querySelectorAll('[data-calendar-metric]')].forEach((b) => b.classList.toggle('is-active', b.dataset.calendarMetric === metric));
  };
  setActive();
  const hasTrades = Boolean(paper && Array.isArray(paper.trades) && paper.trades.length);
  if (!paper || !hasTrades) {
    if (kpis) kpis.innerHTML = '';
    box.innerHTML = '<div class="empty">还没有模拟成交：买入第一笔后，这里按日 / 月 / 年记录账户盈亏。</div>';
    if (meta) meta.textContent = '未成交';
    if (nav) nav.innerHTML = '';
    if (note) setNoteTip(note, '盈亏日历从第一笔模拟成交开始记录；卖出与持仓浮盈都计入，入金不算盈亏。');
    if (chart) chart.innerHTML = '<div class="empty small">成交后显示账户资产曲线</div>';
    if (bars) bars.innerHTML = '';
    return;
  }
  const data = state.paperPnl;
  if (data && data.error) {
    if (kpis) kpis.innerHTML = '';
    box.innerHTML = `<div class="empty">盈亏日历加载失败：${esc(data.error)}</div>`;
    if (meta) meta.textContent = '加载失败';
    if (nav) nav.innerHTML = '';
    if (note) setNoteTip(note, '稍后刷新页面重试；账户、持仓与成交记录不受影响。');
    if (chart) chart.innerHTML = '';
    if (bars) bars.innerHTML = '';
    return;
  }
  if (!data) {
    if (kpis) kpis.innerHTML = '';
    box.innerHTML = '<div class="empty">正在计算盈亏日历：首次需要拉取日线历史（最多约 3 年），可能要 5~20 秒…</div>';
    if (meta) meta.textContent = '计算中';
    if (nav) nav.innerHTML = '';
    if (note) setNoteTip(note, '逐日盈亏按「当日收盘总资产 − 上一可用日总资产 − 当日入金」计算。');
    if (chart) chart.innerHTML = '';
    if (bars) bars.innerHTML = '';
    return;
  }
  const merged = paperDailyRows(data, paper);
  if (merged.empty) {
    if (kpis) kpis.innerHTML = '';
    box.innerHTML = '<div class="empty">成交之后的交易日还没有收盘数据，明天开盘后这里会自动出现。</div>';
    if (meta) meta.textContent = '等待首个交易日收盘';
    if (nav) nav.innerHTML = '';
    if (note) setNoteTip(note, '日线取不到时按成本估值，不会把空数据算成盈亏。');
    if (chart) chart.innerHTML = '';
    if (bars) bars.innerHTML = '';
    return;
  }
  const rows = merged.rows;
  const lastDate = rows[rows.length - 1].d;
  if (unit === 'day' && !state.paperCalendarYearMonth) state.paperCalendarYearMonth = lastDate.slice(0, 7);
  if (unit === 'month' && !state.paperCalendarYear) state.paperCalendarYear = lastDate.slice(0, 4);
  const buckets = paperCalendarBuckets(rows, {
    unit,
    yearMonth: state.paperCalendarYearMonth,
    year: state.paperCalendarYear,
    metric,
  });
  box.innerHTML = calendarGridHtml(buckets, unit, metric);
  if (nav) {
    if (unit === 'day') {
      nav.innerHTML = `<button data-paper-calendar-shift="-1" title="上个月">‹</button><b>${esc(buckets.yearMonth)}</b><button data-paper-calendar-shift="1" title="下个月">›</button>`;
    } else if (unit === 'month') {
      nav.innerHTML = `<button data-paper-calendar-year-shift="-1" title="上一年">‹</button><b>${esc(buckets.year)}</b><button data-paper-calendar-year-shift="1" title="下一年">›</button>`;
    } else {
      nav.innerHTML = '';
    }
  }
  const summary = paperPnlSummary(rows, data, paper);
  if (kpis) {
    kpis.innerHTML = [
      kpiCard('今日盈亏', summary.todayPnl, summary.todayPct, merged.liveAppended || (rows[rows.length - 1] || {}).live ? '含盘中实时' : '按收盘'),
      kpiCard('本周盈亏', summary.weekPnl, summary.weekPct),
      kpiCard('本月盈亏', summary.monthPnl, summary.monthPct),
      kpiCard('今年盈亏', summary.yearPnl, summary.yearPct),
      kpiCard('累计盈亏', summary.cumulative, summary.cumulativePct, paper && paper.injected ? `本金 ${nf(paper.principal, 0)}` : ''),
    ].join('');
  }
  if (chart) {
    const points = rows.map((r) => ({ d: r.d, v: r.mv }));
    fundPnlAreaChart(chart, points, { label: '总资产', emptyText: '成交天数不足，暂时画不出资产曲线' });
  }
  if (bars) fundPnlMonthlyBars(bars, paperMonthlyBars(rows));
  if (meta) {
    const scope = unit === 'day' ? buckets.yearMonth : unit === 'month' ? buckets.year : '全部';
    const range = `${rows[0].d} → ${lastDate}`;
    const flags = [
      data.estimated || data.missing && data.missing.length ? '部分持仓按成本估值' : '',
      data.truncated ? `仅统计最近 ${data.days} 个交易日` : '',
    ].filter(Boolean).join(' · ');
    meta.textContent = `${metric === 'rate' ? '按收益率' : '按金额 / 元'} · ${scope} · 区间 ${range}${flags ? ` · ${flags}` : ''}`;
  }
  if (note) {
    const parts = [
      '口径：当日盈亏 = 当日收盘总资产 − 上一可用日总资产 − 当日入金（增量资金不算收益）。',
      data.truncated ? `日线最长回看 ${data.days} 个交易日，更早的成交只影响累计、不进日历。` : '',
      'v2.12.0 起除权日按后台录入的分红除权事件入账（现金分红进现金、送转股增加股数），不再凭空出现单日浮亏。',
      data.estimated || (data.missing && data.missing.length) ? '有标的取不到日线，已按成本价估值。' : '',
    ].filter(Boolean);
    setNoteTip(note, parts.join(' '));
  }
}

export function renderPaperRealized() {
  const box = $('#paperRealizedTable');
  if (!box) return;
  const meta = $('#paperRealizedMeta');
  const note = $('#paperRealizedNote');
  const rows = ((state.paper && state.paper.realized) || []).slice();
  if (!rows.length) {
    box.innerHTML = '<div class="empty">卖出任意一只个股后，这里会记录它的累计收益金额与累计收益率（清仓后也保留）。</div>';
    if (meta) meta.textContent = '还没有卖出记录';
    if (note) setNoteTip(note, '已实现 =（卖出金额 − 佣金 − 印花税）− 卖出股数 × 移动加权成本；累计收益率 = 累计已实现 / 累计已卖出成本。');
    return;
  }
  const complete = rows.filter((r) => !r.incomplete);
  const totalRealized = round2(complete.reduce((s, r) => s + (Number(r.realized) || 0), 0));
  const totalCost = round2(complete.reduce((s, r) => s + (Number(r.costBasis) || 0), 0));
  const totalPct = totalCost > 0 ? round2((totalRealized / totalCost) * 100) : null;
  const body = rows.map((r) => {
    const tone = Number(r.realized) > 0 ? 'tone-up' : Number(r.realized) < 0 ? 'tone-down' : 'muted';
    const totalTone = Number(r.totalProfit) > 0 ? 'tone-up' : Number(r.totalProfit) < 0 ? 'tone-down' : 'muted';
    return `<tr>
      <td><span class="t-name">${esc(cleanName(r.name) || r.code || '')}</span><span class="t-sub">${esc(r.code || '')}</span>${r.holding ? ' <span class="badge">持仓中</span>' : ' <span class="badge muted">已清仓</span>'}${r.incomplete ? ' <span class="badge muted" title="更早的买入成交已不在最近 1000 笔记录里">历史不完整</span>' : ''}</td>
      <td>${nf(r.sellShares, 0)}</td>
      <td>${nf(r.sellAmount, 0)}</td>
      <td>${nf(r.costBasis, 0)}</td>
      <td class="${tone}">${signedFmt(r.realized, 2)}</td>
      <td class="${tone}">${r.realizedPct === null || r.realizedPct === undefined ? '--' : `${r.realizedPct >= 0 ? '+' : ''}${nf(r.realizedPct, 2)}%`}</td>
      <td class="${totalTone}">${r.holding ? signedFmt(r.totalProfit, 2) : '--'}</td>
      <td class="t-dim">${r.lastAt ? esc(timeText(r.lastAt)) : '--'}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="table-scroll"><table class="table paper-realized-table">
    <thead><tr><th>标的</th><th>累计卖出股数</th><th>累计卖出金额</th><th>累计成本</th><th>累计已实现</th><th>累计收益率</th><th>含浮盈总盈亏</th><th>最近卖出</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
  if (meta) {
    meta.textContent = `已统计 ${rows.length} 只${rows.length !== complete.length ? `（${rows.length - complete.length} 只历史不完整，未计入合计）` : ''} · 合计已实现 ${signedFmt(totalRealized, 2)} 元${totalPct === null ? '' : `（${totalPct >= 0 ? '+' : ''}${nf(totalPct, 2)}%）`}`;
  }
  if (note) {
    setNoteTip(note, '已实现 =（卖出金额 − 佣金 − 印花税）− 卖出股数 × 移动加权成本（买入佣金已摊进成本）；累计收益率 = 累计已实现 / 累计已卖出成本。「含浮盈总盈亏」只对仍持仓的标的显示，= 累计已实现 + 当前浮盈。');
  }
}
