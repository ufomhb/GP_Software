/* 自选基金面板渲染（v2.10.0）
   ---------------------------------------------------------------
   只负责 DOM：多份持仓 TAB、今日盈亏 TOP5、盈亏日历、组合 vs 上证。
   取数仍在 app.js；纯计算在 views/fundpnl.js。 */
import { state, LEGACY_ADDED_DATE } from '../core.js?v=2.15.5';
import { isNum, nf, pctFmt, signedFmt, toneClass, cleanName, esc, setNoteTip } from '../util.js?v=2.15.5';
import { $, $$ } from '../dom.js?v=2.15.5';
import { dualSeriesChart, intradayCompareChart } from '../charts.js?v=2.15.5';
import { fundDayBasis } from './funds.js?v=2.15.5';
import {
  computeFundDailyPnl,
  fundCalendarBuckets,
  portfolioVsIndex,
  intradayVsIndex,
  fundTopMovers,
} from './fundpnl.js?v=2.15.5';
import { calendarGridHtml } from './pnlcalendar.js?v=2.15.5';

export function activePortfolio() {
  const list = state.portfolios || [];
  return list.find((g) => g.id === state.activePortfolioId) || list.find((g) => g.isDefault) || list[0] || null;
}

export function activeHoldings() {
  const group = activePortfolio();
  return (group && group.holdings) || state.fundHoldings || {};
}

export function renderPortfolioTabs() {
  const el = $('#fundPortfolioTabs');
  if (!el) return;
  const list = state.portfolios && state.portfolios.length
    ? state.portfolios
    : [{ id: 'default', name: '主持仓', isDefault: true, holdings: state.fundHoldings || {} }];
  const active = activePortfolio();
  const tabs = list.map((g) => {
    const count = Object.values(g.holdings || {}).filter((h) => h && Number(h.shares) > 0).length;
    return `<button class="fund-portfolio-tab ${g.id === (active && active.id) ? 'is-active' : ''}" data-portfolio-tab="${esc(g.id)}" title="${esc(g.name)}${g.isDefault ? '（默认组合）' : ''}">${esc(g.name)}<b>${count} 只</b></button>`;
  }).join('');
  const isDefault = !active || active.isDefault;
  el.innerHTML = `${tabs}
    <div class="fund-portfolio-actions">
      <button data-portfolio-add title="新建一份独立持仓">＋ 新建</button>
      <button data-portfolio-rename ${isDefault ? 'disabled title="主持仓不能改名"' : ''}>重命名</button>
      <button data-portfolio-delete ${isDefault ? 'disabled title="主持仓不能删除"' : ''}>删除</button>
      <button data-portfolio-adjust title="在一个面板里调整当前组合每只基金的份额 / 成本，也可以删除或在后台恢复">持仓调整</button>
    </div>`;
}

const TOP_MOVERS_COPY = {
  profit: { title: '盈利 TOP5', empty: '当前没有盈利的持仓基金' },
  loss: { title: '亏损 TOP5', empty: '当前没有亏损的持仓基金' },
};

