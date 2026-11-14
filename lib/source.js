'use strict';

/**
 * 行情数据源管理
 * ---------------------------------------------------------------
 * 每个能力（行情、板块、资金流、快讯……）可注册多个上游实现，
 * 按「配置优先级 + 最近健康度」依次尝试；失败的上游进入冷却，
 * 自动让位给下一个，避免用户看到整页 502。
 */

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'source-config.json');

const PROVIDERS = {
  eastmoney: { key: 'eastmoney', label: '东方财富', tag: 'EM' },
  tencent: { key: 'tencent', label: '腾讯行情', tag: 'TX' },
  ths: { key: 'ths', label: '同花顺', tag: 'THS' },
  sina: { key: 'sina', label: '新浪财经', tag: 'SINA' },
};

const CAPABILITIES = [
  {
    key: 'quotes',
    label: '行情快照',
    desc: '指数 / 个股 / ETF / 港股 / 美股的现价、涨跌、成交额',
    providers: ['eastmoney', 'tencent', 'ths', 'sina'],
  },
  {
    key: 'sectors',
    label: '板块行情与资金',
    desc: '行业与概念板块的涨跌幅、主力净流入',
    providers: ['eastmoney', 'sina'],
  },
  {
    key: 'sectorDetail',
    label: '板块走势与成分股',
    desc: '板块 K 线、成分股明细',
    providers: ['eastmoney'],
  },
  {
    key: 'stockFlow',
    label: '个股资金流',
    desc: '当日主力资金分时曲线',
    providers: ['eastmoney', 'sina'],
  },
  {
    key: 'etfFlow',
    label: 'ETF 资金流排行',
    desc: 'ETF 主力净流入榜（仅东方财富提供）',
    providers: ['eastmoney'],
  },
  {
    key: 'rank',
    label: '涨跌幅 / 成交额榜',
    desc: '全市场个股排行',
    providers: ['sina', 'eastmoney'],
  },
  {
    key: 'news',
    label: '7×24 快讯',
    desc: '财经快讯与情绪统计',
    providers: ['eastmoney', 'sina'],
  },
  {
    key: 'kline',
    label: 'K 线历史',
    desc: '日 / 周 / 月 / 分钟 K 线',
    providers: ['eastmoney', 'tencent', 'sina'],
    builtin: true,
    note: '内置搜狐、腾讯、新浪多源回退，无需切换',
  },
  {
    key: 'minute',
    label: '分时图',
    desc: '当日与历史分时',
    providers: ['eastmoney', 'tencent', 'sina'],
    builtin: true,
    note: '内置腾讯、东财、新浪多源回退，无需切换',
  },
  {
    key: 'fund',
    label: '基金净值与排行',
    desc: '场外基金净值、季报、规模',
    providers: ['eastmoney'],
    builtin: true,
    note: '天天基金是唯一公开数据源，暂无可替代接口',
  },
];

const CAP_MAP = new Map(CAPABILITIES.map((c) => [c.key, c]));

const DEFAULT_CONFIG = {
  mode: 'auto',
  strict: false,
  overrides: {},
  cooldownMs: 90000,
  updatedAt: 0,
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      overrides: raw && typeof raw.overrides === 'object' && raw.overrides ? { ...raw.overrides } : {},
    };
  } catch {
    return { ...DEFAULT_CONFIG, overrides: {} };
  }
}

let config = loadConfig();

function saveConfig(next, options = {}) {
  const mergedOverrides = options.replaceOverrides
    ? { ...(next.overrides || {}) }
    : { ...config.overrides, ...(next.overrides || {}) };
  config = {
    ...config,
    ...next,
    overrides: mergedOverrides,
    updatedAt: Date.now(),
  };
  // 清除显式设为 auto 的覆盖项
  for (const [k, v] of Object.entries(config.overrides)) {
    if (!v || v === 'auto') delete config.overrides[k];
  }
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch {
    /* 配置写入失败不影响本次运行 */
  }
  return getConfig();
}

