'use strict';
/**
 * 持仓策略按天记录、次日评价与自动调参（2026-11-17，v2.2.0 起入库）
 *
 * 目标：把每天 14:30 生成的「加仓 / 减仓 / 不变」建议落库，第二天用**已公布净值**
 * 回头判断这条建议是否合理，并用长期命中率**自动调整规则参数**（不断改进策略）。
 *
 * 存储（2026-11-17 改动）：
 * - SQLite 模式 → strategy_records / strategy_meta 两张表（lib/store.js 提供读写）；
 * - JSON 模式 → data/strategy-log.json（兼容旧格式，升级不丢数据）。
 *   本模块只依赖注入进来的 strategyStore，不关心底层是库还是文件。
 *
 * 口径（避免事后自欺）：
 * 0) 决策（2026-11-18 用户要求）：自动/手动/覆盖重记都只用持仓基金 **15:00 当日估值**
 *    做分析，绝不用收盘后公布的真实净值；没有估值就记 pending，宁可不判也不用净值冒充。
 * 1) 记录：只记当期有明确信号的持仓（未持有、当日 15:00 估值还没出的不进建议组），
 *    分组逻辑直接复用 push 服务的 classifyPortfolio，与推送口径完全一致。
 * 2) 评价：只认「次日已公布的净值涨跌」（pctKind === 'nav'），盘中估算一律不算。
 *    次日 = 决策日之后的第一个工作日；遇节假日顺延，但最多 evalWindow 个工作日，
 *    超窗仍拿不到就记 skipped（不参与命中率），绝不用几天后的累计涨跌冒充次日。
 * 3) 判定：加仓→次日涨过 addBand 算对、跌过算错；减仓反之；
 *    不变→次日波动在 holdBand 内算对，波动大记 flat（不动没亏钱，不好判错）。
 * 4) 严格命中率 = 对 / (对 + 错)，flat 与 skipped 不进分母；
 *    页面另给「含中性口径 = 对 / 全部条数」并把四类计数都列出来，避免 4/4=100% 造成误读。
 *
 * 自动调参（全自动，可关、可回滚）：
 * - 每天最多一次；样本数 ≥ minSamples 且命中率 < minHitRate 时：
 *   加仓命中差 → addScore 上调 step；减仓命中差 → cutScore 下调 step。
 * - 只动这两个评分门槛，不动行情阈值与评价口径；命中率高时**不自动放宽**
 *   （避免过拟合、越调越松）。
 * - 每次调参写入 tunes 历史（含前后值、命中率、样本数），页面可一键回滚上一次。
 */
const DEFAULT_BANDS = {
  addBand: 0.3,   // 加仓：次日涨 ≥ 0.3% 算对，跌 ≤ -0.3% 算错
  cutBand: 0.3,   // 减仓：次日跌 ≤ -0.3% 算对，涨 ≥ 0.3% 算错
  holdBand: 1.5,  // 不变：次日 |涨跌| ≤ 该值算对（v2.9.1 从 0.8 提到 1.5：基金次日 |涨跌| 中位数 1.54%）
  evalWindow: 3,  // 决策日后最多几个工作日之内必须拿到次日净值
};

/* v2.9.1：「不变」的判定阈值跟着基金自身波动走（ATR14% × 0.55，夹在 1.2%~3.0%）。
   0.8% 的固定阈值对基金来说等于要求几乎不波动，回测里 68% 的「不变」被判成中性，
   看起来命中率只有 31%，其实是被判定口径吃掉了。 */
const HOLD_BAND_MIN = 1.2;
const HOLD_BAND_MAX = 3.0;
const HOLD_BAND_ATR_K = 0.55;

function holdBandFor(atrPct, bands = DEFAULT_BANDS) {
  const base = Number.isFinite(Number(bands && bands.holdBand)) ? Number(bands.holdBand) : DEFAULT_BANDS.holdBand;
  const atr = Number(atrPct);
  if (!Number.isFinite(atr) || atr <= 0) return base;
  return Math.round(Math.min(HOLD_BAND_MAX, Math.max(HOLD_BAND_MIN, HOLD_BAND_ATR_K * atr)) * 100) / 100;
}

const DEFAULT_AUTOTUNE = {
  enabled: true,      // 全自动调参开关
  minSamples: 20,     // v2.9.1：至少这么多条可判定样本才敢动参数（原 5 太小，噪声当信号）
  minHitRate: 0.5,    // 记录口径（旧逻辑）用：命中率低于它才调
  step: 5,            // 记录口径（旧逻辑）用：每次调整幅度
  minDelta: 0.03,     // v2.9.1：验证段目标函数至少要改善 3% 才采纳
  foldRatio: 0.7,     // v2.9.1：前 70% 训练、后 30% 验证
  maxChanges: 2,      // v2.9.1：单次最多采纳几项（当前实现一次只采纳 1 项，留作上限）
  lastTuneDate: '',   // 已自动调参的日期（每天最多一次）
};

const MAX_RECORDS = 300;
const MAX_TUNES = 30;

