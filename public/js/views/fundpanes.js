/* 基金页新增子页的渲染层（v2.10.0）
   ---------------------------------------------------------------
   只负责把 state 里的数据渲染成 DOM；取数与交互仍在 app.js。
   依赖：core.js（state）、util.js（格式化/转义）、dom.js（$）、charts.js（图表）。

   本文件覆盖：
   - 基金涨跌分布（#fundDistView）
   - 板块总览（#fundThemeView，基金主题口径）
   - 场外基金四个榜（#fundOpenFundView：涨幅/跌幅/热门/ETF）
   --------------------------------------------------------------- */
import { state } from '../core.js?v=2.10.3';
import { isNum, nf, priceFmt, pctFmt, toneClass, cleanName, esc } from '../util.js?v=2.10.3';
import { $ } from '../dom.js?v=2.10.3';
import { distributionChart, themeHistoryChart, intradayChart } from '../charts.js?v=2.10.3';

/* ---------------- 基金涨跌分布 ---------------- */

function fundDistEmptyCards(label = '加载中') {
  return Array.from({ length: 4 })
    .map(() => `<div class="summary-card"><div class="sc-label">${esc(label)}</div><div class="sc-value">--</div></div>`)
    .join('');
}

function renderFundDistribution() {
  const summary = $('#fundDistSummary');
  const chart = $('#fundDistChart');
  const meta = $('#fundDistMeta');
  const dateNote = $('#fundDistDateNote');
  const note = $('#fundDistNote');
  if (!summary || !chart) return;
  const d = state.fundDist;
  if (!d) {
    summary.innerHTML = fundDistEmptyCards('基金涨跌分布');
    chart.innerHTML = '<div class="empty">正在统计全市场基金当日涨跌…</div>';
    if (meta) meta.textContent = '加载中';
    if (dateNote) dateNote.textContent = '--';
    if (note) note.textContent = '样本来自公开净值 / 场内行情，稍等几秒。';
    return;
  }
  if (d.unavailable) {
    summary.innerHTML = `<div class="summary-card" style="grid-column:1/-1"><div class="sc-label">数据暂不可用</div><div class="sc-value">--</div><div class="sc-sub">${esc(d.note || '稍后重试')}</div></div>`;
    chart.innerHTML = `<div class="empty">${esc(d.note || '基金涨跌分布暂不可用，稍后刷新重试')}</div>`;
    if (meta) meta.textContent = d.note || '暂不可用';
    return;
  }
  const total = Number(d.total) || 0;
  const up = Number(d.up) || 0;
  const down = Number(d.down) || 0;
  const flat = Number(d.flat) || 0;
  const upRatio = isNum(d.upRatio) ? Number(d.upRatio) : (total ? (up / total) * 100 : null);
  const scopeLabel = d.scope === 'etf' ? 'ETF（场内）' : '权益类场外基金';
  summary.innerHTML = `
    <div class="summary-card"><div class="sc-label">上涨家数</div><div class="sc-value tone-up">${nf(up, 0)}</div><div class="sc-sub">占样本 ${isNum(upRatio) ? `${upRatio.toFixed(1)}%` : '--'}</div></div>
    <div class="summary-card"><div class="sc-label">下跌家数</div><div class="sc-value tone-down">${nf(down, 0)}</div><div class="sc-sub">平盘 ${nf(flat, 0)} 只</div></div>
    <div class="summary-card"><div class="sc-label">样本数量</div><div class="sc-value">${nf(total, 0)}</div><div class="sc-sub">${esc(scopeLabel)}</div></div>
    <div class="summary-card"><div class="sc-label">更新日</div><div class="sc-value">${esc(d.date || '--')}</div><div class="sc-sub">${d.scope === 'etf' ? '场内实时行情' : '净值日期（T+1 披露）'}</div></div>`;
  if (meta) {
    meta.textContent = `${nf(total, 0)} 只 · 涨 ${nf(up, 0)} / 跌 ${nf(down, 0)} / 平 ${nf(flat, 0)} · 更新 ${d.date || '--'}`;
  }
  if (dateNote) {
    dateNote.textContent = `样本：${scopeLabel} · 统计日 ${d.date || '--'}`;
  }
  distributionChart(chart, d.buckets || [], total);
  if (note) {
    note.textContent = d.note
      || '按每只基金「最新一期净值日涨跌幅」（ETF 为场内实时涨跌）分档统计；涨跌幅缺失或未更新净值的基金不计入。';
  }
}

