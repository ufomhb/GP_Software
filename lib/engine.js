'use strict';

const { computeSeries } = require('./indicators');

const DISCLAIMER =
  '本工具仅基于公开行情与规则模型生成研究性参考，不构成任何投资建议或收益承诺。市场有风险，决策需独立判断。';

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function avg(arr) {
  const nums = arr.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function nf(v, digits = 2) {
  if (!Number.isFinite(v)) return '--';
  return v.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function pctText(v, digits = 2) {
  if (!Number.isFinite(v)) return '--';
  return `${v >= 0 ? '+' : ''}${nf(v, digits)}%`;
}

function yiText(v, digits = 1) {
  if (!Number.isFinite(v)) return '--';
  return nf(v / 1e8, digits);
}

function wanYiText(v) {
  if (!Number.isFinite(v)) return '--';
  return nf(v / 1e12, 2);
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shanghaiToday() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return fmtDate(new Date());
  }
}

function nextTradingDate(dataDate) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(dataDate || ''))
    ? new Date(`${dataDate}T12:00:00+08:00`)
    : new Date();
  if (Number.isNaN(base.getTime())) return fmtDate(new Date());
  const d = new Date(base);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return fmtDate(d);
}

function analyze(candles) {
  if (!Array.isArray(candles) || candles.length < 20) {
    throw new Error('K 线数据不足，无法计算技术指标');
  }
  const n = candles.length;
  const series = computeSeries(candles);
  const last = candles[n - 1];
  const prev = candles[n - 2];
  const closes = candles.map((c) => c.c);
  const at = (arr) => (arr && Number.isFinite(arr[n - 1]) ? arr[n - 1] : null);
  const ma5 = at(series.ma5);
  const ma10 = at(series.ma10);
  const ma20 = at(series.ma20);
  const ma60 = at(series.ma60);
  const ma20Prev = n >= 26 && Number.isFinite(series.ma20[n - 6]) ? series.ma20[n - 6] : null;
  const rsi14 = Number.isFinite(series.rsi14[n - 1]) ? series.rsi14[n - 1] : null;
  const dif = Number.isFinite(series.dif[n - 1]) ? series.dif[n - 1] : null;
  const dea = Number.isFinite(series.dea[n - 1]) ? series.dea[n - 1] : null;
  const macdHist = Number.isFinite(series.macd[n - 1]) ? series.macd[n - 1] : null;
  const macdHistPrev = n >= 2 && Number.isFinite(series.macd[n - 2]) ? series.macd[n - 2] : null;
  const atr14 = at(series.atr14);

  const window20 = candles.slice(-20);
  const window60 = candles.slice(-60);
  const high20 = Math.max(...window20.map((c) => c.h));
  const low20 = Math.min(...window20.map((c) => c.l));
  const high60 = Math.max(...window60.map((c) => c.h));
  const low60 = Math.min(...window60.map((c) => c.l));

  const pivot = (last.h + last.l + last.c) / 3;
  const r1 = 2 * pivot - last.l;
  const s1 = 2 * pivot - last.h;
  const r2 = pivot + (last.h - last.l);
  const s2 = pivot - (last.h - last.l);

  const volPrev = candles.slice(-6, -1);
  const volAvg5 = avg(volPrev.map((c) => c.v));
  const volRatio = volAvg5 && volAvg5 > 0 ? last.v / volAvg5 : 1;
  const change5 = n > 5 ? ((last.c / closes[n - 6]) - 1) * 100 : null;
  const change20 = n > 20 ? ((last.c / closes[n - 21]) - 1) * 100 : null;
  const pct = Number.isFinite(last.pct)
    ? last.pct
    : prev && prev.c
      ? ((last.c / prev.c) - 1) * 100
      : 0;
  const amplitude = Number.isFinite(last.amplitude)
    ? last.amplitude
    : prev && prev.c
      ? ((last.h - last.l) / prev.c) * 100
      : null;

  let trend = 'range';
  if (ma20 !== null && ma20Prev !== null) {
    if (last.c > ma20 && ma20 > ma20Prev) trend = 'up';
    else if (last.c < ma20 && ma20 < ma20Prev) trend = 'down';
  } else if (ma20 !== null) {
    trend = last.c > ma20 ? 'up' : 'down';
  }

  const supports = [ma5, ma10, ma20, low20, s1, s2].filter((v) => Number.isFinite(v) && v < last.c);
  const resistances = [ma5, ma10, ma20, high20, r1, r2].filter((v) => Number.isFinite(v) && v > last.c);
  const support = supports.length ? Math.max(...supports) : low20;
  const resistance = resistances.length ? Math.min(...resistances) : high20;

  return {
    close: last.c,
    prevClose: prev ? prev.c : null,
    pct,
    amplitude,
    ma5,
    ma10,
    ma20,
    ma60,
    ma20Prev,
    rsi14,
    dif,
    dea,
    macdHist,
    macdHistPrev,
    atr14,
    atrPct: atr14 && last.c ? (atr14 / last.c) * 100 : null,
    high20,
    low20,
    high60,
    low60,
    pivot,
    r1,
    s1,
    r2,
    s2,
    support,
    resistance,
    volRatio,
    change5,
    change20,
    trend,
    lastDate: last.d,
  };
}

