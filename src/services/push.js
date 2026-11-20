'use strict';
/**
 * 推送子系统（P2 从 server.js 外移，2026-11-15）
 *
 * 负责：推送配置的读写与归一化、持仓聚合、策略/净值报告生成、渠道发送、时段调度、/api/push/* 路由。
 * 依赖由 createPushService 注入，模块本身不直接碰 server.js 的全局状态，便于单测。
 *
 * 约定：
 * - 时段判定按东八区（pushClock），14:30 策略 / 19:30 净值；weekdaysOnly 为真时周末跳过。
 * - 同一时段每天只发一次（lastSent 记账），错过超过 6 小时不补发。
 * - webhook 出站地址必须过 assertSafeOutboundUrl（https + 非内网）。
 */
const { assertSafeOutboundUrl } = require('../lib/net-safety');

/**
 * 策略规则参数（2026-11-17）：原先写死在 classifyPortfolio 的数字提出来，做成可调参数。
 * 后台「持仓策略」页面调整后，推送与「按天记录」都立即使用新参数，
 * 次日评价再用新参数的效果做验证 —— 这就是「不断改进策略」的闭环。
 */
const DEFAULT_STRATEGY_RULES = {
  addScore: 65,              // 评分 ≥ addScore 且当日跌幅 ≥ addDip 才建议加仓
  addDip: 1.2,               // 加仓需要的当日跌幅（正数表示跌多少）
  strongScore: 80,           // 评分 ≥ strongScore 且跌幅 ≥ strongDip 时加 10%（否则 5%）
  strongDip: 2,
  cutScore: 45,              // 评分 < cutScore 且（涨 ≥ cutRise 或 跌 ≥ cutDip）才建议减仓
  cutRise: 0.8,
  cutDip: 1.2,
  weakScore: 35,             // 评分 < weakScore 用强信号比例，否则常规比例
  baseRatio: 10,             // 常规加/减比例（%，10 = 1 成；用户要求最少 1 成起）
  strongRatio: 20,           // 强信号加/减比例（%，20 = 2 成）
  marketWeight: 1,           // 市场氛围对综合评分的权重（0=忽略，1=标准，2=加倍）
  concentrationPct: 40,      // 单只占比上限，超过则强制减仓
  concentrationTargetPct: 30,
  // v2.9.1 新增（回测数据支撑的过滤条件）
  addTrendConfirm: true,     // 加仓要求价格站稳 MA20 且趋势不是 down（不追跌）
  cutMaxDip: 3,              // 当日跌幅 ≥ 该值时不因弱评分减仓（不追跌，进「观察」）
  maxActionsPerDay: 3,       // 每天最多改几只（按信号强度取前 N，其余顺延）
  volNormalize: false,       // 是否把当日涨跌换算成 ATR 倍数再比阈值（债基/股基同标准）
};

function normalizeStrategyRules(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (key, min, max) => {
    const v = Number(src[key]);
    if (!Number.isFinite(v)) return DEFAULT_STRATEGY_RULES[key];
    return Math.min(max, Math.max(min, v));
  };
  const baseRatio = num('baseRatio', 10, 50);
  const strongRatio = Math.max(baseRatio, num('strongRatio', 10, 80));
  return {
    addScore: num('addScore', 40, 100),
    addDip: num('addDip', 0.2, 10),
    strongScore: num('strongScore', 60, 100),
    strongDip: num('strongDip', 0.5, 15),
    cutScore: num('cutScore', 5, 70),
    cutRise: num('cutRise', 0.1, 10),
    cutDip: num('cutDip', 0.2, 10),
    weakScore: num('weakScore', 5, 60),
    baseRatio,
    strongRatio,
    marketWeight: num('marketWeight', 0, 2),
    concentrationPct: num('concentrationPct', 20, 90),
    concentrationTargetPct: num('concentrationTargetPct', 10, 80),
    // v2.9.1：过滤条件（回测数据支撑）
    addTrendConfirm: src.addTrendConfirm === undefined
      ? DEFAULT_STRATEGY_RULES.addTrendConfirm
      : (src.addTrendConfirm === true || src.addTrendConfirm === '1' || src.addTrendConfirm === 1),
    cutMaxDip: num('cutMaxDip', 0.5, 10),
    maxActionsPerDay: Math.min(10, Math.max(1, Math.trunc(Number(src.maxActionsPerDay) || DEFAULT_STRATEGY_RULES.maxActionsPerDay))),
    volNormalize: src.volNormalize === true || src.volNormalize === '1' || src.volNormalize === 1,
  };
}

function createPushService(deps) {
  const {
    store, // dataStore：push_config 的读写
    loadUsers,
    loadPortfolio,
    savePortfolio,
    requireAdmin,
    currentUser,
    sanitizePortfolio,
    market, // { getFundWatch, shanghaiToday }
    getStrategyRules, // 可选：() => 策略规则参数（由后台页面调的参数持久化而来）
  } = deps;
  const { getFundWatch, shanghaiToday, getOverview, getKline } = market || {};

  // 每次取当前参数而不是缓存：后台调参后无需重启即生效
  function currentStrategyRules() {
    try {
      const fromConfig = typeof getStrategyRules === 'function' ? getStrategyRules() : null;
      return normalizeStrategyRules(fromConfig);
    } catch {
      return { ...DEFAULT_STRATEGY_RULES };
    }
  }

/* =========================================================
   微信定时推送（基金持仓策略）
   渠道：Server酱（方舟）/ PushPlus / 企业微信群机器人 / 自定义 webhook。
   自选基金与持仓由前端同步到 data/push-config.json；到点后由服务端
   生成当日策略并推送，不依赖浏览器是否打开。
   ========================================================= */
const pushNum = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '--');
const pushSigned = (v, d = 2) => (Number.isFinite(Number(v)) ? `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(d)}` : '--');
const PUSH_SLOT_DEFAULTS = [
  { key: 'strategy', label: '持仓策略（加仓/减仓/不变）', time: '14:30', enabled: true },
  { key: 'valuation', label: '当日基金净值/估值', time: '19:30', enabled: true },
];
const PUSH_DEFAULTS = {
  enabled: false,
  channel: 'serverchan',
  token: '',
  webhook: '',
  time: '14:30',
  weekdaysOnly: true,
  slots: PUSH_SLOT_DEFAULTS,
  funds: [],
  holdings: {},
  lastSent: {},
  lastResult: null,
};