/* ---------------- 板块总览（基金主题口径） ---------------- */

const FUND_THEME_SORT_LABEL = {
  day: '按当日涨跌',
  streak: '按连涨天数',
  month: '按近1月',
};

function themeValueCell(x) {
  return `<span class="${toneClass(x.avgDay)}">${pctFmt(x.avgDay)}</span>`;
}

function renderFundThemeOverview() {
  const table = $('#fundThemeTable');
  const summary = $('#fundThemeSummary');
  const meta = $('#fundThemeMeta');
  if (!table) return;
  const d = state.fundThemes;
  if (!d) {
    if (summary) {
      summary.innerHTML = Array.from({ length: 4 })
        .map(() => '<div class="summary-card"><div class="sc-label">板块总览</div><div class="sc-value">--</div><div class="sc-sub">加载中</div></div>')
        .join('');
    }
    table.innerHTML = '<tbody><tr><td><div class="empty">正在聚合基金主题板块（首次约 5~15 秒）…</div></td></tr></tbody>';
    if (meta) meta.textContent = '加载中';
    return;
  }
  if (d.unavailable) {
    if (summary) summary.innerHTML = `<div class="summary-card" style="grid-column:1/-1"><div class="sc-label">数据暂不可用</div><div class="sc-value">--</div><div class="sc-sub">${esc(d.note || '稍后重试')}</div></div>`;
    table.innerHTML = `<tbody><tr><td><div class="empty">${esc(d.note || '板块总览暂不可用')}</div></td></tr></tbody>`;
    if (meta) meta.textContent = d.note || '暂不可用';
    return;
  }
  const sortKey = state.fundThemeSort || 'day';
  const themes = [...(d.themes || [])].sort((a, b) => {
    if (sortKey === 'streak') {
      const av = a.streak === null || a.streak === undefined ? -999 : Number(a.streak);
      const bv = b.streak === null || b.streak === undefined ? -999 : Number(b.streak);
      if (bv !== av) return bv - av;
      return (Number(b.avgDay) || -999) - (Number(a.avgDay) || -999);
    }
    if (sortKey === 'month') return (Number(b.avgMonth) || -999) - (Number(a.avgMonth) || -999);
    return (Number(b.avgDay) || -999) - (Number(a.avgDay) || -999);
  });
  const upThemes = themes.filter((x) => Number(x.avgDay) > 0).length;
  const downThemes = themes.filter((x) => Number(x.avgDay) < 0).length;
  const longest = [...themes].sort((a, b) => (Number(b.streak) || 0) - (Number(a.streak) || 0))[0];
  const best = [...themes].sort((a, b) => (Number(b.avgDay) || -999) - (Number(a.avgDay) || -999))[0];
  if (meta) {
    meta.textContent = `${themes.length} 个基金主题 · 更新 ${d.date || '--'} · ${FUND_THEME_SORT_LABEL[sortKey] || ''}`;
  }
  if (summary) {
    summary.innerHTML = `
      <div class="summary-card"><div class="sc-label">上涨主题 / 下跌主题</div><div class="sc-value"><span class="tone-up">${upThemes}</span> <span class="muted">/</span> <span class="tone-down">${downThemes}</span></div><div class="sc-sub">共 ${themes.length} 个主题</div></div>
      <div class="summary-card"><div class="sc-label">当日最强主题</div><div class="sc-value">${esc(best ? best.sector : '--')}</div><div class="sc-sub ${best ? toneClass(best.avgDay) : ''}">${best ? pctFmt(best.avgDay) : '--'}</div></div>
      <div class="summary-card"><div class="sc-label">连涨最长</div><div class="sc-value">${longest && Number(longest.streak) > 0 ? `${esc(longest.sector)} · ${Number(longest.streak)} 天` : '--'}</div><div class="sc-sub">按代表 ETF 等权涨跌连续为正</div></div>
      <div class="summary-card"><div class="sc-label">覆盖基金</div><div class="sc-value">${nf(d.fundCount, 0)}</div><div class="sc-sub">ETF ${nf(d.etfCount, 0)} 只 + 场外 ${nf(d.stockCount, 0)} 只</div></div>`;
  }
  table.innerHTML = `
    <thead><tr><th>板块（主题）</th><th>当日涨跌</th><th>连涨天数</th><th>近5日</th><th>近1月</th><th>涨跌家数</th><th>基金数</th><th>代表 ETF</th></tr></thead>
    <tbody>${themes.map((x) => `<tr class="sector-row" data-fund-theme="${esc(x.sector)}">
      <td><span class="sector-name-cell"><i class="s-dot"></i>${esc(x.sector)}</span></td>
      <td class="t-chg">${themeValueCell(x)}</td>
      <td class="t-price">${Number(x.streak) > 0 ? `<span class="tone-up">${Number(x.streak)} 天</span>` : '<span class="muted">--</span>'}</td>
      <td class="t-chg ${toneClass(x.day5)}">${pctFmt(x.day5)}</td>
      <td class="t-chg ${toneClass(x.avgMonth)}">${pctFmt(x.avgMonth)}</td>
      <td class="t-dim"><span class="tone-up">${nf(x.upCount, 0)}</span> / <span class="tone-down">${nf(x.downCount, 0)}</span></td>
      <td class="t-dim">${nf(x.etfCount, 0)} + ${nf(x.fundCount, 0)}</td>
      <td class="sector-leader">${esc(x.leaderEtf ? cleanName(x.leaderEtf.name) : (x.leaderStock ? cleanName(x.leaderStock.name) : '--'))}</td>
    </tr>`).join('') || '<tr><td colspan="8"><div class="empty">暂无主题数据</div></td></tr>'}</tbody>`;
}

