/* 全景页行情渲染（v2.4.0 从 app.js 拆出的第二个视图模块，先例见 views/funds.js）

   边界约定：
   - 只做「state → DOM」的纯渲染，不发请求、不改状态；
   - 取数（loadOverview / loadSectors / loadNews / loadWatchData）仍留在 app.js；
   - 本模块自带 getQuote / getBySecid / sessionOf / dataStamp 这些只读 state 的
     行情小工具，因此 app.js 反过来从这里 import，彼此不构成循环依赖。

   依赖：core.js（state）、util.js（格式化/转义）、dom.js（$）、charts.js（sparkline 等）。 */
import { state } from '../core.js?v=2.10.0';
import {
  esc, priceFmt, pctFmt, stockFmt, toneClass, cleanName, timeText,
  isNum, nf, yiFmt, compactAmount, safeUrl,
} from '../util.js?v=2.10.0';
import { $ } from '../dom.js?v=2.10.0';
import { sparkline, sectorFlowBar, gaugeChart, COLORS } from '../charts.js?v=2.10.0';


/* =========================================================
   行情索引（只读 state）
   ========================================================= */

/** 按代码（000001 / HSI / XAU…）取快照 */
export function getQuote(code) {
  if (!state.overview) return null;
  const all = [
    ...(state.overview.cn || []),
    ...(state.overview.global || []),
    ...(state.overview.commodities || []),
    ...(state.overview.fx || []),
  ];
  return all.find((q) => q.code === code || q.secid === code) || null;
}

/** 按 secid（1.600519 / 100.HSI…）取快照 */
export function getBySecid(secid) {
  if (!state.overview) return null;
  const all = [
    ...(state.overview.cn || []),
    ...(state.overview.global || []),
    ...(state.overview.commodities || []),
    ...(state.overview.fx || []),
  ];
  return all.find((q) => q.secid === secid) || null;
}

/** 某个 secid 属于哪个市场的交易时段 */
export function sessionOf(secid) {
  if (!state.overview) return null;
  if (/^(0|1)\.\d{6}$/.test(String(secid))) {
    return (state.overview.sessions && state.overview.sessions.cn) || null;
  }
  const q = getBySecid(secid);
  return (q && q.session) || null;
}

/**
 * 最近一个交易日的日期（YYYY-MM-DD）。
 * 行情快照在休市时停在上一个交易日收盘，必须把「哪一天、收盘还是实时」标出来，
 * 否则用户会把昨天的收盘价当成今天的实时行情。
 */
export function lastTradeDateText() {
  const ov = state.overview || {};
  if (ov.dataDate) return String(ov.dataDate);
  const series = state.heroSeries;
  if (series && series.length) return String(series[series.length - 1].d).slice(0, 10);
  return '';
}

export function dataStamp(session) {
  const s = session;
  const isOpen = s && s.state === 'open';
  if (isOpen) {
    const t = timeText(state.overview && state.overview.updatedAt);
    return { label: `实时 · ${t}`, cls: 'is-live', tip: `交易时段内，行情快照每 ${state.settings.interval} 秒刷新` };
  }
  const d = lastTradeDateText();
  const short = d ? d.slice(5) : '';
  const why = s ? s.label : '休市';
  return {
    label: short ? `上交易日 ${short} 收盘 · ${why}` : `上交易日收盘 · ${why}`,
    cls: 'is-closed',
    tip: d
      ? `当前${why}，显示的是 ${d} 收盘数据；下一个交易日开盘后自动切回实时`
      : `当前${why}，显示的是上一交易日收盘数据`,
  };
}


/* =========================================================
   跑马灯 / 指数网格 / 资产条
   ========================================================= */

export function tickerItems() {
  if (!state.overview) return [];
  const specs = [
    ['000001', '上证'],
    ['HSI', '恒生'],
    ['DJIA', '道指'],
    ['NDX', '纳指'],
    ['XAU', '伦敦金'],
    ['XAG', '伦敦银'],
    ['CL00Y', 'WTI'],
    ['USDCNH', 'USDCNH'],
    ['CN00Y', 'A50'],
    ['AU9999', '沪金'],
  ];
  return specs.map(([code, label]) => {
    const q = getQuote(code);
    return q ? { label, q } : null;
  }).filter(Boolean);
}

export function renderTicker() {
  const el = $('#tickerTrack');
  if (!el) return;
  const items = tickerItems();
  if (!items.length) return;
  const html = items.map(({ label, q }) => `
    <span class="ticker-item">
      <span class="t-name">${esc(label)}</span>
      <span class="t-price">${priceFmt(q.price)}</span>
      <span class="t-chg ${toneClass(q.pct)}">${pctFmt(q.pct)}</span>
    </span>`).join('');
  el.innerHTML = html + html;
}