function createStrategyLog(deps) {
  const {
    strategyStore,
    collectPortfolio,
    classifyPortfolio,
    normalizeStrategyRules,
    defaultRules,
    todayKey,
    // 15:00 冻结估值的读取（server.js 注入）：用于补记口径修正，只在记录/统计里用，不碰净值。
    getFrozenEstimate,
    // 市场氛围（A 股 + 外围）快照（server.js 注入，来自 push 的 collectMarketPulse）
    collectMarketContext,
    // 历史回测（v2.9.0）：净值序列 / 逐日估值重建 / ETF 日线 / 技术评分 / 市场氛围
    getFundPnlSeries,
    estimateFundHistPctBatch,
    getKline,
    stockAdvice,
    buildMarketContext,
    isEtfLike,
    fundSecid,
  } = deps;

  /* ---------------- 日期工具 ---------------- */

  function dateKeyOf() {
    if (typeof todayKey === 'function') return String(todayKey());
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()).replace(/\//g, '-');
  }

  function weekdayOf(key) {
    const d = new Date(`${String(key).slice(0, 10)}T12:00:00+08:00`);
    return Number.isNaN(d.getTime()) ? -1 : d.getUTCDay();
  }

  function isWeekdayKey(key) {
    const w = weekdayOf(key);
    return w >= 1 && w <= 5;
  }

  /** 决策日之后的前 count 个工作日（YYYY-MM-DD 升序） */
  function nextWeekdayKeys(fromKey, count) {
    const out = [];
    const base = new Date(`${String(fromKey).slice(0, 10)}T12:00:00+08:00`);
    if (Number.isNaN(base.getTime())) return out;
    const cursor = new Date(base.getTime());
    for (let guard = 0; guard < 60 && out.length < count; guard += 1) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const key = cursor.toISOString().slice(0, 10);
      const w = cursor.getUTCDay();
      if (w >= 1 && w <= 5) out.push(key);
    }
    return out;
  }

  function shanghaiClockMinutes() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const hour = Number((parts.find((p) => p.type === 'hour') || {}).value);
    const minute = Number((parts.find((p) => p.type === 'minute') || {}).value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
    return hour * 60 + minute;
  }
  const AUTO_RECORD_AFTER = 14 * 60 + 35; // 14:35 之后允许自动记录（14:30 的推送已发）

  /* ---------------- 存储 ---------------- */

  function clampBands(raw) {
    const bands = { ...DEFAULT_BANDS, ...(raw && typeof raw === 'object' ? raw : {}) };
    for (const key of Object.keys(DEFAULT_BANDS)) {
      const v = Number(bands[key]);
      if (!Number.isFinite(v) || v <= 0) bands[key] = DEFAULT_BANDS[key];
    }
    bands.evalWindow = Math.min(10, Math.max(1, Math.trunc(bands.evalWindow)));
    return bands;
  }

  function clampAutoTune(raw) {
    const cfg = { ...DEFAULT_AUTOTUNE, ...(raw && typeof raw === 'object' ? raw : {}) };
    cfg.enabled = cfg.enabled !== false;
    cfg.minSamples = Math.min(50, Math.max(2, Number(cfg.minSamples) || DEFAULT_AUTOTUNE.minSamples));
    cfg.minHitRate = Math.min(0.95, Math.max(0.05, Number(cfg.minHitRate) || DEFAULT_AUTOTUNE.minHitRate));
    cfg.step = Math.min(20, Math.max(1, Number(cfg.step) || DEFAULT_AUTOTUNE.step));
    cfg.lastTuneDate = String(cfg.lastTuneDate || '');
    return cfg;
  }

  /* ---------------- 补记口径修正（2026-11-18） ---------------- */
  /*
   * 旧版本在 15:00 之后补记/覆盖重记时，会因为当天真实净值已公布而误用净值做决策。
   * 这些记录（late=true 且 items 里 pctKind==='nav'）在读取时用当日 15:00 冻结估值修正
   * 「决策日涨跌」，判定结果不变（判定看的是次日净值），并标记为已修正。
   * 修正只改展示口径，不改当时已经给出的加/减/不变动作。
   */
  function frozenEstimateOn(date, code) {
    if (typeof getFrozenEstimate !== 'function') return null;
    try {
      const hit = getFrozenEstimate(String(code || ''), String(date || ''));
      return hit && hit.pct !== null && hit.pct !== undefined && hit.pct !== '' && Number.isFinite(Number(hit.pct))
        ? hit : null;
    } catch {
      return null;
    }
  }

  function repairDecisionBasis(record) {
    if (!record || !Array.isArray(record.items)) return record;
    if (record.decisionBasis === 'estimate' || record.decisionBasis === 'estimate-repaired') return record;
    if (record.late !== true) return record;
    let changed = false;
    const patch = (it) => {
      if (!it || String(it.pctKind) !== 'nav') return;
      const frozen = frozenEstimateOn(record.date, it.code);
      if (!frozen) return;
      it.repairedPct = it.pct;
      it.pct = Number(frozen.pct);
      it.pctKind = frozen.kind === 'etf' ? 'etf' : 'holdings';
      it.pctSource = 'estimate';
      if (typeof it.reason === 'string') it.reason = it.reason.replace(/今日净值/g, '15:00 估值');
      changed = true;
    };
    record.items.forEach(patch);
    if (record.eval && Array.isArray(record.eval.items)) record.eval.items.forEach(patch);
    if (changed) record.decisionBasis = 'estimate-repaired';
    return record;
  }

  async function safeMarketContext() {
    if (typeof collectMarketContext !== 'function') return null;
    try {
      const ctx = await collectMarketContext();
      return ctx && ctx.available !== false ? ctx : null;
    } catch {
      return null;
    }
  }

  function readStore() {
    const store = {
      rules: normalizeStrategyRules(defaultRules),
      bands: { ...DEFAULT_BANDS },
      records: [],
      tunes: [],
      autoTune: { ...DEFAULT_AUTOTUNE },
    };
    let meta = {};
    try { meta = strategyStore.loadMeta() || {}; } catch { meta = {}; }
    let records = [];
    try { records = strategyStore.loadRecords() || []; } catch { records = []; }
    store.rules = normalizeStrategyRules(meta.rules);
    store.bands = clampBands(meta.bands);
    store.tunes = Array.isArray(meta.tunes) ? meta.tunes : [];
    store.autoTune = clampAutoTune(meta.autoTune);
    // v2.9.0：最近一次历史回测的元信息（区间/条数/跳过），只用于页面展示
    store.backfill = meta.backfill && typeof meta.backfill === 'object' ? meta.backfill : null;
    store.records = records
      .filter((r) => r && r.date)
      .map(repairDecisionBasis)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-MAX_RECORDS);
    return store;
  }

  function saveMeta(store) {
    strategyStore.saveMeta({
      rules: store.rules,
      bands: store.bands,
      tunes: (store.tunes || []).slice(-MAX_TUNES),
      autoTune: store.autoTune,
      ...(store.backfill ? { backfill: store.backfill } : {}),
    });
  }

  function persistRecord(record) {
    strategyStore.saveRecord(record);
  }

  function getRules() {
    return readStore().rules;
  }

  /* ---------------- 判定 ---------------- */

  function judge(action, pct, bands = DEFAULT_BANDS, holdBandOverride = null) {
    const b = { ...DEFAULT_BANDS, ...(bands || {}) };
    if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) {
      return { verdict: 'skipped', note: '次日净值未取到' };
    }
    const p = Number(pct);
    if (action === 'add') {
      if (p >= b.addBand) return { verdict: 'right', note: `次日 +${p.toFixed(2)}%，加仓吃到上涨` };
      if (p <= -b.addBand) return { verdict: 'wrong', note: `次日 ${p.toFixed(2)}%，加仓买在下跌` };
      return { verdict: 'flat', note: `次日 ${p.toFixed(2)}%，在 ±${b.addBand}% 内，方向不明显（中性，不计对错）` };
    }
    if (action === 'cut') {
      if (p <= -b.cutBand) return { verdict: 'right', note: `次日 ${p.toFixed(2)}%，减仓躲开下跌` };
      if (p >= b.cutBand) return { verdict: 'wrong', note: `次日 +${p.toFixed(2)}%，减仓减在上涨` };
      return { verdict: 'flat', note: `次日 ${p.toFixed(2)}%，在 ±${b.cutBand}% 内，方向不明显（中性，不计对错）` };
    }
    // v2.9.1：不变用「该基金当时的自适应阈值」，记录里存了就用它，保证事后评价口径不变
    const holdBand = Number.isFinite(Number(holdBandOverride)) ? Number(holdBandOverride) : b.holdBand;
    if (Math.abs(p) <= holdBand) {
      return { verdict: 'right', note: `次日 ${p.toFixed(2)}%，波动在 ±${holdBand}% 内，不动合理` };
    }
    return { verdict: 'flat', note: `次日 ${p.toFixed(2)}%，超出 ±${holdBand}%：不动是保守选择，记中性（不计对错）` };
  }

  /* ---------------- 记录 ---------------- */

  /** 市场氛围快照（记录里只留用得到的字段，避免把整份行情塞进库） */
  function marketSnapshotOf(market) {
    if (!(market && market.available !== false)) return null;
    return {
      available: true,
      verdict: market.verdict,
      score: market.score,
      cnScore: market.cnScore,
      extScore: market.extScore,
      summary: market.summary,
      ext: market.ext,
      lines: market.lines || [],
    };
  }

  /** 单条建议的落库字段（实盘记录与历史回测共用，避免两套结构漂移） */
  function mapRecordItem(it, bands = DEFAULT_BANDS) {
    return {
      code: it.code,
      name: it.name,
      action: it.action,
      rule: it.rule || '',
      shares: it.shares,
      targetShares: it.targetShares,
      delta: it.delta,
      price: it.price,
      pct: it.pct,
      pctKind: it.pctKind,
      navPct: it.navPct === undefined ? null : it.navPct,
      decisionBasis: it.decisionBasis || it.pctKind,
      navDate: it.navDate,
      weight: it.weight === null ? null : Number(Number(it.weight).toFixed(2)),
      score: it.score,
      fundScore: it.fundScore === undefined ? it.score : it.fundScore,
      marketAdj: it.marketAdj || 0,
      atrPct: it.atrPct === undefined ? null : it.atrPct,
      // v2.9.1：判定「不变」时用的自适应阈值（ATR 校准），事后评价按它复现
      holdBandUsed: it.action === 'hold' ? holdBandFor(it.atrPct, bands) : null,
      reason: it.reason,
    };
  }

  function buildRecord(port, {
    slotTime = '14:30', source = 'manual', date, late = false, rules = defaultRules, bands = DEFAULT_BANDS, market = null,
  } = {}) {
    const effectiveRules = normalizeStrategyRules(rules);
    const effectiveBands = { ...DEFAULT_BANDS, ...(bands || {}) };
    const cls = classifyPortfolio(port, effectiveRules, market);
    const items = [...cls.add, ...cls.cut, ...cls.hold];
    const marketSnapshot = marketSnapshotOf(market);
    return {
      date: date || dateKeyOf(),
      slotTime,
      source,
      // late=true：15:00 之后的手动记录/覆盖重记。注意：late 只影响展示标签，
      // 决策口径永远是 15:00 冻结估值（benchmark 见 classifyPortfolio），不再用真实净值。
      late: Boolean(late),
      decisionBasis: 'estimate',
      createdAt: Date.now(),
      rules: effectiveRules,
      bands: effectiveBands,
      market: marketSnapshot,
      snapshot: {
        today: port.today,
        marketValue: port.totals ? port.totals.marketValue : null,
        portfolioPct: port.totals ? port.totals.portfolioPct : null,
        dayProfit: port.totals ? port.totals.dayProfit : null,
        profit: port.totals ? port.totals.profit : null,
        marketVerdict: marketSnapshot ? marketSnapshot.verdict : '',
        marketScore: marketSnapshot ? marketSnapshot.score : null,
        counts: {
          add: cls.add.length, cut: cls.cut.length, hold: cls.hold.length,
          pending: cls.pending.length, observe: (cls.observe || []).length,
        },
      },
      items: items.map((it) => mapRecordItem(it, effectiveBands)),
      pending: cls.pending.map((r) => ({
        code: r.code, name: r.name, navDate: r.navDate || '', navPct: r.navPct,
        note: r.decisionPct === null ? '没有 15:00 估值，不参与本次决策' : '',
      })),
      observe: (cls.observe || []).map((it) => ({
        code: it.code, name: it.name, action: it.action, rule: it.rule,
        pct: it.pct, score: it.score, reason: it.reason,
      })),
      eval: null,
    };
  }

  /** 记录当天建议；已有当天记录且不覆盖时返回 skipped */
  async function recordNow({ force = false, slotTime = '14:30', source = 'manual', late = false } = {}) {
    const today = dateKeyOf();
    const store = readStore();
    const existing = store.records.find((r) => r.date === today);
    if (existing && !force) {
      return { ok: true, recorded: false, reason: 'already-recorded', date: today };
    }
    // 覆盖重记的关键：无论几点、无论真实净值是否已公布，都重新取各持仓基金的
    // 15:00 当日估值（getFundWatch 在收盘后会把估值冻结/回读）再评估，绝不用净值口径。
    const market = await safeMarketContext();
    const port = await collectPortfolio();
    const afterClose = shanghaiClockMinutes() >= 15 * 60;
    const record = buildRecord(port, {
      slotTime,
      source,
      date: today,
      late: Boolean(late) || afterClose,
      rules: store.rules,
      bands: store.bands,
      market,
    });
    persistRecord(record);
    return {
      ok: true,
      recorded: true,
      date: today,
      counts: record.snapshot.counts,
      items: record.items.length,
      decisionBasis: record.decisionBasis,
      late: record.late,
      market: record.market,
    };
  }

  /* ---------------- 次日评价 ---------------- */

  function summarizeEval(items) {
    const counts = { right: 0, wrong: 0, flat: 0, skipped: 0 };
    for (const it of items) counts[it.verdict] = (counts[it.verdict] || 0) + 1;
    const total = counts.right + counts.wrong + counts.flat + counts.skipped;
    const decided = counts.right + counts.wrong;
    return {
      ...counts,
      total,
      decided,
      // 严格命中率 = 对 / (对 + 错)：中性/未评不进分母，这是自动调参用的口径。
      hitRate: decided > 0 ? counts.right / decided : null,
      // 覆盖率 = 可判定条数 / 全部条数：让「样本被中性/未评吃掉多少」一眼可见。
      coverageRate: total > 0 ? decided / total : null,
      // v2.9.1：中性率（flat/全部）单独列出来，避免把「中性多」误读成「命中率低」。
      neutralRate: total > 0 ? counts.flat / total : null,
    };
  }

  /** 补全旧记录 eval.summary 的新字段（total/coverageRate），不改判定结果 */
  function normalizeEval(ev) {
    if (!ev || !Array.isArray(ev.items)) return ev || null;
    return { ...ev, summary: summarizeEval(ev.items) };
  }

  /**
   * 给未评价的历史记录补评价，返回本次新评价的记录（调用方负责落库）。
   * 只认「已公布净值」；窗口内还没出的留到下次再评，超窗的记 skipped。
   */
  function evaluateRecords(records, port, today = dateKeyOf(), bands = DEFAULT_BANDS) {
    const rowsByCode = new Map(((port && port.rows) || []).map((r) => [String(r.code), r]));
    const changed = [];
    for (const record of records) {
      if (record.eval) continue;
      if (String(record.date) >= today) continue; // 当天还没「次日」
      const allowed = nextWeekdayKeys(record.date, bands.evalWindow);
      if (!allowed.length) continue;
      const windowEnd = allowed[allowed.length - 1];
      const tooLate = today > windowEnd;
      const items = [];
      let waiting = false;
      for (const item of record.items || []) {
        const row = rowsByCode.get(String(item.code));
        const navDate = row ? String(row.navDate || '') : '';
        const usable = Boolean(row) && row.pctKind === 'nav' && allowed.includes(navDate) && row.pct !== null;
        if (usable) {
          const verdict = judge(item.action, row.pct, bands, item.holdBandUsed);
          items.push({ ...item, evalPct: Number(row.pct), evalDate: navDate, verdict: verdict.verdict, note: verdict.note });
        } else if (!tooLate) {
          waiting = true; // 次日净值还没公布，下次再来
        } else {
          items.push({
            ...item,
            evalPct: null,
            evalDate: '',
            verdict: 'skipped',
            note: `评价窗口（决策日后 ${bands.evalWindow} 个工作日）内没拿到次日净值`,
          });
        }
      }
      if (waiting && !tooLate) continue;
      record.eval = {
        evaluatedAt: Date.now(),
        windowEnd,
        basis: '次日已公布净值',
        items,
        summary: summarizeEval(items),
      };
      changed.push(record);
    }
    return changed;
  }

  async function evaluateNow() {
    const store = readStore();
    const port = await collectPortfolio();
    const changed = evaluateRecords(store.records, port, dateKeyOf(), store.bands);
    for (const record of changed) persistRecord(record);
    let tune = null;
    if (changed.length) {
      const after = readStore();
      // v2.9.0：调参样本 = 实盘 + 回测（用户要求回测记录也进自动调参）
      tune = runAutoTune(after, buildStats(after, { source: 'all' }), {});
    }
    return { ok: true, evaluated: changed.length, autoTune: tune };
  }

  /* ---------------- 历史回测（v2.9.0） ----------------
     目标：按**现有规则**把最近半年的每一天重放一遍——
     1) 用当日 15:00 估值口径（重仓穿透 / 目标 ETF 穿透），不拿收盘后净值冒充；
     2) 同一套 classifyPortfolio 出加/减/不变；
     3) 次日用已公布净值 judge，得出合理性判定；
     4) 回测记录与实盘记录一起进统计与自动调参，页面分开展示来源。
     历史估值由 server.js 的 estimateFundHistPctBatch 逐日重建，这里只负责编排。
     ------------------------------------------------- */

  const round4 = (v) => Math.round(Number(v) * 10000) / 10000;

  /** 回测日期：净值序列日期并集为交易日历，取 until 之前最后 N 天，已有记录不重算 */
  function planBackfillDates(calendar, { days = 130, until = '', existing = [] } = {}) {
    const have = new Set((existing || [])
      .map((r) => (typeof r === 'string' ? r : r && r.date))
      .filter(Boolean)
      .map((d) => String(d).slice(0, 10)));
    const list = [...new Set((calendar || [])
      .map((d) => String(d || '').slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))]
      .filter((d) => (!until || d <= until) && !have.has(d))
      .sort();
    const n = Math.max(1, Math.min(400, Math.trunc(Number(days) || 130)));
    return list.slice(-n);
  }

  /** 单日回测记录：结构与实盘完全一致，只是来源 / 口径字段不同 */
  function buildBackfillRecord({ date, rows, totals, rules = defaultRules, bands = DEFAULT_BANDS, market = null }) {
    const effectiveRules = normalizeStrategyRules(rules);
    const effectiveBands = { ...DEFAULT_BANDS, ...(bands || {}) };
    const cls = classifyPortfolio({ rows, totals: totals || {}, today: date }, effectiveRules, market);
    const items = [...cls.add, ...cls.cut, ...cls.hold];
    const marketSnapshot = marketSnapshotOf(market);
    return {
      date,
      slotTime: '14:30',
      source: 'backfill',
      backfill: true,
      late: false,
      // 回测的「当日估值」是逐日重建的（重仓穿透 / 目标 ETF），不是收盘后净值
      decisionBasis: 'estimate-replay',
      createdAt: Date.now(),
      rules: effectiveRules,
      bands: effectiveBands,
      market: marketSnapshot,
      snapshot: {
        today: date,
        marketValue: totals ? totals.marketValue : null,
        portfolioPct: totals ? totals.portfolioPct : null,
        dayProfit: totals ? totals.dayProfit : null,
        profit: totals ? totals.profit : null,
        marketVerdict: marketSnapshot ? marketSnapshot.verdict : '',
        marketScore: marketSnapshot ? marketSnapshot.score : null,
        counts: {
          add: cls.add.length, cut: cls.cut.length, hold: cls.hold.length,
          pending: cls.pending.length, observe: (cls.observe || []).length,
        },
      },
      items: items.map((it) => mapRecordItem(it, effectiveBands)),
      pending: cls.pending.map((r) => ({
        code: r.code,
        name: r.name,
        navDate: r.navDate || '',
        navPct: r.navPct,
        note: '当日 15:00 估值不可用（QDII / 无持仓 / 覆盖率不足），不参与回测决策',
      })),
      observe: (cls.observe || []).map((it) => ({
        code: it.code, name: it.name, action: it.action, rule: it.rule,
        pct: it.pct, score: it.score, reason: it.reason,
      })),
      eval: null,
    };
  }

  /** 回测记录的次日判定：窗口内第一个已公布净值日，与实盘同一个 judge */
  function evaluateBackfillRecord(record, { navByCode, bands = DEFAULT_BANDS } = {}) {
    const allowed = nextWeekdayKeys(record.date, bands.evalWindow);
    const windowEnd = allowed.length ? allowed[allowed.length - 1] : '';
    const items = (record.items || []).map((it) => {
      const series = navByCode && typeof navByCode.get === 'function' ? navByCode.get(String(it.code)) : null;
      let hit = null;
      if (series) {
        for (const d of allowed) {
          const row = series.get(d);
          // Number(null) === 0：序列首日没有前一交易日，pct 是 null，不能算成 0%
          if (row && row.pct !== null && row.pct !== undefined && Number.isFinite(Number(row.pct))) {
            hit = { d, pct: Number(row.pct) };
            break;
          }
        }
      }
      if (!hit) {
        return {
          ...it,
          evalPct: null,
          evalDate: '',
          verdict: 'skipped',
          note: `评价窗口（决策日后 ${bands.evalWindow} 个工作日）内没拿到次日净值`,
        };
      }
      const verdict = judge(it.action, hit.pct, bands, it.holdBandUsed);
      return { ...it, evalPct: hit.pct, evalDate: hit.d, verdict: verdict.verdict, note: verdict.note };
    });
    return {
      ...record,
      eval: { evaluatedAt: Date.now(), windowEnd, basis: '次日已公布净值（回测）', items, summary: summarizeEval(items) },
    };
  }

  /**
   * 跑一次回测。
   * 依赖（server.js 注入）：
   *   getFundPnlSeries(codes, days)              → 每只基金的净值/收盘序列
   *   estimateFundHistPctBatch({funds,dates})    → 逐日「15:00 估值」重建（与实盘同一公式）
   *   getKline(secid, 101, limit)                → ETF 真实日线 / 三大指数
   *   stockAdvice(quote, candles, {risk})        → 技术评分（与实盘同一函数）
   *   buildMarketContext(pulse)                  → 市场氛围（与实盘同一函数）
   */
  /* ---------------- 历史回测 / 重放引擎（v2.9.0，v2.9.1 抽出重放） ----------------
     1) buildHistory：抓净值/日线/重仓股，逐日重建 15:00 估值 + 技术评分，得到「每日行」；
     2) replay：用给定参数把这些行重新跑一遍 classifyPortfolio + 次日判定（纯计算）；
     3) backfillNow：replay + 落库 + 记录区间；
     4) tuneSearch：在 replay 上做坐标搜索 + 前后验证，给出更优参数建议。
     历史行缓存在进程内 10 分钟，回测/体检/调参共用，避免重复抓行情。
     ------------------------------------------------- */
  let historyCache = null; // { at, key, history }

  async function buildHistory({ days = 130, refresh = false } = {}) {
    const windowDays = Math.max(30, Math.min(180, Math.trunc(Number(days) || 130)));
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (typeof getFundPnlSeries !== 'function' || typeof estimateFundHistPctBatch !== 'function') {
      throw Object.assign(new Error('回测依赖未就绪'), { status: 503 });
    }
    const port = await collectPortfolio().catch((err) => {
      throw bad(`读不到持仓：${(err && err.message) || '请先在基金页同步自选基金与持仓'}`);
    });
    const held = (port && (port.heldRows || (port.rows || []).filter((r) => r.held))) || [];
    if (!held.length) throw bad('还没有录入持仓：先在「自选基金」表格点「仓」填份额，再回测');

    const codes = held.map((r) => String(r.code)).filter(Boolean);
    const cacheKey = `${windowDays}|${codes.join(',')}|${dateKeyOf()}`;
    if (!refresh && historyCache && historyCache.key === cacheKey && Date.now() - historyCache.at < 10 * 60 * 1000) {
      return historyCache.history;
    }

    const rawDays = windowDays + 80;
    const seriesRes = await getFundPnlSeries(codes, Math.min(500, rawDays));
    const items = (seriesRes && seriesRes.items) || [];
    if (!items.length) throw bad('净值历史取不到，稍后再试');

    // 每只基金：日期 → { nav, pct }（pct 相对前一交易日）
    const navByCode = new Map();
    const datesByCode = new Map();
    const calendarSet = new Set();
    for (const it of items) {
      const code = String(it.code);
      const m = new Map();
      for (const p of it.points || []) {
        const d = String(p.d || '').slice(0, 10);
        const c = Number(p.c);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !(c > 0)) continue;
        m.set(d, { nav: c, pct: null });
        calendarSet.add(d);
      }
      const ds = [...m.keys()].sort();
      for (let i = 1; i < ds.length; i += 1) {
        const cur = m.get(ds[i]);
        const prev = m.get(ds[i - 1]);
        if (prev.nav > 0) cur.pct = round4(((cur.nav - prev.nav) / prev.nav) * 100);
      }
      navByCode.set(code, m);
      datesByCode.set(code, ds);
    }
    const calendar = [...calendarSet].sort();
    if (!calendar.length) throw bad('没有可用的净值日期');

    const today = dateKeyOf();
    // 只回测「今天之前」的交易日：今天的建议由 14:35 实盘记录负责
    const until = calendar.filter((d) => d < today).slice(-1)[0] || '';
    if (!until) throw bad('净值历史还不足一个交易日');

    const plan = planBackfillDates(calendar, { days: windowDays, until });
    if (!plan.length) throw bad('没有可回测的交易日');

    // 逐日「15:00 估值」：重仓穿透 / 目标 ETF 穿透，与实盘同一公式
    const estMap = await estimateFundHistPctBatch({
      funds: held.map((r) => ({ code: String(r.code), name: r.name || '' })),
      dates: plan,
    });

    // ETF 真实日线（技术评分要用真实高低价）。判定与实盘一致：按代码前缀，
    // 不按名称（「XX ETF 联接 C」名称里有 ETF，但它是场外基金，走估值而不是场内价）。
    const etfSet = new Set();
    for (const r of held) {
      const code = String(r.code);
      const byCode = typeof isEtfLike === 'function' ? isEtfLike(code, '') : false;
      const byType = String(r.type) === 'etf' && typeof fundSecid === 'function' && Boolean(fundSecid(code));
      if (byCode || byType) etfSet.add(code);
    }
    const etfCandles = new Map();
    if (typeof getKline === 'function') {
      for (const code of etfSet) {
        const secid = typeof fundSecid === 'function' ? fundSecid(code) : null;
        if (!secid) continue;
        try {
          const k = await getKline(secid, 101, Math.min(400, rawDays));
          const candles = ((k && k.candles) || [])
            .map((c) => ({
              d: String(c.d || '').slice(0, 10),
              o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c),
              v: Number(c.v) || 0,
            }))
            .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.d) && c.c > 0)
            .sort((a, b) => a.d.localeCompare(b.d));
          for (let i = 1; i < candles.length; i += 1) {
            candles[i].pct = candles[i - 1].c > 0
              ? round4(((candles[i].c - candles[i - 1].c) / candles[i - 1].c) * 100)
              : null;
          }
          etfCandles.set(code, candles);
        } catch { /* 单只 ETF 取不到就按「未更新」处理 */ }
      }
    }

    // 三大指数日线 → 市场氛围（涨跌家数 / 成交额历史不可得，按缺失计 0，与实盘缺数据时一致）
    const indexPct = new Map();
    if (typeof getKline === 'function' && typeof buildMarketContext === 'function') {
      for (const [key, secid] of [['sh', '1.000001'], ['sz', '0.399001'], ['cyb', '0.399006']]) {
        try {
          const k = await getKline(secid, 101, Math.min(400, rawDays));
          const m = new Map();
          const cs = ((k && k.candles) || []).map((c) => ({ d: String(c.d || '').slice(0, 10), c: Number(c.c) }))
            .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.d) && c.c > 0);
          for (let i = 1; i < cs.length; i += 1) m.set(cs[i].d, round4(((cs[i].c - cs[i - 1].c) / cs[i - 1].c) * 100));
          indexPct.set(key, m);
        } catch { /* 指数缺失 → 该日市场氛围记不可用 */ }
      }
    }
    const marketByDate = new Map();
    const marketOf = (date) => {
      if (marketByDate.has(date)) return marketByDate.get(date);
      let market = null;
      if (typeof buildMarketContext === 'function' && indexPct.size) {
        const pctOf = (key) => {
          const m = indexPct.get(key);
          return m && m.has(date) ? m.get(date) : null;
        };
        const pulse = {
          sh: { pct: pctOf('sh') },
          sz: { pct: pctOf('sz') },
          cyb: { pct: pctOf('cyb') },
          breadth: {},
          amountYi: null,
          mainYi: null,
        };
        try {
          const got = buildMarketContext(pulse);
          market = got && got.available !== false ? got : null;
        } catch { market = null; }
      }
      marketByDate.set(date, market);
      return market;
    };

    // 单只基金某天的行情切片：净值序列（场外）或日线（ETF）
    const prevOf = (code, date) => {
      const ds = datesByCode.get(code) || [];
      let lo = 0;
      let hi = ds.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ds[mid] < date) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      if (idx < 0) return null;
      return { d: ds[idx], ...(navByCode.get(code) || new Map()).get(ds[idx]) };
    };
    const openHistoryOf = (code, date, estPct, price) => {
      const ds = (datesByCode.get(code) || []).filter((d) => d < date).slice(-80);
      const m = navByCode.get(code) || new Map();
      const bars = ds.map((d) => {
        const row = m.get(d);
        return { d, o: row.nav, h: row.nav, l: row.nav, c: row.nav, v: 0, pct: row.pct };
      });
      const last = bars[bars.length - 1];
      if (last && estPct !== null) {
        bars.push({
          d: date,
          o: last.c,
          h: Math.max(last.c, price),
          l: Math.min(last.c, price),
          c: price,
          v: 0,
          pct: estPct,
          est: true,
        });
      }
      return bars;
    };
    const etfHistoryOf = (code, date) => {
      const candles = etfCandles.get(code) || [];
      const upTo = [];
      for (let i = 0; i < candles.length; i += 1) {
        if (candles[i].d <= date) upTo.push(candles[i]);
        else break;
      }
      return upTo;
    };

    let skipped = 0;
    const rowsByDate = new Map();
    const estimateKinds = new Map();
    for (const date of plan) {
      const rows = [];
      const kinds = new Set();
      for (const r of held) {
        const code = String(r.code);
        const shares = Number(r.shares) || 0;
        const cost = Number(r.cost) || 0;
        if (!(shares > 0)) continue;
        let price = null;
        let pct = null;
        let pctKind = 'stale';
        let navDate = '';
        let navPct = null;
        let advice = null;

        if (etfSet.has(code)) {
          const candles = etfHistoryOf(code, date);
          const lastBar = candles[candles.length - 1];
          if (!lastBar) { skipped += 1; continue; }
          price = lastBar.c;
          pct = lastBar.pct === undefined ? null : lastBar.pct;
          pctKind = pct === null ? 'stale' : 'market';
          navDate = lastBar.d;
          navPct = pct;
          if (pct !== null && typeof stockAdvice === 'function' && candles.length >= 20) {
            try {
              advice = stockAdvice({ name: r.name || code, price, pct }, candles, { risk: 'balanced' });
            } catch { advice = null; }
          }
        } else {
          const prev = prevOf(code, date);
          if (!prev) { skipped += 1; continue; }
          const est = estMap && estMap.get ? (estMap.get(code) || new Map()).get(date) : null;
          // 注意 Number(null) === 0：缺估值必须显式判空，不能把 null 当成 0% 估值
          const estPct = est && est.pct !== null && est.pct !== undefined && est.pct !== ''
            && Number.isFinite(Number(est.pct))
            ? Number(est.pct)
            : null;
          const estKind = est && est.kind ? String(est.kind) : '';
          navDate = prev.d;
          navPct = prev.pct;
          if (estPct === null) {
            price = prev.nav;
            pct = null;
            pctKind = 'stale';
          } else {
            price = round4(prev.nav * (1 + estPct / 100));
            pct = estPct;
            pctKind = estKind || 'holdings';
            kinds.add(estKind || 'holdings');
            if (typeof stockAdvice === 'function') {
              const bars = openHistoryOf(code, date, estPct, price);
              if (bars.length >= 20) {
                try {
                  advice = stockAdvice({ name: r.name || code, price, pct: estPct }, bars, { risk: 'balanced' });
                } catch { advice = null; }
              }
            }
          }
        }
        if (!(price > 0)) { skipped += 1; continue; }
        rows.push({
          code,
          name: r.name || code,
          type: r.type || (etfSet.has(code) ? 'etf' : 'open'),
          held: true,
          shares,
          cost: cost > 0 ? cost : null,
          price,
          pct,
          pctKind,
          // 决策口径与实盘一致：有估值就用估值，ETF 用收盘价，否则进「未更新」组
          decisionPct: pct,
          decisionKind: pctKind,
          navDate,
          navPct,
          pctStale: pct === null,
          marketValue: price * shares,
          profit: cost > 0 ? price * shares - cost * shares : null,
          weight: null,
          advice,
        });
      }
      if (!rows.length) { rowsByDate.set(date, []); continue; }
      const marketValue = rows.reduce((s, x) => s + x.marketValue, 0);
      let costValue = 0;
      let dayProfit = 0;
      let dayValue = 0;
      for (const x of rows) {
        if (x.cost && x.cost > 0) costValue += x.cost * x.shares;
        if (x.pct !== null) {
          dayProfit += (x.marketValue * Number(x.pct)) / (100 + Number(x.pct));
          dayValue += x.marketValue;
        }
        x.weight = marketValue > 0 ? (x.marketValue / marketValue) * 100 : null;
      }
      const profit = costValue > 0 ? marketValue - costValue : null;
      rowsByDate.set(date, rows);
      rows.totals = {
        marketValue,
        costValue,
        dayProfit,
        dayValue,
        profit,
        profitPct: costValue > 0 && profit !== null ? (profit / costValue) * 100 : null,
        portfolioPct: dayValue > 0 ? (dayProfit / dayValue) * 100 : null,
        held: rows.length,
        covered: rows.filter((x) => x.pct !== null).length,
      };
      estimateKinds.set(date, [...kinds]);
      marketOf(date);
    }

    const history = {
      days: windowDays,
      from: plan[0] || '',
      to: plan[plan.length - 1] || '',
      until,
      dates: plan,
      rowsByDate,
      totalsByDate: new Map([...rowsByDate.entries()].map(([d, rs]) => [d, rs.totals || null])),
      markets: marketByDate,
      navByCode,
      etfSet: [...etfSet],
      codes,
      missing: (seriesRes && seriesRes.missing) || [],
      skipped,
      estimateKinds,
      at: Date.now(),
    };
    historyCache = { at: Date.now(), key: cacheKey, history };
    return history;
  }

  /** 用给定参数把历史行重放一遍（纯计算；不落库） */
  function replay(history, rules = defaultRules, bands = DEFAULT_BANDS) {
    const effectiveRules = normalizeStrategyRules(rules);
    const effectiveBands = { ...DEFAULT_BANDS, ...(bands || {}) };
    const records = [];
    let empty = 0;
    for (const date of (history && history.dates) || []) {
      const rows = (history.rowsByDate && history.rowsByDate.get(date)) || [];
      if (!rows.length) { empty += 1; continue; }
      const totals = rows.totals || (history.totalsByDate && history.totalsByDate.get(date)) || {};
      const record = buildBackfillRecord({
        date,
        rows,
        totals,
        rules: effectiveRules,
        bands: effectiveBands,
        market: history.markets ? history.markets.get(date) || null : null,
      });
      if (!record.items.length) { empty += 1; continue; }
      record.estimateKinds = (history.estimateKinds && history.estimateKinds.get(date)) || [];
      records.push(evaluateBackfillRecord(record, { navByCode: history.navByCode, bands: effectiveBands }));
    }
    return { records, empty };
  }

  async function backfillNow({ days = 130, force = false } = {}) {
    const windowDays = Math.max(30, Math.min(180, Math.trunc(Number(days) || 130)));
    const history = await buildHistory({ days: windowDays, refresh: force });
    const store = readStore();
    const existing = new Set(store.records
      .filter((r) => !(force && r.source === 'backfill'))
      .map((r) => r.date));
    const writable = history.dates.filter((d) => !existing.has(d));
    if (!writable.length) {
      return {
        ok: true, records: 0, skipped: history.skipped, empty: 0,
        from: history.from, to: history.to, missing: history.missing,
        reason: 'nothing-to-do', tune: null,
      };
    }
    const replayed = replay(history, store.rules, store.bands);
    const wanted = new Set(writable);
    let made = 0;
    let empty = 0;
    for (const record of replayed.records) {
      if (!wanted.has(record.date)) { empty += 1; continue; }
      persistRecord(record);
      made += 1;
    }
    // 没有任何建议的日期（全「未更新」）不计入落库
    const skippedEmpty = writable.length - made;

    const after = readStore();
    after.backfill = {
      at: Date.now(),
      days: windowDays,
      from: history.from,
      to: history.to,
      records: made,
      skipped: history.skipped,
      empty: skippedEmpty,
      missing: history.missing,
      codes: history.codes.length,
    };
    saveMeta(after);
    // 回测样本立刻参与自动调参（用户要求），结果与调参历史都可回滚
    const tune = await runAutoTuneV2({ force: true, history }).catch(() => null);
    return {
      ok: true,
      records: made,
      skipped: history.skipped,
      empty: skippedEmpty,
      from: history.from,
      to: history.to,
      missing: history.missing,
      tune,
    };
  }

  /* ---------------- 参数体检 / 自动调参 v2（v2.9.1） ----------------
     目标函数 = 方向性命中率 × sqrt(覆盖率)，样本不足不动；
     坐标搜索（每次只动 1 个参数、±1 步），前 70% 训练选参、后 30% 验证确认，
     验证改善 ≥ minDelta 才采纳，避免「同一批样本既调又评」的过拟合。
     ------------------------------------------------- */
  // eslint-disable-next-line no-unused-vars
  const TUNE_FIELDS = ['addScore', 'cutScore', 'addDip', 'cutDip', 'cutMaxDip', 'maxActionsPerDay', 'baseRatio', 'marketWeight', 'addTrendConfirm'];

  function statsOfRecords(records) {
    const items = [];
    for (const r of records || []) for (const it of (r && r.eval && r.eval.items) || []) items.push(it);
    return summarizeEval(items);
  }

  function objectiveOf(stats, minSamples = 20) {
    if (!stats || !Number.isFinite(stats.decided) || stats.decided < Math.max(10, minSamples)) return null;
    const hit = Number.isFinite(stats.hitRate) ? stats.hitRate : 0;
    const cov = Number.isFinite(stats.coverageRate) ? stats.coverageRate : 0;
    return Math.round(hit * Math.sqrt(Math.max(0.01, cov)) * 10000) / 10000;
  }

  function splitRecords(records, foldRatio = 0.7) {
    const rows = [...(records || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const ratio = Math.min(0.9, Math.max(0.5, Number(foldRatio) || 0.7));
    const cut = Math.max(1, Math.floor(rows.length * ratio));
    return { train: rows.slice(0, cut), validate: rows.slice(cut) };
  }

  /** 候选参数：每次只动一个字段，幅度有上限（避免一步跳太远） */
  function candidateMoves(rules) {
    const R = normalizeStrategyRules(rules);
    const moves = [];
    const add = (field, to, step) => {
      const next = normalizeStrategyRules({ ...R, [field]: to })[field];
      if (String(next) !== String(R[field])) moves.push({ field, from: R[field], to: next, step });
    };
    add('addScore', R.addScore + 5, '+5');
    add('addScore', R.addScore - 5, '-5');
    add('cutScore', R.cutScore + 5, '+5');
    add('cutScore', R.cutScore - 5, '-5');
    add('addDip', R.addDip + 0.4, '+0.4');
    add('addDip', R.addDip - 0.4, '-0.4');
    add('cutDip', R.cutDip + 0.5, '+0.5');
    add('cutDip', R.cutDip - 0.5, '-0.5');
    add('cutMaxDip', R.cutMaxDip + 1, '+1');
    add('cutMaxDip', R.cutMaxDip - 1, '-1');
    add('maxActionsPerDay', R.maxActionsPerDay + 1, '+1');
    add('maxActionsPerDay', R.maxActionsPerDay - 1, '-1');
    add('baseRatio', R.baseRatio + 5, '+5');
    add('baseRatio', R.baseRatio - 5, '-5');
    add('marketWeight', R.marketWeight + 0.5, '+0.5');
    add('marketWeight', R.marketWeight - 0.5, '-0.5');
    moves.push({ field: 'addTrendConfirm', from: R.addTrendConfirm, to: !R.addTrendConfirm, step: 'toggle' });
    return moves;
  }

  let lastSearch = null; // 最近一次体检结果，applyTuneCandidate 只接受它推荐的那一档

  /**
   * 参数体检：不改参数，只返回「当前参数 vs 建议参数」以及训练 / 验证两段指标。
   * 数据来自 buildHistory + replay（与回测同一份历史，不重复抓行情）。
   */
  async function tuneSearch({ days = 130, refresh = false } = {}) {
    const history = await buildHistory({ days, refresh });
    const store = readStore();
    const cfg = store.autoTune;
    const bands = store.bands;
    const minSamples = Math.min(200, Math.max(5, Number(cfg.minSamples) || 20));
    const minDelta = Math.min(0.5, Math.max(0.005, Number(cfg.minDelta) || 0.03));
    const foldRatio = Math.min(0.9, Math.max(0.5, Number(cfg.foldRatio) || 0.7));

    const baseReplay = replay(history, store.rules, bands);
    const baseSplit = splitRecords(baseReplay.records, foldRatio);
    const baseTrain = statsOfRecords(baseSplit.train);
    const baseValid = statsOfRecords(baseSplit.validate);
    const baseTrainObj = objectiveOf(baseTrain, minSamples);
    const baseValidObj = objectiveOf(baseValid, minSamples);

    const candidates = [];
    for (const mv of candidateMoves(store.rules)) {
      const res = replay(history, { ...store.rules, [mv.field]: mv.to }, bands);
      const split = splitRecords(res.records, foldRatio);
      const t = statsOfRecords(split.train);
      const v = statsOfRecords(split.validate);
      candidates.push({
        field: mv.field,
        from: mv.from,
        to: mv.to,
        step: mv.step,
        train: { ...t, objective: objectiveOf(t, minSamples) },
        validate: { ...v, objective: objectiveOf(v, minSamples) },
      });
    }
    const rank = (c) => (Number.isFinite(c.train.objective) ? c.train.objective : -1);
    candidates.sort((a, b) => rank(b) - rank(a));
    const best = candidates.find((c) => Number.isFinite(c.train.objective)
      && Number.isFinite(c.validate.objective)
      && baseTrainObj !== null && baseValidObj !== null
      && c.train.objective > baseTrainObj + 1e-9
      && c.validate.objective >= baseValidObj + minDelta) || null;
    const brief = (c) => ({
      objective: c.objective,
      hitRate: c.hitRate,
      coverageRate: c.coverageRate,
      neutralRate: c.neutralRate,
      decided: c.decided,
      total: c.total,
    });
    const payload = {
      ok: true,
      sample: {
        days: history.days,
        from: history.from,
        to: history.to,
        records: baseReplay.records.length,
        codes: history.codes.length,
      },
      rules: store.rules,
      baseline: {
        train: brief({ ...baseTrain, objective: baseTrainObj }),
        validate: brief({ ...baseValid, objective: baseValidObj }),
      },
      candidates: candidates.slice(0, 8).map((c) => ({
        field: c.field,
        from: c.from,
        to: c.to,
        step: c.step,
        train: brief(c.train),
        validate: brief(c.validate),
      })),
      best: best
        ? { field: best.field, from: best.from, to: best.to, step: best.step, train: brief(best.train), validate: brief(best.validate) }
        : null,
      minSamples,
      minDelta,
      foldRatio,
    };
    lastSearch = { at: Date.now(), payload };
    return payload;
  }

  /** 采纳体检建议（只接受最近一次体检推荐的那一档，避免前端传任意值） */
  function applyTuneCandidate({ field, to } = {}) {
    const recommended = lastSearch && lastSearch.payload && lastSearch.payload.best;
    if (!recommended) return { ok: false, reason: 'no-search', message: '先跑一次「参数体检」' };
    if (String(recommended.field) !== String(field) || String(recommended.to) !== String(to)) {
      return { ok: false, reason: 'not-recommended', message: '只接受最近一次体检推荐的那一档参数' };
    }
    const store = readStore();
    const next = normalizeStrategyRules({ ...store.rules, [recommended.field]: recommended.to });
    if (String(next[recommended.field]) === String(store.rules[recommended.field])) {
      return { ok: false, reason: 'no-change', message: '参数已经是该值' };
    }
    const before = { ...store.rules };
    store.rules = next;
    const tune = {
      at: Date.now(),
      date: dateKeyOf(),
      trigger: 'search',
      changes: [{
        field: recommended.field,
        from: before[recommended.field],
        to: next[recommended.field],
        hitRate: recommended.validate.hitRate,
        samples: recommended.validate.decided,
      }],
      before,
      after: { ...next },
      metrics: { baseline: lastSearch.payload.baseline, best: recommended, sample: lastSearch.payload.sample },
    };
    store.tunes = [...(store.tunes || []), tune].slice(-MAX_TUNES);
    saveMeta(store);
    return { ok: true, rules: next, tune };
  }

  /**
   * 自动调参 v2：回放历史 → 坐标搜索 → 前后验证 → 只采纳一项。
   * 历史取不到（离线/无持仓）时退回记录口径，保证每日仍有动作。
   */
  async function runAutoTuneV2({ force = false, history = null } = {}) {
    const store = readStore();
    const cfg = store.autoTune;
    if (!cfg.enabled && !force) return { tuned: false, reason: 'disabled' };
    const today = dateKeyOf();
    if (!force && cfg.lastTuneDate === today) return { tuned: false, reason: 'already-tuned-today' };
    let search = null;
    try {
      if (history) {
        historyCache = { at: Date.now(), key: `${history.days}|${(history.codes || []).join(',')}|${today}`, history };
        search = await tuneSearch({ days: history.days });
      } else {
        search = await tuneSearch({ days: 130 });
      }
    } catch {
      const fallback = runAutoTune(store, buildStats(store, { source: 'all' }), { manual: true, force });
      return { ...fallback, mode: 'records' };
    }
    if (!search || !search.best) {
      store.autoTune.lastTuneDate = today;
      saveMeta(store);
      return { tuned: false, reason: 'no-improvement', search };
    }
    const best = search.best;
    const before = { ...store.rules };
    store.rules = normalizeStrategyRules({ ...store.rules, [best.field]: best.to });
    store.autoTune.lastTuneDate = today;
    const tune = {
      at: Date.now(),
      date: today,
      trigger: force ? 'backfill' : 'auto-replay',
      changes: [{
        field: best.field,
        from: before[best.field],
        to: store.rules[best.field],
        hitRate: best.validate.hitRate,
        samples: best.validate.decided,
      }],
      before,
      after: { ...store.rules },
      metrics: { baseline: search.baseline, best, sample: search.sample },
    };
    store.tunes = [...(store.tunes || []), tune].slice(-MAX_TUNES);
    saveMeta(store);
    return { tuned: true, tune, search };
  }

  /* ---------------- 统计 ---------------- */

  function bucketOfScore(score) {
    if (score === null || score === undefined || !Number.isFinite(Number(score))) return '无评分';
    const s = Number(score);
    if (s < 35) return '<35';
    if (s < 45) return '35-45';
    if (s < 65) return '45-65';
    if (s < 80) return '65-80';
    return '>=80';
  }

  function buildStats(store, { source = 'all' } = {}) {
    const records = (store.records || []).filter((r) => {
      if (source === 'live') return r.source !== 'backfill';
      if (source === 'backfill') return r.source === 'backfill';
      return true;
    });
    const evaluated = records.filter((r) => r.eval);
    const pairs = [];
    for (const r of evaluated) for (const it of r.eval.items || []) pairs.push({ it, record: r });
    const items = pairs.map((p) => p.it);

    const byAction = {};
    for (const action of ['add', 'cut', 'hold']) {
      const sub = items.filter((it) => it.action === action);
      byAction[action] = { n: sub.length, ...summarizeEval(sub) };
    }

    // 评分区间只统计「加仓 / 减仓」：不变没有方向性评分，硬分档会误导。
    const byScore = {};
    const scoreGroups = {};
    for (const it of items.filter((x) => x.action === 'add' || x.action === 'cut')) {
      const key = bucketOfScore(it.score);
      if (!scoreGroups[key]) scoreGroups[key] = [];
      scoreGroups[key].push(it);
    }
    for (const key of Object.keys(scoreGroups)) {
      byScore[key] = { n: scoreGroups[key].length, ...summarizeEval(scoreGroups[key]) };
    }

    // 按市场氛围分档：验证「偏空时少加仓 / 偏多时多加仓」到底有没有效果。
    const byMarket = {};
    const marketGroups = {};
    for (const { it, record } of pairs) {
      const key = (record.market && record.market.verdict) || '未记录';
      if (!marketGroups[key]) marketGroups[key] = [];
      marketGroups[key].push(it);
    }
    for (const key of Object.keys(marketGroups)) {
      byMarket[key] = { n: marketGroups[key].length, ...summarizeEval(marketGroups[key]) };
    }

    const overall = summarizeEval(items);
    const recent = evaluated
      .slice(-10)
      .reverse()
      .map((r) => ({ date: r.date, counts: summarizeEval(r.eval.items || []), hitRate: summarizeEval(r.eval.items || []).hitRate }));

    return {
      days: evaluated.length,
      items: items.length,
      overall,
      byAction,
      byScore,
      byMarket,
      recent,
      lastEvaluated: evaluated.length ? evaluated[evaluated.length - 1].date : null,
    };
  }

  /** 文字建议（人工参考；实际改参数由下面的自动调参完成） */
  function buildSuggestions(stats, rules) {
    const out = [];
    const rate = (x) => (x && x.hitRate !== null ? `${(x.hitRate * 100).toFixed(0)}%（${x.right}/${x.decided}）` : '样本不足');
    const add = stats.byAction.add;
    const cut = stats.byAction.cut;

    if (add.decided >= 5 && add.hitRate !== null && add.hitRate < 0.5) {
      const next = Math.min(100, Number(rules.addScore) + 5);
      out.push({
        key: 'addScore',
        level: 'warn',
        text: `加仓命中率只有 ${rate(add)}：次日在加仓后多数没涨。建议把加仓评分门槛从 ${rules.addScore} 提到 ${next}，或把强信号比例从 ${rules.strongRatio}% 降到常规 ${rules.baseRatio}%（仍不少于 1 成），减少「抄底抄在半山腰」。`,
      });
    } else if (add.decided >= 5 && add.hitRate !== null && add.hitRate >= 0.6) {
      out.push({ key: 'addScore', level: 'ok', text: `加仓命中率 ${rate(add)}，当前评分门槛 ${rules.addScore} 有效，先保持不变继续积累样本。` });
    }

    if (cut.decided >= 5 && cut.hitRate !== null && cut.hitRate < 0.5) {
      const next = Math.max(20, Number(rules.cutScore) - 5);
      out.push({
        key: 'cutScore',
        level: 'warn',
        text: `减仓命中率只有 ${rate(cut)}：减仓后次日反而上涨。建议把减仓评分门槛从 ${rules.cutScore} 降到 ${next}（只在更弱的票上减），或把减仓触发涨幅从 ${rules.cutRise}% 调高到 ${(Number(rules.cutRise) + 0.4).toFixed(1)}%。`,
      });
    } else if (cut.decided >= 5 && cut.hitRate !== null && cut.hitRate >= 0.6) {
      out.push({ key: 'cutScore', level: 'ok', text: `减仓命中率 ${rate(cut)}，当前减仓门槛 ${rules.cutScore} 有效。` });
    }

    const hold = stats.byAction.hold;
    if (hold.n >= 10 && hold.flat > hold.right) {
      out.push({
        key: 'holdBand',
        level: 'info',
        text: `「不变」里有 ${hold.flat} 条次日出现了明显方向：说明当时的信号偏保守。可以考虑放宽加仓/减仓的触发阈值（例如跌幅门槛从 ${rules.addDip}% 降到 ${Math.max(0.6, Number(rules.addDip) - 0.4).toFixed(1)}%），让更多标的参与判断。`,
      });
    }

    const bear = stats.byMarket && stats.byMarket['偏空'];
    if (bear && bear.decided >= 5 && bear.hitRate !== null && bear.hitRate < 0.5) {
      out.push({
        key: 'marketWeight',
        level: 'warn',
        text: `偏空氛围下命中率只有 ${rate(bear)}：说明逆着市场加/减仓容易吃亏。建议把「市场氛围权重」从 ${rules.marketWeight} 调高到 ${Math.min(2, Number(rules.marketWeight) + 0.3).toFixed(1)}，让偏空时加减仓判断更谨慎。`,
      });
    } else if (bear && bear.decided >= 5 && bear.hitRate !== null && bear.hitRate >= 0.6) {
      out.push({
        key: 'marketWeight',
        level: 'ok',
        text: `偏空氛围下命中率 ${rate(bear)}，当前市场氛围权重 ${rules.marketWeight} 有效，先保持。`,
      });
    }

    if (stats.days < 5) {
      out.push({
        key: 'sample',
        level: 'info',
        text: `目前只有 ${stats.days} 个交易日的样本，命中率还不足以下结论。建议先积累到 10 个交易日以上（每个交易日 14:35 自动记录），再依据统计调参。`,
      });
    }
    return out;
  }

  /* ---------------- 自动调参 ---------------- */

  /**
   * 按命中率自动改评分门槛。返回 { tuned, tune?, reason }。
   * 只动 addScore / cutScore，且每天最多一次；命中率达标时不动（不自动放宽）。
   */
  function runAutoTune(store, stats, { force = false, manual = false } = {}) {
    const cfg = store.autoTune;
    if (!cfg.enabled && !force) return { tuned: false, reason: 'disabled' };
    const today = dateKeyOf();
    if (!force && cfg.lastTuneDate === today) return { tuned: false, reason: 'already-tuned-today' };

    const add = stats.byAction.add || {};
    const cut = stats.byAction.cut || {};
    const changes = [];
    const before = { ...store.rules };

    if (add.decided >= cfg.minSamples && add.hitRate !== null && add.hitRate < cfg.minHitRate) {
      const next = Math.min(100, Number(store.rules.addScore) + cfg.step);
      if (next !== Number(store.rules.addScore)) {
        store.rules.addScore = next;
        changes.push({ field: 'addScore', from: before.addScore, to: next, hitRate: add.hitRate, samples: add.decided });
      }
    }
    if (cut.decided >= cfg.minSamples && cut.hitRate !== null && cut.hitRate < cfg.minHitRate) {
      const next = Math.max(5, Number(store.rules.cutScore) - cfg.step);
      if (next !== Number(store.rules.cutScore)) {
        store.rules.cutScore = next;
        changes.push({ field: 'cutScore', from: before.cutScore, to: next, hitRate: cut.hitRate, samples: cut.decided });
      }
    }

    cfg.lastTuneDate = today;
    if (!changes.length) {
      saveMeta(store);
      return { tuned: false, reason: 'no-change', stats: { addSamples: add.decided, cutSamples: cut.decided } };
    }

    const tune = {
      at: Date.now(),
      date: today,
      trigger: manual ? 'manual' : 'auto',
      changes,
      before,
      after: { ...store.rules },
    };
    store.tunes = [...(store.tunes || []), tune].slice(-MAX_TUNES);
    saveMeta(store);
    return { tuned: true, tune };
  }

  /** 回滚上一次调参（把被改的字段改回去） */
  function rollbackLastTune() {
    const store = readStore();
    const last = (store.tunes || []).slice(-1)[0];
    if (!last) return { ok: false, reason: 'no-tune-history' };
    const restored = { ...store.rules };
    for (const change of last.changes || []) {
      if (restored[change.field] !== undefined) restored[change.field] = change.from;
    }
    store.rules = normalizeStrategyRules(restored);
    store.tunes = store.tunes.slice(0, -1).concat([{ ...last, rolledBackAt: Date.now(), trigger: 'rollback' }]);
    saveMeta(store);
    return { ok: true, rules: store.rules, rolledBack: last };
  }

  function setAutoTuneConfig(patch = {}) {
    const store = readStore();
    store.autoTune = clampAutoTune({ ...store.autoTune, ...(patch && typeof patch === 'object' ? patch : {}) });
    saveMeta(store);
    return { ok: true, autoTune: store.autoTune };
  }

  /* ---------------- 对外快照 ---------------- */

  function snapshot({ limit = 60, source = 'all', ...extra } = {}) {
    const store = readStore();
    const today = dateKeyOf();
    // v2.9.0：自动调参样本 = 实盘 + 回测（合计）；页面同时给实盘 / 回测两个分项
    const stats = buildStats(store, { source: 'all' });
    const statsLive = buildStats(store, { source: 'live' });
    const statsBackfill = buildStats(store, { source: 'backfill' });
    const suggestions = buildSuggestions(stats, store.rules);
    const sourceFilter = ['live', 'backfill', 'all'].includes(String(source)) ? String(source) : 'all';
    const maxRows = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 60)));
    const mapped = store.records
      .slice()
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .map((r) => ({
        date: r.date,
        slotTime: r.slotTime,
        source: r.source,
        backfill: Boolean(r.backfill),
        late: Boolean(r.late),
        // 旧记录没有 decisionBasis：只要有一个标的用了真实净值，就标「旧净值口径」；
        // 全部是估值/穿透估算的（如 11/18 17:04 补记）则应标 15:00 估值，不能冤枉成净值口径。
        decisionBasis: r.decisionBasis || ((r.eval && Array.isArray(r.eval.items) ? r.eval.items : (r.items || []))
          .some((it) => it && String(it.pctKind) === 'nav') ? 'nav' : 'estimate'),
        estimateKinds: r.estimateKinds || null,
        createdAt: r.createdAt,
        market: r.market || null,
        snapshot: r.snapshot,
        eval: normalizeEval(r.eval),
        items: r.items,
        pending: r.pending,
      }));
    const records = (sourceFilter === 'live'
      ? mapped.filter((r) => !r.backfill)
      : sourceFilter === 'backfill'
        ? mapped.filter((r) => r.backfill)
        : mapped).slice(0, maxRows);
    return {
      ok: true,
      today,
      isWeekday: isWeekdayKey(today),
      clockMinutes: shanghaiClockMinutes(),
      rules: store.rules,
      bands: store.bands,
      autoTune: store.autoTune,
      tunes: (store.tunes || []).slice().reverse().slice(0, 10),
      stats,
      statsLive,
      statsBackfill,
      backfill: store.backfill || null,
      suggestions,
      records,
      todayRecord: mapped.find((r) => r.date === today) || null,
      ...extra,
    };
  }

  function saveConfig({ rules, bands } = {}) {
    const store = readStore();
    if (rules && typeof rules === 'object') store.rules = normalizeStrategyRules(rules);
    if (bands && typeof bands === 'object') {
      store.bands = clampBands({ ...store.bands, ...bands });
    }
    saveMeta(store);
    return { ok: true, rules: store.rules, bands: store.bands };
  }

  /**
   * 定时任务（每分钟调一次，内部做时间与幂等判断）：
   * 1) 补评价（昨天的净值出了就评）→ 2) 自动调参（每天最多一次）→ 3) 14:35 后自动记录
   */
  async function tick() {
    const today = dateKeyOf();
    if (!isWeekdayKey(today)) return { ok: true, skipped: 'weekend' };
    const store = readStore();
    let port = null;
    try {
      port = await collectPortfolio();
    } catch {
      return { ok: true, skipped: 'portfolio-unavailable' };
    }

    const evaluatedRecords = evaluateRecords(store.records, port, today, store.bands);
    for (const record of evaluatedRecords) persistRecord(record);

    const tune = runAutoTune(store, buildStats(store, { source: 'all' }), {});

    let recorded = false;
    const todayRecord = store.records.find((r) => r.date === today);
    const clock = shanghaiClockMinutes();
    if (!todayRecord && clock >= AUTO_RECORD_AFTER) {
      // 自动记录同样只用 15:00 估值；若 14:35 时估值还没填上，稍后的 tick 会再试一次。
      const market = await safeMarketContext();
      const late = clock > 15 * 60 + 5;
      persistRecord(buildRecord(port, {
        slotTime: '14:30', source: 'auto', date: today, late, rules: store.rules, bands: store.bands, market,
      }));
      recorded = true;
    } else if (todayRecord
      && (todayRecord.items || []).length === 0
      && port.rows.some((r) => r.held && Number.isFinite(Number(r.decisionPct)))) {
      // 当天记录是空的（多半是 14:35 那一刻行情/估值暂时不可用），但现在已经有估值了：
      // 用 15:00 估值补记一次，避免页面一直显示「今天已记录但 0 条建议」。
      // 保留原记录的 source/slotTime，不篡改是自动还是手动。
      const market = await safeMarketContext();
      const late = clock > 15 * 60 + 5;
      persistRecord(buildRecord(port, {
        slotTime: todayRecord.slotTime || '14:30',
        source: todayRecord.source || 'auto',
        date: today,
        late,
        rules: store.rules,
        bands: store.bands,
        market,
      }));
      recorded = true;
    }

    return { ok: true, date: today, evaluated: evaluatedRecords.length, recorded, autoTune: tune };
  }

  return {
    getRules,
    snapshot,
    marketContext: () => safeMarketContext(),
    recordNow,
    evaluateNow,
    saveConfig,
    setAutoTuneConfig,
    runAutoTune: ({ force = false } = {}) => {
      const store = readStore();
      return runAutoTune(store, buildStats(store, { source: 'all' }), { force, manual: true });
    },
    rollbackLastTune,
    tick,
    judge,
    nextWeekdayKeys,
    buildStats,
    buildSuggestions,
    // v2.9.0 历史回测
    backfillNow,
    planBackfillDates,
    buildBackfillRecord,
    evaluateBackfillRecord,
  };
}

module.exports = { createStrategyLog, DEFAULT_BANDS, DEFAULT_AUTOTUNE };
