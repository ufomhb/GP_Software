/* 前端核心状态（P2 从 app.js 抽出）
   版本号、本地存储键、账号命名空间、按账号读写的 localStorage、全局 state。
   视图模块可以 import { state } 与这些读写函数，不再依赖 app.js。 */

const APP_VERSION = '2.1.0';

const WATCH_KEY = 'gp.watchlist.v1';
const ALERTS_KEY = 'gp.alerts.v1';
const SETTINGS_KEY = 'gp.settings.v1';
const FUND_WATCH_KEY = 'gp.fundWatchlist.v1';
const FUND_HOLD_KEY = 'gp.fundHoldings.v1';
const MONITOR_SECTORS_KEY = 'gp.monitorSectors.v1';

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
  fundWatchData: null,
  watchFundSort: 'manual',
  fundFlow: null,
  fundView: 'sector',
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
  tl: { events: [], playing: false, speed: 120, pos: 565, raf: null, last: 0, lastChart: 0 },
};

function loadScopedState() {
  const rawWatch = loadJSON(WATCH_KEY, DEFAULT_WATCH);
  const rawAlerts = loadJSON(ALERTS_KEY, []);
  const rawFunds = loadJSON(FUND_WATCH_KEY, DEFAULT_FUNDS);
  state.watchlist = (Array.isArray(rawWatch) ? rawWatch : [...DEFAULT_WATCH]).filter((w) => w && w.secid);
  state.alerts = (Array.isArray(rawAlerts) ? rawAlerts : []).filter((a) => a && a.secid);
  state.fundWatchlist = (Array.isArray(rawFunds) ? rawFunds : [...DEFAULT_FUNDS]).filter((f) => f && f.code);
  state.fundHoldings = loadJSON(FUND_HOLD_KEY, {});
  if (!state.fundHoldings || typeof state.fundHoldings !== 'object' || Array.isArray(state.fundHoldings)) {
    state.fundHoldings = {};
  }
  state.monitorSectors = loadJSON(MONITOR_SECTORS_KEY, []);
  if (!Array.isArray(state.monitorSectors)) state.monitorSectors = [];
  state.settings = {
    autoRefresh: true,
    interval: 15,
    sound: true,
    notify: false,
    risk: 'balanced',
    ...loadJSON(SETTINGS_KEY, {}),
  };
}

export {
  APP_VERSION,
  WATCH_KEY, ALERTS_KEY, SETTINGS_KEY, FUND_WATCH_KEY, FUND_HOLD_KEY, MONITOR_SECTORS_KEY,
  DEFAULT_WATCH, DEFAULT_FUNDS,
  scopedKey, applyAccountScope, migrateLegacyStore, loadJSON, saveJSON,
  state, loadScopedState,
};