export function renderIndexGrid() {
  const el = $('#indexGrid');
  if (!el || !state.overview) return;
  const cards = [
    { secid: '0.399001', name: '深证成指', code: '399001', view: 'china', mini: 'szse' },
    { secid: '0.399006', name: '创业板指', code: '399006', view: 'china', mini: 'cyb' },
    { secid: '1.000300', name: '沪深300', code: '000300', view: 'china', mini: 'hs300' },
    { secid: '1.000688', name: '科创50', code: '000688', view: 'china', mini: 'kc50' },
    { secid: '0.899050', name: '北证50', code: '899050', view: 'china', mini: 'bse50' },
    { secid: '100.HSI', name: '恒生指数', code: 'HSI', view: 'global', mini: 'hsi' },
  ];
  el.innerHTML = cards.map((card) => {
    const q = getBySecid(card.secid) || {};
    const series = state.miniSeries[card.mini] || [];
    const info = dataStamp(sessionOf(card.secid));
    return `<div class="index-card" data-index-secid="${card.secid}" data-index-view="${card.view}" title="查看 ${esc(card.name)}">
      <div class="idx-head"><span class="idx-name">${esc(card.name)}</span><span class="idx-code">${esc(card.code)}</span></div>
      <div class="idx-price ${toneClass(q.pct)}">${priceFmt(q.price)}</div>
      <div class="idx-foot">
        <span class="idx-chg ${toneClass(q.pct)}">${pctFmt(q.pct)}</span>
        ${sparkline(series, Number(q.pct) >= 0 ? COLORS.up : COLORS.down)}
      </div>
      <div class="idx-stamp ${info.cls}" title="${esc(info.tip || info.label)}">${esc(info.label)}</div>
    </div>`;
  }).join('');
}

export function renderAssetRibbon() {
  const el = $('#assetRibbon');
  if (!el || !state.overview) return;
  const specs = [
    { code: 'XAU', secid: '122.XAU', name: '伦敦金', mini: 'xau', cls: 'asset-gold' },
    { code: 'XAG', secid: '122.XAG', name: '伦敦银', mini: 'xag', cls: 'asset-silver' },
    { code: 'CL00Y', secid: '102.CL00Y', name: 'WTI 原油', mini: 'wti', cls: '' },
    { code: 'USDCNH', secid: '133.USDCNH', name: '美元/离岸人民币', mini: 'cnh', cls: '' },
    { code: 'HSI', secid: '100.HSI', name: '恒生指数', mini: 'hsi', cls: '' },
    { code: 'NDX100', secid: '100.NDX100', name: '纳指100', mini: 'ndx', cls: '' },
    { code: 'CN00Y', secid: '104.CN00Y', name: '富时A50期货', mini: 'a50', cls: '' },
  ];
  el.innerHTML = specs.map((spec) => {
    const q = getQuote(spec.code) || {};
    return `<div class="asset-card ${spec.cls}" data-asset-secid="${spec.secid}" title="${esc(spec.name)}">
      <div class="asset-top"><span class="asset-name">${esc(spec.name)}</span><span class="asset-code">${esc(spec.code)}</span></div>
      <div class="asset-price">${priceFmt(q.price)}</div>
      <div class="asset-bottom">
        <span class="asset-chg ${toneClass(q.pct)}">${pctFmt(q.pct)}</span>
        ${sparkline(state.miniSeries[spec.mini] || [], Number(q.pct) >= 0 ? COLORS.up : COLORS.down)}
      </div>
    </div>`;
  }).join('');
}


/* =========================================================
   板块资金 & 市场温度
   ========================================================= */