export function renderFundTopMovers() {
  const box = $('#fundTopMovers');
  if (!box) return;
  const meta = $('#fundTopMoversMeta');
  const holdings = activeHoldings();
  const heldCount = Object.values(holdings).filter((h) => h && Number(h.shares) > 0).length;
  if (!heldCount) {
    box.innerHTML = '<div class="empty">这个组合还没有持仓。在下方「我的自选基金」表格里点「仓」录入份额与成本。</div>';
    if (meta) meta.textContent = '未录持仓';
    return;
  }
  const items = (state.fundWatchData && state.fundWatchData.items) || [];
  const calc = fundTopMovers(items, holdings, 5);
  // 没有盈利时默认落到「亏损 TOP5」（用户要求）
  if (!calc.hasWinners) state.topMoversTab = 'loss';
  else if (!['profit', 'loss'].includes(state.topMoversTab)) state.topMoversTab = 'profit';
  const tab = state.topMoversTab;
  const rows = tab === 'profit' ? calc.winners : calc.losers;
  const watched = items.filter((x) => getFundHoldingIn(holdings, x.code));
  const basis = fundDayBasis(watched);
  if (meta) {
    meta.textContent = `${calc.total} 只有当日盈亏口径 · ${basis.label}${calc.pending ? ` · ${calc.pending} 只当日未出` : ''}`;
  }
  $$('#fundTopMoversSeg button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.topMovers === tab);
    if (b.dataset.topMovers === 'profit') b.textContent = `盈利 TOP5${calc.winners.length ? `（${calc.winners.length}）` : ''}`;
    if (b.dataset.topMovers === 'loss') b.textContent = `亏损 TOP5${calc.losers.length ? `（${calc.losers.length}）` : ''}`;
  });
  if (!rows.length) {
    box.innerHTML = `<div class="empty">${TOP_MOVERS_COPY[tab].empty}</div>`;
    return;
  }
  box.innerHTML = rows.map((r, i) => `<div class="fund-mover-row" data-fund-code="${esc(r.code)}" data-fund-name="${esc(cleanName(r.name))}" data-fund-type="${esc(r.type)}">
    <span class="fund-mover-rank">${i + 1}</span>
    <div class="fund-mover-name-cell"><div class="fund-mover-name">${esc(cleanName(r.name))}</div><div class="fund-mover-sub">${esc(r.code)} · 持有 ${nf(r.marketValue, 2)}</div></div>
    <span class="fund-mover-val ${toneClass(r.dayProfit)}">${signedFmt(r.dayProfit, 2)}</span>
    <span class="fund-mover-val ${toneClass(r.dayPct)}">${pctFmt(r.dayPct)}</span>
    <span class="fund-mover-val fund-mover-weight ${toneClass(null)}">${isNum(r.weight) ? `${nf(r.weight, 1)}%` : '--'}</span>
  </div>`).join('');
}

function getFundHoldingIn(holdings, code) {
  const h = holdings && holdings[String(code)];
  return h && Number(h.shares) > 0 ? h : null;
}

