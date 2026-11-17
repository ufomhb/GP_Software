'use strict';
/**
 * 持仓策略按天记录与次日评价（2026-11-17）
 *
 * 目标：把每天 14:30 生成的「加仓 / 减仓 / 不变」建议落库，第二天用**已公布净值**
 * 回头判断这条建议是否合理，并用长期命中率指导规则参数调整（不断改进策略）。
 *
 * 口径（重要，避免事后自欺）：
 * 1) 记录：只记**当期有明确信号**的持仓（未持有、当日涨跌还没出的不进建议组），
 *    与推送口径完全一致 —— 分组逻辑直接复用 push 服务的 classifyPortfolio。
 * 2) 评价：只看「次日已公布的净值涨跌」（pctKind === 'nav'），盘中估算一律不算数。
 *    次日 = 决策日之后的第一个工作日；遇到节假日顺延，但最多 evalWindow 个工作日，
 *    超过窗口仍拿不到就记 skipped（不参与命中率），不会拿好几天后的累计涨跌冒充次日。
 * 3) 判定：加仓→次日涨过 addBand 算对、跌过 addBand 算错；减仓反之；
 *    不变→次日波动在 holdBand 内算对，波动大则记 flat（不动没亏钱，不好判错）。
 * 4) 命中率 = 对 / (对 + 错)，flat 与 skipped 不计入分母。
 *
 * 存储：data/strategy-log.json（JSON 文件，两种 STORE 模式下都可用；data/ 不进推送包）。
 */
const DEFAULT_BANDS = {
  addBand: 0.3,   // 加仓：次日涨 ≥ 0.3% 算对，跌 ≤ -0.3% 算错
  cutBand: 0.3,   // 减仓：次日跌 ≤ -0.3% 算对，涨 ≥ 0.3% 算错
  holdBand: 0.8,  // 不变：次日 |涨跌| ≤ 0.8% 算对
  evalWindow: 3,  // 决策日后最多几个工作日之内必须拿到次日净值
};
const MAX_RECORDS = 300;