export function renderSectorPanel() {
  const data = state.sectors[state.sectorType];
  const kpis = $('#sectorKpis');
  const list = $('#sectorFlowList');
  const stamp = $('#sectorStamp');
  if (stamp) {
    if (!data) {
      stamp.className = 'data-stamp';
      stamp.textContent = '--';
    } else {
      const info = dataStamp(sessionOf('1.000001'));
      const tradeDate = lastTradeDateText();
      stamp.className = `data-stamp ${info.cls}`;
      // 板块资金本身没有独立日期字段：数据日取最近交易日，更新时刻取本次抓取时间。
      stamp.textContent = `${tradeDate ? `${tradeDate} 数据` : '交易日数据'} · 更新 ${timeText(data.updatedAt)}`;
      stamp.title = `板块主力资金为 ${data.type === 'concept' ? '概念' : '行业'} 口径，共 ${data.total} 个板块；数值为当日累计主力净流入`;
    }
  }
  if (kpis) {
    if (!data) {
      kpis.innerHTML = '<div class="kpi"><span class="k-label">加载中</span><span class="k-value">--</span></div>';
    } else {
      const topPct = [...data.items].sort((a, b) => b.pct - a.pct)[0];
      const topMain = data.items[0];
      kpis.innerHTML = `
        <div class="kpi"><span class="k-label">板块合计净流入</span><span class="k-value ${toneClass(data.netInflow)}">${yiFmt(data.netInflow)}</span></div>
        <div class="kpi"><span class="k-label">净流入板块</span><span class="k-value">${data.inflowCount}<span class="muted small"> / ${data.total}</span></span></div>
        <div class="kpi"><span class="k-label">领涨板块</span><span class="k-value">${esc(topPct ? topPct.name : '--')}</span></div>
        <div class="kpi"><span class="k-label">资金最强</span><span class="k-value">${esc(topMain ? topMain.name : '--')}</span></div>`;
    }
  }
  if (data) {
    const items = data.items;
    const maxAbs = Math.max(...items.slice(0, 30).map((s) => Math.abs(s.main)), 1);
    const topIn = items.filter((s) => s.main > 0).slice(0, 6);
    // 流出：先取流出最多的 6 个板块，再按流出绝对额从小到大排
    const topOut = items
      .filter((s) => s.main < 0)
      .sort((a, b) => a.main - b.main)
      .slice(0, 6)
      .sort((a, b) => Math.abs(a.main) - Math.abs(b.main));
    const rows = [...topIn, ...topOut];
    if (list) {
      list.innerHTML = rows.map((s) => {
        const width = Math.max(4, (Math.abs(s.main) / maxAbs) * 100);
        const color = s.main >= 0 ? COLORS.up : COLORS.down;
        return `<div class="flow-row" data-sector-code="${esc(s.code)}" data-sector-name="${esc(s.name)}">
          <span class="f-name">${esc(s.name)}</span>
          <span class="f-bar"><i style="width:${width}%;background:${color}"></i></span>
          <span class="f-val ${toneClass(s.main)}">${yiFmt(s.main)}</span>
          <span class="f-val ${toneClass(s.pct)}">${pctFmt(s.pct)}</span>
        </div>`;
      }).join('');
    }
    sectorFlowBar($('#sectorFlowChart'), items);
  } else {
    sectorFlowBar($('#sectorFlowChart'), []);
    if (list) list.innerHTML = '<div class="empty">正在获取板块资金流…</div>';
  }
}

export function renderPulse() {
  const a = state.advice;
  const badge = $('#pulseBadge');
  const line = $('#pulseLine');
  const dims = $('#dimList');
  const tags = $('#pulseTags');
  const stamp = $('#pulseStamp');
  if (!a) {
    if (badge) badge.textContent = '计算中';
    if (line) line.textContent = '正在聚合指数、资金、情绪与外围市场数据…';
    if (dims) dims.innerHTML = '';
    if (tags) tags.innerHTML = '';
    if (stamp) { stamp.className = 'data-stamp'; stamp.textContent = '--'; }
    return;
  }
  if (stamp) {
    const asOf = a.asOf || lastTradeDateText();
    const cell = dataStamp(sessionOf('1.000001'));
    stamp.className = `data-stamp ${cell.cls}`;
    // 市场温度是按「数据日」的指数、资金、涨跌家数算出来的，必须标清算的是哪一天。
    stamp.textContent = `${asOf ? `${asOf} 收盘口径` : '--'} · 生成 ${timeText(a.generatedAt)}`;
    stamp.title = `${cell.tip || ''}　温度分 = 趋势 / 资金 / 情绪 / 外围 四维加权；按 ${asOf || '最近交易日'} 收盘数据计算`;
  }
  if (badge) {
    badge.className = `badge tone-${a.temperature.tone}`;
    badge.textContent = `${a.temperature.label} · ${a.score} 分`;
  }
  if (line) line.textContent = a.oneLine;
  gaugeChart($('#pulseGauge'), a.score, a.temperature.tone);
  if (dims) {
    dims.innerHTML = a.dimensions.map((d) => `
      <div class="dim-row">
        <span class="d-label">${esc(d.label)}</span>
        <span class="d-track"><i class="tone-${d.tone}" style="width:${d.score}%"></i></span>
        <span class="d-score">${d.score}</span>
      </div>`).join('');
  }
  if (tags) {
    const f = a.focus.slice(0, 3).map((s) => `<span class="tag in">↑ ${esc(s.name)}</span>`);
    const v = a.avoid.slice(0, 2).map((s) => `<span class="tag out">↓ ${esc(s.name)}</span>`);
    tags.innerHTML = [...f, ...v].join('') || '<span class="tag">等待板块信号</span>';
  }
}