export function renderFundPnlCalendar() {
  const box = $('#fundPnlCalendar');
  if (!box) return;
  const meta = $('#fundPnlCalendarMeta');
  const note = $('#fundPnlCalendarNote');
  const nav = $('#fundCalendarNav');
  const holdings = activeHoldings();
  const heldCount = Object.values(holdings).filter((h) => h && Number(h.shares) > 0).length;
  const data = state.fundPnl;
  const daily = data && heldCount ? computeFundDailyPnl(data.items || [], holdings) : null;
  $$('#fundCalendarUnitSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.calendarUnit === state.pnlUnit));
  $$('#fundCalendarMetricSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.calendarMetric === state.pnlMetric));
  if (!heldCount) {
    box.innerHTML = '<div class="empty">录入持仓后，这里按日 / 月 / 年显示盈亏日历。</div>';
    if (meta) meta.textContent = '未录持仓';
    if (nav) nav.innerHTML = '';
    if (note) setNoteTip(note, '盈亏统计从「加入持仓」那天开始，不统计建仓之前的数据。');
    return;
  }
  // v2.10.6：建仓日之后还没有已公布净值（后台恢复持仓写回原建仓日 / 当晚录入 / 周末 / QDII 滞后）。
  // 以前这里会一直停在「正在计算盈亏日历…」，现在渲染建仓那个月的日历（全是 --）并写清原因；
  // 仍然只统计建仓日之后，绝不把建仓前的涨跌算进来。
  if (daily && daily.pending) {
    const unit = ['day', 'month', 'year'].includes(state.pnlUnit) ? state.pnlUnit : 'day';
    const metric = state.pnlMetric === 'rate' ? 'rate' : 'amount';
    const anchor = String(daily.pendingStart || daily.lastNavDate || '').slice(0, 7);
    const buckets = fundCalendarBuckets([], { unit, yearMonth: anchor, year: anchor.slice(0, 4), metric });
    box.innerHTML = calendarGridHtml(buckets, unit, metric);
    if (nav) nav.innerHTML = unit === 'day' && anchor ? `<b>${esc(anchor)}</b>` : '';
    if (meta) {
      meta.textContent = [
        '等待新净值',
        daily.pendingStart ? `建仓日 ${daily.pendingStart}` : '',
        daily.lastNavDate ? `最新已公布净值 ${daily.lastNavDate}` : '',
      ].filter(Boolean).join(' · ');
    }
    if (note) {
      setNoteTip(note, `建仓日${daily.pendingStart ? `（${daily.pendingStart}）` : ''}之后还没有已公布净值${daily.lastNavDate ? `（最新 ${daily.lastNavDate}）` : ''}：这段时间没有可统计的净值变动，日历会在新净值公布后自动出现；建仓之前的涨跌不计入。`);
    }
    return;
  }
  if (!daily) {
    box.innerHTML = '<div class="empty">正在计算盈亏日历：首次需要拉取净值历史，可能要 5~30 秒…</div>';
    if (meta) meta.textContent = '计算中';
    if (nav) nav.innerHTML = '';
    return;
  }
  const unit = ['day', 'month', 'year'].includes(state.pnlUnit) ? state.pnlUnit : 'day';
  const metric = state.pnlMetric === 'rate' ? 'rate' : 'amount';
  const lastDate = daily.rows[daily.rows.length - 1].d;
  if (unit === 'day' && !state.pnlYearMonth) state.pnlYearMonth = lastDate.slice(0, 7);
  if (unit === 'month' && !state.pnlCalendarYear) state.pnlCalendarYear = lastDate.slice(0, 4);
  const buckets = fundCalendarBuckets(daily.rows, {
    unit,
    yearMonth: state.pnlYearMonth,
    year: state.pnlCalendarYear,
    metric,
  });
  box.innerHTML = calendarGridHtml(buckets, unit, metric);
  if (nav) {
    if (unit === 'day') {
      nav.innerHTML = `<button data-calendar-shift="-1" title="上个月">‹</button><b>${esc(buckets.yearMonth)}</b><button data-calendar-shift="1" title="下个月">›</button>`;
    } else if (unit === 'month') {
      nav.innerHTML = `<button data-calendar-year-shift="-1" title="上一年">‹</button><b>${esc(buckets.year)}</b><button data-calendar-year-shift="1" title="下一年">›</button>`;
    } else {
      nav.innerHTML = '';
    }
  }
  const range = `${daily.startDate} → ${daily.endDate}`;
  if (meta) {
    const scopeLabel = unit === 'day' ? (buckets.yearMonth || '') : unit === 'month' ? buckets.year : '全部';
    meta.textContent = metric === 'rate'
      ? `按收益率 · ${scopeLabel} · 统计区间 ${range}`
      : `按金额 / 元 · 统计区间 ${range}`;
  }
  if (note) {
    setNoteTip(note, `统计起点 = 各基金建仓日（v2.10.0 之前没记录建仓日的老持仓统一按 ${LEGACY_ADDED_DATE} 计）；逐日盈亏 = 份额 × 当日净值变动，不含申赎费；月/年按逐日盈亏累加，收益率 = 区间盈亏 ÷ 区间起点市值。`);
  }
}

export function renderFundVsIndex() {
  const kpis = $('#fundVsIndexKpis');
  const chart = $('#fundVsIndexChart');
  const meta = $('#fundVsIndexMeta');
  const note = $('#fundVsIndexNote');
  if (!kpis || !chart) return;
  const range = ['today', 'week', 'month', 'year', 'all'].includes(state.fundRange) ? state.fundRange : 'today';
  $$('#fundRangeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.fundRange === range));
  const holdings = activeHoldings();
  const heldCount = Object.values(holdings).filter((h) => h && Number(h.shares) > 0).length;
  if (!heldCount) {
    kpis.innerHTML = '';
    chart.innerHTML = '<div class="empty">录入持仓后，这里对比「我的组合」与上证指数的区间收益。</div>';
    if (meta) meta.textContent = '未录持仓';
    if (note) note.textContent = '';
    return;
  }
  if (range === 'today') {
    const data = state.fundIntraday;
    if (!data) {
      kpis.innerHTML = '';
      chart.innerHTML = '<div class="empty">正在计算当日盘中估算曲线（首次约 10~20 秒，之后缓存 60 秒）…</div>';
      if (meta) meta.textContent = '当日 · 盘中估算';
      return;
    }
    const calc = intradayVsIndex(data, holdings);
    if (!calc) {
      kpis.innerHTML = '';
      chart.innerHTML = '<div class="empty">今日的持仓基金暂时拿不到盘中估算（QDII / 未披露持仓），先看「本周 / 本月 / 今年」口径。</div>';
      if (meta) meta.textContent = '当日 · 无可用估算';
      return;
    }
    kpis.innerHTML = vsIndexKpis(calc.myPct, calc.indexPct, calc.excess, null, calc.indexName);
    intradayCompareChart(chart, {
      indexPoints: calc.indexPoints,
      portfolioPoints: calc.points,
      primaryName: '我的组合（估算）',
      secondaryName: calc.indexName,
    });
    if (meta) meta.textContent = `当日 · 截至 ${calc.endTime || '--'} · 覆盖 ${calc.coverage}% 持仓`;
    if (note) {
      setNoteTip(note, `当日曲线为盘中估值序列：ETF/联接按目标 ETF 分时、重仓型按前十大重仓分时加权；${calc.uncovered ? `${calc.uncovered} 只（QDII / 未披露持仓）按 0% 处理；` : ''}不是官方净值，收盘后以真实净值为准。`);
    }
    return;
  }
  const data = state.fundPnl;
  if (!data) {
    kpis.innerHTML = '';
    chart.innerHTML = '<div class="empty">正在获取净值历史与上证指数…</div>';
    if (meta) meta.textContent = '加载中';
    return;
  }
  const calc = portfolioVsIndex(data, range);
  if (!calc || !calc.points.length) {
    kpis.innerHTML = '';
    chart.innerHTML = '<div class="empty">区间内没有可对比的数据（可能是还没跨过建仓日）。</div>';
    if (meta) meta.textContent = '数据不足';
    return;
  }
  kpis.innerHTML = vsIndexKpis(calc.myPct, calc.indexPct, calc.excess, calc.baseDate, calc.indexName);
  dualSeriesChart(chart, {
    primary: calc.points.map((p) => ({ d: p.d, v: p.me })),
    secondary: calc.points.map((p) => ({ d: p.d, v: p.index })),
    primaryName: '我的组合',
    secondaryName: calc.indexName,
  });
  if (meta) meta.textContent = `${calc.rangeLabel} · 基准日 ${calc.baseDate}`;
  if (note) {
    setNoteTip(note, '组合收益率按「逐日盈亏率」链式复合（中途加仓不会把本金算成收益）；上证取同区间首尾收盘；不含申赎费，份额按当前录入值静态加权。');
  }
}

function vsIndexKpis(myPct, indexPct, excess, baseDate, indexName = '上证指数') {
  const excessTone = isNum(excess) ? (excess >= 0 ? 'tone-up' : 'tone-down') : '';
  const excessText = isNum(excess)
    ? `${excess >= 0 ? '+' : ''}${Number(excess).toFixed(2)}pp`
    : '--';
  const beat = isNum(excess) ? (excess >= 0 ? '跑赢' : '跑输') : '';
  return `
    <div class="summary-card"><div class="sc-label">我的收益率</div><div class="sc-value ${toneClass(myPct)}">${pctFmt(myPct)}</div><div class="sc-sub">${baseDate ? `基准 ${esc(baseDate)}` : '区间起点'}</div></div>
    <div class="summary-card"><div class="sc-label">${esc(indexName)}</div><div class="sc-value ${toneClass(indexPct)}">${pctFmt(indexPct)}</div><div class="sc-sub">同区间涨跌</div></div>
    <div class="summary-card"><div class="sc-label">超额收益</div><div class="sc-value ${excessTone}">${excessText}</div><div class="sc-sub">${beat ? `${beat}上证 ${Math.abs(Number(excess)).toFixed(2)} 个百分点` : '缺少对比数据'}</div></div>
    <div class="summary-card"><div class="sc-label">口径</div><div class="sc-value">逐日盈亏</div><div class="sc-sub">不含申赎费 · 静态份额</div></div>`;
}