/** 板块总览详情抽屉：当日分时 + 历史走势 + 组内基金 */
function openFundThemeDrawer() {
  const d = state.fundThemeDetail;
  const sector = state.fundThemeSector;
  if (!d || !sector) return;
  const summary = d.summary || {};
  const intra = d.intraday || null;
  const etfs = d.etfs || [];
  const funds = d.funds || [];
  mountFundOverlay(`<div class="drawer">
    <div class="drawer-head"><div><div class="eyebrow">FUND THEME</div><h2>${esc(sector)}</h2><span class="code">基金主题板块 · ${esc(state.fundThemeDetailDate || '')}</span></div><button class="modal-close" data-close>×</button></div>
    <div class="fund-summary-grid">
      <div class="summary-card"><div class="sc-label">当日涨跌</div><div class="sc-value ${toneClass(summary.avgDay)}">${pctFmt(summary.avgDay)}</div><div class="sc-sub">组内等权</div></div>
      <div class="summary-card"><div class="sc-label">连涨天数</div><div class="sc-value">${Number(summary.streak) > 0 ? `${Number(summary.streak)} 天` : '--'}</div><div class="sc-sub">代表 ETF 等权</div></div>
      <div class="summary-card"><div class="sc-label">近5日 / 近1月</div><div class="sc-value"><span class="${toneClass(summary.day5)}">${pctFmt(summary.day5)}</span> <span class="muted">/</span> <span class="${toneClass(summary.avgMonth)}">${pctFmt(summary.avgMonth)}</span></div><div class="sc-sub">区间涨跌</div></div>
      <div class="summary-card"><div class="sc-label">覆盖基金</div><div class="sc-value">${nf(summary.fundCount, 0)}</div><div class="sc-sub">ETF ${nf(summary.etfCount, 0)} · 场外 ${nf(summary.stockCount, 0)}</div></div>
    </div>
    <div class="panel-head"><div><h3>当日涨跌图</h3><span class="muted small">代表 ETF 分时 · ${esc(intra && intra.name ? intra.name : '')}${intra && intra.date ? ` · ${esc(intra.date)}` : ''}${intra && intra.isLatestTradingDay ? '（最近交易日）' : ''}</span></div><span class="badge ${intra ? toneClass(intra.pct) : ''}">${intra && isNum(intra.pct) ? pctFmt(intra.pct) : '--'}</span></div>
    <div id="fundThemeIntraday" class="fund-theme-chart"></div>
    <div class="panel-head" style="margin-top:14px"><div><h3>历史走势</h3><span class="muted small">代表 ETF 等权归一（起点 100）</span></div><span class="badge">${esc(d.rangeLabel || '近半年')}</span></div>
    <div id="fundThemeHistory" class="fund-theme-chart"></div>
    <div class="panel-head" style="margin-top:14px"><div><h3>主题内 ETF</h3><span class="muted small">按当日涨跌</span></div><span class="badge">${etfs.length} 只</span></div>
    <div class="table-scroll"><table class="table">
      <thead><tr><th>ETF</th><th>最新</th><th>当日涨跌</th><th>成交额</th></tr></thead>
      <tbody>${etfs.map((x) => `<tr data-fund-code="${esc(x.code)}" data-fund-name="${esc(cleanName(x.name))}" data-fund-type="etf">
        <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-code">${esc(x.code)}</span></td>
        <td class="t-price">${priceFmt(x.price)}</td>
        <td class="t-chg ${toneClass(x.pct)}">${pctFmt(x.pct)}</td>
        <td class="t-dim">${isNum(x.amountYi) ? `${nf(x.amountYi, 1)} 亿` : '--'}</td>
      </tr>`).join('') || '<tr><td colspan="4"><div class="empty">暂无 ETF</div></td></tr>'}</tbody>
    </table></div>
    <div class="panel-head" style="margin-top:14px"><div><h3>主题内场外基金</h3><span class="muted small">按当日涨跌</span></div><span class="badge">${funds.length} 只</span></div>
    <div class="table-scroll"><table class="table">
      <thead><tr><th>基金</th><th>净值</th><th>当日涨跌</th><th>近1月</th><th>近1年</th></tr></thead>
      <tbody>${funds.map((x) => `<tr data-stock-fund-code="${esc(x.code)}" data-stock-fund-name="${esc(cleanName(x.name))}">
        <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-code">${esc(x.code)}</span></td>
        <td class="t-price">${nf(x.nav, 4)}</td>
        <td class="t-chg ${toneClass(x.day)}">${pctFmt(x.day)}</td>
        <td class="t-chg ${toneClass(x.month)}">${pctFmt(x.month)}</td>
        <td class="t-chg ${toneClass(x.year)}">${pctFmt(x.year)}</td>
      </tr>`).join('') || '<tr><td colspan="5"><div class="empty">暂无场外基金</div></td></tr>'}</tbody>
    </table></div>
    <p class="muted small mt12">${esc(d.note || '主题按基金名称关键词近似归类，不代表基金合同中的官方行业分类；历史走势为代表 ETF 等权归一，仅用于观察趋势。')}</p>
  </div>`, 'drawer-overlay');
  const intraEl = $('#fundThemeIntraday');
  if (intraEl) {
    if (intra && Array.isArray(intra.candles) && intra.candles.length >= 2) {
      intradayChart(intraEl, { candles: intra.candles, preClose: Number(intra.preClose) || null, fullSession: true });
    } else {
      intraEl.innerHTML = '<div class="empty">代表 ETF 分时暂不可用</div>';
    }
  }
  const histEl = $('#fundThemeHistory');
  if (histEl) {
    if (Array.isArray(d.index) && d.index.length >= 2) themeHistoryChart(histEl, d.index);
    else histEl.innerHTML = '<div class="empty">历史走势暂不可用</div>';
  }
}

