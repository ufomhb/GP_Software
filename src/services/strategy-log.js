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
  holdBand: 0.8,  // 不变：次日 |涨跌| ≤ 0.8% 算对
  evalWindow: 3,  // 决策日后最多几个工作日之内必须拿到次日净值
};

const DEFAULT_AUTOTUNE = {
  enabled: true,      // 全自动调参开关
  minSamples: 5,      // 至少这么多条可判定样本才敢动参数
  minHitRate: 0.5,    // 命中率低于它才调
  step: 5,            // 每次调整的幅度（评分门槛加减 5）
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
    });
  }

  function persistRecord(record) {
    strategyStore.saveRecord(record);
  }

  function getRules() {
    return readStore().rules;
  }

  /* ---------------- 判定 ---------------- */

  function judge(action, pct, bands = DEFAULT_BANDS) {
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
    if (Math.abs(p) <= b.holdBand) return { verdict: 'right', note: `次日 ${p.toFixed(2)}%，波动在 ±${b.holdBand}% 内，不动合理` };
    return { verdict: 'flat', note: `次日 ${p.toFixed(2)}%，超出 ±${b.holdBand}%：不动是保守选择，记中性（不计对错）` };
  }

  /* ---------------- 记录 ---------------- */

  function buildRecord(port, {
    slotTime = '14:30', source = 'manual', date, late = false, rules = defaultRules, market = null,
  } = {}) {
    const effectiveRules = normalizeStrategyRules(rules);
    const cls = classifyPortfolio(port, effectiveRules, market);
    const items = [...cls.add, ...cls.cut, ...cls.hold];
    const marketSnapshot = market && market.available !== false
      ? {
        available: true,
        verdict: market.verdict,
        score: market.score,
        cnScore: market.cnScore,
        extScore: market.extScore,
        summary: market.summary,
        ext: market.ext,
        lines: market.lines || [],
      }
      : null;
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
          add: cls.add.length, cut: cls.cut.length, hold: cls.hold.length, pending: cls.pending.length,
        },
      },
      items: items.map((it) => ({
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
        reason: it.reason,
      })),
      pending: cls.pending.map((r) => ({
        code: r.code, name: r.name, navDate: r.navDate || '', navPct: r.navPct,
        note: r.decisionPct === null ? '没有 15:00 估值，不参与本次决策' : '',
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
          const verdict = judge(item.action, row.pct, bands);
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
      tune = runAutoTune(after, buildStats(after), {});
    }
    return { ok: true, evaluated: changed.length, autoTune: tune };
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

  function buildStats(store) {
    const evaluated = store.records.filter((r) => r.eval);
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

  function snapshot(extra = {}) {
    const store = readStore();
    const today = dateKeyOf();
    const stats = buildStats(store);
    const suggestions = buildSuggestions(stats, store.rules);
    const records = store.records
      .slice()
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 60)
      .map((r) => ({
        date: r.date,
        slotTime: r.slotTime,
        source: r.source,
        late: Boolean(r.late),
        // 旧记录没有 decisionBasis：只要有一个标的用了真实净值，就标「旧净值口径」；
        // 全部是估值/穿透估算的（如 11/18 17:04 补记）则应标 15:00 估值，不能冤枉成净值口径。
        decisionBasis: r.decisionBasis || ((r.eval && Array.isArray(r.eval.items) ? r.eval.items : (r.items || []))
          .some((it) => it && String(it.pctKind) === 'nav') ? 'nav' : 'estimate'),
        createdAt: r.createdAt,
        market: r.market || null,
        snapshot: r.snapshot,
        eval: normalizeEval(r.eval),
        items: r.items,
        pending: r.pending,
      }));
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
      suggestions,
      records,
      todayRecord: records.find((r) => r.date === today) || null,
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

    const tune = runAutoTune(store, buildStats(store), {});

    let recorded = false;
    const exists = store.records.some((r) => r.date === today);
    if (!exists && shanghaiClockMinutes() >= AUTO_RECORD_AFTER) {
      // 自动记录同样只用 15:00 估值；若 14:35 时估值还没填上，稍后的 tick 会再试一次。
      const market = await safeMarketContext();
      const late = shanghaiClockMinutes() > 15 * 60 + 5;
      persistRecord(buildRecord(port, {
        slotTime: '14:30', source: 'auto', date: today, late, rules: store.rules, market,
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
      return runAutoTune(store, buildStats(store), { force, manual: true });
    },
    rollbackLastTune,
    tick,
    judge,
    nextWeekdayKeys,
    buildStats,
    buildSuggestions,
  };
}

module.exports = { createStrategyLog, DEFAULT_BANDS, DEFAULT_AUTOTUNE };
