'use strict';

/**
 * 纯 JavaScript 技术指标实现（无第三方依赖）。
 * 所有函数返回与输入等长的数组，数据不足的位置为 null。
 */

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    sum += Number.isFinite(v) ? v : 0;
    if (i >= period) {
      const old = Number(values[i - period]);
      sum -= Number.isFinite(old) ? old : 0;
    }
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) {
      out[i] = prev;
      continue;
    }
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const dif = values.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null;
    return emaFast[i] - emaSlow[i];
  });
  const dea = ema(dif.map((v) => (v === null ? 0 : v)), signal);
  const hist = dif.map((v, i) => {
    if (v === null || dea[i] === null) return null;
    return (v - dea[i]) * 2;
  });
  // 修正 EMA 预热期：前 slow 个点不输出
  for (let i = 0; i < Math.min(slow - 1, dif.length); i += 1) {
    dif[i] = null;
    dea[i] = null;
    hist[i] = null;
  }
  return { dif, dea, hist };
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const trs = [null];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const prevClose = candles[i - 1].c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose)));
  }
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += trs[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i += 1) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

function computeSeries(candles) {
  const closes = candles.map((c) => c.c);
  const volumes = candles.map((c) => c.v);
  const m = macd(closes);
  return {
    ma5: sma(closes, 5),
    ma10: sma(closes, 10),
    ma20: sma(closes, 20),
    ma60: sma(closes, 60),
    volMa5: sma(volumes, 5),
    rsi14: rsi(closes, 14),
    dif: m.dif,
    dea: m.dea,
    macd: m.hist,
    atr14: atr(candles, 14),
  };
}

module.exports = { sma, ema, rsi, macd, atr, computeSeries };