function createStrategyLog(deps) {
  const {
    fs,
    path,
    dataDir,
    readJsonFile,
    writeJsonFile,
    collectPortfolio,
    classifyPortfolio,
    normalizeStrategyRules,
    defaultRules,
    todayKey,
  } = deps;
  const FILE = path.join(dataDir, 'strategy-log.json');

  /* ---------------- 日期工具 ---------------- */

  function dateKeyOf(date) {
    if (typeof todayKey === 'function') return String(todayKey());
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    return p.replace(/\//g, '-');
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

  function blankStore() {
    return {
      rules: normalizeStrategyRules(defaultRules),
      bands: { ...DEFAULT_BANDS },
      records: [],
      updatedAt: 0,
    };
  }

  function readStore() {
    const raw = readJsonFile(FILE, null);
    const store = blankStore();
    if (raw && typeof raw === 'object') {
      store.rules = normalizeStrategyRules(raw.rules);
      store.bands = { ...DEFAULT_BANDS, ...(raw.bands && typeof raw.bands === 'object' ? raw.bands : {}) };
      // 参数也要夹到合理区间，避免历史脏数据把判定搞乱
      for (const key of Object.keys(DEFAULT_BANDS)) {
        const v = Number(store.bands[key]);
        if (!Number.isFinite(v) || v <= 0) store.bands[key] = DEFAULT_BANDS[key];
      }
      store.bands.evalWindow = Math.min(10, Math.max(1, Math.trunc(store.bands.evalWindow)));
      store.records = Array.isArray(raw.records) ? raw.records.filter((r) => r && r.date) : [];
      store.updatedAt = Number(raw.updatedAt) || 0;
    }
    return store;
  }

  function writeStore(store) {
    store.updatedAt = Date.now();
    if (store.records.length > MAX_RECORDS) {
      store.records = store.records.slice(store.records.length - MAX_RECORDS);
    }
    writeJsonFile(FILE, store);
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
      return { verdict: 'flat', note: `次日 ${p.toFixed(2)}%，在 ±${b.addBand}% 内，方向不明显` };
    }
    if (action === 'cut') {
      if (p <= -b.cutBand) return { verdict: 'right', note: `次日 ${p.toFixed(2)}%，减仓躲开下跌` };
      if (p >= b.cutBand) return { verdict: 'wrong', note: `次日 +${p.toFixed(2)}%，减仓减在上涨` };
      return { verdict: 'flat', note: `次日 ${p.toFixed(2)}%，在 ±${b.cutBand}% 内，方向不明显` };
    }
    // 不变：波动小说明当时确实没必要动
    if (Math.abs(p) <= b.holdBand) return { verdict: 'right', note: `次日 ${p.toFixed(2)}%，波动在 ±${b.holdBand}% 内，不动合理` };
    return { verdict: 'flat', note: `次日 ${p.toFixed(2)}%，有方向但不动没有亏损` };
  }

  /* ---------------- 记录 ---------------- */

  function buildRecord(port, { slotTime = '14:30', source = 'manual', date, late = false } = {}) {
    const cls = classifyPortfolio(port);
    const items = [...cls.add, ...cls.cut, ...cls.hold];
    return {
      date: date || dateKeyOf(),
      slotTime,
      source,
      // late=true 表示这条是收盘后才补记的（用的是当日已公布净值，不是 14:30 的盘中口径）
      late: Boolean(late),
      createdAt: Date.now(),
      rules: { ...normalizeStrategyRules(defaultRules) },
      snapshot: {
        today: port.today,
        marketValue: port.totals ? port.totals.marketValue : null,
        portfolioPct: port.totals ? port.totals.portfolioPct : null,
        dayProfit: port.totals ? port.totals.dayProfit : null,
        profit: port.totals ? port.totals.profit : null,
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
        navDate: it.navDate,
        weight: it.weight === null ? null : Number(Number(it.weight).toFixed(2)),
        score: it.score,
        reason: it.reason,
      })),
      pending: cls.pending.map((r) => ({ code: r.code, name: r.name, navDate: r.navDate || '', navPct: r.navPct })),
      eval: null,
    };
  }

  /** 记录当天建议；已有当天记录且不覆盖时返回 skipped */
  async function recordNow({ force = false, slotTime = '14:30', source = 'manual' } = {}) {
    const today = dateKeyOf();
    const store = readStore();
    const existing = store.records.find((r) => r.date === today);
    if (existing && !force) {
      return { ok: true, recorded: false, reason: 'already-recorded', date: today };
    }
    const port = await collectPortfolio();
    const record = buildRecord(port, { slotTime, source, date: today });
    if (existing) {
      store.records = store.records.map((r) => (r.date === today ? record : r));
    } else {
      store.records.push(record);
    }
    store.records.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    writeStore(store);
    return { ok: true, recorded: true, date: today, counts: record.snapshot.counts, items: record.items.length };
  }

  /* ---------------- 次日评价 ---------------- */

  function summarizeEval(items) {
    const counts = { right: 0, wrong: 0, flat: 0, skipped: 0 };
    for (const it of items) counts[it.verdict] = (counts[it.verdict] || 0) + 1;
    const decided = counts.right + counts.wrong;
    return { ...counts, decided, hitRate: decided > 0 ? counts.right / decided : null };
  }

  /**
   * 给未评价的历史记录补评价。返回本次新评价了几条。
   * 只认「已公布净值」；窗口内还没出的留到下次再评，超窗的记 skipped。
   */
  function evaluateRecords(store, port, today = dateKeyOf()) {
    const rowsByCode = new Map((port && port.rows ? port.rows : []).map((r) => [String(r.code), r]));
    const bands = store.bands;
    let evaluated = 0;
    for (const record of store.records) {
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
          // 次日净值还没公布（或还在窗口内等它公布），下次 tick 再来评
          waiting = true;
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
      const summary = summarizeEval(items);
      record.eval = {
        evaluatedAt: Date.now(),
        windowEnd,
        basis: '次日已公布净值',
        items,
        summary,
      };
      evaluated += 1;
    }
    return evaluated;
  }

  async function evaluateNow() {
    const store = readStore();
    const port = await collectPortfolio();
    const n = evaluateRecords(store, port, dateKeyOf());
    if (n > 0) writeStore(store);
    return { ok: true, evaluated: n };
  }

  /* ---------------- 统计与改进建议 ---------------- */

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
    const items = [];
    for (const r of evaluated) for (const it of r.eval.items || []) items.push(it);

    const byAction = {};
    for (const action of ['add', 'cut', 'hold']) {
      const sub = items.filter((it) => it.action === action);
      byAction[action] = { n: sub.length, ...summarizeEval(sub) };
    }

    const byScore = {};
    for (const it of items.filter((x) => x.action === 'add' || x.action === 'cut')) {
      const key = bucketOfScore(it.score);
      if (!byScore[key]) byScore[key] = { n: 0, right: 0, wrong: 0, flat: 0, skipped: 0, decided: 0, hitRate: null };
      byScore[key].n += 1;
      byScore[key][it.verdict] = (byScore[key][it.verdict] || 0) + 1;
    }
    for (const key of Object.keys(byScore)) {
      const b = byScore[key];
      b.decided = b.right + b.wrong;
      b.hitRate = b.decided > 0 ? b.right / b.decided : null;
    }

    const overall = summarizeEval(items);
    const recent = evaluated
      .slice(-10)
      .reverse()
      .map((r) => ({
        date: r.date,
        counts: r.eval.summary,
        hitRate: r.eval.summary.hitRate,
      }));

    return {
      days: evaluated.length,
      items: items.length,
      overall,
      byAction,
      byScore,
      recent,
      lastEvaluated: evaluated.length ? evaluated[evaluated.length - 1].date : null,
    };
  }

  /** 根据命中率给「下一步怎么调参」的具体建议（不自动改参数，改不改由人决定） */
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
        text: `加仓命中率只有 ${rate(add)}：次日在加仓后多数没涨。建议把加仓评分门槛从 ${rules.addScore} 提到 ${next}，或把加仓幅度从 10% 降到 5%，减少「抄底抄在半山腰」。`,
      });
    } else if (add.decided >= 5 && add.hitRate !== null && add.hitRate >= 0.6) {
      out.push({
        key: 'addScore',
        level: 'ok',
        text: `加仓命中率 ${rate(add)}，当前评分门槛 ${rules.addScore} 有效，可以先保持不变继续积累样本。`,
      });
    }

    if (cut.decided >= 5 && cut.hitRate !== null && cut.hitRate < 0.5) {
      const next = Math.max(20, Number(rules.cutScore) - 5);
      out.push({
        key: 'cutScore',
        level: 'warn',
        text: `减仓命中率只有 ${rate(cut)}：减仓后次日反而上涨。建议把减仓评分门槛从 ${rules.cutScore} 降到 ${next}（只在更弱的票上减），或把减仓触发涨幅从 ${rules.cutRise}% 调高到 ${(Number(rules.cutRise) + 0.4).toFixed(1)}%。`,
      });
    } else if (cut.decided >= 5 && cut.hitRate !== null && cut.hitRate >= 0.6) {
      out.push({
        key: 'cutScore',
        level: 'ok',
        text: `减仓命中率 ${rate(cut)}，当前减仓门槛 ${rules.cutScore} 有效。`,
      });
    }

    const hold = stats.byAction.hold;
    if (hold.n >= 10 && hold.flat > hold.right) {
      out.push({
        key: 'holdBand',
        level: 'info',
        text: `「不变」里有 ${hold.flat} 条次日出现了明显方向：说明当时的信号偏保守。可以考虑放宽加仓/减仓的触发阈值（例如跌幅门槛从 ${rules.addDip}% 降到 ${Math.max(0.6, Number(rules.addDip) - 0.4).toFixed(1)}%），让更多标的参与判断。`,
      });
    }

    if (stats.days < 5) {
      out.push({
        key: 'sample',
        level: 'info',
        text: `目前只有 ${stats.days} 个交易日的样本，命中率还不足以下结论。建议先积累到 10 个交易日以上（每天 14:35 会自动记录），再依据统计调参。`,
      });
    }
    return out;
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
        createdAt: r.createdAt,
        snapshot: r.snapshot,
        eval: r.eval,
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
      const next = { ...store.bands };
      for (const key of ['addBand', 'cutBand', 'holdBand']) {
        const v = Number(bands[key]);
        if (Number.isFinite(v) && v > 0 && v <= 20) next[key] = v;
      }
      const w = Number(bands.evalWindow);
      if (Number.isFinite(w) && w >= 1 && w <= 10) next.evalWindow = Math.trunc(w);
      store.bands = next;
    }
    writeStore(store);
    return { ok: true, rules: store.rules, bands: store.bands };
  }

  /**
   * 定时任务（每分钟调一次，内部做时间与幂等判断）：
   * - 先补评价（只要昨天的净值出了就评）
   * - 再在今天 14:35 之后、且今天还没有记录时自动记录
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
    let evaluated = evaluateRecords(store, port, today);
    let recorded = false;
    const exists = store.records.some((r) => r.date === today);
    if (!exists && shanghaiClockMinutes() >= AUTO_RECORD_AFTER) {
      // 15:05 之后补记的，标注 late：用的是收盘后的净值口径，不是 14:30 的盘中决策
      const late = shanghaiClockMinutes() > 15 * 60 + 5;
      store.records.push(buildRecord(port, { slotTime: '14:30', source: 'auto', date: today, late }));
      recorded = true;
    }
    if (evaluated > 0 || recorded) {
      store.records.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      writeStore(store);
    }
    return { ok: true, date: today, evaluated, recorded };
  }

  return {
    getRules,
    snapshot,
    recordNow,
    evaluateNow,
    saveConfig,
    tick,
    judge,
    nextWeekdayKeys,
    buildStats,
    buildSuggestions,
    file: FILE,
  };
}

module.exports = { createStrategyLog, DEFAULT_BANDS };