function technicalScore(a) {
  let score = 50;
  const reasons = [];
  const risks = [];

  if (Number.isFinite(a.ma20)) {
    if (a.close > a.ma20) {
      score += 9;
      reasons.push(`收盘价站上 MA20（${nf(a.ma20)}），中期结构未破`);
    } else {
      score -= 9;
      risks.push(`收盘价位于 MA20（${nf(a.ma20)}）下方，中期承压`);
    }
  }

  if (Number.isFinite(a.ma5) && Number.isFinite(a.ma10) && Number.isFinite(a.ma20)) {
    if (a.ma5 > a.ma10 && a.ma10 > a.ma20) {
      score += 8;
      reasons.push('MA5 > MA10 > MA20，均线呈多头排列');
    } else if (a.ma5 < a.ma10 && a.ma10 < a.ma20) {
      score -= 8;
      risks.push('MA5 < MA10 < MA20，均线呈空头排列');
    }
  }

  if (Number.isFinite(a.ma20Prev) && Number.isFinite(a.ma20)) {
    if (a.ma20 > a.ma20Prev) {
      score += 4;
      reasons.push('MA20 向上，趋势斜率仍为正');
    } else {
      score -= 4;
      risks.push('MA20 走平或下弯，趋势动能减弱');
    }
  }

  if (Number.isFinite(a.rsi14)) {
    if (a.rsi14 >= 78) {
      score -= 7;
      risks.push(`RSI ${nf(a.rsi14, 1)}，进入超买区，追高性价比低`);
    } else if (a.rsi14 >= 62) {
      score += 3;
      reasons.push(`RSI ${nf(a.rsi14, 1)}，动量偏强但未极端`);
    } else if (a.rsi14 >= 45) {
      score += 4;
      reasons.push(`RSI ${nf(a.rsi14, 1)}，处于健康中性区`);
    } else if (a.rsi14 >= 30) {
      score -= 3;
      risks.push(`RSI ${nf(a.rsi14, 1)}，动量偏弱`);
    } else {
      score += 2;
      reasons.push(`RSI ${nf(a.rsi14, 1)}，短线超卖，存在技术反抽可能`);
      risks.push('超卖不等于见底，需等待量价企稳');
    }
  }

  if (Number.isFinite(a.macdHist)) {
    if (a.macdHist > 0 && Number.isFinite(a.macdHistPrev) && a.macdHistPrev <= 0) {
      score += 6;
      reasons.push('MACD 柱由负转正，形成金叉信号');
    } else if (a.macdHist > 0) {
      score += 4;
      reasons.push('MACD 红柱延续，多头动能占优');
    } else if (Number.isFinite(a.macdHistPrev) && a.macdHistPrev >= 0) {
      score -= 6;
      risks.push('MACD 柱由正转负，形成死叉信号');
    } else {
      score -= 4;
      risks.push('MACD 绿柱延续，空头动能占优');
    }
  }

  if (Number.isFinite(a.volRatio) && a.volRatio > 1.25) {
    if (a.pct > 0) {
      score += 5;
      reasons.push(`量比 ${nf(a.volRatio, 2)}，放量上涨，资金参与度提升`);
    } else if (a.pct < 0) {
      score -= 5;
      risks.push(`量比 ${nf(a.volRatio, 2)}，放量下跌，抛压较重`);
    }
  } else if (Number.isFinite(a.volRatio) && a.volRatio < 0.7) {
    score -= 1;
    risks.push(`量比 ${nf(a.volRatio, 2)}，成交缩量，方向确认度不足`);
  }

  if (Number.isFinite(a.high20) && a.close >= a.high20 * 0.995) {
    score += 4;
    reasons.push('价格逼近或突破 20 日高点，趋势具备延续条件');
  } else if (Number.isFinite(a.low20) && a.close <= a.low20 * 1.005) {
    score -= 4;
    risks.push('价格逼近 20 日低点，注意破位风险');
  }

  if (Number.isFinite(a.change5)) {
    if (a.change5 > 5) {
      score += 2;
      reasons.push(`近 5 日累计 ${pctText(a.change5)}，短线强度较高`);
    } else if (a.change5 < -5) {
      score -= 2;
      risks.push(`近 5 日累计 ${pctText(a.change5)}，短线处于弱势`);
    }
  }

  return {
    score: clamp(Math.round(score), 0, 100),
    reasons: reasons.slice(0, 5),
    risks: risks.slice(0, 4),
  };
}

