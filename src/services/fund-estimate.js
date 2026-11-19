'use strict';
/**
 * 场外基金「当日估值」的重仓穿透公式（v2.9.0 抽出，实盘与历史回测共用）
 *
 * 为什么抽出来：持仓策略的历史回测要按**现有规则**逐日重建 15:00 估值，
 * 不能拿收盘后公布的净值冒充。把这段加权公式做成纯函数后，
 * 实盘（实时行情）与回测（历史日线）喂同一份逻辑，避免两套口径漂移。
 *
 * 输入：
 *   - route：'holdings'（重仓穿透）/ 'etf'（目标 ETF 穿透，含 ETF 联接）/ 'qdii' / 'none'
 *   - profile：{ stocks: [{ code, weight }], etfCode, etfName }
 *   - stockRatio：最新季报股票仓位（%），>20 才用于缩放
 *   - pctByCode：Map<code, 当日涨跌%>（code 为 6 位股票代码 / 目标 ETF 代码）
 * 输出：{ pct, kind, covered, weight, stockRatio, note }
 *   pct === null 表示这只基金当天算不出估值（调用方应把它放进「未更新」组）。
 *
 * 口径与 server.js 里 estimateFundDayPctBatch 完全一致：
 *   - 重仓股覆盖 ≥ 4 只且合计权重 ≥ 15%，否则不算；
 *   - 股票仓位 > 20% 时按 stockRatio / 权重合计 缩放，否则直接加总；
 *   - ETF 联接直接取目标 ETF 的场内涨跌；QDII / 无持仓不算。
 */
const MIN_COVERED = 4;
const MIN_TOTAL_WEIGHT = 15;
const SCALE_MIN_RATIO = 20;

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function estimateFromProfile({ route = 'none', profile = null, stockRatio = null, pctByCode = null } = {}) {
  const base = {
    pct: null,
    kind: null,
    covered: 0,
    weight: 0,
    stockRatio: Number.isFinite(Number(stockRatio)) && Number(stockRatio) > 0 ? Number(stockRatio) : null,
    note: '',
  };
  if (route === 'qdii') return { ...base, note: 'QDII 净值滞后一交易日，不做盘中估算' };
  if (route === 'none') return { ...base, note: '未披露持仓，无法穿透估算' };
  if (!profile) return { ...base, note: '重仓数据不可用' };
  const pcts = pctByCode instanceof Map ? pctByCode : new Map();

  // ETF 联接 / 发起式联接：净值主要压在目标 ETF 上，直接取目标 ETF 的场内涨跌
  if (route === 'etf') {
    const etfCode = String(profile.etfCode || '');
    const v = pcts.get(etfCode);
    if (!Number.isFinite(Number(v))) {
      return { ...base, note: `目标 ETF ${etfCode || '--'} 行情不可用` };
    }
    const stocks = Array.isArray(profile.stocks) ? profile.stocks : [];
    const extra = stocks.length
      ? `（该基金直持个股合计 ${round2(stocks.reduce((s, x) => s + (Number(x.weight) || 0), 0))}%，低于重仓法门槛，改按目标 ETF 穿透）`
      : '';
    return {
      ...base,
      pct: Number(v),
      kind: 'etf',
      covered: 1,
      weight: 100,
      note: `按目标 ETF ${profile.etfName || etfCode}（${etfCode}）场内涨跌穿透${extra}`,
    };
  }

  // 普通场外基金：重仓股权重 × 个股当日涨跌，再按股票仓位缩放
  const stocks = Array.isArray(profile.stocks) ? profile.stocks : [];
  let weight = 0;
  let contrib = 0;
  let covered = 0;
  for (const s of stocks) {
    const v = pcts.get(String(s.code));
    if (!Number.isFinite(Number(v))) continue;
    weight += Number(s.weight) || 0;
    contrib += ((Number(s.weight) || 0) * Number(v)) / 100;
    covered += 1;
  }
  if (covered < MIN_COVERED || weight < MIN_TOTAL_WEIGHT) {
    return {
      ...base,
      covered,
      weight: round2(weight) || 0,
      note: `重仓覆盖率不足（${covered} 只 / 合计 ${round2(weight) || 0}%），无法穿透估算`,
    };
  }
  const scaleRatio = Number(stockRatio);
  const scale = Number.isFinite(scaleRatio) && scaleRatio > SCALE_MIN_RATIO ? scaleRatio / weight : 1;
  return {
    ...base,
    pct: round2(contrib * scale),
    kind: 'holdings',
    covered,
    weight: round2(weight),
    note: `前 ${covered} 大重仓（合计 ${round2(weight)}%）${scale !== 1 ? `按股票仓位 ${round2(stockRatio)}% 缩放` : '未取到股票仓位，直接按权重加总'}`,
  };
}

module.exports = { estimateFromProfile, round2, MIN_COVERED, MIN_TOTAL_WEIGHT, SCALE_MIN_RATIO };
