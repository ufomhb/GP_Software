import {
  areaChart,
  candleChart,
  sectorFlowBar,
  sectorTreemap,
  gaugeChart,
  flowLine,
  sparkline,
  distributionChart,
  csi300RatioLine,
  indexMiniChart,
  allocationPie,
  resizeCharts,
  sealHistogram,
  auctionBars,
  timelineCumulative,
  intradayChart,
  usMiniChart,
  usIntradayChart,
  sectorCompareBar,
  usSectorFlowBar,
  fundPnlAreaChart,
  fundPnlMonthlyBars,
  themeHistoryChart,
  dualSeriesChart,
  intradayCompareChart,
  compareTrendChart,
  COLORS,
} from './charts.js?v=2.10.3';

// 纯格式化/转义工具（见 util.js）
import {
  isNum,
  nf,
  priceFmt,
  stockFmt,
  pctFmt,
  signedFmt,
  yiFmt,
  compactAmount,
  toneOf,
  toneClass,
  cleanName,
  esc,
  safeUrl,
  timeText,
} from './util.js?v=2.10.3';

// DOM 小工具与 HTTP 封装（见 dom.js / api.js）
import { $, $$, toast, debounce } from './dom.js?v=2.10.3';
import { redirectToLogin, api, apiPost } from './api.js?v=2.10.3';

// 版本号、存储键、本地存储与全局状态（见 core.js）
import {
  APP_VERSION, WATCH_KEY, ALERTS_KEY, SETTINGS_KEY, FUND_WATCH_KEY, FUND_HOLD_KEY, MONITOR_SECTORS_KEY,
  ACTIVE_PORTFOLIO_KEY,
  PORTFOLIOS_KEY,
  PORTFOLIO_META_KEY, PORTFOLIO_PENDING_KEY,
  DEFAULT_WATCH, DEFAULT_FUNDS,
  scopedKey, applyAccountScope, migrateLegacyStore, loadJSON, saveJSON,
  state, loadScopedState,
  ALERT_KINDS, ALERT_KIND_LABEL, ALERT_OP_LABEL, normalizeAlerts, isTrendAlert,
} from './core.js?v=2.10.3';

// 基金页渲染（见 views/funds.js）
import {
  fundCategoryOf,
  getFundHolding,
  fundHoldingRow,
  fundPortfolio,
  fundDayBasis,
  fundDayBasisLine,
  fundDayPctCell,
  fundEstimateCell,
  renderFundSummary,
  renderFundWatchSummary,
  renderFundWatchTable,
  renderFundHoldSummary,
  renderFundHoldTable,
} from './views/funds.js?v=2.10.3';

// 基金页新增子页渲染（v2.10.0：涨跌分布 / 板块总览 / 场外基金四榜，见 views/fundpanes.js）
import {
  renderFundDistribution,
  renderFundThemeOverview,
  openFundThemeDrawer,
  renderFundBoard,
  renderFundBoardCompareBar,
} from './views/fundpanes.js?v=2.10.3';

// 自选基金：多组合 / 今日 TOP5 / 盈亏日历 / 组合 vs 上证（v2.10.0）
import {
  renderPortfolioTabs,
  renderFundTopMovers,
  renderFundPnlCalendar,
  renderFundVsIndex,
  activePortfolio,
  activeHoldings,
} from './views/fundwatch.js?v=2.10.3';
import {
  computeFundPnl,
  computeFundDailyPnl,
  shanghaiDateShift,
  liveFundPoint,
  fundCalendarBuckets,
  portfolioVsIndex,
  intradayVsIndex,
  fundTopMovers,
} from './views/fundpnl.js?v=2.10.3';

// 全景页行情渲染（v2.4.0 从 app.js 拆出，见 views/market.js）
import {
  getQuote, getBySecid,
  sessionOf, lastTradeDateText, dataStamp,
  tickerItems, renderTicker,
  renderIndexGrid, renderAssetRibbon,
  renderSectorPanel, renderPulse,
  renderNewsList, renderDashWatch, renderSessions, renderGlobalMini,
} from './views/market.js?v=2.10.3';


/* =========================================================
   K 线显示选项（副图指标 / 复权口径）
   ========================================================= */

const INDICATOR_OPTIONS = [
  { key: 'macd', label: 'MACD' },
  { key: 'kdj', label: 'KDJ' },
  { key: 'boll', label: 'BOLL' },
  { key: 'none', label: '关' },
];
const FQT_OPTIONS = [
  { v: 0, label: '不复权' },
  { v: 1, label: '前复权' },
  { v: 2, label: '后复权' },
];
const INDICATOR_NAME = { macd: 'MACD', kdj: 'KDJ', boll: 'BOLL', none: '无副图' };
const FQT_NAME = { 0: '不复权', 1: '前复权', 2: '后复权' };

/** 当前副图指标（非法值回落 macd） */
function currentIndicator() {
  const v = state.settings.indicator;
  return ['macd', 'kdj', 'boll', 'none'].includes(v) ? v : 'macd';
}

/** 当前复权口径（0/1/2，非法值回落不复权） */
function currentFqt() {
  const v = Number(state.settings.fqt);
  return [0, 1, 2].includes(v) ? v : 0;
}

/** 复权口径的提示文案（不含前缀分隔符）；空串表示不需要提示 */
function fqtHintText(k) {
  const fq = currentFqt();
  if (fq === 0) return '';
  // 指数 / 期货本身没有复权概念，别说成「数据源缺失」
  if (k && k.fqtApplicable === false) return '该标的无复权概念';
  if (k && k.fqtApplied === false) return '数据源暂无复权序列，仅为不复权价';
  return FQT_NAME[fq];
}

/** 附加到 K 线副标题：· 前复权 / · 该标的无复权概念 … */
function fqtHint(k) {
  const text = fqtHintText(k);
  return text ? ` · ${text}` : '';
}

/** 让所有指标 / 复权分段控件与已保存的设置保持一致（页面加载与切换后都调用） */
function syncKlineSegs() {
  const ind = currentIndicator();
  const fq = currentFqt();
  $$('[data-ind]').forEach((b) => b.classList.toggle('is-active', b.dataset.ind === ind));
  $$('[data-fqt]').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.fqt) === fq));
}

/** 切换副图指标：数据没变，只重画当前可见的 K 线 */
function applyIndicator(key) {
  if (!INDICATOR_OPTIONS.some((o) => o.key === key) || currentIndicator() === key) {
    syncKlineSegs();
    return;
  }
  state.settings.indicator = key;
  saveSettings();
  syncKlineSegs();
  redrawCandles();
  toast(`副图指标：${INDICATOR_NAME[key]}`, 'info', 1600);
}

/** 切换复权口径：口径变了必须重新取数（缓存 key 已含 fqt） */
function applyFqt(v) {
  const fq = Number(v);
  if (![0, 1, 2].includes(fq) || currentFqt() === fq) {
    syncKlineSegs();
    return;
  }
  state.settings.fqt = fq;
  saveSettings();
  syncKlineSegs();
  reloadCandles();
  toast(`复权口径已切换为：${FQT_NAME[fq]}`, 'info', 1800);
}

/** 指标切换后的重绘（不重新取数） */
function redrawCandles() {
  if (state.view === 'china') renderChinaChart();
  if (state.view === 'global') loadGlobalChart(false);
  if (state.view === 'us') renderUSChart();
  if (state.view === 'commodities') renderCommodityChart();
  if (state.stockModal) renderStockModalAgain();
}

/** 复权切换后的重新取数 */
function reloadCandles() {
  if (state.view === 'china') loadChinaChart(true);
  if (state.view === 'global') loadGlobalChart(true);
  if (state.view === 'us') loadUSChart(true);
  if (state.view === 'commodities') loadCommodityChart(true);
  if (state.stockModal) renderStockModalAgain();
}


/* =========================================================
   基础工具
   ========================================================= */

const MINI_SPECS = [
  { secid: '0.399001', key: 'szse' },
  { secid: '0.399006', key: 'cyb' },
  { secid: '1.000300', key: 'hs300' },
  { secid: '1.000688', key: 'kc50' },
  { secid: '0.899050', key: 'bse50' },
  { secid: '100.HSI', key: 'hsi' },
  { secid: '100.NDX100', key: 'ndx' },
  { secid: '122.XAU', key: 'xau' },
  { secid: '122.XAG', key: 'xag' },
  { secid: '102.CL00Y', key: 'wti' },
  { secid: '104.CN00Y', key: 'a50' },
];

const REGION = {
  HSI: 'asia', HSCEI: 'asia', HSTECH: 'asia', N225: 'asia', KS11: 'asia', TWII: 'asia', AS51: 'asia',
  SENSEX: 'asia', STI: 'asia', VNINDEX: 'asia', JKSE: 'asia', XIN9: 'asia',
  GDAXI: 'europe', FTSE: 'europe', FCHI: 'europe', SX5E: 'europe', SSMI: 'europe',
  DJIA: 'america', SPX: 'america', NDX: 'america', NDX100: 'america', TSX: 'america',
  BVSP: 'america', MXX: 'america',
};

/* ---------------------------------------------------------
   本地存储按账号隔离。
   同一浏览器登录不同账号时，自选股票 / 基金 / 持仓 / 设置分别存放在
   gp.<账号id>.xxx 下，互相读不到（此前共用一个键，导致新账号登录后
   能看到上一个账号的自选股票与自选基金）。
   --------------------------------------------------------- */


function todayText() {
  return new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/* =========================================================
   状态   ========================================================= */

// 账号数据加载：登录后按当前账号的命名空间读取本地数据（由 init 调用）。

/* =========================================================
   API
   ========================================================= */
// 会话失效时统一跳登录页，并带上当前地址，登录后能回到原页面。


async function getKlineCached(secid, klt = 101, limit = 140, fqt = null) {
  // 复权口径默认跟随设置；切换复权后 key 变化，不会拿到另一口径的旧缓存。
  const fq = [0, 1, 2].includes(Number(fqt)) ? Number(fqt) : Number(state.settings.fqt) || 0;
  const key = `${secid}:${klt}:${limit}:fq${fq}`;
  const hit = state.klineCache.get(key);
  // 分时图要跟着行情刷新走，其它周期没必要频繁重取。
  const ttl = klt === 1 ? 8000 : 180000;
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await api(`/api/kline?secid=${encodeURIComponent(secid)}&klt=${klt}&limit=${limit}&fqt=${fq}`);
  state.klineCache.set(key, { at: Date.now(), data });
  return data;
}

/* =========================================================
   提示 / 弹层 / 声音
   ========================================================= */

function mountOverlay(html, className = '') {
  const root = $('#overlayRoot');
  // 新建基座会顶掉之前的所有叠加层（例如多个弹窗互跳时），避免残留挡视线
  root.innerHTML = `<div class="overlay ${className}">${html}</div>`;
  document.body.style.overflow = 'hidden';
  return $('.overlay', root);
}

/**
 * 在当前弹窗之上叠一层，**不销毁下层**。
 * v2.7.0 修复：个股详情里点「基本面 / 龙虎榜」「个股资讯」原来走 mountOverlay，
 * 会直接把 #overlayRoot 的 innerHTML 换掉——个股详情被销毁，关掉抽屉后回不到个股。
 * 改成叠加层后，上层关闭只移除自己，下层（个股详情/基金详情…）原样保留。
 * 返回上层元素，调用方应基于它做作用域查询（如 overlay.querySelector('.drawer')），
 * 否则 $('.drawer') 之类可能命中下层。
 */
function pushOverlay(html, className = '') {
  const root = $('#overlayRoot');
  const el = document.createElement('div');
  el.className = `overlay overlay-layer ${className}`.trim();
  el.innerHTML = html;
  root.appendChild(el);
  document.body.style.overflow = 'hidden';
  return el;
}

/** 当前最上层的叠加层（没有则返回 null） */
function topLayer() {
  const root = $('#overlayRoot');
  if (!root) return null;
  const layers = $$('.overlay-layer', root);
  return layers.length ? layers[layers.length - 1] : null;
}

function closeOverlay() {
  const root = $('#overlayRoot');
  if (!root) return;
  // 模拟买卖弹窗关掉后丢弃当前标的，避免异步报价回填到已经关掉的面板
  if (!$('#paperForm')) state.paperTrade = null;
  // 叠加层：只关最上面那层，下面那层（个股详情等）继续留着
  const layer = topLayer();
  if (layer) {
    layer.remove();
    return;
  }
  const wasDetail = parseHashRoute().detail;
  root.innerHTML = '';
  document.body.style.overflow = '';
  // 详情弹窗关闭后清掉「当前个股」标记，避免指标切换去重绘一个不存在的弹窗
  state.stockModal = null;
  state.usStockModal = null;
  // 地址栏退回视图级 hash，否则刷新页面还会重新弹出已经关掉的详情
  if (wasDetail) history.replaceState({ view: state.view }, '', `#${state.view}`);
}

function beep() {
  if (!state.settings.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  } catch { /* 浏览器未授权音频 */ }
}

function notify(title, body) {
  if (!state.settings.notify) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: '/favicon.ico' });
  } catch { /* 忽略 */ }
}

/* =========================================================
   顶栏 / 时钟 / 新鲜度   ========================================================= */
function renderClock() {
  const el = $('#clock');
  if (!el) return;
  const now = new Date();
  el.textContent = `${now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false })} HKT`;
  if (state.lastUpdate && state.settings.autoRefresh) {
    state.countdown = Math.max(0, state.countdown - 1);
    setFreshness(state.overview && state.overview.stale ? 'stale' : 'live', state.overview && state.overview.stale ? `缓存 · ${state.countdown}s` : `实时 · ${state.countdown}s`);
  }
}

function setFreshness(kind, text) {
  const el = $('#dataFreshness');
  if (!el) return;
  el.className = `freshness ${kind === 'live' ? 'is-live' : kind === 'stale' ? 'is-stale' : ''}`;
  el.innerHTML = `<i></i>${esc(text)}`;
}

/* ---------------------------------------------------------
   使用统计心跳：后台管理里的「使用时长 / 访问页面」来源于这里。
   - 切页时记一次 view；
   - 页面可见时每 60 秒上报一次 activeSec，后台累加使用时长。
   --------------------------------------------------------- */
let lastActivityAt = 0;
function pingActivity(event = 'active') {
  if (!state.auth) return;
  const now = Date.now();
  // 只统计页面可见期间的时间；切页/心跳共用，单次最多 120 秒，避免休眠后虚增。
  const activeSec = Math.min(120, Math.max(0, Math.round((now - lastActivityAt) / 1000)));
  lastActivityAt = now;
  fetch('/api/activity/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ view: state.view || 'dashboard', event, activeSec }),
    keepalive: true,
  }).catch(() => { /* 统计失败不影响行情 */ });
}

function startActivityPing() {
  lastActivityAt = Date.now();
  document.addEventListener('visibilitychange', () => {
    lastActivityAt = Date.now();
    if (!document.hidden) pingActivity('view');
  });
  setTimeout(() => pingActivity('view'), 1500);
  setInterval(() => {
    if (!document.hidden) pingActivity('active');
  }, 60000);
}

function renderTopSessions() {
  const el = $('#topSessions');
  if (!el) return;
  const s = state.overview && state.overview.sessions;
  if (!s) {
    el.innerHTML = '<span class="session-pill"><i class="dot"></i><b>连接中</b></span>';
    return;
  }
  const rows = [
    ['A股', s.cn],
    ['港股', s.hk],
    ['美股', s.us],
    ['期货', s.futures],
  ];
  el.innerHTML = rows.map(([name, info]) => `
    <span class="session-pill state-${info.state}" title="${esc(info.label)} · 当地时间 ${esc(info.local)}">
      <i class="dot"></i><b>${name}</b><span>${esc(info.label)}</span>
    </span>`).join('');
}

/* =========================================================
   全景：行情   ========================================================= */
async function loadOverview() {
  if (state.loading.has('overview')) return;
  state.loading.add('overview');
  try {
    const data = await api('/api/overview');
    state.overview = data;
    state.lastUpdate = Date.now();
    state.countdown = state.settings.interval;
    data.cn.forEach((q) => state.quotes.set(q.secid, q));
    data.global.forEach((q) => state.quotes.set(q.secid, q));
    data.commodities.forEach((q) => state.quotes.set(q.secid, q));
    data.fx.forEach((q) => state.quotes.set(q.secid, q));
    setFreshness(data.stale ? 'stale' : 'live', data.stale ? '缓存数据' : `实时 · ${timeText(data.updatedAt)}`);
    renderTicker();
    renderTopSessions();
    renderDashboard();
    if (state.view === 'china') renderChinaHeader();
    if (state.view === 'global') { renderGlobalTable(); renderFx(); renderGlobalSessions(); renderGlobalTemp(); }
    if (state.view === 'commodities') { renderMetalCards(); renderFuturesTables(); }
    updateConverterRates();
    checkAlerts();
    // 行情加载完成后再刷新数据源状态，避免首屏把「未检测」误显示为正常。
    loadSourceStatus(true);
  } catch (err) {
    handleLoadError('行情总览', err);
  } finally {
    state.loading.delete('overview');
  }
}

async function loadHeroSeries() {
  if (state.heroSeries) return;
  try {
    const k = await getKlineCached('1.000001', 101, 90);
    state.heroSeries = k.candles;
  } catch { /* 忽略，主图留白 */ }
}

async function loadMiniSeries() {
  if (state.miniLoaded) return;
  state.miniLoaded = true;
  for (let i = 0; i < MINI_SPECS.length; i += 2) {
    const batch = MINI_SPECS.slice(i, i + 2);
    await Promise.all(batch.map(async (spec) => {
      try {
        const k = await getKlineCached(spec.secid, 101, 40);
        state.miniSeries[spec.key] = k.candles.map((c) => c.c);
      } catch { state.miniSeries[spec.key] = []; }
    }));
  }
  renderIndexGrid();
  renderAssetRibbon();
  if (state.view === 'commodities') renderMetalCards();
}

function renderDashboard() {
  renderHero();
  renderIndexGrid();
  renderAssetRibbon();
  renderSectorPanel();
  renderPulse();
  renderNewsList();
  renderDashWatch();
  renderSessions();
  renderGlobalMini();
}

/* =========================================================
   全景：A 股基准主图
   （数据时间口径 dataStamp / sessionOf 已迁到 views/market.js）
   ========================================================= */
function renderHero() {
  const o = state.overview && state.overview.cn && state.overview.cn.find((q) => q.code === '000001');
  if (!o) return;
  const price = $('#heroPrice');
  const change = $('#heroChange');
  const tag = $('#cnSessionTag');
  if (price) price.textContent = stockFmt(o.price);
  if (change) {
    change.className = `change-pill pill-${toneOf(o.pct)}`;
    change.textContent = `${pctFmt(o.pct)}  ${signedFmt(o.change, 2)}`;
  }
  const cnSess = state.overview.sessions && state.overview.sessions.cn;
  if (tag) {
    tag.textContent = cnSess ? cnSess.label : '--';
    tag.className = `session-tag ${cnSess && cnSess.state === 'open' ? 'is-open' : ''}`;
  }
  const stamp = $('#heroStamp');
  if (stamp) {
    const info = dataStamp(cnSess);
    stamp.hidden = false;
    stamp.className = `data-stamp ${info.cls}`;
    stamp.textContent = info.label;
    stamp.title = info.tip || info.label;
  }
  const breadth = state.overview.breadth || {};
  const flow = state.overview.marketFlow || {};
  const sseQ = state.overview.cn.find((q) => q.code === '000001') || o;
  const szseQ = state.overview.cn.find((q) => q.code === '399001') || {};
  const totalAmount = (Number(sseQ.amount) || 0) + (Number(szseQ.amount) || 0);
  const amplitude = isNum(o.high) && isNum(o.low) && isNum(o.prevClose) && o.prevClose
    ? ((o.high - o.low) / o.prevClose) * 100
    : null;
  const stats = $('#heroStats');
  if (stats) {
    stats.innerHTML = `
      <div class="stat"><div class="s-label">两市成交额</div><div class="s-value">${compactAmount(totalAmount)}</div><div class="s-sub">沪市 ${compactAmount(sseQ.amount)} / 深市 ${compactAmount(szseQ.amount)}</div></div>
      <div class="stat"><div class="s-label">涨跌家数</div><div class="s-value"><span class="tone-up">${breadth.up ?? '--'}</span> / <span class="tone-down">${breadth.down ?? '--'}</span></div><div class="s-sub">平盘 ${breadth.flat ?? '--'}</div></div>
      <div class="stat"><div class="s-label">主力净流入</div><div class="s-value ${toneClass(flow.last)}">${yiFmt(flow.last)}</div><div class="s-sub">全市场主力</div></div>
      <div class="stat"><div class="s-label">日内振幅</div><div class="s-value">${isNum(amplitude) ? `${nf(amplitude, 2)}%` : '--'}</div><div class="s-sub">最高 ${stockFmt(o.high)} / 最低 ${stockFmt(o.low)}</div></div>`;
  }
  // 交易时段展示当日分时（完整交易时段轴）；休市时展示近 90 日收盘走势。
  paintHeroChart(o, cnSess);
}

async function paintHeroChart(o, cnSess) {
  const isOpen = cnSess && cnSess.state === 'open';
  const paintDaily = () => {
    if (!state.heroSeries) return false;
    areaChart($('#heroChart'), state.heroSeries, o.pct >= 0 ? COLORS.up : COLORS.down);
    return true;
  };
  if (isOpen) {
    try {
      const k = await getKlineCached('1.000001', 1, 260);
      if (state.overview) {
        const preClose = Number(k.preClose) || Number(o.prevClose) || null;
        intradayChart($('#heroChart'), { candles: k.candles || [], preClose, fullSession: true });
        return;
      }
    } catch { /* 分时不可用时退回日线收盘走势 */ }
  }
  // 图表库异常不应把整页刷新打断（异步链抛出会成为未捕获 rejection）。
  try {
    if (paintDaily()) return;
    loadHeroSeries().then(() => {
      try { paintDaily(); } catch { /* 忽略绘图失败 */ }
    }).catch(() => { /* 历史走势取不到时保留上一帧 */ });
  } catch { /* 忽略绘图失败 */ }
}

/* =========================================================
   全景：板块 & 温度
   ========================================================= */
async function loadSectors(type = 'industry', force = false) {
  if (!force && state.sectors[type]) {
    if (type === state.sectorType) renderSectorPanel();
    if (type === state.sectorPageType && state.view === 'sectors') renderSectorPage();
    return;
  }
  if (state.loading.has(`sectors:${type}`)) return;
  state.loading.add(`sectors:${type}`);
  try {
    const data = await api(`/api/sectors?type=${type}`);
    state.sectors[type] = data;
    if (type === state.sectorType) renderSectorPanel();
    if (type === state.sectorPageType && state.view === 'sectors') renderSectorPage();
    loadSourceStatus(true);
  } catch (err) {
    handleLoadError('板块资金', err);
  } finally {
    state.loading.delete(`sectors:${type}`);
  }
}

function sectorItems() {
  return (state.sectors[state.sectorType] && state.sectors[state.sectorType].items) || [];
}

/* =========================================================
   全景：新闻 / 自选 / 时段
   ========================================================= */
async function loadNews() {
  if (state.loading.has('news')) return;
  state.loading.add('news');
  try {
    state.news = await api('/api/news?limit=30');
    renderNewsList();
  } catch (err) {
    handleLoadError('财经快讯', err);
  } finally {
    state.loading.delete('news');
  }
}

async function loadWatchData(force = false) {
  if (!state.watchlist.length) {
    state.watchData = { items: [] };
    renderDashWatch();
    renderWatchTable();
    renderWatchAdvice();
    renderAlerts();
    if (state.view === 'strategy') renderPortfolioAdvice();
    return;
  }
  if (state.loading.has('watch') && !force) return;
  state.loading.add('watch');
  try {
    const ids = state.watchlist.map((w) => w.secid).slice(0, 12);
    const data = await api(`/api/watchlist?secids=${encodeURIComponent(ids.join(','))}&risk=${state.settings.risk}`);
    state.watchData = data;
    (data.items || []).forEach((it) => {
      if (it.quote) state.quotes.set(it.quote.secid, it.quote);
    });
    renderDashWatch();
    renderWatchTable();
    renderWatchAdvice();
    checkAlerts();
    if (state.view === 'strategy') renderPortfolioAdvice();
  } catch (err) {
    handleLoadError('自选行情', err);
  } finally {
    state.loading.delete('watch');
  }
}

/* =========================================================
   A股   ========================================================= */
/* =========================================================
   指数多周期涨跌（近1周 / 1月 / 3月 / 6月）
   ========================================================= */
const PERIOD_COLUMNS = ['w1', 'm1', 'm3', 'm6'];

async function loadChinaPeriods(force = false) {
  if (!force && state.cnPeriod) { renderChinaPeriods(); return; }
  try {
    const data = await api('/api/index-periods', 60000);
    state.cnPeriod = data;
    renderChinaPeriods();
  } catch (err) {
    const el = $('#cnPeriodTable');
    if (el) el.innerHTML = `<div class="empty">多周期涨跌加载失败：${esc(err.message)}</div>`;
  }
}

function renderChinaPeriods() {
  const el = $('#cnPeriodTable');
  const data = state.cnPeriod;
  if (!el) return;
  if (!data || !Array.isArray(data.items) || !data.items.length) {
    el.innerHTML = '<div class="empty">正在加载多周期涨跌…</div>';
    return;
  }
  const periods = Array.isArray(data.periods) && data.periods.length
    ? data.periods
    : PERIOD_COLUMNS.map((key) => ({ key, label: key }));
  const meta = $('#cnPeriodMeta');
  if (meta) {
    const date = data.items[0] && data.items[0].date ? data.items[0].date : '--';
    meta.textContent = `数据截至 ${date} · 按交易日统计（5 / 20 / 60 / 120 个交易日）· ${data.items.length} 个宽基指数`;
  }
  const cell = (pct) => (isNum(pct)
    ? `<td class="${toneClass(pct)}">${pct > 0 ? '+' : ''}${Number(pct).toFixed(2)}%</td>`
    : '<td class="muted">--</td>');
  const rows = data.items.map((it) => `<tr data-cn-period-secid="${esc(it.secid)}">
      <td><span class="cp-name">${esc(cleanName(it.name))}</span><span class="t-code">${esc(it.code || '')}</span></td>
      <td class="t-price">${nf(it.close, 2)}</td>
      ${cell(it.todayPct)}
      ${periods.map((p) => cell(it.periods ? it.periods[p.key] : null)).join('')}
    </tr>`).join('');
  const summary = periods.map((p) => {
    const avg = data.average ? data.average[p.key] : null;
    const up = data.upCount ? data.upCount[p.key] : null;
    const avgCls = isNum(avg) ? toneClass(avg) : 'muted';
    return `<span>${esc(p.label)} 均涨跌 <b class="${avgCls}">${isNum(avg) ? `${avg > 0 ? '+' : ''}${Number(avg).toFixed(2)}%` : '--'}</b> · 上涨 ${up === null || up === undefined ? '--' : up}/${data.total || data.items.length} 只</span>`;
  }).join('');
  el.innerHTML = `<table class="table cn-period-table">
    <thead><tr><th>指数</th><th>最新</th><th>今日</th>${periods.map((p) => `<th>${esc(p.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="cn-period-summary">${summary}</div>
  <p class="muted small mt8">区间涨跌 = 最新收盘 ÷ N 个交易日前的收盘 −1，与行情软件的「阶段涨幅」口径一致；点击任意一行可把该指数切到上方主图。</p>`;
  $$('[data-cn-period-secid]', el).forEach((row) => {
    row.onclick = () => {
      state.cnIndex = row.dataset.cnPeriodSecid;
      $$('#cnIndexSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.secid === state.cnIndex));
      loadChinaChart(true);
      loadChinaStock();
    };
  });
}

/* =========================================================
   指数 K 线/ 快照
   ========================================================= */
function renderChinaHeader() {
  if (!state.overview) return;
  const q = getBySecid(state.cnIndex);
  const pill = $('#cnQuote');
  if (pill && q) {
    pill.innerHTML = `${stockFmt(q.price)} <small class="${toneClass(q.pct)}">${pctFmt(q.pct)}</small>`;
  }
}

async function loadChinaChart(force = false) {
  const secid = state.cnIndex;
  const klt = state.cnKlt;
  const limit = klt === 101 ? 2600 : klt === 102 ? 600 : klt === 103 ? 132 : 240;
  try {
    const k = await getKlineCached(secid, klt, limit);
    state.cnKline = k;
    if (klt !== 101) state.cnAdvice = null;
    else if (state.cnStock) state.cnAdvice = state.cnStock.advice;
    renderChinaChart();
    if (klt === 101) renderChinaSnapshot();
  } catch (err) {
    handleLoadError('指数 K 线', err);
  }
}

async function loadChinaStock(force = false) {
  const secid = state.cnIndex;
  if (!force && state.cnStock && state.cnStock.quote && state.cnStock.quote.secid === secid) {
    state.cnAdvice = state.cnStock.advice;
    renderChinaSnapshot();
    return;
  }
  try {
    const data = await api(`/api/stock?secid=${encodeURIComponent(secid)}&risk=${state.settings.risk}`);
    state.cnStock = data;
    state.cnAdvice = data.advice;
    renderChinaSnapshot();
  } catch (err) {
    handleLoadError('指数详情', err);
  }
}

function renderChinaChart() {
  const k = state.cnKline;
  if (!k) return;
  const title = $('#cnChartTitle');
  const sub = $('#cnChartSub');
  if (title) title.textContent = cleanName(k.name) || '指数';
  const pill = $('#cnQuote');
  const q = getBySecid(state.cnIndex) || (state.cnStock && state.cnStock.quote) || {};
  if (pill) pill.innerHTML = `${stockFmt(q.price)} <small class="${toneClass(q.pct)}">${pctFmt(q.pct)}</small>`;
  // 分时：价格线 + 均价线 + 昨收基准，直接跟着自动刷新走。
  if (state.cnKlt === 1) {
    const preClose = Number(k.preClose) || Number(q.prevClose) || null;
    // fullSession：X 轴始终按 A 股完整交易时段（09:30–11:30 / 13:00–15:00）铺开，
    // 盘中右边缘固定是 15:00，不会随「现在几点」缩短。
    intradayChart($('#cnChart'), { candles: k.candles || [], preClose, fullSession: true });
    if (sub) {
      const session = (state.overview && state.overview.sessions && state.overview.sessions.cn) || {};
      sub.textContent = `${k.code || state.cnIndex} · 今日分时 09:30–11:30 / 13:00–15:00${session.state === 'open' ? ' · 实时更新' : ` · ${session.label || '休市'}`}`;
    }
    return;
  }
  if (sub) sub.textContent = `${k.code || state.cnIndex} · ${kltLabel(state.cnKlt)}${fqtHint(k)}`;
  const intraday = [5, 15, 30, 60].includes(state.cnKlt);
  const saved = state.cnZoom && state.cnZoom.secid === state.cnIndex && state.cnZoom.klt === state.cnKlt ? state.cnZoom : null;
  const defaultStart = intraday ? 0 : k.candles.length > 1500 ? 80 : k.candles.length > 500 ? 70 : 30;
  const chart = candleChart($('#cnChart'), k, {
    intraday,
    indicator: currentIndicator(),
    zoomStart: saved ? undefined : defaultStart,
    zoomStartValue: saved?.startValue,
    zoomEndValue: saved?.endValue,
  });
  if (chart && window.echarts) {
    chart.off('dataZoom');
    chart.on('dataZoom', () => {
      const dz = chart.getOption().dataZoom && chart.getOption().dataZoom[0];
      if (!dz) return;
      const dates = k.candles.map((c) => c.d);
      const n = dates.length;
      let startValue = dz.startValue;
      let endValue = dz.endValue;
      if (typeof startValue === 'number') startValue = dates[Math.max(0, Math.min(n - 1, startValue))];
      if (typeof endValue === 'number') endValue = dates[Math.max(0, Math.min(n - 1, endValue))];
      if (!startValue || !endValue) {
        startValue = dates[Math.max(0, Math.floor(((dz.start ?? 0) / 100) * (n - 1)))];
        endValue = dates[Math.min(n - 1, Math.ceil(((dz.end ?? 100) / 100) * (n - 1)))];
      }
      state.cnZoom = { secid: state.cnIndex, klt: state.cnKlt, startValue, endValue, start: dz.start, end: dz.end };
    });
    chart.off('click');
    const chartEl = $('#cnChart');
    if (chartEl) {
      chartEl.onclick = (e) => {
        if (intraday) return;
        const rect = chartEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (y > chart.getHeight() - 28) return;
        const point = chart.convertFromPixel({ seriesIndex: 0 }, [x, y]);
        const idx = Array.isArray(point) ? Math.round(point[0]) : Math.round(point);
        if (!Number.isFinite(idx)) return;
        const candle = k.candles[idx];
        if (!candle) return;
        openIntradayChart(state.cnIndex, String(candle.d).slice(0, 10), k.name);
      };
    }
  }
}

function openIntradayChart(secid, date, name) {
  mountOverlay(`<div class="modal">
    <div class="modal-head"><div class="modal-title"><h2>${esc(cleanName(name) || secid)} · ${esc(date)}</h2><span class="code">${esc(secid)} · 分时</span></div><button class="modal-close" data-close>×</button></div>
    <div class="empty" id="intradayLoading">正在加载 ${esc(date)} 分时…</div>
    <div class="intraday-day-summary" id="intradayDaySummary" hidden></div>
    <div class="main-chart intraday-chart" id="intradayChart" hidden></div>
    <p class="muted small mt12" id="intradayNote">点击日K/周K/月K上的交易日，异步加载当天交易时段走势；数据来自公开行情接口，可能有短暂延迟。</p>
  </div>`);
  const overlay = $('.overlay');
  api(`/api/intraday?secid=${encodeURIComponent(secid)}&date=${encodeURIComponent(date)}`).then((data) => {
    if (!overlay) return;
    const loading = $('#intradayLoading');
    if (loading) loading.hidden = true;
    const chartEl = $('#intradayChart');
    const label = data.periodLabel || '分时';
    const codeEl = overlay.querySelector('.modal-title .code');
    if (codeEl) codeEl.textContent = secid;
    const change = Number(data.pct);
    overlay.querySelector('.modal-head').insertAdjacentHTML('afterend',
      `<div class="modal-price-row"><span class="modal-price ${toneClass(change)}">${stockFmt(data.last)}</span><span class="modal-chg ${toneClass(change)}">${pctFmt(change)}</span><span class="badge">${esc(label)}</span></div>`);
    const note = $('#intradayNote');
    if (data.period === 'day') {
      const low = Number(data.low);
      const high = Number(data.high);
      const last = Number(data.last);
      const pos = high > low ? Math.max(0, Math.min(100, ((last - low) / (high - low)) * 100)) : 50;
      const summary = $('#intradayDaySummary');
      if (summary) {
        summary.hidden = false;
        summary.innerHTML = `
          <div class="ids-grid">
            <div><span>开盘</span><b>${stockFmt(data.first)}</b></div>
            <div><span>最高</span><b class="tone-up">${stockFmt(high)}</b></div>
            <div><span>最低</span><b class="tone-down">${stockFmt(low)}</b></div>
            <div><span>收盘</span><b class="${toneClass(change)}">${stockFmt(last)}</b></div>
            <div><span>成交额</span><b>${compactAmount(data.amount)}</b></div>
            <div><span>昨收</span><b>${stockFmt(data.preClose)}</b></div>
          </div>
          <div class="ids-range"><div class="ids-track"><i style="left:${pos}%"></i></div><div class="ids-range-label"><span>低 ${stockFmt(low)}</span><span>收盘位置</span><span>高 ${stockFmt(high)}</span></div></div>`;
      }
      if (note) note.textContent = '该日期超出免费分钟数据的回溯范围，改为展示当日日线摘要（开高低收、成交额与收盘位置），不会再报错。';
    } else {
      if (chartEl) chartEl.hidden = false;
      areaChart(chartEl, data.candles, change >= 0 ? COLORS.up : COLORS.down, { axes: true });
      if (note) note.textContent = data.period === 1
        ? '1 分钟分时来自公开行情接口，可能有短暂延迟。'
        : `${label}：该日期已超出 1 分钟数据保留期，系统按 5/15/30/60 分钟自动回退，仍可查看当天完整走势。`;
    }
  }).catch((err) => {
    const loading = $('#intradayLoading');
    if (loading) {
      loading.hidden = false;
      loading.textContent = `该日期行情暂不可用：${err.message}`;
    }
    toast(`分时加载失败：{err.message}`, 'err');
  });
}

function renderChinaSnapshot() {
  const el = $('#cnSnapshot');
  if (!el) return;
  const data = state.cnStock;
  if (!data || !data.quote) {
    el.innerHTML = '<div class="empty">加载中…</div>';
    return;
  }
  const q = data.quote;
  const a = data.advice;
  el.innerHTML = `
    <div class="snapshot-hero">
      <div class="sn-name">${esc(cleanName(q.name))} <span class="code">${esc(q.code)}</span></div>
      <div class="sn-price ${toneClass(q.pct)}">${stockFmt(q.price)}</div>
      <div class="sn-chg ${toneClass(q.pct)}">${pctFmt(q.pct)} ${signedFmt(q.change)}</div>
    </div>
    <div class="snapshot-grid">
      <div class="snapshot-item"><span>今开</span><b>${stockFmt(q.open)}</b></div>
      <div class="snapshot-item"><span>昨收</span><b>${stockFmt(q.prevClose)}</b></div>
      <div class="snapshot-item"><span>最高</span><b class="tone-up">${stockFmt(q.high)}</b></div>
      <div class="snapshot-item"><span>最低</span><b class="tone-down">${stockFmt(q.low)}</b></div>
      <div class="snapshot-item"><span>成交额</span><b>${compactAmount(q.amount)}</b></div>
      <div class="snapshot-item"><span>换手率</span><b>${isNum(q.turnover) ? `${nf(q.turnover, 2)}%` : '--'}</b></div>
      <div class="snapshot-item"><span>上涨/下跌</span><b><span class="tone-up">${q.up ?? '--'}</span> / <span class="tone-down">${q.down ?? '--'}</span></b></div>
      <div class="snapshot-item"><span>主力净流入</span><b class="${toneClass(q.mainYi)}">${yiFmt(q.mainYi)}</b></div>
    </div>
    ${a ? `<div class="snapshot-advice">
      <div class="a-head"><span class="muted small">技术评分</span><span class="badge tone-${a.rating.tone}">${esc(a.rating.label)}</span></div>
      <div class="row-between"><span class="a-score ${a.score >= 60 ? 'tone-up' : a.score < 45 ? 'tone-down' : ''}">${a.score}<span class="muted small"> / 100</span></span><span class="muted small">参考仓位 ${esc(a.position.text)}</span></div>
      <p>${esc(a.summary)}</p>
    </div>` : '<div class="empty mt8">暂无策略评分</div>'}`;
}

async function loadIndexCompare(force = false) {
  if (!force && state.cnIndexCompare) { renderIndexCompare(); return; }
  if (state.loading.has('indexcompare') && !force) return;
  state.loading.add('indexcompare');
  try {
    const data = await api('/api/index-compare?days=250');
    state.cnIndexCompare = data;
    renderIndexCompare();
  } catch (err) {
    handleLoadError('五大指数对比', err);
  } finally {
    state.loading.delete('indexcompare');
  }
}

function renderIndexCompare() {
  const el = $('#cnIndexCompare');
  if (!el) return;
  const d = state.cnIndexCompare;
  if (!d || !Array.isArray(d.items) || !d.items.length) {
    el.innerHTML = '<div class="empty">正在加载五大指数走势…</div>';
    return;
  }
  const money = (v) => Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  el.innerHTML = d.items.map((s) => {
    const dayPct = Number(s.dayPct) || 0;
    const spanPct = Number(s.changePct) || 0;
    // 起止日期写进副标题，配合 X 轴上的 MM-DD 刻度说明「区间」到底是哪一段。
    const rows = Array.isArray(s.data) ? s.data : [];
    const firstD = rows.length ? String(rows[0][0]).slice(5, 10) : '';
    const lastD = rows.length ? String(rows[rows.length - 1][0]).slice(5, 10) : '';
    const span = firstD && lastD ? `${firstD}–${lastD}` : '近1年';
    return `<article class="index-mini-card" data-index-secid="${esc(s.secid)}" title="点击切换到 ${esc(s.name)}">
      <div class="imc-top">
        <div class="imc-ident"><div class="imc-name">${esc(s.name)}</div><div class="imc-code">${esc(s.code)} · ${esc(span)}</div></div>
        <div class="imc-quote"><b class="${toneClass(dayPct)}">${money(s.last)}</b><span class="${toneClass(dayPct)}">${pctFmt(dayPct)}</span></div>
      </div>
      <div class="index-mini-chart"></div>
      <div class="imc-foot">
        <span>高 ${money(s.high)}</span><span>低 ${money(s.low)}</span>
        <span>区间 <b class="${toneClass(spanPct)}">${pctFmt(spanPct)}</b></span>
      </div>
    </article>`;
  }).join('');
  $$('.index-mini-card', el).forEach((card, i) => {
    indexMiniChart($('.index-mini-chart', card), d.items[i]);
  });
}

async function loadCsi300Ratio(force = false) {
  if (!force && state.csi300Ratio) { renderCsi300Ratio(); return; }
  if (state.loading.has('csi300ratio') && !force) return;
  state.loading.add('csi300ratio');
  try {
    const data = await api('/api/csi300-ratio?top=10');
    state.csi300Ratio = data;
    renderCsi300Ratio();
  } catch (err) {
    handleLoadError('沪深300基金占比', err);
  } finally {
    state.loading.delete('csi300ratio');
  }
}

function renderCsi300Ratio() {
  const chart = $('#csi300RatioLine');
  const fundsEl = $('#csi300RatioFunds');
  const meta = $('#csi300RatioMeta');
  if (!chart || !fundsEl) return;
  const d = state.csi300Ratio;
  if (!d) {
    if (meta) meta.textContent = '正在统计头部沪深300基金…';
    fundsEl.innerHTML = '<div class="empty">加载中…</div>';
    return;
  }
  if (meta) meta.textContent = `${d.fundCount} 只· 当前 ${nf(d.ratio, 2)}% · 近半年曲线· 列表，${Math.min(6, d.fundCount)} · ${d.date || '--'}`;
  csi300RatioLine(chart, d.history || []);
  fundsEl.innerHTML = `
    <div class="csi300-summary">
      <div><span>头部${d.fundCount}只合计规模</span><b>${nf(d.totalSizeYi, 0)} 亿</b></div>
      <div><span>沪深300流通市值</span><b>${nf(d.floatCapYi / 1e4, 2)} 万亿</b></div>
      <div><span>当前规模 / 流通市值</span><b class="tone-accent">${nf(d.ratio, 2)}%</b></div>
    </div>
    <div class="csi300-fund-list">
      ${(d.funds || []).slice(0, 6).map((f) => `<div class="csi300-fund-item">
        <div class="csi300-fund-name" title="${esc(f.name)}">${esc(cleanName(f.name))}</div>
        <div class="csi300-fund-size">${nf(f.sizeYi, 0)} <small>亿</small></div>
      </div>`).join('')}
    </div>`;
}

function renderBreadth() {
  const el = $('#breadthPanel');
  if (!el || !state.overview) return;
  const dist = state.cnDistribution;
  const b = dist
    ? { up: dist.up, down: dist.down, flat: dist.flat, total: dist.total }
    : (state.overview.breadth || {});
  const total = (b.up || 0) + (b.down || 0) + (b.flat || 0) || 1;
  const upW = ((b.up || 0) / total) * 100;
  const flatW = ((b.flat || 0) / total) * 100;
  const downW = 100 - upW - flatW;
  const bucket = (key) => (dist?.buckets || []).find((x) => x.key === key)?.count ?? '--';
  el.innerHTML = `
    <div class="breadth-title">沪深A股涨跌概览<{!dist && b.available === false ? '<span class="muted small" style="font-weight:400;margin-left:8px">备用数据源不提供涨跌家数</span>' : ''}<strong><span class="tone-up">${b.up ?? '--'}</span> <span class="muted">/</span> <span class="tone-down">${b.down ?? '--'}</span></strong></div>
    <div>
      <div class="breadth-bar">
        <span class="b-up" style="width:${upW}%"></span>
        <span class="b-flat" style="width:${flatW}%"></span>
        <span class="b-down" style="width:${downW}%"></span>
      </div>
      <div class="breadth-legend"><span><i style="background:${COLORS.up}"></i>上涨 ${b.up ?? '--'}</span><span><i style="background:#64748b"></i>平盘 ${b.flat ?? '--'}</span><span><i style="background:${COLORS.down}"></i>下跌 ${b.down ?? '--'}</span></div>
    </div>
    <div class="breadth-metrics">
      <div><span>涨幅 &gt;10%</span><b class="tone-up">${bucket('up10')}</b></div>
      <div><span>跌幅 &lt;-10%</span><b class="tone-down">${bucket('down10')}</b></div>
      <div><span>涨跌比</span><b>${b.down ? (b.up / b.down).toFixed(2) : '--'}</b></div>
      <div><span>总家数</span><b>${b.total ?? total}</b></div>
    </div>
    <div class="breadth-side">
      <div><span>涨幅 &gt;7%</span><b>${dist ? bucket('up10') + bucket('up7_10') : '--'}</b></div>
      <div><span>跌幅 &lt;-7%</span><b>${dist ? bucket('down10') + bucket('down7_10') : '--'}</b></div>
      <div><span>市场状态</span><b>${(state.overview.sessions.cn || {}).label || '--'}</b></div>
    </div>`;
}

async function loadChinaDistribution(force = false) {
  if (!force && state.cnDistribution) { renderChinaDistribution(); return; }
  if (state.loading.has('cndist') && !force) return;
  state.loading.add('cndist');
  try {
    const data = await api('/api/distribution?market=cn');
    state.cnDistribution = data;
    renderChinaDistribution();
  } catch (err) {
    handleLoadError('A股涨跌分布', err);
  } finally {
    state.loading.delete('cndist');
  }
}

function renderChinaDistribution() {
  const el = $('#cnDistributionChart');
  const meta = $('#cnDistMeta');
  if (!el) return;
  const d = state.cnDistribution;
  if (!d) {
    el.innerHTML = '<div class="empty">正在统计全市场涨跌分布…</div>';
    if (meta) meta.textContent = '--';
    return;
  }
  if (meta) meta.textContent = `${d.total} 家· ${d.date || '--'} · 上涨 ${d.up} / 下跌 ${d.down} / 平盘 ${d.flat}`;
  distributionChart(el, d.buckets || [], d.total);
  renderBreadth();
}

async function loadChinaRanks(force = false) {
  if (!force && state.ranks.gain.length) { renderRanks(); return; }
  try {
    const [gain, loss, inflow, outflow] = await Promise.all([
      api('/api/rank?type=gain&limit=8'),
      api('/api/rank?type=loss&limit=8'),
      api('/api/rank?type=inflow&limit=8'),
      api('/api/rank?type=outflow&limit=8'),
    ]);
    state.ranks = {
      gain: gain.items || [],
      loss: loss.items || [],
      inflow: inflow.items || [],
      outflow: outflow.items || [],
    };
    renderRanks();
  } catch (err) {
    handleLoadError('个股榜单', err);
  }
}

function renderRankTable(el, items, mode) {
  if (!el) return;
  if (!items || !items.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  el.innerHTML = `<div class="mini-table">${items.map((q, i) => `
    <div class="mini-row" data-stock-secid="${esc(q.secid)}">
      <span class="mini-idx">${String(i + 1).padStart(2, '0')}</span>
      <span class="mini-name">${esc(cleanName(q.name))}<small>${esc(q.code)}</small></span>
      <span class="mini-price">${stockFmt(q.price)}</span>
      <span class="mini-chg ${mode === 'main' ? toneClass(q.mainYi) : toneClass(q.pct)}">${mode === 'main' ? yiFmt(q.mainYi) : pctFmt(q.pct)}</span>
    </div>`).join('')}</div>`;
}

function renderRanks() {
  renderRankTable($('#rankGain'), state.ranks.gain, 'pct');
  renderRankTable($('#rankLoss'), state.ranks.loss, 'pct');
  renderRankTable($('#rankInflow'), state.ranks.inflow, 'main');
  renderRankTable($('#rankOutflow'), state.ranks.outflow, 'main');
}

function kltLabel(klt) {
  return { 101: '日K', 102: '周K', 103: '月K', 60: '60分', 30: '30分', 15: '15分', 5: '5分', 1: '分时' }[klt] || 'K线';
}

/* =========================================================
   全球
   ========================================================= */
function renderGlobalTable() {
  const el = $('#globalTable');
  if (!el || !state.overview) return;
  const codeOf = (q) => String(q.secid || '').split('.')[1] || q.code;
  let items = state.overview.global.filter((q) => !['UDI', 'HSAHP'].includes(codeOf(q)));
  if (state.globalRegion !== 'all') {
    items = items.filter((q) => (REGION[codeOf(q)] || 'asia') === state.globalRegion);
  }
  const count = $('#globalCount');
  if (count) count.textContent = `${items.length} 个指数`;
  const statusCell = (q) => {
    const s = q.session;
    if (!s) return '<td class="t-session"><span class="muted small">--</span></td>';
    const state = s.state === 'pre' ? 'pre' : s.state === 'open' ? 'open' : s.state === 'break' ? 'break' : 'closed';
    return `<td class="t-session"><span class="sess-tag ${state}" title="${esc(s.label)} · 当地时间 ${esc(s.local || '')}">${esc(s.label)}</span><span class="sess-time">${esc(s.local || '')}</span></td>`;
  };
  const rows = items.map((q) => {
    const amp = isNum(q.high) && isNum(q.low) && q.prevClose ? ((q.high - q.low) / q.prevClose) * 100 : null;
    const selected = q.secid === state.globalIndex ? ' class="is-selected"' : '';
    const key = codeOf(q);
    return `<tr data-global-secid="${esc(q.secid)}"${selected}>
      <td><span class="row-flag">${(REGION[key] || 'asia').slice(0, 3).toUpperCase()}</span><span class="t-name">${esc(cleanName(q.name))}</span><span class="t-code">${esc(q.code)}</span></td>
      <td class="t-price">${priceFmt(q.price)}</td>
      <td class="t-chg ${toneClass(q.pct)}">${pctFmt(q.pct)}</td>
      <td class="t-dim">${isNum(amp) ? `${nf(amp, 2)}%` : '--'}</td>
      ${statusCell(q)}
    </tr>`;
  }).join('');
  el.innerHTML = `<table class="table">
    <thead><tr><th>指数</th><th>最新</th><th>涨跌</th><th>振幅</th><th>交易状态</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5"><div class="empty">暂无数据</div></td></tr>'}</tbody>
  </table>`;

  const q = getBySecid(state.globalIndex) || {};
  if ($('#globalQuote')) $('#globalQuote').innerHTML = `${priceFmt(q.price)} <small class="${toneClass(q.pct)}">${pctFmt(q.pct)}</small>`;
  if ($('#globalChartTitle')) $('#globalChartTitle').textContent = cleanName(q.name) || '全球指数';
  if ($('#globalChartSub')) $('#globalChartSub').textContent = state.globalIndex;
}

async function loadGlobalChart(force = false) {
  const chartEl = $('#globalChart');
  const resetChart = () => {
    if (!chartEl) return;
    if (window.echarts) {
      const inst = window.echarts.getInstanceByDom(chartEl);
      if (inst) inst.dispose();
    }
    chartEl.innerHTML = '';
  };
  try {
    if (!force && state.globalKline && state.globalKline.secid === state.globalIndex) {
      resetChart();
      candleChart(chartEl, state.globalKline, { zoomStart: 20, indicator: currentIndicator() });
      return;
    }
    const k = await getKlineCached(state.globalIndex, 101, 150);
    state.globalKline = k;
    const q = getBySecid(state.globalIndex) || {};
    if ($('#globalQuote')) $('#globalQuote').innerHTML = `${priceFmt(q.price)} <small class="${toneClass(q.pct)}">${pctFmt(q.pct)}</small>`;
    if ($('#globalChartTitle')) $('#globalChartTitle').textContent = cleanName(k.name) || cleanName(q.name);
    if ($('#globalChartSub')) $('#globalChartSub').textContent = `${state.globalIndex}${fqtHint(k)}`;
    resetChart();
    candleChart(chartEl, k, { zoomStart: 20, indicator: currentIndicator() });
  } catch (err) {
    resetChart();
    if (chartEl) chartEl.innerHTML = '<div class="empty">该市场历史K 线暂不可用，最新报价与涨跌幅仍正常显示。</div>';
    handleLoadError('该市场走势', err);
  }
}

function renderFx() {
  const el = $('#fxList');
  if (!el || !state.overview) return;
  const specs = [
    ['USDCNH', '美元/离岸人民币'],
    ['USDJPY', '美元/日元'],
    ['EURUSD', '欧元/美元'],
    ['USDHKD', '美元/港币'],
    ['USDGBP', '美元/英镑'],
    ['UDI', '美元指数'],
  ];
  el.innerHTML = specs.map(([code, name]) => {
    const q = getQuote(code) || {};
    return `<div class="fx-row">
      <div class="fx-name">${name}<small>${esc(code)}</small></div>
      <div class="fx-val">${priceFmt(q.price)}</div>
      <div class="fx-chg ${toneClass(q.pct)}">${pctFmt(q.pct)}</div>
    </div>`;
  }).join('');
}

function renderGlobalSessions() {
  const el = $('#globalSessions');
  if (!el || !state.overview || !state.overview.sessions) return;
  const s = state.overview.sessions;
  const rows = [
    ['沪深', 'CN', s.cn], ['香港', 'HK', s.hk], ['纽约', 'US', s.us],
    ['伦敦', 'EU', s.eu], ['期货', '24H', s.futures],
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

function renderGlobalTemp() {
  const el = $('#globalTemp');
  if (!el || !state.overview) return;
  const avg = (codes) => {
    const vals = codes.map((c) => getQuote(c)).filter((q) => q && isNum(q.pct)).map((q) => Number(q.pct));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  const rows = [
    ['美股', avg(['DJIA', 'SPX', 'NDX'])],
    ['欧洲', avg(['GDAXI', 'FTSE', 'FCHI', 'SX5E'])],
    ['亚太', avg(['HSI', 'N225', 'KS11', 'TWII', 'AS51'])],
    ['商品', avg(['GC00Y', 'SI00Y', 'CL00Y', 'HG00Y'])],
    ['美元', Number((getQuote('UDI') || {}).pct || 0)],
  ];
  el.innerHTML = `<div class="temp-bars">${rows.map(([name, pct]) => {
    const score = Math.max(2, Math.min(100, 50 + Number(pct) * 9));
    return `<div class="temp-bar-row">
      <span class="tb-label">${name}</span>
      <span class="tb-track"><i style="width:${score}%;${pct < 0 ? 'background:linear-gradient(90deg,#16c784,#4ade80)' : ''}"></i></span>
      <span class="tb-val ${toneClass(pct)}">${pctFmt(pct)}</span>
    </div>`;
  }).join('')}</div>`;
}

async function loadUS(force = false) {
  if (!force && state.usData) { renderUS(); return; }
  if (state.loading.has('us') && !force) return;
  state.loading.add('us');
  try {
    const data = await api('/api/us');
    state.usData = data;
    renderUS();
    loadUSMinutes();
  } catch (err) {
    handleLoadError('美股专题', err);
  } finally {
    state.loading.delete('us');
  }
}

async function loadUSChart(force = false) {
  if (!force && state.usKline && state.usKline.secid === state.usIndex) { renderUSChart(); return; }
  if (state.loading.has('uschart') && !force) return;
  state.loading.add('uschart');
  try {
    const data = await api(`/api/kline?secid=${encodeURIComponent(state.usIndex)}&klt=101&limit=160`);
    state.usKline = data;
    renderUSChart();
  } catch (err) {
    handleLoadError('美股指数走势', err);
  } finally {
    state.loading.delete('uschart');
  }
}

function renderUSChart() {
  const k = state.usKline;
  if (!k) return;
  const title = $('#usChartTitle');
  if (title) title.textContent = cleanName(k.name) || '纳斯达克指数';
  const sub = $('#usChartSub');
  if (sub) sub.textContent = `${k.code || 'NDX'} · 日K${fqtHint(k)}`;
  const q = (state.usData?.indices || []).find((x) => x.secid === state.usIndex);
  const pill = $('#usQuote');
  if (pill && q) pill.innerHTML = `${nf(q.price, 2)} <small class="${toneClass(q.pct)}">${pctFmt(q.pct)}</small>`;
  candleChart($('#usChart'), k, { intraday: false, indicator: currentIndicator() });
}

function renderUS() {
  const d = state.usData;
  const cards = $('#usIndexCards');
  const hotColumns = $('#usHotColumns');
  if (!cards || !hotColumns) return;
  if (!d) {
    cards.innerHTML = Array.from({ length: 4 }).map(() => '<div class="us-index-card"><div class="empty">加载中…</div></div>').join('');
    hotColumns.innerHTML = '<div class="empty">正在拉取美股热度…</div>';
    return;
  }
  const session = d.sessions || {};
  if ($('#usSession')) $('#usSession').textContent = `${session.label || '--'} ${session.local || ''}`.trim();
  if ($('#usUpdated')) $('#usUpdated').textContent = d.updatedAt ? `更新 ${new Date(d.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '--';
  cards.innerHTML = (d.indices || []).map((x) => `
    <div class="us-index-card ${x.secid === state.usIndex ? 'is-active' : ''}" data-us-secid="${esc(x.secid)}">
      <div class="us-idx-head"><span class="us-idx-name">${esc(cleanName(x.name))}</span><span class="us-idx-code">${esc(x.code)}</span></div>
      <div class="us-idx-price">${nf(x.price, 2)}</div>
      <div class="us-idx-pct ${toneClass(x.pct)}">${pctFmt(x.pct)} <span class="muted">${signedFmt(x.change)}</span></div>
    </div>`).join('') || '<div class="empty">暂无指数数据</div>';

  const selected = (d.indices || []).find((x) => x.secid === state.usIndex);
  if ($('#usQuote') && selected) $('#usQuote').innerHTML = `${nf(selected.price, 2)} <small class="${toneClass(selected.pct)}">${pctFmt(selected.pct)}</small>`;

  const dist = d.distribution;
  if (dist) {
    if ($('#usDistMeta')) $('#usDistMeta').textContent = `${dist.total} 家· ${dist.date || '--'} · 上涨 ${dist.up} / 下跌 ${dist.down} / 平盘 ${dist.flat}`;
    distributionChart($('#usDistributionChart'), dist.buckets || [], dist.total);
  } else if ($('#usDistributionChart')) {
    $('#usDistributionChart').innerHTML = '<div class="empty">暂无全美涨跌分布</div>';
  }

  const hot = d.hot || [];
  const board = d.usBoard || {};
  const phase = board.phase || '';
  if ($('#usHotMeta')) {
    $('#usHotMeta').textContent = `${hot.length} 只· 美东 ${board.local || '--'} ${board.label || ''} · 成交额口径`
      .replace(/\s+/g, ' ')
      .trim();
  }
  const sessionCell = (s, label, live) => {
    if (!s || !isNum(s.price)) {
      return `<td class="t-sess${live ? ' is-live' : ''}"><span class="us-sess-none">--</span></td>`;
    }
    const at = s.at ? `${esc(s.at.slice(5, 10).replace('-', '/'))} ${esc(s.at.slice(11, 16))}` : '';
    const pct = isNum(s.pct)
      ? `<span class="us-sess-pct ${toneClass(s.pct)}">${pctFmt(s.pct)}</span>`
      : '<span class="us-sess-pct muted">--</span>';
    return `<td class="t-sess${live ? ' is-live' : ''}" title="${esc(label)}${at ? ` ${at} 美东` : ''}">${pct}<span class="us-sess-price">${nf(s.price, 2)}</span></td>`;
  };
  const sessionHead = (key, label, windowText) => `<th class="t-sess${phase === key ? ' is-live' : ''}" title="${label} ${windowText}（美东）">${label}</th>`;
  const mid = Math.ceil(hot.length / 2);
  const renderColumn = (rows) => `<div class="us-hot-column"><div class="table-scroll"><table class="table">
    <thead><tr><th>#</th><th>股票</th><th>板块</th>${sessionHead('pre', '盘前', board.windows?.pre || '04:00–09:30')}${sessionHead('regular', '盘中', board.windows?.regular || '09:30–16:00')}${sessionHead('post', '盘后', board.windows?.post || '16:00–20:00')}<th>成交额</th></tr></thead>
    <tbody>${rows.map((x) => `<tr data-us-stock="${esc(x.symbol)}" title="查看 ${esc(cleanName(x.name))} 实时分时">
      <td><span class="us-hot-rank">${x.rank}</span></td>
      <td><span class="us-hot-name">${esc(cleanName(x.name))}</span><span class="us-hot-symbol">${esc(x.symbol)} · ${esc(x.market)}</span></td>
      <td class="t-sess-sector"><span class="us-sector-tag" title="${esc(x.industry || '')}">${esc(x.sectorName || '--')}</span></td>
      ${sessionCell(x.sessions?.pre, '盘前', phase === 'pre')}
      ${sessionCell(x.sessions?.regular, '盘中', phase === 'regular')}
      ${sessionCell(x.sessions?.post, '盘后', phase === 'post')}
      <td class="t-price">${nf(x.dollarVolumeYi, 1)} 亿</td>
    </tr>`).join('') || '<tr><td colspan="7"><div class="empty">暂无热门美股数据</div></td></tr>'}</tbody>
  </table></div></div>`;
  hotColumns.innerHTML = hot.length
    ? renderColumn(hot.slice(0, mid)) + renderColumn(hot.slice(mid))
    : '<div class="empty">暂无热门美股数据</div>';

  // 默认跟随当前所处时段（盘前/盘中/盘后），用户手动切换后不再自动跳。
  if (!state.usPhaseTouched && ['pre', 'regular', 'post'].includes(board.phase)) {
    state.usPhase = board.phase;
  }
  $$('#usPhaseSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.usPhase === state.usPhase));
  renderUSSector();
  renderUSMinutes();
}

function usSessionPoints(item, phase) {
  const days = (item && item.days) || [];
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const d = days[i] || {};
    const arr = phase === 'pre' ? d.pre : phase === 'post' ? d.post : d.regular;
    if (Array.isArray(arr) && arr.length) return { day: d.day, points: arr };
  }
  return null;
}

function renderUSSector() {
  const list = $('#usSectorList');
  const chartEl = $('#usSectorChart');
  if (!list) return;
  const flow = state.usData && state.usData.sectorFlow;
  if (!flow || !Array.isArray(flow.items) || !flow.items.length) {
    if ($('#usSectorMeta')) $('#usSectorMeta').textContent = '--';
    list.innerHTML = '<div class="empty">暂无美股板块资金数据</div>';
    if (chartEl) chartEl.innerHTML = '<div class="empty">暂无美股板块资金</div>';
    return;
  }
  if ($('#usSectorMeta')) {
    $('#usSectorMeta').textContent = `${flow.items.length} 个板块 · 全天成交额 ${nf(flow.totalAmountYi, 0)} 亿 · 资金流估算 ${signedFmt(flow.totalFlowYi, 1)} 亿`;
  }
  usSectorFlowBar(chartEl, flow.items);
  list.innerHTML = `<table class="table us-sector-table">
    <thead><tr><th>板块</th><th>涨跌幅</th><th>成交额</th><th>资金流估算</th><th>涨/跌</th></tr></thead>
    <tbody>${flow.items.map((s) => `<tr>
      <td><span class="t-name">${esc(s.name)}</span><span class="t-code">${esc(s.sector)}</span></td>
      <td class="${toneClass(s.pct)}">${pctFmt(s.pct)}</td>
      <td class="t-dim">${nf(s.amountYi, 0)} 亿</td>
      <td class="${toneClass(s.flowYi)}">${signedFmt(s.flowYi, 1)} 亿</td>
      <td class="t-dim"><span class="tone-up">${s.up}</span> / <span class="tone-down">${s.down}</span></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderUSMinutes() {
  const grid = $('#usMinutesGrid');
  if (!grid) return;
  const tops = state.usData && Array.isArray(state.usData.topHot) ? state.usData.topHot : [];
  const board = (state.usData && state.usData.usBoard) || {};
  const phase = state.usPhase || 'pre';
  const phaseLabel = { pre: '盘前', regular: '盘中', post: '盘后' }[phase] || '盘前';
  if ($('#usMinutesMeta')) {
    const window = board.windows ? board.windows[phase] || '' : '';
    $('#usMinutesMeta').textContent = `${tops.length} 只 · 美东 ${board.local || '--'}（${board.label || '--'}）· ${phaseLabel} ${window}`
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!tops.length) {
    grid.innerHTML = '<div class="empty">暂无热门股数据</div>';
    return;
  }
  const minutes = state.usMinutes;
  if (!minutes || minutes.error) {
    grid.innerHTML = `<div class="empty">${minutes ? `分时加载失败：{esc(minutes.error || '暂无数据')}` : '正在加载热门股分时…'}</div>`;
    return;
  }
  const map = new Map((minutes.items || []).map((x) => [x.symbol, x]));
  grid.innerHTML = tops.map((x, i) => {
    const m = map.get(x.symbol) || {};
    const got = usSessionPoints(m, phase);
    const minuteLast = got ? got.points[got.points.length - 1][1] : m.last;
    // 与「24H 最热美股」表同一个快照口径：直接用 x.sessions[phase] 的价格与涨跌幅，
    // 只有该时段快照缺失时才退回分钟线末值，避免两处数字对不上。
    const sess = (x.sessions && x.sessions[phase]) || null;
    const lastPrice = sess && isNum(sess.price) ? Number(sess.price) : minuteLast;
    const pct = sess && isNum(sess.pct) ? Number(sess.pct) : (m.prevClose && isNum(lastPrice)
      ? ((Number(lastPrice) - Number(m.prevClose)) / Number(m.prevClose)) * 100
      : x.pct);
    // 迷你曲线的红绿也按同一基准反推，保证「数字涨、线是绿」这类矛盾不再出现。
    const chartBase = sess && isNum(sess.pct) && isNum(sess.price) && Number(sess.pct) > -100
      ? Number(sess.price) / (1 + Number(sess.pct) / 100)
      : m.prevClose;
    const range = got
      ? `${got.day.slice(5)} ${got.points[0][0]}–{got.points[got.points.length - 1][0]}`
      : `${phaseLabel}暂无成交`;
    return `<div class="us-mini-card" data-us-stock="${esc(x.symbol)}" title="${esc(cleanName(x.name))} ${esc(x.symbol)}">
      <div class="umi-head">
        <span class="umi-rank">${i + 1}</span>
        <div class="umi-ident"><b>${esc(cleanName(x.name))}</b><span>${esc(x.symbol)} · ${esc(x.sectorName || '未分类')}</span></div>
        <div class="umi-quote"><b class="${toneClass(pct)}">${isNum(lastPrice) ? Number(lastPrice).toFixed(2) : '--'}</b><span class="${toneClass(pct)}">${pctFmt(pct)}</span></div>
      </div>
      <div class="umi-chart" data-umi-chart data-umi-base="${isNum(chartBase) ? chartBase : ''}"></div>
      <div class="umi-foot"><span>${esc(range)}</span><span>${esc(x.industry || '')}</span></div>
    </div>`;
  }).join('');
  $$('.us-mini-card', grid).forEach((card, i) => {
    const x = tops[i];
    const m = map.get(x.symbol) || {};
    const got = usSessionPoints(m, phase);
    if (got) {
      const chartEl = $('[data-umi-chart]', card);
      const base = Number(chartEl && chartEl.dataset.umiBase);
      usMiniChart(chartEl, got.points, { preClose: Number.isFinite(base) && base > 0 ? base : m.prevClose });
    }
  });
}

/* =========================================================
   美股个股详情（v2.4.1）
   ---------------------------------------------------------
   美股没有 A 股那套「个股 secid + 日 K」，但 CNBC 的 1 分钟成交价
   覆盖 04:00–20:00 的盘前/盘中/盘后，因此这里用真实分钟成交画整幅分时，
   再配上热度表里的三段快照，做到和 A 股详情同样的「点开就能看图」。
   ========================================================= */
const US_SEG_LABEL = { all: '整日', pre: '盘前', regular: '盘中', post: '盘后' };
const US_PHASE_LABEL = { pre: '盘前', regular: '盘中', post: '盘后' };

/** 从美股热度池里找到某只股票的快照（topHot 优先，其次 hot 全量） */
function usHotItemOf(symbol) {
  const d = state.usData;
  if (!d) return null;
  for (const pool of [d.topHot, d.hot]) {
    if (!Array.isArray(pool)) continue;
    const hit = pool.find((x) => x && x.symbol === symbol);
    if (hit) return hit;
  }
  return null;
}

/** 把最近一个交易日的分钟成交按「整日 / 盘前 / 盘中 / 盘后」拼成统一点数序列 */
function usPointsFor(item, seg = 'all') {
  const days = (item && item.days) || [];
  if (!days.length) return { points: [], day: null };
  const d = days[days.length - 1] || {};
  const parts = seg === 'pre' ? [d.pre]
    : seg === 'post' ? [d.post]
      : seg === 'regular' ? [d.regular]
        : [d.pre, d.regular, d.post];
  const points = [];
  for (const arr of parts) {
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      if (!Array.isArray(p) || !Number.isFinite(Number(p[1]))) continue;
      const last = points[points.length - 1];
      // 同一分钟在两个时段里重复出现时保留后者，避免曲线回折
      if (last && last[0] === p[0]) { points[points.length - 1] = [p[0], Number(p[1])]; continue; }
      points.push([p[0], Number(p[1])]);
    }
  }
  return { points, day: d.day || null };
}

async function openUsStock(symbol) {
  if (!symbol) return;
  const meta = usHotItemOf(symbol) || {};
  state.usStockModal = { symbol, name: meta.name || '' };
  if (!routeOpening) pushDetailRoute('us', symbol);
  const overlay = mountOverlay(`
    <div class="modal modal-stock">
      <div class="modal-head">
        <div class="modal-title"><h2>${esc(cleanName(meta.name) || symbol)}</h2><span class="code">${esc(symbol)} · ${esc(meta.market || 'US')}</span></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="empty">正在加载美股实时分时…</div>
    </div>`);
  try {
    const data = await api(`/api/us/minutes?symbols=${encodeURIComponent(symbol)}`, 60000);
    if (!document.body.contains(overlay)) return;
    renderUsStockModal(symbol, meta, (data.items || [])[0] || {}, data);
  } catch (err) {
    toast(`美股分时加载失败：${err.message}`, 'err');
    closeOverlay();
  }
}

function renderUsStockModal(symbol, meta, item, data) {
  const overlay = $('.overlay');
  if (!overlay) return;
  const board = (state.usData && state.usData.usBoard) || {};
  const sessions = meta.sessions || {};
  const phaseNow = board.phase || '';
  const seg = state.usSeg || 'all';
  const { points, day } = usPointsFor(item, seg);
  const preClose = Number(item.prevClose);
  const lastPoint = points.length ? points[points.length - 1][1] : null;
  const liveSess = sessions[phaseNow] || sessions.regular || null;
  const price = liveSess && isNum(liveSess.price) ? Number(liveSess.price) : (isNum(item.last) ? Number(item.last) : lastPoint);
  const pct = liveSess && isNum(liveSess.pct) ? Number(liveSess.pct) : (isNum(item.pct) ? Number(item.pct) : null);
  const sessRow = (key, label, windowText) => {
    const s = sessions[key];
    const on = phaseNow === key;
    return `<div class="us-sess-row${on ? ' is-live' : ''}">
      <div class="usr-label">${label}<small>${esc(windowText)}</small></div>
      <div class="usr-price">${s && isNum(s.price) ? nf(s.price, 2) : '--'}</div>
      <div class="usr-pct ${s && isNum(s.pct) ? toneClass(s.pct) : 'muted'}">${s && isNum(s.pct) ? pctFmt(s.pct) : '--'}</div>
    </div>`;
  };

  overlay.innerHTML = `<div class="modal modal-stock">
    <div class="modal-head">
      <div>
        <div class="modal-title"><h2>${esc(cleanName(meta.name) || symbol)}</h2>
          <span class="code">${esc(symbol)} · ${esc(meta.market || 'US')}</span>
          ${meta.sectorName ? `<span class="badge">${esc(meta.sectorName)}</span>` : ''}
          ${phaseNow ? `<span class="badge tone-up">${esc(US_PHASE_LABEL[phaseNow] || '')}</span>` : ''}
        </div>
        <div class="muted small mt8">${esc(meta.industry || '')}${day ? ` · ${esc(String(day).slice(5))} 分钟成交` : ''}${item.error ? ' · 该股分时暂不可用' : ''}</div>
      </div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-price-row">
      <span class="modal-price ${toneClass(pct)}">${isNum(price) ? nf(price, 2) : '--'}</span>
      <span class="modal-chg ${toneClass(pct)}">${pctFmt(pct)}</span>
      <span class="badge">昨收 ${isNum(preClose) ? nf(preClose, 2) : '--'}</span>
      <span class="badge">成交额 ${isNum(meta.dollarVolumeYi) ? `${nf(meta.dollarVolumeYi, 1)} 亿` : '--'}</span>
      <span class="badge">美元 · 美东时间</span>
    </div>
    <div class="modal-kline-tools">
      <div class="seg seg-sm" id="usStockSeg" title="分时段查看">
        ${['all', 'pre', 'regular', 'post'].map((k) => `<button data-us-seg="${k}" class="${seg === k ? 'is-active' : ''}">${US_SEG_LABEL[k]}</button>`).join('')}
      </div>
      <span class="muted small">${points.length ? `${points.length} 个分钟成交点` : '该时段暂无成交'}</span>
    </div>
    <div class="modal-body-grid">
      <div>
        <div id="usStockChart" class="modal-chart"></div>
      </div>
      <div class="modal-side">
        <div class="modal-advice">
          <div class="ma-top"><span class="muted small">分时段快照</span><span class="muted small">${esc(board.local || '--')} 美东</span></div>
          <div class="us-sess-table mt8">
            ${sessRow('pre', '盘前', (board.windows && board.windows.pre) || '04:00–09:30')}
            ${sessRow('regular', '盘中', (board.windows && board.windows.regular) || '09:30–16:00')}
            ${sessRow('post', '盘后', (board.windows && board.windows.post) || '16:00–20:00')}
          </div>
          <p class="mt8">分时取自 CNBC 1 分钟成交价，覆盖 04:00–20:00 的全部延时交易时段；没有成交的时段留空，不做插值。</p>
        </div>
        <div class="modal-actions">
          <button class="btn" data-goto="us" data-close>返回美股专题</button>
        </div>
        <div class="disclaimer">美股为延时行情，不是交易所实时逐笔；分时用于刻画当日量价方向，不构成投资建议。</div>
      </div>
    </div>
  </div>`;

  usIntradayChart($('#usStockChart'), points, {
    preClose,
    segments: seg === 'all'
      ? [{ time: '09:30', label: '开盘' }, { time: '16:00', label: '收盘' }]
      : [],
  });

  $$('#usStockSeg button').forEach((b) => b.addEventListener('click', () => {
    state.usSeg = b.dataset.usSeg;
    renderUsStockModal(symbol, meta, item, data);
  }));
}

async function loadUSMinutes(force = false) {
  const tops = state.usData && Array.isArray(state.usData.topHot) ? state.usData.topHot : [];
  const symbols = tops.map((x) => x.symbol).filter(Boolean);
  if (!symbols.length) return;
  const key = symbols.join(',');
  if (!force && state.usMinutes && state.usMinutes.symbols === key && Date.now() - state.usMinutes.at < 60000) {
    renderUSMinutes();
    return;
  }
  if (state.usMinutesLoading) return;
  state.usMinutesLoading = true;
  renderUSMinutes();
  try {
    const data = await api(`/api/us/minutes?symbols=${encodeURIComponent(key)}`, 60000);
    state.usMinutes = { ...data, symbols: key, at: Date.now() };
  } catch (err) {
    state.usMinutes = { items: [], symbols: key, at: Date.now(), error: err.message };
  } finally {
    state.usMinutesLoading = false;
    renderUSMinutes();
  }
}

/* =========================================================
   期货·金银
   ========================================================= */
function cnyPerGram(usd, cnh) {
  if (!isNum(usd) || !isNum(cnh)) return null;
  return (Number(usd) * Number(cnh)) / 31.1034768;
}

function renderMetalCards() {
  const el = $('#metalCards');
  if (!el || !state.overview) return;
  const cnh = (getQuote('USDCNH') || {}).price;
  const xau = getQuote('XAU') || {};
  const xag = getQuote('XAG') || {};
  const au = getQuote('AU9999') || {};
  const ratio = isNum(xau.price) && isNum(xag.price) && Number(xag.price) !== 0 ? Number(xau.price) / Number(xag.price) : null;
  const goldCny = cnyPerGram(xau.price, cnh);
  const silverCny = cnyPerGram(xag.price, cnh);
  const premium = isNum(au.price) && isNum(goldCny) ? (Number(au.price) - goldCny) : null;

  const cards = [
    {
      cls: 'gold', name: '伦敦金', code: 'XAU', symbol: 'Au', unit: 'USD / oz',
      q: xau, cny: goldCny, foot: [['金银比', ratio ? nf(ratio, 2) : '--'], ['日内高', priceFmt(xau.high)], ['日内低', priceFmt(xau.low)]],
    },
    {
      cls: 'silver', name: '伦敦银', code: 'XAG', symbol: 'Ag', unit: 'USD / oz',
      q: xag, cny: silverCny, foot: [['金银比', ratio ? nf(ratio, 2) : '--'], ['日内高', priceFmt(xag.high)], ['日内低', priceFmt(xag.low)]],
    },
    {
      cls: 'gold', name: '上海金', code: 'AU9999', symbol: 'Au', unit: 'CNY / g',
      q: au, cny: null, foot: [['对伦敦金溢价', premium === null ? '--' : `${premium >= 0 ? '+' : ''}${nf(premium, 2)} 元/克`], ['日内高', priceFmt(au.high)], ['日内低', priceFmt(au.low)]],
    },
  ];

  el.innerHTML = cards.map((card) => {
    const q = card.q || {};
    const mini = card.code === 'XAU' ? state.miniSeries.xau : card.code === 'XAG' ? state.miniSeries.xag : state.miniSeries.au9999;
    return `<div class="metal-card ${card.cls}">
      <div class="mc-top">
        <div><div class="mc-name">${card.name}<span class="mc-code">${card.code}</span></div></div>
        <div class="mc-symbol">${card.symbol}</div>
      </div>
      <div class="mc-price ${toneClass(q.pct)}">${priceFmt(q.price)}<span class="mc-unit">${card.unit}</span></div>
      <div class="mc-change ${toneClass(q.pct)}">${pctFmt(q.pct)}　${signedFmt(q.change)}</div>
      ${card.cny !== null ? `<div class="mc-cny">≈ ${nf(card.cny, 2)}  元/克 · 按 USD/CNH ${nf(cnh, 4)} 折算</div>` : `<div class="mc-cny">国内现货基准价 · 元/克</div>`}
      <div class="mc-spark"></div>
      <div class="mc-foot">${card.foot.map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('')}</div>
    </div>`;
  }).join('');

  const sparkEls = $$('#metalCards .mc-spark');
  const series = [state.miniSeries.xau, state.miniSeries.xag, state.miniSeries.au9999];
  sparkEls.forEach((node, i) => {
    node.innerHTML = sparkline(series[i] || [], [COLORS.up, '#cbd5e1', COLORS.gold][i] || COLORS.gold);
  });
}

function renderFuturesTables() {
  const intl = $('#intlFutures');
  const dom = $('#domFutures');
  if (!intl || !dom || !state.overview) return;
  const intlCodes = [
    ['GC00Y', 'COMEX 黄金'], ['SI00Y', 'COMEX 白银'], ['HG00Y', 'COMEX 铜'],
    ['CL00Y', 'NYMEX 原油'], ['PL00Y', 'NYMEX 铂金'], ['B00Y', '布伦特原油'],
    ['M00Y', '天然气'], ['CN00Y', '富时 A50 期货'],
  ];
  const domCodes = [
    ['aum', '沪金主连'], ['agm', '沪银主连'], ['cum', '沪铜主连'], ['rbm', '螺纹钢主连'],
  ];
  const table = (specs) => `<table class="table">
    <thead><tr><th>品种</th><th>最新</th><th>涨跌</th><th>高/低</th></tr></thead>
    <tbody>${specs.map(([code, label]) => {
      const q = getQuote(code) || {};
      return `<tr data-stock-secid="${esc(q.secid)}">
        <td><span class="t-name">${label}</span><span class="t-code">${esc(code)}</span></td>
        <td class="t-price">${priceFmt(q.price)}</td>
        <td class="t-chg ${toneClass(q.pct)}">${pctFmt(q.pct)}</td>
        <td class="t-dim">${priceFmt(q.high)} / ${priceFmt(q.low)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
  intl.innerHTML = table(intlCodes);
  dom.innerHTML = table(domCodes);
}

async function loadCommodityChart(force = false) {
  try {
    const days = [30, 65, 130, 260].includes(Number(state.comDays)) ? Number(state.comDays) : 260;
    if (!force && state.comKline && state.comKline.secid === state.comSecid && state.comKlineDays === days) {
      renderCommodityChart();
      return;
    }
    const k = await getKlineCached(state.comSecid, 101, days);
    state.comKline = k;
    state.comKlineDays = days;
    renderCommodityChart();
  } catch (err) {
    handleLoadError('期货走势', err);
  }
}

function renderCommodityChart() {
  const k = state.comKline;
  if (!k) return;
  const q = getBySecid(state.comSecid) || {};
  if ($('#comChartTitle')) $('#comChartTitle').textContent = cleanName(k.name) || cleanName(q.name);
  if ($('#comChartSub')) {
    const n = (k.candles || []).length;
    const first = k.candles && k.candles.length ? String(k.candles[0].d).slice(0, 10) : '--';
    const last = k.candles && k.candles.length ? String(k.candles[k.candles.length - 1].d).slice(0, 10) : '--';
    $('#comChartSub').textContent = `${state.comSecid} · 日K · ${n} 根 · ${first} ~ ${last}${fqtHint(k)}`;
  }
  if ($('#comQuote')) $('#comQuote').innerHTML = `${priceFmt(q.price)} <small class="${toneClass(q.pct)}">${pctFmt(q.pct)}</small>`;
  candleChart($('#comChart'), k, { zoomStart: 0, indicator: currentIndicator() });
  const note = $('#comChartNote');
  if (note) {
    const map = { 30: '近1 个月', 65: '近3 个月', 130: '近6 个月', 260: '近1 年' };
    note.textContent = `当前区间：{map[state.comKlineDays] || '近1 年'}（{(k.candles || []).length} 根日线）。COMEX 黄金原始历史可回溯到 2016 年，如需更长区间可在数据源里切换。`;
  }
  renderCommoditySnapshot();
}

/* ---------------------------------------------------------
   伦敦金/ 伦敦银/ 上海金· 1 分钟分时
   --------------------------------------------------------- */
async function loadMetalsIntraday(force = false) {
  if (state.metalIntradayLoading) return;
  if (!force && state.metalIntraday && Date.now() - state.metalIntraday.at < 45000) {
    renderMetalIntraday();
    return;
  }
  state.metalIntradayLoading = true;
  try {
    const data = await api('/api/metals/intraday?codes=XAU,XAG,AU9999', 45000);
    state.metalIntraday = { ...data, at: Date.now() };
  } catch (err) {
    state.metalIntraday = { items: [], error: err.message, at: Date.now() };
  } finally {
    state.metalIntradayLoading = false;
    renderMetalIntraday();
  }
}

function renderMetalIntraday() {
  const grid = $('#metalIntradayGrid');
  if (!grid) return;
  const data = state.metalIntraday;
  if (!data) {
    grid.innerHTML = '<div class="empty">正在加载金银分钟数据…</div>';
    return;
  }
  if (data.error) {
    grid.innerHTML = `<div class="empty">金银分时加载失败：{esc(data.error)}</div>`;
    return;
  }
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    grid.innerHTML = '<div class="empty">暂无金银分时数据</div>';
    return;
  }
  const meta = $('#metalIntradayMeta');
  if (meta) {
    const rows = items.filter((x) => Array.isArray(x.points) && x.points.length);
    const stamp = rows.length && rows[0].day ? rows[0].day : '--';
    const total = rows.reduce((s, x) => s + x.points.length, 0);
    meta.textContent = `${rows.length} 个品种 · ${stamp} · 共 ${total} 个分钟点 · 实时刷新（约 45 秒）`;
  }
  grid.innerHTML = items.map((x) => {
    const hasPts = Array.isArray(x.points) && x.points.length >= 2;
    const pct = isNum(x.pct) ? x.pct : null;
    const stats = hasPts ? [
      ['今开', nf(x.first, 2)],
      ['最高', nf(x.high, 2)],
      ['最低', nf(x.low, 2)],
      ['昨收', nf(x.preClose, 2)],
      ['振幅', isNum(x.amplitude) ? `${Number(x.amplitude).toFixed(2)}%` : '--'],
      ['涨跌幅', pct === null ? '--' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`],
      ['分钟点', String(x.points.length)],
      ['单位', x.unit || '--'],
    ] : [['状态', '暂无分钟数据']];
    return `<div class="metal-mini-card" data-metal-card="${esc(x.code)}">
      <div class="mmc-head">
        <div><span class="mmc-name">${esc(x.name)}</span><span class="mmc-code">${esc(x.code)}</span></div>
        <div class="mmc-quote"><b class="${toneClass(pct)}">${hasPts ? nf(x.last, 2) : '--'}</b><span class="${toneClass(pct)}">${pct === null ? '' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}</span></div>
      </div>
      <div class="mmc-chart" data-mmc-chart></div>
      <div class="mmc-stats">${stats.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
      <div class="mmc-foot"><span>${esc(x.sourceLabel || '')}</span></div>
      ${x.note ? `<p class="mmc-note">${esc(x.note)}</p>` : ''}
    </div>`;
  }).join('');
  const cards = $$('[data-metal-card]', grid);
  cards.forEach((card, i) => {
    const x = items[i];
    const el = $('[data-mmc-chart]', card);
    if (!el) return;
    if (!x || !Array.isArray(x.candles) || x.candles.length < 2) {
      el.innerHTML = `<div class="umi-empty">${esc((x && x.error) || '暂无分时')}</div>`;
      return;
    }
    intradayChart(el, {
      candles: x.candles,
      preClose: x.preClose,
      avgLine: x.avgLine,
    });
  });
}

function renderCommoditySnapshot() {
  const el = $('#comSnapshot');
  if (!el) return;
  const q = getBySecid(state.comSecid) || {};
  const a = state.comKline && state.comKline.analysis;
  const cnh = (getQuote('USDCNH') || {}).price;
  const cny = cnyPerGram(q.price, cnh);
  el.innerHTML = `
    <div class="snapshot-hero">
      <div class="sn-name">${esc(cleanName(q.name))} <span class="code">${esc(q.code)}</span></div>
      <div class="sn-price ${toneClass(q.pct)}">${priceFmt(q.price)}</div>
      <div class="sn-chg ${toneClass(q.pct)}">${pctFmt(q.pct)} ${signedFmt(q.change)}</div>
    </div>
    <div class="snapshot-grid">
      <div class="snapshot-item"><span>今开</span><b>${priceFmt(q.open)}</b></div>
      <div class="snapshot-item"><span>昨收</span><b>${priceFmt(q.prevClose)}</b></div>
      <div class="snapshot-item"><span>最高</span><b class="tone-up">${priceFmt(q.high)}</b></div>
      <div class="snapshot-item"><span>最低</span><b class="tone-down">${priceFmt(q.low)}</b></div>
      <div class="snapshot-item"><span>折合人民币</span><b>${cny === null ? '--' : `${nf(cny, 2)} 元/克`}</b></div>
      <div class="snapshot-item"><span>金银比</span><b>${(() => { const x = getQuote('XAU'); const s = getQuote('XAG'); return x && s && s.price ? nf(x.price / s.price, 2) : '--'; })()}</b></div>
    </div>
    ${a ? `<div class="modal-section-title">技术观察</div>
      <div class="snapshot-grid">
        <div class="snapshot-item"><span>趋势</span><b class="${a.trend === 'up' ? 'tone-up' : a.trend === 'down' ? 'tone-down' : ''}">${a.trend === 'up' ? '偏多' : a.trend === 'down' ? '偏空' : '震荡'}</b></div>
        <div class="snapshot-item"><span>RSI(14)</span><b>${nf(a.rsi14, 1)}</b></div>
        <div class="snapshot-item"><span>支撑</span><b>${priceFmt(a.support)}</b></div>
        <div class="snapshot-item"><span>压力</span><b>${priceFmt(a.resistance)}</b></div>
      </div>
      <p class="muted small mt8">技术位基于最近 20 个交易日计算；期货杠杆高、波动大，请独立控制风险。</p>` : ''}`;
}

function updateConverterRates() {
  if (!state.overview || state.convTouched) return;
  const xau = getQuote('XAU');
  const cnh = getQuote('USDCNH');
  const usdInput = $('#convUsd');
  const rateInput = $('#convRate');
  if (usdInput && xau && isNum(xau.price)) usdInput.value = Number(xau.price).toFixed(2);
  if (rateInput && cnh && isNum(cnh.price)) rateInput.value = Number(cnh.price).toFixed(4);
  calcConverter();
}

function calcConverter() {
  const usd = Number($('#convUsd') && $('#convUsd').value);
  const rate = Number($('#convRate') && $('#convRate').value);
  const out = $('#convResult');
  if (!out) return;
  const val = cnyPerGram(usd, rate);
  out.textContent = val === null ? '--' : nf(val, 2);
}

/* =========================================================
   板块资金页    ========================================================= */
const SECTOR_PERIOD_LABEL = {
  today: '今日',
  '3d': '近3日',
  '5d': '近5日',
  '10d': '近2周',
  '20d': '近1月',
};

function currentSectorData() {
  const type = state.sectorPageType;
  const bag = state.sectorPeriodData[type] || {};
  const period = state.sectorPeriod;
  if (bag[period]) return bag[period];
  const legacy = state.sectors[type];
  if (!legacy) return null;
  return {
    ...legacy,
    period,
    periodLabel: SECTOR_PERIOD_LABEL[period] || '今日',
    items: legacy.items,
    stats: {
      netInflow: legacy.netInflow,
      inflowCount: legacy.inflowCount,
      outflowCount: legacy.outflowCount,
      total: legacy.total,
    },
  };
}

async function loadSectorPage(type = state.sectorPageType) {
  state.sectorPageType = type;
  await loadSectors(type);
  renderSectorPage();
  loadSectorPeriod();
}

async function loadSectorPeriod(force = false) {
  const type = state.sectorPageType;
  const period = state.sectorPeriod;
  const bag = state.sectorPeriodData[type] || (state.sectorPeriodData[type] = {});
  const requestKey = `${type}:${period}`;
  if (!force && bag[period]) {
    renderSectorPage();
    return;
  }
  if (state.sectorLoadingPeriod === requestKey) return;
  state.sectorLoadingPeriod = requestKey;
  try {
    const data = await api(`/api/sectors/period?type=${type}&period=${period}`, 60000);
    bag[period] = data;
  } catch (err) {
    bag[period] = {
      type,
      period,
      periodLabel: SECTOR_PERIOD_LABEL[period] || period,
      items: [],
      error: err.message,
      updatedAt: Date.now(),
    };
    if (period !== 'today') toast(`板块资金：{SECTOR_PERIOD_LABEL[period] || period}）：${err.message}`, 'err', 5000);
  } finally {
    if (state.sectorLoadingPeriod === requestKey) state.sectorLoadingPeriod = false;
    renderSectorPage();
  }
}

function renderSectorPage() {
  const data = currentSectorData();
  const summary = $('#sectorSummaryGrid');
  const label = SECTOR_PERIOD_LABEL[state.sectorPeriod] || '今日';
  $$('#sectorPeriodSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.sectorPeriod === state.sectorPeriod));
  if ($('#sectorHotBadge')) $('#sectorHotBadge').textContent = label;
  if ($('#sectorBarMeta')) $('#sectorBarMeta').textContent = `亿元 · ${label}主力净额`;
  if ($('#sectorHotTitle')) $('#sectorHotTitle').textContent = `热门板块 TOP 10 · ${label}`;
  if (!data || !Array.isArray(data.items)) {
    if (summary) summary.innerHTML = '<div class="summary-card"><div class="sc-label">加载中</div><div class="sc-value">--</div></div>';
    if ($('#sectorHotList')) $('#sectorHotList').innerHTML = '<div class="empty">正在加载板块资金…</div>';
    return;
  }
  if (!data.items.length) {
    if (summary) summary.innerHTML = '';
    const msg = data.error ? `该周期数据暂不可用：${esc(data.error)}` : '该周期暂无板块资金数据';
    if ($('#sectorHotList')) $('#sectorHotList').innerHTML = `<div class="empty">${msg}<br><button class="btn small mt8" data-sector-retry>重新加载</button></div>`;
    if ($('#sectorBar')) $('#sectorBar').innerHTML = '<div class="empty">暂无数据</div>';
    if ($('#sectorCompareChart')) $('#sectorCompareChart').innerHTML = '<div class="empty">暂无对比数据</div>';
    if ($('#sectorTreemap')) $('#sectorTreemap').innerHTML = '<div class="empty">该周期暂无板块资金数据</div>';
    renderSectorTable();
    return;
  }
  const byPct = [...data.items].filter((x) => isNum(x.pct)).sort((a, b) => b.pct - a.pct);
  const top = byPct[0];
  const worst = byPct[byPct.length - 1];
  const stats = data.stats || {};
  const netInflow = isNum(stats.netInflow)
    ? stats.netInflow
    : data.items.reduce((s, x) => s + (Number(x.main) || 0), 0);
  const inflowCount = isNum(stats.inflowCount) ? stats.inflowCount : data.items.filter((x) => x.main > 0).length;
  const outflowCount = isNum(stats.outflowCount) ? stats.outflowCount : data.items.filter((x) => x.main < 0).length;
  if (summary) {
    summary.innerHTML = `
      <div class="summary-card"><div class="sc-label">${esc(label)}主力净流入合计</div><div class="sc-value ${toneClass(netInflow)}">${yiFmt(netInflow)}</div><div class="sc-sub">${data.items.length} 个板块样本 {data.sampleLimited ? ' · 样本' : ''}</div></div>
      <div class="summary-card"><div class="sc-label">净流入 / 净流出</div><div class="sc-value"><span class="tone-up">${inflowCount}</span> <span class="muted">/</span> <span class="tone-down">${outflowCount}</span></div><div class="sc-sub">板块数量对比</div></div>
      <div class="summary-card"><div class="sc-label">领涨板块 {esc(label)}</div><div class="sc-value">${esc(top ? top.name : '--')}</div><div class="sc-sub ${toneClass(top && top.pct)}">${top ? pctFmt(top.pct) : '--'}</div></div>
      <div class="summary-card"><div class="sc-label">领跌板块 {esc(label)}</div><div class="sc-value">${esc(worst ? worst.name : '--')}</div><div class="sc-sub ${toneClass(worst && worst.pct)}">${worst ? pctFmt(worst.pct) : '--'}</div></div>`;
  }
  sectorTreemap($('#sectorTreemap'), data.items);
  sectorFlowBar($('#sectorBar'), data.items, { limit: 10 });
  renderSectorCompare(data);
  renderSectorHot(data);
  renderSectorTable();
  if (data.note && $('#sectorHotMeta')) {
    $('#sectorHotMeta').textContent = data.note;
  } else if ($('#sectorHotMeta')) {
    $('#sectorHotMeta').textContent = `${data.items.length} 个板块· {esc(label)}主力净额排序 · 点击展开行情`;
  }
}

function renderSectorCompare(data) {
  const chart = $('#sectorCompareChart');
  const bar = $('#sectorBar');
  if (!chart || !bar) return;
  const show = state.sectorCompare;
  bar.hidden = show;
  chart.hidden = !show;
  if (!show) return;
  const compare = data && data.compare;
  if (!compare || (!compare.inflow?.length && !compare.outflow?.length)) {
    chart.innerHTML = '<div class="empty">暂无可对比的历史资金数据（需要东方财富板块资金历史）</div>';
    return;
  }
  const hasPrevious = [...(compare.inflow || []), ...(compare.outflow || [])]
    .some((x) => x && isNum(x.previous));
  if (!hasPrevious) {
    chart.innerHTML = '<div class="empty">上期资金历史暂不可用，无法生成对比图</div>';
    return;
  }
  sectorCompareBar(chart, compare);
}

function renderSectorHot(data) {
  const el = $('#sectorHotList');
  if (!el) return;
  const source = Array.isArray(data.topIn) && data.topIn.length
    ? data.topIn
    : [...(data.items || [])].sort((a, b) => b.main - a.main).slice(0, 10);
  const items = source.slice(0, 10);
  if (!items.length) {
    el.innerHTML = '<div class="empty">暂无热门板块数据</div>';
    return;
  }
  const label = SECTOR_PERIOD_LABEL[state.sectorPeriod] || '今日';
  el.innerHTML = items.map((s, i) => {
    const hist = Array.isArray(s.history) && s.history.length > 1 ? sparkline(s.history, s.main >= 0 ? COLORS.up : COLORS.down) : '';
    const delta = isNum(s.changeVsPrev) ? `<span class="${toneClass(s.changeVsPrev)}">环比 ${signedFmt(s.changeVsPrev, 1)} 亿</span>` : '';
    return `<div class="hot-sector-card${hist ? '' : ' no-spark'}" data-sector-code="${esc(s.code)}" data-sector-name="${esc(s.name)}">
      <div class="hsc-rank">${i + 1}</div>
      <div class="hsc-main">
        <div class="hsc-name">${esc(s.name)}<span class="code">${esc(s.code)}</span></div>
        <div class="hsc-sub">${label}净流入 <b class="${toneClass(s.main)}">${yiFmt(s.main)}</b> · 涨跌 <b class="${toneClass(s.pct)}">${pctFmt(s.pct)}</b></div>
      </div>
      <div class="hsc-spark">${hist}</div>
      <div class="hsc-side">
        <span class="t-dim">成交 ${isNum(s.amountYi) ? `${nf(s.amountYi, 0)} 亿` : '--'}</span>
        ${delta}
      </div>
    </div>`;
  }).join('');
}

function renderSectorTable() {
  const el = $('#sectorTable');
  if (!el) return;
  const data = currentSectorData();
  if (!data || !Array.isArray(data.items) || !data.items.length) {
    if ($('#sectorTableCount')) $('#sectorTableCount').textContent = '--';
    el.innerHTML = `<tr><td><div class="empty">${data && data.error ? esc(data.error) : '暂无该周期的板块明细'}</div></td></tr>`;
    return;
  }
  let items = [...data.items];
  const q = state.sectorQuery.trim();
  if (q) items = items.filter((s) => s.name.includes(q) || String(s.code).includes(q));
  const key = state.sectorSort;
  items.sort((a, b) => {
    if (key === 'pct') return (b.pct || 0) - (a.pct || 0);
    if (key === 'amount') return (b.amountYi || 0) - (a.amountYi || 0);
    if (key === 'mainPct') return (b.mainPct || 0) - (a.mainPct || 0);
    return (b.main || 0) - (a.main || 0);
  });
  const maxAbs = Math.max(...items.slice(0, 50).map((s) => Math.abs(s.main || 0)), 1);
  if ($('#sectorTableCount')) $('#sectorTableCount').textContent = `${items.length} 个板块· {({ main: '主力净流入', pct: '涨跌幅', amount: '成交额', mainPct: '净占比' })[key]}`;
  const rows = items.map((s) => {
    const w = Math.max(4, Math.min(100, (Math.abs(s.main || 0) / maxAbs) * 100));
    return `<tr data-sector-code="${esc(s.code)}" data-sector-name="${esc(s.name)}">
      <td><span class="sector-name-cell"><i class="s-dot"></i>${esc(s.name)}<span class="code">${esc(s.code)}</span></span></td>
      <td class="${toneClass(s.pct)}">${pctFmt(s.pct)}</td>
      <td class="${toneClass(s.main)}"><span class="bar-cell"><i><b style="width:${w}%;background:${(s.main || 0) >= 0 ? COLORS.up : COLORS.down}"></b></i>${yiFmt(s.main)}</span></td>
      <td class="${toneClass(s.mainPct)}">${isNum(s.mainPct) ? `${nf(s.mainPct, 2)}%` : '--'}</td>
      <td class="num">${isNum(s.amountYi) ? `${nf(s.amountYi, 1)} 亿` : '--'}</td>
      <td class="t-dim"><span class="tone-up">${s.up ?? '--'}</span> / <span class="tone-down">${s.down ?? '--'}</span></td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <thead><tr><th>板块</th><th>涨跌幅</th><th>主力净流入</th><th>净占比</th><th>成交额</th><th>净占比</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6"><div class="empty">没有匹配的板块</div></td></tr>'}</tbody>`;
}

/* =========================================================
   智能策略
   ========================================================= */
async function loadAdvice(force = false) {
  if (state.loading.has('advice') && !force) return;
  state.loading.add('advice');
  try {
    const data = await api(`/api/advice?risk=${state.settings.risk}`);
    state.advice = data;
    renderPulse();
    if (state.view === 'strategy') renderStrategy();
  } catch (err) {
    handleLoadError('策略引擎', err);
  } finally {
    state.loading.delete('advice');
  }
}

function renderStrategy() {
  const a = state.advice;
  if (!a) return;
  const asOf = $('#strategyAsOf');
  if (asOf) asOf.textContent = `数据截至 ${a.asOf} · 下一交易日 ${a.nextDate} · 生成于 ${timeText(a.generatedAt)}${a.note ? ` · ${a.note}` : ''}`;
  gaugeChart($('#strategyGauge'), a.score, a.temperature.tone);
  const meta = $('#strategyTempMeta');
  if (meta) {
    meta.innerHTML = `<span>模型温度</span><span class="badge tone-${a.temperature.tone}">${esc(a.temperature.label)}</span><span>${a.score} / 100</span>`;
  }
  renderVerdict();
  renderDimensions();
  renderStrategyMetrics();
  renderReviewPanel();
  renderPlanPanel();
  renderSignalsPanel();
  renderRecentPanel();
  renderLevelsPanel();
  renderScenarioPanel();
  renderFocusPanel();
  renderRiskPanel();
  renderPortfolioAdvice();
  renderWatchAdvice();
  renderBattleStrategyStrip();
}

function renderStrategyMetrics() {
  const el = $('#strategyMetrics');
  if (!el || !state.advice) return;
  const metrics = state.advice.review.metrics || [];
  el.innerHTML = metrics.map((m) => `
    <div class="strategy-metric">
      <div class="sm-label">${esc(m.label)}</div>
      <div class="sm-value tone-${m.tone}">${esc(m.value)}</div>
      <div class="sm-sub">${esc(m.sub || '')}</div>
    </div>`).join('');
}

function renderSignalsPanel() {
  const el = $('#signalsPanel');
  if (!el || !state.advice) return;
  const s = state.advice.signals || { bull: [], bear: [] };
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">SIGNALS</div><h2>多空信号</h2></div><span class="badge">${s.bull.length} 多</ ${s.bear.length} 空</span></div>
    <div class="signal-grid">
      <div class="signal-col bull">
        <div class="signal-title"><span>支撑因素</span><span class="tone-up">${s.bull.length}</span></div>
        <ul class="signal-list">${s.bull.length ? s.bull.map((x) => `<li>${esc(x)}</li>`).join('') : '<li>暂无明显多头信号</li>'}</ul>
      </div>
      <div class="signal-col bear">
        <div class="signal-title"><span>压制因素</span><span class="tone-down">${s.bear.length}</span></div>
        <ul class="signal-list">${s.bear.length ? s.bear.map((x) => `<li>${esc(x)}</li>`).join('') : '<li>暂无明显空头信号</li>'}</ul>
      </div>
    </div>`;
}

function renderRecentPanel() {
  const el = $('#recentPanel');
  if (!el || !state.advice) return;
  const recent = state.advice.recent || [];
  if (!recent.length) {
    el.innerHTML = '<div class="panel-head"><div><div class="eyebrow">LAST 5 DAYS</div><h2>近5 日走势</h2></div></div><div class="empty">暂无近5 日数据</div>';
    return;
  }
  const closes = recent.map((r) => r.close);
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">LAST 5 DAYS</div><h2>近5 日走势</h2></div>${sparkline(closes, closes.at(-1) >= closes[0] ? COLORS.up : COLORS.down)}</div>
    <table class="recent-table">
      <thead><tr><th>日期</th><th>收盘</th><th>涨跌</th><th>成交额</th></tr></thead>
      <tbody>${recent.map((r) => `<tr>
        <td>${esc(String(r.date || '').slice(5))}</td>
        <td>${nf(r.close, 2)}</td>
        <td class="${toneClass(r.pct)}">${pctFmt(r.pct)}</td>
        <td>${compactAmount(r.volume)}</td>
      </tr>`).join('')}</tbody>
    </table>
    <p class="level-note">仅展示最近 5 个交易日，帮助判断短期节奏；不构成趋势预测。</p>`;
}

function renderVerdict() {
  const el = $('#verdictPanel');
  if (!el || !state.advice) return;
  const a = state.advice;
  el.innerHTML = `
    <div class="eyebrow">MODEL VERDICT</div>
    <div class="verdict-top">
      <div>
        <div class="verdict-score ${a.score >= 60 ? 'tone-up' : a.score < 45 ? 'tone-down' : ''}">${a.score}<small>/ 100</small></div>
        <div class="verdict-rating tone-${a.rating.tone}">${esc(a.rating.label)}</div>
      </div>
      <div class="verdict-position">
        <div class="vp-label">参考仓位</div>
        <div class="vp-value">${esc(a.position.text)}</div>
        <div class="badge tone-${a.temperature.tone} mt8">${esc(a.temperature.label)}</div>
        <div class="badge mt8" title="${esc(a.confidence.note)}">数据完整度 ${esc(a.confidence.label)} · ${a.confidence.score}%</div>
      </div>
    </div>
    <div class="verdict-line">${esc(a.oneLine)}</div>
    <div class="verdict-actions">
      <button class="btn" data-goto="sectors">查看资金主线</button>
      <button class="btn" id="copyStrategy">复制策略摘要</button>
      <button class="btn" data-goto="china">查看指数走势</button>
    </div>
    <div class="disclaimer">${esc(a.disclaimer)}</div>`;
  const copy = $('#copyStrategy');
  if (copy) {
    copy.addEventListener('click', async () => {
      const text = `${a.review.title}\n${a.review.summary}\n\n${a.plan.title}\n${a.plan.summary}\n\n仓位：{a.position.text}\n${a.disclaimer}`;
      try {
        await navigator.clipboard.writeText(text);
        toast('策略摘要已复制', 'ok');
      } catch {
        toast('复制失败，请手动选择文本', 'err');
      }
    });
  }
}

function renderDimensions() {
  const el = $('#strategyDims');
  if (!el || !state.advice) return;
  el.innerHTML = state.advice.dimensions.map((d) => `
    <div class="dimension-card">
      <div class="dc-head"><span class="dc-label">${esc(d.label)}</span><span class="dc-score tone-${d.tone}">${d.score}</span></div>
      <div class="dc-track"><i class="tone-${d.tone}" style="width:${d.score}%"></i></div>
      <div class="dc-detail">${esc(d.detail)}</div>
    </div>`).join('');
}

function renderReviewPanel() {
  const el = $('#reviewPanel');
  if (!el || !state.advice) return;
  const r = state.advice.review;
  const sections = r.sections || [];
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">SESSION REVIEW</div><h2>${esc(r.title)}</h2></div><span class="badge">${esc(r.date)}</span></div>
    <p class="review-summary">${esc(r.summary)}</p>
    ${sections.length ? `<div class="review-sections">${sections.map((s) => `<div class="review-section"><span class="rs-label">${esc(s.label)}</span><p>${esc(s.text)}</p></div>`).join('')}</div>` : `<ul class="bullets">${r.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`}`;
}

function renderPlanPanel() {
  const el = $('#planPanel');
  if (!el || !state.advice) return;
  const p = state.advice.plan;
  const rules = p.rules || [];
  const checklist = p.checklist || [];
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">NEXT SESSION</div><h2>${esc(p.title)}</h2></div><span class="badge tone-${state.advice.rating.tone}">${esc(state.advice.rating.label)}</span></div>
    <div class="stance-row"><span class="badge">${esc(p.stance)}</span><span class="badge">${esc(state.advice.nextDate)}</span><span class="badge">方向：{esc(p.direction || state.advice.rating.label)}</span></div>
    <p class="review-summary">${esc(p.summary)}</p>
    <div class="modal-section-title">如果…就？</div>
    <div class="plan-rules">${rules.map((r) => `<div class="rule-row"><span class="rule-if">如果</span><div class="rule-body"><b>${esc(r.if)}</b><em>就 ${esc(r.then)}</em></div></div>`).join('')}</div>
    <div class="modal-section-title">盘中检查清单</div>
    <div class="checklist">${checklist.map((c) => `<label class="check-item"><input type="checkbox"><span>${esc(c)}</span></label>`).join('')}</div>`;
}

function renderLevelsPanel() {
  const el = $('#levelsPanel');
  if (!el || !state.advice) return;
  const l = state.advice.levels;
  const low = Math.min(...[l.s2, l.low20, l.close].filter(isNum));
  const high = Math.max(...[l.r2, l.high20, l.close].filter(isNum));
  const span = high - low || 1;
  const pos = (v) => Math.max(2, Math.min(98, ((Number(v) - low) / span) * 100));
  const markers = [
    ['S2', l.s2, false],
    ['S1', l.s1, false],
    ['现价', l.close, true],
    ['R1', l.r1, false],
    ['R2', l.r2, false],
  ].filter(([, v]) => isNum(v));
  const rows = [
    ['强压力 R2', l.r2, 'tone-up'],
    ['压力 R1', l.r1, 'tone-up'],
    ['现价', l.close, 'current'],
    ['支撑 S1', l.s1, 'tone-down'],
    ['强支撑 S2', l.s2, 'tone-down'],
    ['MA20', l.ma20, ''],
    ['20 日高', l.high20, ''],
    ['20 日低', l.low20, ''],
  ];
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">KEY LEVELS</div><h2>上证关键位</h2></div><span class="badge">规则计算</span></div>
    <div class="level-ladder">
      <div class="ladder-track">${markers.map(([, v, cur]) => `<span class="ladder-marker ${cur ? 'current' : ''}" style="left:${pos(v)}%"></span>`).join('')}</div>
      <div class="ladder-labels">${markers.map(([label, v, cur]) => `<span class="ladder-label ${cur ? 'current' : ''}" style="left:${pos(v)}%">${label}<b>${nf(v, 2)}</b></span>`).join('')}</div>
    </div>
    <div class="levels-table">${rows.map(([label, val, cls]) => `<div class="level-row ${cls}"><span>${label}</span><b>${nf(val, 2)}</b></div>`).join('')}</div>
    <p class="level-note">支撑/压力基于最近一根日 K 的枢轴点与 20 日高低点；突破或跌破后需结合成交量确认。模型不预测点位，仅给出观察框架。</p>`;
}

function renderScenarioPanel() {
  const el = $('#scenarioPanel');
  if (!el || !state.advice) return;
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">SCENARIOS</div><h2>下一交易日情景推演</h2></div><span class="badge">概率为模型主观映射</span></div>
    <div class="scenario-list">${state.advice.scenarios.map((s) => `
      <div class="scenario-item">
        <div class="scenario-head">
          <span class="scenario-name"><i class="status-dot ${s.tone === 'up' ? 'on' : ''}" style="background:${s.tone === 'up' ? COLORS.up : s.tone === 'down' ? COLORS.down : COLORS.accent}"></i>${esc(s.label)}</span>
          <span class="scenario-prob tone-${s.tone}">${s.prob}%</span>
        </div>
        <div class="scenario-track"><i style="width:${s.prob}%;${s.tone === 'down' ? 'background:linear-gradient(90deg,#16c784,#4ade80)' : s.tone === 'flat' ? 'background:linear-gradient(90deg,#64748b,#94a3b8)' : ''}"></i></div>
        <div class="scenario-meta"><b>触发：</b>${esc(s.trigger)}<br><b>应对：</b>${esc(s.action)} · ${esc(s.target)}</div>
      </div>`).join('')}</div>`;
}

function renderFocusPanel() {
  const el = $('#focusPanel');
  if (!el || !state.advice) return;
  const f = state.advice.focus;
  const v = state.advice.avoid;
  const row = (s, cls) => `<div class="focus-row" data-sector-code="${esc(s.code)}" data-sector-name="${esc(s.name)}">
    <div class="focus-main"><div class="focus-name">${esc(s.name)}</div><div class="focus-reason">${esc(s.reason)}</div></div>
    <div class="focus-chg ${toneClass(s.pct)}">${pctFmt(s.pct)}</div>
  </div>`;
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">SECTOR TILT</div><h2>关注 / 回避</h2></div><span class="badge">资金流驱动</span></div>
    <div class="modal-section-title">优先关注</div>
    <div class="focus-list">${f.length ? f.map((s) => row(s, 'in')).join('') : '<div class="empty">暂无满足条件的流入板块</div>'}</div>
    <div class="modal-section-title">暂时回避</div>
    <div class="focus-list">${v.length ? v.map((s) => row(s, 'out')).join('') : '<div class="empty">暂无明显流出板块</div>'}</div>`;
}

function renderRiskPanel() {
  const el = $('#riskPanel');
  if (!el || !state.advice) return;
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">RISK CHECK</div><h2>风险清单</h2></div><span class="badge tone-down">务必阅读</span></div>
    <div class="risk-list">${state.advice.riskNotes.map((r, i) => `<div class="risk-item"><span class="r-index">${String(i + 1).padStart(2, '0')}</span><span>${esc(r)}</span></div>`).join('')}</div>
    <div class="disclaimer">${esc(state.advice.disclaimer)}</div>`;
}

const FUND_CAT_LABEL = {
  bond: '债券/货币',
  gold: '黄金/商品',
  overseas: '海外',
  broad: '宽基',
  sector: '行业',
  mixed: '混合/其他',
};


function fundActionOf(f) {
  const pct = Number(f.pct);
  const flow = Number(f.mainYi);
  if (f.cat === 'bond') return pct < -0.3 ? '观察，暂不加久期' : '底仓持有';
  if (f.cat === 'gold') return '对冲持有，不追涨';
  if (Number.isFinite(flow) && flow < -1) return '资金流出，减仓';
  if (Number.isFinite(pct) && pct <= -2) return '单日回撤，等企稳';
  if (f.cat === 'sector') return Number.isFinite(pct) && pct > 1.5 ? '波段持有，不追高' : '定投 / 观察';
  if (f.cat === 'broad') return '定投，分批';
  if (f.cat === 'overseas') return '分批，注意溢价';
  return '持有观察';
}

function renderPortfolioAdvice() {
  const el = $('#portfolioAdvicePanel');
  if (!el) return;
  const a = state.advice;
  const stocks = (state.watchData && state.watchData.items ? state.watchData.items : []).filter((x) => x.advice);
  const funds = (state.fundWatchData && state.fundWatchData.items ? state.fundWatchData.items : []);
  const stockCount = state.watchlist.length;
  const fundCount = state.fundWatchlist.length;
  if (!a) {
    el.innerHTML = '<div class="panel-head"><div><div class="eyebrow">PORTFOLIO ADVISOR</div><h2>自选组合建议</h2></div></div><div class="empty">正在生成组合建议…</div>';
    return;
  }
  if (!stockCount && !fundCount) {
    el.innerHTML = '<div class="panel-head"><div><div class="eyebrow">PORTFOLIO ADVISOR</div><h2>自选组合建议</h2></div></div><div class="empty">还没有自选股或自选基金。加入后，这里会结合市场温度、自选股评分、基金涨跌与 ETF 资金流，动态生成股票 + 基金组合建议<div class="mt12"><button class="btn small" data-goto="stockwatch">去添加自选</button></div></div>';
    return;
  }
  const fundRows = funds.map((f) => {
    const name = cleanName(f.name || (state.fundWatchlist.find((w) => w.code === f.code) || {}).name || f.code);
    const fresh = !f.pctStale && f.pctKind !== 'stale' && Number.isFinite(Number(f.pct));
    return { ...f, name, cat: fundCategoryOf(name), pctN: fresh ? Number(f.pct) : NaN, flowN: Number(f.mainYi) };
  });
  const avgStock = stocks.length ? stocks.reduce((s, x) => s + (Number(x.advice.score) || 0), 0) / stocks.length : null;
  const validFundPct = fundRows.map((x) => x.pctN).filter((x) => Number.isFinite(x));
  const avgFund = validFundPct.length ? validFundPct.reduce((s, x) => s + x, 0) / validFundPct.length : null;
  const etfFlow = fundRows.filter((x) => x.type === 'etf').reduce((s, x) => s + (Number(x.mainYi) || 0), 0);
  const catCounts = fundRows.reduce((m, x) => { m[x.cat] = (m[x.cat] || 0) + 1; return m; }, {});
  const catText = Object.entries(catCounts).map(([k, n]) => `${FUND_CAT_LABEL[k]} ${n}`).join(' · ');
  const suggestions = [];
  if (a.score >= 58) suggestions.push(`市场温度 ${a.score}/100，偏暖；股票与权益基金可以保持进攻，但单只高波动标的建议控制在组合的 15% 以内。`);
  else if (a.score < 45) suggestions.push(`市场温度 ${a.score}/100，偏弱；优先降低高波动股票与行业基金仓位，用债基/货币基金承接防守。`);
  else suggestions.push(`市场温度 ${a.score}/100，中性；组合以结构性机会为主，股票与基金都建议分批，不一次性满仓。`);
  if (avgStock !== null) {
    if (avgStock >= 58) suggestions.push(`自选股平均技术评分 ${avgStock.toFixed(1)}，整体偏强；关注回踩支撑，不追高。`);
    else if (avgStock < 45) suggestions.push(`自选股平均技术评分 ${avgStock.toFixed(1)}，整体偏弱；反弹优先降低弱势标的仓位。`);
    else suggestions.push(`自选股平均技术评分 ${avgStock.toFixed(1)}，分化；保留强势股，弱票等待修复。`);
  }
  if (fundCount) {
    if (etfFlow > 0) suggestions.push(`自选 ETF 合计主力净流入 ${yiFmt(etfFlow)}，资金面偏正；可继续观察连续性。`);
    else if (etfFlow < 0) suggestions.push(`自选 ETF 合计主力净流出 ${yiFmt(Math.abs(etfFlow))}，资金面偏弱；暂不急于补仓。`);
    if (avgFund !== null) suggestions.push(`自选基金平均日涨跌 ${pctFmt(avgFund)}（{avgFund >= 0 ? '组合当日偏正' : '组合当日承压'}；场外基金注意 T+1 净值。`);
    if (catText) suggestions.push(`自选基金覆盖：${catText}，{catCounts.sector && !catCounts.bond ? '行业基金占比偏高、波动集中，建议补充债基或宽基降低相关性；' : '结构相对分散，继续按类别控制单一行业暴露。'}`);
    if (!catCounts.bond) suggestions.push('自选基金里还没有债基/货币基金，建议用 10%–20% 仓位做防守，降低组合回撤。');
    if (!catCounts.gold) suggestions.push('可补充少量黄金 商品基金作为对冲，但不宜追涨，建议分批。');
    const weakFund = [...fundRows].filter((x) => Number.isFinite(x.pctN)).sort((x, y) => x.pctN - y.pctN)[0];
    if (weakFund && weakFund.pctN < -1) suggestions.push(`${weakFund.name} 当日 ${pctFmt(weakFund.pctN)}，是自选基金中较弱的一只；先观察，不与趋势对抗。`);
    const strongFund = [...fundRows].filter((x) => Number.isFinite(x.pctN)).sort((x, y) => y.pctN - x.pctN)[0];
    if (strongFund && strongFund.pctN > 1) suggestions.push(`${strongFund.name} 当日 ${pctFmt(strongFund.pctN)}，短线偏强；已有仓位可持有，空仓不追高。`);
  }
  if (fundCount && !stockCount) suggestions.push('当前以基金自选为主，建议用宽基 行业 ETF 承担进攻，债基或货币基金降低组合波动。');
  if (stockCount && !fundCount) suggestions.push('当前只有股票自选，建议补充宽基 ETF 或债基，避免单一权益暴露。');
  const stockTop = [...stocks].sort((x, y) => y.advice.score - x.advice.score).slice(0, 2);
  const fundTop = [...fundRows].filter((x) => Number.isFinite(x.pctN)).sort((x, y) => y.pctN - x.pctN).slice(0, 2);
  const equityTotal = Math.max(0, Math.min(90, Number(a.position.hi) || 30));
  const equityFundCount = fundRows.filter((f) => ['broad', 'sector', 'overseas', 'mixed'].includes(f.cat)).length;
  let stockAlloc = 0;
  let fundAlloc = 0;
  if (stockCount && equityFundCount) {
    const stockShare = Math.min(0.65, Math.max(0.35, stockCount / (stockCount + equityFundCount)));
    stockAlloc = Math.round(equityTotal * stockShare);
    fundAlloc = equityTotal - stockAlloc;
  } else if (stockCount) {
    stockAlloc = equityTotal;
  } else if (equityFundCount) {
    fundAlloc = equityTotal;
  }
  const defensiveTotal = Math.max(0, 100 - equityTotal);
  let bondAlloc = Math.round(defensiveTotal * 0.55);
  const goldAlloc = Math.round(defensiveTotal * 0.25);
  if (!stockAlloc && !fundAlloc) bondAlloc += equityTotal;
  const cashAlloc = Math.max(0, 100 - stockAlloc - fundAlloc - bondAlloc - goldAlloc);
  const alloc = { stock: stockAlloc, fund: fundAlloc, bond: bondAlloc, gold: goldAlloc, cash: cashAlloc };
  const allocTotal = Object.values(alloc).reduce((s, x) => s + x, 0) || 1;
  const allocSlices = [
    { key: 'stock', name: '股票', value: Math.round((alloc.stock / allocTotal) * 100), color: '#ff4d5e' },
    { key: 'fund', name: '权益基金', value: Math.round((alloc.fund / allocTotal) * 100), color: '#38bdf8' },
    { key: 'bond', name: '债券/货币', value: Math.round((alloc.bond / allocTotal) * 100), color: '#16c784' },
    { key: 'gold', name: '黄金/商品', value: Math.round((alloc.gold / allocTotal) * 100), color: '#f5c451' },
    { key: 'cash', name: '现金', value: Math.round((alloc.cash / allocTotal) * 100), color: '#526078' },
  ].filter((s) => s.value > 0);
  const stockActions = stocks.slice(0, 8).map(({ quote, advice }) => {
    const score = Number(advice.score) || 0;
    const text = score >= 62 ? '持有 / 回踩加仓' : score >= 52 ? '持有' : score >= 42 ? '减仓 / 等修复' : '回避 / 反弹减仓';
    return `<div class="pa-row"><div class="pa-main"><span class="pa-name">${esc(cleanName(quote.name))}</span><span class="pa-tag">评分 ${score}</span></div><b class="${score >= 52 ? 'tone-up' : score < 45 ? 'tone-down' : ''}">${text}</b></div>`;
  }).join('');
  const fundActions = fundRows.slice(0, 8).map((f) => {
    const text = fundActionOf(f);
    return `<div class="pa-row"><div class="pa-main"><span class="pa-name">${esc(f.name)}</span><span class="pa-tag">${FUND_CAT_LABEL[f.cat]} · ${pctFmt(f.pctN)}</span></div><b class="${toneClass(f.pctN)}">${text}</b></div>`;
  }).join('');
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">PORTFOLIO ADVISOR</div><h2>自选组合建议</h2><span class="muted small">股票评分 + 基金分类/涨跌 + ETF 资金 + 市场温度</span></div><span class="badge tone-${a.temperature.tone}">${esc(a.temperature.label)} · ${a.score}</span></div>
    <div class="portfolio-grid">
      <div class="portfolio-stat"><span>自选股</span><b>${stockCount} 只</b><em>${avgStock === null ? '暂无评分' : `平均评分 ${avgStock.toFixed(1)}`}</em></div>
      <div class="portfolio-stat"><span>自选基金</span><b>${fundCount} 只</b><em>${avgFund === null ? '暂无行情' : `平均日涨跌 ${pctFmt(avgFund)}`}</em></div>
      <div class="portfolio-stat"><span>ETF 资金净流入</span><b class="${toneClass(etfFlow)}">${yiFmt(etfFlow)}</b><em>仅自选 ETF</em></div>
      <div class="portfolio-stat"><span>参考仓位</span><b>${esc(a.position.text)}</b><em>${esc(a.rating.label)}</em></div>
    </div>
    <div class="portfolio-alloc">
      <div class="pa-title"><span>建议配置</span><span class="muted small">按市场温度与自选结构动态调整</span></div>
      <div class="pa-pie-wrap">
        <div class="pa-pie" id="portfolioAllocPie"></div>
        <div class="pa-legend-grid">
          ${allocSlices.map((s) => `<div class="pa-leg-item"><i class="dot ${s.key}"></i><span>${esc(s.name)}</span><b>${s.value}%</b></div>`).join('')}
        </div>
      </div>
    </div>
    <div class="portfolio-actions">
      <div class="pa-col"><div class="pa-head"><span>股票动作</span><em>${stocks.length} 只</em></div>${stockActions || '<div class="empty small">暂无自选股评分</div>'}</div>
      <div class="pa-col"><div class="pa-head"><span>基金动作</span><em>${fundCount} 只</em></div>${fundActions || '<div class="empty small">暂无自选基金</div>'}</div>
    </div>
    <div class="portfolio-suggestions">${suggestions.slice(0, 8).map((s) => `<div class="portfolio-suggestion"><i></i><span>${esc(s)}</span></div>`).join('')}</div>
    <div class="portfolio-picks">
      <div><span class="ps-label">股票关注</span>${stockTop.length ? stockTop.map(({ quote, advice }) => `<span class="chip">${esc(cleanName(quote.name))} <b>${advice.score}</b></span>`).join('') : '<span class="muted small">暂无</span>'}</div>
      <div><span class="ps-label">基金关注</span>${fundTop.length ? fundTop.map((f) => `<span class="chip">${esc(f.name)} <b class="${toneClass(f.pctN)}">${pctFmt(f.pctN)}</b></span>`).join('') : '<span class="muted small">暂无</span>'}</div>
    </div>
    <p class="muted small mt8">建议由规则组合生成，仅作观察与仓位管理参考，不构成个性化投资建议。</p>`;
  allocationPie($('#portfolioAllocPie'), allocSlices);
}

function renderWatchAdvice() {
  const el = $('#watchAdvicePanel');
  if (!el) return;
  const items = (state.watchData && state.watchData.items || []).filter((x) => x.advice);
  if (!state.watchlist.length) {
    el.innerHTML = '<div class="panel-head"><div><div class="eyebrow">WATCHLIST SCORE</div><h2>自选股评分</h2></div></div><div class="empty">添加自选后，这里会显示每只股票的技术评分、支撑压力与参考仓位。<br><button class="text-link mt8" data-goto="stockwatch">去添加<加</button></div>';
    return;
  }
  if (!items.length) {
    el.innerHTML = '<div class="panel-head"><div><div class="eyebrow">WATCHLIST SCORE</div><h2>自选股评分</h2></div></div><div class="empty">正在计算自选股评分…</div>';
    return;
  }
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">WATCHLIST SCORE</div><h2>自选股评分</h2></div><span class="badge">${items.length} 只</span></div>
    <div class="table-scroll"><table class="table">
      <thead><tr><th>标的</th><th>评分</th><th>评级</th><th>支撑/压力</th><th>仓位</th></tr></thead>
      <tbody>${[...items].sort((a, b) => b.advice.score - a.advice.score).map(({ quote, advice }) => `
        <tr data-stock-secid="${esc(quote.secid)}">
          <td><span class="t-name">${esc(cleanName(quote.name))}</span><span class="t-code">${esc(quote.code)}</span></td>
          <td class="t-price ${advice.score >= 60 ? 'tone-up' : advice.score < 45 ? 'tone-down' : ''}">${advice.score}</td>
          <td><span class="badge tone-${advice.rating.tone}">${esc(advice.rating.label)}</span></td>
          <td class="t-dim">${priceFmt(advice.levels.support)} / ${priceFmt(advice.levels.resistance)}</td>
          <td class="t-dim">${esc(advice.position.text)}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

/* =========================================================
   智能策略 · 作战中心
   ========================================================= */
const ALERT_TYPE_LABEL = {
  seal: '封板', reseal: '回封', break: '炸板', limitdown: '跌停',
  pulse: '脉冲', inflow: '抢筹', touch: '触板',
};
const BATTLE_TABS = ['overview', 'sectors', 'moves', 'ladder', 'tenday', 'timeline', 'review'];

function battleTimeText(ts) {
  if (!ts) return '--:--';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).slice(0, 5);
}

function battleMinuteText(min) {
  const m = Math.max(0, Math.min(24 * 60 - 1, Number(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
}

function battleGradeClass(grade) {
  return `grade-${grade || 'D'}`;
}

function deltaYiText(v) {
  return isNum(v) && Math.abs(Number(v)) >= 0.005 ? yiFmt(v) : '--';
}

function saveMonitorSectors() {
  saveJSON(MONITOR_SECTORS_KEY, state.monitorSectors);
}

async function loadBattle(force = false) {
  if (state.battleLoading.has('battle') && !force) return;
  state.battleLoading.add('battle');
  try {
    const data = await api('/api/battle', 40000);
    state.battle = data;
    renderBattle();
    if (state.view === 'strategy') {
      if (state.battleTab === 'overview') renderBattleOverview();
      if (state.battleTab === 'sectors' && state.battleSectors) renderBattleSectors();
    }
  } catch (err) {
    handleLoadError('作战总览', err);
  } finally {
    state.battleLoading.delete('battle');
  }
}

function switchBattleTab(tab) {
  if (!BATTLE_TABS.includes(tab)) tab = 'overview';
  if (state.battleTab === 'timeline' && tab !== 'timeline') stopTimeline();
  state.battleTab = tab;
  $$('#battleTabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.btab === tab));
  $$('.battle-page').forEach((page) => page.classList.toggle('is-active', page.dataset.bpage === tab));
  setTimeout(resizeCharts, 70);
  loadBattleTab(tab);
}

function loadBattleTab(tab, force = false) {
  if (tab === 'overview') { renderBattleOverview(); return; }
  if (tab === 'sectors') { renderBattleSectors(); if (!state.battleSectors) loadBattleSectors(force); return; }
  if (tab === 'moves') { renderMoveTable(); if (!state.battleMoves) loadBattleMoves(force); return; }
  if (tab === 'ladder') { renderLadder(); if (!state.battleLadder) loadBattleLadder(force); return; }
  if (tab === 'timeline') { renderTimeline(); if (!state.battleTimeline) loadBattleTimeline(force); return; }
  if (tab === 'tenday') { renderTenDay(); return; }
  if (tab === 'review') { renderStrategy(); return; }
}

function renderBattle() {
  const b = state.battle;
  const dateEl = $('#battleDate');
  if (dateEl) dateEl.textContent = b ? b.date : '--';
  const fresh = $('#battleFresh');
  if (fresh) fresh.textContent = b ? `${b.stale ? '缓存' : '实时'} · ${timeText(b.updatedAt)}` : '等待数据';
  renderBattleMarket();
  renderBattleStrategyStrip();
  if (state.battleTab === 'overview') renderBattleOverview();
}

function renderBattleMarket() {
  const b = state.battle;
  const ov = state.overview;
  let indices = b && b.indices;
  if (!indices || !indices.length) {
    const cn = (ov && ov.cn) || [];
    indices = ['000001', '399001', '399006', '000300'].map((code) => {
      const q = cn.find((x) => x.code === code);
      return q ? { code, name: (q.name || '').replace('指数', ''), price: q.price, pct: q.pct, amountYi: q.amountYi } : null;
    }).filter(Boolean);
  }
  const el = $('#battleIndices');
  if (el) {
    el.innerHTML = indices.length ? indices.map((q) => `
      <div class="battle-index">
        <div class="bi-name">${esc(q.name)}</div>
        <div class="bi-price ${toneClass(q.pct)}">${nf(q.price, 2)}</div>
        <div class="bi-pct ${toneClass(q.pct)}">${pctFmt(q.pct)}</div>
      </div>`).join('') : '<div class="empty" style="grid-column:1/-1">指数数据加载中…</div>';
  }
  const amountYi = b && b.totalAmountYi
    ? b.totalAmountYi
    : (((ov && ov.cn) || []).find((x) => x.code === '000001')?.amountYi || 0) + (((ov && ov.cn) || []).find((x) => x.code === '399001')?.amountYi || 0);
  if ($('#battleAmount')) $('#battleAmount').textContent = amountYi ? `${nf(amountYi, 0)} 亿` : '--';
  const breadth = (b && b.breadth) || (ov && ov.breadth) || {};
  if ($('#battleBreadth')) {
    $('#battleBreadth').innerHTML = breadth.available && isNum(breadth.up)
      ? `<span class="tone-up">${breadth.up}</span> / <span class="tone-down">${breadth.down}</span>`
      : '<span class="muted">数据源不支持</span>';
  }
  const temp = b && b.temp;
  if ($('#battleTempChip')) {
    $('#battleTempChip').textContent = temp ? `${temp.label} · ${temp.score}` : '--';
    $('#battleTempChip').className = temp ? `tone-${temp.tone}` : '';
  }
  if ($('#battleMarketMeta')) {
    $('#battleMarketMeta').textContent = b ? `${b.date} · ${b.source || '公开行情'}` : '聚合指数 / 涨跌家数 / 成交额';
  }
}

function renderBattleStrategyStrip() {
  const a = state.advice;
  const b = state.battle;
  const temp = (b && b.temp) || (a && a.temperature) || null;
  if ($('#battleScore')) $('#battleScore').textContent = a ? a.score : '--';
  if ($('#battleRating')) {
    $('#battleRating').textContent = a ? a.rating.label : '等待模型评分';
    $('#battleRating').className = a ? `bp-rating tone-${a.rating.tone}` : 'bp-rating';
  }
  if ($('#battlePosition')) $('#battlePosition').textContent = a ? `参考仓位 ${a.position.text}` : '参考仓位 --';
  if ($('#battleOneLine')) $('#battleOneLine').textContent = a ? a.oneLine : '正在生成今日复盘与下一交易日策略…';
  if ($('#battleTempLabel')) {
    $('#battleTempLabel').textContent = temp ? temp.label : '--';
    $('#battleTempLabel').className = temp ? `tone-${temp.tone}` : '';
  }
  if ($('#battleTempBar')) {
    $('#battleTempBar').firstElementChild.style.width = temp ? `${temp.score}%` : '0%';
  }
}

function renderBattleOverview() {
  const b = state.battle;
  if (!b) return;
  const kpis = $('#battleKpis');
  if (kpis) {
    kpis.innerHTML = (b.kpis || []).map((k) => `
      <div class="battle-kpi tone-${k.tone || 'flat'}">
        <div class="bk-label"><span>${esc(k.label)}</span><i></i></div>
        <div class="bk-value ${toneClass(k.tone === 'down' ? -1 : k.tone === 'up' ? 1 : 0)}">${esc(String(k.value))}<small>${esc(k.unit || '')}</small></div>
        <div class="bk-sub">${esc(k.sub || '')}</div>
      </div>`).join('');
  }
  const temp = b.temp || { score: 0, label: '--', tone: 'flat' };
  gaugeChart($('#battleGauge'), temp.score, temp.tone);
  if ($('#battleTempBadge')) {
    $('#battleTempBadge').textContent = `${temp.label} · ${temp.score}`;
    $('#battleTempBadge').className = `badge tone-${temp.tone}`;
  }
  if ($('#battleTempMeta')) {
    $('#battleTempMeta').innerHTML = `<span>今日情绪</span><span class="badge tone-${temp.tone}">${esc(temp.label)}</span><span>${temp.score} / 100</span>`;
  }
  if ($('#battleTempDims')) {
    $('#battleTempDims').innerHTML = (b.tempDims || []).map((d) => `
      <div class="battle-dim"><span>${esc(d.label)}</span><b>${d.score}</b><i><em style="width:${Math.max(2, Math.min(100, d.score))}%"></em></i></div>`).join('');
  }
  if (b.sealGrid) sealHistogram($('#sealHistChart'), b.sealGrid.bins);

  const au = b.auction || {};
  const auctionBadge = $('#auctionBadge');
  if (au.pending) {
    if (auctionBadge) auctionBadge.textContent = `扫描中 ${au.progress || 0}%`;
    if ($('#auctionChart')) $('#auctionChart').innerHTML = '<div class="empty">正在扫描全市场开盘价…</div>';
    if ($('#auctionKpis')) $('#auctionKpis').innerHTML = `<div class="auction-kpi"><span>已扫描</span><b>${au.scanned || 0}</b></div>`;
  } else if (au.buckets) {
    if (auctionBadge) auctionBadge.textContent = `${au.total} 只样本`;
    auctionBars($('#auctionChart'), au.buckets, au.total);
    if ($('#auctionKpis')) {
      $('#auctionKpis').innerHTML = `
        <div class="auction-kpi"><span>竞价涨停</span><b class="tone-up">${au.limitUpOpen || 0}</b></div>
        <div class="auction-kpi"><span>竞价跌停</span><b class="tone-down">${au.limitDownOpen || 0}</b></div>
        <div class="auction-kpi"><span>高开 / 低开</span><b>${au.highOpen || 0} / ${au.lowOpen || 0}</b></div>
        <div class="auction-kpi"><span>平均开盘</span><b class="${toneClass(au.avgGap)}">${pctFmt(au.avgGap)}</b></div>`;
    }
  }

  const mainline = $('#mainlineList');
  if (mainline) {
    mainline.innerHTML = (b.mainline || []).length ? b.mainline.map((s, i) => `
      <div class="ml-row" data-mainline-code="${esc(s.code)}" data-mainline-name="${esc(s.name)}" data-mainline-type="${esc(s.type)}">
        <span class="ml-rank">${i + 1}</span>
        <span class="ml-name"><b>${esc(s.name)}</b><span>${esc(s.type === 'industry' ? '行业' : '概念')} · 涨停 ${s.zt ?? '--'} · 领涨 ${esc(s.lead || '--')}${s.leadPct !== null && s.leadPct !== undefined ? ` ${pctFmt(s.leadPct)}` : ''}</span></span>
        <span class="ml-score"><b class="${s.score >= 78 ? 'tone-up' : s.score >= 62 ? 'tone-up' : ''}">${s.score}</b><i><em style="width:${s.score}%"></em></i></span>
        <span class="ml-tag"><span class="status-pill ${s.status.key}">${esc(s.status.label)}</span></span>
        <span class="ml-score ${toneClass(s.pct)}" style="font-size:11px">${pctFmt(s.pct)}</span>
      </div>`).join('') : '<div class="empty">板块评分加载中…</div>';
  }

  const movesTop = $('#moveTopList');
  if (movesTop) {
    movesTop.innerHTML = (b.movesTop || []).length ? b.movesTop.map((m) => `
      <div class="mt-row" data-move-secid="${esc(m.secid)}">
        <span class="mt-grade ${battleGradeClass(m.grade)}">${m.grade}</span>
        <span class="mt-name"><b>${esc(cleanName(m.name))}</b><span>${esc(cleanName(m.tags.slice(0, 3).join(' · ')) || m.industry || '')}</span></span>
        <span class="mt-pct ${toneClass(m.pct)}">${pctFmt(m.pct)}</span>
        <span class="mt-main ${toneClass(m.mainYi)}">${yiFmt(m.mainYi)}</span>
        <span class="mt-score">${m.score}</span>
      </div>`).join('') : '<div class="empty">资金异动加载中…</div>';
  }

  const feed = $('#alertFeed');
  if (feed) {
    const alerts = b.alerts || [];
    if ($('#alertBadge')) $('#alertBadge').textContent = `${alerts.length} 条`;
    feed.innerHTML = alerts.length ? alerts.map((a) => `
      <div class="alert-item tone-${a.tone || 'flat'}" data-stock-secid="${esc(a.secid)}">
        <span class="alert-time">${esc(a.time || battleTimeText(a.at))}</span>
        <span class="alert-type">${esc(ALERT_TYPE_LABEL[a.type] || '事件')}</span>
        <span class="alert-text"><b>${esc(cleanName(a.name))}</b> ${esc(a.text || '')}</span>
      </div>`).join('') : '<div class="empty">暂无警报</div>';
  }
}

async function loadBattleSectors(force = false) {
  if (state.battleLoading.has('sectors') && !force) return;
  state.battleLoading.add('sectors');
  try {
    const data = await api('/api/sector-confirm', 50000);
    state.battleSectors = data;
    if (state.view === 'strategy') renderBattleSectors();
    const expanded = state.battleSectorExpanded;
    if (expanded && !state.sectorMembers[expanded]) {
      const row = (data.items || []).find((x) => x.code === expanded);
      if (row) loadSectorMembers(row);
    }
    if (data.scan && data.scan.running) {
      clearTimeout(state.battlePoller);
      state.battlePoller = setTimeout(() => {
        if (state.view === 'strategy' && state.battleTab === 'sectors') loadBattleSectors(true);
      }, 3200);
    }
  } catch (err) {
    handleLoadError('板块确认', err);
  } finally {
    state.battleLoading.delete('sectors');
  }
}

function renderMonitorPool() {
  const el = $('#monitorPool');
  if (!el) return;
  if (!state.monitorSectors.length) {
    el.innerHTML = '<span class="mp-label">监测池：</span><span class="muted small">暂无，点击板块行【监控】加入</span>';
    return;
  }
  el.innerHTML = `<span class="mp-label">监测：${state.monitorSectors.length}</span>` + state.monitorSectors.map((s) => `
    <span class="monitor-chip" data-monitor-code="${esc(s.code)}">${esc(s.name)}<button data-unmonitor-sector="${esc(s.code)}" title="移除">×</button></span>`).join('');
}

function renderBattleSectors() {
  const data = state.battleSectors;
  renderMonitorPool();
  if (!data) return;
  const sum = data.summary || {};
  if ($('#sectorMeta')) {
    $('#sectorMeta').textContent = `${sum.total || 0} 个板块 · 行业 ${sum.industry || 0} · 概念 ${sum.concept || 0} · ${data.scan && data.scan.running ? `成分扫描 ${data.scan.progress}%` : '评分实时更新'}`;
  }
  if ($('#sectorSummary')) {
    $('#sectorSummary').innerHTML = `
      <div class="sector-stat"><span>强确认</span><b class="tone-up">${sum.strong || 0}</b><em>涨幅 / 资金 / 涨停共振</em></div>
      <div class="sector-stat"><span>已确认</span><b style="color:#f5c451">${sum.confirmed || 0}</b><em>趋势成立，等回踩</em></div>
      <div class="sector-stat"><span>观察中</span><b style="color:#7dd3fc">${sum.watch || 0}</b><em>有资金，缺涨幅</em></div>
      <div class="sector-stat"><span>待确认</span><b class="muted">${sum.pending || 0}</b><em>强度不足</em></div>`;
  }
  const el = $('#battleSectorTable');
  if (!el) return;
  const filter = state.battleSectorFilter;
  const q = state.battleSectorQuery.trim();
  let rows = (data.items || []).filter((s) => filter === 'all' || s.type === filter);
  if (q) rows = rows.filter((s) => s.name.includes(q) || String(s.lead || '').includes(q) || String(s.code).includes(q));
  if (!rows.length) {
    el.innerHTML = '<div class="empty">没有匹配的板块</div>';
    return;
  }
  const totalRows = rows.length;
  const shown = rows.slice(0, state.battleSectorLimit);
  if ($('#sectorMeta')) {
    const sum = data.summary || {};
    $('#sectorMeta').textContent = `${sum.total || 0} 个板块 · 行业 ${sum.industry || 0} · 概念 ${sum.concept || 0} · 当前显示 ${shown.length} 只 · 评分实时更新`;
  }
  const head = `<div class="sector-thead"><span>#</span><span>板块</span><span>得分</span><span>确认状态</span><span>涨跌幅</span><span>主力净流入</span><span>涨跌家跌/span><span>涨停</span><span>确认依据</span><span style="text-align:right">操作</span></div>`;
  const body = shown.map((s) => {
    const expanded = state.battleSectorExpanded === s.code;
    let detail = '';
    if (expanded) {
      const mem = state.sectorMembers[s.code];
      if (!mem || mem.loading) {
        detail = '<div class="mini-loading">正在加载成分股…</div>';
      } else if (mem.error) {
        detail = `<div class="scr-detail-note tone-down">${esc(mem.error)}</div>`;
      } else if ((mem.items || []).length) {
        detail = `<div class="scr-detail-grid">${mem.items.slice(0, 16).map((m) => `
          <div class="member-chip" data-stock-secid="${m.market}.${m.code}"><span>${esc(cleanName(m.name))}</span><b class="${toneClass(m.pct)}">${pctFmt(m.pct)}</b></div>`).join('')}</div>
          <div class="scr-detail-note">展示前 ${Math.min(16, mem.items.length)} 只/ 共 ${mem.total || mem.items.length} 只 · 点击成分股查看详情· ${mem.partial ? esc(mem.note || '仅展示涨停成分') : '导出文件包含全部成分股'}</div>`;
      } else {
        detail = `<div class="scr-detail-note">${esc(mem.note || '成分股接口暂不可用，可稍后重试或使用通达信导出')}</div>`;
      }
    }
    return `<div class="scr" data-confirm-sector="${esc(s.code)}" data-name="${esc(s.name)}" data-type="${esc(s.type)}">
      <div class="scr-main ${expanded ? 'expanded' : ''}">
        <span class="scr-rank">${s.rank}</span>
        <span class="scr-name"><b title="${esc(s.name)}">${esc(s.name)}</b><span class="scr-type ${s.type}">${s.type === 'industry' ? '行业' : '概念'}</span></span>
        <span class="scr-score"><b>${s.score}</b><i><em style="width:${s.score}%"></em></i></span>
        <span><span class="status-pill ${s.status.key}">${esc(s.status.label)}</span></span>
        <span class="scr-num ${toneClass(s.pct)}">${pctFmt(s.pct)}</span>
        <span class="scr-num ${toneClass(s.mainYi)}">${yiFmt(s.mainYi)}</span>
        <span class="scr-dim"><span class="tone-up">${s.up ?? '--'}</span>/<span class="tone-down">${s.down ?? '--'}</span></span>
        <span class="scr-num" title="${s.ztSource === 'f10' ? '按涨停股 F10 概念反推' : '按板块成分股统计'}">${s.zt ?? '--'}</span>
        <span class="scr-reason">${s.mainYi >= 1 ? '资金强' : s.mainYi > 0 ? '资金流入' : '资金流出'} · 涨停 ${s.zt ?? '--'} · 宽度 ${isNum(s.breadth) ? Math.round(s.breadth * 100) + '%' : '--'} · 涨幅 ${pctFmt(s.pct)}</span>
        <span class="scr-actions">
          <button data-monitor-sector="${esc(s.code)}" data-name="${esc(s.name)}" data-type="${esc(s.type)}" data-score="${s.score}" class="${state.monitorSectors.some((m) => m.code === s.code) ? 'on' : ''}">${state.monitorSectors.some((m) => m.code === s.code) ? '已监控' : '监控'}</button>
          <button data-export-sector="${esc(s.code)}" data-name="${esc(s.name)}" data-type="${esc(s.type)}">通达信</button>
          <button data-expand-sector="${esc(s.code)}" data-name="${esc(s.name)}" data-type="${esc(s.type)}">${expanded ? '收起' : '成分股'}</button>
        </span>
      </div>
      <div class="scr-detail" ${expanded ? '' : 'hidden'}>${detail}</div>
    </div>`;
  }).join('');
  const more = totalRows > shown.length
    ? `<div class="table-more"><button data-sector-more>加载更多（剩余 ${totalRows - shown.length} 个）</button></div>`
    : '';
  el.innerHTML = head + body + more;
}

async function loadSectorMembers(row) {
  state.sectorMembers[row.code] = { loading: true };
  renderBattleSectors();
  try {
    const data = await api(`/api/sector/members?code=${encodeURIComponent(row.code)}&name=${encodeURIComponent(row.name || '')}&type=${encodeURIComponent(row.type || 'concept')}`, 40000);
    state.sectorMembers[row.code] = { ...data, loading: false };
  } catch (err) {
    state.sectorMembers[row.code] = { loading: false, error: err.message, items: [] };
  }
  renderBattleSectors();
}

function toggleSectorExpand(row) {
  if (state.battleSectorExpanded === row.code) {
    state.battleSectorExpanded = null;
    renderBattleSectors();
    return;
  }
  state.battleSectorExpanded = row.code;
  renderBattleSectors();
  if (!state.sectorMembers[row.code]) loadSectorMembers(row);
}

function toggleMonitorSector(row) {
  const idx = state.monitorSectors.findIndex((s) => s.code === row.code);
  if (idx >= 0) {
    state.monitorSectors.splice(idx, 1);
    toast(`已移出监测池：{row.name}`, 'info');
  } else {
    state.monitorSectors.push({ code: row.code, name: row.name, type: row.type, score: Number(row.score) || 0, at: Date.now() });
    toast(`已纳入监测池：{row.name}`, 'ok');
  }
  saveMonitorSectors();
  renderBattleSectors();
}

async function exportSectorBlk(row) {
  toast(`正在生成通达信板块：${row.name}…`, 'info', 1800);
  try {
    const data = await api(`/api/sector/export?code=${encodeURIComponent(row.code)}`, 60000);
    downloadText(data.filename || `${row.name}_${row.code}.blk`, data.content || '');
    toast(`${data.partial ? '已导出盘中涨停成分' : '已导出完整板块'} ${data.count} 条 · ${data.filename}${data.partial ? '（全量成分接口限流）' : ''}`, data.partial ? 'warn' : 'ok', 5200);
  } catch (err) {
    toast(`导出失败：{err.message}`, 'err', 5000);
  }
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

async function loadBattleMoves(force = false) {
  if (state.battleLoading.has('moves') && !force) return;
  state.battleLoading.add('moves');
  try {
    const data = await api('/api/money-moves', 40000);
    state.battleMoves = data;
    if (state.view === 'strategy') renderMoveTable();
  } catch (err) {
    handleLoadError('资金异动', err);
  } finally {
    state.battleLoading.delete('moves');
  }
}

function renderMoveTable() {
  const data = state.battleMoves;
  if (!data) return;
  if ($('#moveSourceBadge')) {
    $('#moveSourceBadge').textContent = data.source === 'sina/tencent' ? '新浪 / 腾讯容错' : '东方财富';
  }
  if ($('#moveMeta')) {
    $('#moveMeta').textContent = `${data.items.length} 只异动 · 四路快照 ${battleTimeText(data.updatedAt)} · 增量主力 / 加速倍率 / 价格脉冲 / 距涨停；收盘后增量与加速为空，盘中按刷新间隔累积。`;
  }
  if ($('#moveSummary')) {
    const inf = (data.summary && data.summary.inflowTop && data.summary.inflowTop[0]) || null;
    const out = (data.summary && data.summary.outflowTop && data.summary.outflowTop[0]) || null;
    const seals = (data.items || []).filter((x) => x.state === '封板').length;
    $('#moveSummary').innerHTML = `
      <div class="move-kpi"><span>主力净流入 TOP</span><b class="tone-up">${inf ? esc(cleanName(inf.name)) : '--'}</b><em>${inf ? yiFmt(inf.mainYi) : '--'}</em></div>
      <div class="move-kpi"><span>主力净流出 TOP</span><b class="tone-down">${out ? esc(cleanName(out.name)) : '--'}</b><em>${out ? yiFmt(out.mainYi) : '--'}</em></div>
      <div class="move-kpi"><span>封板 / 炸板</span><b>${seals} / ${(data.items || []).filter((x) => x.state === '炸板').length}</b><em>封板 / 炸板</em></div>
      <div class="move-kpi"><span>今日警报</span><b>${(data.alerts || []).length}</b><em>封板 / 脉冲 / 抢筹</em></div>`;
  }
  const el = $('#moveTable');
  if (!el) return;
  const list = state.battleMoveList;
  const ids = (data.lists && data.lists[list]) || [];
  const map = new Map((data.items || []).map((x) => [x.secid, x]));
  let rows = ids.map((id) => map.get(id)).filter(Boolean);
  if (state.battleMoveFilter !== 'all') rows = rows.filter((x) => (x.tags || []).includes(state.battleMoveFilter));
  if (!rows.length) {
    el.innerHTML = '<div class="empty" style="margin:10px">当前筛选下没有异动标的</div>';
    return;
  }
  const totalRows = rows.length;
  const shown = rows.slice(0, state.battleMoveLimit);
  const head = `<div class="move-thead"><span>标的</span><span>现价</span><span>涨跌幅</span><span>分级</span><span>评分</span><span>主力净流入</span><span>1分钟增量</span><span>加速</span><span>量比</span><span>距涨停</span><span>状态</span><span>触发标签</span></div>`;
  const body = shown.map((m) => {
    const tags = (m.tags || []).slice(0, 4).map((t) => {
      const cls = /炸板|跌停|流出/.test(t) ? 'break' : /尾盘|加速/.test(t) ? 'gold' : 'hot';
      return `<span class="mv-tag ${cls}">${esc(t)}</span>`;
    }).join('');
    return `<div class="move-row" data-move-secid="${esc(m.secid)}">
      <span class="mv-name"><b>${esc(cleanName(m.name))}</b><span>${esc(m.code)} · ${esc(m.industry || '')}</span></span>
      <span class="mv-num">${nf(m.price, 2)}</span>
      <span class="mv-num ${toneClass(m.pct)}">${pctFmt(m.pct)}</span>
      <span><span class="mt-grade ${battleGradeClass(m.grade)}">${m.grade}</span></span>
      <span class="mv-num">${m.score}</span>
      <span class="mv-num ${toneClass(m.mainYi)}">${yiFmt(m.mainYi)}</span>
      <span class="mv-num ${toneClass(m.delta1m)}">${deltaYiText(m.delta1m)}</span>
      <span class="mv-num">${isNum(m.accel) ? `${nf(m.accel, 2)}×` : '--'}</span>
      <span class="mv-num">${isNum(m.volumeRatio) ? nf(m.volumeRatio, 2) : '--'}</span>
      <span class="mv-num">${isNum(m.distance) ? `${nf(m.distance, 2)}%` : '--'}</span>
      <span class="mv-num">${esc(m.state || '--')}</span>
      <span class="mv-tags">${tags || '<span class="muted small"></span>'}</span>
    </div>`;
  }).join('');
  const more = totalRows > shown.length
    ? `<div class="table-more"><button data-move-more>加载更多（剩余 ${totalRows - shown.length} 只）</button></div>`
    : '';
  el.innerHTML = head + body + more;
}

function findMoveItem(secid) {
  const pools = [state.battleMoves && state.battleMoves.items, state.battle && state.battle.movesTop];
  for (const list of pools) {
    const hit = (list || []).find((x) => x.secid === secid);
    if (hit) return hit;
  }
  return null;
}

async function openMoveDetail(secid) {
  if (!secid) return;
  const item = findMoveItem(secid) || { secid, code: secid.split('.')[1], name: secid, tags: [], reasons: [] };
  mountOverlay(`
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title"><h2>${esc(cleanName(item.name))}</h2><span class="code">${esc(item.code || '')}</span><span class="mt-grade ${battleGradeClass(item.grade)}">${esc(item.grade || 'D')}</span></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="modal-price-row">
        <span class="modal-price ${toneClass(item.pct)}">${nf(item.price, 2)}</span>
        <span class="modal-chg ${toneClass(item.pct)}">${pctFmt(item.pct)}</span>
        <span class="badge">异动评分 ${item.score ?? '--'}</span>
        <span class="badge">${esc(item.state || '--')}</span>
      </div>
      <div class="modal-body-grid">
        <div>
          <div id="moveIntraday" class="modal-chart"></div>
          <div id="moveFlow" class="modal-chart" style="height:150px;margin-top:8px"></div>
          <div class="modal-kv">
            <div class="kv"><span>主力净流入</span><b class="${toneClass(item.mainYi)}">${yiFmt(item.mainYi)}</b></div>
            <div class="kv"><span>1 分钟增量</span><b class="${toneClass(item.delta1m)}">${deltaYiText(item.delta1m)}</b></div>
            <div class="kv"><span>流入加速</span><b>${isNum(item.accel) ? `${nf(item.accel, 2)}×` : '--'}</b></div>
            <div class="kv"><span>5 分钟脉冲</span><b class="${toneClass(item.pulse5m)}">${isNum(item.pulse5m) ? pctFmt(item.pulse5m) : '--'}</b></div>
            <div class="kv"><span>量比</span><b>${isNum(item.volumeRatio) ? nf(item.volumeRatio, 2) : '--'}</b></div>
            <div class="kv"><span>距涨停</span><b>${isNum(item.distance) ? `${nf(item.distance, 2)}%` : '--'}</b></div>
          </div>
        </div>
        <div class="modal-side">
          <div class="modal-advice">
            <div class="ma-top"><span class="muted small">触发原因</span><span class="mv-tags">${(item.tags || []).map((t) => `<span class="mv-tag hot">${esc(t)}</span>`).join('')}</span></div>
            <div class="modal-reasons mt8">${(item.reasons || []).map((r) => `<div>${esc(r)}</div>`).join('') || '<div>暂无明细</div>'}</div>
            <p class="muted small mt8">异动分级由主力增量、价格脉冲、量比、封板状态与尾盘时段综合打分，仅作盘中线索。</p>
          </div>
          <div class="modal-actions">
            <button class="btn primary" id="moveWatch">选<加入自选</button>
            <button class="btn" id="moveKline">查看日K</button>
          </div>
        </div>
      </div>
    </div>`);
  const watchBtn = $('#moveWatch');
  if (watchBtn) {
    watchBtn.addEventListener('click', () => {
      if (addWatch({ secid: item.secid, code: item.code, name: item.name })) {
        watchBtn.textContent = '已加入自选';
        watchBtn.disabled = true;
      }
    });
  }
  const klineBtn = $('#moveKline');
  if (klineBtn) klineBtn.addEventListener('click', () => openStock(item.secid, item.code, item.name));
  const date = state.battle && state.battle.date ? state.battle.date : todayText().replace(/\//g, '-');
  try {
    const [intra, flow] = await Promise.all([
      api(`/api/intraday?secid=${encodeURIComponent(secid)}&date=${encodeURIComponent(date)}`, 30000).catch(() => null),
      api(`/api/flow?secid=${encodeURIComponent(secid)}`, 20000).catch(() => null),
    ]);
    if (intra && intra.candles && intra.candles.length >= 2) {
      areaChart($('#moveIntraday'), intra.candles, Number(intra.last) >= Number(intra.preClose) ? COLORS.up : COLORS.down, { axes: true });
    } else if ($('#moveIntraday')) {
      $('#moveIntraday').innerHTML = '<div class="empty">暂无分时数据</div>';
    }
    if (flow && flow.points && flow.points.length) flowLine($('#moveFlow'), flow);
    else if ($('#moveFlow')) $('#moveFlow').innerHTML = '<div class="empty">暂无主力分时</div>';
  } catch {
    if ($('#moveIntraday')) $('#moveIntraday').innerHTML = '<div class="empty">分时数据加载失败</div>';
  }
}

async function loadBattleLadder(force = false) {
  if (state.battleLoading.has('ladder') && !force) return;
  state.battleLoading.add('ladder');
  try {
    const data = await api('/api/ladder', 30000);
    state.battleLadder = data;
    if (state.view === 'strategy') renderLadder();
  } catch (err) {
    handleLoadError('连板梯队', err);
  } finally {
    state.battleLoading.delete('ladder');
  }
}

function renderLadder() {
  const data = state.battleLadder;
  if (!data) return;
  if ($('#ladderStats')) {
    $('#ladderStats').textContent = `涨停 ${data.stats.zt} · 炸板 ${data.stats.zb} · 跌停 ${data.stats.dt} · 炸板率 ${data.stats.breakRate}%`;
  }
  if ($('#ladderMeta')) $('#ladderMeta').textContent = `${data.date} · 最高${data.maxBoards} 板 · 从最高板到首板依次排列`;
  const board = $('#ladderBoard');
  if (board) {
    const countByBoard = new Map((data.levels || []).map((l) => [l.boards, l.items.length]));
    const scale = [];
    for (let b = 11; b >= 1; b -= 1) {
      const n = countByBoard.get(b) || 0;
      scale.push(`<span class="ladder-step ${n ? 'on' : ''}"><b>${b === 1 ? '首板' : b}</b><i>${n}</i></span>`);
    }
    board.innerHTML = `<div class="ladder-scale">${scale.join('')}<span class="ladder-scale-note">11 → → 首板 · 空档保留</span></div><div class="ladder">${(data.levels || []).map((level) => `
      <div class="ladder-col">
        <div class="ladder-head ${level.boards >= 3 ? 'hot' : ''}"><span>${esc(level.label)}</span><b>${level.items.length}</b></div>
        ${level.items.length ? level.items.map((x) => `
          <div class="ladder-card" data-stock-secid="${esc(x.secid)}">
            <div class="lc-top"><span class="lc-name" title="${esc(x.name)}">${esc(cleanName(x.name))}</span>${x.oneWord ? '<span class="lc-word">一字</span>' : ''}</div>
            <div class="lc-meta">封单 <b>${x.sealFundYi === null ? '--' : nf(x.sealFundYi, 2)}亿</b><br>首封 <b>${esc(x.firstSeal)}</b> · 炸板 <b>${x.breakCount}</b></div>
            <div class="lc-meta">${x.statDays ? `${x.statDays}板{x.statBoards}板` : '--'} · ${esc(x.industry || '')}</div>
            <div class="lc-fund ${toneClass(x.pct)}">${pctFmt(x.pct)} · ${x.price === null ? '--' : nf(x.price, 2)}</div>
          </div>`).join('') : '<div class="ladder-empty">—</div>'}
      </div>`).join('')}</div>`;
  }
  const broken = $('#brokenPanel');
  if (broken) {
    broken.innerHTML = `<div class="panel-head"><div><div class="eyebrow">OPENED BOARD</div><h2>炸板率</h2></div><span class="badge tone-down">${data.broken.length} 只</span></div>
      <div class="pool-list">${data.broken.length ? data.broken.map((x) => `
        <div class="pool-row" data-stock-secid="${esc(x.secid)}">
          <span class="pr-name">${esc(cleanName(x.name))}<span>${esc(x.firstSeal)} 首封 · ${esc(x.industry || '')}</span></span>
          <span class="pr-num ${toneClass(x.pct)}">${pctFmt(x.pct)}</span>
          <span class="pr-num">${x.breakCount} 次</span>
          <span class="pr-num">${x.statDays ? `${x.statDays}板{x.statBoards}板` : '--'}</span>
        </div>`).join('') : '<div class="empty">今日无炸板</div>'}</div>`;
  }
  const dt = $('#limitDownPanel');
  if (dt) {
    dt.innerHTML = `<div class="panel-head"><div><div class="eyebrow">LIMIT DOWN</div><h2>跌停率</h2></div><span class="badge tone-down">${data.limitDown.length} 只</span></div>
      <div class="pool-list">${data.limitDown.length ? data.limitDown.map((x) => `
        <div class="pool-row" data-stock-secid="${esc(x.secid)}">
          <span class="pr-name">${esc(cleanName(x.name))}<span>${esc(x.lastSeal)} 封死 · ${esc(x.industry || '')}</span></span>
          <span class="pr-num ${toneClass(x.pct)}">${pctFmt(x.pct)}</span>
          <span class="pr-num">封单 ${x.sealFundYi === null ? '--' : nf(Math.abs(x.sealFundYi), 2)}亿</span>
          <span class="pr-num">${x.days ? `${x.days}天` : '--'}</span>
        </div>`).join('') : '<div class="empty">今日无跌停</div>'}</div>`;
  }
}

async function loadBattleTimeline(force = false) {
  if (state.battleLoading.has('timeline') && !force) return;
  state.battleLoading.add('timeline');
  try {
    const data = await api('/api/timeline', 30000);
    state.battleTimeline = data;
    state.tl.events = data.events || [];
    state.tl.pos = data.startMin || 565;
    if (state.view === 'strategy' && state.battleTab === 'timeline') renderTimeline();
  } catch (err) {
    handleLoadError('时间轴复盘', err);
  } finally {
    state.battleLoading.delete('timeline');
  }
}

function renderTimeline() {
  const data = state.battleTimeline;
  const tape = $('#timelineTape');
  const feed = $('#timelineFeed');
  if (!data) return;
  const start = data.startMin || 565;
  const end = data.endMin || 900;
  if ($('#timelineBadge')) $('#timelineBadge').textContent = `${data.events.length} / ${data.totalEvents} 个事件`;
  if (tape) {
    const ticks = [];
    for (let m = 570; m <= 870; m += 30) {
      ticks.push(`<i class="tl-tick" style="left:${((m - start) / (end - start)) * 100}%"><span>${battleMinuteText(m)}</span></i>`);
    }
    const dots = data.events.map((e, i) => `<b class="tl-event-dot ${e.tone}" data-tl-dot="${i}" style="left:${((e.min - start) / (end - start)) * 100}%" title="${esc(`${e.t} ${e.label} ${e.name}`)}"></b>`).join('');
    tape.innerHTML = `${ticks.join('')}${dots}<i class="tl-playhead" id="tlPlayhead" style="left:${((state.tl.pos - start) / (end - start)) * 100}%"></i>`;
  }
  if (feed) {
    feed.innerHTML = data.events.length ? data.events.map((e, i) => `
      <div class="tl-feed-row tone-${e.tone}" data-tl-feed="${i}">
        <span class="tf-time">${esc(e.t)}</span>
        <span class="tf-label">${esc(e.label)}</span>
        <span class="tf-text"><b>${esc(cleanName(e.name))}</b> ${esc(e.detail || '')}</span>
      </div>`).join('') : '<div class="empty">暂无封板事件</div>';
  }
  updateTimelinePlayback(true);
}

function updateTimelinePlayback(forceChart = false) {
  const data = state.battleTimeline;
  if (!data) return;
  const start = data.startMin || 565;
  const end = data.endMin || 900;
  const pos = Math.max(start, Math.min(end, state.tl.pos));
  const head = $('#tlPlayhead');
  if (head) head.style.left = `${((pos - start) / (end - start)) * 100}%`;
  if ($('#tlClock')) $('#tlClock').textContent = battleMinuteText(pos);
  let revealed = 0;
  $$('#timelineFeed .tl-feed-row').forEach((row) => {
    const i = Number(row.dataset.tlFeed);
    const on = data.events[i] && data.events[i].min <= pos;
    row.classList.toggle('on', Boolean(on));
    if (on) revealed += 1;
  });
  $$('#timelineTape .tl-event-dot').forEach((dot) => {
    const i = Number(dot.dataset.tlDot);
    dot.classList.toggle('on', Boolean(data.events[i] && data.events[i].min <= pos));
  });
  if ($('#tlProgress')) $('#tlProgress').textContent = `${revealed} / ${data.events.length}`;
  const now = performance.now();
  if (forceChart || !state.tl.lastChart || now - state.tl.lastChart > 140) {
    state.tl.lastChart = now;
    timelineCumulative($('#timelineChart'), data.events, pos);
  }
  const feed = $('#timelineFeed');
  if (feed && state.tl.playing) {
    const active = feed.querySelector('.tl-feed-row.on:last-of-type');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
}

function timelineTick(now) {
  if (!state.tl.playing) return;
  const dt = Math.max(0, Math.min(80, now - (state.tl.last || now)));
  state.tl.last = now;
  const speed = Number(state.tl.speed) || 60;
  state.tl.pos += (dt / 60000) * speed;
  const end = state.battleTimeline ? state.battleTimeline.endMin || 900 : 900;
  if (state.tl.pos >= end) {
    state.tl.pos = end;
    updateTimelinePlayback(true);
    state.tl.playing = false;
    if ($('#tlPlay')) $('#tlPlay').textContent = '▶ 重播';
    return;
  }
  updateTimelinePlayback();
  state.tl.raf = requestAnimationFrame(timelineTick);
}

function startTimeline() {
  if (!state.battleTimeline) { loadBattleTimeline(); return; }
  const start = state.battleTimeline.startMin || 565;
  const end = state.battleTimeline.endMin || 900;
  if (state.tl.pos >= end - 0.01) state.tl.pos = start;
  state.tl.playing = true;
  state.tl.last = performance.now();
  if ($('#tlPlay')) $('#tlPlay').textContent = '⏸ 暂停';
  updateTimelinePlayback(true);
  cancelAnimationFrame(state.tl.raf);
  state.tl.raf = requestAnimationFrame(timelineTick);
}

function stopTimeline() {
  state.tl.playing = false;
  cancelAnimationFrame(state.tl.raf);
  if ($('#tlPlay')) $('#tlPlay').textContent = '▶ 播放';
}

function renderTenDay() {
  const data = state.battleTenDay;
  const status = $('#tenDayStatus');
  if (!status) return;
  if (!data) {
    status.className = 'ten-day-status';
    status.textContent = '点击「一键扫描近 10 日」，扫描涨停 / 炸板 / 涨跌幅榜 / 资金异动池…';
    if ($('#tenDayList')) $('#tenDayList').innerHTML = '';
    return;
  }
  if (data.pending) {
    const p = data.progress || {};
    status.className = 'ten-day-status';
    status.textContent = `正在扫描近10 日数据…${p.progress || 0}%（{p.done || 0}/${p.total || 0}）`;
    return;
  }
  if (data.error) {
    status.className = 'ten-day-status err';
    status.textContent = `扫描失败：{data.error}`;
    return;
  }
  status.className = 'ten-day-status';
  status.innerHTML = `${esc(data.date)} · 扫描 ${data.scanned || 0} 只（候选池 ${data.universe || 0} 只） · ${esc(data.note || '')}`;
  const el = $('#tenDayList');
  if (!el) return;
  if (!(data.items || []).length) {
    el.innerHTML = '<div class="empty">没有扫描到数据</div>';
    return;
  }
  const dir = state.battleTenDayDir;
  const shown = data.items.slice(0, state.battleTenDayLimit);
  const more = data.items.length > shown.length
    ? `<div class="table-more"><button data-ten-more>加载更多（剩余 ${data.items.length - shown.length} 只）</button></div>`
    : '';
  el.innerHTML = `<div class="td-list">${shown.map((x, i) => `
    <div class="td-row" data-stock-secid="${esc(x.secid)}">
      <span class="td-num">${i + 1}</span>
      <span class="td-name"><b>${esc(cleanName(x.name))}</b><span>${esc(x.code)} · ${esc(x.industry || '')}</span></span>
      <span class="td-num ${toneClass(x.cumPct)}">${pctFmt(x.cumPct)}<small>累计</small></span>
      <span class="td-num"><b class="tone-up">${x.upDays || 0}</b> / <b class="tone-down">${x.downDays || 0}</b><small>连涨 / 连跌</small></span>
      <span class="td-num">${x.limitCount || 0}<small>涨停次数</small></span>
      <span class="td-num ${toneClass(x.maxDay)}">${pctFmt(x.maxDay)}<small>最大单笔</small></span>
      <span class="td-num">${isNum(x.volRatio) ? `${nf(x.volRatio, 2)}×` : '--'}<small>量能放大</small></span>
      <span class="td-num">${x.flowStreak || 0}<small>资金连流入</small></span>
      <span class="td-num ${toneClass(x.flowSumYi)}">${yiFmt(x.flowSumYi)}<small>10日主力</small></span>
      <span class="td-spark">${sparkline(x.spark, dir === 'down' ? COLORS.down : COLORS.up)}</span>
    </div>`).join('')}</div>${more}`;
}

async function loadBattleTenDay(force = false) {
  const dir = state.battleTenDayDir;
  const pending = state.battleTenDay && state.battleTenDay.pending;
  if (state.battleTenDayLoading && !force && !pending) return;
  state.battleTenDayLoading = true;
  clearTimeout(state.tenDayPoller);
  if (!state.battleTenDay || force) {
    state.battleTenDay = { pending: true, progress: { progress: 0, done: 0, total: 0 } };
    renderTenDay();
  }
  try {
    const data = await api(`/api/ten-day?dir=${dir}${force ? '&force=1' : ''}`, 30000);
    state.battleTenDay = data;
    renderTenDay();
    if (data.pending) {
      state.tenDayPoller = setTimeout(() => {
        if (state.view === 'strategy' && state.battleTab === 'tenday') loadBattleTenDay(false);
        else state.battleTenDayLoading = false;
      }, 2600);
    } else {
      state.battleTenDayLoading = false;
    }
  } catch (err) {
    state.battleTenDayLoading = false;
    state.battleTenDay = { error: err.message, pending: false };
    renderTenDay();
    handleLoadError('十日异动', err);
  }
}

function openSectorFromOverview(code, name, type) {
  state.battleSectorFilter = 'all';
  state.battleSectorQuery = '';
  state.battleSectorLimit = 40;
  if ($('#battleSectorSearch')) $('#battleSectorSearch').value = '';
  $$('#sectorTypeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.secType === 'all'));
  state.battleSectorExpanded = code;
  switchBattleTab('sectors');
  if (state.battleSectors) {
    renderBattleSectors();
    setTimeout(() => {
      const row = document.querySelector(`[data-confirm-sector="${code}"]`);
      if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
    if (!state.sectorMembers[code]) loadSectorMembers({ code, name, type });
  }
}

function bindBattleEvents() {
  $('#battleTabs') && $('#battleTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-btab]');
    if (btn) switchBattleTab(btn.dataset.btab);
  });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-btab-go]');
    if (go) { switchBattleTab(go.dataset.btabGo); return; }
    const mainline = e.target.closest('[data-mainline-code]');
    if (mainline) {
      openSectorFromOverview(mainline.dataset.mainlineCode, mainline.dataset.mainlineName, mainline.dataset.mainlineType);
      return;
    }
    const move = e.target.closest('[data-move-secid]');
    if (move) { openMoveDetail(move.dataset.moveSecid); return; }
    const unmon = e.target.closest('[data-unmonitor-sector]');
    if (unmon) {
      state.monitorSectors = state.monitorSectors.filter((s) => s.code !== unmon.dataset.unmonitorSector);
      saveMonitorSectors();
      renderBattleSectors();
      return;
    }
  });

  $('#battleRefresh') && $('#battleRefresh').addEventListener('click', async () => {
    toast('正在刷新作战数据…', 'info', 1500);
    await Promise.allSettled([loadBattle(true), loadAdvice(true), loadWatchData(true)]);
    loadBattleTab(state.battleTab, true);
    toast('作战数据已刷新', 'ok', 1500);
  });

  $('#sectorTypeSeg') && $('#sectorTypeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sec-type]');
    if (!btn) return;
    state.battleSectorFilter = btn.dataset.secType;
    state.battleSectorLimit = 40;
    $$('#sectorTypeSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderBattleSectors();
  });
  const search = $('#battleSectorSearch');
  if (search) {
    search.addEventListener('input', debounce((e) => {
      state.battleSectorQuery = e.target.value;
      state.battleSectorLimit = 40;
      renderBattleSectors();
    }, 160));
  }
  const table = $('#battleSectorTable');
  if (table) {
    table.addEventListener('click', (e) => {
      if (e.target.closest('[data-stock-secid]')) return; // 交给个股详情全局委托
      const more = e.target.closest('[data-sector-more]');
      if (more) { state.battleSectorLimit += 40; renderBattleSectors(); return; }
      const mon = e.target.closest('[data-monitor-sector]');
      if (mon) { toggleMonitorSector({ code: mon.dataset.monitorSector, name: mon.dataset.name, type: mon.dataset.type, score: mon.dataset.score }); return; }
      const exp = e.target.closest('[data-export-sector]');
      if (exp) { exportSectorBlk({ code: exp.dataset.exportSector, name: exp.dataset.name, type: exp.dataset.type }); return; }
      const expand = e.target.closest('[data-expand-sector]');
      if (expand) { toggleSectorExpand({ code: expand.dataset.expandSector, name: expand.dataset.name, type: expand.dataset.type }); return; }
      const row = e.target.closest('[data-confirm-sector]');
      if (row) toggleSectorExpand({ code: row.dataset.confirmSector, name: row.dataset.name, type: row.dataset.type });
    });
  }

  $('#moveTabs') && $('#moveTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-move-list]');
    if (!btn) return;
    state.battleMoveList = btn.dataset.moveList;
    state.battleMoveLimit = 40;
    $$('#moveTabs button').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderMoveTable();
  });
  $('#moveFilters') && $('#moveFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-move-filter]');
    if (!btn) return;
    state.battleMoveFilter = btn.dataset.moveFilter;
    state.battleMoveLimit = 40;
    $$('#moveFilters button').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderMoveTable();
  });
  $('#moveTable') && $('#moveTable').addEventListener('click', (e) => {
    if (e.target.closest('[data-move-more]')) {
      state.battleMoveLimit += 40;
      renderMoveTable();
    }
  });
  $('#tenDayList') && $('#tenDayList').addEventListener('click', (e) => {
    if (e.target.closest('[data-ten-more]')) {
      state.battleTenDayLimit += 30;
      renderTenDay();
    }
  });

  $('#tenDayDirSeg') && $('#tenDayDirSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ten-dir]');
    if (!btn) return;
    state.battleTenDayDir = btn.dataset.tenDir;
    state.battleTenDay = null;
    state.battleTenDayLimit = 30;
    $$('#tenDayDirSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderTenDay();
  });
  $('#tenDayScan') && $('#tenDayScan').addEventListener('click', () => {
    state.battleTenDayLimit = 30;
    loadBattleTenDay(true);
  });
  $('#tlPlay') && $('#tlPlay').addEventListener('click', () => {
    if (state.tl.playing) { stopTimeline(); return; }
    startTimeline();
  });
  $('#tlReset') && $('#tlReset').addEventListener('click', () => {
    stopTimeline();
    state.tl.pos = state.battleTimeline ? state.battleTimeline.startMin || 565 : 565;
    updateTimelinePlayback(true);
  });
  $('#tlSpeedSeg') && $('#tlSpeedSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tl-speed]');
    if (!btn) return;
    state.tl.speed = Number(btn.dataset.tlSpeed) || 60;
    $$('#tlSpeedSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
  });
}

/* =========================================================
   自选 / 预警
   ========================================================= */

/* =========================================================
   自选 / 预警
   ========================================================= */
function renderWatchTable() {
  const el = $('#watchTable');
  if (!el) return;
  if ($('#watchCount')) $('#watchCount').textContent = `${state.watchlist.length} 只`;
  if (!state.watchlist.length) {
    el.innerHTML = `<div class="empty">自选列表为空。可以从上方搜索添加，或直接点击示例<div class="chip-row mt8" style="justify-content:center">
      ${DEFAULT_WATCH.slice(0, 4).map((w) => `<button class="tag" data-demo-watch="${esc(w.secid)}">${esc(w.name)}</button>`).join('')}
    </div></div>`;
    return;
  }
  const items = state.watchData && state.watchData.items ? state.watchData.items : [];
  if (!items.length) {
    el.innerHTML = '<div class="empty">正在加载自选行情…</div>';
    return;
  }
  const order = new Map(state.watchlist.map((w, i) => [w.secid, i]));
  const sorted = [...items].sort((a, b) => (order.get(a.quote.secid) ?? 999) - (order.get(b.quote.secid) ?? 999));
  // v2.7.0：改成和「我的自选基金」一致的表格式列表（同样的表头/拖拽/操作按钮/手机端列精简），
  // 复用 .fund-watch-table 的样式与响应式规则，只额外标一个 watch-stock-table 便于单独微调。
  el.innerHTML = `<div class="table-scroll"><table class="table fund-watch-table watch-stock-table">
    <thead><tr>
      <th>股票</th><th data-col="last">最新</th><th>涨跌幅</th><th data-col="flow">主力净流入</th>
      <th data-col="score">技术评分</th><th data-col="rating">评级 / 仓位</th><th data-col="industry">行业</th><th>操作</th>
    </tr></thead>
    <tbody>${sorted.map(({ quote, advice: av }) => {
      const q = quote || {};
      return `<tr draggable="true" data-drag-secid="${esc(q.secid)}" data-stock-secid="${esc(q.secid)}" title="拖动行排序，点击查看详情">
        <td><span class="fund-drag-grip">⋮⋮</span><span class="t-name">${esc(cleanName(q.name))}</span><span class="t-code">${esc(q.code)}</span></td>
        <td data-col="last" class="t-price">${stockFmt(q.price)}${q.priceMode === 'prevClose' ? '<div class="t-sub">昨收</div>' : ''}</td>
        <td class="t-chg ${toneClass(q.pct)}"${q.priceMode === 'prevClose' ? ' title="开盘前没有成交价，现价与涨跌幅按昨收计算"' : ''}>${pctFmt(q.pct)}</td>
        <td data-col="flow" class="t-chg ${toneClass(q.mainYi)}">${yiFmt(q.mainYi)}</td>
        <td data-col="score" class="t-price ${av && av.score >= 60 ? 'tone-up' : av && av.score < 45 ? 'tone-down' : ''}">${av ? av.score : '--'}</td>
        <td data-col="rating">${av ? `<span class="badge tone-${av.rating.tone}">${esc(av.rating.label)}</span><div class="t-sub">${esc(av.position.text)}</div>` : '--'}</td>
        <td data-col="industry" class="t-dim">${esc(q.industry || '--')}</td>
        <td><div class="fund-watch-actions watch-actions">
          <button title="查看 K 线详情" data-watch-action="chart" data-secid="${esc(q.secid)}">K</button>
          <button class="move" title="上移" data-watch-action="up" data-secid="${esc(q.secid)}">↑</button>
          <button class="move" title="下移" data-watch-action="down" data-secid="${esc(q.secid)}">↓</button>
          <button title="添加价格预警" data-watch-action="alert" data-secid="${esc(q.secid)}">警</button>
          <button class="del" title="移出自选" data-watch-action="remove" data-secid="${esc(q.secid)}">×</button>
        </div></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
  bindWatchDrag(el);
}

/** 自选股拖拽排序（桌面 HTML5 + 手机长按），与自选基金同一套体验 */
function bindWatchDrag(container) {
  if (!container || container.dataset.watchDragBound === '1') return;
  container.dataset.watchDragBound = '1';
  bindTouchReorder(container, '[data-drag-secid]', 'dragSecid', (from, to) => reorderWatch(from, to));
  let dragSecid = null;
  container.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-drag-secid]');
    if (!row) return;
    dragSecid = row.dataset.dragSecid;
    row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSecid || '');
    }
  });
  container.addEventListener('dragover', (e) => {
    const row = e.target.closest('[data-drag-secid]');
    if (!row || !dragSecid) return;
    e.preventDefault();
    $$('.drag-over', container).forEach((r) => r.classList.remove('drag-over'));
    if (row.dataset.dragSecid !== dragSecid) row.classList.add('drag-over');
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  container.addEventListener('dragleave', (e) => {
    const row = e.target.closest('[data-drag-secid]');
    if (row) row.classList.remove('drag-over');
  });
  container.addEventListener('drop', (e) => {
    const row = e.target.closest('[data-drag-secid]');
    if (!row) return;
    e.preventDefault();
    const target = row.dataset.dragSecid;
    row.classList.remove('drag-over');
    const from = dragSecid;
    dragSecid = null;
    reorderWatch(from, target);
  });
  container.addEventListener('dragend', () => {
    dragSecid = null;
    $$('.dragging, .drag-over', container).forEach((r) => r.classList.remove('dragging', 'drag-over'));
  });
}

/** 把一条预警规则渲染成人类可读的条件文本 */
function alertConditionText(a) {
  if (!a) return '';
  const opLabel = ALERT_OP_LABEL[a.op] || a.op;
  if (isTrendAlert(a.kind)) return `${ALERT_KIND_LABEL[a.kind]} ${opLabel}`;
  const unit = a.kind === 'pct' ? '%' : a.kind === 'volume' ? ' 倍' : '';
  return `${ALERT_KIND_LABEL[a.kind]} ${opLabel} ${nf(a.value, 2)}${unit}`;
}

function renderAlerts() {
  const el = $('#alertsPanel');
  if (!el) return;
  const rows = state.alerts;
  const activeRows = rows.filter((a) => a.active);
  const hitRows = rows.filter((a) => !a.active).sort((a, b) => (b.triggeredAt || 0) - (a.triggeredAt || 0));
  // 云端预警状态（阶段 2.4）：规则存服务端，关页面也继续盯
  const cloud = state.cloudAlerts || { enabled: false, items: [] };
  const cloudActive = (cloud.items || []).filter((a) => a.active).length;
  const cloudText = cloud.enabled
    ? `已同步 ${(cloud.items || []).length} 条（监控中 ${cloudActive}）· 命中后走推送${cloud.lastPush ? ` · 上次${cloud.lastPush.ok ? '已推送' : '推送失败'}` : ''}`
    : '未开启：关掉页面后不再监控';
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">CONDITION ALERTS</div><h2>条件预警</h2></div><span class="badge">${activeRows.length} 条监控中</span></div>
    ${rows.length ? `<div class="alert-list">${[...activeRows, ...hitRows].map((a) => `
      <div class="alert-row">
        <div class="alert-main">
          <div class="alert-name">${esc(cleanName(a.name))} <span class="code">${esc(a.code)}</span><span class="alert-kind">${esc(ALERT_KIND_LABEL[a.kind] || '')}</span></div>
          <div class="alert-cond">${esc(alertConditionText(a))}${a.active ? ' 时提醒' : ''}${a.triggerNote ? ` · ${esc(a.triggerNote)}` : ''}</div>
        </div>
        <span class="alert-state ${a.active ? 'on' : 'hit'}">${a.active ? '监控中' : '已触发'}</span>
        <button class="alert-del" title="删除" data-alert-id="${esc(a.id)}">×</button>
      </div>`).join('')}</div>` : '<div class="empty">还没有条件预警。打开任意股票详情，可选价格、涨跌幅、量比、均线穿越与 MACD 交叉。</div>'}
    <div class="cloud-alert-row mt12">
      <label class="auto-toggle" title="开启后规则存到服务端，关掉页面也会继续盯，命中时走推送">
        <input type="checkbox" id="cloudAlertToggle" ${cloud && cloud.enabled ? 'checked' : ''}>
        <span class="switch-ui"></span>
        <span>云端预警</span>
      </label>
      <button class="btn small" id="cloudAlertSync">同步规则到云端</button>
      <span class="muted small" id="cloudAlertMeta">${esc(cloudText)}</span>
    </div>
    <div class="mt8 row-between">
      <button class="btn small" data-action="notify">${('Notification' in window) && Notification.permission === 'granted' ? '通知已开启' : '开启浏览器通知'}</button>
      <span class="muted small">本地预警仅在页面打开时监控</span>
    </div>`;

  const cloudToggle = $('#cloudAlertToggle');
  if (cloudToggle) {
    cloudToggle.addEventListener('change', async () => {
      const on = cloudToggle.checked;
      try {
        // 开启时顺手把当前本地规则一起推上去，避免"开了云端但一条规则都没有"
        await saveCloudAlerts(on, on ? state.alerts : undefined);
        toast(on ? '云端预警已开启，关闭页面后仍会监控' : '云端预警已关闭', on ? 'ok' : 'info', 3000);
      } catch (err) {
        cloudToggle.checked = !on;
        toast(`云端预警设置失败：${err.message}`, 'err');
      }
    });
  }
  const syncBtn = $('#cloudAlertSync');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = '同步中…';
      try {
        const res = await saveCloudAlerts(true, state.alerts);
        toast(`已同步 ${(res.items || []).length} 条规则到云端`, 'ok');
      } catch (err) {
        toast(`同步失败：${err.message}`, 'err');
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = '同步规则到云端';
      }
    });
  }
}

function renderWatchTips() {
  const el = $('#watchTips');
  if (!el) return;
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">HOW TO USE</div><h2>使用提示</h2></div></div>
    <ul class="tips-list">
      <li>自选股会同时拉取技术评分：≥60 偏多，45–60 中性，&lt;45 偏空</li>
      <li>条件预警支持五类规则：价格、涨跌幅、量比、均线穿越 MA20、MACD 金叉死叉</li>
      <li>打开「云端预警」后规则存到服务端，关掉页面也继续监控，命中走后台配置的推送通道；不开启则只在本页面运行</li>
      <li>点击 K 看 K 线、支撑压力与主力资金；打开个股详情的「基本面 / 龙虎榜」「个股资讯」可看 F10 与相关新闻</li>
      <li>数据刷新频率默认 15 秒；可在右上角设置中调整，或关闭自动刷新</li>
      <li>模拟交易按最新价成交、含费用，仅用于复盘；所有评分均为规则模型输出，不构成买卖指令</li>
    </ul>`;
}

/* =========================================================
   云端预警（阶段 2.4：规则存服务端，关掉页面也继续盯）
   ========================================================= */

async function loadCloudAlerts() {
  try {
    const data = await api('/api/alerts', 15000);
    state.cloudAlerts = data && typeof data === 'object' ? data : { enabled: false, items: [] };
  } catch {
    // 未登录或接口不可用时保持「本地预警」模式，不影响页面
    state.cloudAlerts = state.cloudAlerts || { enabled: false, items: [] };
  }
  renderAlerts();
}

async function saveCloudAlerts(enabled, items) {
  const payload = { enabled };
  if (items) payload.items = items;
  const data = await apiPost('/api/alerts', payload);
  state.cloudAlerts = { ...(state.cloudAlerts || {}), ...(data || {}) };
  renderAlerts();
  return data;
}

/* =========================================================
   模拟交易（阶段 3.3）
   ========================================================= */

async function loadPaper(force = false) {
  if (!force && state.paper) { renderPaper(); return; }
  try {
    state.paper = await api('/api/paper', 20000);
    state.paperAt = Date.now();
  } catch (err) {
    if ($('#paperPanel')) {
      $('#paperPanel').innerHTML = `<div class="panel-head"><h3>模拟交易</h3></div><div class="empty">加载失败：${esc(err.message)}</div>`;
    }
    return;
  }
  renderPaper();
}

function renderPaper() {
  const el = $('#paperPanel');
  if (!el) return;
  const d = state.paper;
  if (!d) { el.innerHTML = '<div class="empty">加载模拟交易账户…</div>'; return; }
  // 0 收益用中性色，避免"平盘也标红"
  const tone = d.profit > 0 ? 'tone-up' : d.profit < 0 ? 'tone-down' : 'muted';
  const priceUpdated = d.pricesAsOf ? timeText(d.pricesAsOf) : (d.updatedAt ? timeText(d.updatedAt) : '--:--:--');
  const posRows = (d.positions || []).map((p) => `<tr data-paper-secid="${esc(p.secid)}">
    <td><span class="t-name">${esc(cleanName(p.name))}</span><span class="t-sub">${esc(p.code)}</span></td>
    <td>${nf(p.shares, 0)}</td>
    <td>${nf(p.cost, 3)}</td>
    <td>${nf(p.price, 3)}${p.priceMode === 'prevClose' ? '<div class="t-sub">昨收</div>' : p.priceMode === 'cost' ? '<div class="t-sub">按成本估</div>' : ''}</td>
    <td class="${toneClass(p.pct)}"${p.priceMode === 'prevClose' ? ' title="开盘前没有成交价，按昨收估"' : ''}>${p.pct === null ? '--' : pctFmt(p.pct)}</td>
    <td>${nf(p.marketValue, 0)}</td>
    <td class="${toneClass(p.profit)}">${nf(p.profit, 0)}</td>
    <td class="${toneClass(p.profitPct)}">${p.profitPct === null ? '--' : `${nf(p.profitPct, 2)}%`}</td>
    <td><button class="text-link" data-paper-sell="${esc(p.secid)}" data-paper-name="${esc(p.name)}" data-paper-shares="${p.shares}">卖出</button></td>
  </tr>`).join('') || '<tr><td colspan="9"><div class="empty">还没有模拟持仓。点「模拟买入」按最新价建仓。</div></td></tr>';

  const tradeRows = (d.trades || []).slice(0, 20).map((t) => `<tr>
    <td>${esc(timeText(t.ts))}</td>
    <td><span class="tag ${t.side === 'buy' ? 'in' : 'out'}">${t.side === 'buy' ? '买' : '卖'}</span></td>
    <td><span class="t-name">${esc(cleanName(t.name))}</span><span class="t-sub">${esc(t.code)}</span></td>
    <td>${nf(t.price, 3)}</td>
    <td>${nf(t.shares, 0)}</td>
    <td>${nf(t.amount, 0)}</td>
    <td>${nf(t.fee, 2)}</td>
    <td class="t-sub">${t.signal && t.signal.score !== undefined ? `评分 ${t.signal.score}${t.signal.rating ? ` · ${esc(t.signal.rating)}` : ''}` : '--'}</td>
  </tr>`).join('') || '<tr><td colspan="8"><div class="empty">还没有成交记录</div></td></tr>';

  el.innerHTML = `
    <div class="panel-head">
      <div>
        <div class="eyebrow">PAPER TRADING</div>
        <h3>模拟交易 · 账户与信号留痕</h3>
        <span class="muted small">按最新价成交，佣金万 2.5（最低 5 元）、卖出印花税万 5；仅用于复盘，不是实盘</span>
      </div>
      <div class="head-actions">
        <button class="btn primary small" id="paperBuyBtn">模拟买入</button>
        <button class="text-link" id="paperResetBtn">重置账户</button>
      </div>
    </div>
    <div class="fund-summary-grid paper-kpis">
      <div class="summary-card"><div class="sc-label">总资产</div><div class="sc-value">${nf(d.total, 0)}</div><div class="sc-sub">初始 ${nf(d.initial, 0)} · 更新 ${esc(priceUpdated)}</div></div>
      <div class="summary-card"><div class="sc-label">可用资金</div><div class="sc-value">${nf(d.cash, 0)}</div><div class="sc-sub">现金</div></div>
      <div class="summary-card"><div class="sc-label">持仓市值</div><div class="sc-value">${nf(d.marketValue, 0)}</div><div class="sc-sub">${(d.positions || []).length} 只${d.anyPrevClose ? ` · ${d.prevCloseCount || 0} 只按昨收估` : ''}</div></div>
      <div class="summary-card"><div class="sc-label">累计盈亏</div><div class="sc-value ${tone}">${nf(d.profit, 0)}</div><div class="sc-sub">${nf(d.profitPct, 2)}%${d.positionProfit === undefined ? '' : ` · 持仓浮盈 ${signedFmt(d.positionProfit, 0)}`}${d.realizedProfit === undefined ? '' : ` · 已实现 ${signedFmt(d.realizedProfit, 0)}`}</div></div>
    </div>
    <div class="table-scroll mt12"><table class="table paper-pos-table">
      <thead><tr><th>持仓</th><th>股数</th><th>成本</th><th>现价</th><th>当日</th><th>市值</th><th>浮盈</th><th>收益率</th><th></th></tr></thead>
      <tbody>${posRows}</tbody>
    </table></div>
    <div class="modal-section-title">最近成交（含成交时的大盘评分）</div>
    <div class="table-scroll tall-table"><table class="table paper-trade-table">
      <thead><tr><th>时间</th><th>方向</th><th>标的</th><th>价</th><th>股数</th><th>金额</th><th>费用</th><th>信号</th></tr></thead>
      <tbody>${tradeRows}</tbody>
    </table></div>
    <div class="modal-section-title paper-rank-head">
      <span>模拟账户排行榜 · 全体用户</span>
      <button class="btn small" id="paperRankToggle" aria-expanded="${state.paperRankOpen ? 'true' : 'false'}">${state.paperRankOpen ? '收起排行榜' : '展开排行榜'}</button>
    </div>
    <p class="muted small">所有登录用户都能看到彼此的模拟持仓与总资产；仅模拟盘，不含真实资金。默认收起，点「展开排行榜」再显示。</p>
    <div id="paperRankBody" ${state.paperRankOpen ? '' : 'hidden'}><div class="empty small">展开后加载排行榜…</div></div>`;

  const buyBtn = $('#paperBuyBtn');
  if (buyBtn) buyBtn.addEventListener('click', () => openPaperTrade('buy'));
  const resetBtn = $('#paperResetBtn');
  if (resetBtn) resetBtn.addEventListener('click', async () => {
    const initial = Number((state.paper || {}).initial) || 1000000;
    if (!confirm(`确定把模拟账户重置为 ${nf(initial, 0)} 元、清空持仓与成交记录？`)) return;
    try {
      await apiPost('/api/paper/reset', {});
      await loadPaper(true);
      if (state.paperRankOpen) loadPaperRanking(true);
      toast('模拟账户已重置', 'ok');
    } catch (err) {
      toast(`重置失败：${err.message}`, 'err');
    }
  });
  $$('[data-paper-sell]', el).forEach((b) => b.addEventListener('click', () => {
    openPaperTrade('sell', { secid: b.dataset.paperSell, name: b.dataset.paperName, shares: Number(b.dataset.paperShares) });
  }));
  // v2.9.0：排行榜默认收起，点按钮才请求并显示（用户要求）
  const rankBtn = $('#paperRankToggle');
  if (rankBtn) {
    rankBtn.addEventListener('click', () => {
      state.paperRankOpen = !state.paperRankOpen;
      const body = $('#paperRankBody');
      if (body) body.hidden = !state.paperRankOpen;
      rankBtn.textContent = state.paperRankOpen ? '收起排行榜' : '展开排行榜';
      rankBtn.setAttribute('aria-expanded', state.paperRankOpen ? 'true' : 'false');
      if (state.paperRankOpen) {
        if (state.paperRank) renderPaperRanking();
        else loadPaperRanking();
      }
    });
  }
  // 展开状态下随账户面板一起重绘（收起时完全不请求排行榜接口）
  if (state.paperRankOpen) {
    if (state.paperRank) renderPaperRanking();
    else loadPaperRanking();
  }
}

/* =========================================================
   模拟账户排行榜（v2.8.0）
   ---------------------------------------------------------
   用户明确要求：本系统所有登录用户都能看到彼此模拟账户的标的与总资产。
   服务端只透出用户名 + 模拟盘数据；前端这里只负责排序与渲染。
   ========================================================= */
async function loadPaperRanking(force = false) {
  if (!force && state.paperRank && Date.now() - (state.paperRank.at || 0) < 30000) {
    renderPaperRanking();
    return;
  }
  try {
    const data = await api('/api/paper/ranking', 30000);
    state.paperRank = { ...(data || {}), at: Date.now() };
  } catch (err) {
    state.paperRank = { items: [], error: err.message, at: Date.now() };
  }
  renderPaperRanking();
}

function renderPaperRanking() {
  const el = $('#paperRankBody');
  if (!el) return;
  const d = state.paperRank;
  if (!d) { el.innerHTML = '<div class="empty small">加载排行榜…</div>'; return; }
  if (d.error) { el.innerHTML = `<div class="empty small">排行榜加载失败：${esc(d.error)}</div>`; return; }
  const items = (d.items || []).slice();
  const sort = state.paperRankSort || 'total';
  if (sort === 'profit') items.sort((a, b) => (Number(b.profitPct) || 0) - (Number(a.profitPct) || 0));
  else items.sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0));
  const me = state.auth && state.auth.username;
  const rows = items.map((item, i) => {
    const held = (item.positions || []).slice(0, 3)
      .map((p) => `${esc(cleanName(p.name) || p.code)} <span class="t-sub">${nf(p.shares, 0)} 股${p.priceMode === 'prevClose' ? ' · 昨收' : ''}</span>`)
      .join('<br>') || '<span class="muted">空仓</span>';
    // 前 3 只看不下时，悬浮能看到这一户的全部标的（服务端最多给 10 只）
    const heldTitle = (item.positions || [])
      .map((p) => `${cleanName(p.name) || p.code} ${nf(p.shares, 0)} 股 · 市值 ${nf(p.marketValue, 2)}`)
      .join('\n');
    const more = (item.positionCount || 0) > 3 ? `<div class="t-sub">等 ${item.positionCount} 只</div>` : '';
    // 0 收益不标正负号，避免 -0 显示成 +0.00%
    const pctVal = Number(item.profitPct) || 0;
    const pctText = Math.abs(pctVal) < 0.005 ? '0.00%' : `${pctVal > 0 ? '+' : ''}${pctVal.toFixed(2)}%`;
    return `<tr class="${item.username === me ? 'is-me' : ''}">
      <td class="num">${i + 1}</td>
      <td><span class="t-name">${esc(item.username)}</span>${item.username === me ? ' <span class="badge">我</span>' : ''}</td>
      <td class="t-price">${nf(item.total, 2)}</td>
      <td class="t-chg ${toneClass(item.profit)}">${signedFmt(item.profit, 2)}</td>
      <td class="t-chg ${toneClass(pctVal)}">${pctText}</td>
      <td title="${esc(heldTitle)}">${held}${more}</td>
      <td class="t-dim">${item.updatedAt ? esc(timeText(item.updatedAt)) : '<span class="muted">未交易</span>'}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <div class="row-between mt8">
      <div class="seg" id="paperRankSortSeg">
        <button class="${sort === 'total' ? 'is-active' : ''}" data-rank-sort="total">按总资产</button>
        <button class="${sort === 'profit' ? 'is-active' : ''}" data-rank-sort="profit">按收益率</button>
      </div>
      <span class="muted small">${items.length} 个账号${d.estimated ? ' · 部分持仓按成本价估算' : ''}${d.truncated ? ' · 仅显示前 200 个账号' : ''}${d.updatedAt ? ` · 截至 ${esc(timeText(d.updatedAt))}` : ''}</span>
    </div>
    <div class="table-scroll tall-table mt8"><table class="table paper-rank-table">
      <thead><tr><th>排名</th><th>用户</th><th>总资产</th><th>累计盈亏</th><th>收益率</th><th>持仓（前 3）</th><th>最近操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7"><div class="empty">还没有账号</div></td></tr>'}</tbody>
    </table></div>`;
  const seg = $('#paperRankSortSeg');
  if (seg) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rank-sort]');
      if (!btn) return;
      state.paperRankSort = btn.dataset.rankSort;
      renderPaperRanking();
    });
  }
}

/* =========================================================
   模拟买卖弹窗（v2.9.0）
   ---------------------------------------------------------
   用户要求：能直接输入代码/名称选标的、看到当前价与分时图、
   按「剩余金额的百分比」下单（1/4、1/3、1/2、全部），卖出同理。
   成交价仍以服务端为准；这里的股数只是按当前报价的估算。
   ========================================================= */
const PAPER_FEE_RATE = 0.00025;
const PAPER_FEE_MIN = 5;
const PAPER_TAX_RATE = 0.0005;

function shanghaiTodayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (k) => (parts.find((p) => p.type === k) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function paperFeeOf(amount) {
  return Math.max(PAPER_FEE_MIN, Number(amount) * PAPER_FEE_RATE);
}

/** 按比例估算股数（与服务端 paperTrade 的 ratio 口径一致） */
function paperRatioShares({ side, ratio, price, cash, held, lot }) {
  const p = Number(price);
  if (!(p > 0)) return 0;
  const step = lot || 100;
  if (side === 'sell') {
    const shares = Number(held) || 0;
    if (shares <= 0) return 0;
    return ratio >= 1 ? shares : Math.floor((shares * ratio) / step) * step;
  }
  const budget = Math.max(0, (Number(cash) || 0) * ratio);
  let want = Math.floor(budget / (p * (1 + PAPER_FEE_RATE)) / step) * step;
  while (want > 0 && p * want + paperFeeOf(p * want) > (Number(cash) || 0) + 0.005) want -= step;
  return Math.max(0, want);
}

function paperLotOf(secid) {
  return /^[01]\.\d{6}$/.test(String(secid || '')) ? 100 : 1;
}

/**
 * 股数校验（纯函数，弹窗与单测共用）。
 * 注意：弹窗里不再用 <input step> 的原生校验（step 从 min 起算，min=1/step=100 会让 100 非法），
 * 统一在这里给出中文提示，服务端仍会二次校验。
 */
function paperValidateShares({ side = 'buy', shares, secid = '', price = 0, cash = 0, held = 0 } = {}) {
  const n = Math.floor(Number(shares));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, message: '股数必须是正整数' };
  const lot = paperLotOf(secid);
  if (lot === 100 && n % 100 !== 0) {
    if (side === 'buy') {
      const lo = Math.floor(n / 100) * 100;
      const hi = lo + 100;
      return { ok: false, message: `买入 A 股 / 场内 ETF 需 100 股整数倍，当前 ${n} 股（可改成 ${lo} 或 ${hi}）` };
    }
    if (n !== Math.floor(Number(held) || 0)) {
      return { ok: false, message: `卖出需 100 股整数倍；想清仓请点「全部」一次卖出 ${nf(held, 0)} 股` };
    }
  }
  if (side === 'buy' && Number(price) > 0) {
    const amount = Number(price) * n;
    const fee = paperFeeOf(amount);
    if (amount + fee > (Number(cash) || 0) + 0.005) {
      return { ok: false, message: `可用资金不足：需要 ${nf(amount + fee, 2)} 元，现有 ${nf(cash, 2)} 元` };
    }
  }
  if (side === 'sell' && n > Math.floor(Number(held) || 0)) {
    return { ok: false, message: `持仓不足：当前 ${nf(held, 0)} 股，不能卖出 ${n} 股` };
  }
  return { ok: true, message: '' };
}

/** 当前模拟持仓里某只标的的份额 */
function paperHeldShares(secid) {
  const pos = ((state.paper && state.paper.positions) || []).find((p) => p.secid === secid);
  return pos ? Number(pos.shares) || 0 : 0;
}

function renderPaperQuote() {
  const box = $('#paperQuote');
  const t = state.paperTrade;
  if (!box || !t) return;
  const d = state.paper || {};
  const side = t.side;
  const target = t.target;
  if (!target) {
    box.innerHTML = '<div class="empty small">先输入股票代码或名称，选中标的后显示实时报价与分时</div>';
    const chart = $('#paperIntraday');
    if (chart) chart.innerHTML = '';
    renderPaperPreview();
    return;
  }
  const q = t.quote;
  const held = paperHeldShares(target.secid);
  if (!q) {
    box.innerHTML = `<div class="paper-quote-main"><div><b>${esc(cleanName(target.name) || target.code || '')}</b> <span class="t-code">${esc(target.code || '')}</span></div><div class="muted small">报价加载中…</div></div>`;
    renderPaperPreview();
    return;
  }
  const tone = toneClass(q.pct);
  const prevMode = q.priceMode === 'prevClose';
  box.innerHTML = `<div class="paper-quote-main">
      <div class="paper-quote-id"><b>${esc(cleanName(q.name || target.name) || target.code || '')}</b> <span class="t-code">${esc(q.code || target.code || '')}</span></div>
      <div class="paper-quote-price ${tone}">${priceFmt(q.price)}<span>${q.pct === null || q.pct === undefined ? '--' : pctFmt(q.pct)}</span></div>
      <div class="paper-quote-meta">${prevMode ? '<span class="muted">开盘前暂无成交价：现价与涨跌幅按昨收显示，开盘后才能下单</span>' : ''}${prevMode ? ' · ' : ''}${side === 'buy'
        ? `可用资金 ${nf(d.cash, 2)} 元`
        : `当前模拟持仓 ${nf(held, 0)} 股`}</div>
    </div>`;
  renderPaperPreview();
}

function renderPaperPreview() {
  const box = $('#paperPreview');
  const t = state.paperTrade;
  if (!box || !t) return;
  const q = t.quote;
  const target = t.target;
  const sharesInput = $('#paperShares');
  const shares = Math.max(0, Math.floor(Number(sharesInput ? sharesInput.value : 0) || 0));
  if (!target || !q || !(Number(q.price) > 0) || !shares) {
    box.innerHTML = t.ratio
      ? `<span class="muted small">按 ${esc(t.ratio >= 1 ? '全部' : `1/${Math.round(1 / t.ratio)}`)} 估算中…</span>`
      : '<span class="muted small">选择标的并填写股数后，这里显示预计成交金额与费用</span>';
    return;
  }
  const amount = shares * Number(q.price);
  const fee = paperFeeOf(amount);
  const tax = t.side === 'sell' ? amount * PAPER_TAX_RATE : 0;
  const d = state.paper || {};
  const cashAfter = t.side === 'buy' ? Number(d.cash) - amount - fee : Number(d.cash) + amount - fee - tax;
  const heldAfter = t.side === 'sell' ? paperHeldShares(target.secid) - shares : paperHeldShares(target.secid) + shares;
  const short = t.side === 'buy' ? Number(d.cash) + 0.005 < amount + fee : paperHeldShares(target.secid) < shares;
  box.innerHTML = `<div class="paper-preview-row"><span>预计金额</span><b>${nf(amount, 2)} 元</b></div>
    <div class="paper-preview-row"><span>佣金（万 2.5，最低 5 元）${tax ? ' + 印花税（万 5）' : ''}</span><b>${nf(fee + tax, 2)} 元</b></div>
    <div class="paper-preview-row"><span>成交后${t.side === 'buy' ? '可用资金' : '剩余份额'}</span><b>${t.side === 'buy' ? `${nf(cashAfter, 2)} 元` : `${nf(Math.max(0, heldAfter), 0)} 股`}</b></div>
    ${short ? `<div class="paper-preview-warn">${t.side === 'buy' ? '可用资金不足，请减少股数或改按比例买入' : '持仓不足，无法卖出这么多'}</div>` : ''}`;
}

async function loadPaperQuote(secid) {
  const t = state.paperTrade;
  if (!t || !secid) return;
  t.quote = null;
  renderPaperQuote();
  const date = shanghaiTodayKey();
  const [quoteRes, intraRes] = await Promise.allSettled([
    api(`/api/quotes?secids=${encodeURIComponent(secid)}`, 12000),
    api(`/api/intraday?secid=${encodeURIComponent(secid)}&date=${encodeURIComponent(date)}`, 20000),
  ]);
  if (state.paperTrade !== t) return; // 弹窗已关闭或换了标的
  if (quoteRes.status === 'fulfilled') {
    t.quote = ((quoteRes.value || {}).items || [])[0] || null;
  }
  const chart = $('#paperIntraday');
  if (intraRes.status === 'fulfilled' && chart) {
    const data = intraRes.value || {};
    const candles = data.candles || [];
    if (candles.length >= 2) {
      chart.classList.remove('is-empty');
      intradayChart(chart, { candles, preClose: Number(data.preClose), fullSession: true });
      t.intraday = data;
    } else {
      chart.classList.add('is-empty');
      chart.innerHTML = `<div class="empty small">暂无分时（未开盘或休市）${data.periodLabel ? ` · ${esc(data.periodLabel)}` : ''}</div>`;
    }
  } else if (chart) {
    chart.classList.add('is-empty');
    chart.innerHTML = '<div class="empty small">分时暂不可用，价格仍可正常成交</div>';
  }
  renderPaperQuote();
}

/** 选中标的后：更新标题、加载报价与分时 */
function pickPaperSymbol(item, { presetShares = 0 } = {}) {
  const t = state.paperTrade;
  if (!t || !item || !item.secid) return;
  t.target = { secid: String(item.secid), code: String(item.code || ''), name: String(item.name || '') };
  t.ratio = null;
  t.presetShares = Number(presetShares) || 0;
  const input = $('#paperShares');
  if (input && t.presetShares > 0) input.value = String(t.presetShares);
  const pop = $('#paperSymbolPop');
  if (pop) pop.hidden = true;
  const symbolInput = $('#paperSymbol');
  if (symbolInput) symbolInput.value = `${cleanName(t.target.name) || ''} ${t.target.code || ''}`.trim();
  const chips = $$('[data-paper-pick]');
  chips.forEach((c) => c.classList.toggle('is-active', c.dataset.paperPick === t.target.secid));
  loadPaperQuote(t.target.secid);
}

/** 打开买入/卖出弹窗 */
function openPaperTrade(side = 'buy', preset = {}) {
  const isSell = side === 'sell';
  const d = state.paper || {};
  state.paperTrade = {
    side,
    target: null,
    quote: null,
    intraday: null,
    ratio: null,
    presetShares: Number(preset.shares) || 0,
    searchTimer: null,
  };
  const picks = (isSell
    ? ((d.positions || []).map((p) => ({ secid: p.secid, code: p.code, name: p.name, extra: `${nf(p.shares, 0)} 股` })))
    : ((state.watchlist || []).map((w) => ({ secid: w.secid, code: w.code, name: w.name, extra: '' })))
  ).slice(0, 6);
  const chips = picks.map((p) => `<button type="button" class="paper-pick" data-paper-pick="${esc(p.secid)}" data-paper-code="${esc(p.code || '')}" data-paper-name="${esc(p.name || '')}">
      <span>${esc(cleanName(p.name) || p.code || p.secid)}</span>${p.extra ? `<small>${esc(p.extra)}</small>` : `<small>${esc(p.code || '')}</small>`}
    </button>`).join('');
  mountOverlay(`
    <div class="modal modal-md paper-trade-modal">
      <div class="modal-head">
        <div class="modal-title"><h2>模拟${isSell ? '卖出' : '买入'}</h2><span class="muted small">按最新价成交，佣金万 2.5（最低 5 元）${isSell ? ' + 印花税万 5' : ''}</span></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <form id="paperForm" class="pw-form" autocomplete="off" novalidate>
        <div class="paper-symbol-wrap">
          <label class="input-wrap">
            <span>标的</span>
            <input id="paperSymbol" type="search" placeholder="${isSell ? '输入持仓标的代码或名称，如 600519' : '输入股票代码或名称，如 600519 / 贵州茅台'}" autocomplete="off">
          </label>
          <div id="paperSymbolPop" class="search-pop paper-symbol-pop" hidden></div>
        </div>
        <div class="paper-picks">${chips || `<span class="muted small">${isSell ? '还没有模拟持仓' : '自选股为空，可直接搜索任意 A 股 / ETF'}</span>`}</div>
        <div class="paper-quote" id="paperQuote"><div class="empty small">先输入股票代码或名称，选中标的后显示实时报价与分时</div></div>
        <div id="paperIntraday" class="paper-intraday"></div>
        <div class="paper-qty">
          <label class="input-wrap">
            <span>股数</span>
            <input id="paperShares" type="number" min="1" step="1" inputmode="numeric" value="100" placeholder="如 100 / 200 / 500">
          </label>
          <div class="paper-ratio-seg" id="paperRatioSeg" role="group" aria-label="按比例下单">
            <button type="button" data-paper-ratio="0.25">1/4</button>
            <button type="button" data-paper-ratio="0.3333">1/3</button>
            <button type="button" data-paper-ratio="0.5">1/2</button>
            <button type="button" data-paper-ratio="1">全部</button>
          </div>
        </div>
        <div class="paper-qty-hint">A 股 / 场内 ETF 买入需 100 股整数倍；卖出可全仓（含零股）</div>
        <div class="paper-preview" id="paperPreview"><span class="muted small">选择标的并填写股数后，这里显示预计成交金额与费用</span></div>
        <label class="input-wrap"><span>备注</span><input id="paperNote" maxlength="40" placeholder="可选，如：回踩 MA20 买入"></label>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>取消</button>
          <button class="btn primary" type="submit" id="paperSubmit">确认${isSell ? '卖出' : '买入'}</button>
        </div>
      </form>
    </div>`);
  const form = $('#paperForm');
  if (!form) return;

  // 快捷标的
  $$('[data-paper-pick]').forEach((btn) => btn.addEventListener('click', () => {
    pickPaperSymbol({
      secid: btn.dataset.paperPick,
      code: btn.dataset.paperCode,
      name: btn.dataset.paperName,
    }, { presetShares: isSell ? paperHeldShares(btn.dataset.paperPick) : 0 });
  }));

  // 搜索（代码或名称）
  const symbolInput = $('#paperSymbol');
  const pop = $('#paperSymbolPop');
  const runPaperSearch = async (q) => {
    const kw = String(q || '').trim();
    if (!kw) { if (pop) pop.hidden = true; return; }
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(kw)}`, 9000);
      const items = (data.items || [])
        .filter((x) => /^[01]\.\d{6}$/.test(String(x.secid || '')))
        .slice(0, 8);
      if (!pop) return;
      if (!items.length) {
        pop.hidden = false;
        pop.innerHTML = '<div class="search-empty">没有找到匹配的 A 股 / 场内 ETF</div>';
        return;
      }
      pop.hidden = false;
      pop.innerHTML = items.map((x) => `<button type="button" class="search-item" data-pick-secid="${esc(x.secid)}" data-pick-code="${esc(x.code)}" data-pick-name="${esc(x.name)}">
          <span><span class="s-name">${esc(cleanName(x.name))}</span> <span class="s-code">${esc(x.code)}</span></span>
          <span class="s-type">${esc(x.type || '')}</span>
        </button>`).join('');
      pop.querySelectorAll('[data-pick-secid]').forEach((btn) => btn.addEventListener('click', () => {
        pickPaperSymbol({ secid: btn.dataset.pickSecid, code: btn.dataset.pickCode, name: btn.dataset.pickName });
      }));
    } catch (err) {
      if (pop) { pop.hidden = false; pop.innerHTML = `<div class="search-empty">${esc(err.message)}</div>`; }
    }
  };
  if (symbolInput) {
    symbolInput.addEventListener('input', debounce(() => runPaperSearch(symbolInput.value), 260));
    symbolInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = pop && pop.querySelector('[data-pick-secid]');
      if (first) {
        pickPaperSymbol({ secid: first.dataset.pickSecid, code: first.dataset.pickCode, name: first.dataset.pickName });
      } else {
        runPaperSearch(symbolInput.value);
      }
    });
    symbolInput.focus();
  }

  // 股数 / 比例
  const sharesInput = $('#paperShares');
  if (sharesInput) {
    sharesInput.addEventListener('input', () => {
      if (state.paperTrade) state.paperTrade.ratio = null;
      $$('#paperRatioSeg button').forEach((b) => b.classList.remove('is-active'));
      renderPaperPreview();
    });
  }
  $$('#paperRatioSeg [data-paper-ratio]').forEach((btn) => btn.addEventListener('click', () => {
    const t = state.paperTrade;
    if (!t || !t.target || !t.quote || !(Number(t.quote.price) > 0)) {
      toast('先选择标的，等报价出来再按比例下单', 'warn');
      return;
    }
    const ratio = Number(btn.dataset.paperRatio) || 1;
    t.ratio = ratio;
    $$('#paperRatioSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    const est = paperRatioShares({
      side: t.side,
      ratio,
      price: t.quote.price,
      cash: (state.paper || {}).cash,
      held: paperHeldShares(t.target.secid),
      lot: paperLotOf(t.target.secid),
    });
    if (sharesInput) sharesInput.value = String(est || '');
    if (!est) toast(t.side === 'sell' ? '该标的没有可卖持仓' : '可用资金不足一手', 'warn');
    renderPaperPreview();
  }));

  // 从持仓表点「卖出」进来：直接定位标的与全仓股数
  if (preset.secid) {
    pickPaperSymbol({ secid: preset.secid, code: preset.code || '', name: preset.name || '' }, { presetShares: isSell ? Number(preset.shares) || 0 : 0 });
  } else if (isSell && picks.length === 1) {
    pickPaperSymbol(picks[0], { presetShares: paperHeldShares(picks[0].secid) });
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const t = state.paperTrade;
    if (!t || !t.target) { toast('请先选择标的', 'warn'); return; }
    const note = $('#paperNote') ? $('#paperNote').value : '';
    const payload = { secid: t.target.secid, side, note };
    if (t.ratio) {
      payload.ratio = t.ratio;
    } else {
      const shares = Math.floor(Number(sharesInput ? sharesInput.value : 0));
      const check = paperValidateShares({
        side,
        shares,
        secid: t.target.secid,
        price: t.quote ? t.quote.price : 0,
        cash: (state.paper || {}).cash,
        held: paperHeldShares(t.target.secid),
      });
      if (!check.ok) { toast(check.message, 'warn', 6000); return; }
      payload.shares = shares;
    }
    const btn = $('#paperSubmit');
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const res = await apiPost('/api/paper/trade', payload);
      state.paper = res.account;
      closeOverlay();
      renderPaper();
      if (state.paperRankOpen) loadPaperRanking(true);
      toast(`${isSell ? '卖出' : '买入'}成功：${res.trade.shares} 股 @ ${nf(res.trade.price, 3)}`, 'ok');
    } catch (err) {
      toast(`下单失败：${err.message}`, 'err');
      btn.disabled = false;
      btn.textContent = `确认${isSell ? '卖出' : '买入'}`;
    }
  });
}

/* =========================================================
   个股资讯（阶段 3.6）
   ========================================================= */

async function openStockNews(code, name) {
  if (!code) return;
  // 叠在个股详情之上：关掉资讯抽屉后仍回到个股详情
  const overlay = pushOverlay(`
    <div class="drawer">
      <div class="drawer-head">
        <div><div class="eyebrow">STOCK NEWS</div><h2>${esc(cleanName(name) || code)} · 资讯</h2><span class="code">${esc(code)}</span></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="empty">正在检索相关资讯…</div>
    </div>`, 'drawer-overlay');
  try {
    const data = await api(`/api/stock/news?code=${encodeURIComponent(code)}&limit=12`, 30000);
    if (!document.body.contains(overlay)) return;
    const drawer = overlay.querySelector('.drawer');
    if (!drawer) return;
    const items = (data && data.items) || [];
    drawer.innerHTML = `
      <div class="drawer-head">
        <div><div class="eyebrow">STOCK NEWS</div><h2>${esc(cleanName(name) || code)} · 资讯</h2><span class="code">${esc(code)}</span></div>
        <button class="modal-close" data-close>×</button>
      </div>
      ${items.length ? `<div class="news-list">${items.map((x) => `
        <a class="news-item news-neutral" href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener noreferrer">
          <div class="news-meta"><span>${esc((x.time || '').slice(5, 16))}</span>${x.source ? `<span class="sent">${esc(x.source)}</span>` : ''}</div>
          <div class="news-title">${esc(x.title)}</div>
          ${x.summary ? `<div class="news-summary">${esc(x.summary)}</div>` : ''}
        </a>`).join('')}</div>` : '<div class="empty">没有检索到相关资讯</div>'}
      <p class="muted small mt12">${esc((data && data.note) || '')}</p>`;
  } catch (err) {
    toast(`资讯加载失败：${err.message}`, 'err');
    closeOverlay();
  }
}

/**
 * 查看大盘策略：在新标签页打开，个股详情原样保留（v2.7.0 修复）
 * 原来这个按钮带 data-goto="strategy" data-close：先关掉弹窗再切视图，
 * 用户看完策略回到本页时个股详情已经没了。新标签页等于并排看，回来还是原弹窗。
 * 弹窗被浏览器拦截时退回原行为（关弹窗 + 本页切到策略），功能不会丢。
 */
function openStrategyInNewTab() {
  let win = null;
  try {
    win = window.open(`${location.pathname}${location.search}#strategy`, '_blank');
  } catch {
    win = null;
  }
  if (win) {
    toast('已在新标签页打开大盘策略，个股详情保留', 'ok', 2800);
    return;
  }
  closeOverlay();
  navigate('strategy');
  toast('新标签页被拦截，已在本页打开大盘策略', 'warn', 2800);
}

/* =========================================================
   自选操作 / 预警检查    ========================================================= */
function addWatch(item) {
  if (!item || !item.secid) return false;
  if (state.watchlist.some((w) => w.secid === item.secid)) {
    toast(`${cleanName(item.name)} 已在自选中`, 'warn');
    return false;
  }
  state.watchlist.push({ secid: item.secid, code: item.code, name: item.name });
  saveJSON(WATCH_KEY, state.watchlist);
  schedulePushSync();
  toast(`已加入自选：${cleanName(item.name)}`, 'ok');
  loadWatchData(true);
  return true;
}

function removeWatch(secid) {
  const item = state.watchlist.find((w) => w.secid === secid);
  state.watchlist = state.watchlist.filter((w) => w.secid !== secid);
  saveJSON(WATCH_KEY, state.watchlist);
  schedulePushSync();
  toast(`已移出自选：${item ? cleanName(item.name) : secid}`, 'info');
  loadWatchData(true);
}

function moveWatch(secid, dir) {
  const i = state.watchlist.findIndex((w) => w.secid === secid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.watchlist.length) return;
  [state.watchlist[i], state.watchlist[j]] = [state.watchlist[j], state.watchlist[i]];
  saveJSON(WATCH_KEY, state.watchlist);
  schedulePushSync();
  renderWatchTable();
  renderDashWatch();
  toast('自选顺序已更新', 'ok', 1200);
}

function reorderWatch(fromSecid, toSecid) {
  if (!fromSecid || !toSecid || fromSecid === toSecid) return;
  const from = state.watchlist.findIndex((w) => w.secid === fromSecid);
  const to = state.watchlist.findIndex((w) => w.secid === toSecid);
  if (from < 0 || to < 0) return;
  const [item] = state.watchlist.splice(from, 1);
  state.watchlist.splice(to, 0, item);
  saveJSON(WATCH_KEY, state.watchlist);
  schedulePushSync();
  renderWatchTable();
  renderDashWatch();
  toast('自选顺序已更新', 'ok', 1200);
}

/* 手机端长按拖拽排序：HTML5 拖放（dragstart/drop）在触屏浏览器上不触发，
   这里用 touch 事件补一套——按住 420ms 且手指基本不动才进入拖拽，避免和滚动、单击冲突。
   dataKey 为行上 dataset 键名（如 dragSecid / dragFund）；onReorder(fromId, toId) 负责持久化与重渲染。 */
function bindTouchReorder(container, rowSelector, dataKey, onReorder) {
  if (!container) return;
  let timer = null;
  let ctx = null; // { row, id, active, startX, startY, ghost }

  const clearTimer = () => { clearTimeout(timer); timer = null; };
  const removeGhost = () => { if (ctx && ctx.ghost) { ctx.ghost.remove(); ctx.ghost = null; } };
  const resetRows = () => $$(rowSelector, container).forEach((r) => r.classList.remove('dragging', 'drag-over'));

  // 长按松手后浏览器还会补一个 click；拦截掉，避免排序后误打开详情。
  const suppressClickOnce = () => {
    const block = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      container.removeEventListener('click', block, true);
    };
    container.addEventListener('click', block, { capture: true });
    setTimeout(() => container.removeEventListener('click', block, true), 350);
  };

  container.addEventListener('touchstart', (e) => {
    const row = e.target.closest(rowSelector);
    if (!row) return;
    const t = e.touches[0];
    ctx = { row, id: row.dataset[dataKey], active: false, startX: t.clientX, startY: t.clientY, ghost: null };
    clearTimer();
    timer = setTimeout(() => {
      if (!ctx) return;
      ctx.active = true;
      ctx.row.classList.add('dragging');
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch { /* 部分浏览器不支持振动 */ } }
      toast('拖动到目标行后松手排序', 'info', 1400);
      // 用轻量浮动标签而不是克隆整行：表格行（tr）脱离 table 后列宽会塌。
      const rect = row.getBoundingClientRect();
      const nameEl = row.querySelector('.wi-name, .t-name, .imc-name');
      const label = nameEl ? nameEl.textContent.trim() : row.textContent.trim().slice(0, 12);
      const ghost = document.createElement('div');
      ghost.className = 'touch-drag-ghost';
      ghost.textContent = label || '拖动排序';
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      document.body.appendChild(ghost);
      ctx.ghost = ghost;
    }, 420);
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!ctx) return;
    const t = e.touches[0];
    const dx = t.clientX - ctx.startX;
    const dy = t.clientY - ctx.startY;
    if (!ctx.active) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearTimer(); // 明显移动视为滚动，取消长按
      return;
    }
    e.preventDefault(); // 已进入拖拽，禁止页面跟着滚
    if (ctx.ghost) ctx.ghost.style.transform = `translate(${dx}px, ${dy}px)`;
    const hit = document.elementFromPoint(t.clientX, t.clientY);
    const over = hit ? hit.closest(rowSelector) : null;
    $$(`${rowSelector}.drag-over`, container).forEach((r) => { if (r !== over) r.classList.remove('drag-over'); });
    if (over && over !== ctx.row) over.classList.add('drag-over');
  }, { passive: false });

  const finish = (e) => {
    if (!ctx) return;
    const wasActive = ctx.active;
    if (wasActive && e) {
      const t = e.changedTouches[0];
      const hit = document.elementFromPoint(t.clientX, t.clientY);
      const over = hit ? hit.closest(rowSelector) : null;
      if (over && over !== ctx.row && over.dataset[dataKey]) {
        try { onReorder(ctx.id, over.dataset[dataKey]); } catch { /* 重排失败不影响收尾 */ }
      }
      suppressClickOnce();
    }
    removeGhost();
    resetRows();
    clearTimer();
    ctx = null;
  };

  container.addEventListener('touchend', finish);
  container.addEventListener('touchcancel', () => {
    if (ctx) { removeGhost(); resetRows(); }
    clearTimer();
    ctx = null;
  });
}

/* =========================================================
   条件预警（v2）
   ========================================================= */

/**
 * 单条预警判定：纯函数，不依赖 DOM / 网络，便于单测复现。
 * 返回 { hit:boolean, price?:number, note?:string }，数据不足时一律不触发。
 */
function evalAlertRule(alert, quote, kline) {
  if (!alert) return { hit: false };
  const price = quote ? Number(quote.price) : NaN;
  const series = (kline && kline.series) || {};
  const candles = (kline && kline.candles) || [];

  if (alert.kind === 'price') {
    if (!Number.isFinite(price)) return { hit: false };
    const hit = alert.op === 'below' ? price <= alert.value : price >= alert.value;
    return { hit, price, note: `最新价 ${nf(price, 2)}` };
  }

  if (alert.kind === 'pct') {
    const pct = quote ? Number(quote.pct) : NaN;
    if (!Number.isFinite(pct)) return { hit: false };
    const hit = alert.op === 'below' ? pct <= alert.value : pct >= alert.value;
    return { hit, price, note: `涨跌幅 ${nf(pct, 2)}%` };
  }

  if (alert.kind === 'volume') {
    // 量比 = 当日成交量 ÷ 前 5 日均量（与前端口径一致，用成交量而非成交额避免缺失）
    if (candles.length < 6) return { hit: false };
    const last = candles[candles.length - 1];
    const prev5 = candles.slice(-6, -1).map((c) => Number(c.v) || 0);
    const avg = prev5.reduce((s, v) => s + v, 0) / prev5.length;
    if (!avg) return { hit: false };
    const ratio = (Number(last.v) || 0) / avg;
    const hit = alert.op === 'below' ? ratio <= alert.value : ratio >= alert.value;
    return { hit, price, note: `量比 ${nf(ratio, 2)} 倍` };
  }

  if (alert.kind === 'ma') {
    const ma = series.ma20;
    if (!Array.isArray(ma) || candles.length < 2) return { hit: false };
    const n = candles.length;
    const c0 = Number(candles[n - 2].c);
    const c1 = Number(candles[n - 1].c);
    const m0 = Number(ma[n - 2]);
    const m1 = Number(ma[n - 1]);
    if (![c0, c1, m0, m1].every((v) => Number.isFinite(v))) return { hit: false };
    const hit = alert.op === 'dead' ? (c0 >= m0 && c1 < m1) : (c0 <= m0 && c1 > m1);
    return { hit, price, note: `收盘 ${nf(c1, 2)} / MA20 ${nf(m1, 2)}` };
  }

  if (alert.kind === 'macd') {
    const dif = series.dif;
    const dea = series.dea;
    if (!Array.isArray(dif) || !Array.isArray(dea) || dif.length < 2) return { hit: false };
    const n = dif.length;
    const d0 = Number(dif[n - 2]);
    const d1 = Number(dif[n - 1]);
    const e0 = Number(dea[n - 2]);
    const e1 = Number(dea[n - 1]);
    if (![d0, d1, e0, e1].every((v) => Number.isFinite(v))) return { hit: false };
    const hit = alert.op === 'dead' ? (d0 >= e0 && d1 < e1) : (d0 <= e0 && d1 > e1);
    return { hit, price, note: `DIF ${nf(d1, 2)} / DEA ${nf(e1, 2)}` };
  }

  return { hit: false };
}

function addAlert({ secid, code, name, kind = 'price', op = 'above', value = null } = {}) {
  if (!secid) {
    toast('缺少标的代码', 'warn');
    return false;
  }
  const k = ALERT_KINDS.includes(kind) ? kind : 'price';
  const trend = isTrendAlert(k);
  let v = null;
  if (!trend) {
    v = Number(value);
    if (!Number.isFinite(v)) {
      toast('请输入有效的预警数值', 'warn');
      return false;
    }
    if (k === 'price' && v <= 0) {
      toast('请输入有效的预警价格', 'warn');
      return false;
    }
  }
  if (!state.watchlist.some((w) => w.secid === secid)) {
    addWatch({ secid, code, name });
  }
  const normalized = normalizeAlerts([{
    id: `alert-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
    secid, code, name, kind: k, op, value: v,
    active: true, createdAt: Date.now(),
  }], state.alerts.length);
  if (!normalized.length) {
    toast('预警条件不合法', 'warn');
    return false;
  }
  state.alerts.push(normalized[0]);
  saveJSON(ALERTS_KEY, state.alerts);
  renderAlerts();
  toast(`预警已设置：${cleanName(name)} ${alertConditionText(normalized[0])}`, 'ok');
  return true;
}

let alertsChecking = false;

async function checkAlerts() {
  if (!state.alerts.length || alertsChecking) return;
  alertsChecking = true;
  let changed = false;
  try {
    const items = (state.watchData && state.watchData.items) || [];
    for (const alert of state.alerts) {
      if (!alert.active) continue;
      const q = state.quotes.get(alert.secid)
        || (items.find((it) => it.quote && it.quote.secid === alert.secid) || {}).quote
        || null;
      let kline = null;
      // 只有量比与趋势类规则才需要 K 线；价格 / 涨跌幅用快照即可，避免多余请求。
      if (alert.kind === 'volume' || isTrendAlert(alert.kind)) {
        try {
          kline = await getKlineCached(alert.secid, 101, 120);
        } catch {
          kline = null;
        }
      }
      const res = evalAlertRule(alert, q, kline);
      if (!res.hit) continue;
      alert.active = false;
      alert.triggeredAt = Date.now();
      alert.triggeredPrice = Number.isFinite(res.price) ? res.price : null;
      alert.triggerNote = res.note || '';
      changed = true;
      const msg = `${cleanName(alert.name)} ${alertConditionText(alert)} · ${res.note || ''}`;
      toast(msg, 'warn', 6000);
      notify('条件预警触发', msg);
      beep();
    }
  } catch {
    // 预警判定失败（接口抖动 / 通知权限异常）不应打断行情刷新，也不该产生未处理 rejection
  } finally {
    alertsChecking = false;
  }
  if (changed) {
    saveJSON(ALERTS_KEY, state.alerts);
    renderAlerts();
  }
}

/* =========================================================
   基金 / ETF
   ========================================================= */
function fundTypeOf(code, name = '') {
  if (/ETF|LOF/i.test(String(name))) return 'etf';
  return /^(51|56|58|15|16|18)/.test(String(code)) ? 'etf' : 'open';
}

/* =========================================================
   界面模块显隐（v2.10.0）
   ---------------------------------------------------------
   后台「界面管理」把配置写进 data/ui-config.json，前端启动时读一次：
   隐藏的子页按钮与面板一起隐藏，当前子页若被隐藏则回退到第一个可见项。
   接口失败时按内置默认（只留 板块资金/板块总览/涨跌分布/场外基金）处理，
   绝不因为一个配置读不到就把整页隐藏。
   ========================================================= */
const FUND_MODULE_DEFAULT = {
  sector: true,
  theme: true,
  dist: true,
  openfund: true,
  openflow: false,
  proxy: false,
  flow: false,
  stock: false,
  bond: false,
};
const FUND_VIEWS_ALL = ['sector', 'theme', 'dist', 'openfund', 'openflow', 'proxy', 'flow', 'stock', 'bond'];

function fundModuleVisible(key) {
  const cfg = (state.uiConfig && state.uiConfig.fundModules) || FUND_MODULE_DEFAULT;
  return cfg[key] !== false;
}

function visibleFundViews() {
  const list = FUND_VIEWS_ALL.filter(fundModuleVisible);
  return list.length ? list : ['sector'];
}

async function loadUiConfig() {
  try {
    const data = await api('/api/ui/config', 8000);
    state.uiConfig = {
      fundModules: { ...FUND_MODULE_DEFAULT, ...((data && data.fundModules) || {}) },
    };
  } catch {
    state.uiConfig = { fundModules: { ...FUND_MODULE_DEFAULT } };
  }
  applyFundModuleVisibility();
  return state.uiConfig;
}

function applyFundModuleVisibility() {
  $$('#fundSubnav [data-fund-view]').forEach((btn) => {
    const show = fundModuleVisible(btn.dataset.fundView);
    btn.hidden = !show;
    btn.setAttribute('aria-hidden', show ? 'false' : 'true');
  });
  if (!visibleFundViews().includes(state.fundView)) state.fundView = visibleFundViews()[0];
  if (state.view === 'funds') renderFunds();
}

async function loadFundDistribution(force = false) {
  const scope = state.fundDistScope === 'etf' ? 'etf' : 'equity';
  if (!force && state.fundDist && state.fundDist.scope === scope && !state.fundDist.unavailable) {
    renderFundDistribution();
    return;
  }
  if (state.loading.has('funddist') && !force) return;
  state.loading.add('funddist');
  try {
    const data = await api(`/api/funds/distribution?scope=${scope}`, 45000);
    if (scope !== (state.fundDistScope === 'etf' ? 'etf' : 'equity')) return;
    state.fundDist = data;
    renderFundDistribution();
  } catch (err) {
    state.fundDist = {
      unavailable: true,
      scope,
      note: `基金涨跌分布加载失败：${err.message}（稍后刷新重试）`,
      updatedAt: Date.now(),
    };
    renderFundDistribution();
  } finally {
    state.loading.delete('funddist');
  }
}

async function loadFundThemes(force = false) {
  if (!force && state.fundThemes && !state.fundThemes.unavailable) {
    renderFundThemeOverview();
    return;
  }
  if (state.loading.has('fundthemes') && !force) return;
  state.loading.add('fundthemes');
  try {
    const data = await api('/api/funds/themes?type=equity', 60000);
    state.fundThemes = data;
    renderFundThemeOverview();
  } catch (err) {
    state.fundThemes = {
      unavailable: true,
      themes: [],
      note: `板块总览加载失败：${err.message}（稍后刷新重试）`,
      updatedAt: Date.now(),
    };
    renderFundThemeOverview();
  } finally {
    state.loading.delete('fundthemes');
  }
}

async function openFundTheme(sector) {
  if (!sector) return;
  state.fundThemeSector = sector;
  state.fundThemeDetail = null;
  state.fundThemeDetailDate = '';
  toast(`正在加载「${sector}」板块…`, 'info', 1600);
  try {
    const data = await api(`/api/funds/theme?sector=${encodeURIComponent(sector)}&days=120`, 60000);
    if (state.fundThemeSector !== sector) return;
    state.fundThemeDetail = data;
    state.fundThemeDetailDate = data.date || '';
    openFundThemeDrawer();
  } catch (err) {
    toast(`板块详情加载失败：${err.message}`, 'err');
  }
}

async function loadFundBoard(force = false) {
  const tab = ['gain', 'loss', 'hot', 'etf'].includes(state.fundBoardTab) ? state.fundBoardTab : 'gain';
  const type = state.fundBoardTab === 'etf' ? 'all' : (['gp', 'zs', 'hh'].includes(state.fundBoardType) ? state.fundBoardType : 'all');
  const key = `${tab}:${type}`;
  if (!force && state.fundBoard && state.fundBoard.key === key && !state.fundBoard.unavailable) {
    renderFundBoard();
    return;
  }
  if (state.loading.has('fundboard') && !force) return;
  state.loading.add('fundboard');
  try {
    const data = await api(`/api/funds/board?tab=${tab}&type=${type}&limit=50`, 60000);
    if (`${state.fundBoardTab}:${state.fundBoardTab === 'etf' ? 'all' : state.fundBoardType}` !== key) return;
    state.fundBoard = { ...data, key };
    renderFundBoard();
    renderFundBoardCompareBar();
  } catch (err) {
    state.fundBoard = {
      unavailable: true,
      key,
      items: [],
      note: `基金排行加载失败：${err.message}（稍后刷新重试）`,
      updatedAt: Date.now(),
    };
    renderFundBoard();
  } finally {
    state.loading.delete('fundboard');
  }
}

async function loadFundFlow(force = false) {
  if (state.loading.has('fundflow') && !force) return;
  state.loading.add('fundflow');
  try {
    const data = await api(`/api/funds/flow?type=${state.fundFlowDir}&limit=40&category=${state.fundCategory}`);
    state.fundFlow = data;
    renderFundSummary();
    renderFundFlowTable();
    renderFundCategories();
  } catch (err) {
    handleLoadError('ETF 资金流', err);
  } finally {
    state.loading.delete('fundflow');
  }
}

async function loadFundWatch(force = false) {
  if (!state.fundWatchlist.length) {
    state.fundWatchData = { items: [] };
    renderPortfolioTabs();
    renderFundTopMovers();
    renderFundWatchSummary();
    renderFundWatchTable();
    renderFundHoldSummary();
    renderFundHoldTable();
    renderFundPnl();
    if (state.view === 'strategy') renderPortfolioAdvice();
    return;
  }
  if (state.loading.has('fundwatch') && !force) return;
  state.loading.add('fundwatch');
  try {
    const codes = state.fundWatchlist.map((f) => f.code).slice(0, 20);
    const data = await api(`/api/funds/watch?codes=${encodeURIComponent(codes.join(','))}&risk=${state.settings.risk}`);
    state.fundWatchData = data;
    renderPortfolioTabs();
    renderFundTopMovers();
    renderFundWatchSummary();
    renderFundWatchTable();
    renderFundHoldSummary();
    renderFundHoldTable();
    renderFundPnl();
    if (state.view === 'strategy') renderPortfolioAdvice();
  } catch (err) {
    handleLoadError('自选基金', err);
  } finally {
    state.loading.delete('fundwatch');
  }
}

/* =========================================================
   自选基金盈亏统计（v2.10.0：计算逻辑已移到 views/fundpnl.js）
   ---------------------------------------------------------
   - 逐日盈亏：份额 × 当日净值变动，只统计「建仓日之后」；
   - 区间盈亏用逐日盈亏累加，避免加仓/申赎把本金算成收益；
   - 今日盈亏仍与「我的持仓」同口径（实时价 / 当日估值）。
   ========================================================= */
const FUND_PNL_MAX_HOLDINGS = 12;

function fundHeldList(holdings) {
  const map = holdings || state.fundHoldings || {};
  return state.fundWatchlist
    .map((f) => ({ code: String(f.code), name: f.name || f.code, type: f.type, h: map[String(f.code)] }))
    .filter((f) => f.h && Number(f.h.shares) > 0)
    .slice(0, FUND_PNL_MAX_HOLDINGS);
}

function renderFundwatchPanels() {
  renderFundWatchSummary();
  renderFundWatchTable();
  renderFundHoldSummary();
  renderFundHoldTable();
  renderPortfolioTabs();
  renderFundTopMovers();
  renderFundPnlCalendar();
  renderFundVsIndex();
  renderFundPnl();
}

async function loadFundPnl(force = false) {
  const held = fundHeldList(activeHoldings());
  if (!held.length) {
    state.fundPnl = { items: [], missing: [], index: null, codes: '' };
    renderFundPnl();
    renderFundPnlCalendar();
    renderFundVsIndex();
    renderFundTopMovers();
    return;
  }
  const codes = held.map((f) => f.code).join(',');
  if (!force && state.fundPnl && state.fundPnl.codes === codes) {
    renderFundPnl();
    renderFundPnlCalendar();
    renderFundVsIndex();
    return;
  }
  if (state.loading.has('fundpnl') && !force) return;
  state.loading.add('fundpnl');
  const note = $('#fundPnlNote');
  if (note) note.textContent = '正在计算盈亏曲线：首次需要拉取净值历史（最多约 2 年），可能要 10~40 秒…';
  try {
    const data = await api(`/api/funds/pnl-series?codes=${encodeURIComponent(codes)}&days=${Number(state.fundPnlDays) || 800}&index=1.000001`, 180000);
    state.fundPnl = { ...(data || {}), codes, at: Date.now() };
    renderFundPnl();
    renderFundPnlCalendar();
    renderFundVsIndex();
    if (state.fundRange === 'today') loadFundIntradayCompare();
  } catch (err) {
    if (note) note.textContent = `盈亏曲线加载失败：${err.message}`;
    renderFundPnlCalendar();
    renderFundVsIndex();
  } finally {
    state.loading.delete('fundpnl');
  }
}

/** 当日「我的组合 vs 上证」盘中估算序列（只在选中「当日」时按需加载，缓存 60 秒） */
async function loadFundIntradayCompare(force = false) {
  const held = fundHeldList(activeHoldings());
  if (!held.length) {
    state.fundIntraday = null;
    renderFundVsIndex();
    return;
  }
  const codes = held.map((f) => f.code).slice(0, 8).join(',');
  if (!force && state.fundIntraday && state.fundIntraday.codes === codes) {
    renderFundVsIndex();
    return;
  }
  if (state.loading.has('fundintraday')) return;
  state.loading.add('fundintraday');
  state.fundIntradayLoading = true;
  renderFundVsIndex();
  try {
    const data = await api(`/api/funds/intraday-series?codes=${encodeURIComponent(codes)}&index=1.000001`, 90000);
    state.fundIntraday = { ...(data || {}), codes, at: Date.now() };
  } catch (err) {
    state.fundIntraday = { codes, funds: [], index: null, note: `当日估算加载失败：${err.message}`, at: Date.now() };
  } finally {
    state.loading.delete('fundintraday');
    state.fundIntradayLoading = false;
    renderFundVsIndex();
  }
}

function pnlKpi(label, pnl, pct, sub) {
  const tone = pnl === null || pnl === undefined ? '' : toneClass(pnl);
  const main = pnl === null || pnl === undefined ? '--' : signedFmt(pnl, 2);
  const percent = isNum(pct) ? `${pct >= 0 ? '+' : ''}${Number(pct).toFixed(2)}%` : '';
  // v2.9.2：百分比与口径说明同时显示（例如「+0.83% · 按当日估值」）
  const line = [percent, sub].filter(Boolean).join(' · ');
  return `<div class="summary-card"><div class="sc-label">${esc(label)}</div><div class="sc-value ${tone}">${main}</div><div class="sc-sub">${esc(line)}</div></div>`;
}

function renderFundPnl() {
  const kpis = $('#fundPnlKpis');
  if (!kpis) return;
  const note = $('#fundPnlNote');
  const held = fundHeldList(activeHoldings());
  if (!held.length) {
    kpis.innerHTML = ['今日盈亏', '近1月盈亏', '今年至今', '近1年盈亏']
      .map((label) => `<div class="summary-card"><div class="sc-label">${label}</div><div class="sc-value">--</div><div class="sc-sub">未录持仓</div></div>`)
      .join('');
    if ($('#fundPnlChart')) $('#fundPnlChart').innerHTML = '<div class="empty small">先在下方「我的自选基金」表格点「仓」录入份额与成本</div>';
    if ($('#fundPnlBars')) $('#fundPnlBars').innerHTML = '<div class="empty small">还没有持仓，暂无月度盈亏</div>';
    if ($('#fundPnlChartMeta')) $('#fundPnlChartMeta').textContent = '';
    if (note) note.textContent = '盈亏统计按已录入份额与成本计算；份额与成本保存在你的账号里（服务端），换设备自动恢复。';
    return;
  }
  const calc = computeFundPnl(state.fundPnl);
  if (!calc) {
    kpis.innerHTML = held.map((f) => `<div class="summary-card"><div class="sc-label">${esc(cleanName(f.name) || f.code)}</div><div class="sc-value">--</div><div class="sc-sub">净值历史不足</div></div>`).slice(0, 4).join('');
    if ($('#fundPnlChart')) $('#fundPnlChart').innerHTML = '<div class="empty small">正在获取净值历史…</div>';
    if ($('#fundPnlBars')) $('#fundPnlBars').innerHTML = '<div class="empty small">正在获取净值历史…</div>';
    if (note) note.textContent = '已提交请求，正在等待净值历史返回。';
    return;
  }
  const range = state.fundPnlRange || 'year';
  const days = range === 'quarter' ? 92 : range === 'half' ? 182 : 365;
  const cutoff = shanghaiDateShift(calc.asOf, -days);
  const rangeRows = calc.rows.filter((r) => r.d >= cutoff);
  const chartRows = rangeRows.length >= 2 ? rangeRows : calc.rows.slice(-2);
  // v2.9.0：今日盈亏 / 累计收益 / 组合市值 直接取「我的持仓」同一个 fundPortfolio()，
  // 两处面板从此逐分一致（此前盈亏面板用已公布净值序列，场外 T+1 会差一天）。
  const pf = fundPortfolio();
  // 口径要看「自选基金行情」里的字段（pctKind / estimatePct / navPctToday），持仓结构里没有这些
  const watched = (state.fundWatchData && state.fundWatchData.items) || [];
  const basis = fundDayBasis(watched.filter((x) => getFundHolding(x.code)));
  kpis.innerHTML = [
    pnlKpi('今日盈亏', pf.dayProfit, pf.dayPct, pf.dayProfit === null ? `${basis.label} · 今日数据未出` : `按${basis.label.replace(/^按/, '')}口径`),
    pnlKpi('近1月盈亏', calc.m1Pnl, calc.m1Pct),
    pnlKpi('今年至今', calc.ytdPnl, calc.ytdPct),
    pnlKpi('近1年盈亏', calc.y1Pnl, calc.y1Pct),
    `<div class="summary-card"><div class="sc-label">累计收益</div><div class="sc-value ${toneClass(pf.profit)}">${pf.profit === null ? '--' : signedFmt(pf.profit, 2)}</div><div class="sc-sub ${toneClass(pf.profitPct)}">${isNum(pf.profitPct) ? `${pf.profitPct >= 0 ? '+' : ''}${Number(pf.profitPct).toFixed(2)}%` : '需录入成本净值'}</div></div>`,
    `<div class="summary-card"><div class="sc-label">组合市值</div><div class="sc-value">${nf(pf.marketValue, 2)}</div><div class="sc-sub">${pf.counted} 只 · 截至 ${esc(calc.asOf)}</div></div>`,
  ].join('');
  // v2.9.2：口径标签与「我的持仓」同一份文案（前日净值 / 当日估值 / 15:00 估值终值 / 今日净值）
  const basisLine = $('#fundPnlBasis');
  if (basisLine) basisLine.innerHTML = fundDayBasisLine(basis);
  fundPnlAreaChart($('#fundPnlChart'), chartRows, { cost: pf.costValue > 0 ? pf.costValue : null });
  fundPnlMonthlyBars($('#fundPnlBars'), calc.monthly);
  if ($('#fundPnlChartMeta')) $('#fundPnlChartMeta').textContent = `${chartRows[0].d} → ${calc.asOf}`;
  if (note) {
    const parts = ['今日盈亏 / 累计收益 / 组合市值 与上方「我的持仓」同一口径（含今日估算净值）'];
    if (calc.startDate) parts.push(`统计起点 ${calc.startDate}（从建仓日起算，不统计建仓前）`);
    if (calc.missingCount) parts.push(`${calc.missingCount} 只未取到净值历史，未计入区间曲线`);
    if (calc.rangeDays < 300) parts.push(`历史仅 ${calc.rangeDays} 天，年区间不完整`);
    parts.push('区间收益按逐日盈亏累加；场外净值 T+1、QDII 滞后；不含申赎费');
    note.textContent = parts.join(' · ');
  }
  renderFundPnlCalendar();
  renderFundVsIndex();
}

/* 场外基金资金流：基金季报申购 / 赎回（前 50 名） */
const OPEN_FUND_CAT_LABEL = {
  equity: '股票型',
  mixed: '混合型',
  index: '指数型',
  bond: '债券型',
  money: '货币型',
  commodity: '商品型',
};

async function loadOpenFlow(force = false) {
  if (!force && state.openFlowData && state.openFlowData.category === state.openFlowCategory) {
    renderOpenFlow();
    return;
  }
  if (state.loading.has('openflow')) return;
  state.loading.add('openflow');
  try {
    const data = await api(
      `/api/funds/open-flow?category=${encodeURIComponent(state.openFlowCategory)}&limit=50`,
      45000,
    );
    state.openFlowData = data;
    renderOpenFlow();
  } catch (err) {
    handleLoadError('场外基金资金流', err);
  } finally {
    state.loading.delete('openflow');
  }
}

function renderOpenFlow() {
  const summary = $('#openFlowSummary');
  const inTable = $('#openFlowInTable');
  const outTable = $('#openFlowOutTable');
  const meta = $('#openFlowMeta');
  if (!summary || !inTable || !outTable) return;
  const d = state.openFlowData;
  if (!d) {
    summary.innerHTML = Array.from({ length: 4 }).map(() => '<div class="summary-card"><div class="sc-label">场外基金</div><div class="sc-value">--</div><div class="sc-sub">加载中</div></div>').join('');
    inTable.innerHTML = '<tbody><tr><td><div class="empty">正在拉取场外基金季报数据（约 2 万只，首次约 10 秒）</div></td></tr></tbody>';
    outTable.innerHTML = '<tbody><tr><td><div class="empty">正在拉取场外基金季报数据…</div></td></tr></tbody>';
    if (meta) meta.textContent = '季报口径 · 加载中';
    return;
  }
  const inRows = d.inflow || [];
  const outRows = d.outflow || [];
  summary.innerHTML = `
    <div class="summary-card"><div class="sc-label">报告期</div><div class="sc-value">${esc(d.periodLabel)}</div><div class="sc-sub">基金季报申购赎回</div></div>
    <div class="summary-card"><div class="sc-label">场外基金样本</div><div class="sc-value">${nf(d.sample, 0)}</div><div class="sc-sub">剔除场内 ETF / LOF，保留ETF 联接</div></div>
    <div class="summary-card"><div class="sc-label">净申购合计</div><div class="sc-value tone-up">+${nf(d.inflowTotal, 1)} 亿</div><div class="sc-sub">${nf(d.inflowCount, 0)} 只净流入</div></div>
    <div class="summary-card"><div class="sc-label">净赎回合计</div><div class="sc-value tone-down">${nf(d.outflowTotal, 1)} 亿</div><div class="sc-sub">${nf(d.outflowCount, 0)} 只净流出</div></div>`;
  if (meta) meta.textContent = `${d.periodLabel} 季报 · 样本 ${nf(d.sample, 0)} 只 · 净流入 / 净流出：${inRows.length} / ${outRows.length} 只`;
  const head = '<thead><tr><th>#</th><th>基金</th><th>类型</th><th>申购(亿份)</th><th>赎回(亿份)</th><th>净额(亿元)</th><th>规模(亿元)</th></tr></thead>';
  const rowsHtml = (rows, direction) => rows.map((x, i) => {
    const tone = direction === 'in' ? 'tone-up' : 'tone-down';
    return `<tr data-fund-code="${esc(x.code)}" data-fund-name="${esc(cleanName(x.name))}" data-fund-type="open">
      <td class="t-dim">${i + 1}</td>
      <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-code">${esc(x.code)}</span></td>
      <td><span class="fund-tag open">${esc(OPEN_FUND_CAT_LABEL[x.category] || '其他')}</span></td>
      <td class="t-dim">${nf(x.subYi, 1)}</td>
      <td class="t-dim">${nf(x.redYi, 1)}</td>
      <td class="t-chg ${tone}">${x.netYi > 0 ? '+' : ''}${nf(x.netYi, 1)}</td>
      <td class="t-dim">${nf(x.sizeYi, 1)}</td>
    </tr>`;
  }).join('');
  inTable.innerHTML = head + `<tbody>${rowsHtml(inRows, 'in') || '<tr><td colspan="7"><div class="empty">没有净流入数据</div></td></tr>'}</tbody>`;
  outTable.innerHTML = head + `<tbody>${rowsHtml(outRows, 'out') || '<tr><td colspan="7"><div class="empty">没有净流出数据</div></td></tr>'}</tbody>`;
}

/* 场外基金每日代理：目标ETF 实时主力额× 规模占比 */
async function loadProxy(force = false) {
  if (!force && state.proxyData) {
    renderProxy();
    return;
  }
  if (state.loading.has('fundproxy')) return;
  state.loading.add('fundproxy');
  try {
    const data = await api('/api/funds/daily-proxy?limit=50', 45000);
    state.proxyData = data;
    renderProxy();
  } catch (err) {
    handleLoadError('场外基金每日代理', err);
  } finally {
    state.loading.delete('fundproxy');
  }
}

function renderProxy() {
  const summary = $('#proxySummary');
  const table = $('#proxyTable');
  const meta = $('#proxyMeta');
  const title = $('#proxyTableTitle');
  const badge = $('#proxyDirBadge');
  if (!summary || !table) return;
  const d = state.proxyData;
  if (!d) {
    summary.innerHTML = Array.from({ length: 4 }).map(() => '<div class="summary-card"><div class="sc-label">每日代理</div><div class="sc-value">--</div><div class="sc-sub">加载中</div></div>').join('');
    table.innerHTML = '<tbody><tr><td><div class="empty">正在匹配场外指数基金与目标ETF（首次约 20–30 秒，之后走缓存）</div></td></tr></tbody>';
    if (meta) meta.textContent = '加载中';
    return;
  }
  if (d.unavailable) {
    summary.innerHTML = '<div class="summary-card" style="grid-column:1/-1"><div class="sc-label">数据暂不可用</div><div class="sc-value">--</div><div class="sc-sub">' + esc(d.note || '稍后重试') + '</div></div>';
    table.innerHTML = '<tbody><tr><td><div class="empty">' + esc(d.note || 'ETF 实时资金流暂不可用') + '</div></td></tr></tbody>';
    if (meta) meta.textContent = d.note || '暂不可用';
    return;
  }
  const isIn = state.proxyDir === 'inflow';
  const rows = (isIn ? d.inflow : d.outflow) || [];
  const tone = isIn ? 'tone-up' : 'tone-down';
  summary.innerHTML = `
    <div class="summary-card"><div class="sc-label">匹配场外基金</div><div class="sc-value">${nf(d.matched, 0)}</div><div class="sc-sub">指数 / ETF 联接基金</div></div>
    <div class="summary-card"><div class="sc-label">覆盖目标 ETF</div><div class="sc-value">${nf(d.etfCount, 0)}</div><div class="sc-sub">按名称主题匹配</div></div>
    <div class="summary-card"><div class="sc-label">代理净流入合计</div><div class="sc-value tone-up">+${nf(d.inflowTotal, 1)} 亿</div><div class="sc-sub">按规模占比分摊</div></div>
    <div class="summary-card"><div class="sc-label">代理净流出合计</div><div class="sc-value tone-down">${nf(d.outflowTotal, 1)} 亿</div><div class="sc-sub">按规模占比分摊</div></div>`;
  if (meta) meta.textContent = `代理口径 · ${nf(d.matched, 0)} 只基金/ ${nf(d.etfCount, 0)} 只目标ETF · ETF 资金：${d.flowDate || '--'} · 更新 ${new Date(d.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  if (title) title.textContent = `场外基金 · 目标ETF代理净${isIn ? '流入' : '流出'} TOP 50`;
  if (badge) {
    badge.className = `badge ${tone}`;
    badge.textContent = isIn ? '代理流入' : '代理流出';
  }
  const head = '<thead><tr><th>#</th><th>场外基金</th><th>目标 ETF</th><th>规模占比</th><th>目标ETF主力净流入</th><th>代理净额</th></tr></thead>';
  const body = rows.map((x, i) => `<tr data-fund-code="${esc(x.code)}" data-fund-name="${esc(cleanName(x.name))}" data-fund-type="open">
    <td class="t-dim">${i + 1}</td>
    <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-code">${esc(x.code)}</span></td>
    <td><span class="t-name">${esc(cleanName(x.targetName))}</span><span class="t-code">${esc(x.targetCode)} · 规模 ${nf(x.targetSizeYi, 0)} 亿</span></td>
    <td class="t-dim">${nf(x.ratio, 1)}%</td>
    <td class="t-chg ${toneClass(x.targetMainYi)}">${x.targetMainYi > 0 ? '+' : ''}${nf(x.targetMainYi, 2)}</td>
    <td class="t-chg ${toneClass(x.proxyYi)}">${x.proxyYi > 0 ? '+' : ''}${nf(x.proxyYi, 2)}</td>
  </tr>`).join('');
  table.innerHTML = head + `<tbody>${body || '<tr><td colspan="6"><div class="empty">没有匹配到可用代理数据</div></td></tr>'}</tbody>`;
}

async function loadFundSectorFlow(force = false) {  if (state.loading.has('fundsector') && !force) return;
  state.loading.add('fundsector');
  try {
    const data = await api('/api/funds/sector-flow');
    state.fundSectorData = data;
    renderFundSectorView();
  } catch (err) {
    handleLoadError('基金板块资金', err);
  } finally {
    state.loading.delete('fundsector');
  }
}

function renderFundSectorView() {
  const data = state.fundSectorData;
  const summary = $('#fundSectorSummary');
  const meta = $('#fundSectorMeta');
  const table = $('#fundSectorTable');
  const mainline = $('#fundSectorMainline');
  if (!summary || !table) return;
  if (!data) {
    summary.innerHTML = Array.from({ length: 4 }).map(() => '<div class="summary-card"><div class="sc-label">加载中</div><div class="sc-value">--</div></div>').join('');
    table.innerHTML = '<tbody><tr><td><div class="empty">正在聚合板块资金…</div></td></tr></tbody>';
    if (mainline) mainline.innerHTML = '<div class="empty">加载中…</div>';
    return;
  }
  const key = state.fundSectorSort;
  const list = [...(data.sectors || [])].sort((a, b) => {
    if (key === 'pct') return (Number(b.etfAvgPct) || -999) - (Number(a.etfAvgPct) || -999);
    if (key === 'month') return (Number(b.stockAvgMonth) || -999) - (Number(a.stockAvgMonth) || -999);
    return (Number(b.etfNet) || 0) - (Number(a.etfNet) || 0);
  });
  const topFlow = [...list].sort((a, b) => b.etfNet - a.etfNet)[0];
  const topPct = [...list].sort((a, b) => (b.etfAvgPct || -999) - (a.etfAvgPct || -999))[0];
  const sortLabel = { flow: '主力净流入', pct: 'ETF 平均涨跌', month: '场外基金' }[key];
  if (meta) meta.textContent = `${list.length} 个板块 · ${data.date || '--'} · 按 {sortLabel}排序 · 60 秒刷新`;
  if ($('#fundSectorCount')) $('#fundSectorCount').textContent = `${list.length} 个板块 · ETF ${data.etfCount} 只/ 场外基金 ${data.stockCount} 只`;
  summary.innerHTML = `
    <div class="summary-card"><div class="sc-label">板块 ETF 主力净流入</div><div class="sc-value ${toneClass(data.netInflow)}">${yiFmt(data.netInflow)}</div><div class="sc-sub">ETF 合计 · ${data.date || '--'}</div></div>
    <div class="summary-card"><div class="sc-label">流入 / 流出板块</div><div class="sc-value"><span class="tone-up">${data.inflowCount}</span> <span class="muted">/</span> <span class="tone-down">${data.outflowCount}</span></div><div class="sc-sub">共 ${list.length} 个板块</div></div>
    <div class="summary-card"><div class="sc-label">资金最强板块</div><div class="sc-value">${esc(topFlow ? topFlow.sector : '--')}</div><div class="sc-sub ${topFlow ? toneClass(topFlow.etfNet) : ''}">${topFlow ? yiFmt(topFlow.etfNet) : '--'}</div></div>
    <div class="summary-card"><div class="sc-label">涨幅最强板块</div><div class="sc-value">${esc(topPct ? topPct.sector : '--')}</div><div class="sc-sub ${topPct ? toneClass(topPct.etfAvgPct) : ''}">${topPct ? pctFmt(topPct.etfAvgPct) : '--'}</div></div>`;

  sectorFlowBar($('#fundSectorChart'), list.filter((s) => s.etfCount > 0).map((s) => ({ name: s.sector, main: s.etfNet, pct: s.etfAvgPct })));

  const inflowTop = [...list].filter((s) => s.etfCount > 0 && s.etfNet > 0).sort((a, b) => b.etfNet - a.etfNet).slice(0, 5);
  const outflowTop = [...list].filter((s) => s.etfCount > 0 && s.etfNet < 0).sort((a, b) => a.etfNet - b.etfNet).slice(0, 3);
  if (mainline) {
    mainline.innerHTML = `
      <div class="fund-mainline-label">资金流入</div>
      ${inflowTop.length ? inflowTop.map((s, i) => `<div class="mainline-row" data-fund-sector="${esc(s.sector)}">
        <span class="mainline-rank">${i + 1}</span>
        <div class="mainline-main"><div class="mainline-name">${esc(s.sector)}</div><div class="mainline-sub">ETF ${s.etfCount} 只 · 场外基金 ${s.stockCount} 只</div></div>
        <span class="mainline-val ${toneClass(s.etfNet)}">${yiFmt(s.etfNet)}</span>
      </div>`).join('') : '<div class="empty">暂无明显净流入板块</div>'}
      <div class="fund-mainline-label" style="margin-top:12px">资金流出</div>
      ${outflowTop.length ? outflowTop.map((s) => `<div class="mainline-row" data-fund-sector="${esc(s.sector)}">
        <span class="mainline-rank out">!</span>
        <div class="mainline-main"><div class="mainline-name">${esc(s.sector)}</div><div class="mainline-sub">ETF 平均 ${pctFmt(s.etfAvgPct)}</div></div>
        <span class="mainline-val ${toneClass(s.etfNet)}">${yiFmt(s.etfNet)}</span>
      </div>`).join('') : '<div class="empty">暂无明显净流出板块</div>'}`;
  }

  table.innerHTML = `
    <thead><tr><th>板块</th><th>ETF 主力净流入</th><th>ETF 平均涨跌</th><th>场外基金 数量</th><th>基金规模</th><th>代表 ETF</th><th>代表基金</th></tr></thead>
    <tbody>${list.map((s) => `
      <tr class="sector-row" data-fund-sector="${esc(s.sector)}">
        <td><span class="sector-name-cell"><i class="s-dot"></i>${esc(s.sector)}</span></td>
        <td class="${toneClass(s.etfNet)}">${s.etfCount ? yiFmt(s.etfNet) : '<span class="muted">无ETF</span>'}</td>
        <td class="${toneClass(s.etfAvgPct)}">${s.etfCount ? pctFmt(s.etfAvgPct) : '--'}</td>
        <td><span class="${toneClass(s.stockAvgDay)}">${pctFmt(s.stockAvgDay)}</span> <span class="muted">/</span> <span class="${toneClass(s.stockAvgMonth)}">${pctFmt(s.stockAvgMonth)}</span></td>
        <td><span class="sector-count">${s.etfCount} ETF · ${s.stockCount} 基金</span></td>
        <td class="sector-leader">${esc(s.leaderEtf ? s.leaderEtf.name : '--')}</td>
        <td class="sector-leader">${esc(s.leaderStock ? s.leaderStock.name : '--')}</td>
      </tr>`).join('') || '<tr><td colspan="7"><div class="empty">暂无板块数据</div></td></tr>'}</tbody>`;
  table.querySelectorAll('.sector-row').forEach((row) => row.addEventListener('click', () => openFundSector(row.dataset.fundSector)));
}

function openFundSector(name) {
  const s = (state.fundSectorData?.sectors || []).find((x) => x.sector === name);
  if (!s) return;
  mountOverlay(`<div class="drawer">
    <div class="drawer-head"><div><div class="eyebrow">FUND SECTOR</div><h2>${esc(s.sector)}</h2><span class="code">板块资金明细</span></div><button class="modal-close" data-close>×</button></div>
    <div class="fund-summary-grid">
      <div class="summary-card"><div class="sc-label">ETF 主力净流入</div><div class="sc-value ${toneClass(s.etfNet)}">${yiFmt(s.etfNet)}</div><div class="sc-sub">${s.etfCount} 只 ETF</div></div>
      <div class="summary-card"><div class="sc-label">ETF 平均涨跌</div><div class="sc-value ${toneClass(s.etfAvgPct)}">${pctFmt(s.etfAvgPct)}</div><div class="sc-sub">当日</div></div>
      <div class="summary-card"><div class="sc-label">场外基金数<数</div><div class="sc-value ${toneClass(s.stockAvgMonth)}">${pctFmt(s.stockAvgMonth)}</div><div class="sc-sub">${s.stockCount} 只基金</div></div>
      <div class="summary-card"><div class="sc-label">板块基金数</div><div class="sc-value">${s.fundCount}</div><div class="sc-sub">ETF + 场外</div></div>
    </div>
    <div class="panel-head"><div><h3>板块内 ETF</h3><span class="muted small">按主力净流入排序</span></div><span class="badge">${s.etfs.length} 只</span></div>
    <div class="table-scroll"><table class="table">
      <thead><tr><th>ETF</th><th>最新</th><th>涨跌</th><th>主力净流入</th></tr></thead>
      <tbody>${s.etfs.map((x) => `<tr data-fund-code="${esc(x.code)}" data-fund-name="${esc(cleanName(x.name))}" data-fund-type="etf">
        <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-code">${esc(x.code)}</span></td>
        <td class="t-price">${priceFmt(x.price)}</td>
        <td class="t-chg ${toneClass(x.pct)}">${pctFmt(x.pct)}</td>
        <td class="t-chg ${toneClass(x.mainYi)}">${yiFmt(x.mainYi)}</td>
      </tr>`).join('') || '<tr><td colspan="4"><div class="empty">暂无 ETF</div></td></tr>'}</tbody>
    </table></div>
    <div class="panel-head" style="margin-top:14px"><div><h3>板块内场外基金</h3><span class="muted small">按近1月排序</span></div><span class="badge">${s.stocks.length} 只</span></div>
    <div class="table-scroll"><table class="table">
      <thead><tr><th>基金</th><th>净值</th><th>日涨跌</th><th>近1月</th></tr></thead>
      <tbody>${s.stocks.map((x) => `<tr data-stock-fund-code="${esc(x.code)}" data-stock-fund-name="${esc(cleanName(x.name))}">
        <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-code">${esc(x.code)}</span></td>
        <td class="t-price">${nf(x.nav, 4)}</td>
        <td class="t-chg ${toneClass(x.day)}">${pctFmt(x.day)}</td>
        <td class="t-chg ${toneClass(x.month)}">${pctFmt(x.month)}</td>
      </tr>`).join('') || '<tr><td colspan="4"><div class="empty">暂无场外基金</div></td></tr>'}</tbody>
    </table></div>
  </div>`, 'drawer-overlay');
}

function renderFunds() {
  const view = state.fundView;
  const panes = {
    sector: $('#fundSectorView'),
    theme: $('#fundThemeView'),
    dist: $('#fundDistView'),
    openfund: $('#fundOpenFundView'),
    openflow: $('#fundOpenFlowView'),
    proxy: $('#fundProxyView'),
    flow: $('#fundFlowView'),
    stock: $('#fundStockView'),
    bond: $('#fundBondView'),
  };
  // v2.10.0：后台可以把某些子页隐藏；当前子页不可用时回退到第一个可见项
  const visible = visibleFundViews();
  if (!panes[view] || !visible.includes(view)) {
    state.fundView = view = visible[0] || 'sector';
  }
  for (const [key, el] of Object.entries(panes)) if (el) el.hidden = key !== view;
  $$('#fundSubnav button').forEach((b) => b.classList.toggle('is-active', b.dataset.fundView === view));
  $$('#fundFlowDirSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.fundDir === state.fundFlowDir));
  $$('#fundCategorySeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.fundCategory === state.fundCategory));
  $$('#fundSectorSortSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.sectorSort === state.fundSectorSort));
  $$('#stockFundTypeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.stockFundType === state.stockFundType));
  $$('#stockFundSortSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.stockFundSort === state.stockFundSort));
  $$('#bondFundSortSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.bondFundSort === state.bondFundSort));
  if ($('#openFlowCat')) $('#openFlowCat').value = state.openFlowCategory;
  $$('#proxyDirSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.proxyDir === state.proxyDir));
  $$('#fundDistScopeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.fundDistScope === (state.fundDistScope === 'etf' ? 'etf' : 'equity')));
  if (view === 'sector') renderFundSectorView();
  if (view === 'theme') {
    renderFundThemeOverview();
    $$('#fundThemeSortSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.fundThemeSort === state.fundThemeSort));
  }
  if (view === 'dist') {
    renderFundDistribution();
    if (state.fundDist && state.fundDist.scope !== (state.fundDistScope === 'etf' ? 'etf' : 'equity')) loadFundDistribution();
  }
  if (view === 'openfund') {
    renderFundBoard();
    $$('#fundBoardTabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.fundBoardTab === state.fundBoardTab));
    $$('#fundBoardTypeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.fundBoardType === state.fundBoardType && state.fundBoardTab !== 'etf'));
  }
  if (view === 'openflow') renderOpenFlow();
  if (view === 'proxy') renderProxy();
  if (view === 'flow') {
    renderFundSummary();
    renderFundFlowTable();
    renderFundCategories();
  }
  if (view === 'stock') {
    renderStockFund();
    renderStockFundIntel();
    renderCompareBar();
  }
  if (view === 'bond') renderBondFund();
}


function renderFundFlowTable() {
  const el = $('#fundFlowTable');
  if (!el) return;
  const f = state.fundFlow;
  if (f && f.unavailable) {
    if ($('#fundFlowMeta')) $('#fundFlowMeta').textContent = '数据源不可用';
    el.innerHTML = `<tbody><tr><td><div class="empty">
      ETF 资金流只有东方财富提供，当前接口不可用。<br>
      <span class="muted small">${esc(f.reason || '')}</span><br>
      <button class="text-link mt8" data-source-open>查看数据源状态</button>
    </div></td></tr></tbody>`;
    return;
  }
  if ($('#fundFlowMeta')) {
    $('#fundFlowMeta').textContent = f
      ? `${f.universe} 只样本 · ${f.date || '--'} · 60 秒刷新`
      : '正在加载 ETF 资金流…';
  }
  if (!f || !f.items || !f.items.length) {
    el.innerHTML = '<tbody><tr><td><div class="empty">暂无 ETF 资金流数据</div></td></tr></tbody>';
    return;
  }
  el.innerHTML = `
    <thead><tr><th>基金</th><th>最新</th><th>涨跌</th><th>主力净流入</th><th>净占比</th><th>成交额</th></tr></thead>
    <tbody>${f.items.map((x) => `
      <tr data-fund-code="${esc(x.code)}" data-fund-name="${esc(cleanName(x.name))}" data-fund-type="etf">
        <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-code">${esc(x.code)} · <span class="fund-tag etf">ETF</span></span></td>
        <td class="t-price">${priceFmt(x.price)}</td>
        <td class="t-chg ${toneClass(x.pct)}">${pctFmt(x.pct)}</td>
        <td class="t-chg ${toneClass(x.mainYi)}">${yiFmt(x.mainYi)}</td>
        <td class="t-dim">${isNum(x.mainPct) ? `${nf(x.mainPct, 2)}%` : '--'}</td>
        <td class="t-dim">${isNum(x.amountYi) ? `${nf(x.amountYi, 1)} 亿` : '--'}</td>
      </tr>`).join('')}</tbody>`;
}

function renderFundCategories() {
  const el = $('#fundCategoryPanel');
  if (!el) return;
  const cats = (state.fundFlow && state.fundFlow.categories) || [];
  if (!cats.length) {
    el.innerHTML = '<div class="panel-head"><div><div class="eyebrow">ETF CATEGORY</div><h2>ETF 类别资金流</h2></div></div><div class="empty">暂无类别数据</div>';
    return;
  }
  const maxAbs = Math.max(...cats.map((c) => Math.abs(c.net)), 1);
  el.innerHTML = `
    <div class="panel-head"><div><div class="eyebrow">ETF CATEGORY</div><h2>ETF 类别资金流</h2></div><span class="muted small">当日主力净流入</span></div>
    <div class="fund-cat-list">${cats.map((c) => {
      const width = Math.max(4, (Math.abs(c.net) / maxAbs) * 100);
      return `<div class="fund-cat-row">
        <span class="fund-cat-name">${esc(c.label)}</span>
        <span class="fund-cat-track"><i style="width:${width}%;${c.net < 0 ? 'background:linear-gradient(90deg,#16c784,#4ade80)' : ''}"></i></span>
        <span class="fund-cat-val ${toneClass(c.net)}">${yiFmt(c.net)} · ${c.count}只</span>
      </div>`;
    }).join('')}</div>`;
}

async function loadStockFund(force = false) {
  if (state.loading.has('stockfund') && !force) return;
  const reqKey = `${state.stockFundType}:${state.stockFundSort}`;
  state.loading.add('stockfund');
  try {
    const data = await api(`/api/funds/stock-rank?type=${state.stockFundType}&sort=${state.stockFundSort}&limit=30`);
    if (reqKey !== `${state.stockFundType}:${state.stockFundSort}`) return;
    state.stockFund = data;
    renderStockFund();
  } catch (err) {
    handleLoadError('股票型基金情报', err);
  } finally {
    state.loading.delete('stockfund');
  }
}

async function loadStockFundIntel(force = false) {
  if (state.loading.has('stockintel') && !force) return;
  state.loading.add('stockintel');
  try {
    const [hot, warnings] = await Promise.all([
      api('/api/funds/hot'),
      api('/api/funds/warnings'),
    ]);
    state.stockFundIntel = { hot, warnings };
    renderStockFundIntel();
  } catch (err) {
    handleLoadError('基金推荐与风险提醒', err);
  } finally {
    state.loading.delete('stockintel');
  }
}

async function loadBondFund(force = false) {
  if (!force && state.bondFund) { renderBondFund(); return; }
  if (state.loading.has('bondfund') && !force) return;
  state.loading.add('bondfund');
  try {
    const data = await api(`/api/funds/stock-rank?type=zq&sort=${state.bondFundSort}&limit=30`);
    state.bondFund = data;
    renderBondFund();
  } catch (err) {
    handleLoadError('债基排行', err);
  } finally {
    state.loading.delete('bondfund');
  }
}

function renderBondFund() {
  const el = $('#bondFundTable');
  if (!el) return;
  const d = state.bondFund;
  const summary = $('#bondFundSummary');
  const meta = $('#bondFundMeta');
  const sortLabel = { day: '近1日', week: '近1周', month: '近1月', month3: '近3月', month6: '近6月', year: '近1年' }[state.bondFundSort] || '近1日';
  if (!d) {
    if (summary) summary.innerHTML = Array.from({ length: 4 }).map(() => '<div class="summary-card"><div class="sc-label">加载中</div><div class="sc-value">--</div></div>').join('');
    el.innerHTML = '<tbody><tr><td><div class="empty">正在拉取债基排行…</div></td></tr></tbody>';
    return;
  }
  const items = d.items || [];
  const avgDay = items.length ? items.reduce((s, x) => s + (Number(x.day) || 0), 0) / items.length : 0;
  const up = items.filter((x) => (Number(x.day) || 0) > 0).length;
  const down = items.filter((x) => (Number(x.day) || 0) < 0).length;
  const top = items[0];
  if (meta) meta.textContent = `${d.count || items.length} 只 · ${d.date || '--'} · 按 {sortLabel}排序`;
  if (summary) summary.innerHTML = `
    <div class="summary-card"><div class="sc-label">TOP30 平均日涨跌</div><div class="sc-value ${toneClass(avgDay)}">${pctFmt(avgDay)}</div><div class="sc-sub">债券型样本</div></div>
    <div class="summary-card"><div class="sc-label">上涨 / 下跌</div><div class="sc-value"><span class="tone-up">${up}</span> <span class="muted">/</span> <span class="tone-down">${down}</span></div><div class="sc-sub">样本内基金数量</div></div>
    <div class="summary-card"><div class="sc-label">${sortLabel}最高</div><div class="sc-value">${esc(top ? cleanName(top.name) : '--')}</div><div class="sc-sub ${top ? toneClass(top[d.sortKey]) : ''}">${top ? pctFmt(top[d.sortKey]) : '--'}</div></div>
    <div class="summary-card"><div class="sc-label">净值日期</div><div class="sc-value">${esc(d.date || '--')}</div><div class="sc-sub">债基净值通常 T+1</div></div>`;
  el.innerHTML = `
    <thead><tr><th>基金</th><th>最新净值</th><th>日涨跌</th><th>近1周</th><th>近1月</th><th>近1年</th></tr></thead>
    <tbody>${items.map((x) => `<tr data-stock-fund-code="${esc(x.code)}" data-stock-fund-name="${esc(cleanName(x.name))}">
      <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-code">${esc(x.code)} · <span class="fund-tag open">债基</span></span></td>
      <td class="t-price">${nf(x.nav, 4)}</td>
      <td class="t-chg ${toneClass(x.day)}">${pctFmt(x.day)}</td>
      <td class="t-chg ${toneClass(x.week)}">${pctFmt(x.week)}</td>
      <td class="t-chg ${toneClass(x.month)}">${pctFmt(x.month)}</td>
      <td class="t-chg ${toneClass(x.year)}">${pctFmt(x.year)}</td>
    </tr>`).join('') || '<tr><td colspan="6"><div class="empty">暂无债基数据</div></td></tr>'}</tbody>`;
}

function renderStockFund() {
  const el = $('#stockFundTable');
  if (!el) return;
  const f = state.stockFund;
  const summary = $('#stockFundSummary');
  const meta = $('#stockFundMeta');
  const sortLabel = { day: '近1日', week: '近1周', month: '近1月', month3: '近3月', month6: '近6月', year: '近1年' }[state.stockFundSort] || '近1日';
  if (meta) {
    meta.innerHTML = f
      ? `${esc(f.typeLabel)} · ${f.count} 只 · 展示：${(f.items || []).length} · ${esc(f.date || '--')} · 按 {sortLabel}排序`
      : '正在加载股票型基金情报…';
  }
  if (!f) {
    if (summary) summary.innerHTML = '<div class="summary-card"><div class="sc-label">加载中</div><div class="sc-value">--</div></div>';
    el.innerHTML = '<tbody><tr><td><div class="empty">正在拉取股票型基金排行…</div></td></tr></tbody>';
    return;
  }
  const items = f.items || [];
  const avg = items.length ? items.reduce((s, x) => s + (Number(x.day) || 0), 0) / items.length : 0;
  const up = items.filter((x) => (Number(x.day) || 0) > 0).length;
  const down = items.filter((x) => (Number(x.day) || 0) < 0).length;
  const top = items[0];
  if (summary) {
    summary.innerHTML = `
      <div class="summary-card"><div class="sc-label">TOP30 平均日涨跌</div><div class="sc-value ${toneClass(avg)}">${pctFmt(avg)}</div><div class="sc-sub">${esc(f.typeLabel)} TOP ${items.length}</div></div>
      <div class="summary-card"><div class="sc-label">上涨 / 下跌</div><div class="sc-value"><span class="tone-up">${up}</span> <span class="muted">/</span> <span class="tone-down">${down}</span></div><div class="sc-sub">样本内基金数量</div></div>
      <div class="summary-card"><div class="sc-label">${sortLabel}最高</div><div class="sc-value">${esc(top ? top.name : '--')}</div><div class="sc-sub ${top ? toneClass(top[f.sortKey]) : ''}">${top ? pctFmt(top[f.sortKey]) : '--'}</div></div>
      <div class="summary-card"><div class="sc-label">净值日期</div><div class="sc-value">${esc(f.date || '--')}</div><div class="sc-sub">盘中估值以实际页面为准</div></div>`;
  }
  el.innerHTML = `
    <thead><tr><th class="compare-col">对比</th><th>基金</th><th>最新净值</th><th>日涨跌</th><th>近1周</th><th>近1月</th><th>近1年</th></tr></thead>
    <tbody>${items.map((x) => {
      const checked = state.compareFunds.some((c) => c.code === x.code);
      return `<tr data-stock-fund-code="${esc(x.code)}" data-stock-fund-name="${esc(cleanName(x.name))}">
        <td class="compare-col"><input class="compare-check" type="checkbox" data-compare-code="${esc(x.code)}" data-compare-name="${esc(cleanName(x.name))}" ${checked ? 'checked' : ''}></td>
        <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-code">${esc(x.code)} · <span class="fund-tag open">${esc(x.type)}</span></span></td>
        <td class="t-price">${nf(x.nav, 4)}</td>
        <td class="t-chg ${toneClass(x.day)}">${pctFmt(x.day)}</td>
        <td class="t-chg ${toneClass(x.week)}">${pctFmt(x.week)}</td>
        <td class="t-chg ${toneClass(x.month)}">${pctFmt(x.month)}</td>
        <td class="t-chg ${toneClass(x.year)}">${pctFmt(x.year)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7"><div class="empty">暂无基金数据</div></td></tr>'}</tbody>`;
}

function renderStockFundIntel() {
  const el = $('#stockFundIntel');
  if (!el) return;
  const data = state.stockFundIntel;
  if (!data) {
    el.innerHTML = '<div class="intel-card"><div class="empty">正在筛选热门基金与风险提醒…</div></div>';
    return;
  }
  const hot = data.hot || {};
  const warn = data.warnings || {};
  const hotRows = [
    ...(hot.stocks || []).slice(0, 2).map((x) => ({ ...x, label: '股票型' })),
    ...(hot.etfs || []).slice(0, 2).map((x) => ({ ...x, label: 'ETF' })),
  ];
  const warnRows = [
    ...(warn.stocks || []).slice(0, 2),
    ...(warn.etfs || []).slice(0, 2),
  ];
  el.innerHTML = `
    <div class="intel-card">
      <div class="intel-head"><div><div class="intel-title">热门基金推荐</div><div class="intel-sub">阶段动量 + 资金流规则筛选</div></div><span class="fund-tag etf">关注</span></div>
      <div class="intel-list">${hotRows.length ? hotRows.map((x) => `
        <div class="intel-item" data-intel-code="${esc(x.code)}" data-intel-name="${esc(cleanName(x.name))}" data-intel-type="${x.type}">
          <div class="intel-main"><div class="intel-name">${esc(cleanName(x.name))} <span class="fund-tag ${x.type === 'etf' ? 'etf' : 'open'}">${x.label}</span></div><div class="intel-reason">${esc(x.reason)}</div></div>
          <div class="intel-val ${toneClass(x.day)}">${pctFmt(x.day)}</div>
        </div>`).join('') : '<div class="empty">暂无满足条件的基金</div>'}</div>
      <div class="intel-sub" style="margin-top:6px">${esc(hot.note || '')}</div>
    </div>
    <div class="intel-card">
      <div class="intel-head"><div><div class="intel-title">避坑提醒</div><div class="intel-sub">弱势区间 / 资金持续流出</div></div><span class="fund-tag open">谨慎</span></div>
      <div class="intel-warn">${warnRows.length ? warnRows.map((x) => `
        <div class="intel-warn-item" data-intel-code="${esc(x.code)}" data-intel-name="${esc(cleanName(x.name))}" data-intel-type="${x.type}">
          <span class="iw-mark">!</span>
          <div class="iw-main"><div class="iw-name">${esc(cleanName(x.name))}</div><div class="iw-reason">${esc(x.reason)}</div></div>
        </div>`).join('') : '<div class="empty">暂无触发风险规则的基金</div>'}</div>
      <div class="intel-sub" style="margin-top:6px">${esc(warn.note || '')}</div>
    </div>`;
}

function renderCompareBar() {
  const bar = $('#stockFundCompareBar');
  if (!bar) return;
  bar.hidden = !(state.fundView === 'stock');
  if ($('#compareCount')) $('#compareCount').textContent = state.compareFunds.length;
  if ($('#compareChips')) {
    $('#compareChips').innerHTML = state.compareFunds.map((f) => `<span class="compare-chip">${esc(cleanName(f.name))}<button data-compare-remove="${esc(f.code)}">×</button></span>`).join('');
  }
  if ($('#compareBtn')) $('#compareBtn').disabled = state.compareFunds.length < 2;
}

function toggleCompareFund(code, name, checked) {
  if (checked) {
    if (state.compareFunds.some((f) => f.code === code)) return;
    if (state.compareFunds.length >= 4) {
      toast('最多选择 4 只基金进行对比', 'warn');
      renderStockFund();
      return;
    }
    state.compareFunds.push({ code, name });
  } else {
    state.compareFunds = state.compareFunds.filter((f) => f.code !== code);
  }
  renderCompareBar();
}

async function openFundCompare(codes) {
  const list = (codes || state.compareFunds.map((f) => f.code)).slice(0, 4);
  if (list.length < 2) { toast('至少选择 2 只基金', 'warn'); return; }
  mountOverlay(`<div class="modal"><div class="modal-head"><div class="modal-title"><h2>基金对比</h2><span class="code">${list.length} 只</span></div><button class="modal-close" data-close>×</button></div><div class="empty">正在计算对比数据…</div></div>`);
  const overlay = $('.overlay');
  try {
    const data = await api(`/api/funds/compare?codes=${encodeURIComponent(list.join(','))}`);
    const items = data.items || [];
    if (!items.length) throw new Error('没有可对比的数据');
    const rows = [
      ['类型', (x) => x.type || '--', 'text'],
      ['最新净值', (x) => nf(x.nav, 4), 'text'],
      ['日涨幅', (x) => x.day, 'pct'],
      ['近1周', (x) => x.week, 'pct'],
      ['近1月', (x) => x.month, 'pct'],
      ['近3月', (x) => x.month3, 'pct'],
      ['近1年', (x) => x.year, 'pct'],
      ['近3年', (x) => x.year2, 'pct'],
      ['最大回撤', (x) => (isNum(x.maxDrawdown) ? -Math.abs(x.maxDrawdown) : null), 'pct'],
      ['夏普(1年3年', (x) => x.sharpe, 'num'],
      ['规模(亿', (x) => (isNum(x.size) ? x.size / 1e8 : null), 'num'],
      ['基金经理', (x) => x.manager || '--', 'text'],
      ['风险等级', (x) => (x.risk ? `${x.risk}/5` : '--'), 'text'],
      ['重仓重合', (x) => (isNum(x.overlap) ? x.overlap : null), 'pct'],
    ];
    const bestFor = (values) => {
      let best = -1;
      let bestVal = -Infinity;
      values.forEach((v, i) => {
        if (isNum(v) && Number(v) > bestVal) {
          bestVal = Number(v);
          best = i;
        }
      });
      return best;
    };
    overlay.innerHTML = `<div class="modal">
      <div class="modal-head"><div class="modal-title"><h2>基金对比</h2><span class="code">${items.length} 只 · 公开数据</span></div><button class="modal-close" data-close>×</button></div>
      <div class="compare-trend-wrap">
        <div class="panel-head"><div><h3>近半年走势对比</h3><span class="muted small">每只基金都按自身起点归一为 100</span></div><span class="badge">归一化</span></div>
        <div id="compareTrendChart" class="compare-trend"></div>
      </div>
      <div class="table-scroll"><table class="compare-table">
        <thead><tr><th>指标</th>${items.map((x) => `<th><span class="cmp-name">${esc(cleanName(x.name))}</span><span class="cmp-code">${esc(x.code)}</span></th>`).join('')}</tr></thead>
        <tbody>${rows.map(([label, getter, kind]) => {
          const vals = items.map(getter);
          const best = ['pct', 'num'].includes(kind) ? bestFor(vals) : -1;
          return `<tr><td>${label}</td>${vals.map((v, i) => `<td class="${kind === 'pct' ? toneClass(v) : ''} ${i === best ? 'best' : ''}">${kind === 'pct' ? pctFmt(v) : kind === 'num' ? (isNum(v) ? nf(v, 2) : '--') : esc(v)}</td>`).join('')}</tr>`;
        }).join('')}</tbody>
      </table></div>
      <p class="muted small mt12">对比仅基于公开净值、阶段收益、规模、经理与最近一期重仓股；重仓重合以第一只基金为基准。历史业绩不代表未来。</p>
    </div>`;
    compareTrendChart($('#compareTrendChart'), items.map((x) => ({ name: cleanName(x.name) || x.code, points: x.history || [] })));
  } catch (err) {
    toast(`基金对比失败：${err.message}`, 'err');
    closeOverlay();
  }
}

/** 「基金比较」选择器：搜索 + 已选 chips（与场外基金表 / 股票型基金表的勾选共用 state.compareFunds） */
function openFundComparePicker() {
  mountOverlay(`<div class="modal modal-sm">
    <div class="modal-head"><div class="modal-title"><h2>基金比较</h2><span class="code">选择 2~4 只基金</span></div><button class="modal-close" data-close>×</button></div>
    <div class="hold-form">
      <label class="field-label" for="cmpSearch">搜索基金（代码 / 名称）</label>
      <div class="input-wrap"><input id="cmpSearch" type="search" placeholder="例如 510300 / 华夏成长" autocomplete="off"><span>⌕</span></div>
      <div id="cmpSearchList" class="search-pop fund-search-pop" style="position:static;margin-top:6px"></div>
      <div class="compare-bar" style="margin-top:12px">
        <span class="muted small">已选 <b id="cmpPickCount">0</b> / 4</span>
        <div class="compare-chips" id="cmpPickChips"></div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn primary" id="cmpStart">开始对比</button>
      <button class="btn" data-close>取消</button>
    </div>
  </div>`);
  const listEl = $('#cmpSearchList');
  const renderPick = () => {
    if ($('#cmpPickCount')) $('#cmpPickCount').textContent = state.compareFunds.length;
    if ($('#cmpPickChips')) {
      $('#cmpPickChips').innerHTML = state.compareFunds
        .map((f) => `<span class="compare-chip">${esc(cleanName(f.name))}<button data-cmp-remove="${esc(f.code)}">×</button></span>`)
        .join('');
    }
    if ($('#cmpStart')) $('#cmpStart').disabled = state.compareFunds.length < 2;
  };
  const addPick = (item) => {
    if (!item || !item.code) return;
    if (state.compareFunds.some((f) => f.code === item.code)) {
      toast('这只基金已在对比列表里', 'warn', 1600);
      return;
    }
    if (state.compareFunds.length >= 4) {
      toast('最多选择 4 只基金进行对比', 'warn', 1800);
      return;
    }
    state.compareFunds.push({ code: String(item.code), name: item.name || item.code });
    renderPick();
  };
  const renderResults = (items) => {
    if (!listEl) return;
    if (!items || !items.length) {
      listEl.innerHTML = '<div class="empty small">输入基金代码或名称搜索</div>';
      return;
    }
    listEl.innerHTML = items.map((x) => `<div class="fund-search-item" data-cmp-add="${esc(x.code)}" data-cmp-name="${esc(cleanName(x.name))}">
      <div class="fs-main"><div class="fs-name">${esc(cleanName(x.name))}</div><div class="fs-code">${esc(x.code)}${x.ftype ? ` · ${esc(x.ftype)}` : ''}</div></div>
      <button class="fs-add" type="button">＋ 加入</button>
    </div>`).join('');
  };
  renderPick();
  renderResults([]);
  const input = $('#cmpSearch');
  const search = debounce(async () => {
    const q = input && input.value.trim();
    if (!q) { renderResults([]); return; }
    try {
      const data = await api(`/api/funds/search?q=${encodeURIComponent(q)}`, 20000);
      renderResults(data.items || []);
    } catch (err) {
      if (listEl) listEl.innerHTML = `<div class="empty small">搜索失败：${esc(err.message)}</div>`;
    }
  }, 320);
  if (input) input.addEventListener('input', search);
  listEl && listEl.addEventListener('click', (e) => {
    const row = e.target.closest('[data-cmp-add]');
    if (!row) return;
    addPick({ code: row.dataset.cmpAdd, name: row.dataset.cmpName });
  });
  $('#cmpPickChips') && $('#cmpPickChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmp-remove]');
    if (!btn) return;
    state.compareFunds = state.compareFunds.filter((f) => f.code !== btn.dataset.cmpRemove);
    renderPick();
  });
  $('#cmpStart') && $('#cmpStart').addEventListener('click', () => {
    if (state.compareFunds.length < 2) return;
    openFundCompare(state.compareFunds.map((f) => f.code));
  });
}

function openStockFund(code, name) {  if (!code) return;
  if (!routeOpening) pushDetailRoute('fund', code);
  mountOverlay(`
    <div class="modal">
      <div class="modal-head"><div class="modal-title"><h2>${esc(cleanName(name) || code)}</h2><span class="code">${esc(code)}</span></div><button class="modal-close" data-close>×</button></div>
      <div class="empty">正在加载基金情报…</div>
    </div>`);
  api(`/api/funds/stock-detail?code=${encodeURIComponent(code)}`).then((data) => {
    renderStockFundModal(data, name);
  }).catch((err) => {
    toast(`基金情报加载失败：{err.message}`, 'err');
    closeOverlay();
  });
}

function renderStockFundModal(data, fallbackName) {
  const overlay = $('.overlay');
  if (!overlay) return;
  const info = data.info || {};
  const basic = data.basic || {};
  const inWatch = state.fundWatchlist.some((f) => f.code === data.code);
  const estimate = isNum(info.estimate) ? info.estimate : null;
  const estimatePct = isNum(info.estimatePct) ? info.estimatePct : null;
  const name = basic.name || info.name || fallbackName || data.code;
  const holdings = data.positions || [];
  const holdingsHistory = data.holdingsHistory || [];
  const perfRows = [
    ['日涨幅', info.dayPct, 'day'],
    ['盘中估值', estimatePct, 'estimate'],
    ['夏普(1年3年', basic.sharpe1, 'ratio'],
    ['最大回撤', basic.maxDrawdown === null ? null : -Math.abs(basic.maxDrawdown), 'drawdown'],
  ];
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head">
      <div class="modal-title"><h2>${esc(cleanName(name))}</h2><span class="code">${esc(data.code)}</span><span class="fund-tag open">${esc(basic.ftype || '股票型')}</span></div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-price-row">
      <span class="modal-price ${toneClass(estimatePct ?? info.dayPct)}">${estimate !== null ? nf(estimate, 4) : nf(info.nav, 4)}</span>
      <span class="modal-chg ${toneClass(estimatePct ?? info.dayPct)}">${pctFmt(estimatePct ?? info.dayPct)}</span>
      <span class="badge">${estimate !== null ? '盘中估值' : '最新净值'}</span>
      <span class="badge">净值 ${nf(info.nav, 4)} · ${esc(info.date || '--')}</span>
    </div>
    <div class="modal-body-grid">
      <div>
        <div id="stockFundChart" style="height:330px"></div>
        <div class="panel-head" style="margin-top:10px"><div><h3>前十大重仓股</h3><span class="muted small">${basic.theme ? `主题：{esc(basic.theme)}` : ''}</span></div><span class="badge">${holdings.length} 只</span></div>
        <div class="table-scroll"><table class="holding-table">
          <thead><tr><th>股票</th><th>占净值</th><th>今日涨跌</th><th>较上期</th></tr></thead>
          <tbody>${holdings.map((h) => {
            const cls = h.changeType === '增持' || h.changeType === '新增' ? 'add' : h.changeType === '减持' ? 'cut' : 'flat';
            return `<tr>
              <td><span class="t-name">${esc(cleanName(h.name))}</span><span class="t-code">${esc(h.code)} · ${esc(h.industry || '')}</span></td>
              <td>${isNum(h.weight) ? `${nf(h.weight, 2)}%` : '--'}</td>
              <td class="${toneClass(h.pct)}">${pctFmt(h.pct)}</td>
              <td><span class="holding-change ${cls}">${esc(h.changeType || '--')}${isNum(h.change) && h.change !== 0 ? ` ${signedFmt(h.change, 2)}%` : ''}</span></td>
            </tr>`;
          }).join('') || '<tr><td colspan="4"><div class="empty">暂无重仓股数据</div></td></tr>'}</tbody>
        </table></div>
        <div class="panel-head" style="margin-top:12px"><div><h3>持仓变动历史</h3><span class="muted small">最近 ${Math.min(6, holdingsHistory.length)} 个季度</span></div><span class="badge">较上期</span></div>
        <div class="table-scroll"><table class="holding-history">
          <thead><tr><th>季度</th><th>前三大重仓</th><th>新进</th><th>退出</th><th>增持</th><th>减持</th></tr></thead>
          <tbody>${holdingsHistory.slice(0, 6).map((q) => {
            const c = q.changes || { new: [], exit: [], increase: [], decrease: [] };
            const top = (q.stocks || []).slice(0, 3).map((s) => `${s.name} ${isNum(s.weight) ? `${nf(s.weight, 2)}%` : ''}`).join('、');
            const title = (arr) => arr.map((s) => s.name).join('、');
            return `<tr>
              <td>${esc(q.quarter)}<span class="t-code">${esc(q.reportDate || '')}</span></td>
              <td class="hh-top" title="${esc(top)}">${esc(top || '--')}</td>
              <td><span class="hh-badge add" title="${esc(title(c.new))}">${c.new.length}</span></td>
              <td><span class="hh-badge cut" title="${esc(title(c.exit))}">${c.exit.length}</span></td>
              <td><span class="hh-badge add" title="${esc(title(c.increase))}">${c.increase.length}</span></td>
              <td><span class="hh-badge cut" title="${esc(title(c.decrease))}">${c.decrease.length}</span></td>
            </tr>`;
          }).join('') || '<tr><td colspan="6"><div class="empty">暂无历史持仓数据</div></td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="modal-side">
        <div class="fund-intel-estimate">
          <div class="fi-label">盘中估值/ 最新净值</div>
          <div class="fi-value ${toneClass(estimatePct ?? info.dayPct)}">${estimate !== null ? nf(estimate, 4) : nf(info.nav, 4)}</div>
          <div class="fi-sub">${estimate !== null ? `${esc(info.estimateTime || '--')} · 估值 ${pctFmt(estimatePct)}` : '非交易时段或估值未更新，展示最新净值'}</div>
        </div>
        <div class="perf-grid">
          ${perfRows.map(([label, val, kind]) => `<div class="perf-item"><span>${label}</span><b class="${kind === 'ratio' ? '' : toneClass(val)}">${kind === 'ratio' ? (isNum(val) ? nf(val, 2) : '--') : kind === 'drawdown' ? (isNum(val) ? pctFmt(val) : '--') : pctFmt(val)}</b></div>`).join('')}
        </div>
        <div class="manager-box">
          <div class="mb-row"><span>基金经理</span><b>${esc(basic.manager || '--')}</b></div>
          <div class="mb-row"><span>基金公司</span><b>${esc(basic.company || '--')}</b></div>
          <div class="mb-row"><span>成立日期</span><b>${esc(basic.establish || '--')}</b></div>
          <div class="mb-row"><span>基金规模</span><b>${isNum(basic.size) ? `${nf(basic.size / 1e8, 2)} 亿` : '--'}</b></div>
          <div class="mb-row"><span>风险等级</span><b>${esc(basic.risk || '--')} / 5</b></div>
          <div class="mb-row"><span>申购费率</span><b>${esc(basic.fee || '--')}</b></div>
          <div class="mb-row"><span>业绩基准</span><b title="${esc(basic.benchmark || '')}">${esc((basic.benchmark || '--').slice(0, 28))}</b></div>
        </div>
        <div class="modal-actions">
          <button class="btn primary" id="stockFundWatch" ${inWatch ? 'disabled' : ''}>${inWatch ? '已在自选' : '＋ 加入自选基金'}</button>
          <button class="btn" id="stockFundCompare">加入对比</button>
          <button class="btn" data-goto="funds" data-close>返回基金</button>
        </div>
        <p class="muted small">盘中估值为按持仓推算的参考值，正式净值以基金公司披露为准；重仓股数据来自最近一期定期报告，存在滞后。</p>
      </div>
    </div>
  </div>`;
  const history = (data.history || []).map((x) => ({ d: x.d, c: x.c, o: x.c, h: x.c, l: x.c, v: 0, pct: x.pct }));
  if (history.length) areaChart($('#stockFundChart'), history, (history.at(-1).c >= history[0].c) ? COLORS.up : COLORS.down);
  const btn = $('#stockFundWatch');
  if (btn) btn.addEventListener('click', () => {
    if (addFund({ code: data.code, name, type: 'open' })) {
      btn.textContent = '已在自选';
      btn.disabled = true;
    }
  });
  const cmp = $('#stockFundCompare');
  if (cmp) cmp.addEventListener('click', () => {
    toggleCompareFund(data.code, name, true);
    toast('已加入对比，返回基金排行继续选择', 'ok');
    closeOverlay();
    state.fundView = 'stock';
    renderFunds();
  });
}

/* ---------------------------------------------------------
   我的基金持仓（份额 + 成本净值，保存在本机 localStorage；
   参考养基宝 / 同花顺「我的基金」：按份额与成本算持有收益、当日盈亏。   --------------------------------------------------------- */

/**
 * 统一提交当前组合的持仓改动（v2.10.3）
 * ---------------------------------------------------------------
 * 逐只编辑与「持仓调整」批量编辑都走这里：只改内存里的组合 holdings，
 * 然后一次性落本机缓存 + 排队推送服务端。服务端在写入时会对比 before/after，
 * 把「之前持有、现在不持有」的条目存进后台的持仓回收站。
 */
function commitPortfolioHoldings(mutate) {
  if (!state.portfolios || !state.portfolios.length) settleActivePortfolio('default');
  const group = currentPortfolio();
  if (!group || typeof mutate !== 'function') return;
  const now = Date.now();
  const next = { ...(group.holdings || {}) };
  mutate(next, now);
  group.holdings = next;
  state.fundHoldings = next;
  saveJSON(PORTFOLIOS_KEY, state.portfolios);
  const main = findPortfolio('default');
  if (main) saveJSON(FUND_HOLD_KEY, main.holdings);
  const meta = portfolioMeta();
  meta.savedAt = now;
  meta.pending = true; // 服务端确认前先标成「未同步」
  savePortfolioMeta();
  renderFundSyncState();
  schedulePushSync();
  renderPortfolioTabs();
  renderFundHoldSummary();
  renderFundWatchTable();
  renderFundHoldTable();
  renderFundTopMovers();
  // v2.8.0：持仓变化后盈亏曲线要跟着变（份额变了但净值序列可以复用）
  loadFundPnl(true);
}

function saveFundHolding(code, shares, cost, addedAt) {
  const key = String(code);
  const group = currentPortfolio();
  const prev = group && group.holdings ? group.holdings[key] : null;
  let entry;
  if (!shares || shares <= 0) {
    // v2.9.2：删除写成「墓碑」（shares=0 + 时间戳）而不是直接消失，
    // 否则另一台设备合并时会把删掉的条目又带回来。渲染层会忽略 shares<=0 的条目。
    entry = { shares: 0, cost: 0, updatedAt: Date.now() };
  } else {
    const now = Date.now();
    entry = { shares: Number(shares), cost: Number(cost) || 0, updatedAt: now };
    // v2.10.0：建仓日只在第一次录入时写，后续改份额不重置；没记录时默认今天
    const wanted = Number(addedAt);
    const kept = Number(prev && prev.addedAt);
    entry.addedAt = Number.isFinite(wanted) && wanted > 0 ? wanted : (Number.isFinite(kept) && kept > 0 ? kept : now);
  }
  commitPortfolioHoldings((map) => { map[key] = entry; });
}

/** 批量保存（「持仓调整」面板）：只传改动过的行，未改动的保持原样 */
function savePortfolioHoldingsBatch(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return;
  commitPortfolioHoldings((map, now) => {
    for (const row of list) {
      const key = String(row && row.code ? row.code : '');
      if (!key) continue;
      const prev = map[key] || {};
      const shares = Number(row.shares);
      if (!Number.isFinite(shares) || shares <= 0) {
        if (Number(prev.shares) > 0) map[key] = { shares: 0, cost: 0, updatedAt: now };
        continue;
      }
      const entry = { shares, cost: Number(row.cost) || 0, updatedAt: now };
      const wanted = Number(row.addedAt);
      const kept = Number(prev.addedAt);
      entry.addedAt = Number.isFinite(wanted) && wanted > 0 ? wanted : (Number(kept) > 0 ? kept : now);
      map[key] = entry;
    }
  });
}

/** 删除一条持仓：本机写墓碑（0 份），服务端会保留原始份额/成本/建仓日到后台回收站 */
function deleteFundHolding(code, name) {
  const group = currentPortfolio();
  const held = group && group.holdings ? group.holdings[String(code)] : null;
  if (!held || !(Number(held.shares) > 0)) {
    toast('这条持仓已经不存在了', 'warn');
    return false;
  }
  const label = cleanName(name) || String(code);
  const sharesText = Number(held.shares).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const ok = window.confirm(`从「${group.name}」删除持仓「${label}」？\n当前份额 ${sharesText} 份。\n\n删除后后台会保留这条数据（份额 / 成本 / 建仓日），可在「后台 → 持仓数据 → 持仓回收站」恢复；自选基金本身不受影响。`);
  if (!ok) return false;
  saveFundHolding(code, 0, 0);
  toast('已删除，后台「持仓回收站」可恢复', 'ok', 2600);
  return true;
}





function openFundHoldEditor(code, name) {
  const cur = state.fundHoldings && state.fundHoldings[code] ? state.fundHoldings[code] : {};
  const addedAt = Number(cur.addedAt) > 0 ? new Date(Number(cur.addedAt)).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) : '';
  const group = currentPortfolio();
  mountOverlay(`<div class="modal modal-sm">
    <div class="modal-head"><div class="modal-title"><h2>${esc(cleanName(name) || code)}</h2><span class="code">${esc(code)} · 持仓录入</span></div><button class="modal-close" data-close>×</button></div>
    <div class="hold-form">
      <div class="muted small" style="margin-bottom:8px">录入到组合：<b>${esc(group ? group.name : '主持仓')}</b></div>
      <label class="field-label" for="holdShares">持有份额</label>
      <div class="input-wrap"><input id="holdShares" type="number" step="0.01" min="0" value="${cur.shares ? Number(cur.shares) : ''}" placeholder="例如 10000"><span>份</span></div>
      <label class="field-label" for="holdCost">成本净值（元）</label>
      <div class="input-wrap"><input id="holdCost" type="number" step="0.0001" min="0" value="${cur.cost ? Number(cur.cost) : ''}" placeholder="例如 1.2345"><span>元</span></div>
      <label class="field-label" for="holdAddedAt">建仓日期（盈亏从这天起算）</label>
      <div class="input-wrap"><input id="holdAddedAt" type="date" value="${addedAt}"><span>日</span></div>
      <div class="modal-actions" style="justify-content:flex-start;margin-top:6px">
        <button class="btn small" id="holdAddedToday">从今天起算</button>
        <span class="muted small" id="holdAddedHint">${addedAt ? `已记录：${esc(addedAt)}` : '未记录：盈亏统计会用全部可用净值历史'}</span>
      </div>
      <p class="muted small mt8">填 0 或清空份额即可删除该基金的持仓；成本净值留空时只算市值与当日盈亏。每份组合的持仓互不影响。</p>
    </div>
    <div class="modal-actions">
      <button class="btn primary" id="holdSave">保存</button>
      <button class="btn" data-close>取消</button>
    </div>
  </div>`);
  $('#holdAddedToday') && $('#holdAddedToday').addEventListener('click', () => {
    const input = $('#holdAddedAt');
    if (input) input.value = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const hint = $('#holdAddedHint');
    if (hint) hint.textContent = '已改为从今天起算';
  });
  const save = $('#holdSave');
  if (save) save.addEventListener('click', () => {
    const shares = Number($('#holdShares') && $('#holdShares').value);
    const cost = Number($('#holdCost') && $('#holdCost').value);
    const dateText = String(($('#holdAddedAt') && $('#holdAddedAt').value) || '').trim();
    const addedTs = /^\d{4}-\d{2}-\d{2}$/.test(dateText)
      ? new Date(`${dateText}T12:00:00+08:00`).getTime()
      : null;
    saveFundHolding(code, shares, cost, addedTs);
    closeOverlay();
    toast(shares > 0 ? '持仓已保存' : '已清除该基金持仓', 'ok', 1600);
  });
}


/* ---------------------------------------------------------
   跨设备同步：自选基金与持仓同时保存在服务端（data/push-config.json），
   手机第一次打开时本机没有数据，自动拉一份，保证和电脑看到的一致。  --------------------------------------------------------- */
function normalizePortfolioFunds(funds) {
  return (Array.isArray(funds) ? funds : [])
    .map((f) => ({
      code: String((f && f.code) || ''),
      name: String((f && f.name) || ''),
      type: (f && f.type) === 'etf' ? 'etf' : 'open',
    }))
    .filter((f) => f.code)
    .map((f) => ({ ...f, type: f.type || fundTypeOf(f.code, f.name) }));
}

function normalizePortfolioHoldings(holdings, { keepTombstones = false } = {}) {
  const out = {};
  if (!holdings || typeof holdings !== 'object') return out;
  for (const [code, v] of Object.entries(holdings)) {
    const shares = Number(v && v.shares);
    if (!code || !Number.isFinite(shares)) continue;
    // shares<=0 是删除墓碑：显示层要过滤掉，但合并/上推时必须留着，否则删除会丢
    if (shares <= 0 && !keepTombstones) continue;
    const entry = { shares: shares > 0 ? shares : 0, cost: Number(v && v.cost) || 0 };
    const stamp = Number(v && v.updatedAt);
    if (Number.isFinite(stamp) && stamp > 0) entry.updatedAt = stamp;
    if (shares <= 0) entry.removedAt = Number(v && v.removedAt) || entry.updatedAt || Date.now();
    out[String(code)] = entry;
  }
  return out;
}

function normalizePortfolioWatchlist(list) {
  return (Array.isArray(list) ? list : [])
    .map((w) => ({
      secid: String((w && w.secid) || ''),
      code: String((w && w.code) || ''),
      name: String((w && w.name) || ''),
    }))
    .filter((w) => w.secid);
}

/* ---------------------------------------------------------
   多份持仓组合（v2.10.0）
   ---------------------------------------------------------
   服务端 /api/portfolio 返回 portfolios（主持仓 + 额外组合）是唯一真源；
   本机 state.portfolios 是内存副本，localStorage 只做离线兜底。
   state.fundHoldings 始终是「当前选中组合」的持仓视图——views/funds.js 的
   渲染函数与「我的持仓」面板都读它，切组合就是换这份映射。
   --------------------------------------------------------- */
const PORTFOLIO_NAME_MAX = 20;
const PORTFOLIO_GROUPS_MAX = 12;

function publicGroupHoldings(map, { keepTombstones = false } = {}) {
  const out = {};
  for (const [code, v] of Object.entries(map || {})) {
    const shares = Number(v && v.shares);
    if (!code || !Number.isFinite(shares)) continue;
    if (shares <= 0 && !keepTombstones) continue;
    const entry = { shares: shares > 0 ? shares : 0, cost: Number(v && v.cost) || 0 };
    const stamp = Number(v && v.updatedAt);
    if (Number.isFinite(stamp) && stamp > 0) entry.updatedAt = stamp;
    const added = Number(v && v.addedAt);
    if (Number.isFinite(added) && added > 0) entry.addedAt = added;
    if (shares <= 0) entry.removedAt = Number(v && v.removedAt) || entry.updatedAt || Date.now();
    out[String(code)] = entry;
  }
  return out;
}

function normalizePortfolioGroups(list) {
  const out = [];
  const seen = new Set();
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || !g.id) continue;
    const id = String(g.id).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(g.name || '').slice(0, PORTFOLIO_NAME_MAX) || (id === 'default' ? '主持仓' : '未命名组合'),
      isDefault: Boolean(g.isDefault || id === 'default'),
      createdAt: Number(g.createdAt) || 0,
      updatedAt: Number(g.updatedAt) || 0,
      holdings: publicGroupHoldings(g.holdings, { keepTombstones: true }),
    });
  }
  if (!out.some((g) => g.isDefault)) {
    out.unshift({ id: 'default', name: '主持仓', isDefault: true, createdAt: 0, updatedAt: 0, holdings: {} });
  }
  // 主持仓永远排第一
  out.sort((a, b) => (a.isDefault === b.isDefault ? Number(a.createdAt || 0) - Number(b.createdAt || 0) : a.isDefault ? -1 : 1));
  return out.slice(0, PORTFOLIO_GROUPS_MAX);
}

function findPortfolio(id) {
  const list = state.portfolios || [];
  return list.find((g) => g.id === id) || list.find((g) => g.isDefault) || list[0] || null;
}

/** 切到某个组合：state.fundHoldings 换成该组合的持仓视图，并记住选择 */
function settleActivePortfolio(preferredId) {
  const list = normalizePortfolioGroups(state.portfolios && state.portfolios.length
    ? state.portfolios
    : [{ id: 'default', name: '主持仓', isDefault: true, holdings: state.fundHoldings || {} }]);
  state.portfolios = list;
  const wanted = String(preferredId || state.activePortfolioId || 'default');
  const picked = findPortfolio(wanted) || list[0];
  state.activePortfolioId = picked ? picked.id : 'default';
  state.fundHoldings = (picked && picked.holdings) || {};
  saveJSON(PORTFOLIOS_KEY, state.portfolios);
  saveJSON(ACTIVE_PORTFOLIO_KEY, state.activePortfolioId);
  // 旧代码（本地缓存 / 推送兜底）仍读 gp.fundHoldings.v1，让它保持「主持仓」这一份
  const main = findPortfolio('default');
  if (main) saveJSON(FUND_HOLD_KEY, main.holdings);
  return picked;
}

function currentPortfolio() {
  return findPortfolio(state.activePortfolioId);
}

function switchPortfolio(id) {
  const picked = settleActivePortfolio(id);
  if (!picked) return;
  refreshFundPanelsAfterPortfolioChange();
  toast(`已切换到「${picked.name}」`, 'ok', 1400);
}

async function portfolioGroupAction(action, { id = '', name = '' } = {}) {
  try {
    const res = await apiPost('/api/portfolio/groups', { action, id, name }, 20000);
    const list = normalizePortfolioGroups(res && res.portfolios);
    state.portfolios = list;
    if (action === 'create') {
      const created = list.find((g) => g.name === name) || list[list.length - 1];
      settleActivePortfolio(created ? created.id : state.activePortfolioId);
    } else if (action === 'delete' && !list.some((g) => g.id === state.activePortfolioId)) {
      settleActivePortfolio('default');
    } else {
      settleActivePortfolio(state.activePortfolioId);
    }
    const m = portfolioMeta();
    m.rev = Number(res && res.rev) || Date.now();
    m.savedAt = Date.now();
    m.pending = false;
    m.serverLabel = portfolioServerLabel();
    savePortfolioMeta();
    renderFundSyncState();
    refreshFundPanelsAfterPortfolioChange();
    return res;
  } catch (err) {
    toast(`${action === 'create' ? '新建' : action === 'rename' ? '重命名' : '删除'}组合失败：${err.message}`, 'err', 4200);
    throw err;
  }
}

function openPortfolioCreate() {
  mountOverlay(`<div class="modal modal-sm">
    <div class="modal-head"><div class="modal-title"><h2>新建持仓组合</h2><span class="code">与主持仓互不影响</span></div><button class="modal-close" data-close>×</button></div>
    <div class="hold-form">
      <label class="field-label" for="portfolioName">组合名称</label>
      <div class="input-wrap"><input id="portfolioName" type="text" maxlength="${PORTFOLIO_NAME_MAX}" placeholder="例如 结婚基金 / 父母养老"><span>名</span></div>
      <p class="muted small mt8">最多保存 ${PORTFOLIO_GROUPS_MAX} 份组合（含主持仓）；建仓日、盈亏统计都按组合分别记录。</p>
    </div>
    <div class="modal-actions">
      <button class="btn primary" id="portfolioCreateSave">创建</button>
      <button class="btn" data-close>取消</button>
    </div>
  </div>`);
  $('#portfolioCreateSave') && $('#portfolioCreateSave').addEventListener('click', async () => {
    const name = String(($('#portfolioName') && $('#portfolioName').value) || '').trim();
    if (!name) { toast('请填写组合名称', 'warn'); return; }
    try {
      await portfolioGroupAction('create', { name });
      closeOverlay();
      toast(`已创建组合「${name}」`, 'ok');
    } catch { /* 失败提示已在 portfolioGroupAction 里 */ }
  });
}

function openPortfolioRename() {
  const cur = currentPortfolio();
  if (!cur || cur.isDefault) { toast('主持仓不能改名', 'warn'); return; }
  mountOverlay(`<div class="modal modal-sm">
    <div class="modal-head"><div class="modal-title"><h2>重命名组合</h2><span class="code">${esc(cur.name)}</span></div><button class="modal-close" data-close>×</button></div>
    <div class="hold-form">
      <label class="field-label" for="portfolioRename">新名称</label>
      <div class="input-wrap"><input id="portfolioRename" type="text" maxlength="${PORTFOLIO_NAME_MAX}" value="${esc(cur.name)}"><span>名</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn primary" id="portfolioRenameSave">保存</button>
      <button class="btn" data-close>取消</button>
    </div>
  </div>`);
  $('#portfolioRenameSave') && $('#portfolioRenameSave').addEventListener('click', async () => {
    const name = String(($('#portfolioRename') && $('#portfolioRename').value) || '').trim();
    if (!name) { toast('请填写组合名称', 'warn'); return; }
    try {
      await portfolioGroupAction('rename', { id: cur.id, name });
      closeOverlay();
      toast('组合已改名', 'ok');
    } catch { /* 已提示 */ }
  });
}

async function deleteActivePortfolio() {
  const cur = currentPortfolio();
  if (!cur || cur.isDefault) { toast('主持仓不能删除', 'warn'); return; }
  const held = Object.values(cur.holdings || {}).filter((h) => h && Number(h.shares) > 0).length;
  const ok = window.confirm(`确定删除组合「${cur.name}」？\n该组合的 ${held} 条持仓会一起删除，且不可撤销（自选基金本身不受影响）。`);
  if (!ok) return;
  try {
    await portfolioGroupAction('delete', { id: cur.id });
    toast(`已删除组合「${cur.name}」`, 'ok');
  } catch { /* 已提示 */ }
}

/* ---------------------------------------------------------
   持仓调整（v2.10.3）
   ---------------------------------------------------------
   在同一个面板里改当前组合每只基金的份额 / 成本，不用逐只点「仓」。
   空着的自选基金也可以直接填份额补录；每行的「删除」立即生效，
   服务端留档，可在后台「持仓回收站」恢复。
   --------------------------------------------------------- */
function openPortfolioAdjust() {
  const group = currentPortfolio();
  if (!group) { toast('还没有可调整的持仓组合', 'warn'); return; }
  const holdings = group.holdings || {};
  const items = (state.fundWatchData && state.fundWatchData.items) || [];
  const itemByCode = new Map(items.map((x) => [String(x.code), x]));
  const watch = (state.fundWatchlist || []).slice();
  const watchByCode = new Map(watch.map((f) => [String(f.code), f]));
  const infoOf = (code, fallbackName, fallbackType) => {
    const w = watchByCode.get(code);
    const it = itemByCode.get(code);
    return {
      name: (w && w.name) || (it && it.name) || fallbackName || code,
      type: (w && w.type) || (it && it.type) || fallbackType || 'open',
      price: it && isNum(it.price) ? Number(it.price) : null,
    };
  };
  const heldRows = Object.entries(holdings)
    .filter(([, h]) => h && Number(h.shares) > 0)
    .map(([code, h]) => {
      const info = infoOf(code);
      const shares = Number(h.shares) || 0;
      return {
        code,
        name: info.name,
        type: info.type,
        shares,
        cost: Number(h.cost) || 0,
        value: info.price !== null ? info.price * shares : 0,
      };
    })
    .sort((a, b) => b.value - a.value);
  const heldCodes = new Set(heldRows.map((r) => r.code));
  const addRows = watch
    .filter((f) => f && f.code && !heldCodes.has(String(f.code)))
    .map((f) => ({ code: String(f.code), name: f.name || String(f.code), type: f.type || 'open', shares: 0, cost: 0, value: 0 }));
  const rows = [...heldRows, ...addRows];
  const totalValue = heldRows.reduce((sum, r) => sum + r.value, 0);
  mountOverlay(`<div class="modal modal-adjust">
    <div class="modal-head"><div class="modal-title"><h2>持仓调整</h2><span class="code">组合：${esc(group.name)} · ${heldRows.length} 只已持有</span></div><button class="modal-close" data-close>×</button></div>
    <div class="hold-form">
      <p class="muted small">直接改「新份额」再点保存，就会批量更新这个组合；份额填 0 等于清仓。点「删除」立即移除该条持仓，服务端会留档，可在后台「持仓数据 → 持仓回收站」恢复原份额 / 成本 / 建仓日。</p>
      <div class="table-scroll"><table class="table fund-hold-adjust-table">
        <thead><tr><th>基金</th><th>当前份额</th><th>新份额</th><th>成本净值</th><th>市值</th><th>操作</th></tr></thead>
        <tbody id="holdAdjustBody">${rows.map((r) => {
          const type = r.type === 'etf' ? 'etf' : 'open';
          return `<tr data-adjust-code="${esc(r.code)}" data-prev-shares="${r.shares}" data-prev-cost="${r.cost}">
            <td><span class="t-name">${esc(cleanName(r.name) || r.code)}</span><span class="t-code">${esc(r.code)} · <span class="fund-tag ${type}">${type === 'etf' ? 'ETF' : '场外'}</span></span></td>
            <td class="t-dim">${r.shares > 0 ? `${nf(r.shares, 2)} 份` : '<span class="muted">未持有</span>'}</td>
            <td><input class="hold-adjust-input" data-adjust-shares type="number" step="0.01" min="0" value="${r.shares > 0 ? r.shares : ''}" placeholder="0"></td>
            <td><input class="hold-adjust-input" data-adjust-cost type="number" step="0.0001" min="0" value="${r.cost > 0 ? r.cost : ''}" placeholder="成本净值"></td>
            <td class="t-price">${r.value > 0 ? nf(r.value, 2) : '<span class="muted">--</span>'}</td>
            <td>${r.shares > 0
              ? `<button type="button" class="btn small danger" data-adjust-delete="${esc(r.code)}" data-adjust-name="${esc(cleanName(r.name) || r.code)}">删除</button>`
              : '<span class="muted small">--</span>'}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="6"><div class="empty">这个组合还没有持仓，自选基金也还没加入。</div></td></tr>'}</tbody>
      </table></div>
      <p class="muted small mt8">${totalValue > 0 ? `按最新价估算，当前组合市值 ${nf(totalValue, 2)} 元；` : ''}份额为 0 的行保存后会清仓（等同于删除，后台同样留档）。</p>
    </div>
    <div class="modal-actions">
      <button class="btn primary" id="holdAdjustSave">保存全部</button>
      <button class="btn" data-close>取消</button>
    </div>
  </div>`);

  const body = $('#holdAdjustBody');
  if (body) {
    body.addEventListener('click', (e) => {
      const del = e.target.closest('[data-adjust-delete]');
      if (!del) return;
      e.preventDefault();
      e.stopPropagation();
      const tr = del.closest('tr');
      const code = del.dataset.adjustDelete;
      const name = del.dataset.adjustName || code;
      const prevShares = Number(tr && tr.dataset.prevShares) || 0;
      if (!(prevShares > 0)) return;
      const ok = window.confirm(`删除「${name}」的持仓（${prevShares.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 份）？\n后台会保留原数据，可在「后台 → 持仓数据 → 持仓回收站」恢复。`);
      if (!ok) return;
      if (!deleteFundHolding(code, name)) return;
      // 面板不重建，避免丢掉其它行还没保存的输入；这一行就地变成「已删除」
      if (tr) {
        tr.dataset.deleted = '1';
        tr.classList.add('is-deleted');
        const sharesInput = tr.querySelector('[data-adjust-shares]');
        const costInput = tr.querySelector('[data-adjust-cost]');
        if (sharesInput) { sharesInput.value = ''; sharesInput.disabled = true; }
        if (costInput) { costInput.value = ''; costInput.disabled = true; }
        const curCell = tr.children[1];
        if (curCell) curCell.innerHTML = '<span class="muted">已删除</span>';
        del.disabled = true;
        del.textContent = '已删除';
        del.className = 'btn small';
      }
    });
  }

  const save = $('#holdAdjustSave');
  if (save) save.addEventListener('click', () => {
    const trs = body ? [...body.querySelectorAll('tr[data-adjust-code]')] : [];
    const changed = [];
    for (const tr of trs) {
      if (tr.dataset.deleted === '1') continue;
      const sharesInput = tr.querySelector('[data-adjust-shares]');
      const costInput = tr.querySelector('[data-adjust-cost]');
      const sharesRaw = String((sharesInput && sharesInput.value) || '').trim();
      const costRaw = String((costInput && costInput.value) || '').trim();
      if (!sharesRaw && !costRaw) continue;
      const shares = Number(sharesRaw || 0);
      const cost = Number(costRaw || 0);
      if (!Number.isFinite(shares) || shares < 0) { toast('份额要填 0 或正数', 'warn'); return; }
      if (!Number.isFinite(cost) || cost < 0) { toast('成本净值要填 0 或正数', 'warn'); return; }
      const prevShares = Number(tr.dataset.prevShares) || 0;
      const prevCost = Number(tr.dataset.prevCost) || 0;
      if (shares === prevShares && Math.abs(cost - prevCost) < 1e-9) continue;
      changed.push({ code: tr.dataset.adjustCode, shares, cost });
    }
    if (!changed.length) { closeOverlay(); toast('没有改动', 'info'); return; }
    const adds = changed.filter((r) => r.shares > 0).length;
    const removes = changed.filter((r) => r.shares <= 0).length;
    savePortfolioHoldingsBatch(changed);
    closeOverlay();
    toast(`持仓已更新：${adds} 项设置份额${removes ? `，${removes} 项清仓` : ''}`, 'ok', 2600);
  });
}


/* ---------------------------------------------------------
   持仓同步状态（v2.9.2）
   ---------------------------------------------------------
   背景：2026-11-19 在另一台设备/线上改过的持仓，本机完全不知道；
   同步失败又是静默吞掉的，用户只能看到「昨天改的今天回滚了」。
   现在：服务端是唯一真源，本机只做缓存 + 未同步兜底，并且把
   「哪台服务器、最后保存于何时、有没有未同步改动」直接显示出来。
   --------------------------------------------------------- */
function portfolioMeta() {
  if (!state.portfolioMeta || typeof state.portfolioMeta !== 'object') {
    state.portfolioMeta = { rev: 0, savedAt: 0, pending: false, serverLabel: '' };
  }
  return state.portfolioMeta;
}

function loadPortfolioMetaFromStore() {
  const raw = loadJSON(PORTFOLIO_META_KEY, null);
  const m = raw && typeof raw === 'object' ? raw : {};
  state.portfolioMeta = {
    rev: Number(m.rev) || 0,
    savedAt: Number(m.savedAt) || 0,
    pending: Boolean(m.pending),
    serverLabel: String(m.serverLabel || ''),
  };
  return state.portfolioMeta;
}

function savePortfolioMeta() {
  saveJSON(PORTFOLIO_META_KEY, portfolioMeta());
}

function portfolioServerLabel() {
  return String(location.host || '本机');
}

function readPortfolioPending() {
  const raw = loadJSON(PORTFOLIO_PENDING_KEY, null);
  return raw && typeof raw === 'object' ? raw : null;
}

function writePortfolioPending(snap) {
  if (snap) saveJSON(PORTFOLIO_PENDING_KEY, snap);
  else {
    try { localStorage.removeItem(scopedKey(PORTFOLIO_PENDING_KEY)); } catch { /* 忽略 */ }
  }
}

function fmtPortfolioTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '--';
  return new Date(n).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 自选列表求并集（服务端顺序在前，本机独有的追加在后） */
function unionPortfolioList(a, b, key) {
  const out = [];
  const seen = new Set();
  for (const item of [...(a || []), ...(b || [])]) {
    const k = String((item && item[key]) || '');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function refreshFundPanelsAfterPortfolioChange() {
  state.fundWatchData = null;
  renderWatchTable();
  renderDashWatch();
  renderFundwatchPanels();
  loadFundWatch();
  loadFundPnl(true);
  loadWatchData(true).catch(() => {});
}

/**
 * 把服务端返回的持仓应用到本机。
 * mode='server'：服务端为准（普通启动）
 * mode='merge'：保留本机更新过的持仓条目与自选（本机有未同步改动时）
 */
function adoptPortfolioFromServer(data, { mode = 'server' } = {}) {
  const serverFunds = normalizePortfolioFunds(data && data.funds);
  const serverWatch = normalizePortfolioWatchlist(data && data.watchlist);
  const rev = Number((data && (data.rev || data.updatedAt)) || 0) || Date.now();
  // v2.10.0：优先用服务端的 portfolios；老服务端只给 holdings 时，把它当成「主持仓」一份
  const serverGroups = Array.isArray(data && data.portfolios) && data.portfolios.length
    ? normalizePortfolioGroups(data.portfolios)
    : normalizePortfolioGroups([{
      id: 'default',
      name: '主持仓',
      isDefault: true,
      holdings: normalizePortfolioHoldings(data && data.holdings, { keepTombstones: true }),
    }]);
  let groups = serverGroups;
  if (mode === 'merge') {
    const localById = new Map((state.portfolios || []).map((g) => [g.id, g]));
    groups = serverGroups.map((sg) => {
      const lg = localById.get(sg.id);
      if (!lg) return sg;
      const merged = {};
      for (const [code, h] of Object.entries(sg.holdings || {})) merged[code] = { ...h, updatedAt: rev };
      for (const [code, h] of Object.entries(lg.holdings || {})) {
        const cur = merged[code];
        if (!cur || (Number(h && h.updatedAt) || 0) >= (Number(cur.updatedAt) || 0)) merged[code] = h;
      }
      // 墓碑要保留到上推完成之后（渲染层会自动忽略 shares<=0）
      return { ...sg, holdings: normalizePortfolioHoldings(merged, { keepTombstones: true }) };
    });
    for (const lg of state.portfolios || []) {
      if (!lg.isDefault && !groups.some((g) => g.id === lg.id)) groups.push(lg);
    }
    state.fundWatchlist = unionPortfolioList(serverFunds, state.fundWatchlist, 'code');
    state.watchlist = unionPortfolioList(serverWatch, state.watchlist, 'secid');
  } else {
    state.fundWatchlist = serverFunds;
    state.watchlist = serverWatch;
  }
  state.portfolios = groups;
  settleActivePortfolio(state.activePortfolioId);
  saveJSON(FUND_WATCH_KEY, state.fundWatchlist);
  saveJSON(WATCH_KEY, state.watchlist);
  const meta = portfolioMeta();
  meta.rev = rev;
  meta.savedAt = Date.now();
  meta.pending = false;
  meta.serverLabel = portfolioServerLabel();
  savePortfolioMeta();
  writePortfolioPending(null);
  renderFundSyncState();
  refreshFundPanelsAfterPortfolioChange();
}

/** 「已同步 21:03:12 · 数据源 127.0.0.1:8090」/「未同步」标识（我的持仓面板） */
function renderFundSyncState(errMessage = '') {
  const el = $('#fundSyncState');
  if (!el) return;
  const meta = portfolioMeta();
  const at = meta.savedAt ? new Date(meta.savedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--';
  if (meta.pending) {
    el.className = 'badge tone-down';
    el.textContent = `本机已保存 ${at} · 未同步`;
    el.title = `同步失败${errMessage ? `：${errMessage}` : ''}；改动已留在本机，点这里立即重试`;
    el.style.cursor = 'pointer';
    el.onclick = () => syncPushWatchlist();
  } else {
    el.className = 'badge';
    el.textContent = `已同步 ${at} · 数据源 ${meta.serverLabel || portfolioServerLabel()}`;
    el.title = '持仓以服务端为准：换设备/换浏览器打开会自动恢复；线上与本机是两套数据，可在后台做「持仓数据互通」';
    el.style.cursor = '';
    el.onclick = null;
  }
}

/** 手动「从服务端恢复」：本机有未同步改动时二次确认 */
async function adoptServerPortfolio({ silent = false } = {}) {
  const data = await api('/api/portfolio', 20000);
  const hasData = (data && data.funds && data.funds.length)
    || (data && data.holdings && Object.keys(data.holdings).length)
    || (data && Array.isArray(data.portfolios) && data.portfolios.some((g) => Object.keys((g && g.holdings) || {}).length))
    || (data && data.watchlist && data.watchlist.length);
  if (!hasData) {
    if (!silent) toast('服务端还没有这个账号的数据：先在本机操作一次，数据会自动同步上去', 'warn', 4200);
    return false;
  }
  adoptPortfolioFromServer(data, { mode: 'server' });
  if (!silent) {
    toast(`已从服务端恢复（保存于 ${fmtPortfolioTime(Number(data.rev || data.updatedAt) || 0)}）`, 'ok', 3600);
  }
  return true;
}

/**
 * 启动时对齐（替代原来的「只有新设备才拉服务端」）：
 *  - 服务端没有数据 → 把本机推上去
 *  - 本机有未同步改动 / 本机保存时间比服务端新 → 合并后上推
 *  - 否则以服务端为准（昨天在另一台设备/线上改的持仓会在这里被拉回来）
 */
async function reconcilePortfolioOnBoot() {
  loadPortfolioMetaFromStore();
  let data = null;
  try {
    data = await api('/api/portfolio', 20000);
  } catch {
    // 服务没起来（例如刚开机还没启动）：先用本机缓存，失败不阻塞页面
    renderFundSyncState('读取服务端失败');
    return false;
  }
  const meta = portfolioMeta();
  const serverRev = Number((data && (data.rev || data.updatedAt)) || 0);
  const serverHas = (data.funds || []).length || Object.keys(data.holdings || {}).length || (data.watchlist || []).length;
  const localHas = state.fundWatchlist.length || Object.keys(state.fundHoldings || {}).length || state.watchlist.length;
  const pending = readPortfolioPending();
  if (!serverHas) {
    if (localHas) await syncPushWatchlist();
    else renderFundSyncState();
    return true;
  }
  const localNewer = Number(meta.savedAt) > serverRev + 1000;
  if (pending || meta.pending || localNewer) {
    // 上次同步失败的快照可能比 localStorage 还新（换浏览器/清了缓存），先并回内存再合并上推
    if (pending) {
      if (Array.isArray(pending.funds)) state.fundWatchlist = normalizePortfolioFunds(pending.funds);
      if (Array.isArray(pending.watchlist)) state.watchlist = normalizePortfolioWatchlist(pending.watchlist);
      if (Array.isArray(pending.portfolios)) state.portfolios = normalizePortfolioGroups(pending.portfolios);
      if (pending.holdings) {
        const main = findPortfolio('default');
        if (main) main.holdings = publicGroupHoldings(pending.holdings, { keepTombstones: true });
      }
      settleActivePortfolio(state.activePortfolioId);
    }
    adoptPortfolioFromServer(data, { mode: 'merge' });
    const ok = await syncPushWatchlist();
    if (ok && (pending || localNewer)) toast('本机有未同步的持仓改动，已合并到服务端', 'ok', 4200);
    return true;
  }
  const serverNewer = !meta.rev || Math.abs(serverRev - Number(meta.rev)) > 1;
  adoptPortfolioFromServer(data, { mode: 'server' });
  if (serverNewer && meta.rev) {
    toast(`已从服务端载入最新持仓（保存于 ${fmtPortfolioTime(serverRev)}）`, 'ok', 4200);
  }
  return true;
}


/* v2.8.0：自选基金并入「自选基金」板块，只剩 renderFundWatchTable 一张表，
   原 renderWatchFunds（#watchFundList 精简表）已删除，避免两份实现漂移。 */

function addFund(item) {
  if (!item || !item.code) return false;
  if (state.fundWatchlist.some((f) => f.code === item.code)) {
    toast(`${cleanName(item.name) || item.code} 已在自选基金中`, 'warn');
    return false;
  }
  const type = item.type || fundTypeOf(item.code, item.name);
  state.fundWatchlist.push({ code: String(item.code), name: item.name || item.code, type });
  saveJSON(FUND_WATCH_KEY, state.fundWatchlist);
  schedulePushSync();
  toast(`已加入自选基金：${cleanName(item.name) || item.code}`, 'ok');
  // v2.8.0：自选基金已独立成板块，基金页不再有「自选基金」子页，
  // 添加后就地刷新（不强行切页），用户可点子页导航里的「自选基金 →」过去看。
  renderFunds();
  loadFundWatch(true);
  loadFundPnl(true);
  return true;
}

function removeFund(code) {
  const item = state.fundWatchlist.find((f) => f.code === code);
  state.fundWatchlist = state.fundWatchlist.filter((f) => f.code !== code);
  saveJSON(FUND_WATCH_KEY, state.fundWatchlist);
  schedulePushSync();
  toast(`已移除基金：${item ? cleanName(item.name) : code}`, 'info');
  loadFundWatch(true);
  loadFundPnl(true);
}

function moveFund(code, dir) {
  const i = state.fundWatchlist.findIndex((f) => f.code === code);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.fundWatchlist.length) return;
  [state.fundWatchlist[i], state.fundWatchlist[j]] = [state.fundWatchlist[j], state.fundWatchlist[i]];
  saveJSON(FUND_WATCH_KEY, state.fundWatchlist);
  schedulePushSync();
  state.watchFundSort = 'manual';
  if ($('#watchFundSort')) $('#watchFundSort').value = 'manual';
  renderFundWatchTable();
  if (state.fundPnl) renderFundPnl();
  toast('自选基金顺序已更新', 'ok', 1200);
}

function reorderFund(fromCode, toCode) {
  if (!fromCode || !toCode || fromCode === toCode) return;
  const from = state.fundWatchlist.findIndex((f) => f.code === fromCode);
  const to = state.fundWatchlist.findIndex((f) => f.code === toCode);
  if (from < 0 || to < 0) return;
  const [item] = state.fundWatchlist.splice(from, 1);
  state.fundWatchlist.splice(to, 0, item);
  state.watchFundSort = 'manual';
  if ($('#watchFundSort')) $('#watchFundSort').value = 'manual';
  saveJSON(FUND_WATCH_KEY, state.fundWatchlist);
  schedulePushSync();
  renderFundWatchTable();
  if (state.fundPnl) renderFundPnl();
  toast('自选基金顺序已更新', 'ok', 1200);
}

let fundDragEndedAt = 0;

function bindFundDrag(container) {
  if (!container || container.dataset.fundDragBound === '1') return;
  container.dataset.fundDragBound = '1';
  // 手机端长按拖拽（桌面端走下面的 HTML5 drag 事件）
  bindTouchReorder(container, '[data-drag-fund]', 'dragFund', (from, to) => reorderFund(from, to));
  let dragCode = null;
  container.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-drag-fund]');
    if (!row) return;
    dragCode = row.dataset.dragFund;
    row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragCode || '');
    }
  });
  container.addEventListener('dragover', (e) => {
    const row = e.target.closest('[data-drag-fund]');
    if (!row || !dragCode) return;
    e.preventDefault();
    $$('.fund-watch-table tr.drag-over', container).forEach((r) => r.classList.remove('drag-over'));
    if (row.dataset.dragFund !== dragCode) row.classList.add('drag-over');
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  container.addEventListener('dragleave', (e) => {
    const row = e.target.closest('[data-drag-fund]');
    if (row) row.classList.remove('drag-over');
  });
  container.addEventListener('drop', (e) => {
    const row = e.target.closest('[data-drag-fund]');
    if (!row) return;
    e.preventDefault();
    const target = row.dataset.dragFund;
    row.classList.remove('drag-over');
    const from = dragCode;
    dragCode = null;
    reorderFund(from, target);
  });
  container.addEventListener('dragend', () => {
    dragCode = null;
    fundDragEndedAt = Date.now();
    $$('tr.dragging, tr.drag-over', container).forEach((r) => r.classList.remove('dragging', 'drag-over'));
  });
}

async function openFund(code, name, type) {
  if (!code) return;
  if (!routeOpening) pushDetailRoute('fund', code);
  mountOverlay(`
    <div class="modal">
      <div class="modal-head"><div class="modal-title"><h2>${esc(cleanName(name) || code)}</h2><span class="code">${esc(code)}</span></div><button class="modal-close" data-close>×</button></div>
      <div class="empty">正在加载基金数据…</div>
    </div>`);
  try {
    const kind = type || fundTypeOf(code, name);
    if (kind === 'open') {
      openStockFund(code, name);
      return;
    }
    const data = await api(`/api/funds/detail?code=${encodeURIComponent(code)}&type=${kind}`);
    renderFundModal(data, name);
  } catch (err) {
    toast(`基金详情加载失败：{err.message}`, 'err');
    closeOverlay();
  }
}

function renderFundModal(data, fallbackName) {
  const overlay = $('.overlay');
  if (!overlay) return;
  const inWatch = state.fundWatchlist.some((f) => f.code === data.code);
  if (data.type === 'etf') {
    const q = data.quote || {};
    const flowLast = data.flow && isNum(data.flow.last) ? data.flow.last : null;
    overlay.innerHTML = `<div class="modal">
      <div class="modal-head">
        <div class="modal-title"><h2>${esc(cleanName(fallbackName || q.name) || data.code)}</h2><span class="code">${esc(data.code)} · ETF</span><span class="fund-tag etf">场内</span></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="modal-price-row">
        <span class="modal-price ${toneClass(q.pct)}">${priceFmt(q.price)}</span>
        <span class="modal-chg ${toneClass(q.pct)}">${pctFmt(q.pct)} ${signedFmt(q.change)}</span>
        <span class="badge">主力 ${yiFmt(q.mainYi)}</span>
        <span class="badge">成交额 ${isNum(q.amountYi) ? `${nf(q.amountYi, 1)} 亿` : '--'}</span>
      </div>
      <div class="fund-detail-grid">
        <div>
          <div id="fundKline" style="height:340px"></div>
          ${data.flow && data.flow.points && data.flow.points.length ? '<div class="modal-section-title">当日主力资金</div><div id="fundFlowChart" style="height:160px"></div>' : ''}
        </div>
        <div class="modal-side">
          <div class="snapshot-grid">
            <div class="snapshot-item"><span>今开</span><b>${priceFmt(q.open)}</b></div>
            <div class="snapshot-item"><span>昨收</span><b>${priceFmt(q.prevClose)}</b></div>
            <div class="snapshot-item"><span>最高</span><b class="tone-up">${priceFmt(q.high)}</b></div>
            <div class="snapshot-item"><span>最低</span><b class="tone-down">${priceFmt(q.low)}</b></div>
            <div class="snapshot-item"><span>主力净流入</span><b class="${toneClass(q.mainYi)}">${yiFmt(q.mainYi)}</b></div>
            <div class="snapshot-item"><span>净占比</span><b>${isNum(q.mainPct) ? `${nf(q.mainPct, 2)}%` : '--'}</b></div>
            <div class="snapshot-item"><span>成交额</span><b>${isNum(q.volume) ? `${nf(q.volume / 1e4, 0)} 万份` : '--'}</b></div>
            <div class="snapshot-item"><span>资金趋势</span><b class="${toneClass(flowLast)}">${flowLast === null ? '--' : yiFmt(flowLast)}</b></div>
          </div>
          <div class="modal-actions">
            <button class="btn primary" id="fundModalWatch" ${inWatch ? 'disabled' : ''}>${inWatch ? '已在自选' : '＋ 加入自选基金'}</button>
            <button class="btn" data-goto="funds" data-close>返回基金榜</button>
          </div>
          <p class="muted small">ETF 资金流按当日主力净流入统计，反映二级市场大单方向，不等同于基金申赎。历史业绩不代表未来收益。</p>
        </div>
      </div>
    </div>`;
    if (data.kline) candleChart($('#fundKline'), data.kline, { zoomStart: 25, indicator: currentIndicator() });
    if (data.flow && data.flow.points && data.flow.points.length) flowLine($('#fundFlowChart'), data.flow);
    const btn = $('#fundModalWatch');
    if (btn) btn.addEventListener('click', () => {
      if (addFund({ code: data.code, name: fallbackName || q.name, type: 'etf' })) {
        btn.textContent = '已在自选';
        btn.disabled = true;
      }
    });
    loadFundMetricsInto($('.overlay .modal'), data.code, 'etf');
    return;
  }

  const latest = data.latest || {};
  const history = (data.history || []).map((x) => ({ d: x.d, c: x.c, o: x.c, h: x.c, l: x.c, v: 0, pct: x.pct }));
  const est = isNum(latest.estimate) ? latest.estimate : null;
  const estPct = isNum(latest.estimatePct) ? latest.estimatePct : null;
  const displayPct = estPct ?? latest.pct;
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head">
      <div class="modal-title"><h2>${esc(cleanName(fallbackName) || data.code)}</h2><span class="code">${esc(data.code)} · 场外基金</span><span class="fund-tag open">净值</span></div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-price-row">
      <span class="modal-price ${toneClass(displayPct)}">${nf(est ?? latest.nav, 4)}</span>
      <span class="modal-chg ${toneClass(displayPct)}">${pctFmt(displayPct)}</span>
      <span class="badge">${est !== null ? '盘中估值' : '最新净值'}</span>
      <span class="badge">净值日期 ${esc(latest.date || '--')}</span>
      <span class="badge">累计净值 ${nf(latest.navAcc, 4)}</span>
    </div>
    <div class="fund-detail-grid">
      <div>
        <div id="fundNavChart" style="height:340px"></div>
        <p class="muted small mt8">场外基金无交易所实时价格，图为最近 120 个交易日的单位净值走势。</p>
      </div>
      <div class="modal-side">
        <div class="snapshot-grid">
          <div class="snapshot-item"><span>单位净值</span><b>${nf(latest.nav, 4)}</b></div>
          <div class="snapshot-item"><span>累计净值</span><b>${nf(latest.navAcc, 4)}</b></div>
          <div class="snapshot-item"><span>日涨跌</span><b class="${toneClass(latest.pct)}">${pctFmt(latest.pct)}</b></div>
          <div class="snapshot-item"><span>申购状态</span><b>${esc(latest.subscribe || '--')}</b></div>
          <div class="snapshot-item"><span>赎回状态</span><b>${esc(latest.redeem || '--')}</b></div>
          <div class="snapshot-item"><span>净值日期</span><b>${esc(latest.date || '--')}</b></div>
        </div>
        <div class="modal-actions">
          <button class="btn primary" id="fundModalWatch" ${inWatch ? 'disabled' : ''}>${inWatch ? '已在自选' : '＋ 加入自选基金'}</button>
          <button class="btn" data-goto="funds" data-close>返回基金榜</button>
        </div>
        <p class="muted small">场外基金按净值申赎，通常 T+1 更新；申购费、赎回费与持有期限会影响实际收益。</p>
      </div>
    </div>
  </div>`;
  if (history.length) areaChart($('#fundNavChart'), history, (history.at(-1).c >= history[0].c) ? COLORS.up : COLORS.down);
  const btn = $('#fundModalWatch');
  if (btn) btn.addEventListener('click', () => {
    if (addFund({ code: data.code, name: fallbackName, type: 'open' })) {
      btn.textContent = '已在自选';
      btn.disabled = true;
    }
  });
  loadFundMetricsInto($('.overlay .modal'), data.code, 'open');
}

/* ---------------------------------------------------------
   基金详情增强：阶段涨幅 / 同类排名 / 风险指标 / 档案 / 重仓结构
   --------------------------------------------------------- */
function loadFundMetricsInto(root, code, type) {
  if (!root) return;
  const host = document.createElement('div');
  host.className = 'fund-metrics';
  host.innerHTML = '<div class="empty">正在加载阶段涨幅、同类排名与风险指标…</div>';
  root.appendChild(host);
  api(`/api/funds/metrics?code=${encodeURIComponent(code)}&type=${encodeURIComponent(type || 'open')}`, 45000)
    .then((m) => { if (host.isConnected) host.innerHTML = renderFundMetricsBlock(m); })
    .catch((err) => {
      if (host.isConnected) host.innerHTML = `<div class="empty">阶段涨幅加载失败：${esc(err.message)}</div>`;
    });
}

function renderFundMetricsBlock(m) {
  if (!m) return '<div class="empty">暂无数据</div>';
  const periods = Array.isArray(m.periods) ? m.periods.filter((p) => isNum(p.pct)) : [];
  const risk = m.risk || {};
  const profile = m.profile || {};
  const rows = periods.map((p) => `
    <tr>
      <td>${esc(p.label)}</td>
      <td class="${toneClass(p.pct)}">${p.pct > 0 ? '+' : ''}${Number(p.pct).toFixed(2)}%</td>
      <td class="${isNum(p.avg) ? toneClass(p.avg) : 'muted'}">${isNum(p.avg) ? `${p.avg > 0 ? '+' : ''}${Number(p.avg).toFixed(2)}%` : '--'}</td>
      <td class="${isNum(p.bench) ? toneClass(p.bench) : 'muted'}">${isNum(p.bench) ? `${p.bench > 0 ? '+' : ''}${Number(p.bench).toFixed(2)}%` : '--'}</td>
      <td>${isNum(p.rank) && isNum(p.total) ? `${p.rank} / ${p.total}<div class="t-sub">前 ${(100 - Number(p.percentile)).toFixed(0)}%</div>` : '--'}</td>
    </tr>`).join('');
  const riskCell = (label, value, unit) => `<div class="risk-item"><span>${label}</span><b>${isNum(value) ? `${Number(value).toFixed(2)}${unit || ''}` : '--'}</b></div>`;
  const holdings = Array.isArray(m.holdings) ? m.holdings : [];
  const mix = Array.isArray(m.industryMix) ? m.industryMix.slice(0, 6) : [];
  const mixTotal = mix.reduce((s, x) => s + (Number(x.pct) || 0), 0) || 1;
  return `
    <div class="fund-metrics-head">
      <h3>阶段涨幅 · 同类排名</h3>
      <span class="muted small">${esc(m.note || '天天基金口径')}</span>
    </div>
    ${rows ? `<div class="table-scroll"><table class="table fund-period-table">
      <thead><tr><th>区间</th><th>本基金</th><th>同类平均</th><th>沪深300</th><th>同类排名</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : '<div class="empty">暂无阶段涨幅数据</div>'}
    <div class="fund-risk-grid">
      ${riskCell('近1年夏普', risk.sharpe)}
      ${riskCell('最大回撤', risk.mdd, '%')}
      ${riskCell('年化波动', risk.vol, '%')}
      ${riskCell('近3年夏普', risk.sharpe3)}
      ${riskCell('近2年波动', risk.vol2, '%')}
      ${riskCell('近3年波动', risk.vol3, '%')}
    </div>
    <div class="fund-profile-grid">
      ${profile.type ? `<div><span>基金类型</span><b>${esc(profile.type)}</b></div>` : ''}
      ${profile.company ? `<div><span>基金公司</span><b>${esc(profile.company)}</b></div>` : ''}
      ${isNum(profile.sizeYi) ? `<div><span>资产规模</span><b>${nf(profile.sizeYi, 2)} 亿</b></div>` : ''}
      ${profile.estabDate ? `<div><span>成立日期</span><b>${esc(profile.estabDate)}</b></div>` : ''}
      ${profile.riskLevel ? `<div><span>风险等级</span><b>R${esc(profile.riskLevel)}</b></div>` : ''}
      ${profile.rate ? `<div><span>申购费</span><b>${esc(profile.rate)}${profile.sourceRate ? ` <small class="muted">原 ${esc(profile.sourceRate)}</small>` : ''}</b></div>` : ''}
      ${profile.minBuy ? `<div><span>起购金额</span><b>${esc(profile.minBuy)} 元</b></div>` : ''}
    </div>
    ${mix.length ? `<div class="fund-mix"><h4>重仓行业分布（前 6）</h4>
      ${mix.map((x) => `<div class="mix-row"><span>${esc(x.name)}</span><div class="mix-bar"><i style="width:${Math.max(3, Math.min(100, (Number(x.pct) / mixTotal) * 100))}%"></i></div><b>${nf(x.pct, 2)}%</b></div>`).join('')}
    </div>` : ''}
    ${holdings.length ? `<div class="fund-holdings"><h4>前十大重仓股</h4>
      <div class="table-scroll"><table class="table">
        <thead><tr><th>股票</th><th>占净值</th><th>行业</th><th>较上期</th></tr></thead>
        <tbody>${holdings.map((h) => `<tr>
          <td><span class="t-name">${esc(h.name)}</span><span class="t-code">${esc(h.code)}</span></td>
          <td class="t-price">${nf(h.pct, 2)}%</td>
          <td class="t-dim">${esc(h.industry || '--')}</td>
          <td class="${toneClass(h.chg)}">${esc(h.chgType || '--')}${isNum(h.chg) ? ` ${h.chg > 0 ? '+' : ''}${Number(h.chg).toFixed(2)}` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}`;
}

/* =========================================================
   基金搜索
   ========================================================= */
let fundSearchTimer = null;

async function runFundSearch(q, popEl) {
  const pop = popEl || $('#fundSearchPop');
  if (!pop) return;
  const query = String(q || '').trim();
  if (!query) { pop.hidden = true; pop.innerHTML = ''; return; }
  try {
    const data = await api(`/api/funds/search?q=${encodeURIComponent(query)}`, 10000);
    state.fundSearchItems = data.items || [];
    if (!state.fundSearchItems.length) {
      pop.hidden = false;
      pop.innerHTML = '<div class="search-empty">没有找到匹配的基金</div>';
      return;
    }
    pop.hidden = false;
    pop.innerHTML = state.fundSearchItems.map((x) => {
      const added = state.fundWatchlist.some((f) => f.code === x.code);
      return `<div class="fund-search-item" data-fund-code="${esc(x.code)}" data-fund-name="${esc(cleanName(x.name))}" data-fund-type="${esc(x.type)}">
        <div class="fs-main"><div class="fs-name">${esc(cleanName(x.name))}</div><div class="fs-code">${esc(x.code)} · <span class="fund-tag ${x.type}">${x.type === 'etf' ? 'ETF' : '场外'}</span> · ${esc(x.ftype || '')}</div></div>
        <button class="fs-add" data-fund-add="${esc(x.code)}" ${added ? 'disabled' : ''}>${added ? '已加' : '＋自选'}</button>
      </div>`;
    }).join('');
  } catch (err) {
    pop.hidden = false;
    pop.innerHTML = `<div class="search-empty">${esc(err.message)}</div>`;
  }
}

/* =========================================================
   基金搜索框绑定（v2.8.0：基金页与「自选基金」板块共用一套逻辑）
   ========================================================= */
function bindFundSearch(inputSel, popSel, btnSel) {
  const input = $(inputSel);
  const pop = $(popSel);
  if (!input || !pop) return;
  input.addEventListener('input', (e) => {
    clearTimeout(fundSearchTimer);
    fundSearchTimer = setTimeout(() => runFundSearch(e.target.value, pop), 240);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { pop.hidden = true; input.blur(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = state.fundSearchItems[0];
      if (first) {
        addFund(first);
        pop.hidden = true;
        input.value = '';
      } else {
        runFundSearch(input.value, pop);
      }
    }
  });
  input.addEventListener('focus', () => {
    if (input.value.trim()) runFundSearch(input.value, pop);
  });
  const btn = $(btnSel);
  if (btn) {
    btn.addEventListener('click', () => {
      if (!input.value.trim()) { toast('请输入基金代码或名称', 'warn'); return; }
      runFundSearch(input.value, pop);
    });
  }
  pop.addEventListener('click', (e) => {
    const add = e.target.closest('[data-fund-add]');
    if (add) {
      e.stopPropagation();
      const item = state.fundSearchItems.find((x) => x.code === add.dataset.fundAdd);
      if (item) {
        addFund(item);
        pop.hidden = true;
        input.value = '';
      }
      return;
    }
    const row = e.target.closest('[data-fund-code]');
    if (row) {
      e.stopPropagation();
      pop.hidden = true;
      openFund(row.dataset.fundCode, row.dataset.fundName, row.dataset.fundType);
    }
  });
}

/* =========================================================
   搜索
   ========================================================= */
let searchTimer = null;

async function runSearch(q) {
  q = String(q || '').trim();
  const pop = $('#searchPop');
  if (!pop) return;
  if (!q) { pop.hidden = true; pop.innerHTML = ''; return; }
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`, 9000);
    state.searchItems = (data.items || []).slice(0, 9);
    state.searchIndex = state.searchItems.length ? 0 : -1;
    renderSearchPop();
  } catch (err) {
    pop.hidden = false;
    pop.innerHTML = `<div class="search-empty">${esc(err.message)}</div>`;
  }
}

function renderSearchPop() {
  const pop = $('#searchPop');
  if (!pop) return;
  if (!state.searchItems.length) {
    pop.hidden = false;
    pop.innerHTML = '<div class="search-empty">没有找到匹配的A 股/ 指数</div>';
    return;
  }
  pop.hidden = false;
  pop.innerHTML = state.searchItems.map((item, i) => `
    <button class="search-item ${i === state.searchIndex ? 'is-active' : ''}" data-search-secid="${esc(item.secid)}" data-search-code="${esc(item.code)}" data-search-name="${esc(item.name)}">
      <span><span class="s-name">${esc(cleanName(item.name))}</span> <span class="s-code">${esc(item.code)}</span></span>
      <span class="s-type">${esc(item.type || '')}</span>
    </button>`).join('');
}

function chooseSearchItem(item) {
  if (!item) return;
  const pop = $('#searchPop');
  if (pop) pop.hidden = true;
  $('#searchInput').value = '';
  openStock(item.secid, item.code, item.name);
}

/* =========================================================
   个股详情弹窗
   ========================================================= */
async function openStock(secid, code, name) {
  if (!secid) return;
  state.stockModal = { secid, code: code || '', name: name || '' };
  // 路由化：把详情写进地址栏，支持复制分享与新标签直接打开
  if (!routeOpening) pushDetailRoute('stock', secid);
  const overlay = mountOverlay(`
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title"><h2>${esc(cleanName(name) || '加载中')}</h2><span class="code">${esc(code || secid)}</span></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="empty">正在加载行情与策略评分…</div>
    </div>`);
  try {
    const data = await api(`/api/stock?secid=${encodeURIComponent(secid)}&risk=${state.settings.risk}&fqt=${currentFqt()}`);
    if (!document.body.contains(overlay)) return;
    renderStockModal(data);
  } catch (err) {
    toast(`个股详情加载失败：${err.message}`, 'err');
    closeOverlay();
  }
}

/** 指标 / 复权切换后原地刷新个股详情（服务端按 fqt 缓存，重复调用代价很低） */
async function renderStockModalAgain() {
  const m = state.stockModal;
  if (!m || !$('.overlay')) return;
  try {
    const data = await api(`/api/stock?secid=${encodeURIComponent(m.secid)}&risk=${state.settings.risk}&fqt=${currentFqt()}`);
    if (!$('.overlay')) return;
    renderStockModal(data);
  } catch (err) {
    handleLoadError('个股详情', err);
  }
}

function renderStockModal(data) {
  const { quote: q, advice: a, kline } = data;
  const overlay = $('.overlay');
  if (!overlay) return;
  const inWatch = state.watchlist.some((w) => w.secid === q.secid);
  overlay.innerHTML = `<div class="modal modal-stock">
    <div class="modal-head">
      <div>
        <div class="modal-title"><h2>${esc(cleanName(q.name))}</h2><span class="code">${esc(q.code)} · ${esc(q.secid)}</span><span class="badge tone-${a.rating.tone}">${esc(a.rating.label)}</span></div>
        <div class="muted small mt8">${esc(q.industry || '')} ${q.market === 1 ? '· 沪市' : q.market === 0 ? '· 深市' : ''}</div>
      </div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-price-row">
      <span class="modal-price ${toneClass(q.pct)}">${stockFmt(q.price)}</span>
      <span class="modal-chg ${toneClass(q.pct)}">${pctFmt(q.pct)} ${signedFmt(q.change)}</span>
      <span class="badge">评分 ${a.score} / 100</span>
      <span class="badge">参考仓位 ${esc(a.position.text)}</span>
    </div>
    <div class="modal-kline-tools">
      <div class="seg seg-sm modal-ind-seg" title="K 线副图指标">
        ${INDICATOR_OPTIONS.map((o) => `<button data-ind="${o.key}" class="${currentIndicator() === o.key ? 'is-active' : ''}">${o.label}</button>`).join('')}
      </div>
      <div class="seg seg-sm modal-fqt-seg" title="复权口径">
        ${FQT_OPTIONS.map((o) => `<button data-fqt="${o.v}" class="${currentFqt() === o.v ? 'is-active' : ''}">${o.label}</button>`).join('')}
      </div>
      <span class="muted small">${esc(fqtHintText(kline))}</span>
    </div>
    <div class="modal-body-grid">
      <div>
        <div id="stockKline" class="modal-chart"></div>
        <div class="modal-kv">
          <div class="kv"><span>今开</span><b>${stockFmt(q.open)}</b></div>
          <div class="kv"><span>昨收</span><b>${stockFmt(q.prevClose)}</b></div>
          <div class="kv"><span>最高</span><b class="tone-up">${stockFmt(q.high)}</b></div>
          <div class="kv"><span>最低</span><b class="tone-down">${stockFmt(q.low)}</b></div>
          <div class="kv"><span>成交额</span><b>${compactAmount(q.amount)}</b></div>
          <div class="kv"><span>换手率</span><b>${isNum(q.turnover) ? `${nf(q.turnover, 2)}%` : '--'}</b></div>
          <div class="kv"><span>市盈率</span><b>${isNum(q.pe) ? nf(q.pe, 2) : '--'}</b></div>
          <div class="kv"><span>总市值</span><b>${isNum(q.mktCapYi) ? `${nf(q.mktCapYi, 0)} 亿` : '--'}</b></div>
          <div class="kv"><span>主力净流入</span><b class="${toneClass(q.mainYi)}">${yiFmt(q.mainYi)}</b></div>
          <div class="kv"><span>净流入占比</span><b class="${toneClass(q.mainPct)}">${isNum(q.mainPct) ? `${nf(q.mainPct, 2)}%` : '--'}</b></div>
        </div>
      </div>
      <div class="modal-side">
        <div class="modal-advice">
          <div class="ma-top"><span class="muted small">规则模型观点</span><span class="ma-score tone-${a.rating.tone}">${a.score}</span></div>
          <p>${esc(a.summary)}</p>
          <div class="modal-section-title">支撑 / 压力</div>
          <div class="snapshot-grid">
            <div class="snapshot-item"><span>支撑 S1</span><b>${priceFmt(a.levels.s1)}</b></div>
            <div class="snapshot-item"><span>压力 R1</span><b>${priceFmt(a.levels.r1)}</b></div>
            <div class="snapshot-item"><span>强支撑 S2</span><b>${priceFmt(a.levels.s2)}</b></div>
            <div class="snapshot-item"><span>强压力 R2</span><b>${priceFmt(a.levels.r2)}</b></div>
          </div>
          <div class="modal-section-title">评分依据</div>
          <div class="modal-reasons">${a.reasons.map((r) => `<div>${esc(r)}</div>`).join('') || '<div>暂无明显正向信号</div>'}</div>
          ${a.risks && a.risks.length ? `<div class="modal-section-title">风险提示</div><div class="modal-reasons">${a.risks.map((r) => `<div>${esc(r)}</div>`).join('')}</div>` : ''}
        </div>
        <div class="modal-actions">
          <button class="btn primary" id="modalWatch" ${inWatch ? 'disabled' : ''}>${inWatch ? '已加入自选' : '加入自选'}</button>
          <button class="btn" data-f10-open data-f10-secid="${esc(q.secid)}" data-f10-code="${esc(q.code)}" data-f10-name="${esc(q.name)}">基本面 / 龙虎榜</button>
          <button class="btn" data-news-open data-news-code="${esc(q.code)}" data-news-name="${esc(q.name)}">个股资讯</button>
          <button class="btn" data-strategy-new title="在新标签页打开大盘策略，个股详情保留">查看大盘策略 ↗</button>
        </div>
        <div class="modal-advice">
          <div class="muted small">条件预警</div>
          <div class="alert-form mt8">
            <select id="modalAlertKind" aria-label="预警类型">
              ${ALERT_KINDS.map((k) => `<option value="${k}">${ALERT_KIND_LABEL[k]}</option>`).join('')}
            </select>
            <div class="seg seg-sm" id="modalAlertOp">
              <button class="is-active" data-alert-op="above">↗ 突破</button>
              <button data-alert-op="below">↘ 跌破</button>
            </div>
          </div>
          <div class="alert-form mt8" id="modalAlertValueRow">
            <div class="input-wrap grow"><input id="modalAlertValue" type="number" step="0.01" value="${Number(q.price).toFixed(2)}"><span id="modalAlertUnit">元</span></div>
          </div>
          <button class="btn primary block mt8" id="modalAlertAdd">添加预警</button>
          <p class="muted small mt8">预警保存在本机浏览器，只在页面打开时监控；触发后会发浏览器通知（需授权）。云端推送见后台「定时推送」。</p>
        </div>
        <div class="disclaimer">${esc(a.disclaimer)}</div>
      </div>
    </div>
  </div>`;

  candleChart($('#stockKline'), kline, { zoomStart: 25, indicator: currentIndicator() });
  const watchBtn = $('#modalWatch');
  if (watchBtn) watchBtn.addEventListener('click', () => {
    if (addWatch({ secid: q.secid, code: q.code, name: q.name })) {
      watchBtn.textContent = '已加入自选';
      watchBtn.disabled = true;
    }
  });
  // 条件预警：类型决定操作符口径（突破/跌破 vs 金叉/死叉）与数值单位
  const alertKindEl = $('#modalAlertKind');
  const alertOpWrap = $('#modalAlertOp');
  const alertValueRow = $('#modalAlertValueRow');
  const alertValueEl = $('#modalAlertValue');
  const alertUnitEl = $('#modalAlertUnit');
  const alertDefaults = { price: Number(q.price) || 0, pct: 5, volume: 2, ma: 0, macd: 0 };
  const alertUnits = { price: '元', pct: '%', volume: '倍', ma: '', macd: '' };
  let alertOp = 'above';
  const syncAlertForm = () => {
    const kind = alertKindEl ? alertKindEl.value : 'price';
    const trend = isTrendAlert(kind);
    if (alertOpWrap) {
      alertOpWrap.innerHTML = trend
        ? '<button data-alert-op="golden" class="is-active">金叉</button><button data-alert-op="dead">死叉</button>'
        : '<button data-alert-op="above" class="is-active">↗ 突破</button><button data-alert-op="below">↘ 跌破</button>';
      alertOp = trend ? 'golden' : 'above';
      $$('#modalAlertOp button').forEach((b) => b.addEventListener('click', () => {
        alertOp = b.dataset.alertOp;
        $$('#modalAlertOp button').forEach((x) => x.classList.toggle('is-active', x === b));
      }));
    }
    if (alertValueRow) alertValueRow.hidden = trend;
    if (alertUnitEl) alertUnitEl.textContent = alertUnits[kind] || '';
    if (alertValueEl && !trend) alertValueEl.value = String(alertDefaults[kind] ?? 0);
  };
  if (alertKindEl) alertKindEl.addEventListener('change', syncAlertForm);
  syncAlertForm();
  const alertBtn = $('#modalAlertAdd');
  if (alertBtn) alertBtn.addEventListener('click', () => {
    const kind = alertKindEl ? alertKindEl.value : 'price';
    const trend = isTrendAlert(kind);
    const value = trend ? null : Number(alertValueEl ? alertValueEl.value : NaN);
    if (addAlert({ secid: q.secid, code: q.code, name: q.name, kind, op: alertOp, value })) {
      alertBtn.textContent = '预警已添加';
      setTimeout(() => { alertBtn.textContent = '添加预警'; }, 1800);
    }
  });
}

/* =========================================================
   板块详情抽屉
   ========================================================= */
async function openSector(code, name) {
  if (!routeOpening) pushDetailRoute('sector', code);
  mountOverlay(`
    <div class="drawer">
      <div class="drawer-head"><div><div class="eyebrow">SECTOR DETAIL</div><h2>${esc(name || code)}</h2><span class="code">${esc(code)}</span></div><button class="modal-close" data-close>×</button></div>
      <div class="empty">正在加载板块资金与成分股…</div>
    </div>`, 'drawer-overlay');
  try {
    // 新浪口径的板块代码是 new_xxx / gn_xxx，没有对应的东财板块资金与成分股。
    const emSector = /^BK\d+$/i.test(code);
    const [flowRes, consRes] = await Promise.allSettled(
      emSector
        ? [
            api(`/api/flow?secid=90.${encodeURIComponent(code)}`),
            api(`/api/sector/constituents?code=${encodeURIComponent(code)}`),
          ]
        : [
            Promise.reject(new Error('该板块来自新浪口径')),
            Promise.resolve({ items: [], unavailable: true }),
          ],
    );
    const flow = flowRes.status === 'fulfilled' ? flowRes.value : null;
    const cons = consRes.status === 'fulfilled' ? consRes.value : { items: [], unavailable: true };
    const quote = [...((state.sectors.industry && state.sectors.industry.items) || []), ...((state.sectors.concept && state.sectors.concept.items) || [])]
      .find((s) => s.code === code) || null;
    const drawer = $('.drawer');
    if (!drawer) return;
    const items = cons.items || [];
    const flowLast = flow && isNum(flow.last) ? flow.last : null;
    drawer.innerHTML = `
      <div class="drawer-head"><div><div class="eyebrow">SECTOR DETAIL</div><h2>${esc(name || (quote && quote.name) || code)}</h2><span class="code">${esc(code)}</span></div><button class="modal-close" data-close>×</button></div>
      ${quote ? `<div class="snapshot-hero">
        <div class="sn-name">${esc(quote.name)} <span class="code">${esc(quote.code)}</span></div>
        <div class="sn-price ${toneClass(quote.pct)}">${priceFmt(quote.price)}</div>
        <div class="sn-chg ${toneClass(quote.pct)}">${pctFmt(quote.pct)}</div>
      </div>
      <div class="snapshot-grid">
        <div class="snapshot-item"><span>主力净流入</span><b class="${toneClass(quote.main)}">${yiFmt(quote.main)}</b></div>
        <div class="snapshot-item"><span>净流入占比</span><b class="${toneClass(quote.mainPct)}">${isNum(quote.mainPct) ? `${nf(quote.mainPct, 2)}%` : '--'}</b></div>
        <div class="snapshot-item"><span>成交额</span><b>${isNum(quote.amountYi) ? `${nf(quote.amountYi, 1)} 亿` : '--'}</b></div>
        <div class="snapshot-item"><span>涨跌家数</span><b><span class="tone-up">${quote.up ?? '--'}</span> / <span class="tone-down">${quote.down ?? '--'}</span></b></div>
      </div>` : ''}
      ${!emSector ? '<div class="empty" style="margin:10px 0">该板块来自新浪口径，分时资金与成分股需切回东方财富后查看。</div>' : ''}
      <div class="panel-head"><div><h3>分时主力资金</h3><span class="muted small">当日累计 · 亿元</span></div><span class="badge ${flowLast !== null ? `tone-${toneOf(flowLast)}` : ''}">${flowLast === null ? '--' : yiFmt(flowLast)}</span></div>
      ${flow && flow.points && flow.points.length ? '<div id="sectorDrawerFlow" style="height:220px;margin-bottom:10px"></div>' : '<div class="empty" style="margin-bottom:10px">板块分时资金暂不可用</div>'}
      ${items.length ? `<div class="panel-head"><div><h3>成分股资金流 TOP</h3><span class="muted small">按主力净流入排序</span></div><span class="badge">${items.length} 只</span></div>
      <div class="table-scroll"><table class="table">
        <thead><tr><th>个股</th><th>最新</th><th>涨跌</th><th>主力净流入</th></tr></thead>
        <tbody>${items.map((q) => `<tr data-stock-secid="${esc(q.secid)}">
          <td><span class="t-name">${esc(cleanName(q.name))}</span><span class="t-code">${esc(q.code)}</span></td>
          <td class="t-price">${stockFmt(q.price)}</td>
          <td class="t-chg ${toneClass(q.pct)}">${pctFmt(q.pct)}</td>
          <td class="t-chg ${toneClass(q.mainYi)}">${yiFmt(q.mainYi)}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty">成分股明细接口暂时受限；<br><button class="text-link mt8" data-close data-goto="china">查看全市场个股资金榜 →</button></div>`}`;
    if (flow && flow.points && flow.points.length) flowLine($('#sectorDrawerFlow'), flow);
  } catch (err) {
    toast(`板块详情加载失败：{err.message}`, 'err');
    closeOverlay();
  }
}

/* =========================================================
   设置抽屉
   ========================================================= */
/* =========================================================
   数据源状态与切换
   ========================================================= */
const SOURCE_LABELS = { eastmoney: '东方财富', tencent: '腾讯行情', ths: '同花顺', sina: '新浪财经' };

function sourceLabelOf(key) {
  return SOURCE_LABELS[key] || key || '--';
}


async function loadSourceStatus(force = false) {
  if (!force && state.sourceStatus && Date.now() - state.sourceStatus.at < 15000) {
    renderSourceChip();
    return state.sourceStatus;
  }
  try {
    const data = await api('/api/source/status', 8000);
    state.sourceStatus = { ...data, at: Date.now() };
    renderSourceChip();
    renderSourceBanner();
    if ($('#sourceList')) renderSourcePanel();
  } catch {
    /* 旧版本服务端没有该接口时静默降级 */
  }
  return state.sourceStatus;
}

function sourceCap(key) {
  return ((state.sourceStatus && state.sourceStatus.capabilities) || []).find((c) => c.key === key) || null;
}

function renderSourceChip() {
  const st = state.sourceStatus;
  const chip = $('#sourceChip');
  if (!chip || !st) return;
  const degraded = st.degraded > 0;
  chip.classList.toggle('is-warn', degraded);
  const dot = $('#sourceChipDot');
  if (dot) dot.className = `dot ${degraded ? 'warn' : 'ok'}`;
  const text = $('#sourceChipText');
  if (text) text.textContent = degraded ? '备用数据源' : '数据源正常';
  const parts = (st.capabilities || [])
    .filter((c) => !c.builtin && c.active)
    .map((c) => `${c.label} ：${sourceLabelOf(c.active)}`);
  chip.title = parts.join('\n') || '查看数据源状态';
}

function renderSourceBanner() {
  const el = $('#sourceBanner');
  const st = state.sourceStatus;
  if (!el || !st) return;
  const dismissedAt = Number(sessionStorage.getItem('gp.sourceBannerDismissed') || 0);
  const fallbackCaps = (st.capabilities || []).filter(
    (c) => !c.builtin && c.active && c.providers[0] && c.active !== c.providers[0].key,
  );
  if (!fallbackCaps.length || Date.now() - dismissedAt < 3600000) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<span class="sb-dot"></span>
    <div class="sb-text">
      <strong>东方财富接口暂不可用，已自动切换到备用数据源</strong>
      <span>${fallbackCaps.map((c) => `${esc(c.label)} ：${esc(sourceLabelOf(c.active))}`).join(' · ')}。备用源不提供主力净流入等字段。</span>
    </div>
    <button class="btn small" data-source-open>查看数据源</button>
    <button class="sb-close" data-source-dismiss aria-label="关闭提示">×</button>`;
}

function renderSourcePanel() {
  const st = state.sourceStatus;
  const list = $('#sourceList');
  if (!st || !list) return;
  $$('#sourceModeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === st.mode));
  const strict = $('#sourceStrict');
  if (strict) strict.checked = Boolean(st.strict);
  const note = $('#sourceModeNote');
  if (note) {
    note.textContent = st.mode === 'auto'
      ? '自动容错：按「东方财富 → 腾讯 → 同花顺 → 新浪」依次尝试，失败自动切换，优先保证页面有数据'
      : `优先使用${sourceLabelOf(st.mode)}${st.strict ? '，已关闭回退：其它源不可用时直接报错' : '，不可用时自动切换其它源'}。`;
  }
  list.innerHTML = (st.capabilities || []).map((cap) => {
    const activeSt = (cap.providers || []).find((p) => p.key === cap.active) || {};
    const tone = cap.builtin
      ? 'builtin'
      : activeSt.state === 'ok'
        ? 'ok'
        : activeSt.state === 'fail'
          ? 'fail'
          : 'unknown';
    const detail = cap.builtin
      ? cap.note || '已内置多源回退'
      : `${cap.desc}${cap.active ? ` · 当前 ${sourceLabelOf(cap.active)}` : ''}${activeSt.state === 'fail' ? ` · ${activeSt.error || '失败'}` : ''}`;
    const select = cap.builtin
      ? '<span class="source-locked">内置</span>'
      : `<select data-source-cap="${cap.key}">
          <option value="auto" ${!cap.override ? 'selected' : ''}>自动</option>
          ${(cap.providers || [])
            .filter((p) => p.registered)
            .map((p) => `<option value="${p.key}" ${cap.override === p.key ? 'selected' : ''}>${esc(p.label)}</option>`)
            .join('')}
        </select>`;
    return `<div class="source-row">
      <div class="sr-main">
        <div class="sr-label"><i class="dot ${tone}"></i>${esc(cap.label)}${cap.builtin ? '<span class="tag-mini">内置多源</span>' : ''}</div>
        <div class="sr-sub">${esc(detail)}</div>
      </div>
      ${select}
    </div>`;
  }).join('');
  list.querySelectorAll('[data-source-cap]').forEach((sel) => {
    sel.addEventListener('change', () => updateSource({ cap: sel.dataset.sourceCap, provider: sel.value }));
  });
}

async function updateSource(patch) {
  try {
    const data = await apiPost('/api/source/config', patch);
    state.sourceStatus = { ...data.status, at: Date.now() };
    renderSourceChip();
    renderSourceBanner();
    renderSourcePanel();
    toast('数据源已更新，正在重新加载数据', 'ok');
    setTimeout(() => refreshAll(true), 400);
  } catch (err) {
    toast(`切换失败：${err.message}`, 'err');
  }
}

function bindSourceSettings() {
  const seg = $('#sourceModeSeg');
  if (seg) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (btn) updateSource({ mode: btn.dataset.mode });
    });
  }
  const strict = $('#sourceStrict');
  if (strict) strict.addEventListener('change', () => updateSource({ strict: strict.checked }));
  const probe = $('#sourceProbeBtn');
  if (probe) {
    probe.addEventListener('click', async () => {
      probe.disabled = true;
      probe.textContent = '检测中…';
      try {
        const data = await api('/api/source/probe', 90000);
        state.sourceStatus = { ...data.status, at: Date.now() };
        renderSourcePanel();
        renderSourceChip();
        renderSourceBanner();
        toast('数据源检测完成', 'ok');
      } catch (err) {
        toast(`检测失败：${err.message}`, 'err');
      } finally {
        probe.disabled = false;
        probe.textContent = '重新检测';
      }
    });
  }
  loadSourceStatus(true);
}

// 终端里只读展示数据源状态；切换入口已移到 /admin.html 后台管理。
async function openSourceStatus() {
  mountOverlay(`
    <div class="drawer">
      <div class="drawer-head"><div><div class="eyebrow">DATA SOURCE</div><h2>数据源状态</h2></div><button class="modal-close" data-close>×</button></div>
      <div class="source-list" id="sourceStatusList"><div class="empty">正在检测数据源…</div></div>
      <p class="setting-note">数据源的切换属于全局配置，已移到「后台管理 → 数据源」。普通用户在这里只能查看当前状态。</p>
      <div class="push-actions">
        ${state.auth && (state.auth.role === 'admin' || state.auth.role === 'super') ? '<a class="btn small primary" href="/admin.html" target="_blank" rel="noreferrer">打开后台管理</a>' : ''}
        <button class="btn small" id="sourceStatusReload">重新检测</button>
      </div>
    </div>`, 'drawer-overlay');
  const render = (st) => {
    const box = $('#sourceStatusList');
    if (!box || !st) return;
    box.innerHTML = (st.capabilities || []).map((cap) => {
      const active = (cap.providers || []).find((p) => p.key === cap.active) || {};
      const tone = cap.builtin ? 'builtin' : active.state === 'ok' ? 'ok' : active.state === 'fail' ? 'fail' : 'unknown';
      const detail = cap.builtin
        ? cap.note || '内置多源回退'
        : `${cap.desc || ''}${cap.active ? ` · 当前 ${sourceLabelOf(cap.active)}` : ''}${active.state === 'fail' ? ` · ${active.error || '失败'}` : ''}`;
      return `<div class="source-row">
        <div class="sr-main"><div class="sr-label"><i class="dot ${tone}"></i>${esc(cap.label)}${cap.builtin ? '<span class="tag-mini">内置多源</span>' : ''}</div><div class="sr-sub">${esc(detail)}</div></div>
      </div>`;
    }).join('') || '<div class="empty">暂无数据源信息</div>';
  };
  try {
    const st = await api('/api/source/status', 8000);
    render(st);
  } catch (err) {
    const box = $('#sourceStatusList');
    if (box) box.innerHTML = `<div class="empty">读取失败：${esc(err.message)}</div>`;
  }
  $('#sourceStatusReload') && $('#sourceStatusReload').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = '检测中…';
    try {
      const data = await api('/api/source/probe', 90000);
      render(data.status || data);
      toast('数据源检测完成', 'ok');
    } catch (err) {
      toast(`检测失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '重新检测';
    }
  });
}

/* ---------------------------------------------------------
   自选/持仓同步到服务端（推送配置与手机访问地址已移到后台管理 /admin.html）
   v2.9.2：带 baseRev 做冲突检测；失败不再静默——写 pending、显示「未同步」、自动重试三次。
   --------------------------------------------------------- */
let pushSyncTimer = null;
let pushSyncRetry = 0;

// 自选股票 + 自选基金 + 持仓统一同步到服务端（按账号隔离存储，换设备可恢复）。
async function syncPushWatchlist() {
  const meta = portfolioMeta();
  if (!state.portfolios || !state.portfolios.length) settleActivePortfolio('default');
  const groups = normalizePortfolioGroups(state.portfolios);
  const main = groups.find((g) => g.isDefault) || groups[0];
  const payload = {
    watchlist: state.watchlist.map((w) => ({ secid: w.secid, code: w.code, name: w.name })),
    funds: state.fundWatchlist.map((f) => ({ code: f.code, name: f.name, type: f.type })),
    // v2.10.0：holdings = 主持仓（服务端 push/审计仍按主持仓），portfolios = 额外组合
    holdings: publicGroupHoldings(main && main.holdings, { keepTombstones: true }),
    portfolios: groups
      .filter((g) => !g.isDefault)
      .map((g) => ({ id: g.id, name: g.name, holdings: publicGroupHoldings(g.holdings, { keepTombstones: true }) })),
    source: 'web',
    ...(meta.rev ? { baseRev: meta.rev } : {}),
  };
  try {
    const res = await apiPost('/api/portfolio', payload, 20000);
    if (res && res.conflict) {
      // 另一台设备刚改过自选：以服务端为底 + 保留本机条目，再用新 rev 重推一次
      const server = res.server ? { ...res.server, rev: res.rev } : await api('/api/portfolio', 20000);
      adoptPortfolioFromServer(server, { mode: 'merge' });
      portfolioMeta().pending = true;
      savePortfolioMeta();
      if (pushSyncRetry < 1) {
        pushSyncRetry += 1;
        const ok = await syncPushWatchlist();
        pushSyncRetry = 0;
        if (ok) return true;
      }
      toast('另一台设备刚改过自选，已载入最新数据', 'warn', 4200);
      return false;
    }
    const m = portfolioMeta();
    m.rev = Number(res && res.rev) || Date.now();
    m.savedAt = Date.now();
    m.pending = false;
    m.serverLabel = portfolioServerLabel();
    savePortfolioMeta();
    writePortfolioPending(null);
    pushSyncRetry = 0;
    // 服务端返回合并后的组合列表：用它回填，确保「另一台设备刚建的组合」也能马上看到
    if (res && Array.isArray(res.portfolios) && res.portfolios.length) {
      state.portfolios = normalizePortfolioGroups(res.portfolios);
      settleActivePortfolio(state.activePortfolioId);
      renderPortfolioTabs();
    }
    renderFundSyncState();
    return true;
  } catch (err) {
    const m = portfolioMeta();
    m.pending = true;
    m.savedAt = m.savedAt || Date.now();
    savePortfolioMeta();
    writePortfolioPending({
      at: Date.now(),
      funds: state.fundWatchlist,
      holdings: publicGroupHoldings(main && main.holdings, { keepTombstones: true }),
      portfolios: groups.filter((g) => !g.isDefault),
      watchlist: state.watchlist,
    });
    renderFundSyncState(err && err.message);
    if (pushSyncRetry < 3) {
      const wait = [5000, 15000, 45000][pushSyncRetry] || 45000;
      pushSyncRetry += 1;
      clearTimeout(pushSyncTimer);
      pushSyncTimer = setTimeout(() => { syncPushWatchlist(); }, wait);
    } else {
      pushSyncRetry = 0;
      toast(`持仓同步失败：${err.message}（已保存在本机，点面板上的「未同步」可重试）`, 'err', 6000);
    }
    return false;
  }
}

function schedulePushSync() {
  clearTimeout(pushSyncTimer);
  pushSyncTimer = setTimeout(() => { syncPushWatchlist(); }, 800);
}

// 顶栏账号菜单：账号信息、密码、数据源、后台、履历与退出登录（退出按钮从顶栏移入这里）。
async function logoutAccount() {
  const btn = $('#acctLogout');
  if (btn) { btn.disabled = true; btn.textContent = '退出中…'; }
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* 忽略网络异常，仍回登录页 */ }
  location.replace('/login.html');
}

function fmtAccountTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '--' : d.toLocaleString('zh-CN', { hour12: false });
}

function openAccount() {
  const u = state.auth;
  if (!u) { redirectToLogin(); return; }
  const isAdmin = u.role === 'admin' || u.role === 'super';
  const roleLabel = u.role === 'super' ? '超级管理员' : u.role === 'admin' ? '管理员' : '普通用户';
  mountOverlay(`
    <div class="drawer">
      <div class="drawer-head"><div><div class="eyebrow">ACCOUNT</div><h2>账号设置</h2></div><button class="modal-close" data-close>×</button></div>
      <div class="account-hero">
        <span class="account-avatar">${esc(String(u.username || '?').slice(0, 1).toUpperCase())}</span>
        <div class="account-hero-meta">
          <div class="ah-name">${esc(u.username)} <span class="badge tone-flat">${esc(roleLabel)}</span></div>
          <div class="ah-sub">账号 ID：${esc(u.id)}</div>
        </div>
      </div>
      <div class="setting-group">
        <h3>账号信息</h3>
        <div class="setting-row"><div><div class="sr-label">注册时间</div><div class="sr-sub">账号创建时间</div></div><b>${esc(fmtAccountTime(u.createdAt))}</b></div>
        <div class="setting-row"><div><div class="sr-label">最近登录</div><div class="sr-sub">上一次登录时间</div></div><b>${esc(fmtAccountTime(u.lastLoginAt))}</b></div>
        <div class="setting-row"><div><div class="sr-label">累计登录</div><div class="sr-sub">含当前会话</div></div><b>${Number(u.loginCount) || 0} 次</b></div>
      </div>
      <div class="setting-group">
        <h3>安全与管理</h3>
        <div class="setting-row"><div><div class="sr-label">修改密码</div><div class="sr-sub">修改后其它设备需要重新登录</div></div><button class="btn small" id="acctPassword">修改</button></div>
        <div class="setting-row"><div><div class="sr-label">数据源状态</div><div class="sr-sub">查看当前行情源与备用源</div></div><button class="btn small" id="acctSource">查看</button></div>
        <div class="setting-row" id="acctAdminRow" hidden><div><div class="sr-label">后台管理</div><div class="sr-sub">用户、登录记录、流量统计、推送与数据源</div></div><a class="btn small primary" href="/admin.html" target="_blank" rel="noreferrer">打开</a></div>
        <div class="setting-row"><div><div class="sr-label">更新履历</div><div class="sr-sub">查看每个版本改了什么</div></div><button class="btn small" id="acctChangelog">查看</button></div>
      </div>
      <div class="setting-group">
        <h3>会话</h3>
        <p class="setting-note">退出后当前设备立即回到登录页；其它设备的会话不受影响，只有修改密码才会让所有设备重新登录。</p>
        <button class="btn danger block" id="acctLogout">退出登录</button>
      </div>
    </div>`, 'drawer-overlay');
  const adminRow = $('#acctAdminRow');
  if (adminRow) adminRow.hidden = !isAdmin;
  $('#acctPassword') && $('#acctPassword').addEventListener('click', openPasswordModal);
  $('#acctSource') && $('#acctSource').addEventListener('click', () => { closeOverlay(); openSourceStatus(); });
  $('#acctChangelog') && $('#acctChangelog').addEventListener('click', () => { closeOverlay(); openChangelog(); });
  $('#acctLogout') && $('#acctLogout').addEventListener('click', logoutAccount);
}

function openSettings() {
  const s = state.settings;
  mountOverlay(`
    <div class="drawer">
      <div class="drawer-head"><div><div class="eyebrow">PREFERENCES</div><h2>偏好设置</h2></div><button class="modal-close" data-close>×</button></div>
      <div class="setting-group">
        <h3>刷新与风险</h3>
        <div class="setting-row"><div><div class="sr-label">自动刷新</div><div class="sr-sub">关闭后仅手动刷新</div></div><input type="checkbox" id="setAuto" ${s.autoRefresh ? 'checked' : ''}></div>
        <div class="setting-row"><div><div class="sr-label">刷新间隔</div><div class="sr-sub">行情轮询频率</div></div><select id="setInterval">
          ${[10, 15, 30, 60].map((v) => `<option value="${v}" ${Number(s.interval) === v ? 'selected' : ''}>${v} 个</option>`).join('')}
        </select></div>
        <div class="setting-row"><div><div class="sr-label">风险偏好</div><div class="sr-sub">影响参考仓位区间</div></div><select id="setRisk">
          <option value="conservative" ${s.risk === 'conservative' ? 'selected' : ''}>稳健</option>
          <option value="balanced" ${s.risk === 'balanced' ? 'selected' : ''}>均衡</option>
          <option value="aggressive" ${s.risk === 'aggressive' ? 'selected' : ''}>进取</option>
        </select></div>
        <div class="setting-row"><div><div class="sr-label">提示音</div><div class="sr-sub">预警触发时发声</div></div><input type="checkbox" id="setSound" ${s.sound ? 'checked' : ''}></div>
      </div>
      <div class="setting-group">
        <h3>通知</h3>
        <div class="setting-row"><div><div class="sr-label">浏览器通知</div><div class="sr-sub">价格预警触发时推送</div></div><button class="btn small" id="setNotify">${'Notification' in window && Notification.permission === 'granted' ? '已授权' : '申请授权'}</button></div>
        <p class="setting-note">浏览器通知需要 HTTPS 或 localhost 环境。本工具运行在本地端口，通常可以直接授权。</p>
      </div>
      <div class="setting-group">
        <h3>数据</h3>
        <div class="setting-row"><div><div class="sr-label">导出自选与预警</div><div class="sr-sub">JSON 格式，便于备份</div></div><button class="btn small" id="setExport">导出</button></div>
        <div class="setting-row"><div><div class="sr-label">清空本地数据</div><div class="sr-sub">自选、预警和设置全部重置</div></div><button class="btn small danger" id="setReset">重置</button></div>
      </div>
      <div class="setting-group">
        <h3>关于</h3>
        <p class="setting-note">寰球智投 v${APP_VERSION} · 数据来源：东方财富 / 腾讯 / 新浪公开行情接口。行情可能延迟、缺失或调整口径；本工具仅用于学习研究，不构成投资建议。<br>账号信息、修改密码与退出登录请点顶栏账号；行情数据源、微信定时推送、手机访问地址在「后台管理」。</p>
      </div>
    </div>`, 'drawer-overlay');

  $('#setAuto').addEventListener('change', (e) => {
    s.autoRefresh = e.target.checked;
    $('#autoRefresh').checked = s.autoRefresh;
    saveSettings();
    startTimers();
    toast(s.autoRefresh ? '已开启自动刷新' : '已关闭自动刷新', 'info');
  });
  $('#setInterval').addEventListener('change', (e) => {
    s.interval = Number(e.target.value);
    saveSettings();
    startTimers();
    toast(`刷新间隔已设为${s.interval} 秒`, 'ok');
  });
  $('#setRisk').addEventListener('change', (e) => {
    s.risk = e.target.value;
    saveSettings();
    syncRiskSeg();
    loadAdvice(true);
    loadWatchData(true);
    loadFundWatch(true);
    if (state.cnStock) loadChinaStock(true);
    toast('风险偏好已更新，正在重算策略', 'info');
  });
  $('#setSound').addEventListener('change', (e) => { s.sound = e.target.checked; saveSettings(); });
  $('#setNotify').addEventListener('click', async () => {
    const ok = await requestNotify();
    if (ok) $('#setNotify').textContent = '已授权';
  });
  $('#setExport').addEventListener('click', exportAll);
  $('#setReset').addEventListener('click', resetAll);
}

function openPasswordModal() {
  if (!state.auth) { toast('请先登录', 'warn'); return; }
  mountOverlay(`
    <div class="modal modal-sm">
      <div class="modal-head"><div class="modal-title"><h2>修改密码</h2><span class="code">${esc(state.auth.username)}</span></div><button class="modal-close" data-close>×</button></div>
      <form id="pwForm" class="pw-form" autocomplete="off">
        <label class="input-wrap"><span>原密码</span><input id="pwOld" type="password" maxlength="64" autocomplete="current-password" placeholder="当前密码"></label>
        <label class="input-wrap"><span>新密码</span><input id="pwNew" type="password" maxlength="64" autocomplete="new-password" placeholder="至少 6 位"></label>
        <label class="input-wrap"><span>确认新密码</span><input id="pwConfirm" type="password" maxlength="64" autocomplete="new-password" placeholder="再输入一次"></label>
        <p class="muted small">修改成功后，这台设备与其它已登录设备都需要用新密码重新登录。</p>
        <div class="modal-actions"><button class="btn primary" type="submit" id="pwSubmit">确认修改</button></div>
      </form>
    </div>`);
  const form = $('#pwForm');
  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const oldPassword = $('#pwOld').value;
    const newPassword = $('#pwNew').value;
    if (newPassword.length < 6) { toast('新密码至少 6 位', 'warn'); return; }
    if (newPassword !== $('#pwConfirm').value) { toast('两次输入的新密码不一致', 'warn'); return; }
    const btn = $('#pwSubmit');
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      await apiPost('/api/auth/password', { username: state.auth.username, oldPassword, newPassword });
      toast('密码已修改，请用新密码重新登录', 'ok', 5000);
      setTimeout(() => location.replace('/login.html?changed=1'), 900);
    } catch (err) {
      toast(`修改失败：${err.message}`, 'err');
      btn.disabled = false;
      btn.textContent = '确认修改';
    }
  });
}

function saveSettings() {
  saveJSON(SETTINGS_KEY, state.settings);
}

function syncRiskSeg() {
  $$('#riskSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.risk === state.settings.risk));
}

async function requestNotify() {
  if (!('Notification' in window)) { toast('当前浏览器不支持通知', 'warn'); return false; }
  if (Notification.permission === 'granted') { state.settings.notify = true; saveSettings(); renderAlerts(); return true; }
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      state.settings.notify = true;
      saveSettings();
      renderAlerts();
      toast('浏览器通知已开启', 'ok');
      return true;
    }
    toast('通知权限未授予，仍可在页面内看到预警', 'warn');
    return false;
  } catch {
    toast('通知授权失败，请检查浏览器设置', 'err');
    return false;
  }
}

function exportAll() {
  const data = {
    exportedAt: new Date().toISOString(),
    version: APP_VERSION,
    watchlist: state.watchlist,
    fundWatchlist: state.fundWatchlist,
    alerts: state.alerts,
    settings: state.settings,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `global-pulse-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出自选与预警', 'ok');
}

function resetAll() {
  if (!window.confirm('确定清空自选、预警和设置吗？此操作不可撤销')) return;
  localStorage.removeItem(scopedKey(WATCH_KEY));
  localStorage.removeItem(scopedKey(ALERTS_KEY));
  localStorage.removeItem(scopedKey(SETTINGS_KEY));
  localStorage.removeItem(scopedKey(FUND_WATCH_KEY));
  localStorage.removeItem(scopedKey(FUND_HOLD_KEY));
  localStorage.removeItem(scopedKey(MONITOR_SECTORS_KEY));
  state.watchlist = [...DEFAULT_WATCH];
  state.alerts = [];
  state.fundWatchlist = [...DEFAULT_FUNDS];
  state.fundWatchData = null;
  state.settings = { autoRefresh: true, interval: 15, sound: true, notify: false, risk: 'balanced' };
  toast('本地数据已重置', 'ok');
  setTimeout(() => window.location.reload(), 400);
}

/* =========================================================
   视图切换 / 加载
   ========================================================= */
function showView(view) {
  const known = ['dashboard', 'china', 'global', 'us', 'commodities', 'sectors', 'funds', 'data', 'strategy', 'fundwatch', 'stockwatch'];
  if (!known.includes(view)) view = 'dashboard';
  if (view !== 'strategy') stopTimeline();
  state.view = view;
  $$('.nav-tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('is-active', section.id === `view-${view}`));
  setTimeout(resizeCharts, 60);
  pingActivity('view');
  loadView(view);
}

function navigate(view) {
  if (state.view === view) { loadView(view); return; }
  pushViewRoute(view);
  showView(view);
}

/* =========================================================
   数据中心（阶段 2）
   ---------------------------------------------------------
   龙虎榜 / 限售解禁 / 分红送转 / 可转债 / 条件选股。
   这些都不是「每秒一变」的行情，而是研究复盘用的数据，所以统一按需加载 +
   切子页才拉取，不跟着自动刷新跑，避免无意义的上游请求。
   ========================================================= */

function switchDataTab(tab) {
  const known = ['longhu', 'calendar', 'cb', 'screener'];
  const next = known.includes(tab) ? tab : 'longhu';
  state.dataTab = next;
  $$('#dataTabSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.dataTab === next));
  $$('[data-data-pane]').forEach((p) => { p.hidden = p.dataset.dataPane !== next; });
  if (next === 'longhu' && !state.longhu) loadLonghu();
  if (next === 'calendar' && !state.calendar) loadCalendar(state.calendarType);
  if (next === 'cb' && !state.cb) loadConvertibles();
}

async function loadLonghu(force = false) {
  if (!force && state.longhu && state.longhuDate === '') { renderLonghu(); return; }
  const date = state.longhuDate;
  const key = `longhu:${date || 'latest'}`;
  if (!force && state.longhu && state.longhu._key === key) { renderLonghu(); return; }
  try {
    const data = await api(`/api/longhu?limit=60${date ? `&date=${encodeURIComponent(date)}` : ''}`, 30000);
    state.longhu = { ...data, _key: key };
    renderLonghu();
  } catch (err) {
    handleLoadError('龙虎榜', err);
    if ($('#longhuTable')) $('#longhuTable').innerHTML = `<tbody><tr><td><div class="empty">龙虎榜加载失败：${esc(err.message)}</div></td></tr></tbody>`;
  }
}

function renderLonghu() {
  const table = $('#longhuTable');
  if (!table) return;
  const d = state.longhu;
  if ($('#longhuMeta')) {
    $('#longhuMeta').textContent = d
      ? `${d.date} · ${d.count} 只 · 上榜净额合计 ${d.netTotalYi >= 0 ? '+' : ''}${nf(d.netTotalYi, 2)} 亿`
      : '--';
  }
  if (!d || !(d.items || []).length) {
    table.innerHTML = '<tbody><tr><td><div class="empty">该交易日暂无龙虎榜数据</div></td></tr></tbody>';
    return;
  }
  table.innerHTML = `<thead><tr>
    <th>股票</th><th>收盘</th><th>涨跌幅</th><th>换手</th><th>上榜净额</th><th>买入</th><th>卖出</th><th>成交占比</th><th>上榜原因</th>
  </tr></thead><tbody>${d.items.map((x) => `<tr data-stock-secid="${esc(x.secucode.startsWith('SH') ? '1.' : '0.')}${esc(x.code)}" title="查看该股详情">
    <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-sub">${esc(x.code)}</span></td>
    <td>${nf(x.close, 2)}</td>
    <td class="${toneClass(x.pct)}">${pctFmt(x.pct)}</td>
    <td>${nf(x.turnover, 2)}%</td>
    <td class="${toneClass(x.netYi)}">${x.netYi === null ? '--' : `${x.netYi >= 0 ? '+' : ''}${nf(x.netYi, 2)} 亿`}</td>
    <td>${nf(x.buyYi, 2)} 亿</td>
    <td>${nf(x.sellYi, 2)} 亿</td>
    <td>${nf(x.dealRatio, 1)}%</td>
    <td class="t-sub">${esc(x.reason)}${x.seatNote ? `<span class="t-sub"> · ${esc(x.seatNote)}</span>` : ''}</td>
  </tr>`).join('')}</tbody>`;
}

const CAL_TITLE = {
  lift: '限售解禁（今日及以后）',
  bonus: '分红送转（按公告日倒序）',
  ipo: '新股申购（今日及以后）',
  cbapply: '转债申购（今日及以后）',
};
const CAL_NAME = { lift: '限售解禁', bonus: '分红送转', ipo: '新股申购', cbapply: '转债申购' };

async function loadCalendar(type = 'lift') {
  const kind = CAL_TITLE[type] ? type : 'lift';
  state.calendarType = kind;
  $$('#calendarTypeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.calType === kind));
  if ($('#calendarTitle')) $('#calendarTitle').textContent = CAL_TITLE[kind];
  if ($('#calendarTable')) $('#calendarTable').innerHTML = '<tbody><tr><td><div class="empty">加载中…</div></td></tr></tbody>';
  try {
    const data = await api(`/api/calendar?type=${kind}&limit=40`, 30000);
    state.calendar = { ...data, type: kind };
    renderCalendar();
  } catch (err) {
    handleLoadError(CAL_NAME[kind], err);
    if ($('#calendarTable')) $('#calendarTable').innerHTML = `<tbody><tr><td><div class="empty">加载失败：${esc(err.message)}</div></td></tr></tbody>`;
  }
}

function renderCalendar() {
  const table = $('#calendarTable');
  const d = state.calendar;
  if (!table) return;
  if ($('#calendarMeta')) {
    $('#calendarMeta').textContent = d
      ? (d.type === 'bonus' ? `${d.count} 条 · 最新公告 ${(d.items[0] || {}).noticeDate || '--'}` : `${d.count} 条 · 自 ${d.since || '--'} 起`)
      : '--';
  }
  if ($('#calendarNote') && d && d.note) $('#calendarNote').textContent = d.note;
  if (!d || !(d.items || []).length) {
    const empty = d && d.type === 'ipo' ? '近期暂无新股申购' : d && d.type === 'cbapply' ? '近期暂无可转债申购' : '暂无数据';
    table.innerHTML = `<tbody><tr><td><div class="empty">${empty}</div></td></tr></tbody>`;
    return;
  }
  // 新股申购（v2.7.0）
  if (d.type === 'ipo') {
    table.className = 'table calendar-table calendar-ipo';
    table.innerHTML = `<thead><tr>
      <th>申购日</th><th>新股</th><th data-col="apply">申购代码</th><th data-col="price">发行价</th>
      <th data-col="upper">申购上限</th><th data-col="pe">发行市盈率</th><th data-col="ipe">行业PE</th>
      <th data-col="ballot">中签号日</th><th data-col="listing">上市日</th>
    </tr></thead>
    <tbody>${d.items.map((x) => `<tr>
      <td>${esc(x.applyDate)}</td>
      <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-sub">${esc(x.code)}${x.market ? ` · ${esc(x.market)}` : ''}</span></td>
      <td data-col="apply">${esc(x.applyCode || '--')}</td>
      <td data-col="price">${x.issuePrice === null ? '<span class="muted">待定</span>' : `${nf(x.issuePrice, 2)} 元`}</td>
      <td data-col="upper">${x.onlineApplyUpper === null ? '--' : `${nf(x.onlineApplyUpper, 0)} 股`}</td>
      <td data-col="pe">${x.pe === null ? '--' : nf(x.pe, 2)}</td>
      <td data-col="ipe">${x.industryPe === null ? '--' : nf(x.industryPe, 2)}</td>
      <td data-col="ballot">${esc(x.ballotDate || '--')}</td>
      <td data-col="listing">${esc(x.listingDate || '--')}</td>
    </tr>`).join('')}</tbody>`;
    return;
  }
  // 转债申购（v2.7.0）
  if (d.type === 'cbapply') {
    table.className = 'table calendar-table calendar-cbapply';
    table.innerHTML = `<thead><tr>
      <th>申购日</th><th>转债</th><th data-col="apply">申购代码</th><th data-col="stock">正股</th>
      <th data-col="rating">评级</th><th data-col="scale">发行规模</th><th data-col="tp">转股价</th><th data-col="listing">上市日</th>
    </tr></thead>
    <tbody>${d.items.map((x) => `<tr>
      <td>${esc(x.applyDate)}</td>
      <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-sub">${esc(x.code)}</span></td>
      <td data-col="apply">${esc(x.applyCode || '--')}</td>
      <td data-col="stock">${esc(x.stockCode || '--')}</td>
      <td data-col="rating">${esc(x.rating || '--')}</td>
      <td data-col="scale">${x.issueYi === null ? '--' : `${nf(x.issueYi, 2)} 亿`}</td>
      <td data-col="tp">${x.transferPrice === null ? '--' : `${nf(x.transferPrice, 2)} 元`}</td>
      <td data-col="listing">${esc(x.listingDate || '--')}</td>
    </tr>`).join('')}</tbody>`;
    return;
  }
  if (d.type === 'bonus') {
    table.className = 'table calendar-table calendar-bonus';
    table.innerHTML = `<thead><tr><th>股票</th><th>方案</th><th>每10股派息</th><th>送转</th><th>进度</th><th>公告日</th><th>股权登记日</th><th>除权除息日</th></tr></thead>
      <tbody>${d.items.map((x) => `<tr>
        <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-sub">${esc(x.code)}</span></td>
        <td class="t-sub">${esc(x.plan)}</td>
        <td>${x.cashPer10 === null ? '--' : `${nf(x.cashPer10, 2)} 元`}</td>
        <td>${x.bonusPer10 === null ? '--' : `${nf(x.bonusPer10, 2)} 股`}</td>
        <td class="t-sub">${esc(x.progress)}</td>
        <td>${esc(x.noticeDate || '--')}</td>
        <td>${esc(x.recordDate || '--')}</td>
        <td>${esc(x.exDate || '--')}</td>
      </tr>`).join('')}</tbody>`;
    return;
  }
  table.className = 'table calendar-table calendar-lift';
  table.innerHTML = `<thead><tr><th>解禁日</th><th>股票</th><th>解禁市值</th><th>解禁份额</th><th>可解禁份额</th><th>占流通比</th><th>类型</th></tr></thead>
    <tbody>${d.items.map((x) => `<tr>
      <td>${esc(x.date)}</td>
      <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-sub">${esc(x.code)}</span></td>
      <td>${x.marketYi === null ? '--' : `${nf(x.marketYi, 2)} 亿`}</td>
      <td>${x.sharesWan === null ? '--' : `${nf(x.sharesWan, 0)} 万股`}</td>
      <td>${x.ableSharesWan === null ? '--' : `${nf(x.ableSharesWan, 0)} 万股`}</td>
      <td>${nf(x.freeRatio, 4)}%</td>
      <td class="t-sub">${esc(x.type)}</td>
    </tr>`).join('')}</tbody>`;
}

async function loadConvertibles(force = false) {
  if (!force && state.cb) { renderConvertibles(); return; }
  if ($('#cbTable')) $('#cbTable').innerHTML = '<tbody><tr><td><div class="empty">加载中…</div></td></tr></tbody>';
  try {
    // 接口已经把数据中心的基本信息与腾讯现价合并好了，前端不用再单独取报价
    const data = await api('/api/calendar?type=cb&limit=40', 30000);
    state.cb = data;
    renderConvertibles();
  } catch (err) {
    handleLoadError('可转债', err);
    if ($('#cbTable')) $('#cbTable').innerHTML = `<tbody><tr><td><div class="empty">加载失败：${esc(err.message)}</div></td></tr></tbody>`;
  }
}

function renderConvertibles() {
  const table = $('#cbTable');
  const d = state.cb;
  if (!table) return;
  if ($('#cbMeta')) {
    $('#cbMeta').textContent = d ? `${d.count} 只 · 有行情 ${d.quoteCount || 0} 只` : '--';
  }
  if (!d || !(d.items || []).length) {
    table.innerHTML = '<tbody><tr><td><div class="empty">暂无可转债数据</div></td></tr></tbody>';
    return;
  }
  table.innerHTML = `<thead><tr><th>转债</th><th>现价</th><th>涨跌</th><th>正股</th><th>评级</th><th>发行规模</th><th>上市日</th><th>到期日</th></tr></thead>
    <tbody>${d.items.map((x) => `<tr>
      <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-sub">${esc(x.code)}</span></td>
      <td>${x.price === null ? '--' : nf(x.price, 3)}</td>
      <td class="${toneClass(x.pct)}">${x.pct === null ? '--' : pctFmt(x.pct)}</td>
      <td>${esc(x.stockCode || '--')}</td>
      <td>${esc(x.rating || '--')}</td>
      <td>${x.issueYi === null ? '--' : `${nf(x.issueYi, 2)} 亿`}</td>
      <td>${esc(x.listingDate || '--')}</td>
      <td>${esc(x.expireDate || '--')}</td>
    </tr>`).join('')}</tbody>`;
}

function screenerParams() {
  const v = (id) => {
    const el = $(id);
    if (!el) return '';
    const s = String(el.value || '').trim();
    return s === '' ? '' : s;
  };
  return {
    pctMin: v('#scrPctMin'),
    pctMax: v('#scrPctMax'),
    turnoverMin: v('#scrTurnMin'),
    amountMinYi: v('#scrAmtMin'),
    capMinYi: v('#scrCapMin'),
    capMaxYi: v('#scrCapMax'),
    peMax: v('#scrPeMax'),
    pbMax: v('#scrPbMax'),
    priceMin: v('#scrPriceMin'),
    board: v('#scrBoard'),
    sort: v('#scrSort') || 'pct',
    limit: 80,
  };
}

async function loadScreener() {
  if (state.screenerLoading) return;
  state.screenerLoading = true;
  const params = screenerParams();
  const qs = new URLSearchParams();
  for (const [k, val] of Object.entries(params)) if (val !== '') qs.set(k, val);
  if ($('#screenerTable')) $('#screenerTable').innerHTML = '<tbody><tr><td><div class="empty">正在扫描全市场，约需几秒…</div></td></tr></tbody>';
  if ($('#screenerBadge')) $('#screenerBadge').textContent = '扫描中';
  try {
    const data = await api(`/api/screener?${qs.toString()}`, 90000);
    state.screener = data;
    renderScreener();
  } catch (err) {
    handleLoadError('条件选股', err);
    if ($('#screenerTable')) $('#screenerTable').innerHTML = `<tbody><tr><td><div class="empty">扫描失败：${esc(err.message)}</div></td></tr></tbody>`;
    if ($('#screenerBadge')) $('#screenerBadge').textContent = '失败';
  } finally {
    state.screenerLoading = false;
  }
}

function renderScreener() {
  const table = $('#screenerTable');
  const d = state.screener;
  if (!table) return;
  if ($('#screenerBadge')) {
    // 没出结果时不显示一个孤零零的「--」徽标
    const badge = $('#screenerBadge');
    badge.textContent = d ? `${d.matched} 只命中` : '';
    badge.hidden = !d;
  }
  if ($('#screenerMeta')) {
    $('#screenerMeta').textContent = d
      ? `样本 ${d.poolSize} 只 · 扫描 ${d.scannedPages} 页 · 命中 ${d.matched} 只`
      : '样本池 = 新浪全市场快照';
  }
  if ($('#screenerNote') && d && d.note) $('#screenerNote').textContent = d.note;
  if (!d || !(d.items || []).length) {
    table.innerHTML = `<tbody><tr><td><div class="empty">没有符合条件的股票，放宽条件再试</div></td></tr></tbody>`;
    return;
  }
  table.innerHTML = `<thead><tr><th>股票</th><th>现价</th><th>涨跌幅</th><th>换手</th><th>成交额</th><th>PE</th><th>PB</th><th>总市值</th><th>流通市值</th></tr></thead>
    <tbody>${d.items.map((x) => `<tr data-stock-secid="${esc(x.secid)}" title="查看该股详情">
      <td><span class="t-name">${esc(cleanName(x.name))}</span><span class="t-sub">${esc(x.code)}</span></td>
      <td>${nf(x.price, 2)}</td>
      <td class="${toneClass(x.pct)}">${pctFmt(x.pct)}</td>
      <td>${nf(x.turnover, 2)}%</td>
      <td>${nf(x.amountYi, 2)} 亿</td>
      <td>${x.pe === null ? '--' : nf(x.pe, 1)}</td>
      <td>${x.pb === null ? '--' : nf(x.pb, 2)}</td>
      <td>${nf(x.mktCapYi, 1)} 亿</td>
      <td>${nf(x.floatCapYi, 1)} 亿</td>
    </tr>`).join('')}</tbody>`;
}

function loadDataCenter() {
  switchDataTab(state.dataTab);
}

/* =========================================================
   港股热门 + 港股个股详情（阶段 2）
   ========================================================= */

const HK_HOT = [
  ['00700', '腾讯控股'], ['09988', '阿里巴巴'], ['03690', '美团'], ['01810', '小米集团'],
  ['01211', '比亚迪股份'], ['00981', '中芯国际'], ['09618', '京东集团'], ['09999', '网易'],
  ['01024', '快手'], ['02318', '中国平安'],
];

async function loadHk(force = false) {
  if (!force && state.hk && Date.now() - state.hk.at < 30000) { renderHk(); return; }
  try {
    const codes = HK_HOT.map((x) => x[0]).join(',');
    const data = await api(`/api/hk/quotes?codes=${codes}`, 30000);
    state.hk = { ...data, at: Date.now() };
    renderHk();
  } catch (err) {
    handleLoadError('港股热门', err);
    if ($('#hkList')) $('#hkList').innerHTML = `<div class="empty">港股行情加载失败：${esc(err.message)}</div>`;
  }
}

function renderHk() {
  const el = $('#hkList');
  if (!el) return;
  const d = state.hk;
  if ($('#hkMeta')) $('#hkMeta').textContent = d ? `${d.count} 只 · ${timeText(d.updatedAt)}` : '--';
  if (!d || !(d.items || []).length) {
    el.innerHTML = '<div class="empty">暂无港股行情</div>';
    return;
  }
  el.innerHTML = d.items.map((x) => `
    <div class="hk-row" data-hk-code="${esc(x.code)}" title="查看 ${esc(cleanName(x.name))} 分时与日K">
      <div class="hk-name">${esc(cleanName(x.name))}<span class="hk-code">${esc(x.code)}</span></div>
      <div class="hk-price ${toneClass(x.pct)}">${nf(x.price, 3)}</div>
      <div class="hk-pct ${toneClass(x.pct)}">${pctFmt(x.pct)}</div>
    </div>`).join('');
}

async function openHkStock(code) {
  if (!code) return;
  const meta = HK_HOT.find((x) => x[0] === code);
  if (!routeOpening) pushDetailRoute('hk', code);
  const overlay = mountOverlay(`
    <div class="modal modal-stock">
      <div class="modal-head">
        <div class="modal-title"><h2>${esc(meta ? meta[1] : code)}</h2><span class="code">${esc(code)} · HK</span></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="empty">正在加载港股行情…</div>
    </div>`);
  try {
    const [q, m, k] = await Promise.all([
      api(`/api/hk/quote?code=${encodeURIComponent(code)}`, 30000),
      api(`/api/hk/minute?code=${encodeURIComponent(code)}`, 30000).catch(() => null),
      api(`/api/hk/kline?code=${encodeURIComponent(code)}&limit=160&fqt=1`, 30000).catch(() => null),
    ]);
    if (!document.body.contains(overlay)) return;
    renderHkStockModal(m, k, q);
  } catch (err) {
    toast(`港股详情加载失败：${err.message}`, 'err');
    closeOverlay();
  }
}

function renderHkStockModal(minute, kline, quote) {
  const overlay = $('.overlay');
  if (!overlay) return;
  const q = quote || {};
  const points = (minute && minute.points) || [];
  const preClose = Number((minute && minute.prevClose) || q.prevClose);
  let mode = 'minute';
  overlay.innerHTML = `<div class="modal modal-stock">
    <div class="modal-head">
      <div>
        <div class="modal-title"><h2>${esc(cleanName(q.name) || q.code)}</h2><span class="code">${esc(q.code)} · HK</span><span class="badge">港股延时</span></div>
        <div class="muted small mt8">交易时段 09:30–16:00（香港时间）</div>
      </div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-price-row">
      <span class="modal-price ${toneClass(q.pct)}">${nf(q.price, 3)}</span>
      <span class="modal-chg ${toneClass(q.pct)}">${pctFmt(q.pct)} ${nf(q.change, 3)}</span>
      <span class="badge">昨收 ${nf(q.prevClose, 3)}</span>
      <span class="badge">最高 ${nf(q.high, 3)}</span>
      <span class="badge">最低 ${nf(q.low, 3)}</span>
    </div>
    <div class="modal-kline-tools">
      <div class="seg seg-sm" id="hkModeSeg">
        <button data-hk-mode="minute" class="is-active">分时</button>
        <button data-hk-mode="kline">日 K</button>
      </div>
      <span class="muted small">${points.length ? `${points.length} 个分钟成交点` : '该时段暂无分时'}</span>
    </div>
    <div class="modal-body-grid">
      <div><div id="hkChart" class="modal-chart"></div></div>
      <div class="modal-side">
        <div class="modal-advice">
          <div class="ma-top"><span class="muted small">港股口径</span><span class="muted small">HKD</span></div>
          <p class="mt8">港股为延时行情，日 K 为腾讯前复权序列；港股没有 A 股那套涨跌停与主力净流入口径，因此这里不展示相关指标。</p>
        </div>
        <div class="modal-actions"><button class="btn" data-goto="global" data-close>返回全球市场</button></div>
      </div>
    </div>
  </div>`;

  const draw = () => {
    if (mode === 'kline' && kline && kline.candles && kline.candles.length > 1) {
      candleChart($('#hkChart'), kline, { zoomStart: 30, indicator: currentIndicator() });
    } else {
      usIntradayChart($('#hkChart'), points, { preClose });
    }
  };
  draw();
  $$('#hkModeSeg button').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.hkMode;
    $$('#hkModeSeg button').forEach((x) => x.classList.toggle('is-active', x === b));
    draw();
  }));
}

/* =========================================================
   基本面（F10）+ 个股龙虎榜抽屉（阶段 3）
   ========================================================= */

const F10_TABS = [
    ['survey', '公司概况'],
    ['finance', '主要财务'],
    ['holders', '股东研究'],
    ['bonus', '分红融资'],
    ['longhu', '个股龙虎榜'],
];

async function openFundamental(secid, code, name) {
  if (!code && !secid) return;
  // 叠在个股详情之上：关掉 F10 抽屉后仍回到个股详情（v2.7.0 修复）
  const overlay = pushOverlay(`
    <div class="drawer">
      <div class="drawer-head">
        <div><div class="eyebrow">FUNDAMENTALS</div><h2>${esc(cleanName(name) || code || secid)}</h2><span class="code">${esc(code || '')}</span></div>
        <button class="modal-close" data-close>×</button>
      </div>
      <div class="empty">正在加载基本面数据…</div>
    </div>`, 'drawer-overlay');
  try {
    const [f10, longhu, seats] = await Promise.all([
      api(`/api/f10?secid=${encodeURIComponent(secid || '')}&code=${encodeURIComponent(code || '')}`, 45000),
      api(`/api/longhu/stock?code=${encodeURIComponent(code || (secid || '').split('.')[1] || '')}&limit=15`, 30000).catch(() => null),
      // 席位明细（机构专用 / 营业部）单独取，失败不影响其它页签
      api(`/api/longhu/seats?code=${encodeURIComponent(code || (secid || '').split('.')[1] || '')}&limit=60`, 30000).catch(() => null),
    ]);
    if (!document.body.contains(overlay)) return;
    renderFundamentalDrawer(f10 || {}, longhu || {}, overlay, seats || null);
  } catch (err) {
    toast(`基本面加载失败：${err.message}`, 'err');
    closeOverlay();
  }
}

function renderFundamentalDrawer(f10, longhu, overlay, seats) {
  const drawer = overlay ? overlay.querySelector('.drawer') : $('.drawer');
  if (!drawer) return;
  const survey = f10.survey || {};
  const finance = f10.finance || {};
  const holders = f10.shareholders || {};
  const bonus = f10.bonus || {};
  const tabs = F10_TABS.map(([k, label], i) => `<button data-f10-tab="${k}" class="${i === 0 ? 'is-active' : ''}">${label}</button>`).join('');

  const panes = {
    survey: `<div class="f10-section">
      <div class="kv-grid">
        <div class="kv"><span>公司全称</span><b>${esc(survey.fullName || '--')}</b></div>
        <div class="kv"><span>所属行业</span><b>${esc(survey.industry || '--')}</b></div>
        <div class="kv"><span>地区</span><b>${esc(survey.area || '--')}</b></div>
        <div class="kv"><span>上市日期</span><b>${esc(survey.listDate || '--')}</b></div>
        <div class="kv"><span>董事长</span><b>${esc(survey.chairman || '--')}</b></div>
        <div class="kv"><span>官网</span><b>${esc(survey.website || '--')}</b></div>
      </div>
      <div class="modal-section-title">主营业务</div>
      <p class="muted small">${esc(survey.business || '--')}</p>
      <div class="modal-section-title">公司简介</div>
      <p class="muted small">${esc(survey.profile || '暂无简介')}</p>
    </div>`,
    finance: `<table class="table"><thead><tr><th>报告期</th><th>营收</th><th>营收同比</th><th>净利</th><th>净利同比</th><th>EPS</th><th>ROE</th><th>毛利率</th><th>负债率</th></tr></thead>
      <tbody>${(finance.items || []).map((x) => `<tr>
        <td>${esc(x.reportName || x.period)}</td>
        <td>${x.revenueYi === null ? '--' : `${nf(x.revenueYi, 2)} 亿`}</td>
        <td class="${toneClass(x.revenueYoy)}">${x.revenueYoy === null ? '--' : `${nf(x.revenueYoy, 2)}%`}</td>
        <td>${x.profitYi === null ? '--' : `${nf(x.profitYi, 2)} 亿`}</td>
        <td class="${toneClass(x.profitYoy)}">${x.profitYoy === null ? '--' : `${nf(x.profitYoy, 2)}%`}</td>
        <td>${x.eps === null ? '--' : nf(x.eps, 2)}</td>
        <td>${x.roe === null ? '--' : `${nf(x.roe, 2)}%`}</td>
        <td>${x.grossMargin === null ? '--' : `${nf(x.grossMargin, 2)}%`}</td>
        <td>${x.debtRatio === null ? '--' : `${nf(x.debtRatio, 2)}%`}</td>
      </tr>`).join('') || '<tr><td colspan="9"><div class="empty">暂无财务数据</div></td></tr>'}</tbody></table>`,
    holders: `<div class="muted small">股东户数</div>
      <div class="kv-grid mt8">${(holders.holderCount || []).map((x) => `<div class="kv"><span>${esc(x.date || '--')}</span><b>${nf(x.count, 0)} 户</b></div>`).join('') || '<div class="kv"><span>暂无</span><b>--</b></div>'}</div>
      <div class="modal-section-title">十大股东</div>
      <table class="table"><thead><tr><th>股东</th><th>持股(万股)</th><th>占比</th><th>变动</th></tr></thead>
      <tbody>${(holders.top10 || []).map((x) => `<tr><td>${esc(x.name)}</td><td>${nf(x.sharesWan, 2)}</td><td>${nf(x.ratio, 2)}%</td><td class="t-sub">${esc(x.change || '')}</td></tr>`).join('') || '<tr><td colspan="4"><div class="empty">暂无股东数据</div></td></tr>'}</tbody></table>`,
    bonus: `<table class="table"><thead><tr><th>日期</th><th>方案</th><th>每10股派息</th><th>送转</th><th>进度</th></tr></thead>
      <tbody>${(bonus.items || []).map((x) => `<tr><td>${esc(x.date || '--')}</td><td class="t-sub">${esc(x.profile || '--')}</td><td>${x.cashPer10 === null ? '--' : `${nf(x.cashPer10, 2)} 元`}</td><td>${x.bonusPer10 === null ? '--' : `${nf(x.bonusPer10, 2)} 股`}</td><td class="t-sub">${esc(x.progress || '')}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">暂无分红记录</div></td></tr>'}</tbody></table>`,
    longhu: `<table class="table f10-longhu-table"><thead><tr><th>日期</th><th>收盘</th><th>涨跌幅</th><th>上榜净额</th><th>上榜原因</th></tr></thead>
      <tbody>${((longhu && longhu.items) || []).map((x) => `<tr><td>${esc(x.date)}</td><td>${nf(x.close, 2)}</td><td class="${toneClass(x.pct)}">${pctFmt(x.pct)}</td><td class="${toneClass(x.netYi)}">${x.netYi === null ? '--' : `${nf(x.netYi, 2)} 亿`}</td><td class="t-sub">${esc(x.reason || '')}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">该股近期没有上榜记录</div></td></tr>'}</tbody></table>
      ${renderSeatsBlock(seats)}`,
  };

  drawer.innerHTML = `
    <div class="drawer-head">
      <div><div class="eyebrow">FUNDAMENTALS</div><h2>${esc(cleanName(survey.name || '') || f10.code || '')}</h2><span class="code">${esc(f10.code || '')}</span></div>
      <button class="modal-close" data-close>×</button>
    </div>
    <nav class="f10-tabs" id="f10Tabs">${tabs}</nav>
    ${F10_TABS.map(([k], i) => `<div class="f10-pane" data-f10-pane="${k}" ${i === 0 ? '' : 'hidden'}>${panes[k]}</div>`).join('')}
    <p class="muted small mt12">F10 数据来自东财公开接口，财务指标为报告期口径；十大股东存在披露滞后，不代表当前持股。</p>`;

  // 作用域限定在本抽屉内：F10 现在是叠加层，全局选择器可能命中下层元素
  const tabBtns = $$('#f10Tabs button', drawer);
  const panesEls = $$('[data-f10-pane]', drawer);
  tabBtns.forEach((b) => b.addEventListener('click', () => {
    tabBtns.forEach((x) => x.classList.toggle('is-active', x === b));
    panesEls.forEach((p) => { p.hidden = p.dataset.f10Pane !== b.dataset.f10Tab; });
  }));
}

/**
 * 龙虎榜「机构与席位明细」区块（v2.7.0）
 * 数据来自东财 RPT_BILLBOARD_DAILYDETAILSBUY / ...SELL：
 * 主板披露的是营业部（含「机构专用」），科创板/创业板有时直接披露
 * 「机构 / 中小投资者 / 其他自然人 / 沪深股通」这类投资者分类，这里统一按席位展示并打标签。
 */
function renderSeatsBlock(seats) {
  if (!seats) return '<div class="modal-section-title">机构与席位明细</div><div class="empty">席位明细加载失败，可稍后重试</div>';
  const groups = seats.items || [];
  if (!groups.length) return '<div class="modal-section-title">机构与席位明细</div><div class="empty">近期没有可用的席位明细</div>';
  const rows = groups.map((g) => {
    const head = `<div class="seat-day"><span class="seat-date">${esc(g.date)}</span><span class="t-sub">${esc(g.reason || '')}</span>${g.orgNetYi !== null ? `<span class="badge ${g.orgNetYi >= 0 ? 'tone-up' : 'tone-down'}">机构净额 ${g.orgNetYi >= 0 ? '+' : ''}${nf(g.orgNetYi, 2)} 亿</span>` : ''}</div>`;
    const list = (g.seats || []).map((s) => `<tr>
      <td class="t-sub seat-name">${esc(s.dept)}${s.isOrg ? '<span class="seat-tag">机构</span>' : ''}${s.isNorth ? '<span class="seat-tag north">股通</span>' : ''}</td>
      <td class="t-chg">${s.buyYi === null ? '--' : nf(s.buyYi, 2)}</td>
      <td class="t-chg ${toneClass(-(s.sellYi || 0))}">${s.sellYi === null ? '--' : nf(s.sellYi, 2)}</td>
      <td class="t-chg ${toneClass(s.netYi)}">${s.netYi === null ? '--' : `${s.netYi >= 0 ? '+' : ''}${nf(s.netYi, 2)}`}</td>
    </tr>`).join('');
    return `${head}<table class="table seat-table"><thead><tr><th>席位</th><th>买入(亿)</th><th>卖出(亿)</th><th>净额(亿)</th></tr></thead><tbody>${list}</tbody></table>`;
  }).join('');
  return `<div class="modal-section-title">机构与席位明细 <span class="muted small">近 ${groups.length} 个上榜日 · 单位亿元</span></div>
    <div class="seat-list">${rows}</div>
    <p class="muted small mt8">${esc(seats.note || '')}</p>`;
}

/* =========================================================
   详情路由
   ---------------------------------------------------------
   视图级仍是 #dashboard 这种单段 hash；个股 / 板块 / 基金 / 美股详情
   升级为 #/stock/1.600519、#/sector/BK0475、#/fund/510300、#/us/AAPL，
   这样地址栏可以直接复制、收藏、新标签打开，后退键也能正常关闭弹窗。
   ========================================================= */
const VIEWS = ['dashboard', 'china', 'global', 'us', 'commodities', 'sectors', 'funds', 'data', 'strategy', 'fundwatch', 'stockwatch'];
// v2.8.0：原「自选·预警」拆成「自选基金」（fundwatch）与「自选股票」（stockwatch），
// 旧书签 #watchlist 一律落到自选股票，避免历史链接打开空白页。
const VIEW_ALIAS = { watchlist: 'stockwatch', watch: 'stockwatch' };
const DETAIL_KINDS = ['stock', 'sector', 'fund', 'us', 'hk'];
const DETAIL_BASE_VIEW = { stock: 'stockwatch', sector: 'sectors', fund: 'funds', us: 'us', hk: 'global' };
// 由 popstate / 直接打开详情路由时为 true，避免「打开详情」再压一条新历史
let routeOpening = false;

function parseHashRoute() {
  const raw = (location.hash || '').replace(/^#/, '');
  if (raw.startsWith('/')) {
    const seg = raw.slice(1).split('/');
    const kind = seg[0] || '';
    const key = decodeURIComponent(seg[1] || '');
    if (DETAIL_KINDS.includes(kind) && key) return { detail: { kind, key } };
    return { view: 'dashboard' };
  }
  const view = VIEW_ALIAS[raw] || raw;
  return { view: VIEWS.includes(view) ? view : 'dashboard' };
}

function detailHash(kind, key) {
  return `#/${kind}/${encodeURIComponent(key)}`;
}

function pushDetailRoute(kind, key) {
  const h = detailHash(kind, key);
  if (location.hash === h) return;
  history.pushState({ view: state.view, detail: { kind, key } }, '', h);
}

function pushViewRoute(view) {
  const h = `#${view}`;
  if (location.hash === h) return;
  history.pushState({ view }, '', h);
}

/** 从详情路由打开详情（popstate 与首屏深链共用） */
async function openDetailRoute(detail) {
  routeOpening = true;
  try {
    if (detail.kind === 'stock') await openStock(detail.key);
    else if (detail.kind === 'sector') await openSector(detail.key);
    else if (detail.kind === 'us') await openUsStock(detail.key);
    else if (detail.kind === 'hk') await openHkStock(detail.key);
    else if (detail.kind === 'fund') {
      try {
        await openFund(detail.key);
      } catch {
        await openStockFund(detail.key);
      }
    }
  } finally {
    routeOpening = false;
  }
}

function loadView(view) {
  if (view === 'dashboard') {
    if (!state.overview) loadOverview();
    if (!state.sectors[state.sectorType]) loadSectors(state.sectorType);
    if (!state.news) loadNews();
    if (!state.advice) loadAdvice();
    if (!state.watchData) loadWatchData();
    renderDashboard();
  }
  if (view === 'china') {
    renderChinaHeader();
    renderBreadth();
    renderIndexCompare();
    loadIndexCompare();
    loadChinaStock();
    loadChinaChart();
    loadChinaRanks();
    loadChinaDistribution();
    loadChinaPeriods();
    // v2.10.0：「头部沪深300基金 / 流通市值」按用户要求移回 A 股页
    loadCsi300Ratio();
  }
  if (view === 'global') {
    renderGlobalTable();
    renderFx();
    renderGlobalSessions();
    renderGlobalTemp();
    loadGlobalChart();
    loadHk();
  }
  if (view === 'us') {
    renderUS();
    loadUS();
    loadUSChart();
    loadUSMinutes();
  }
  if (view === 'commodities') {
    renderMetalCards();
    renderFuturesTables();
    loadCommodityChart();
    loadMetalsIntraday();
  }
  if (view === 'sectors') {
    renderSectorPage();
    loadSectorPage(state.sectorPageType);
  }
  if (view === 'data') {
    loadDataCenter();
  }
  if (view === 'funds') {
    renderFunds();
    if (state.fundView === 'sector') {
      if (!state.fundSectorData) loadFundSectorFlow();
    }
    if (state.fundView === 'theme') {
      if (!state.fundThemes) loadFundThemes();
      renderFundThemeOverview();
    }
    if (state.fundView === 'dist') {
      if (!state.fundDist) loadFundDistribution();
      else renderFundDistribution();
    }
    if (state.fundView === 'openfund') {
      if (!state.fundBoard) loadFundBoard();
      else renderFundBoard();
    }
    if (state.fundView === 'openflow' && !state.openFlowData) loadOpenFlow();
    if (state.fundView === 'proxy' && !state.proxyData) loadProxy();
    if (state.fundView === 'flow' && !state.fundFlow) loadFundFlow();
    if (state.fundView === 'bond') loadBondFund();
    if (state.fundView === 'stock') {
      if (!state.stockFund) loadStockFund();
      loadStockFundIntel();
    }
  }
  if (view === 'strategy') {
    if (!state.advice) loadAdvice();
    else renderStrategy();
    loadWatchData();
    loadFundWatch();
    loadBattle();
    if (state.battleTab !== 'overview') loadBattleTab(state.battleTab);
    else if (state.battle) renderBattleOverview();
  }
  if (view === 'fundwatch') {
    if (!state.portfolios || !state.portfolios.length) settleActivePortfolio('default');
    renderFundwatchPanels();
    loadFundWatch();
    loadFundPnl();
    if (state.fundRange === 'today') loadFundIntradayCompare();
  }
  if (view === 'stockwatch') {
    renderWatchTable();
    renderAlerts();
    renderWatchTips();
    renderPaper();
    loadWatchData();
    loadCloudAlerts();
    loadPaper();
    // 排行榜默认收起：只有用户点开过才请求（v2.9.0）
    if (state.paperRankOpen) loadPaperRanking();
  }
}

/* =========================================================
   加载失败处理
   ========================================================= */
function handleLoadError(label, err) {
  const last = state.errors.get(label) || 0;
  if (Date.now() - last > 30000) {
    state.errors.set(label, Date.now());
    toast(`${label}加载失败：{err.message}`, 'err', 5000);
  }
  setFreshness('stale', `${label}异常`);
}

/* =========================================================
   刷新调度
   ========================================================= */
let fastTimer = null;
let slowTimer = null;
let slowTick = 0;

function startTimers() {
  clearInterval(fastTimer);
  clearInterval(slowTimer);
  if (!state.settings.autoRefresh) return;
  fastTimer = setInterval(() => {
    if (document.hidden) return;
    refreshFast();
  }, Math.max(5, Number(state.settings.interval) || 15) * 1000);
  slowTimer = setInterval(() => {
    if (document.hidden) return;
    slowTick += 1;
    loadNews();
    loadSectors(state.view === 'sectors' ? state.sectorPageType : state.sectorType);
    if (state.view === 'sectors') loadSectorPeriod(true);
    if (slowTick % 2 === 0) loadAdvice();
  }, 60000);
}

async function refreshFast() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    await loadOverview();
    await loadWatchData(true);
    if (state.view === 'fundwatch') loadFundWatch();
    // v2.9.2：模拟盘账户也跟 15 秒刷新走（此前只有切页/手动刷新才拉，盘中看着「上面的金额不会变」）
    if (state.view === 'stockwatch') {
      if (Date.now() - (state.paperAt || 0) > 10000) loadPaper(true);
      if (state.paperRankOpen) loadPaperRanking(true);
    }
    if (state.view === 'china') {
      await loadChinaStock();
      loadChinaDistribution();
      loadIndexCompare();
      await loadChinaChart();
    }
    if (state.view === 'global') loadGlobalChart();
    if (state.view === 'us') { loadUS(true); loadUSMinutes(); }
    if (state.view === 'commodities') { loadCommodityChart(); loadMetalsIntraday(); }
    if (state.view === 'strategy') {
      loadBattle();
      if (state.battleTab === 'sectors') loadBattleSectors(true);
      if (state.battleTab === 'moves') loadBattleMoves(true);
      if (state.battleTab === 'ladder') loadBattleLadder(true);
    }
    if (state.view === 'funds') {
      if (state.fundView === 'sector') loadFundSectorFlow(true);
      if (state.fundView === 'dist') loadFundDistribution(true);
      if (state.fundView === 'theme') loadFundThemes(true);
      if (state.fundView === 'openfund') loadFundBoard(true);
      if (state.fundView === 'flow') loadFundFlow(true);
      if (state.fundView === 'bond') loadBondFund(true);
      if (state.fundView === 'stock') {
        loadStockFund();
        loadStockFundIntel();
      }
    }
  } finally {
    state.refreshing = false;
  }
}

async function refreshAll(manual = false) {
  if (manual) toast('正在刷新全部数据…', 'info', 1600);
  await Promise.allSettled([
    loadOverview(),
    loadSectors(state.view === 'sectors' ? state.sectorPageType : state.sectorType, true),
    loadNews(),
    loadAdvice(true),
    loadWatchData(true),
  ]);
  if (state.view === 'china') { await loadChinaRanks(true); await loadChinaStock(true); await loadChinaChart(); await loadChinaDistribution(true); await loadCsi300Ratio(true); await loadIndexCompare(true); await loadChinaPeriods(true); }
  if (state.view === 'global') await loadGlobalChart(true);
  if (state.view === 'us') { await loadUS(true); await loadUSChart(true); await loadUSMinutes(true); }
  if (state.view === 'fundwatch') { await loadFundWatch(true); await loadFundPnl(true); if (state.fundRange === 'today') loadFundIntradayCompare(true); }
  if (state.view === 'stockwatch') {
    await loadPaper(true);
    if (state.paperRankOpen) await loadPaperRanking(true);
  }
  if (state.view === 'commodities') await loadCommodityChart(true);
  if (state.view === 'commodities') await loadMetalsIntraday(true);
  if (state.view === 'funds') {
    if (state.fundView === 'sector') await loadFundSectorFlow(true);
    if (state.fundView === 'dist') await loadFundDistribution(true);
    if (state.fundView === 'theme') await loadFundThemes(true);
    if (state.fundView === 'openfund') await loadFundBoard(true);
    if (state.fundView === 'openflow') await loadOpenFlow(true);
    if (state.fundView === 'proxy') await loadProxy(true);
    if (state.fundView === 'flow') await loadFundFlow(true);
    if (state.fundView === 'bond') await loadBondFund(true);
    if (state.fundView === 'stock') {
      await loadStockFund(true);
      await loadStockFundIntel(true);
    }
  }
  if (state.view === 'sectors') { await loadSectorPeriod(true); renderSectorPage(); }
  if (state.view === 'strategy') {
    await loadBattle(true);
    renderStrategy();
    await loadBattleTab(state.battleTab, true);
  }
  toast('数据已刷新', 'ok', 1800);
}

/* =========================================================
   事件绑定
   ========================================================= */
function bindEvents() {
  $$('.nav-tab').forEach((tab) => tab.addEventListener('click', () => navigate(tab.dataset.view)));

  document.addEventListener('click', (e) => {
    const indBtn = e.target.closest('[data-ind]');
    if (indBtn) {
      e.preventDefault();
      applyIndicator(indBtn.dataset.ind);
      return;
    }
    const fqtBtn = e.target.closest('[data-fqt]');
    if (fqtBtn) {
      e.preventDefault();
      applyFqt(fqtBtn.dataset.fqt);
      return;
    }
    const retry = e.target.closest('[data-sector-retry]');
    if (retry) {
      e.preventDefault();
      const bag = state.sectorPeriodData[state.sectorPageType] || {};
      delete bag[state.sectorPeriod];
      loadSectorPeriod(true);
      return;
    }
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      e.preventDefault();
      if (goto.hasAttribute('data-close')) closeOverlay();
      // 带 data-fund-pane 的跳转要同时切到基金页指定子页（板块资金 ↔ 基金板块资金互相跳）
      if (goto.dataset.fundPane) state.fundView = goto.dataset.fundPane;
      navigate(goto.dataset.goto);
      return;
    }
    const stock = e.target.closest('[data-stock-secid]');
    if (stock) {
      e.preventDefault();
      openStock(stock.dataset.stockSecid);
      return;
    }
    const usStock = e.target.closest('[data-us-stock]');
    if (usStock) {
      e.preventDefault();
      openUsStock(usStock.dataset.usStock);
      return;
    }
    const hkStock = e.target.closest('[data-hk-code]');
    if (hkStock) {
      e.preventDefault();
      openHkStock(hkStock.dataset.hkCode);
      return;
    }
    const f10Btn = e.target.closest('[data-f10-open]');
    if (f10Btn) {
      e.preventDefault();
      const st = state.stockModal || {};
      openFundamental(f10Btn.dataset.f10Secid || st.secid, f10Btn.dataset.f10Code || st.code, f10Btn.dataset.f10Name || st.name);
      return;
    }
    const newsBtn = e.target.closest('[data-news-open]');
    if (newsBtn) {
      e.preventDefault();
      const st = state.stockModal || {};
      openStockNews(newsBtn.dataset.newsCode || st.code, newsBtn.dataset.newsName || st.name);
      return;
    }
    const strategyBtn = e.target.closest('[data-strategy-new]');
    if (strategyBtn) {
      e.preventDefault();
      openStrategyInNewTab();
      return;
    }
    const idx = e.target.closest('[data-index-secid]');
    if (idx) {
      e.preventDefault();
      const secid = idx.dataset.indexSecid;
      if (idx.dataset.indexView === 'global') {
        state.globalIndex = secid;
        navigate('global');
      } else {
        const changed = state.cnIndex !== secid;
        state.cnIndex = secid;
        $$('#cnIndexSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.secid === secid));
        navigate('china');
        if (changed) {
          state.cnStock = null;
          state.cnKline = null;
          state.cnZoom = null;
          loadChinaStock(true);
          loadChinaChart(true);
        }
      }
      return;
    }
    const asset = e.target.closest('[data-asset-secid]');
    if (asset) {
      e.preventDefault();
      const secid = asset.dataset.assetSecid;
      if (secid.startsWith('100.')) { state.globalIndex = secid; navigate('global'); }
      else { state.comSecid = secid; navigate('commodities'); }
      return;
    }
    // 「对比」勾选框不能被行点击当成「打开详情」：先吃掉，交给各表格自己的 change 监听
    if (e.target.closest('[data-compare-code]')) return;
    // 持仓表的「改 / 删」按钮同理，别冒泡成打开基金详情
    if (e.target.closest('[data-hold-action]')) return;
    const fundStockRow = e.target.closest('[data-stock-fund-code]');
    if (fundStockRow && !fundStockRow.closest('#stockFundTable') && !fundStockRow.closest('#fundBoardTable')) {
      e.preventDefault();
      openStockFund(fundStockRow.dataset.stockFundCode, fundStockRow.dataset.stockFundName);
      return;
    }
    const fundRow = e.target.closest('[data-fund-code]');
    if (fundRow && !fundRow.closest('#fundFlowTable') && !fundRow.closest('#fundWatchTable') && !fundRow.closest('#fundBoardTable')) {
      e.preventDefault();
      if (Date.now() - fundDragEndedAt < 350) return;
      openFund(fundRow.dataset.fundCode, fundRow.dataset.fundName, fundRow.dataset.fundType || 'etf');
      return;
    }
    const fundSector = e.target.closest('[data-fund-sector]');
    if (fundSector && !fundSector.closest('#fundSectorTable')) {
      e.preventDefault();
      openFundSector(fundSector.dataset.fundSector);
      return;
    }
    const sector = e.target.closest('[data-sector-code]');
    if (sector) {
      e.preventDefault();
      openSector(sector.dataset.sectorCode, sector.dataset.sectorName);
      return;
    }
    if (e.target.closest('[data-close]')) { closeOverlay(); return; }
    if (e.target.classList.contains('overlay')) { closeOverlay(); return; }
    if (e.target.closest('[data-action="notify"]')) { requestNotify(); return; }

    const demo = e.target.closest('[data-demo-watch]');
    if (demo) {
      const item = DEFAULT_WATCH.find((w) => w.secid === demo.dataset.demoWatch);
      if (item) addWatch(item);
    }
  });

  document.addEventListener('click', (e) => {
    const alertDel = e.target.closest('[data-alert-id]');
    if (alertDel) {
      state.alerts = state.alerts.filter((a) => a.id !== alertDel.dataset.alertId);
      saveJSON(ALERTS_KEY, state.alerts);
      renderAlerts();
      toast('预警已删除', 'info');
    }
  });

  $('#sectorSeg') && $('#sectorSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sector-type]');
    if (!btn) return;
    state.sectorType = btn.dataset.sectorType;
    $$('#sectorSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    loadSectors(state.sectorType);
  });

  $('#sectorPageSeg') && $('#sectorPageSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sector-page]');
    if (!btn) return;
    state.sectorPageType = btn.dataset.sectorPage;
    $$('#sectorPageSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    loadSectorPage(state.sectorPageType);
  });

  $('#sectorPeriodSeg') && $('#sectorPeriodSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sector-period]');
    if (!btn) return;
    state.sectorPeriod = btn.dataset.sectorPeriod;
    $$('#sectorPeriodSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    const bag = state.sectorPeriodData[state.sectorPageType] || {};
    if (bag[state.sectorPeriod]) renderSectorPage();
    else loadSectorPeriod();
  });

  $('#sectorCompareSeg') && $('#sectorCompareSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-compare]');
    if (!btn) return;
    state.sectorCompare = btn.dataset.compare === 'on';
    $$('#sectorCompareSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    const data = currentSectorData();
    if (data) renderSectorCompare(data);
  });

  $('#usPhaseSeg') && $('#usPhaseSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-us-phase]');
    if (!btn) return;
    state.usPhase = btn.dataset.usPhase;
    state.usPhaseTouched = true;
    $$('#usPhaseSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderUSMinutes();
  });

  // 数据中心（阶段 2）：子页切换 + 龙虎榜 / 日历 / 选股控件
  $('#dataTabSeg') && $('#dataTabSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-data-tab]');
    if (!btn) return;
    switchDataTab(btn.dataset.dataTab);
  });
  $('#longhuLoad') && $('#longhuLoad').addEventListener('click', () => {
    state.longhuDate = ($('#longhuDate') && $('#longhuDate').value) || '';
    loadLonghu(true);
  });
  $('#longhuDate') && $('#longhuDate').addEventListener('change', () => {
    state.longhuDate = ($('#longhuDate') && $('#longhuDate').value) || '';
    loadLonghu(true);
  });
  $('#calendarTypeSeg') && $('#calendarTypeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cal-type]');
    if (!btn) return;
    loadCalendar(btn.dataset.calType);
  });
  $('#scrRun') && $('#scrRun').addEventListener('click', () => loadScreener());
  $('#scrReset') && $('#scrReset').addEventListener('click', () => {
    for (const id of ['scrPctMin', 'scrPctMax', 'scrTurnMin', 'scrAmtMin', 'scrCapMin', 'scrCapMax', 'scrPeMax', 'scrPbMax', 'scrPriceMin']) {
      const el = $(`#${id}`);
      if (el) el.value = '';
    }
    const b = $('#scrBoard');
    if (b) b.value = '';
    const s = $('#scrSort');
    if (s) s.value = 'pct';
  });

  $('#fundSubnav') && $('#fundSubnav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fund-view]');
    if (!btn) return;
    if (!fundModuleVisible(btn.dataset.fundView)) return;
    state.fundView = btn.dataset.fundView;
    renderFunds();
    if (state.fundView === 'sector' && !state.fundSectorData) loadFundSectorFlow();
    if (state.fundView === 'theme' && !state.fundThemes) loadFundThemes();
    if (state.fundView === 'dist' && !state.fundDist) loadFundDistribution();
    if (state.fundView === 'openfund' && !state.fundBoard) loadFundBoard();
    if (state.fundView === 'openflow' && !state.openFlowData) loadOpenFlow();
    if (state.fundView === 'proxy' && !state.proxyData) loadProxy();
    if (state.fundView === 'flow' && !state.fundFlow) loadFundFlow();
    if (state.fundView === 'bond') loadBondFund();
    if (state.fundView === 'stock') {
      if (!state.stockFund) loadStockFund();
      loadStockFundIntel();
    }
  });

  $('#openFlowCat') && $('#openFlowCat').addEventListener('change', (e) => {
    state.openFlowCategory = e.target.value;
    state.openFlowData = null;
    loadOpenFlow(true);
  });

  $('#proxyDirSeg') && $('#proxyDirSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-proxy-dir]');
    if (!btn) return;
    state.proxyDir = btn.dataset.proxyDir;
    renderFunds();
    renderProxy();
  });

  $('#proxyToQuarterly') && $('#proxyToQuarterly').addEventListener('click', () => {
    state.fundView = 'openflow';
    renderFunds();
    if (!state.openFlowData) loadOpenFlow();
    else renderOpenFlow();
  });

  $('#bondFundSortSeg') && $('#bondFundSortSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bond-fund-sort]');
    if (!btn) return;
    state.bondFundSort = btn.dataset.bondFundSort;
    state.bondFund = null;
    renderFunds();
    loadBondFund(true);
  });

  $('#fundSectorSortSeg') && $('#fundSectorSortSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sector-sort]');
    if (!btn) return;
    state.fundSectorSort = btn.dataset.sectorSort;
    renderFunds();
  });

  /* ---------- v2.10.0：基金涨跌分布 / 板块总览 / 场外基金 ---------- */
  $('#fundDistScopeSeg') && $('#fundDistScopeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fund-dist-scope]');
    if (!btn) return;
    const scope = btn.dataset.fundDistScope === 'etf' ? 'etf' : 'equity';
    if (scope === state.fundDistScope) return;
    state.fundDistScope = scope;
    state.fundDist = null;
    renderFunds();
    loadFundDistribution(true);
  });

  $('#fundThemeSortSeg') && $('#fundThemeSortSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fund-theme-sort]');
    if (!btn) return;
    state.fundThemeSort = ['day', 'streak', 'month'].includes(btn.dataset.fundThemeSort)
      ? btn.dataset.fundThemeSort
      : 'day';
    renderFundThemeOverview();
    $$('#fundThemeSortSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
  });

  $('#fundThemeTable') && $('#fundThemeTable').addEventListener('click', (e) => {
    const row = e.target.closest('[data-fund-theme]');
    if (!row) return;
    openFundTheme(row.dataset.fundTheme);
  });

  $('#fundBoardTabs') && $('#fundBoardTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fund-board-tab]');
    if (!btn) return;
    state.fundBoardTab = ['gain', 'loss', 'hot', 'etf'].includes(btn.dataset.fundBoardTab)
      ? btn.dataset.fundBoardTab
      : 'gain';
    state.fundBoard = null;
    renderFunds();
    loadFundBoard(true);
  });

  $('#fundBoardTypeSeg') && $('#fundBoardTypeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fund-board-type]');
    if (!btn || state.fundBoardTab === 'etf') return;
    state.fundBoardType = ['all', 'gp', 'zs', 'hh'].includes(btn.dataset.fundBoardType)
      ? btn.dataset.fundBoardType
      : 'all';
    state.fundBoard = null;
    renderFunds();
    loadFundBoard(true);
  });

  $('#fundBoardTable') && $('#fundBoardTable').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-compare-code]');
    if (!cb) return;
    toggleCompareFund(cb.dataset.compareCode, cb.dataset.compareName, cb.checked);
  });
  $('#fundBoardTable') && $('#fundBoardTable').addEventListener('click', (e) => {
    if (e.target.closest('[data-compare-code]')) return;
    const etfRow = e.target.closest('[data-fund-code]');
    if (etfRow) {
      openFund(etfRow.dataset.fundCode, etfRow.dataset.fundName, 'etf');
      return;
    }
    const openRow = e.target.closest('[data-stock-fund-code]');
    if (openRow) openStockFund(openRow.dataset.stockFundCode, openRow.dataset.stockFundName);
  });

  $('#fundBoardCompareChips') && $('#fundBoardCompareChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-compare-remove]');
    if (!btn) return;
    state.compareFunds = state.compareFunds.filter((f) => f.code !== btn.dataset.compareRemove);
    renderFundBoard();
    renderFundBoardCompareBar();
  });
  $('#fundBoardCompareBtn') && $('#fundBoardCompareBtn').addEventListener('click', () => openFundCompare());
  $('#fundBoardCompareClear') && $('#fundBoardCompareClear').addEventListener('click', () => {
    state.compareFunds = [];
    renderFundBoard();
    renderFundBoardCompareBar();
  });
  $('#fundCompareOpen') && $('#fundCompareOpen').addEventListener('click', () => openFundComparePicker());

  $('#fundFlowDirSeg') && $('#fundFlowDirSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fund-dir]');
    if (!btn) return;
    state.fundFlowDir = btn.dataset.fundDir;
    renderFunds();
    loadFundFlow(true);
  });

  $('#fundCategorySeg') && $('#fundCategorySeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fund-category]');
    if (!btn) return;
    state.fundCategory = btn.dataset.fundCategory;
    renderFunds();
    loadFundFlow(true);
  });

  $('#stockFundTypeSeg') && $('#stockFundTypeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stock-fund-type]');
    if (!btn) return;
    state.stockFundType = btn.dataset.stockFundType;
    state.stockFund = null;
    renderFunds();
    loadStockFund(true);
  });
  $('#stockFundSortSeg') && $('#stockFundSortSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stock-fund-sort]');
    if (!btn) return;
    state.stockFundSort = btn.dataset.stockFundSort;
    state.stockFund = null;
    renderFunds();
    loadStockFund(true);
  });
  $('#stockFundTable') && $('#stockFundTable').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-compare-code]');
    if (!cb) return;
    toggleCompareFund(cb.dataset.compareCode, cb.dataset.compareName, cb.checked);
  });
  $('#stockFundTable') && $('#stockFundTable').addEventListener('click', (e) => {
    if (e.target.closest('[data-compare-code]')) return;
    const row = e.target.closest('[data-stock-fund-code]');
    if (row) openStockFund(row.dataset.stockFundCode, row.dataset.stockFundName);
  });
  $('#stockFundIntel') && $('#stockFundIntel').addEventListener('click', (e) => {
    const item = e.target.closest('[data-intel-code]');
    if (!item) return;
    const type = item.dataset.intelType;
    if (type === 'etf') openFund(item.dataset.intelCode, item.dataset.intelName, 'etf');
    else openStockFund(item.dataset.intelCode, item.dataset.intelName);
  });
  $('#compareChips') && $('#compareChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-compare-remove]');
    if (!btn) return;
    state.compareFunds = state.compareFunds.filter((f) => f.code !== btn.dataset.compareRemove);
    renderStockFund();
    renderCompareBar();
  });
  $('#compareBtn') && $('#compareBtn').addEventListener('click', () => openFundCompare());
  $('#compareClear') && $('#compareClear').addEventListener('click', () => {
    state.compareFunds = [];
    renderStockFund();
    renderCompareBar();
  });
  $('#stockFundTable') && $('#stockFundTable').addEventListener('click', (e) => {
    const row = e.target.closest('[data-stock-fund-code]');
    if (row) openStockFund(row.dataset.stockFundCode, row.dataset.stockFundName);
  });

  // 基金搜索：基金页 + 自选基金板块各一套，逻辑共用
  bindFundSearch('#fundSearchInput', '#fundSearchPop', '#fundSearchBtn');
  bindFundSearch('#fwSearchInput', '#fwSearchPop', '#fwSearchBtn');
  $('#fundFlowTable') && $('#fundFlowTable').addEventListener('click', (e) => {
    const row = e.target.closest('[data-fund-code]');
    if (row) openFund(row.dataset.fundCode, row.dataset.fundName, row.dataset.fundType);
  });
  $('#fundWatchTable') && $('#fundWatchTable').addEventListener('click', (e) => {
    const action = e.target.closest('[data-fund-action]');
    if (action) {
      e.stopPropagation();
      const code = action.dataset.code;
      const type = action.dataset.fundAction;
      if (type === 'detail') {
        const item = state.fundWatchlist.find((f) => f.code === code);
        openFund(code, item && item.name, item && item.type);
      }
      if (type === 'up') moveFund(code, -1);
      if (type === 'down') moveFund(code, 1);
      if (type === 'remove') removeFund(code);
      if (type === 'hold') openFundHoldEditor(code, action.dataset.name || code);
      return;
    }
    const row = e.target.closest('[data-fund-code]');
    if (row) openFund(row.dataset.fundCode, row.dataset.fundName, row.dataset.fundType);
  });
  $('#fundHoldTable') && $('#fundHoldTable').addEventListener('click', (e) => {
    const action = e.target.closest('[data-hold-action]');
    if (!action) return;
    e.stopPropagation();
    const code = action.dataset.code;
    const name = action.dataset.name || code;
    if (action.dataset.holdAction === 'edit') openFundHoldEditor(code, name);
    if (action.dataset.holdAction === 'delete') deleteFundHolding(code, name);
  });
  $('#fundExport') && $('#fundExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), funds: state.fundWatchlist }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `global-pulse-funds-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出自选基金', 'ok');
  });
  $('#fundSync') && $('#fundSync').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const meta = portfolioMeta();
    if (meta.pending) {
      const ok = window.confirm('本机还有未同步的持仓改动。\n「从服务端恢复」会用服务端那份覆盖本机未同步的改动（服务端已保存的仓位不会丢）。\n\n继续？');
      if (!ok) return;
    }
    btn.disabled = true;
    btn.textContent = '读取中…';
    try {
      await adoptServerPortfolio({ silent: false });
      renderFundSyncState();
    } catch (err) {
      toast(`恢复失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '从服务端恢复';
    }
  });

  $('#watchFundSort') && $('#watchFundSort').addEventListener('change', (e) => {
    state.watchFundSort = e.target.value;
    renderFundWatchTable();
  });

  // v2.8.0：盈亏曲线区间切换（近1年 / 近半年 / 近3月）
  $('#fundPnlRangeSeg') && $('#fundPnlRangeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pnl-range]');
    if (!btn) return;
    state.fundPnlRange = btn.dataset.pnlRange;
    $$('#fundPnlRangeSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderFundPnl();
  });

  /* ---------- v2.10.0：多份持仓组合 / 今日 TOP5 / 盈亏日历 / 组合 vs 上证 ---------- */
  $('#fundPortfolioTabs') && $('#fundPortfolioTabs').addEventListener('click', (e) => {
    const add = e.target.closest('[data-portfolio-add]');
    if (add) { openPortfolioCreate(); return; }
    const rename = e.target.closest('[data-portfolio-rename]');
    if (rename) { openPortfolioRename(); return; }
    const del = e.target.closest('[data-portfolio-delete]');
    if (del) { deleteActivePortfolio(); return; }
    const adjust = e.target.closest('[data-portfolio-adjust]');
    if (adjust) { openPortfolioAdjust(); return; }
    const tab = e.target.closest('[data-portfolio-tab]');
    if (!tab) return;
    if (tab.dataset.portfolioTab === state.activePortfolioId) return;
    switchPortfolio(tab.dataset.portfolioTab);
  });

  $('#fundTopMoversSeg') && $('#fundTopMoversSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-top-movers]');
    if (!btn) return;
    state.topMoversTab = btn.dataset.topMovers === 'loss' ? 'loss' : 'profit';
    renderFundTopMovers();
  });

  $('#fundCalendarUnitSeg') && $('#fundCalendarUnitSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-calendar-unit]');
    if (!btn) return;
    state.pnlUnit = ['day', 'month', 'year'].includes(btn.dataset.calendarUnit) ? btn.dataset.calendarUnit : 'day';
    renderFundPnlCalendar();
  });
  $('#fundCalendarMetricSeg') && $('#fundCalendarMetricSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-calendar-metric]');
    if (!btn) return;
    state.pnlMetric = btn.dataset.calendarMetric === 'rate' ? 'rate' : 'amount';
    renderFundPnlCalendar();
  });
  $('#fundCalendarNav') && $('#fundCalendarNav').addEventListener('click', (e) => {
    const shift = e.target.closest('[data-calendar-shift]');
    if (shift) {
      const dir = Number(shift.dataset.calendarShift) >= 0 ? 1 : -1;
      const base = state.pnlYearMonth || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
      const [y, m] = base.split('-').map((x) => Number(x));
      const next = new Date(Date.UTC(y, m - 1 + dir, 1));
      state.pnlYearMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
      renderFundPnlCalendar();
      return;
    }
    const yShift = e.target.closest('[data-calendar-year-shift]');
    if (yShift) {
      const dir = Number(yShift.dataset.calendarYearShift) >= 0 ? 1 : -1;
      const cur = Number(state.pnlCalendarYear) || Number((state.pnlYearMonth || '').slice(0, 4)) || new Date().getFullYear();
      state.pnlCalendarYear = String(cur + dir);
      renderFundPnlCalendar();
    }
  });

  $('#fundRangeSeg') && $('#fundRangeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fund-range]');
    if (!btn) return;
    state.fundRange = ['today', 'week', 'month', 'year', 'all'].includes(btn.dataset.fundRange) ? btn.dataset.fundRange : 'today';
    renderFundVsIndex();
    if (state.fundRange === 'today') loadFundIntradayCompare();
  });

  $('#cnIndexSeg') && $('#cnIndexSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-secid]');
    if (!btn) return;
    state.cnIndex = btn.dataset.secid;
    state.cnStock = null;
    state.cnKline = null;
    state.cnZoom = null;
    $$('#cnIndexSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    loadChinaStock(true);
    loadChinaChart(true);
  });

  $('#cnKltSeg') && $('#cnKltSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-klt]');
    if (!btn) return;
    state.cnKlt = Number(btn.dataset.klt);
    state.cnKline = null;
    state.cnZoom = null;
    $$('#cnKltSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    loadChinaChart(true);
  });

  $('#usIndexCards') && $('#usIndexCards').addEventListener('click', (e) => {
    const card = e.target.closest('[data-us-secid]');
    if (!card) return;
    state.usIndex = card.dataset.usSecid;
    state.usKline = null;
    renderUS();
    loadUSChart(true);
  });

  $('#globalRegionSeg') && $('#globalRegionSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-region]');
    if (!btn) return;
    state.globalRegion = btn.dataset.region;
    $$('#globalRegionSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderGlobalTable();
  });

  $('#globalTable') && $('#globalTable').addEventListener('click', (e) => {
    const row = e.target.closest('[data-global-secid]');
    if (!row) return;
    state.globalIndex = row.dataset.globalSecid;
    renderGlobalTable();
    loadGlobalChart(true);
  });

  $('#comSeg') && $('#comSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-secid]');
    if (!btn) return;
    state.comSecid = btn.dataset.secid;
    state.comKline = null;
    $$('#comSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    loadCommodityChart(true);
  });

  $('#comPeriodSeg') && $('#comPeriodSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-com-days]');
    if (!btn) return;
    state.comDays = Number(btn.dataset.comDays) || 260;
    $$('#comPeriodSeg button').forEach((b) => b.classList.toggle('is-active', b === btn));
    loadCommodityChart(true);
  });

  $('#riskSeg') && $('#riskSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-risk]');
    if (!btn) return;
    state.settings.risk = btn.dataset.risk;
    saveSettings();
    syncRiskSeg();
    loadAdvice(true);
    loadWatchData(true);
    loadFundWatch(true);
    if (state.cnStock) loadChinaStock(true);
  });

  $('#refreshBtn') && $('#refreshBtn').addEventListener('click', () => refreshAll(true));
  $('#autoRefresh') && $('#autoRefresh').addEventListener('change', (e) => {
    state.settings.autoRefresh = e.target.checked;
    saveSettings();
    startTimers();
    toast(state.settings.autoRefresh ? '自动刷新已开启' : '自动刷新已关闭', 'info');
  });
  $('#settingsBtn') && $('#settingsBtn').addEventListener('click', openSettings);
  $('#sourceChip') && $('#sourceChip').addEventListener('click', openSourceStatus);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-source-open]')) openSourceStatus();
    if (e.target.closest('[data-source-dismiss]')) {
      sessionStorage.setItem('gp.sourceBannerDismissed', String(Date.now()));
      const el = $('#sourceBanner');
      if (el) el.hidden = true;
    }
  });

  const searchInput = $('#searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      const q = e.target.value;
      searchTimer = setTimeout(() => runSearch(q), 230);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { $('#searchPop').hidden = true; searchInput.blur(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!state.searchItems.length) return;
        state.searchIndex = (state.searchIndex + (e.key === 'ArrowDown' ? 1 : -1) + state.searchItems.length) % state.searchItems.length;
        renderSearchPop();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = state.searchItems[state.searchIndex] || state.searchItems[0];
        chooseSearchItem(item);
      }
    });
    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim()) runSearch(searchInput.value);
    });
  }
  $('#searchPop') && $('#searchPop').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-search-secid]');
    if (!btn) return;
    chooseSearchItem({ secid: btn.dataset.searchSecid, code: btn.dataset.searchCode, name: btn.dataset.searchName });
  });

  const addWatchInput = $('#watchAddInput');
  const addWatchBtn = $('#watchAddBtn');
  const addFromInput = async () => {
    const q = addWatchInput ? addWatchInput.value.trim() : '';
    if (!q) { toast('请输入股票代码或名称', 'warn'); return; }
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`, 9000);
      const item = (data.items || [])[0];
      if (!item) { toast('没有找到匹配的股票', 'warn'); return; }
      addWatch(item);
      addWatchInput.value = '';
    } catch (err) { toast(`搜索失败：{err.message}`, 'err'); }
  };
  addWatchBtn && addWatchBtn.addEventListener('click', addFromInput);
  addWatchInput && addWatchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFromInput(); });
  $('#exportWatch') && $('#exportWatch').addEventListener('click', exportAll);

  $('#watchTable') && $('#watchTable').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-watch-action]');
    if (!btn) return;
    e.stopPropagation();
    const secid = btn.dataset.secid;
    if (btn.dataset.watchAction === 'chart') openStock(secid);
    if (btn.dataset.watchAction === 'up') moveWatch(secid, -1);
    if (btn.dataset.watchAction === 'down') moveWatch(secid, 1);
    if (btn.dataset.watchAction === 'alert') {
      const item = state.watchlist.find((w) => w.secid === secid);
      openStock(secid, item && item.code, item && item.name);
    }
    if (btn.dataset.watchAction === 'remove') removeWatch(secid);
  });

  // 拖拽排序（桌面 HTML5 + 手机长按）已改由 bindWatchDrag 在渲染时绑定，
  // 因为 v2.7.0 起自选股是表格式列表（行 = tr[data-drag-secid]）。

  $('#sectorSearch') && $('#sectorSearch').addEventListener('input', (e) => {
    state.sectorQuery = e.target.value;
    renderSectorTable();
  });
  $('#sectorSort') && $('#sectorSort').addEventListener('change', (e) => {
    state.sectorSort = e.target.value;
    renderSectorTable();
  });

  const convUsd = $('#convUsd');
  const convRate = $('#convRate');
  [convUsd, convRate].forEach((el) => el && el.addEventListener('input', () => {
    state.convTouched = true;
    calcConverter();
  }));

  window.addEventListener('resize', debounce(resizeCharts, 180));
  window.addEventListener('popstate', () => {
    const route = parseHashRoute();
    if (route.detail) {
      openDetailRoute(route.detail);
      return;
    }
    closeOverlay();
    showView(route.view);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.settings.autoRefresh) refreshFast();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault();
      $('#searchInput').focus();
    }
    if (e.key === 'Escape') {
      if ($('#overlayRoot').children.length) closeOverlay();
      else if ($('#searchPop')) $('#searchPop').hidden = true;
    }
  });

  document.addEventListener('click', (e) => {
    const box = $('#searchBox');
    if (box && !box.contains(e.target) && $('#searchPop')) $('#searchPop').hidden = true;
    const fundWrap = e.target.closest('.fund-search-wrap');
    if (!fundWrap) {
      if ($('#fundSearchPop')) $('#fundSearchPop').hidden = true;
      if ($('#fwSearchPop')) $('#fwSearchPop').hidden = true;
    }
  });
}


/* =========================================================
   启动
   ========================================================= */
// 账号状态：填充当前用户、绑定退出登录；未登录时服务端会把页面 302 到登录页。
/* ---------------------------------------------------------
   管理员面板 & 更新履历
   --------------------------------------------------------- */
function adminEsc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(sec) {
  const n = Number(sec) || 0;
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

async function openChangelog() {
  let versions = [];
  try {
    const data = await api('/api/changelog', 8000);
    versions = data.versions || [];
  } catch (err) {
    toast(`读取更新履历失败：${err.message}`, 'err');
    return;
  }
  const items = versions
    .map(
      (v) => `
    <div class="changelog-item">
      <div class="changelog-head">
        <span class="changelog-ver">v${adminEsc(v.version)}</span>
        <span class="changelog-date">${adminEsc(v.date || '')}</span>
        <b class="changelog-title">${adminEsc(v.title || '')}</b>
      </div>
      <ul>${(v.items || []).map((i) => `<li>${adminEsc(i)}</li>`).join('')}</ul>
    </div>`,
    )
    .join('');
  mountOverlay(`
    <div class="drawer changelog-drawer">
      <div class="drawer-head"><div><div class="eyebrow">CHANGELOG</div><h2>更新履历</h2></div><button class="modal-close" data-close>×</button></div>
      <div class="changelog-list">${items || '<div class="empty">暂无记录</div>'}</div>
    </div>`);
}

async function openAdmin() {
  let users = [];
  let sys = null;
  try {
    const [u, s] = await Promise.all([api('/api/admin/users', 10000), api('/api/admin/system', 20000)]);
    users = u.users || [];
    sys = s;
  } catch (err) {
    toast(`读取系统状态失败：${err.message}`, 'err');
    return;
  }

  const sysRows = Object.entries(sys.services || {})
    .map(([k, v]) => `<div class="admin-kv"><span>${adminEsc(k)}</span><b class="${v === 'active' ? 'ok' : 'bad'}">${adminEsc(v)}</b></div>`)
    .join('');
  const timerRows = Object.entries(sys.timers || {})
    .map(([k, v]) => `<div class="admin-kv"><span>${adminEsc(k)}</span><b class="${v === 'active' ? 'ok' : 'bad'}">${adminEsc(v)}</b></div>`)
    .join('');
  const backupRows =
    (sys.backups || [])
      .slice(0, 5)
      .map((b) => `<div class="admin-commit"><code>${adminEsc(b)}</code></div>`)
      .join('') || '<div class="empty">暂无备份</div>';
  const userRows = users
    .map(
      (u) => `
    <div class="admin-user">
      <div><b>${adminEsc(u.username)}</b>${u.primary ? ' <span class="badge">主账号</span>' : ''}</div>
      <div class="admin-user-role">
        <select data-role-user="${adminEsc(u.id)}" ${u.primary ? 'disabled' : ''}>
          <option value="user" ${u.role === 'user' ? 'selected' : ''}>普通用户</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理员</option>
        </select>
      </div>
    </div>`,
    )
    .join('');

  mountOverlay(`
    <div class="drawer admin-drawer">
      <div class="drawer-head"><div><div class="eyebrow">SYSTEM ADMIN</div><h2>系统管理</h2></div><button class="modal-close" data-close>×</button></div>

      <div class="setting-group">
        <h3>账号与权限</h3>
        <p class="setting-note">管理员可以修改设置、管理用户；普通用户只能操作行情、自选与持仓。主账号必须保留管理员。</p>
        <div class="admin-users">${userRows}</div>
      </div>

      <div class="setting-group">
        <h3>NAS 部署状态</h3>
        <div class="admin-kv"><span>服务版本</span><b>v${adminEsc(sys.version)}</b></div>
        <div class="admin-kv"><span>运行时长</span><b>${adminEsc(fmtDuration(sys.uptime))}</b></div>
        <div class="admin-kv"><span>最近部署</span><b>${adminEsc(sys.deployedAt || '-')}</b></div>
        <div class="admin-kv"><span>磁盘</span><b>${adminEsc(sys.disk || '-')}</b></div>
        <div class="admin-sub">服务</div>${sysRows || '<div class="empty">本机非 Linux 部署</div>'}
        <div class="admin-sub">定时任务</div>${timerRows}
        <div class="admin-sub">最近备份</div>${backupRows}
      </div>

      <div class="setting-group">
        <h3>GitHub 提交</h3>
        <div class="admin-kv"><span>仓库</span><b><a href="${adminEsc(safeUrl(sys.repo))}" target="_blank" rel="noreferrer">${adminEsc(sys.repo)}</a></b></div>
        <div id="adminCommits"><div class="empty">正在读取…</div></div>
      </div>
    </div>`);

  document.querySelectorAll('[data-role-user]').forEach((sel) => {
    sel.addEventListener('change', async (ev) => {
      const id = ev.target.getAttribute('data-role-user');
      const role = ev.target.value;
      try {
        await apiPost('/api/admin/users/role', { id, role });
        toast('权限已更新', 'ok');
      } catch (err) {
        toast(`修改失败：${err.message}`, 'err');
        ev.target.value = role === 'admin' ? 'user' : 'admin';
      }
    });
  });

  const box = document.getElementById('adminCommits');
  try {
    const res = await fetch('https://api.github.com/repos/ufomhb/GP_Software/commits?per_page=5', { cache: 'no-store' });
    if (res.ok && box) {
      const list = await res.json();
      box.innerHTML = list
        .map(
          (c) =>
            `<div class="admin-commit"><code>${adminEsc(c.sha.slice(0, 7))}</code> ${adminEsc((c.commit.message || '').split('\n')[0])} <span class="muted">${adminEsc((c.commit.author && c.commit.author.date) || '')}</span></div>`,
        )
        .join('');
    } else if (box) {
      box.innerHTML = '<div class="empty">GitHub API 不可达（网络限制），点上方链接直接查看</div>';
    }
  } catch {
    if (box) box.innerHTML = '<div class="empty">GitHub API 不可达（网络限制），点上方链接直接查看</div>';
  }
}

async function loadAuthState() {
  try {
    const data = await api('/api/auth/me', 8000);
    const user = data && data.user;
    if (!user) {
      redirectToLogin();
      return null;
    }
    state.auth = user;
    const nameEl = $('#accountName');
    const chip = $('#accountChip');
    if (nameEl) nameEl.textContent = user.username;
    if (chip) {
      chip.hidden = false;
      chip.title = '账号设置：账号信息、修改密码、后台管理与退出登录';
      // 名字点开「账号」抽屉；齿轮才是刷新/风险/通知等偏好设置，两者不再重复。
      chip.addEventListener('click', openAccount);
    }
    // 设置只含个人偏好（刷新、风险、通知、数据），所有登录用户都能打开；系统级配置在 /admin.html。
    const settingsBtn = $('#settingsBtn');
    if (settingsBtn) settingsBtn.hidden = false;
    // 更新履历所有登录用户都能看
    const changelogBtn = $('#changelogBtn');
    if (changelogBtn) {
      changelogBtn.hidden = false;
      changelogBtn.addEventListener('click', openChangelog);
    }
    return user;
  } catch (err) {
    return null;
  }
}

async function init() {
  const authUser = await loadAuthState();
  if (!authUser) return; // 未登录：loadAuthState 已跳转登录页
  applyAccountScope(authUser);
  migrateLegacyStore(authUser);
  loadScopedState();
  // v2.10.0：先把本机缓存的组合坐实（选中组合决定 state.fundHoldings 是哪一份）
  settleActivePortfolio(state.activePortfolioId);
  // v2.10.0：先读「界面管理」配置，再决定基金页哪些子页可见（失败按内置默认）
  await loadUiConfig();
  $('#buildVersion') && ($('#buildVersion').textContent = `v${APP_VERSION}`);
  $('#autoRefresh').checked = state.settings.autoRefresh;
  syncRiskSeg();
  bindEvents();
  bindBattleEvents();
  syncKlineSegs();
  renderAlerts();
  renderWatchTips();
  // 云端预警与模拟交易：登录后拉一次，切到自选页会再刷新
  loadCloudAlerts();
  renderClock();
  setInterval(renderClock, 1000);
  startActivityPing();
  startTimers();
  loadSourceStatus();

  // 首屏路由：既支持 #china 这类视图，也支持 #/stock/1.600519 这类详情深链
  const bootRoute = parseHashRoute();
  const params = new URLSearchParams(location.search);
  const legacyFundWatch = params.get('fundview') === 'watch';
  const initial = legacyFundWatch
    ? 'fundwatch'
    : (bootRoute.detail ? (DETAIL_BASE_VIEW[bootRoute.detail.kind] || 'dashboard') : bootRoute.view);
  state.view = initial;
  $$('.nav-tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === initial));
  $$('.view').forEach((section) => section.classList.toggle('is-active', section.id === `view-${initial}`));

  await loadOverview();
  loadSectors('industry');
  loadNews();
  loadAdvice();
  loadWatchData();
  loadHeroSeries().then(() => renderHero());
  setTimeout(loadMiniSeries, 1600);
  // v2.8.0：?fundview=watch 已迁移成「自选基金」板块，其余 fundview 取值仍留在基金页
  if (['flow', 'stock', 'sector', 'bond', 'openflow', 'proxy', 'theme', 'dist', 'openfund'].includes(params.get('fundview'))
    && fundModuleVisible(params.get('fundview'))) {
    state.fundView = params.get('fundview');
  }
  // v2.9.2：每次启动都和服务端对齐一次（不再只在「新设备」才拉），
  // 这样在另一台设备/线上改过的持仓会被拉回来，本机未同步的改动也会被推上去。
  await reconcilePortfolioOnBoot();
  renderFundSyncState();
  loadView(initial);

  if (params.get('stock')) setTimeout(() => openStock(params.get('stock')), 1800);
  if (params.get('sector')) setTimeout(() => openSector(params.get('sector')), 1800);
  if (params.get('fund')) setTimeout(() => openStockFund(params.get('fund')), 1800);
  // 详情深链（#/stock/1.600519 等）：等首屏数据就绪后再打开弹窗
  if (bootRoute.detail) setTimeout(() => openDetailRoute(bootRoute.detail), 1200);
}

// 测试开关：设置 globalThis.__GP_NO_AUTOBOOT__ 后只加载模块（供 test/dom-smoke 直接调渲染函数）
if (!globalThis.__GP_NO_AUTOBOOT__) {
  init().catch((err) => {
    console.error(err);
    toast(`初始化失败：${err.message}`, 'err', 8000);
  });
}

// 仅供测试直接调用的渲染函数；生产页面用不到这些导出（ESM 导出不影响浏览器加载）
export {
  state, esc, safeUrl, cleanName,
  renderNewsList, renderRankTable, renderRanks,
  renderHero, renderIndexGrid, renderSectorPanel, renderPulse, renderWatchTable,
  dataStamp, lastTradeDateText,
  openAccount, openSettings, bindTouchReorder,
  renderFundWatchSummary, renderFundWatchTable,
  renderFundHoldSummary, renderFundHoldTable, renderFundSummary,
  fundEstimateCell, fundDayPctCell,
  renderPortfolioAdvice,
  // 预警 / K 线选项的纯逻辑，供 dom-smoke 与单元测试直接调用
  evalAlertRule, alertConditionText, currentIndicator, currentFqt,
  parseHashRoute, detailHash, normalizeAlerts, syncKlineSegs, renderAlerts,
  // 详情弹窗（v2.4.1：A 股弹窗加宽 + 美股分时详情）供回归测试直接渲染
  renderStockModal, renderUsStockModal, usPointsFor, usHotItemOf, renderUS,
  // 数据中心（阶段 2）
  switchDataTab, renderLonghu, renderCalendar, renderConvertibles, renderScreener,
  // 阶段 2.4 / 3.3：云端预警与模拟交易面板
  renderPaper, loadCloudAlerts,
  // v2.8.0：自选基金盈亏统计与模拟账户排行榜
  loadFundPnl, renderFundPnl, computeFundPnl, loadPaperRanking, renderPaperRanking,
  // v2.9.0：模拟买卖弹窗（搜索 / 比例 / 报价与分时）与盈亏口径统一的共用函数
  openPaperTrade, paperRatioShares, paperHeldShares, renderPaperQuote, renderPaperPreview,
  paperValidateShares, paperLotOf,
  fundPortfolio,
  // v2.7.0：叠层（个股详情之上再开 F10 / 资讯）与席位明细区块
  mountOverlay, pushOverlay, topLayer, closeOverlay, renderSeatsBlock, openStrategyInNewTab,
  // v2.10.0：基金页新增子页 + 自选基金多组合 / 盈亏日历 / 组合对比（供 dom-smoke 直接渲染与断言）
  renderFundDistribution, renderFundThemeOverview, renderFundBoard,
  renderPortfolioTabs, renderFundTopMovers, renderFundPnlCalendar, renderFundVsIndex,
  activePortfolio, activeHoldings, switchPortfolio, settleActivePortfolio,
  applyFundModuleVisibility, fundModuleVisible, visibleFundViews, loadUiConfig,
  computeFundDailyPnl, fundCalendarBuckets, portfolioVsIndex, intradayVsIndex, fundTopMovers,
  // v2.10.3：持仓调整 / 删除（后台回收站可恢复）
  openPortfolioAdjust, savePortfolioHoldingsBatch, saveFundHolding, deleteFundHolding, commitPortfolioHoldings,
  init,
};