function ratingFor(score, type = 'stock') {
  const market = type === 'market';
  if (score >= (market ? 70 : 72)) {
    return {
      key: 'strong',
      label: market ? '强势偏多' : '强势偏多',
      tone: 'up',
      action: market ? '顺势持有，回踩不破可分批' : '顺势持有，回踩支撑不破可分批',
    };
  }
  if (score >= (market ? 58 : 60)) {
    return {
      key: 'bull',
      label: '偏多',
      tone: 'up',
      action: '逢回踩分批，避免无量追高',
    };
  }
  if (score >= (market ? 46 : 48)) {
    return {
      key: 'neutral',
      label: '中性',
      tone: 'flat',
      action: '区间观察，等待量价方向确认',
    };
  }
  if (score >= (market ? 34 : 36)) {
    return {
      key: 'bear',
      label: '偏空',
      tone: 'down',
      action: '控制仓位，反弹以减仓为主',
    };
  }
  return {
    key: 'defensive',
    label: '防御',
    tone: 'down',
    action: '以观望为主，等待企稳信号',
  };
}

function positionFor(score, risk = 'balanced') {
  let lo;
  let hi;
  if (score >= 72) { lo = 60; hi = 80; }
  else if (score >= 60) { lo = 40; hi = 60; }
  else if (score >= 48) { lo = 25; hi = 45; }
  else if (score >= 36) { lo = 10; hi = 25; }
  else { lo = 0; hi = 10; }
  if (risk === 'conservative') { lo -= 10; hi -= 10; }
  if (risk === 'aggressive') { lo += 10; hi += 10; }
  lo = clamp(lo, 0, 85);
  hi = clamp(hi, 5, 85);
  if (hi < lo) hi = lo;
  const toCheng = (v) => (v % 10 === 0 ? String(v / 10) : (v / 10).toFixed(1));
  return { lo, hi, text: `${toCheng(lo)}-${toCheng(hi)} 成` };
}

function stockAdvice(quote, candles, options = {}) {
  const a = analyze(candles);
  const tech = technicalScore(a);
  let score = tech.score;
  const reasons = [...tech.reasons];
  const risks = [...tech.risks];

  if (Number.isFinite(quote.mainPct)) {
    score += clamp(quote.mainPct * 0.5, -7, 7);
    if (quote.mainPct > 5) reasons.unshift(`主力净流入占比 ${nf(quote.mainPct, 2)}%，资金面偏积极`);
    else if (quote.mainPct < -5) risks.unshift(`主力净流出占比 ${nf(Math.abs(quote.mainPct), 2)}%，资金面偏谨慎`);
  }
  if (Number.isFinite(quote.pct) && quote.pct > 9.8) {
    score -= 2;
    risks.unshift('当日涨幅接近涨停，短线追高面临回撤风险');
  }
  score = clamp(Math.round(score), 0, 100);
  const rating = ratingFor(score);
  const position = positionFor(score, options.risk || 'balanced');

  let action = rating.action;
  if (score >= 60 && a.close <= a.support * 1.02) action = '回踩支撑附近分批，跌破支撑止损';
  if (score >= 60 && a.close >= a.resistance * 0.995) action = '放量突破可跟随，假突破则减仓';
  if (score < 48) action = '反弹控制仓位，等待止跌信号';

  const summary =
    `${quote.name || '标的'} 最新 ${nf(quote.price)}，${pctText(quote.pct)}。` +
    `技术评分 ${score} 分，${rating.label}；参考仓位 ${position.text}。` +
    `上方关注 ${nf(a.resistance)}，下方支撑 ${nf(a.support)}。`;

  return {
    score,
    rating,
    position,
    action,
    summary,
    reasons: reasons.slice(0, 5),
    risks: risks.slice(0, 5),
    levels: {
      close: a.close,
      support: a.support,
      resistance: a.resistance,
      s1: a.s1,
      s2: a.s2,
      r1: a.r1,
      r2: a.r2,
      ma20: a.ma20,
      high20: a.high20,
      low20: a.low20,
    },
    analysis: {
      trend: a.trend,
      rsi14: a.rsi14,
      macdHist: a.macdHist,
      volRatio: a.volRatio,
      atrPct: a.atrPct,
      lastDate: a.lastDate,
    },
    disclaimer: DISCLAIMER,
  };
}