/* 叠层打开（与 app.js 的 mountOverlay 同款，避免本模块反向依赖 app.js） */
function mountFundOverlay(html, kind = 'drawer-overlay') {
  const root = $('#overlayRoot');
  if (!root) return;
  root.innerHTML = `<div class="overlay ${kind}">${html}</div>`;
}

/* ---------------- 场外基金四个榜 ---------------- */

const FUND_BOARD_TAB_LABEL = {
  gain: '涨幅榜',
  loss: '跌幅榜',
  hot: '热门榜',
  etf: 'ETF 榜',
};

function fundBoardRow(x, i) {
  const isEtf = x.type === 'etf';
  const checked = (state.compareFunds || []).some((c) => c.code === x.code);
  return `<tr ${isEtf
    ? `data-fund-code="${esc(x.code)}" data-fund-name="${esc(cleanName(x.name))}" data-fund-type="etf"`
    : `data-stock-fund-code="${esc(x.code)}" data-stock-fund-name="${esc(cleanName(x.name))}"`}>
    <td class="compare-col"><input class="compare-check" type="checkbox" data-compare-code="${esc(x.code)}" data-compare-name="${esc(cleanName(x.name))}" ${checked ? 'checked' : ''}></td>
    <td class="t-dim">${i + 1}</td>
    <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-code">${esc(x.code)}</span></td>
    <td>${isEtf ? '<span class="fund-tag etf">ETF</span>' : `<span class="fund-tag open">${esc(x.typeLabel || '场外')}</span>`}</td>
    <td class="t-price">${isEtf ? priceFmt(x.price) : nf(x.nav, 4)}</td>
    <td class="t-chg ${toneClass(x.day)}">${pctFmt(x.day)}</td>
    <td class="t-chg ${toneClass(x.week)}">${pctFmt(x.week)}</td>
    <td class="t-chg ${toneClass(x.month)}">${pctFmt(x.month)}</td>
    <td class="t-chg ${toneClass(x.year)}">${pctFmt(x.year)}</td>
    <td class="sector-leader">${esc(x.sector || '--')}</td>
  </tr>`;
}