function getConfig() {
  return {
    mode: config.mode,
    strict: Boolean(config.strict),
    overrides: { ...config.overrides },
    cooldownMs: config.cooldownMs,
    updatedAt: config.updatedAt,
  };
}

/* ---------------- 运行时健康度 ---------------- */

const health = new Map(); // key = `${cap}:${provider}`

function healthKey(cap, provider) {
  return `${cap}:${provider}`;
}

function getHealth(cap, provider) {
  return health.get(healthKey(cap, provider)) || null;
}

function markOk(cap, provider, latency) {
  health.set(healthKey(cap, provider), {
    ok: true,
    at: Date.now(),
    latency,
    error: null,
    fails: 0,
    cooldownUntil: 0,
  });
}

function markFail(cap, provider, err) {
  const prev = getHealth(cap, provider);
  const fails = (prev?.fails || 0) + 1;
  const cooldown = Math.min(10 * 60 * 1000, (config.cooldownMs || 90000) * Math.min(4, fails));
  health.set(healthKey(cap, provider), {
    ok: false,
    at: Date.now(),
    latency: null,
    error: String(err && err.message ? err.message : err).slice(0, 240),
    fails,
    cooldownUntil: Date.now() + cooldown,
  });
}

function healthRank(cap, provider, now) {
  const h = getHealth(cap, provider);
  if (!h) return 1; // 未知
  if (h.ok && now - h.at < 5 * 60 * 1000) return 0; // 最近成功
  if (!h.ok && h.cooldownUntil > now) return 2; // 冷却中
  return 1;
}

/* ---------------- 注册与调度 ---------------- */

const registry = new Map(); // cap -> { handlers, probeArgs }

function register(cap, handlers, probeArgs) {
  if (!CAP_MAP.has(cap)) throw new Error(`未知数据能力: ${cap}`);
  registry.set(cap, { handlers: { ...handlers }, probeArgs: probeArgs || [] });
}

function supportedProviders(cap) {
  const entry = registry.get(cap);
  const declared = CAP_MAP.get(cap)?.providers || [];
  if (!entry) return declared;
  return declared.filter((p) => typeof entry.handlers[p] === 'function');
}

function orderFor(cap, now = Date.now()) {
  const supported = supportedProviders(cap);
  if (!supported.length) return [];
  const override = config.overrides[cap];
  const preferred = override || (config.mode !== 'auto' ? config.mode : null);

  if (preferred && supported.includes(preferred)) {
    const rest = supported.filter((p) => p !== preferred);
    const order = [preferred, ...rest];
    return config.strict ? order.slice(0, 1) : order;
  }

  const order = supported.slice();
  if (!config.strict) {
    order.sort((a, b) => {
      const d = healthRank(cap, a, now) - healthRank(cap, b, now);
      if (d !== 0) return d;
      return supported.indexOf(a) - supported.indexOf(b);
    });
  }
  return config.strict ? order.slice(0, 1) : order;
}

class SourceError extends Error {
  constructor(cap, attempts) {
    const label = CAP_MAP.get(cap)?.label || cap;
    const detail = attempts.map((a) => `${PROVIDERS[a.provider]?.label || a.provider}: ${a.error}`).join('；');
    super(`${label}暂无可用数据源${detail ? `（${detail}）` : ''}`);
    this.name = 'SourceError';
    this.capability = cap;
    this.attempts = attempts;
    this.status = 503;
  }
}

async function run(cap, args) {
  const entry = registry.get(cap);
  if (!entry) throw new SourceError(cap, [{ provider: 'none', error: '未注册数据源' }]);
  const order = orderFor(cap);
  if (!order.length) throw new SourceError(cap, [{ provider: 'none', error: '没有可用实现' }]);

  const attempts = [];
  for (const provider of order) {
    const fn = entry.handlers[provider];
    if (!fn) continue;
    const started = Date.now();
    try {
      const data = await fn(...(args || entry.probeArgs));
      markOk(cap, provider, Date.now() - started);
      return { data, source: provider, attempts, latency: Date.now() - started };
    } catch (err) {
      if (!err || !err.soft) markFail(cap, provider, err);
      attempts.push({ provider, error: err.message || String(err), ms: Date.now() - started });
    }
  }
  throw new SourceError(cap, attempts);
}