const POSITIVE_WORDS = [
  '利好', '增长', '突破', '创新高', '回购', '增持', '中标', '签约', '超预期', '降准', '降息',
  '刺激', '回暖', '盈利', '上调', '获批', '合作', '订单', '涨停', '扩产', '分红', '提速',
];
const NEGATIVE_WORDS = [
  '利空', '下滑', '亏损', '减持', '处罚', '调查', '退市', '违约', '暴跌', '风险', '下调',
  '裁员', '停牌', '诉讼', '召回', '事故', '冲突', '制裁', '关税', '跌停', '警示', '承压',
];

function scoreText(text) {
  let s = 0;
  for (const w of POSITIVE_WORDS) if (text.includes(w)) s += 1;
  for (const w of NEGATIVE_WORDS) if (text.includes(w)) s -= 1;
  return clamp(s, -3, 3);
}

function aggregateNews(items = []) {
  let total = 0;
  let pos = 0;
  let neg = 0;
  const scored = items.map((item) => {
    const s = scoreText(`${item.title || ''} ${item.summary || ''}`);
    total += s;
    if (s > 0) pos += 1;
    if (s < 0) neg += 1;
    return { ...item, sentiment: s };
  });
  const raw = items.length ? total / (items.length * 2) : 0;
  const score = clamp(raw, -1, 1);
  const label = score > 0.18 ? '偏暖' : score < -0.18 ? '偏冷' : '中性';
  return {
    score,
    label,
    positive: pos,
    negative: neg,
    total: items.length,
    items: scored,
    topPositive: scored.filter((i) => i.sentiment > 0).slice(0, 4),
    topNegative: scored.filter((i) => i.sentiment < 0).slice(0, 4),
  };
}

function tempFor(score) {
  if (score >= 75) return { label: '强势', tone: 'up' };
  if (score >= 60) return { label: '偏暖', tone: 'up' };
  if (score >= 45) return { label: '中性', tone: 'flat' };
  if (score >= 30) return { label: '偏冷', tone: 'down' };
  return { label: '冰点', tone: 'down' };
}

function dimension(key, label, score, detail) {
  const s = clamp(Math.round(score), 0, 100);
  return {
    key,
    label,
    score: s,
    tone: s >= 60 ? 'up' : s >= 45 ? 'flat' : 'down',
    detail,
  };
}

