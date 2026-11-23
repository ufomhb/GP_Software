/* 前端核心状态（P2 从 app.js 抽出）
   版本号、本地存储键、账号命名空间、按账号读写的 localStorage、全局 state。
   视图模块可以 import { state } 与这些读写函数，不再依赖 app.js。 */

const APP_VERSION = '2.12.0';

// v2.11.0：模拟交易的逐日盈亏（盈亏日历 / 资产曲线）与个股累计已实现收益。
// 服务端 /api/paper/pnl 给「首笔成交以来」的逐日行，前端只负责叠加今日实时点。
const PAPER_PNL_DEFAULT_DAYS = 800;

// v2.10.7：v2.10.0 之前的版本不记建仓日，老持仓统一按 2026-11-01 作为建仓日（用户 2026-11-22 要求）。
// 与服务端 lib/store.js 的 LEGACY_ADDED_AT 保持一致；盈亏日历 / 统计都按它裁剪。
const LEGACY_ADDED_DATE = '2026-11-01';

const WATCH_KEY = 'gp.watchlist.v1';
const ALERTS_KEY = 'gp.alerts.v1';
const SETTINGS_KEY = 'gp.settings.v1';
const FUND_WATCH_KEY = 'gp.fundWatchlist.v1';
const FUND_HOLD_KEY = 'gp.fundHoldings.v1';
// v2.10.0：当前选中的持仓组合（多份持仓 TAB），按账号命名空间存放
const ACTIVE_PORTFOLIO_KEY = 'gp.activePortfolio.v1';
// v2.10.0：多份持仓组合的本机缓存（服务端 /api/portfolio 的 portfolios 是唯一真源，这里只做离线兜底）
const PORTFOLIOS_KEY = 'gp.portfolios.v1';
const MONITOR_SECTORS_KEY = 'gp.monitorSectors.v1';
// v2.9.2：持仓同步元信息（服务端 rev / 本机最后保存时间 / 待同步标记），按账号命名空间存放
const PORTFOLIO_META_KEY = 'gp.portfolioMeta.v1';
const PORTFOLIO_PENDING_KEY = 'gp.portfolioPending.v1';

const DEFAULT_WATCH = [
  { secid: '1.600519', code: '600519', name: '贵州茅台' },
  { secid: '0.300750', code: '300750', name: '宁德时代' },
  { secid: '1.601318', code: '601318', name: '中国平安' },
  { secid: '0.000858', code: '000858', name: '五粮液' },
  { secid: '1.600036', code: '600036', name: '招商银行' },
];

const DEFAULT_FUNDS = [
  { code: '510300', name: '沪深300ETF华泰柏瑞', type: 'etf' },
  { code: '159915', name: '创业板ETF易方达', type: 'etf' },
  { code: '512690', name: '酒ETF鹏华', type: 'etf' },
  { code: '000001', name: '华夏成长混合', type: 'open' },
];

let STORE_SCOPE = '';

function scopedKey(key) {
  if (!STORE_SCOPE) return key;
  return String(key).replace(/^gp\./, `gp.${STORE_SCOPE}.`);
}

function applyAccountScope(user) {
  STORE_SCOPE = user && user.id ? String(user.id) : '';
}

// 旧版本没有账号命名空间：只把旧数据迁移给主账号，其它账号一律从空白开始。
function migrateLegacyStore(user) {
  if (!user || !user.primary) return;
  for (const key of [WATCH_KEY, ALERTS_KEY, SETTINGS_KEY, FUND_WATCH_KEY, FUND_HOLD_KEY, MONITOR_SECTORS_KEY]) {
    const scoped = scopedKey(key);
    if (scoped === key) continue;
    try {
      if (localStorage.getItem(scoped) === null && localStorage.getItem(key) !== null) {
        localStorage.setItem(scoped, localStorage.getItem(key));
      }
    } catch { /* 忽略隐私模式限制 */ }
  }
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(scopedKey(key));
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return val == null ? fallback : val;
  } catch {
    return fallback;
  }
}