function renderFundBoard() {
  const table = $('#fundBoardTable');
  const meta = $('#fundBoardMeta');
  if (!table) return;
  const d = state.fundBoard;
  const tab = state.fundBoardTab || 'gain';
  const tabLabel = FUND_BOARD_TAB_LABEL[tab] || '涨幅榜';
  if (!d) {
    table.innerHTML = '<tbody><tr><td><div class="empty">正在拉取基金排行…</div></td></tr></tbody>';
    if (meta) meta.textContent = '加载中';
    return;
  }
  if (d.unavailable) {
    table.innerHTML = `<tbody><tr><td><div class="empty">${esc(d.note || '基金排行暂不可用')}</div></td></tr></tbody>`;
    if (meta) meta.textContent = d.note || '暂不可用';
    return;
  }
  const items = d.items || [];
  if (meta) {
    meta.textContent = `${nf(items.length, 0)} 只 · ${esc(d.date || '--')} · ${tabLabel}${d.typeLabel ? ` · ${esc(d.typeLabel)}` : ''}`;
  }
  table.innerHTML = `
    <thead><tr><th class="compare-col">对比</th><th>#</th><th>基金</th><th>类型</th><th>最新</th><th>当日涨跌</th><th>近1周</th><th>近1月</th><th>近1年</th><th>关联板块</th></tr></thead>
    <tbody>${items.map((x, i) => fundBoardRow(x, i)).join('') || '<tr><td colspan="10"><div class="empty">暂无数据</div></td></tr>'}</tbody>
    <tfoot><tr><td colspan="10"><span class="muted small">${esc(d.note || '')}</span></td></tr></tfoot>`;
}

/** 场外基金页的「已选对比」条（与股票型基金页的对比条共用 state.compareFunds） */
function renderFundBoardCompareBar() {
  const bar = $('#fundBoardCompareBar');
  if (!bar) return;
  const list = state.compareFunds || [];
  bar.hidden = state.fundView !== 'openfund';
  const count = $('#fundBoardCompareCount');
  if (count) count.textContent = list.length;
  const chips = $('#fundBoardCompareChips');
  if (chips) {
    chips.innerHTML = list
      .map((f) => `<span class="compare-chip">${esc(cleanName(f.name))}<button data-compare-remove="${esc(f.code)}">×</button></span>`)
      .join('');
  }
  const btn = $('#fundBoardCompareBtn');
  if (btn) btn.disabled = list.length < 2;
}

export {
  renderFundDistribution,
  renderFundThemeOverview,
  openFundThemeDrawer,
  renderFundBoard,
  renderFundBoardCompareBar,
};