function marketAdvice({ overview, klines, sectors, news }) {
  const cn = overview.cn || [];
  const global = overview.global || [];
  const commodities = overview.commodities || [];
  const flow = overview.marketFlow || { points: [], last: 0 };
  const breadth = overview.breadth || { up: 0, down: 0, flat: 0, total: 0 };
  const byCode = (arr, code) => arr.find((q) => q.code === code) || {};
  const sseQ = byCode(cn, '000001');
  const szseQ = byCode(cn, '399001');
  const cybQ = byCode(cn, '399006');
  const bseQ = byCode(cn, '899050');
  const hs300Q = byCode(cn, '000300');

  const seriesOf = (key) => {
    const k = klines && klines[key];
    if (!k || !Array.isArray(k.candles) || k.candles.length < 20) return null;
    return analyze(k.candles);
  };
  const aSse = seriesOf('sse');
  const aSzse = seriesOf('szse');
  const aCyb = seriesOf('cyb');
  const aHs300 = seriesOf('hs300');
  const techList = [
    [aSse, 0.5],
    [aSzse, 0.2],
    [aCyb, 0.2],
    [aHs300, 0.1],
  ].filter(([a]) => a);
  const tech = techList.length
    ? techList.reduce((sum, [a, w]) => sum + technicalScore(a).score * w, 0) /
      techList.reduce((sum, [, w]) => sum + w, 0)
    : 50;

  const up = Number(breadth.up) || 0;
  const down = Number(breadth.down) || 0;
  const breadthScore = up + down > 0 ? (up / (up + down)) * 100 : 50;

  const mainYi = Number.isFinite(flow.last) ? flow.last : 0;
  const flowScore = clamp(50 + mainYi / 40, 5, 95);

  const usPcts = ['DJIA', 'SPX', 'NDX']
    .map((code) => byCode(global, code).pct)
    .filter((v) => Number.isFinite(v));
  const avgUS = avg(usPcts);
  const hsiPct = byCode(global, 'HSI').pct;
  const n225Pct = byCode(global, 'N225').pct;
  const daxPct = byCode(global, 'GDAXI').pct;
  const usdPct = byCode(global, 'UDI').pct;
  const a50Pct = byCode(commodities, 'CN00Y').pct;
  const goldPct = byCode(commodities, 'GC00Y').pct;

  const globalParts = [];
  if (Number.isFinite(avgUS)) globalParts.push([avgUS, 0.5]);
  if (Number.isFinite(hsiPct)) globalParts.push([hsiPct, 0.2]);
  if (Number.isFinite(n225Pct)) globalParts.push([n225Pct, 0.15]);
  if (Number.isFinite(daxPct)) globalParts.push([daxPct, 0.15]);
  const globalAvg = globalParts.length
    ? globalParts.reduce((s, [v, w]) => s + v * w, 0) /
      globalParts.reduce((s, [, w]) => s + w, 0)
    : 0;
  const globalScore = clamp(50 + globalAvg * 14, 0, 100);

  const newsStat = aggregateNews((news && news.items) || []);
  const newsScore = clamp(50 + newsStat.score * 45, 0, 100);

  const composite = clamp(
    tech * 0.42 + breadthScore * 0.2 + flowScore * 0.18 + globalScore * 0.12 + newsScore * 0.08,
    0,
    100,
  );
  const score = Math.round(composite);
  const rating = ratingFor(score, 'market');
  const position = positionFor(score, overview.risk || 'balanced');
  const temp = tempFor(score);
  const today = shanghaiToday();
  const dataDate = overview.dataDate || (aSse && aSse.lastDate) || today;
  const nextDate = nextTradingDate(dataDate);

  const sectorItems = (sectors && sectors.items) || [];
  const inflowCount = sectorItems.filter((s) => s.main > 0).length;
  const netSectorInflow = sectorItems.reduce((s, x) => s + (Number(x.main) || 0), 0);
  const topInflow = sectorItems[0] || null;
  const topOutflow = sectorItems.length ? sectorItems[sectorItems.length - 1] : null;

  const focus = sectorItems
    .filter((s) => s.main > 0 && s.pct > 0)
    .slice(0, 5)
    .map((s) => ({
      code: s.code,
      name: s.name,
      pct: s.pct,
      main: s.main,
      reason: `主力净流入 ${nf(s.main, 1)} 亿，板块 ${pctText(s.pct)}`,
    }));
  if (!focus.length) {
    focus.push(...sectorItems.filter((s) => s.main > 0).slice(0, 5).map((s) => ({
      code: s.code,
      name: s.name,
      pct: s.pct,
      main: s.main,
      reason: `主力净流入 ${nf(s.main, 1)} 亿，价格仍待确认`,
    })));
  }
  const avoid = sectorItems
    .filter((s) => s.main < 0 && s.pct < 0)
    .slice(-5)
    .reverse()
    .map((s) => ({
      code: s.code,
      name: s.name,
      pct: s.pct,
      main: s.main,
      reason: `主力净流出 ${nf(Math.abs(s.main), 1)} 亿，板块 ${pctText(s.pct)}`,
    }));

  const totalAmount = (Number(sseQ.amount) || 0) + (Number(szseQ.amount) || 0);
  const breadthLabel = up > down * 1.5 ? '普涨格局' : down > up * 1.5 ? '普跌格局' : '涨跌分化';
  const flowWord = mainYi >= 0 ? '净流入' : '净流出';
  const mainAbs = Math.abs(mainYi);
  const marketWord = (sseQ.pct || 0) >= 0 ? '收涨' : '收跌';

  const reviewBullets = [
    `上证指数收 ${nf(sseQ.price)}，${pctText(sseQ.pct)}；深证成指 ${pctText(szseQ.pct)}，创业板指 ${pctText(cybQ.pct)}，北证50 ${pctText(bseQ.pct)}。`,
    `全市场 ${up} 家上涨、${down} 家下跌、${Number(breadth.flat) || 0} 家平盘，${breadthLabel}；两市成交额约 ${wanYiText(totalAmount)} 万亿元。`,
    `主力资金全天${flowWord} ${nf(mainAbs, 1)} 亿元；${topInflow ? `${topInflow.name}（${pctText(topInflow.pct)}，主力 +${nf(topInflow.main, 1)} 亿）` : '—'}流入居前，${topOutflow ? `${topOutflow.name}（${pctText(topOutflow.pct)}，主力 ${nf(topOutflow.main, 1)} 亿）` : '—'}流出居前。`,
    `外围市场：美股三大指数均值 ${pctText(avgUS)}，恒生指数 ${pctText(hsiPct)}，日经225 ${pctText(n225Pct)}，美元指数 ${pctText(usdPct)}，A50 期货 ${pctText(a50Pct)}，COMEX 黄金 ${pctText(goldPct)}。`,
    `消息面${newsStat.label}：正面 ${newsStat.positive} 条、负面 ${newsStat.negative} 条${newsStat.topNegative[0] ? `；关注「${newsStat.topNegative[0].title}」` : ''}。`,
  ];

  const summaryReview =
    `${dataDate} A股${marketWord}，上证收 ${nf(sseQ.price)}（${pctText(sseQ.pct)}），` +
    `全市场 ${up} 涨 / ${down} 跌，成交 ${wanYiText(totalAmount)} 万亿元；` +
    `主力资金${flowWord} ${nf(mainAbs, 1)} 亿元，${topInflow ? topInflow.name : '—'}相对强势。` +
    `外围${globalAvg < 0 ? '偏弱' : '偏暖'}，消息面${newsStat.label}。`;

  const s1 = aSse ? aSse.s1 : (Number(sseQ.price) || 0) * 0.98;
  const s2 = aSse ? aSse.s2 : (Number(sseQ.price) || 0) * 0.96;
  const r1 = aSse ? aSse.r1 : (Number(sseQ.price) || 0) * 1.02;
  const r2 = aSse ? aSse.r2 : (Number(sseQ.price) || 0) * 1.04;

  const planBullets = [
    `上证核心观察区间 ${nf(s1)}–${nf(r1)}，强支撑 ${nf(s2)}，强压力 ${nf(r2)}；MA20 位于 ${nf(aSse && aSse.ma20)}。`,
    `若放量站稳 ${nf(r1)}，可看向 ${nf(r2)}，届时关注领涨板块能否形成合力；若跌破 ${nf(s1)}，下一支撑看 ${nf(s2)}，需主动降低仓位。`,
    `方向优先级：${focus.length ? focus.map((s) => s.name).join('、') : '等待资金形成主线'}；回避：${avoid.length ? avoid.map((s) => s.name).join('、') : '无明显流出板块'}。`,
    `仓位建议 ${position.text}；单日回撤超过 2% 时优先降仓，不用单一信号一次性打满。`,
  ];

  let upProb = clamp(35 + ((score - 50) / 50) * 30, 8, 68);
  let downProb = clamp(33 - ((score - 50) / 50) * 28, 8, 62);
  let flatProb = 100 - upProb - downProb;
  if (flatProb < 18) {
    const diff = (18 - flatProb) / 2;
    upProb -= diff;
    downProb -= diff;
    flatProb = 18;
  }
  const probs = [Math.round(upProb), Math.round(flatProb)];
  probs.push(100 - probs[0] - probs[1]);

  const scenarios = [
    {
      key: 'bull',
      label: '乐观情景',
      prob: probs[0],
      trigger: `上证放量突破 ${nf(r1)}`,
      action: '持有强势方向，回踩不破可加仓',
      target: `上看 ${nf(r2)}`,
      tone: 'up',
    },
    {
      key: 'base',
      label: '中性情景',
      prob: probs[1],
      trigger: `${nf(s1)}–${nf(r1)} 区间震荡`,
      action: '高抛低吸，聚焦资金流入板块',
      target: '结构性行情为主',
      tone: 'flat',
    },
    {
      key: 'bear',
      label: '谨慎情景',
      prob: probs[2],
      trigger: `跌破 ${nf(s1)} 且无法快速收回`,
      action: '降低仓位，等待止跌企稳',
      target: `下看 ${nf(s2)}`,
      tone: 'down',
    },
  ];

  const riskNotes = [];
  if (Number.isFinite(avgUS) && avgUS < -0.8) riskNotes.push(`隔夜美股均值 ${pctText(avgUS)}，外资风险偏好承压，可能拖累 A 股开盘。`);
  if (Number.isFinite(usdPct) && usdPct > 0.3) riskNotes.push(`美元指数 ${pctText(usdPct)}，走强阶段通常压制新兴市场估值与贵金属。`);
  if (mainYi < -200) riskNotes.push(`主力资金净流出 ${nf(Math.abs(mainYi), 1)} 亿元，反弹持续性需要资金回流确认。`);
  if (down > up * 2) riskNotes.push('市场下跌家数显著多于上涨家数，个股层面容易出现“指数稳、个股弱”。');
  riskNotes.push('模型基于日线收盘与公开资金流数据，盘中突发消息、政策与流动性变化可能快速改变结论。');
  riskNotes.push('若次日出现跳空缺口，原有支撑/压力位需按新价格结构重新计算。');

  const oneLine =
    `上证 ${pctText(sseQ.pct)} 收 ${nf(sseQ.price)}，${breadthLabel}，主力${flowWord} ${nf(mainAbs, 1)} 亿；` +
    `模型 ${score} 分，${rating.label}，参考仓位 ${position.text}。`;

  const sseTone = (Number(sseQ.pct) || 0) >= 0 ? 'up' : 'down';
  const reviewMetrics = [
    {
      label: '上证指数',
      value: pctText(sseQ.pct),
      sub: `收 ${nf(sseQ.price)}`,
      tone: sseTone,
    },
    {
      label: '两市成交',
      value: `${wanYiText(totalAmount)} 万亿`,
      sub: '沪深合计',
      tone: 'flat',
    },
    {
      label: '涨跌家数',
      value: `${up} / ${down}`,
      sub: `涨跌比 ${down ? (up / down).toFixed(2) : '--'}`,
      tone: up >= down ? 'up' : 'down',
    },
    {
      label: '主力资金',
      value: `${mainYi >= 0 ? '+' : ''}${nf(mainYi, 1)} 亿`,
      sub: flowWord,
      tone: mainYi >= 0 ? 'up' : 'down',
    },
  ];

  const reviewSections = [
    {
      label: '盘面',
      text: `上证收 ${nf(sseQ.price)}（${pctText(sseQ.pct)}），深证 ${pctText(szseQ.pct)}，创业板 ${pctText(cybQ.pct)}，北证50 ${pctText(bseQ.pct)}；${breadthLabel}。`,
    },
    {
      label: '资金',
      text: `主力全天${flowWord} ${nf(mainAbs, 1)} 亿元；${topInflow ? `${topInflow.name}净流入 ${nf(topInflow.main, 1)} 亿` : '—'}，${topOutflow ? `${topOutflow.name}净流出 ${nf(Math.abs(topOutflow.main), 1)} 亿` : '—'}。`,
    },
    {
      label: '板块',
      text: `相对强势：${focus.length ? focus.slice(0, 3).map((s) => s.name).join('、') : '暂未形成主线'}；承压：${avoid.length ? avoid.slice(0, 3).map((s) => s.name).join('、') : '暂无明显流出'}。`,
    },
    {
      label: '外围',
      text: `美股均值 ${pctText(avgUS)}，恒指 ${pctText(hsiPct)}，日经 ${pctText(n225Pct)}，美元指数 ${pctText(usdPct)}，A50 期货 ${pctText(a50Pct)}。`,
    },
    {
      label: '消息',
      text: `正面 ${newsStat.positive} 条 / 负面 ${newsStat.negative} 条，情绪${newsStat.label}${newsStat.topNegative[0] ? `；关注「${newsStat.topNegative[0].title}」` : ''}。`,
    },
  ];

  const techSse = aSse ? technicalScore(aSse) : { reasons: [], risks: [] };
  const bullSignals = [...(techSse.reasons || []).slice(0, 3)];
  const bearSignals = [...(techSse.risks || []).slice(0, 3)];
  if (breadthScore >= 55) bullSignals.push(`上涨家数占比 ${nf(breadthScore, 1)}%，市场宽度偏强`);
  else if (breadthScore <= 45) bearSignals.push(`上涨家数占比仅 ${nf(breadthScore, 1)}%，市场宽度偏弱`);
  if (mainYi > 0) bullSignals.push(`主力资金净流入 ${nf(mainYi, 1)} 亿元`);
  else bearSignals.push(`主力资金净流出 ${nf(Math.abs(mainYi), 1)} 亿元`);
  if (globalAvg > 0.2) bullSignals.push(`外围市场均值 ${pctText(globalAvg)}，风险偏好回暖`);
  else if (globalAvg < -0.2) bearSignals.push(`外围市场均值 ${pctText(globalAvg)}，开盘情绪承压`);
  if (newsStat.score > 0.12) bullSignals.push(`新闻情绪偏暖（${newsStat.positive} 正 / ${newsStat.negative} 负）`);
  else if (newsStat.score < -0.12) bearSignals.push(`新闻情绪偏冷（${newsStat.positive} 正 / ${newsStat.negative} 负）`);
  if (focus.length) bullSignals.push(`资金主线：${focus.slice(0, 3).map((s) => s.name).join('、')}`);
  if (avoid.length) bearSignals.push(`资金撤离：${avoid.slice(0, 2).map((s) => s.name).join('、')}`);

  const confidenceScore = clamp(
    55
    + (klines && klines.sse && klines.sse.candles && klines.sse.candles.length >= 120 ? 10 : 0)
    + (sectorItems.length > 50 ? 10 : 0)
    + (newsStat.total >= 20 ? 8 : 0)
    + (breadth.total > 1000 ? 7 : 0)
    + (globalParts.length >= 3 ? 5 : 0)
    + (aSse ? 5 : 0),
    0,
    95,
  );
  const confidenceLabel = confidenceScore >= 80 ? '高' : confidenceScore >= 65 ? '中高' : confidenceScore >= 50 ? '中' : '低';
  const confidence = {
    score: confidenceScore,
    label: confidenceLabel,
    note: `日线 ${klines && klines.sse ? klines.sse.candles.length : 0} 根 · 板块 ${sectorItems.length} 个 · 快讯 ${newsStat.total} 条`,
  };

  const recent = (klines && klines.sse && klines.sse.candles ? klines.sse.candles.slice(-5) : [])
    .map((c) => ({ date: c.d, close: c.c, pct: c.pct, volume: c.v }));

  const defensivePosition = positionFor(Math.max(0, score - 15), overview.risk || 'balanced');
  const planRules = [
    {
      if: `上证放量站稳 ${nf(r1)}`,
      then: `持有或加仓强势方向，目标看 ${nf(r2)}，回踩不破再确认`,
    },
    {
      if: `上证在 ${nf(s1)}–${nf(r1)} 区间震荡`,
      then: `保持 ${position.text}，做结构、不追高，优先资金流入板块`,
    },
    {
      if: `上证跌破 ${nf(s1)} 且 30 分钟未收回`,
      then: `降仓至 ${defensivePosition.text}，下一支撑看 ${nf(s2)}`,
    },
    {
      if: '开盘 30 分钟成交额明显低于昨日同期',
      then: '降低当日预期，先兑现浮盈，不新增追高仓位',
    },
  ];

  const planChecklist = [
    '开盘 30 分钟观察两市成交额是否较昨日同期放大',
    '确认领涨板块出现 2 个以上放量龙头，再提高仓位',
    '主力资金由净流出转为净流入前，不追高',
    '单日回撤超过 2% 时先降仓，不用单一信号打满',
    '若隔夜外围大跌，开盘先观察 15 分钟再决策',
  ];

  return {
    generatedAt: Date.now(),
    asOf: dataDate,
    nextDate,
    isTradingTime: overview.sessions && overview.sessions.cn && overview.sessions.cn.state === 'open',
    score,
    temperature: { score, label: temp.label, tone: temp.tone },
    rating,
    position,
    oneLine,
    dimensions: [
      dimension('trend', '趋势结构', tech, `上证 ${pctText(sseQ.pct)}，MA20 ${nf(aSse && aSse.ma20)}，均线${aSse && aSse.trend === 'up' ? '多头' : aSse && aSse.trend === 'down' ? '空头' : '纠缠'}`),
      dimension('capital', '资金动能', flowScore, `主力${flowWord} ${nf(mainAbs, 1)} 亿；${inflowCount}/${sectorItems.length} 个板块净流入`),
      dimension('sentiment', '市场情绪', breadthScore * 0.6 + newsScore * 0.4, `${up} 涨 / ${down} 跌；新闻情绪${newsStat.label}`),
      dimension('global', '外围环境', globalScore, `美股均值 ${pctText(avgUS)}，恒指 ${pctText(hsiPct)}，美元指数 ${pctText(usdPct)}`),
    ],
    review: {
      title: dataDate === today ? '今日复盘' : `${dataDate} 收盘复盘`,
      shortTitle: '今日复盘',
      date: dataDate,
      tone: sseTone,
      summary: summaryReview,
      bullets: reviewBullets,
      metrics: reviewMetrics,
      sections: reviewSections,
    },
    plan: {
      title: nextDate === today ? '今日交易策略' : `${nextDate} 交易策略`,
      shortTitle: '明日策略',
      date: nextDate,
      stance: `${rating.label} · 参考仓位 ${position.text}`,
      direction: rating.label,
      summary:
        `${nextDate} 关注上证 ${nf(s1)}–${nf(r1)} 区间。${rating.label}，建议${position.text}。` +
        `放量站稳 ${nf(r1)} 可看向 ${nf(r2)}；跌破 ${nf(s1)} 则回踩 ${nf(s2)}。`,
      bullets: planBullets,
      rules: planRules,
      checklist: planChecklist,
    },
    confidence,
    signals: {
      bull: [...new Set(bullSignals)].slice(0, 5),
      bear: [...new Set(bearSignals)].slice(0, 5),
    },
    recent,
    levels: {
      close: aSse ? aSse.close : sseQ.price,
      support: aSse ? aSse.support : s1,
      resistance: aSse ? aSse.resistance : r1,
      s1,
      s2,
      pivot: aSse ? aSse.pivot : null,
      r1,
      r2,
      ma20: aSse ? aSse.ma20 : null,
      high20: aSse ? aSse.high20 : null,
      low20: aSse ? aSse.low20 : null,
    },
    scenarios,
    focus,
    avoid,
    sectorStats: {
      count: sectorItems.length,
      inflowCount,
      outflowCount: sectorItems.length - inflowCount,
      netInflow: round(netSectorInflow, 1),
    },
    news: newsStat,
    riskNotes,
    note: overview.sessions && overview.sessions.cn && overview.sessions.cn.state !== 'open'
      ? '当前为非交易时段，以下策略基于最近一个交易日收盘数据推演。'
      : '',
    disclaimer: DISCLAIMER,
  };
}

module.exports = {
  analyze,
  technicalScore,
  stockAdvice,
  marketAdvice,
  aggregateNews,
  ratingFor,
  positionFor,
  nextTradingDate,
  shanghaiToday,
  nf,
  pctText,
  clamp,
  DISCLAIMER,
};