/** 指定数据源执行一次（用于补齐主数据源缺失的品种），不参与优先级调度。 */
async function runProvider(cap, provider, args) {
  const entry = registry.get(cap);
  const fn = entry && entry.handlers[provider];
  if (!fn) {
    const err = new Error('该数据源未注册此能力');
    err.soft = true;
    throw err;
  }
  const started = Date.now();
  try {
    const data = await fn(...(args || entry.probeArgs));
    markOk(cap, provider, Date.now() - started);
    return { data, source: provider, latency: Date.now() - started };
  } catch (err) {
    if (!err || !err.soft) markFail(cap, provider, err);
    throw err;
  }
}

/* ---------------- 状态与探针 ---------------- */

function providerState(cap, provider, now) {
  const h = getHealth(cap, provider);
  const supported = supportedProviders(cap).includes(provider) || CAP_MAP.get(cap)?.providers.includes(provider);
  if (!supported) return { state: 'unsupported' };
  if (!h) return { state: 'unknown' };
  if (h.ok && now - h.at < 5 * 60 * 1000) {
    return { state: 'ok', latency: h.latency, at: h.at, error: null };
  }
  if (!h.ok && h.cooldownUntil > now) {
    return { state: 'fail', error: h.error, at: h.at, cooldownUntil: h.cooldownUntil, fails: h.fails };
  }
  return { state: 'unknown', at: h.at, error: h.ok ? null : h.error };
}

function status() {
  const now = Date.now();
  const items = CAPABILITIES.map((cap) => {
    const order = orderFor(cap.key);
    const entry = registry.get(cap.key);
    const providers = cap.providers.map((p) => {
      const st = providerState(cap.key, p, now);
      return {
        key: p,
        label: PROVIDERS[p].label,
        tag: PROVIDERS[p].tag,
        registered: Boolean(entry && entry.handlers[p]),
        ...st,
      };
    });
    return {
      key: cap.key,
      label: cap.label,
      desc: cap.desc,
      builtin: Boolean(cap.builtin),
      note: cap.note || '',
      order,
      active: order[0] || null,
      override: config.overrides[cap.key] || null,
      providers,
    };
  });
  return {
    mode: config.mode,
    strict: config.strict,
    cooldownMs: config.cooldownMs,
    updatedAt: Date.now(),
    providers: Object.values(PROVIDERS),
    capabilities: items,
    degraded: items.filter((i) => i.active && i.active !== (CAP_MAP.get(i.key)?.providers[0] || 'eastmoney')).length,
  };
}

async function probe(capKey) {
  const caps = capKey ? [capKey] : [...registry.keys()];
  const results = [];
  for (const cap of caps) {
    const entry = registry.get(cap);
    if (!entry) continue;
    const providers = [];
    for (const [provider, fn] of Object.entries(entry.handlers)) {
      const started = Date.now();
      try {
        await withTimeout(fn(...entry.probeArgs), 8000);
        markOk(cap, provider, Date.now() - started);
        providers.push({ provider, ok: true, ms: Date.now() - started });
      } catch (err) {
        markFail(cap, provider, err);
        providers.push({ provider, ok: false, ms: Date.now() - started, error: String(err.message || err).slice(0, 160) });
      }
    }
    results.push({ capability: cap, providers });
  }
  return { results, status: status() };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`探测超时 ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}

function labelFor(providerKey) {
  return PROVIDERS[providerKey]?.label || providerKey || '未知';
}

module.exports = {
  CAPABILITIES,
  PROVIDERS,
  SourceError,
  register,
  run,
  runProvider,
  status,
  probe,
  getConfig,
  saveConfig,
  labelFor,
  orderFor,
};