function saveJSON(key, val) {
  try { localStorage.setItem(scopedKey(key), JSON.stringify(val)); } catch { /* 忽略隐私模式限制 */ }
}

/* =========================================================
   状态（所有视图共享）
   ========================================================= */
const state = {
  view: 'dashboard',
  auth: null,
  overview: null,
  news: null,
  advice: null,
  sectors: { industry: null, concept: null },
  sectorType: 'industry',
  sectorPageType: 'industry',
  sectorSort: 'main',
  sectorQuery: '',
  // 账号相关的数据在 init() 里按登录账号加载（loadScopedState），这里先留空。
  watchlist: [],
  alerts: [],
  fundWatchlist: [],
  fundHoldings: {},
  // v2.9.2：持仓与服务端的同步状态（rev / 本机保存时间 / 是否有未同步改动）
  portfolioMeta: { rev: 0, savedAt: 0, pending: false, serverLabel: '' },
  fundWatchData: null,
  watchFundSort: 'manual',
  fundFlow: null,
  fundView: 'sector',
  // v2.10.0：界面模块显隐（后台「界面管理」控制）与基金页新增子页的数据
  uiConfig: null,
  fundDist: null,
  fundDistScope: 'equity',
  fundThemes: null,
  fundThemeSort: 'day',
  fundThemeSortDir: 'desc',
  fundThemeDetail: null,
  fundThemeSector: '',
  fundThemeDetailDate: '',
  fundBoard: null,
  fundBoardTab: 'gain',
  fundBoardType: 'all',
  // v2.10.0：自选基金多份持仓 / 盈亏日历 / 组合对比
  portfolios: [],
  activePortfolioId: 'default',
  fundPnlDays: 800,
  pnlUnit: 'day',
  pnlMetric: 'amount',
  pnlYearMonth: '',
  pnlCalendarYear: '',
  topMoversTab: 'profit',
  fundRange: 'today',
  fundIntraday: null,
  fundIntradayLoading: false,
  fundFlowDir: 'inflow',
  fundCategory: 'all',
  openFlowCategory: 'all',
  openFlowData: null,
  proxyDir: 'inflow',
  proxyData: null,
  fundSearchItems: [],
  fundSectorSort: 'flow',
  fundSectorData: null,
  stockFundType: 'gp',
  stockFundSort: 'month',
  stockFund: null,
  stockFundIntel: null,
  bondFundSort: 'month',
  bondFund: null,
  compareFunds: [],
  settings: {
    autoRefresh: true,
    interval: 15,
    sound: true,
    notify: false,
    risk: 'balanced',
    // K 线副图指标：macd / kdj / boll / none
    indicator: 'macd',
    // K 线复权口径：0 不复权 / 1 前复权 / 2 后复权
    fqt: 1,
  },
  watchData: null,
  quotes: new Map(),
  miniSeries: {},
  miniLoaded: false,
  heroSeries: null,
  cnIndex: '1.000001',
  cnKlt: 1,
  cnStock: null,
  cnKline: null,
  cnZoom: null,
  cnAdvice: null,
  cnDistribution: null,
  cnIndexCompare: null,
  cnPeriod: null,
  csi300Ratio: null,
  usData: null,
  usKline: null,
  usIndex: '100.NDX',
  usPhase: 'pre',
  usPhaseTouched: false,
  usMinutes: null,
  usMinutesLoading: false,
  // 美股个股详情（v2.4.1）：当前分段与当前打开的标的
  usSeg: 'all',
  usStockModal: null,
  sectorPeriod: 'today',
  sectorPeriodData: { industry: {}, concept: {} },
  sectorLoadingPeriod: false,
  sectorCompare: false,
  globalIndex: '100.HSI',
  globalRegion: 'all',
  globalKline: null,
  comSecid: '101.GC00Y',
  comKline: null,
  comDays: 260,
  metalIntraday: null,
  metalIntradayLoading: false,
  ranks: { gain: [], loss: [], inflow: [], outflow: [] },
  klineCache: new Map(),
  loading: new Set(),
  errors: new Map(),
  lastUpdate: 0,
  countdown: 15,
  refreshing: false,
  searchItems: [],
  searchIndex: -1,
  // 当前打开的个股详情（用于指标 / 复权切换后原地重绘）
  stockModal: null,
  quoteMeta: null,
  sourceStatus: null,
  battle: null,
  battleTab: 'overview',
  battleSectors: null,
  battleMoves: null,
  battleLadder: null,
  battleTimeline: null,
  battleTenDay: null,
  battleTenDayDir: 'up',
  battleTenDayLoading: false,
  battleLoading: new Set(),
  battleSectorFilter: 'all',
  battleSectorQuery: '',
  battleSectorExpanded: null,
  sectorMembers: {},
  battleMoveList: 'all',
  battleMoveFilter: 'all',
  battleSectorLimit: 40,
  battleMoveLimit: 40,
  battleTenDayLimit: 30,
  battlePoller: null,
  monitorSectors: [],
  // 数据中心（阶段 2）：当前子页与各子页数据
  dataTab: 'longhu',
  longhu: null,
  longhuDate: '',
  calendarType: 'lift',
  calendar: null,
  cb: null,
  screener: null,
  screenerLoading: false,
  hk: null,
  hkDetail: null,
  // 阶段 2.4 / 3.3：云端预警与模拟交易
  cloudAlerts: null,
  paper: null,
  // v2.8.0：自选基金盈亏曲线（持仓口径）与模拟账户排行榜
  fundPnl: null,
  fundPnlRange: 'year',
  paperRank: null,
  paperRankSort: 'total',
  // v2.9.0：排行榜默认收起（用户要求「默认不显示，点按钮再展开」）
  paperRankOpen: false,
  // v2.11.0：模拟盘盈亏日历 / 资产曲线 / 个股累计收益 / 排行榜持仓详情
  paperPnl: null,
  paperPnlAt: 0,
  paperCalendarUnit: 'day',
  paperCalendarMetric: 'amount',
  paperCalendarYearMonth: '',
  paperCalendarYear: '',
  paperDetail: null,
  paperDetailAt: 0,
  // v2.12.0：模拟盘自动化 —— 委托 / 条件单 / 网格定投 / 跟单 / 持仓预警 / 复盘
  paperAutoTab: 'condition',
  paperReview: null,
  paperReviewAt: 0,
  paperReviewKey: '',
  paperReload: null,
  // v2.9.0：模拟买卖弹窗的当前标的与报价（打开弹窗时重置）
  paperTrade: null,
  tl: { events: [], playing: false, speed: 120, pos: 565, raf: null, last: 0, lastChart: 0 },
};