/* =========================================================
   快讯 / 自选 / 交易时段
   ========================================================= */

export function renderNewsList() {
  const el = $('#newsList');
  if (!el) return;
  const n = state.news;
  if (!n || !n.items || !n.items.length) {
    el.innerHTML = '<div class="empty">暂无快讯</div>';
    if ($('#newsSentiment')) $('#newsSentiment').textContent = '--';
    return;
  }
  if ($('#newsSentiment')) {
    $('#newsSentiment').textContent = `情绪 ${n.sentiment.label} · 多头 ${n.sentiment.positive} / 空头 ${n.sentiment.negative}`;
  }
  el.innerHTML = n.items.slice(0, 14).map((item) => {
    const s = item.sentiment || 0;
    const sent = s > 0 ? '<span class="sent pos">偏多</span>' : s < 0 ? '<span class="sent neg">偏空</span>' : '';
    const mood = s > 0 ? 'news-pos' : s < 0 ? 'news-neg' : 'news-neutral';
    return `<a class="news-item ${mood}" href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">
      <div class="news-meta"><span>${esc((item.time || '').slice(5, 16))}</span>${sent}</div>
      <div class="news-title">${esc(item.title)}</div>
      ${item.summary ? `<div class="news-summary">${esc(item.summary)}</div>` : ''}
    </a>`;
  }).join('');
}

export function renderDashWatch() {
  const el = $('#dashWatch');
  if (!el) return;
  const items = state.watchData && state.watchData.items ? state.watchData.items : [];
  if (!state.watchlist.length) {
    el.innerHTML = '<div class="empty">还没有自选股<br><button class="text-link mt8" data-goto="stockwatch">去添加第一只</button></div>';
    return;
  }
  if (!items.length) {
    el.innerHTML = '<div class="empty">正在加载自选行情…</div>';
    return;
  }
  const order = new Map(state.watchlist.map((w, i) => [w.secid, i]));
  const sorted = [...items].sort((a, b) => (order.get(a.quote.secid) ?? 999) - (order.get(b.quote.secid) ?? 999));
  el.innerHTML = `<div class="watch-list">${sorted.slice(0, 5).map(({ quote, advice }) => {
    const q = quote || {};
    return `<div class="watch-row" data-stock-secid="${esc(q.secid)}">
      <div><div class="w-name">${esc(cleanName(q.name))}</div><div class="w-code">${esc(q.code)}</div></div>
      <div class="w-price">${stockFmt(q.price)}</div>
      <div class="w-chg ${toneClass(q.pct)}">${pctFmt(q.pct)}${advice ? `<div class="small muted">${advice.score}分</div>` : ''}</div>
    </div>`;
  }).join('')}</div>`;
}

export function renderSessions() {
  const el = $('#sessionList');
  if (!el) return;
  const s = state.overview && state.overview.sessions;
  if (!s) { el.innerHTML = '<div class="empty">加载中…</div>'; return; }
  const rows = [
    ['沪深 A 股', 'CN', s.cn],
    ['香港市场', 'HK', s.hk],
    ['美国市场', 'US', s.us],
    ['欧洲市场', 'EU', s.eu],
    ['全球期货', 'FUT', s.futures],
  ];
  el.innerHTML = rows.map(([name, flag, info]) => `
    <div class="session-row">
      <div class="session-name"><span class="flag">${flag}</span>${name}</div>
      <div class="session-right">
        <span class="session-time">${esc(info.local || '--')}</span>
        <span class="badge ${info.state === 'open' ? 'tone-up' : info.state === 'closed' ? '' : 'tone-flat'}">${esc(info.label)}</span>
      </div>
    </div>`).join('');
}

export function renderGlobalMini() {
  const el = $('#globalMini');
  if (!el) return;
  const specs = [['HSI', '恒生'], ['NDX', '纳指'], ['XAU', '伦敦金'], ['USDCNH', 'USDCNH']];
  el.innerHTML = specs.map(([code, name]) => {
    const q = getQuote(code) || {};
    return `<div class="mini-quote">
      <div class="m-name">${name}</div>
      <div class="m-val">${priceFmt(q.price)}</div>
      <div class="m-chg ${toneClass(q.pct)}">${pctFmt(q.pct)}</div>
    </div>`;
  }).join('');
}