// HH:MM 合法性：既要求两位格式，也要求 00:00–23:59（否则会算出 26:39 这种永远到不了的时段）
function isValidClockTime(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

// 兼容旧配置：单条 time + 字符串 lastSent 迁移成两个时段。
function normalizePushConfig(raw) {
  const cfg = { ...PUSH_DEFAULTS, ...(raw || {}) };
  // 注意看的是 raw.slots 而不是合并后的 cfg.slots：合并后永远有默认两段，
  // 会让「旧配置只有 time」这条迁移分支永远走不到。
  const rawSlots = raw && raw.slots;
  if (!Array.isArray(rawSlots) || !rawSlots.length) {
    cfg.slots = PUSH_SLOT_DEFAULTS.map((s) => ({ ...s }));
    if (raw && raw.time) cfg.slots[0].time = String(raw.time).slice(0, 5);
  } else {
    cfg.slots = cfg.slots
      .filter((s) => s && s.key)
      .map((s) => {
        const def = PUSH_SLOT_DEFAULTS.find((d) => d.key === s.key) || {};
        return {
          key: String(s.key),
          label: s.label || def.label || String(s.key),
          time: isValidClockTime(s.time) ? String(s.time).slice(0, 5) : (def.time || '19:30'),
          enabled: s.enabled !== false,
        };
      });
  }
  if (typeof cfg.lastSent === 'string') cfg.lastSent = {};
  if (!cfg.lastSent || typeof cfg.lastSent !== 'object' || Array.isArray(cfg.lastSent)) cfg.lastSent = {};
  return cfg;
}

function loadPushConfig() {
  // json 模式原样返回 push-config.json（含主账号 funds/holdings）；
  // sqlite 模式回落 data/gp.sqlite 的 push_config 单行（funds/holdings 在 portfolio_* 里）。
  return normalizePushConfig(store.loadPushConfig());
}

function savePushConfig(patch = {}) {
  const next = { ...loadPushConfig(), ...patch };
  try {
    store.savePushConfig(next);
  } catch (err) {
    throw new Error(`推送配置写入失败：${err.message}`);
  }
  return next;
}

function pushChannelHint(cfg) {
  const key = String((cfg && cfg.token) || '');
  if ((cfg && cfg.channel) === 'serverchan') {
    if (/^sctp/i.test(key)) {
      return '这是 Server酱³ 的 SendKey（sctp 开头）：消息只会进「Server酱³」App，不会进微信。要微信推送，请到 sct.ftqq.com 用微信扫码换一个 SCT 开头的 Turbo SendKey。';
    }
    if (/^SCT/i.test(key)) {
      return 'Server酱Turbo（SCT）：消息按控制台「消息通道」投递，默认是微信服务号，需要关注「方糖」公众号并在 sc.ftqq.com 绑定微信。';
    }
  }
  if ((cfg && cfg.channel) === 'serverchan') return 'SendKey 通常以 SCT / sctp 开头，请检查是否粘贴完整。';
  return '';
}

function maskPushConfig(cfg) {
  const mask = (v) => (v ? `${String(v).slice(0, 4)}****${String(v).slice(-4)}` : '');
  return { ...cfg, token: mask(cfg.token), webhook: mask(cfg.webhook) };
}

function pushChannelLabel(ch) {
  return { serverchan: 'Server酱', pushplus: 'PushPlus', wecom: '企业微信群机器人', custom: '自定义 webhook' }[ch] || ch;
}

async function collectPortfolio() {
  const cfg = loadPushConfig();
  // 持仓与自选统一从「主账号的 portfolio」取：json 模式下它来自 push-config.json，
  // sqlite 模式下来自 portfolio_* 表，两条路径对推送是同一份数据。
  const primaryUser = loadUsers().users.find((u) => u.primary) || null;
  const portfolio = primaryUser ? loadPortfolio(primaryUser) : { funds: [], holdings: {} };
  const codes = (portfolio.funds || []).map((f) => f && f.code).filter(Boolean);
  if (!codes.length) throw new Error('还没有同步自选基金，请先在基金页添加自选后再试');
  const watch = await getFundWatch(codes, 'balanced');
  const today = shanghaiToday();
  const items = (watch.items || []).filter((x) => x && x.code);
  const holdings = portfolio.holdings || {};
  const rows = [];
  let marketValue = 0;
  let costValue = 0;
  let dayProfit = 0;
  let dayValue = 0;
  for (const x of items) {
    const h = holdings[x.code];
    const shares = h ? Number(h.shares) : 0;
    const cost = h ? Number(h.cost) : 0;
    const price = Number(x.price);
    // 只有「今天」的涨跌才参与当日盈亏；昨天净值只留着展示，不能当成今天的。
    const fresh = Boolean(x.pctKind) && x.pctKind !== 'stale' && x.pct !== null && Number.isFinite(Number(x.pct));
    const pct = fresh ? Number(x.pct) : null;
    const held = shares > 0 && Number.isFinite(price);
    const mv = held ? price * shares : null;
    // 决策口径（2026-11-18 用户要求）：持仓策略的「加/减/不变」只认 15:00 当日估值，
    // 绝不使用收盘后公布的真实净值。estimatePct 是 server.js 在 15:00 冻结的估值终值；
    // 场内 ETF 没有独立估值，收盘价本身就是它的当日涨跌，仍按当日口径使用。
    // 注意 Number(null) === 0：缺估值必须先显式判空，否则会把 null 当成 0% 估值。
    const estimatePct = x.estimatePct === null || x.estimatePct === undefined || x.estimatePct === ''
      ? null
      : (Number.isFinite(Number(x.estimatePct)) ? Number(x.estimatePct) : null);
    const estimateKind = String(x.estimateKind || '');
    const isMarketKind = x.pctKind === 'market';
    const decisionPct = estimatePct !== null
      ? estimatePct
      : (isMarketKind && fresh ? Number(pct) : null);
    const decisionKind = estimatePct !== null
      ? (estimateKind || 'estimate')
      : (isMarketKind ? 'market' : 'stale');
    if (held) {
      marketValue += mv;
      if (cost > 0) costValue += cost * shares;
      if (pct !== null) {
        dayProfit += (mv * pct) / (100 + pct);
        dayValue += mv;
      }
    }
    rows.push({
      code: x.code,
      name: x.name || x.code,
      type: x.type || 'open',
      price: Number.isFinite(price) ? price : null,
      pct,
      pctKind: x.pctKind || (fresh ? 'nav' : 'stale'),
      decisionPct,
      decisionKind,
      estimatePct,
      estimateKind,
      pctDate: x.pctDate || x.date || '',
      pctLabel: x.pctLabel || '',
      pctNote: x.pctNote || '',
      navDate: x.navDate || x.date || '',
      navPct: Number.isFinite(Number(x.navPct)) ? Number(x.navPct) : null,
      pctStale: Boolean(x.pctStale) || !fresh,
      held,
      shares: held ? shares : 0,
      cost: cost > 0 ? cost : null,
      marketValue: mv,
      profit: held && cost > 0 ? mv - cost * shares : null,
      weight: null,
      dayProfit: held && pct !== null ? (mv * pct) / (100 + pct) : null,
      advice: x.advice || null,
      date: x.date || '',
      estimateTime: x.estimateTime || '',
      today,
    });
  }
  for (const r of rows) {
    r.weight = marketValue > 0 && r.marketValue ? (r.marketValue / marketValue) * 100 : null;
  }
  const profit = costValue > 0 ? marketValue - costValue : null;
  const profitPct = costValue > 0 ? (profit / costValue) * 100 : null;
  const portfolioPct = dayValue > 0 ? (dayProfit / dayValue) * 100 : null;
  const pendingRows = rows.filter((r) => r.pctStale);
  const heldRows = rows.filter((r) => r.held);
  return {
    cfg,
    rows,
    heldRows,
    pendingRows,
    freshRows: rows.filter((r) => !r.pctStale),
    staleHeld: heldRows.filter((r) => r.pctStale),
    totals: {
      marketValue,
      costValue,
      dayProfit,
      dayValue,
      profit,
      profitPct,
      portfolioPct,
      held: heldRows.length,
      covered: rows.filter((r) => !r.pctStale).length,
    },
    today,
  };
}

function pushTone(pct) {
  if (!Number.isFinite(Number(pct))) return '⚪';
  if (Number(pct) >= 1.5) return '🔴';
  if (Number(pct) <= -1.5) return '🟢';
  return '⚪';
}

// ---- 14:30 档：分组动作 + 具体份额 + 明日展望 ----

// 盘面与外围快照（用于明日展望）
async function collectMarketPulse() {
  try {
    const ov = await getOverview();
    const cn = ov.cn || [];
    const find = (arr, code) => (arr || []).find((q) => q && q.code === code) || null;
    const glob = ov.global || [];
    const comm = ov.commodities || [];
    const fx = ov.fx || [];
    const sh = find(cn, '000001');
    const sz = find(cn, '399001');
    const cyb = find(cn, '399006');
    const kc50 = find(cn, '000688');
    const hs300 = find(cn, '000300');
    const b = ov.breadth || {};
    const amountYi = (Number(sh && sh.amountYi) || 0) + (Number(sz && sz.amountYi) || 0);
    const mainYi = cn.reduce((acc, q) => acc + (Number(q && q.mainYi) || 0), 0);
    let ma = null;
    try {
      const k = await getKline('1.000001', 101, 30);
      const cs = (k && k.candles) || [];
      if (cs.length >= 20) {
        const closes = cs.map((c) => Number(c.c));
        const avg = (n) => closes.slice(-n).reduce((a2, v) => a2 + v, 0) / n;
        ma = { ma5: avg(5), ma20: avg(20), low: Number(cs[cs.length - 1].l), high: Number(cs[cs.length - 1].h) };
      }
    } catch { /* 均线不可用不影响推送 */ }
    return {
      sh, sz, cyb, kc50, hs300,
      breadth: b,
      amountYi,
      mainYi,
      ndx: find(glob, 'NDX'),
      spx: find(glob, 'SPX'),
      dji: find(glob, 'DJIA'),
      hsi: find(glob, 'HSI'),
      n225: find(glob, 'N225'),
      dxy: find(glob, 'UDI'),
      xau: find(comm, 'XAU'),
      oil: find(comm, 'CL00Y'),
      cnh: find(fx, 'USDCNH'),
      ma,
    };
  } catch {
    return null;
  }
}

function pushPct(v) {
  if (!Number.isFinite(Number(v))) return '--';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

// 规则化明日展望：不预测点位，只给倾向、观察点与仓位建议。
function buildOutlook(pulse) {
  if (!pulse) return { verdict: '待定', score: 0, lines: ['### 📅 明日走势预估', '- 行情快照暂不可用，明天开盘前再看一次。'] };
  const b = pulse.breadth || {};
  const adv = Number(b.up);
  const dec = Number(b.down);
  let score = 0;
  const facts = [];
  const notes = [];
  if (Number.isFinite(pulse.sh && pulse.sh.pct)) {
    facts.push(`上证 ${pushNum(pulse.sh.price, 2)}（${pushPct(pulse.sh.pct)}）`);
    if (pulse.sh.pct <= -1) score -= 1;
    if (pulse.sh.pct >= 1) score += 1;
  }
  if (Number.isFinite(pulse.sz && pulse.sz.pct)) facts.push(`深证 ${pushPct(pulse.sz.pct)}`);
  if (Number.isFinite(pulse.cyb && pulse.cyb.pct)) facts.push(`创业板 ${pushPct(pulse.cyb.pct)}`);
  if (Number.isFinite(pulse.kc50 && pulse.kc50.pct)) facts.push(`科创50 ${pushPct(pulse.kc50.pct)}`);
  if (adv && dec) {
    const ratio = adv / (adv + dec);
    facts.push(`涨跌 ${adv}:${dec}`);
    if (ratio >= 0.6) { score += 2; notes.push(`涨跌家数 ${adv}:${dec}，多头占优`); }
    else if (ratio <= 0.35) { score -= 2; notes.push(`涨跌家数 ${adv}:${dec}，赚钱效应差，反弹需要成交量配合`); }
    else notes.push(`涨跌家数 ${adv}:${dec}，多空分歧`);
  }
  if (pulse.amountYi) facts.push(`两市成交 ${pushNum(pulse.amountYi, 0)} 亿`);
  if (pulse.mainYi) {
    facts.push(`主力 ${pushSigned(pulse.mainYi, 0)} 亿`);
    if (pulse.mainYi >= 50) score += 1;
    if (pulse.mainYi <= -50) score -= 1;
  }
  const ext = [];
  const pushExt = (label, q) => {
    if (q && Number.isFinite(Number(q.pct))) ext.push(`${label} ${pushPct(q.pct)}`);
  };
  pushExt('纳指', pulse.ndx);
  pushExt('标普', pulse.spx);
  pushExt('道指', pulse.dji);
  pushExt('恒生', pulse.hsi);
  pushExt('日经', pulse.n225);
  if (pulse.dxy && Number.isFinite(Number(pulse.dxy.price))) ext.push(`美元指数 ${pushNum(pulse.dxy.price, 2)}${Number.isFinite(Number(pulse.dxy.pct)) ? `(${pushPct(pulse.dxy.pct)})` : ''}`);
  pushExt('伦敦金', pulse.xau);
  pushExt('原油', pulse.oil);
  if (pulse.cnh && Number.isFinite(Number(pulse.cnh.price))) ext.push(`离岸人民币 ${pushNum(pulse.cnh.price, 4)}`);
  if (pulse.ndx && Number.isFinite(Number(pulse.ndx.pct))) {
    if (pulse.ndx.pct <= -1.5) score -= 1;
    if (pulse.ndx.pct >= 1.5) score += 1;
  }
  if (pulse.dxy && Number.isFinite(Number(pulse.dxy.pct)) && pulse.dxy.pct >= 0.5) {
    score -= 1;
    notes.push('美元走强，压制外资与成长股');
  }
  if (pulse.xau && Number.isFinite(Number(pulse.xau.pct)) && pulse.xau.pct >= 1.5) {
    notes.push('黄金大涨，避险情绪升温');
  }
  const verdict = score >= 3 ? '偏多' : score <= -3 ? '偏空' : '震荡';
  const verdictEmoji = verdict === '偏多' ? '🟥' : verdict === '偏空' ? '🟩' : '⬜';
  const ma = pulse.ma;
  if (ma) {
    const above = Number(pulse.sh && pulse.sh.price) >= ma.ma20;
    notes.push(`上证 ${above ? '站上' : '位于'} 20 日线（${pushNum(ma.ma20, 2)}）${above ? '，趋势未破' : '，反弹仍受压制'}；当日区间 ${pushNum(ma.low, 2)}~${pushNum(ma.high, 2)}`);
  }
  const posAdvice = verdict === '偏多'
    ? '总仓位可保持 6~7 成，加仓分 2~3 批，优先低位宽基/行业 ETF'
    : verdict === '偏空'
      ? '总仓位压到 5~6 成以下，减仓优先执行，反弹再减、不追跌'
      : '总仓位维持现状，等方向选择，单日不追涨杀跌';
  const link = verdict === '偏空'
    ? '今天触发的加仓只做第一批（一半），剩余等明天确认；减仓按建议执行。'
    : verdict === '偏多'
      ? '加仓可分批执行完，减仓可放缓或只做集中度调整。'
      : '加仓减仓都按半仓执行，明天看方向再加码。';
  const lines = [
    '### 📅 明日走势预估（规则化推断，非点位预测）',
    facts.length ? `- 今日盘面：${facts.join(' ｜ ')}` : '',
    ext.length ? `- 外围隔夜：${ext.join(' ｜ ')}` : '',
    `- 倾向：${verdictEmoji} **${verdict}**（强度 ${score > 0 ? '+' : ''}${score}）`,
    notes.length ? `- 关注：${notes.map((n2, i) => `${i + 1}) ${n2}`).join('；')}` : '',
    `- 仓位建议：${posAdvice}`,
    `- 与今日动作的配合：${link}`,
  ];
  return { verdict, score, lines: lines.filter(Boolean) };
}

/* ---------------------------------------------------------
   市场氛围 → 评分调整（2026-11-18 用户要求 6）
   持仓建议不能只看「基金评级 + 当日估值」，还要把 A 股整体氛围（指数涨跌、
   涨跌家数、成交额、主力净流入）和外围（隔夜美股/港股/日经、美元、黄金）算进去。
   这里把盘面汇总成一个 -6 ~ +6 的分数：正分=偏多，负分=偏空；
   classifyPortfolio 会按「基金技术评分 + 市场分 × 权重」得到综合评分，
   再决定加仓/减仓/不变。市场数据不可用时分数为 0，退回原规则，不影响可用性。
   --------------------------------------------------------- */
function buildMarketContext(pulse) {
  const empty = {
    available: false, verdict: '未知', score: 0, cnScore: 0, extScore: 0,
    summary: '行情快照暂不可用，本次只按基金评级与当日估值判断', ext: '', lines: [],
  };
  if (!pulse) return empty;
  // Number(null) === 0：行情缺失时必须显式判空，不能把 null 当成 0% 涨跌。
  const p = (q) => (q && q.pct !== null && q.pct !== undefined && q.pct !== '' && Number.isFinite(Number(q.pct))
    ? Number(q.pct) : null);
  const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt = (v) => (Number.isFinite(Number(v)) ? `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%` : '');
  const out = buildOutlook(pulse);

  let cnScore = 0;
  const sh = p(pulse.sh);
  if (sh !== null) cnScore += sh <= -1.5 ? -2 : sh <= -0.7 ? -1 : sh >= 1.5 ? 2 : sh >= 0.7 ? 1 : 0;
  const cyb = p(pulse.cyb);
  if (cyb !== null) cnScore += cyb <= -1.5 ? -1.5 : cyb <= -0.5 ? -0.75 : cyb >= 1.5 ? 1.5 : cyb >= 0.5 ? 0.75 : 0;
  const sz = p(pulse.sz);
  if (sz !== null) cnScore += sz <= -1 ? -0.5 : sz <= -0.5 ? -0.25 : sz >= 1 ? 0.5 : sz >= 0.5 ? 0.25 : 0;
  const b = pulse.breadth || {};
  const adv = Number(b.up);
  const dec = Number(b.down);
  if (adv && dec) {
    const ratio = adv / (adv + dec);
    cnScore += ratio >= 0.6 ? 2 : ratio <= 0.35 ? -2 : 0;
  }
  if (pulse.mainYi !== null && pulse.mainYi !== undefined && pulse.mainYi !== '' && Number.isFinite(Number(pulse.mainYi))) {
    if (Number(pulse.mainYi) >= 50) cnScore += 1;
    else if (Number(pulse.mainYi) <= -50) cnScore -= 1;
  }

  let extScore = 0;
  const ndx = p(pulse.ndx);
  if (ndx !== null) extScore += ndx <= -1.5 ? -1.5 : ndx <= -0.5 ? -0.75 : ndx >= 1.5 ? 1.5 : ndx >= 0.5 ? 0.75 : 0;
  const spx = p(pulse.spx);
  if (spx !== null) extScore += spx <= -1 ? -0.5 : spx <= -0.5 ? -0.25 : spx >= 1 ? 0.5 : spx >= 0.5 ? 0.25 : 0;
  const hsi = p(pulse.hsi);
  if (hsi !== null) extScore += hsi <= -1 ? -0.5 : hsi <= -0.5 ? -0.25 : hsi >= 1 ? 0.5 : hsi >= 0.5 ? 0.25 : 0;
  const dxyP = p(pulse.dxy);
  if (dxyP !== null) {
    if (dxyP >= 0.5) extScore -= 1;
    else if (dxyP <= -0.5) extScore += 0.5;
  }
  const xauP = p(pulse.xau);
  if (xauP !== null) {
    if (xauP >= 1.5) extScore -= 0.5;
    else if (xauP <= -1.5) extScore += 0.5;
  }

  const score = clampN(Math.round((Number(out.score) || 0) * 10) / 10, -6, 6);
  const cnText = [
    sh !== null ? `上证 ${fmt(sh)}` : '',
    cyb !== null ? `创业板 ${fmt(cyb)}` : '',
    adv && dec ? `涨跌 ${adv}:${dec}` : '',
    Number.isFinite(Number(pulse.amountYi)) && Number(pulse.amountYi) > 0 ? `两市成交 ${pushNum(pulse.amountYi, 0)} 亿` : '',
    Number.isFinite(Number(pulse.mainYi)) ? `主力 ${pushSigned(pulse.mainYi, 0)} 亿` : '',
  ].filter(Boolean);
  const extText = [
    ndx !== null ? `纳指 ${fmt(ndx)}` : '',
    spx !== null ? `标普 ${fmt(spx)}` : '',
    hsi !== null ? `恒生 ${fmt(hsi)}` : '',
    pulse.dxy && Number.isFinite(Number(pulse.dxy.price)) ? `美元指数 ${pushNum(pulse.dxy.price, 2)}${dxyP !== null ? `(${fmt(dxyP)})` : ''}` : '',
    xauP !== null ? `伦敦金 ${fmt(xauP)}` : '',
  ].filter(Boolean);
  return {
    available: true,
    verdict: out.verdict,
    score,
    cnScore: Math.round(cnScore * 10) / 10,
    extScore: Math.round(extScore * 10) / 10,
    summary: cnText.join(' ｜ ') || '盘面数据暂缺',
    ext: extText.join(' ｜ ') || '外围数据暂缺',
    lines: (out.lines || []).filter((x) => x && !x.startsWith('###')),
  };
}


// 0.05 → 0.5 成，0.1 → 1 成
function chengText(ratio) {
  const c = Number(ratio) * 10;
  return `${Number.isInteger(c) ? c.toFixed(0) : c.toFixed(1)} 成`;
}

// 按份额给出具体加减仓数量（份额由用户自行在页面更新，这里只是建议）
function roundShares(shares, delta, minRatio = 0) {
  const base = Number(shares) || 0;
  const unit = base >= 10000 ? 500 : base >= 2000 ? 100 : 10;
  let v = Math.round(Math.abs(delta) / unit) * unit;
  // 用户要求「最少 1 成起」：即使四舍五入也不要低于约定比例，避免加/减得太轻。
  const floor = Math.ceil((base * Number(minRatio || 0)) / unit) * unit;
  if (floor > v) v = floor;
  return Math.max(unit, v);
}

// 涨跌口径的中文说明，用于推送正文里标注「这个数到底是哪天的」。
function pctKindLabel(kind) {
  return {
    nav: '今日净值',
    market: '场内实时',
    estimate: '盘中估值',
    official: '官方估值',
    etf: '穿透估算·ETF',
    holdings: '穿透估算·重仓',
    stale: '当日未更新',
  }[kind] || '';
}

// 只有「今天」的口径才算今日涨跌：官方净值、场内实时价，或我们自己的盘中穿透估算。
function isTodayPct(r) {
  return Boolean(r) && !r.pctStale && Number.isFinite(Number(r.pct)) && r.pctKind !== 'stale';
}

/**
 * 把持仓按三条策略规则分成 加仓 / 减仓 / 不变 三组（结构化结果）。
 *
 * 后台管理的「持仓策略」页面也用它：按天记录、次日评价必须和推送口径完全一致，
 * 否则「建议」和「事后评价」会对着两套规则说话，改进策略就失去意义。
 */
function classifyPortfolio(port, rules = DEFAULT_STRATEGY_RULES, market = null) {
  const R = normalizeStrategyRules(rules);
  const { rows, totals } = port;
  const hold = [];
  const add = [];
  const cut = [];
  const pendingList = [];
  const observe = []; // v2.9.1：有信号但被过滤（趋势未确认 / 跌幅过大 / 每日上限），不算建议也不算「不变」
  // 市场氛围只调整「综合评分」，不改评分门槛本身：偏空时门槛实质变严，偏多时变松。
  const marketScore = market && market.available !== false && Number.isFinite(Number(market.score))
    ? Number(market.score) : 0;
  const marketWeight = Number.isFinite(Number(R.marketWeight)) ? Number(R.marketWeight) : 1;
  const marketAdj = marketScore
    ? Math.max(-8, Math.min(8, Math.round(marketScore * 1.5 * marketWeight)))
    : 0;
  const baseRatio = Number(R.baseRatio) / 100;
  const strongRatio = Math.max(baseRatio, Number(R.strongRatio) / 100);
  const withMarket = (score) => (score === null ? null : Math.max(0, Math.min(100, Math.round(score + marketAdj))));
  const marketHint = marketAdj ? `，市场氛围 ${marketAdj > 0 ? '+' : ''}${marketAdj}` : '';

  for (const r of rows) {
    if (!r.held) continue; // 未录入持仓的不进三组，避免干扰
    // 决策口径优先级：15:00 冻结估值 > 场内收盘价（ETF 无独立估值）> 无（不进建议组）。
    // 绝不再拿「今日真实净值」参与决策——收盘后补记/覆盖重记也只用估值。
    const dp = r.decisionPct === undefined ? r.pct : r.decisionPct;
    const dk = r.decisionKind === undefined ? r.pctKind : r.decisionKind;
    const decisionPct = dp === null || dp === undefined || !Number.isFinite(Number(dp)) ? null : Number(dp);
    if (decisionPct === null || !r.price || dk === 'stale') {
      pendingList.push(r);
      continue;
    }
    const av = r.advice;
    const fundScore = av && Number.isFinite(Number(av.score)) ? Number(av.score) : null;
    const score = withMarket(fundScore);
    const pct = decisionPct;
    const src = pctKindLabel(dk) || '15:00 估值';
    const scoreText = score === null
      ? ''
      : `技术评分 ${score}${marketAdj ? `（基金 ${fundScore}${marketHint}）` : ''}`;
    const navPct = r.pct === null || r.pct === undefined || r.pct === ''
      ? null
      : (Number.isFinite(Number(r.pct)) ? Number(r.pct) : null);
    // v2.9.1：把基金自身波动（ATR%）带进建议，供「自适应判定」与「波动归一」用
    const atrPct = av && av.analysis && Number.isFinite(Number(av.analysis.atrPct))
      ? Number(av.analysis.atrPct)
      : null;
    const itemBase = {
      shares: r.shares, price: r.price, pct, pctKind: dk, navPct,
      navDate: r.navDate || '', weight: r.weight,
      score, fundScore, marketAdj, decisionBasis: dk, atrPct,
    };
    // volNormalize：把「当日涨跌」换算成 ATR 倍数（2% ≈ 原阈值 1 倍），让债基/股基同标准
    const vol2 = R.volNormalize && Number.isFinite(atrPct) && atrPct > 0 ? atrPct : null;
    const pctSignal = vol2 ? (pct / vol2) * 2 : pct;
    // 1) 集中度强制减仓
    if (r.weight !== null && r.weight > R.concentrationPct && totals.marketValue > 0) {
      const targetMv = totals.marketValue * (R.concentrationTargetPct / 100);
      const targetShares = Math.floor(targetMv / r.price);
      const delta = Math.min(-10, targetShares - r.shares);
      if (delta < 0) {
        cut.push({
          ...itemBase,
          code: r.code, name: r.name, action: 'cut', rule: 'concentration',
          targetShares: r.shares + delta, delta,
          ratioPct: r.weight - R.concentrationTargetPct,
          reason: `单只占比 ${r.weight.toFixed(1)}%，超过 ${R.concentrationPct}% 上限，建议降到 ${R.concentrationTargetPct}% 左右（${pushNum(targetMv, 0)} 元）`,
        });
        continue;
      }
    }
    if (score !== null && score >= R.addScore && pctSignal <= -R.addDip) {
      // v2.9.1：趋势确认——回测显示「评分高 + 当日跌」对次日没有预测力，
      // 只有价格站稳 MA20 且趋势不是 down 时加仓才有效（回踩买，不追跌）。
      const ma20 = av && av.levels && Number.isFinite(Number(av.levels.ma20)) ? Number(av.levels.ma20) : null;
      const trend = av && av.analysis ? String(av.analysis.trend || '') : '';
      // 均线缺失（新基金 / 数据不足）时不拦，只提示；有均线才真正做趋势确认
      const trendOk = !R.addTrendConfirm || ma20 === null
        || (Number(r.price) >= ma20 && trend !== 'down');
      if (!trendOk) {
        observe.push({
          ...itemBase,
          code: r.code, name: r.name, action: 'add', rule: 'add-trend-blocked',
          targetShares: r.shares, delta: 0, ratioPct: 0,
          reason: `${scoreText} 偏多、${src} ${pct.toFixed(2)}% 回落，但价格未站稳 MA20${ma20 === null ? '（缺均线）' : `（现价 ${pushNum(r.price)} / MA20 ${pushNum(ma20)}）`}${trend === 'down' ? '、趋势向下' : ''}，暂不加仓`,
        });
        continue;
      }
      const ratio = score >= R.strongScore && pctSignal <= -R.strongDip ? strongRatio : baseRatio;
      const delta = roundShares(r.shares, r.marketValue * ratio / r.price, ratio);
      add.push({
        ...itemBase,
        code: r.code, name: r.name, action: 'add', rule: 'score-strong-dip',
        targetShares: r.shares + delta, delta,
        ratioPct: ratio * 100,
        reason: `${scoreText} 偏多，${src} ${pct.toFixed(2)}% 回落且站稳 MA20，建议加 ${chengText(ratio)}（分 2 批）`,
      });
      continue;
    }
    if (score !== null && score < R.cutScore && (pctSignal >= R.cutRise || pctSignal <= -R.cutDip)) {
      // v2.9.1：不追跌——当日跌幅超过 cutMaxDip 时不减仓（回测：1-2% 跌幅减仓命中 54%，≥5% 仅 39%）
      if (pct <= -Number(R.cutMaxDip)) {
        observe.push({
          ...itemBase,
          code: r.code, name: r.name, action: 'cut', rule: 'cut-max-dip',
          targetShares: r.shares, delta: 0, ratioPct: 0,
          reason: `${scoreText} 偏弱，但当日已跌 ${Math.abs(pct).toFixed(2)}%（≥ ${R.cutMaxDip}%），不追跌减仓，等反弹或次日确认`,
        });
        continue;
      }
      const ratio = score < R.weakScore ? strongRatio : baseRatio;
      const delta = roundShares(r.shares, r.marketValue * ratio / r.price, ratio);
      cut.push({
        ...itemBase,
        code: r.code, name: r.name, action: 'cut', rule: score < R.weakScore ? 'score-weak-drop' : 'score-weak',
        targetShares: r.shares - delta, delta,
        ratioPct: ratio * 100,
        reason: score < R.weakScore
          ? `${scoreText} 弱势，${src}${pct >= 0 ? '反弹' : '继续下跌'} ${Math.abs(pct).toFixed(2)}%，建议减 ${chengText(ratio)}`
          : `${scoreText} 偏弱，${src}${pct >= 0 ? '反弹' : '下跌'} ${Math.abs(pct).toFixed(2)}%，建议减 ${chengText(ratio)}`,
      });
      continue;
    }
    hold.push({
      ...itemBase,
      code: r.code, name: r.name, action: 'hold', rule: 'no-signal',
      targetShares: r.shares, delta: 0, ratioPct: 0,
      rating: (av && av.rating && av.rating.label) || '',
      reason: av && av.rating && av.rating.label
        ? `评级「${av.rating.label}」${av.position ? `，参考仓位 ${av.position.text}` : ''}`
        : '无明确信号，保持现有仓位',
    });
  }

  // v2.9.1：每日调仓上限——按信号强度（|当日涨跌|）排序，只保留前 N 只，
  // 其余记「顺延」；集中度强制减仓属于风控，永远保留。
  const cap = Math.max(1, Math.trunc(Number(R.maxActionsPerDay) || 3));
  const forced = cut.filter((x) => x.rule === 'concentration');
  const movable = [...add, ...cut.filter((x) => x.rule !== 'concentration')]
    .sort((a, b) => Math.abs(Number(b.pct) || 0) - Math.abs(Number(a.pct) || 0));
  const keep = new Set(forced.map((x) => `${x.code}|${x.rule}`));
  const budget = Math.max(0, cap - forced.length);
  const kept = movable.slice(0, budget);
  for (const it of kept) keep.add(`${it.code}|${it.rule}`);
  const overflow = movable.slice(budget);
  for (const it of overflow) {
    observe.push({
      ...it,
      rule: 'daily-cap',
      targetShares: it.shares,
      delta: 0,
      ratioPct: 0,
      reason: `信号成立，但已到每日调仓上限 ${cap} 只（本只排第 ${movable.indexOf(it) + 1}），顺延到下一交易日`,
    });
  }
  const addFinal = add.filter((x) => keep.has(`${x.code}|${x.rule}`));
  const cutFinal = cut.filter((x) => keep.has(`${x.code}|${x.rule}`));
  return { add: addFinal, cut: cutFinal, hold, pending: pendingList, observe, rows, totals, marketAdj };
}

function buildStrategyReport(port, pulse, opts = {}) {
  const { rows, totals, today } = port;
  const slotTime = opts.slotTime || '14:30';
  const outlook = buildOutlook(pulse);
  const market = buildMarketContext(pulse);
  const { add, cut, hold, pending: pendingList } = classifyPortfolio(port, currentStrategyRules(), market);

  const line = (r, sign) => {
    const delta = sign === 0 ? 0 : sign * r.delta;
    const target = r.shares + delta;
    const amount = Math.abs(delta) * r.price;
    const dir = delta > 0 ? '+' : delta < 0 ? '−' : '';
    return [
      `- ${r.name}（${r.code}）`,
      `  份额 ${pushNum(r.shares, 0)} → **${pushNum(target, 0)}**（${dir}${pushNum(Math.abs(delta), 0)} 份 ≈ ${pushNum(amount, 0)} 元）`,
      `  理由：${r.reason}`,
    ].join('\n');
  };

  const covered = rows.filter((r) => {
    const dk = r.decisionKind === undefined ? r.pctKind : r.decisionKind;
    return dk !== 'stale' && Number.isFinite(Number(r.decisionPct === undefined ? r.pct : r.decisionPct));
  }).length;
  const kindCount = (k) => rows.filter((r) => (r.decisionKind === undefined ? r.pctKind : r.decisionKind) === k).length;
  const summary = `市值 ${pushNum(totals.marketValue, 0)} 元 ｜ 今日 ${pushSigned(totals.portfolioPct, 2)}%（${pushSigned(totals.dayProfit, 0)} 元）${totals.profit === null ? '' : ` ｜ 累计 ${pushSigned(totals.profit, 0)} 元（${pushSigned(totals.profitPct, 2)}%）`}`;
  const caliber = [
    kindCount('official') ? `官方估值 ${kindCount('official')} 只` : '',
    kindCount('estimate') ? `盘中估值 ${kindCount('estimate')} 只` : '',
    kindCount('etf') || kindCount('holdings') ? `穿透估值 ${kindCount('etf') + kindCount('holdings')} 只` : '',
    kindCount('market') ? `场内收盘 ${kindCount('market')} 只` : '',
    pendingList.length ? `无 15:00 估值 ${pendingList.length} 只` : '',
  ].filter(Boolean).join(' ｜ ');
  const lines = [
    `## 寰球智投 · 持仓策略（${today} ${slotTime}）`,
    '',
    summary,
    `决策口径：${caliber || '--'}（只用 15:00 当日估值，不用收盘后公布的真实净值）${covered < rows.length ? '；没有估值的标的不参与加减仓判断' : ''}`,
    `分组：🔴 加仓 ${add.length} 只 ｜ 🟢 减仓 ${cut.length} 只 ｜ ⚪ 不变 ${hold.length} 只`,
    market.available
      ? `市场氛围：${market.verdict}（${market.score > 0 ? '+' : ''}${market.score}）｜ ${market.summary}${market.ext ? ` ｜ 外围 ${market.ext}` : ''}`
      : '市场氛围：数据暂不可用，本次只按基金评级 + 当日估值判断',
    '',
    `### 🔴 加仓（${add.length}）`,
    ...(add.length ? add.map((r) => line(r, 1)) : ['- 今天没有触发加仓条件的基金']),
    '',
    `### 🟢 减仓（${cut.length}）`,
    ...(cut.length ? cut.map((r) => line(r, -1)) : ['- 今天没有触发减仓条件的基金']),
    '',
    `### ⚪ 不变（${hold.length}）`,
    ...(hold.length
      ? hold.map((r) => `- ${r.name}（${r.code}）${pushPct(r.pct)} ｜ ${pushNum(r.shares, 0)} 份 ｜ ${r.reason} ｜ ${pctKindLabel(r.pctKind)}`)
      : ['- 无']),
    ...(pendingList.length
      ? [
        '',
        `### ❔ 当日未更新（${pendingList.length}）`,
        ...pendingList.map((r) => `- ${r.name}（${r.code}）最新 ${r.navDate || '--'} 净值${r.navPct === null ? '' : ` ${pushPct(r.navPct)}`}${r.pctNote ? `（${r.pctNote}）` : ''} ｜ 当日涨跌还没出，本次不给动作`),
      ]
      : []),
    '',
    ...outlook.lines,
    '',
    '> 份额为建议值，需你自己在「基金 → 自选基金 → 仓」里手动更新；本工具不会自动改动持仓。',
    '> 数据口径：今日净值 > 场内实时 > 盘中穿透估算（重仓股当日涨跌 × 股票仓位）；估算与最终净值可能有偏差，仅供参考。',
  ];
  return {
    title: `${today.slice(5)} 策略·加${add.length}减${cut.length}不变${hold.length}·明日${outlook.verdict}${pendingList.length ? `·${pendingList.length}未更新` : ''}`,
    content: lines.join('\n'),
    summary,
    count: rows.length,
    pending: pendingList.length,
    groups: { add: add.length, cut: cut.length, hold: hold.length },
    market,
  };
}

// 19:30 档：只认官方净值 / 场内收盘价；没出的不给涨跌，等净值公布后再补发一条。
function buildValuationReport(port, opts = {}) {
  const { rows, totals, today } = port;
  const slotTime = opts.slotTime || '19:30';
  const official = (r) => (r.pctKind === 'nav' || r.pctKind === 'market') && Number.isFinite(Number(r.pct));
  const fresh = rows.filter(official).sort((a, b) => Number(b.pct) - Number(a.pct));
  const pending = rows.filter((r) => !official(r));
  const estRows = rows.filter((r) => (r.pctKind === 'holdings' || r.pctKind === 'etf') && Number.isFinite(Number(r.pct)));
  const officialHeld = fresh.filter((r) => r.held && r.dayProfit !== null);
  const officialMv = officialHeld.reduce((s, r) => s + r.marketValue, 0);
  const officialDp = officialHeld.reduce((s, r) => s + r.dayProfit, 0);
  const officialPct = officialMv > 0 ? (officialDp / officialMv) * 100 : null;
  const estHeld = estRows.filter((r) => r.held && r.dayProfit !== null);
  const estMv = estHeld.reduce((s, r) => s + r.marketValue, 0);
  const estDp = estHeld.reduce((s, r) => s + r.dayProfit, 0);
  const up = fresh.filter((r) => Number(r.pct) > 0).length;
  const down = fresh.filter((r) => Number(r.pct) < 0).length;
  const best = fresh[0];
  const worst = fresh[fresh.length - 1];
  const fmtPct = (v) => (Number.isFinite(Number(v)) ? `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%` : '--');

  const summary = fresh.length
    ? `已出当日净值 ${fresh.length}/${rows.length} 只 ｜ 当日盈亏 ${pushSigned(officialDp, 0)} 元（${pushSigned(officialPct, 2)}%）`
    : `当日净值还没出（0/${rows.length} 只），本条只报告已确认的数据`;

  const head = [
    `## 寰球智投 · 当日基金估值（${today} ${slotTime}）`,
    '',
    summary,
    `持有市值 ${pushNum(totals.marketValue, 0)} 元${totals.profit === null ? '' : ` ｜ 累计 ${pushSigned(totals.profit, 0)} 元（${pushSigned(totals.profitPct, 2)}%）`}`,
    fresh.length
      ? `涨 ${up} 只 / 跌 ${down} 只${best ? ` · 最强 ${best.name} ${fmtPct(best.pct)}` : ''}${worst && worst !== best ? ` · 最弱 ${worst.name} ${fmtPct(worst.pct)}` : ''}`
      : '',
    estMv > 0 ? `穿透估算参考（未确认）：${pushSigned((estDp / estMv) * 100, 2)}%，覆盖 ${estHeld.length} 只持有基金，等官方净值出来再算数` : '',
  ].filter(Boolean);

  const freshLines = fresh.map((r) => {
    const tone = pushTone(r.pct);
    const tail = r.held
      ? ` ｜ 市值 ${pushNum(r.marketValue, 0)} 元${r.dayProfit === null ? '' : ` ｜ 当日 ${pushSigned(r.dayProfit, 0)} 元`}${r.profit === null ? '' : ` ｜ 累计 ${pushSigned(r.profit, 0)} 元`}`
      : '';
    return `- ${tone} ${r.name}（${r.code}） ${fmtPct(r.pct)} ｜ ${pctKindLabel(r.pctKind)}${tail}`;
  });
  const pendingLines = pending.map((r) => {
    const last = r.navPct === null
      ? '最新净值未知'
      : `最新 ${r.navDate || '--'} 净值 ${fmtPct(r.navPct)}`;
    const tail = r.held ? ` ｜ 市值 ${pushNum(r.marketValue, 0)} 元（不计入当日盈亏）` : '';
    const note = r.pctNote ? `（${r.pctNote}）` : '';
    return `- ❔ ${r.name}（${r.code}） 当日涨跌未出 ｜ ${last}${note}${tail}`;
  });

  const lines = [
    ...head,
    '',
    `### 已出当日净值（${fresh.length}）`,
    ...(freshLines.length ? freshLines : ['- 暂无']),
    ...(pending.length
      ? ['', `### 当日未更新（${pending.length}）`, ...pendingLines]
      : []),
    '',
    '### 口径说明',
    '- 「今日净值」= 基金公司已公布的当日单位净值涨跌；「场内实时」= 场内 ETF 收盘价涨跌。这两类才是当日的真实涨跌。',
    '- 场外基金净值一般 19:00~21:00 陆续公布（QDII 更晚，常滞后一个交易日）；没公布的不显示涨跌、也不计入当日盈亏。',
    '- 净值出来之后，本工具会自动再发一条更新消息，把最新涨跌补齐。',
    '',
    '> 净值为基金公司披露口径，ETF 为场内收盘价；本工具仅做整理，不构成投资建议。',
  ];
  const title = pending.length
    ? `${today.slice(5)} 估值·${fresh.length}/${rows.length}已出`
    : `${today.slice(5)} 估值·${pushSigned(officialPct, 2)}%·${pushSigned(officialDp, 0)}元`;
  return {
    title,
    content: lines.join('\n'),
    summary,
    count: rows.length,
    pending: pending.length,
    fresh: fresh.length,
  };
}

async function buildReportForSlot(slotKey, opts = {}) {
  const port = await collectPortfolio();
  if (slotKey === 'valuation') return buildValuationReport(port, opts);
  const pulse = await collectMarketPulse();
  return buildStrategyReport(port, pulse, opts);
}

// 出站地址校验（webhook 防 SSRF）见 src/lib/net-safety.js。

async function sendPushMessage({ title, content }) {
  const cfg = loadPushConfig();
  const channel = cfg.channel || 'serverchan';
  const timeout = 20000;
  if (channel === 'serverchan') {
    if (!cfg.token) throw new Error('请先填写 Server酱 SendKey');
    const key = String(cfg.token).trim();
    // Server酱³ 的 SendKey 形如 sctp<uid>xxx，端点与旧版不同；两种都试一次，取第一个成功的。
    const uid = (key.match(/^sctp(\d+)/i) || [])[1];
    const endpoints = [];
    if (uid) endpoints.push(`https://${uid}.push.ft07.com/send/${encodeURIComponent(key)}.send`);
    endpoints.push(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`);
    const body = new URLSearchParams({ title, desp: content });
    let lastErr = null;
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(timeout),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 视为失败 */ }
        if (!json) throw new Error(`Server酱返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
        const code = Number(json.code ?? json.errno);
        if (code !== 0) throw new Error(`${json.message || json.errmsg || 'Server酱拒绝推送'}（code=${json.code}）`);
        const pushid = json?.data?.pushid ?? null;
        return {
          ok: true,
          channel,
          pushid,
          endpoint: url.includes('push.ft07.com') ? 'serverchan3' : 'serverchan',
          message: json.message || 'SUCCESS',
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Server酱推送失败');
  }
  if (channel === 'pushplus') {
    if (!cfg.token) throw new Error('请先填写 PushPlus token');
    const res = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cfg.token, title, content, template: 'markdown' }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    if (!json) throw new Error(`PushPlus 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
    if (Number(json.code) !== 200) throw new Error(json.msg || `PushPlus 推送失败（code=${json.code}）`);
    return { ok: true, channel, pushid: json?.data || null };
  }
  if (channel === 'wecom') {
    if (!cfg.webhook) throw new Error('请先填写企业微信群机器人 webhook');
    await assertSafeOutboundUrl(cfg.webhook);
    const res = await fetch(cfg.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: `### ${title}\n${content}` } }),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    if (!json) throw new Error(`企业微信返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
    if (Number(json.errcode) !== 0) throw new Error(json.errmsg || '企业微信推送失败');
    return { ok: true, channel };
  }
  if (!cfg.webhook) throw new Error('请先填写自定义 webhook 地址');
  await assertSafeOutboundUrl(cfg.webhook);
  const res = await fetch(cfg.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content }),
    signal: AbortSignal.timeout(timeout),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`自定义 webhook 返回 HTTP ${res.status}`);
  return { ok: true, channel: 'custom' };
}

// 双时段调度：14:30 推持仓策略（加仓/减仓/不变），19:30 推当日基金净值/估值。
// 电脑睡眠/关机错过时间点时，唤醒或开机后当天补发一次；错过超过 6 小时则跳过。
function pushClock(now = new Date()) {
  const sh = new Date(now.getTime() + 8 * 3600 * 1000);
  return {
    sh,
    day: sh.toISOString().slice(0, 10),
    minutes: sh.getUTCHours() * 60 + sh.getUTCMinutes(),
    weekday: sh.getUTCDay(),
  };
}

function slotMinutes(slot) {
  const [h, m] = String(slot && slot.time ? slot.time : '00:00').slice(0, 5).split(':').map((v) => Number(v) || 0);
  return h * 60 + m;
}

function dueSlots(cfg, clock) {
  if (!cfg.enabled) return [];
  if (cfg.weekdaysOnly && (clock.weekday === 0 || clock.weekday === 6)) return [];
  return (cfg.slots || []).filter((slot) => {
    if (!slot || slot.enabled === false) return false;
    if ((cfg.lastSent || {})[slot.key] === clock.day) return false;
    return clock.minutes >= slotMinutes(slot);
  });
}

async function handleDueSlot(cfg, slot, clock) {
  const late = clock.minutes - slotMinutes(slot);
  if (late > 360) {
    const fresh = loadPushConfig();
    savePushConfig({ lastSent: { ...(fresh.lastSent || {}), [slot.key]: clock.day } });
    console.log(`[push] ${slot.key} skipped for ${clock.day}: missed by ${late}min`);
    return;
  }
  try {
    const report = await buildReportForSlot(slot.key);
    if (late > 3) {
      report.title = `${report.title}（补发）`;
      report.content = `> 电脑睡眠或关机错过了计划时间，本消息为当天补发。\n\n${report.content}`;
    }
    const sent = await sendPushMessage(report);
    const after = loadPushConfig();
    const patch = {
      lastSent: { ...(after.lastSent || {}), [slot.key]: clock.day },
      lastResult: {
        ok: true,
        at: Date.now(),
        slot: slot.key,
        label: slot.label || slot.key,
        summary: report.summary,
        pushid: (sent && sent.pushid) || null,
        endpoint: (sent && (sent.endpoint || sent.channel)) || '',
        late: late > 3 ? late : 0,
      },
    };
    // 估值这条如果还有基金当日净值没出，记下来，等净值公布后再补一条更新。
    if (slot.key === 'valuation') {
      patch.followUp = {
        day: clock.day,
        pending: Number(report.pending) || 0,
        updates: 0,
        lastAt: Date.now(),
      };
    }
    savePushConfig(patch);
    console.log(`[push] ${slot.key} sent for ${clock.day}${late > 3 ? ` (catch-up, late ${late}min)` : ''}${sent && sent.pushid ? ` pushid=${sent.pushid}` : ''}${slot.key === 'valuation' ? ` pending=${Number(report.pending) || 0}` : ''}`);
  } catch (err) {
    savePushConfig({
      lastResult: { ok: false, at: Date.now(), slot: slot.key, label: slot.label || slot.key, error: err.message },
    });
    console.log(`[push] ${slot.key} failed: ${String(err.message || err)}`);
  }
}

const FOLLOWUP_MAX_UPDATES = 3;
const FOLLOWUP_GAP_MS = 10 * 60 * 1000;
const FOLLOWUP_END_MINUTES = 23 * 60 + 40;

// 净值陆续公布后，把「当日基金估值」补一条更新（最多 3 条，直到全部出齐）。
async function runValuationFollowUp(clock) {
  const cfg = loadPushConfig();
  if (!cfg.enabled) return;
  const fu = cfg.followUp;
  if (!fu || fu.day !== clock.day) return;
  if (!Number(fu.pending)) return; // 上次已经出齐
  if ((fu.updates || 0) >= FOLLOWUP_MAX_UPDATES) return;
  if (Date.now() - (Number(fu.lastAt) || 0) < FOLLOWUP_GAP_MS) return;
  if (clock.minutes > FOLLOWUP_END_MINUTES) return;
  const slot = (cfg.slots || []).find((x) => x.key === 'valuation');
  if (!slot || slot.enabled === false) return;
  if ((cfg.lastSent || {}).valuation !== clock.day) return;
  if (clock.minutes < slotMinutes(slot) + 5) return;
  let report;
  try {
    report = await buildReportForSlot('valuation', { slotTime: slot.time });
  } catch {
    return;
  }
  const pendingNow = Number(report.pending) || 0;
  if (pendingNow >= Number(fu.pending)) {
    // 还没有新净值出来，只更新时间戳，避免反复重建。
    savePushConfig({ followUp: { ...fu, lastAt: Date.now() } });
    return;
  }
  const prevPending = Number(fu.pending) || 0;
  report.title = `${report.title}·净值更新`;
  report.content = `> 有新的净值公布，这是「当日基金净值/估值」的补充更新：未更新数量 ${prevPending} → ${pendingNow}。\n\n${report.content}`;
  try {
    const sent = await sendPushMessage(report);
    savePushConfig({
      followUp: { day: clock.day, pending: pendingNow, updates: (Number(fu.updates) || 0) + 1, lastAt: Date.now() },
      lastResult: {
        ok: true,
        at: Date.now(),
        slot: 'valuation',
        label: '当日基金净值/估值（更新）',
        summary: report.summary,
        pushid: (sent && sent.pushid) || null,
        endpoint: (sent && (sent.endpoint || sent.channel)) || '',
        late: 0,
      },
    });
    console.log(`[push] valuation follow-up sent for ${clock.day}: pending ${prevPending} -> ${pendingNow}`);
  } catch (err) {
    savePushConfig({ followUp: { ...fu, lastAt: Date.now() } });
    console.log(`[push] valuation follow-up failed: ${String(err.message || err)}`);
  }
}

async function runPushTick() {
  const cfg = loadPushConfig();
  const clock = pushClock();
  const due = dueSlots(cfg, clock);
  for (const slot of due) {
    await handleDueSlot(cfg, slot, clock);
  }
  if (!due.length) {
    await runValuationFollowUp(clock);
  }
}

async function handlePushApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  if (p === '/api/push/config' && req.method === 'GET') {
    // 2026-11-15：推送属于全局配置，已移到后台管理，普通用户不可读。
    requireAdmin(req);
    const cfg = loadPushConfig();
    return {
      ok: true,
      config: maskPushConfig(cfg),
      channelLabel: pushChannelLabel(cfg.channel),
      hint: pushChannelHint(cfg),
      slots: cfg.slots,
    };
  }
  if (p === '/api/push/config' && req.method === 'POST') {
    // 推送配置是全局的（消息发到同一个微信），只有管理员能改，避免其它账号覆盖。
    requireAdmin(req);
    const body = req.body || {};
    const patch = {};
    // v2.9.2：funds / holdings 属于账号数据，统一走 /api/portfolio（条目级合并 + 审计），
    // 这个接口只改推送渠道相关字段，避免后台保存推送设置时把持仓整份覆盖。
    for (const key of ['enabled', 'channel', 'token', 'webhook', 'weekdaysOnly']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.time && isValidClockTime(body.time)) patch.time = String(body.time).slice(0, 5);
    if (Array.isArray(body.slots)) {
      const slots = body.slots
        .filter((x) => x && x.key)
        .map((x) => ({
          key: String(x.key),
          label: String(x.label || '').slice(0, 40),
          time: isValidClockTime(x.time) ? String(x.time).slice(0, 5) : '19:30',
          enabled: x.enabled !== false,
        }));
      if (!slots.length) throw new Error('至少要保留一个推送时段');
      patch.slots = slots;
    }
    if (patch.channel && !['serverchan', 'pushplus', 'wecom', 'custom'].includes(patch.channel)) {
      throw new Error('不支持的推送渠道');
    }
    if (body.time && patch.time === undefined) throw new Error('推送时间格式应为 HH:MM');
    if (patch.webhook !== undefined && String(patch.webhook || '').trim()) {
      await assertSafeOutboundUrl(patch.webhook);
    }
    const next = savePushConfig(patch);
    return { ok: true, config: maskPushConfig(next), slots: next.slots };
  }
  if (p === '/api/push/sync' && req.method === 'POST') {
    // 兼容旧前端：自选基金/持仓仍可从这里同步，但必须落到当前账号名下，
    // 不能像以前那样直接写全局 push-config（否则任何账号都会覆盖主账号的推送数据）。
    const user = currentUser(req);
    if (!user) throw Object.assign(new Error('未登录'), { status: 401 });
    const body = req.body || {};
    const cleaned = sanitizePortfolio(body);
    const current = loadPortfolio(user);
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    // v2.9.2：持仓按条目时间戳合并，旧客户端整份提交也不会把新改动冲掉。
    const holdings = has('holdings')
      ? store.mergePortfolioHoldings(current.holdings || {}, cleaned.holdings, { stampMissing: true })
      : (current.holdings || {});
    savePortfolio(user, {
      funds: has('funds') ? cleaned.funds : current.funds,
      holdings,
      watchlist: current.watchlist,
    });
    return { ok: true, funds: (has('funds') ? cleaned.funds : current.funds).length };
  }
  if (p === '/api/push/preview') {
    requireAdmin(req);
    const slotKey = q.get('slot') === 'valuation' ? 'valuation' : 'strategy';
    const pcfg = loadPushConfig();
    const pslot = (pcfg.slots || []).find((x) => x.key === slotKey) || {};
    const report = await buildReportForSlot(slotKey, { slotTime: pslot.time });
    return { ok: true, slot: slotKey, ...report };
  }
  if (p === '/api/push/test' && req.method === 'POST') {
    // 允许把当前表单值一起带上来，避免「改了密钥但没点保存就直接测试」。
    requireAdmin(req);
    const body = req.body || {};
    const patch = {};
    for (const key of ['channel', 'token', 'webhook', 'enabled']) {
      if (body[key] !== undefined && body[key] !== '') patch[key] = body[key];
    }
    if (Array.isArray(body.slots) && body.slots.length) {
      patch.slots = body.slots
        .filter((x) => x && x.key)
        .map((x) => ({
          key: String(x.key),
          label: String(x.label || '').slice(0, 40),
          time: isValidClockTime(x.time) ? String(x.time).slice(0, 5) : '19:30',
          enabled: x.enabled !== false,
        }));
    }
    if (Object.keys(patch).length) savePushConfig(patch);
    const slot = body.slot === 'valuation' ? 'valuation' : 'strategy';
    const tcfg = loadPushConfig();
    const tslot = (tcfg.slots || []).find((x) => x.key === slot) || {};
    const report = await buildReportForSlot(slot, { slotTime: tslot.time });
    const sent = await sendPushMessage(report);
    const clock = pushClock();
    const cfg = loadPushConfig();
    savePushConfig({
      lastResult: {
        ok: true,
        at: Date.now(),
        slot,
        label: (cfg.slots || []).find((x) => x.key === slot)?.label || slot,
        summary: report.summary,
        pushid: sent.pushid || null,
        endpoint: sent.endpoint || sent.channel || '',
      },
      lastSent: { ...(cfg.lastSent || {}), [slot]: clock.day },
    });
    return { ok: true, sent, slot, title: report.title, pushid: sent.pushid || null, hint: pushChannelHint(loadPushConfig()) };
  }
  if (p === '/api/push/run' && req.method === 'POST') {
    requireAdmin(req);
    await runPushTick();
    return { ok: true, lastResult: loadPushConfig().lastResult, slots: loadPushConfig().slots };
  }
  const err = new Error('未知接口');
  err.status = 404;
  throw err;
}

  return {
    PUSH_SLOT_DEFAULTS,
    PUSH_DEFAULTS,
    DEFAULT_STRATEGY_RULES,
    normalizeStrategyRules,
    normalizePushConfig,
    loadPushConfig,
    savePushConfig,
    pushChannelHint,
    pushChannelLabel,
    maskPushConfig,
    collectPortfolio,
    classifyPortfolio,
    collectMarketPulse,
    buildMarketContext,
    collectMarketContext: async () => buildMarketContext(await collectMarketPulse()),
    buildStrategyReport,
    buildValuationReport,
    buildReportForSlot,
    sendPushMessage,
    pushClock,
    slotMinutes,
    dueSlots,
    handleDueSlot,
    runValuationFollowUp,
    runPushTick,
    handlePushApi,
  };
}

module.exports = { createPushService };