function loadScopedState() {
  const rawWatch = loadJSON(WATCH_KEY, DEFAULT_WATCH);
  const rawAlerts = loadJSON(ALERTS_KEY, []);
  const rawFunds = loadJSON(FUND_WATCH_KEY, DEFAULT_FUNDS);
  state.watchlist = (Array.isArray(rawWatch) ? rawWatch : [...DEFAULT_WATCH]).filter((w) => w && w.secid);
  state.alerts = normalizeAlerts(Array.isArray(rawAlerts) ? rawAlerts : []);
  state.fundWatchlist = (Array.isArray(rawFunds) ? rawFunds : [...DEFAULT_FUNDS]).filter((f) => f && f.code);
  state.fundHoldings = loadJSON(FUND_HOLD_KEY, {});
  if (!state.fundHoldings || typeof state.fundHoldings !== 'object' || Array.isArray(state.fundHoldings)) {
    state.fundHoldings = {};
  }
  // v2.10.0：多份持仓组合；本机缓存只是兜底，启动后会用服务端 /api/portfolio 覆盖
  const cachedPortfolios = loadJSON(PORTFOLIOS_KEY, null);
  state.portfolios = Array.isArray(cachedPortfolios) ? cachedPortfolios : [];
  state.activePortfolioId = String(loadJSON(ACTIVE_PORTFOLIO_KEY, 'default') || 'default');
  state.monitorSectors = loadJSON(MONITOR_SECTORS_KEY, []);
  if (!Array.isArray(state.monitorSectors)) state.monitorSectors = [];
  state.settings = {
    autoRefresh: true,
    interval: 15,
    sound: true,
    notify: false,
    risk: 'balanced',
    indicator: 'macd',
    fqt: 1,
    ...loadJSON(SETTINGS_KEY, {}),
  };
}

/* =========================================================
   预警规则（v2）
   ---------------------------------------------------------------
   v1 只有 { type:'above'|'below', price } 一种价格预警。
   v2 扩展为按 kind 分发的多条件规则，加载时自动迁移旧数据：
     price  价格突破 / 跌破             value = 价格
     pct    涨跌幅高于 / 低于            value = 百分比（可为负）
     volume 量比放大 / 缩量              value = 当日成交额 ÷ 近5日均额
     ma     均线上穿 / 下穿 MA20         无 value（趋势类）
     macd   MACD 金叉 / 死叉            无 value（趋势类）
   ========================================================= */
const ALERT_KINDS = ['price', 'pct', 'volume', 'ma', 'macd'];
const ALERT_KIND_LABEL = {
  price: '价格',
  pct: '涨跌幅',
  volume: '量比',
  ma: '均线穿越',
  macd: 'MACD 交叉',
};
const ALERT_OP_LABEL = {
  above: '↗ 突破',
  below: '↘ 跌破',
  golden: '金叉',
  dead: '死叉',
};

function isTrendAlert(kind) {
  return kind === 'ma' || kind === 'macd';
}

/** 把任意版本（v1 price 结构 / v2 kind 结构）的预警规范成 v2，坏数据直接丢弃 */
function normalizeAlerts(list, seq = 0) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((raw, i) => {
    if (!raw || !raw.secid) return;
    const kindRaw = raw.kind;
    let kind = ALERT_KINDS.includes(kindRaw) ? kindRaw : 'price';
    // v1 → v2：type 映射成 op，price 映射成 value
    let op = raw.op;
    let value = raw.value;
    if (!ALERT_KINDS.includes(kindRaw)) {
      op = raw.type === 'below' ? 'below' : 'above';
      value = Number(raw.price);
    }
    if (isTrendAlert(kind)) {
      op = op === 'dead' || op === 'below' ? 'dead' : 'golden';
      value = null;
    } else {
      op = op === 'below' ? 'below' : 'above';
      value = Number(value);
      if (!Number.isFinite(value)) return;
    }
    const secid = String(raw.secid);
    let id = raw.id ? String(raw.id) : `alert-${Date.now()}-${seq + i}`;
    if (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    out.push({
      id,
      secid,
      code: raw.code ? String(raw.code) : '',
      name: raw.name ? String(raw.name) : '',
      kind,
      op,
      value,
      active: raw.active !== false,
      createdAt: Number(raw.createdAt) || Date.now(),
      triggeredAt: Number(raw.triggeredAt) || null,
      triggeredPrice: Number.isFinite(Number(raw.triggeredPrice)) ? Number(raw.triggeredPrice) : null,
      triggerNote: raw.triggerNote ? String(raw.triggerNote).slice(0, 120) : '',
    });
  });
  return out;
}

export {
  APP_VERSION,
  LEGACY_ADDED_DATE,
  PAPER_PNL_DEFAULT_DAYS,
  WATCH_KEY, ALERTS_KEY, SETTINGS_KEY, FUND_WATCH_KEY, FUND_HOLD_KEY, MONITOR_SECTORS_KEY,
  ACTIVE_PORTFOLIO_KEY,
  PORTFOLIOS_KEY,
  PORTFOLIO_META_KEY, PORTFOLIO_PENDING_KEY,
  DEFAULT_WATCH, DEFAULT_FUNDS,
  scopedKey, applyAccountScope, migrateLegacyStore, loadJSON, saveJSON,
  state, loadScopedState,
  ALERT_KINDS, ALERT_KIND_LABEL, ALERT_OP_LABEL, normalizeAlerts, isTrendAlert,
};
