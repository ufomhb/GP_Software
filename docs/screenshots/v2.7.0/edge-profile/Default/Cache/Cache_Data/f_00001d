/* 图表层：封装 ECharts，保持所有视图的视觉语言一致 */

const C = {
  up: '#ff4d5e',
  down: '#16c784',
  flat: '#94a3b8',
  accent: '#38bdf8',
  accent2: '#818cf8',
  gold: '#f5c451',
  text: '#dbe7f6',
  muted: '#7f8fa8',
  line: 'rgba(148,163,184,.12)',
  split: 'rgba(148,163,184,.075)',
  panel: '#0d1523',
};

const TOOLTIP = {
  backgroundColor: 'rgba(9,16,27,.97)',
  borderColor: 'rgba(148,163,184,.22)',
  borderWidth: 1,
  padding: [8, 11],
  textStyle: { color: '#dbe7f6', fontSize: 11 },
  extraCssText: 'backdrop-filter:blur(10px);border-radius:9px;box-shadow:0 16px 40px rgba(0,0,0,.45);',
};

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (s) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[s]));
}

function getChart(el) {
  if (!el || !window.echarts) return null;
  let inst = window.echarts.getInstanceByDom(el);
  if (!inst) {
    inst = window.echarts.init(el, null, { renderer: 'canvas' });
  }
  return inst;
}

function setOption(el, option) {
  if (!el) return null;
  if (!window.echarts) {
    el.innerHTML = '<div class="empty">图表组件未能加载</div>';
    return null;
  }
  const inst = getChart(el);
  if (!inst) return null;
  inst.setOption(option, true);
  return inst;
}

export function resizeCharts() {
  if (!window.echarts) return;
  document.querySelectorAll('.hero-chart,.main-chart,.tall-chart,.gauge-chart,.flow-chart,.distribution-chart,.fund-sector-chart,.csi300-ratio-chart,.csi300-ratio-line,.index-compare-chart,.index-mini-chart,.pa-pie,.umi-chart,.us-sector-chart').forEach((el) => {
    const inst = window.echarts.getInstanceByDom(el);
    if (inst) inst.resize();
  });
}

export function areaChart(el, candles, color = C.accent, options = {}) {
  if (!candles || candles.length < 2) {
    el.innerHTML = '<div class="empty">暂无走势数据</div>';
    return null;
  }
  const dates = candles.map((c) => c.d);
  const values = candles.map((c) => c.c);
  const rgb = color === C.up ? '255,77,94' : color === C.down ? '22,199,132' : '56,189,248';
  const axes = options.axes === true;
  const timeLabel = (v) => {
    const s = String(v == null ? '' : v);
    if (s.includes(' ')) return s.slice(11, 16);
    return s.length > 5 ? s.slice(5) : s;
  };
  return setOption(el, {
    animation: false,
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: 'rgba(56,189,248,.35)' } },
      formatter: (ps) => {
        const p = ps[0];
        return `<div style="color:#7f8fa8;font-size:10px">${esc(p.axisValue)}</div><div style="font-family:Bahnschrift;font-size:15px;margin-top:3px">${Number(p.value).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>`;
      },
    },
    grid: axes
      ? { left: 52, right: 20, top: 16, bottom: 28 }
      : { left: 0, right: 0, top: 8, bottom: 0 },
    xAxis: axes
      ? {
          type: 'category',
          data: dates,
          boundaryGap: false,
          axisLine: { lineStyle: { color: C.line } },
          axisTick: { show: false },
          axisLabel: { color: C.muted, fontSize: 9, formatter: timeLabel, hideOverlap: true },
          splitLine: { show: false },
        }
      : { type: 'category', data: dates, boundaryGap: false, show: false },
    yAxis: axes
      ? {
          type: 'value',
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: C.muted, fontSize: 9, formatter: (v) => Number(v).toFixed(2) },
          splitLine: { lineStyle: { color: C.split } },
        }
      : { type: 'value', scale: true, show: false },
    series: [{
      type: 'line',
      data: values,
      smooth: 0.25,
      showSymbol: false,
      lineStyle: { width: 1.7, color },
      areaStyle: {
        color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: `rgba(${rgb},.30)` },
          { offset: 0.72, color: `rgba(${rgb},.045)` },
          { offset: 1, color: `rgba(${rgb},0)` },
        ]),
      },
    }],
  });
}

export function candleChart(el, kline, options = {}) {
  const candles = kline && kline.candles;
  if (!candles || candles.length < 2) {
    el.innerHTML = '<div class="empty">暂无 K 线数据</div>';
    return null;
  }
  const series = kline.series || {};
  const dates = candles.map((c) => c.d);
  const ohlc = candles.map((c) => [c.o, c.c, c.l, c.h]);
  const intraday = options.intraday || dates[0].includes(' ');
  const xLabel = (value) => {
    if (!intraday) return value.slice(5);
    return value.includes(' ') ? value.slice(5, 16) : value;
  };
  const volumes = candles.map((c) => c.v);
  const amount = candles.map((c) => c.a);
  const hasVolume = volumes.some((v) => Number(v) > 0);
  const zoomState = options.zoomStartValue && options.zoomEndValue
    ? { startValue: options.zoomStartValue, endValue: options.zoomEndValue }
    : { start: options.zoomStart ?? 30, end: options.zoomEnd ?? 100 };

  /*
   * 副图指标：macd / kdj / boll / none（默认 macd）。
   * boll 是主图叠加（通道线画在价格图上），macd 与 kdj 各占一个独立副图 grid。
   * 数据不足或字段缺失时自动退回 none，不画空白副图。
   */
  const want = ['macd', 'kdj', 'boll', 'none'].includes(options.indicator) ? options.indicator : 'macd';
  const hasBoll = want === 'boll' && Array.isArray(series.bollMid) && series.bollMid.some((v) => Number.isFinite(v));
  const subKind = (want === 'macd' && Array.isArray(series.dif)) || (want === 'kdj' && Array.isArray(series.kdjK))
    ? want
    : (hasBoll ? 'boll' : 'none');
  const showSub = subKind === 'macd' || subKind === 'kdj';
  const gridCount = 1 + (showSub ? 1 : 0) + (hasVolume ? 1 : 0);
  const subIndex = showSub ? 1 : null;
  const volIndex = hasVolume ? (showSub ? 2 : 1) : null;
  const xAxisIndexes = Array.from({ length: gridCount }, (_, i) => i);

  let layout;
  if (gridCount === 3) layout = { main: { top: 23, height: '44%' }, sub: { top: '66%', height: '11%' }, vol: { top: '81%', height: '12%' } };
  else if (showSub) layout = { main: { top: 23, height: '60%' }, sub: { top: '74%', height: '18%' } };
  else if (hasVolume) layout = { main: { top: 23, height: '63%' }, vol: { top: '76%', height: '15%' } };
  else layout = { main: { top: 23, height: '76%' } };

  const maSeries = [
    ['MA5', series.ma5, '#f5c451'],
    ['MA10', series.ma10, '#38bdf8'],
    ['MA20', series.ma20, '#c084fc'],
    ['MA60', series.ma60, '#94a3b8'],
  ].filter(([, arr]) => Array.isArray(arr)).map(([name, data, color]) => ({
    name,
    type: 'line',
    data,
    smooth: true,
    showSymbol: false,
    connectNulls: false,
    lineStyle: { width: 1, color, opacity: 0.9 },
    itemStyle: { color },
    emphasis: { disabled: true },
  }));

  // BOLL(20,2) 通道：叠加在主图价格上
  const bollSeries = hasBoll ? [
    ['BOLL中轨', series.bollMid, C.muted, 1.2, 'dashed'],
    ['BOLL上轨', series.bollUpper, '#c084fc', 1, 'solid'],
    ['BOLL下轨', series.bollLower, '#c084fc', 1, 'solid'],
  ].map(([name, data, color, width, type]) => ({
    name,
    type: 'line',
    data,
    smooth: true,
    showSymbol: false,
    connectNulls: false,
    lineStyle: { width, color, opacity: 0.9, type },
    itemStyle: { color },
    emphasis: { disabled: true },
  })) : [];

  // 副图指标序列（共用副图 grid）
  const subSeries = subKind === 'macd'
    ? [
        {
          name: 'MACD',
          type: 'bar',
          xAxisIndex: subIndex,
          yAxisIndex: subIndex,
          data: series.macd,
          barWidth: '55%',
          itemStyle: {
            color: (p) => (Number(p.value) >= 0 ? 'rgba(255,77,94,.75)' : 'rgba(22,199,132,.75)'),
          },
          emphasis: { disabled: true },
        },
        {
          name: 'DIF',
          type: 'line',
          xAxisIndex: subIndex,
          yAxisIndex: subIndex,
          data: series.dif,
          showSymbol: false,
          smooth: true,
          connectNulls: false,
          lineStyle: { width: 1.1, color: C.accent },
          itemStyle: { color: C.accent },
          emphasis: { disabled: true },
        },
        {
          name: 'DEA',
          type: 'line',
          xAxisIndex: subIndex,
          yAxisIndex: subIndex,
          data: series.dea,
          showSymbol: false,
          smooth: true,
          connectNulls: false,
          lineStyle: { width: 1.1, color: C.gold },
          itemStyle: { color: C.gold },
          emphasis: { disabled: true },
        },
      ]
    : subKind === 'kdj'
      ? [
          ['K', series.kdjK, C.accent],
          ['D', series.kdjD, C.gold],
          ['J', series.kdjJ, '#c084fc'],
        ].map(([name, data, color]) => ({
          name,
          type: 'line',
          xAxisIndex: subIndex,
          yAxisIndex: subIndex,
          data,
          showSymbol: false,
          smooth: true,
          connectNulls: false,
          lineStyle: { width: 1.1, color },
          itemStyle: { color },
          emphasis: { disabled: true },
        }))
      : [];

  const legendNames = [
    ...maSeries.map((s) => s.name),
    ...bollSeries.map((s) => s.name),
    ...subSeries.map((s) => s.name),
  ];

  return setOption(el, {
    animation: false,
    legend: {
      top: 0,
      right: 8,
      itemWidth: 10,
      itemHeight: 2,
      itemGap: 10,
      textStyle: { color: C.muted, fontSize: 9 },
      data: legendNames,
    },
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'cross', lineStyle: { color: 'rgba(56,189,248,.28)' }, crossStyle: { color: 'rgba(56,189,248,.28)' } },
      formatter: (params) => {
        const idx = params[0] && params[0].dataIndex;
        const c = candles[idx];
        if (!c) return '';
        const chg = Number.isFinite(c.pct) ? c.pct : 0;
        const tone = chg >= 0 ? C.up : C.down;
        return `<div style="color:#7f8fa8;font-size:10px;margin-bottom:4px">${esc(c.d)}</div>
          <div style="display:grid;grid-template-columns:auto auto;gap:2px 14px;font-size:10px;color:#9fb2c9">
            <span>开盘 <b style="color:#dbe7f6;font-family:Bahnschrift">${Number(c.o).toFixed(2)}</b></span>
            <span>最高 <b style="color:#dbe7f6;font-family:Bahnschrift">${Number(c.h).toFixed(2)}</b></span>
            <span>收盘 <b style="color:${tone};font-family:Bahnschrift">${Number(c.c).toFixed(2)}</b></span>
            <span>最低 <b style="color:#dbe7f6;font-family:Bahnschrift">${Number(c.l).toFixed(2)}</b></span>
            <span>涨跌 <b style="color:${tone};font-family:Bahnschrift">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</b></span>
            <span>成交 <b style="color:#dbe7f6;font-family:Bahnschrift">${(c.v / 1e4).toFixed(0)}万</b></span>
          </div>`;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: gridCount > 1
      ? [
          { left: 48, right: 14, ...layout.main },
          showSub ? { left: 48, right: 14, ...layout.sub } : null,
          hasVolume ? { left: 48, right: 14, ...layout.vol } : null,
        ].filter(Boolean)
      : [{ left: 48, right: 14, ...layout.main }],
    xAxis: xAxisIndexes.map((i) => ({
      type: 'category',
      data: dates,
      gridIndex: i,
      boundaryGap: true,
      axisLine: { lineStyle: { color: C.line } },
      axisTick: { show: false },
      axisLabel: i === 0
        ? { color: C.muted, fontSize: 9, formatter: xLabel, hideOverlap: true }
        : { show: false },
      splitLine: { show: false },
    })),
    yAxis: xAxisIndexes.map((i) => {
      const axis = {
        gridIndex: i,
        scale: true,
        position: 'left',
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: C.split } },
      };
      if (i === volIndex) {
        return {
          ...axis,
          axisLabel: {
            color: C.muted,
            fontSize: 8,
            formatter: (v) => (v >= 1e8 ? `${(v / 1e8).toFixed(0)}亿` : `${(v / 1e4).toFixed(0)}万`),
          },
          splitLine: { show: false },
        };
      }
      if (i === subIndex) {
        return {
          ...axis,
          axisLabel: {
            color: C.muted,
            fontSize: 8,
            formatter: (v) => (subKind === 'kdj' ? Number(v).toFixed(0) : Number(v).toFixed(2)),
          },
          splitLine: { show: false },
        };
      }
      return { ...axis, axisLabel: { color: C.muted, fontSize: 9, formatter: (v) => Number(v).toFixed(2) } };
    }),
    dataZoom: [
      { type: 'inside', xAxisIndex: xAxisIndexes, ...zoomState },
      {
        type: 'slider',
        xAxisIndex: xAxisIndexes,
        bottom: 0,
        height: 13,
        ...zoomState,
        borderColor: 'transparent',
        backgroundColor: 'rgba(148,163,184,.05)',
        fillerColor: 'rgba(56,189,248,.1)',
        handleStyle: { color: '#38bdf8', borderColor: '#38bdf8' },
        textStyle: { color: C.muted, fontSize: 8 },
        dataBackground: { lineStyle: { color: 'rgba(148,163,184,.25)' }, areaStyle: { color: 'rgba(148,163,184,.08)' } },
      },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        data: ohlc,
        itemStyle: {
          color: C.up,
          color0: C.down,
          borderColor: C.up,
          borderColor0: C.down,
        },
        emphasis: { itemStyle: { borderWidth: 1.5 } },
      },
      ...maSeries,
      ...bollSeries,
      ...subSeries,
      ...(hasVolume ? [{
        name: '成交量',
        type: 'bar',
        xAxisIndex: volIndex,
        yAxisIndex: volIndex,
        data: volumes,
        barWidth: '62%',
        itemStyle: {
          color: (p) => {
            const c = candles[p.dataIndex];
            return c && c.c >= c.o ? 'rgba(255,77,94,.45)' : 'rgba(22,199,132,.45)';
          },
        },
        emphasis: { itemStyle: { opacity: 0.85 } },
      }] : []),
    ],
  });
}

export function csi300RatioGauge(el, ratio) {
  const value = Number(ratio) || 0;
  const max = Math.max(1, Math.ceil(value * 2 * 10) / 10);
  return setOption(el, {
    animationDuration: 650,
    series: [{
      type: 'gauge',
      startAngle: 210,
      endAngle: -30,
      min: 0,
      max,
      splitNumber: 4,
      radius: '92%',
      center: ['50%', '54%'],
      progress: { show: true, width: 10, itemStyle: { color: C.accent } },
      axisLine: { lineStyle: { width: 10, color: [[1, 'rgba(148,163,184,.12)']] } },
      pointer: { show: true, length: '52%', width: 3, itemStyle: { color: C.accent } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      anchor: { show: true, size: 5, itemStyle: { color: C.accent } },
      title: { offsetCenter: [0, '78%'], color: C.muted, fontSize: 8 },
      detail: {
        offsetCenter: [0, '42%'],
        color: '#dff6ff',
        fontFamily: 'Bahnschrift',
        fontSize: 20,
        formatter: () => `${value.toFixed(2)}%`,
      },
      data: [{ value, name: '占流通市值' }],
    }],
  });
}

export function indexCompareChart(el, series) {
  const items = Array.isArray(series) ? series.filter((s) => Array.isArray(s.data) && s.data.length) : [];
  if (!items.length) {
    if (el) el.innerHTML = '<div class="empty">暂无指数对比数据</div>';
    return null;
  }
  const colors = [C.up, C.accent, C.gold, '#c084fc', C.down];
  const dates = [...new Set(items.flatMap((s) => s.data.map((x) => x[0])))].sort();
  const seriesData = items.map((s) => {
    const map = new Map(s.data.map(([d, v]) => [d, v]));
    return dates.map((d) => (map.has(d) ? map.get(d) : null));
  });
  return setOption(el, {
    animation: false,
    legend: {
      top: 0,
      right: 8,
      itemWidth: 10,
      itemHeight: 2,
      itemGap: 12,
      textStyle: { color: C.muted, fontSize: 9 },
      data: items.map((s) => s.name),
    },
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'cross', lineStyle: { color: 'rgba(56,189,248,.25)' } },
      formatter: (ps) => {
        if (!ps || !ps.length) return '';
        const date = ps[0].axisValue;
        return `<div style="color:#7f8fa8;font-size:10px;margin-bottom:4px">${esc(date)}</div>` +
          ps.map((p) => `<div style="font-size:10px;color:#9fb2c9">${esc(p.seriesName)} <b style="color:${p.color};font-family:Bahnschrift">${Number(p.value).toFixed(2)}</b></div>`).join('');
      },
    },
    grid: { left: 48, right: 18, top: 26, bottom: 30 },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine: { lineStyle: { color: C.line } },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 8, hideOverlap: true, formatter: (v) => String(v).slice(5) },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 8, formatter: (v) => `${Number(v).toFixed(0)}` },
      splitLine: { lineStyle: { color: C.split } },
    },
    series: items.map((s, i) => ({
      name: s.name,
      type: 'line',
      data: seriesData[i],
      smooth: false,
      showSymbol: false,
      connectNulls: true,
      lineStyle: { width: 1.4, color: colors[i % colors.length] },
      itemStyle: { color: colors[i % colors.length] },
    })),
  });
}

export function indexMiniChart(el, item) {
  const rows = Array.isArray(item?.data) ? item.data.map(([d, v]) => [d, Number(v)]).filter(([, v]) => Number.isFinite(v)) : [];
  if (!el || rows.length < 2) {
    if (el) el.innerHTML = '<div class="empty">暂无走势</div>';
    return null;
  }
  const up = Number(item.changePct) >= 0;
  const color = up ? C.up : C.down;
  const rgb = up ? '255,77,94' : '22,199,132';
  const values = rows.map(([, v]) => v);
  return setOption(el, {
    animation: false,
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: 'rgba(56,189,248,.22)' } },
      formatter: (ps) => {
        const p = ps && ps[0];
        if (!p) return '';
        return `<div style="color:#7f8fa8;font-size:10px">${esc(p.axisValue)}</div><div style="font-family:Bahnschrift;font-size:13px;margin-top:3px">${Number(p.value).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>`;
      },
    },
    grid: { left: 4, right: 4, top: 8, bottom: 22 },
    xAxis: {
      type: 'category',
      data: rows.map(([d]) => String(d).slice(0, 10)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: C.line } },
      axisTick: { show: false },
      // 近一年的日线：大致给出 4 个日期刻度（MM-DD），不再把 X 轴整个藏掉。
      axisLabel: {
        color: C.muted,
        fontSize: 8,
        hideOverlap: true,
        interval: Math.max(0, Math.floor(rows.length / 4) - 1),
        formatter: (v) => String(v).slice(5),
      },
      splitLine: { show: false },
    },
    yAxis: { type: 'value', scale: true, show: false },
    series: [{
      type: 'line',
      data: values,
      smooth: 0.16,
      showSymbol: false,
      lineStyle: { width: 1.5, color },
      areaStyle: {
        color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: `rgba(${rgb},.24)` },
          { offset: 1, color: `rgba(${rgb},0)` },
        ]),
      },
      markLine: {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: 'rgba(148,163,184,.22)', width: 1, type: 'dashed' },
        data: [{ yAxis: values[0] }],
      },
    }],
  });
}

export function csi300RatioLine(el, history) {
  const rows = Array.isArray(history) ? history.filter((x) => Number.isFinite(Number(x.ratio))) : [];
  if (rows.length < 2) {
    if (el) el.innerHTML = '<div class="empty">暂无近半年占比数据</div>';
    return null;
  }
  const dates = rows.map((x) => String(x.d).slice(5));
  const values = rows.map((x) => Number(x.ratio));
  const min = Math.max(0, Math.floor((Math.min(...values) - 0.08) * 10) / 10);
  const max = Math.ceil((Math.max(...values) + 0.08) * 10) / 10;
  return setOption(el, {
    animation: false,
    grid: { left: 46, right: 18, top: 22, bottom: 28 },
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      formatter: (ps) => {
        const row = rows[ps[0].dataIndex];
        return `<div style="color:#7f8fa8;font-size:10px;margin-bottom:4px">${esc(row.d)}</div>
          <div style="font-size:11px;color:#dbe7f6">占比 <b style="color:${C.accent};font-family:Bahnschrift">${Number(row.ratio).toFixed(2)}%</b></div>
          <div style="font-size:10px;color:#7f8fa8;margin-top:2px">沪深300 ${Number(row.close).toFixed(2)}</div>`;
      },
    },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: C.line } },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 8, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      min,
      max,
      splitLine: { lineStyle: { color: C.split } },
      axisLabel: { color: C.muted, fontSize: 8, formatter: (v) => `${v.toFixed(1)}%` },
    },
    series: [{
      name: '基金规模/流通市值',
      type: 'line',
      data: values,
      smooth: true,
      symbol: 'none',
      lineStyle: { width: 2, color: C.accent },
      itemStyle: { color: C.accent },
      areaStyle: { color: 'rgba(56,189,248,.14)' },
      markPoint: {
        symbol: 'circle',
        symbolSize: 5,
        data: [{ coord: [dates.length - 1, values[values.length - 1]] }],
        itemStyle: { color: C.accent },
        label: { show: false },
      },
    }],
  });
}

export function distributionChart(el, buckets, total = null) {
  if (!buckets || !buckets.length) {
    if (el) el.innerHTML = '<div class="empty">暂无涨跌分布数据</div>';
    return null;
  }
  const labels = buckets.map((b) => b.label);
  const values = buckets.map((b) => b.count);
  const colors = buckets.map((b) => (b.tone === 'up' ? C.up : b.tone === 'down' ? C.down : C.flat));
  return setOption(el, {
    animationDuration: 500,
    grid: { left: 42, right: 16, top: 28, bottom: 30 },
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(56,189,248,.045)' } },
      formatter: (params) => {
        const p = params[0];
        const count = Number(p.value) || 0;
        const share = total ? ((count / total) * 100).toFixed(1) : null;
        return `<b>${esc(p.name)}</b><br/>${count} 家${share ? ` · 占比 ${share}%` : ''}`;
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: C.line } },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 9, interval: 0 },
    },
    yAxis: {
      type: 'value',
      name: '家数',
      nameTextStyle: { color: C.muted, fontSize: 9 },
      splitLine: { lineStyle: { color: C.split } },
      axisLabel: { color: C.muted, fontSize: 9 },
    },
    series: [{
      type: 'bar',
      data: values.map((v, i) => ({ value: v, itemStyle: { color: colors[i], borderRadius: [3, 3, 0, 0] } })),
      barWidth: '56%',
      label: { show: true, position: 'top', color: '#9fb2c9', fontSize: 9 },
    }],
  });
}

export function sectorFlowBar(el, sectors, options = {}) {
  const items = Array.isArray(sectors) ? sectors : [];
  if (!items.length) {
    el.innerHTML = '<div class="empty">暂无板块资金数据</div>';
    return null;
  }
  const n = Math.max(1, Math.min(12, Number(options.limit) || 7));
  // 流入：净流入从大到小（保持现状）
  const topIn = items.filter((s) => s.main > 0).sort((a, b) => b.main - a.main).slice(0, n);
  // 流出：先取流出金额最大的 n 个板块，再按流出绝对额从小到大排列
  const topOut = items
    .filter((s) => s.main < 0)
    .sort((a, b) => a.main - b.main)
    .slice(0, n)
    .sort((a, b) => Math.abs(a.main) - Math.abs(b.main));
  const rows = [...topIn, ...topOut];
  const names = rows.map((s) => s.name.length > 7 ? `${s.name.slice(0, 7)}…` : s.name);
  const values = rows.map((s) => s.main);
  return setOption(el, {
    animation: false,
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(56,189,248,.04)' } },
      formatter: (ps) => {
        const p = ps[0];
        const row = rows[p.dataIndex];
        return `<div style="font-size:11px;color:#dbe7f6">${esc(row.name)}</div><div style="font-size:10px;color:#7f8fa8;margin-top:3px">主力净流入 <b style="color:${row.main >= 0 ? C.up : C.down};font-family:Bahnschrift">${row.main >= 0 ? '+' : ''}${row.main.toFixed(2)} 亿</b></div><div style="font-size:10px;color:#7f8fa8">板块涨跌 <b style="color:${row.pct >= 0 ? C.up : C.down}">${row.pct >= 0 ? '+' : ''}${Number(row.pct).toFixed(2)}%</b></div>`;
      },
    },
    grid: { left: 78, right: 58, top: 5, bottom: 5 },
    xAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 8, formatter: (v) => `${v}亿` },
      splitLine: { lineStyle: { color: C.split } },
    },
    yAxis: {
      type: 'category',
      data: names,
      inverse: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#9fb2c9', fontSize: 9 },
    },
    series: [
      {
        name: '净流入',
        type: 'bar',
        stack: 'flow',
        barWidth: 9,
        data: rows.map((s) => (s.main >= 0 ? {
          value: s.main,
          itemStyle: { color: 'rgba(255,77,94,.72)', borderRadius: [0, 3, 3, 0] },
          label: { color: '#ff9aa3' },
        } : null)),
        label: {
          show: true,
          position: 'right',
          formatter: (p) => `+${Number(p.value).toFixed(1)}`,
          fontFamily: 'Bahnschrift',
          fontSize: 8,
        },
      },
      {
        name: '净流出',
        type: 'bar',
        stack: 'flow',
        barWidth: 9,
        data: rows.map((s) => (s.main < 0 ? {
          value: s.main,
          itemStyle: { color: 'rgba(22,199,132,.72)', borderRadius: [3, 0, 0, 3] },
          label: { color: '#68ddb4' },
        } : null)),
        label: {
          show: true,
          position: 'left',
          formatter: (p) => `${Number(p.value).toFixed(1)}`,
          fontFamily: 'Bahnschrift',
          fontSize: 8,
        },
      },
    ],
  });
}

/**
 * 自选组合建议：建议配置饼图（环形）。
 * slices: [{ name, value, color }]，value 为百分比数值。
 */
export function allocationPie(el, slices) {
  const items = (Array.isArray(slices) ? slices : [])
    .filter((s) => s && Number(s.value) > 0);
  if (!items.length) {
    if (el) el.innerHTML = '<div class="empty small">暂无配置建议</div>';
    return null;
  }
  const total = items.reduce((sum, s) => sum + Number(s.value), 0);
  return setOption(el, {
    animationDuration: 550,
    title: {
      text: `${Math.round(total)}%`,
      subtext: '建议配置',
      left: '50%',
      top: '36%',
      textAlign: 'center',
      itemGap: 2,
      textStyle: {
        color: '#dbe7f6',
        fontFamily: 'Bahnschrift',
        fontSize: 22,
        fontWeight: 600,
      },
      subtextStyle: { color: '#64748b', fontSize: 9 },
    },
    tooltip: {
      ...TOOLTIP,
      trigger: 'item',
      formatter: (p) => `<div style="font-size:11px;color:#dbe7f6">${esc(p.name)}</div><div style="font-size:10px;color:#7f8fa8;margin-top:3px">建议比例 <b style="color:${p.color};font-family:Bahnschrift">${p.percent}%</b></div>`,
    },
    series: [{
      type: 'pie',
      radius: ['50%', '76%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      minAngle: 2,
      itemStyle: {
        borderColor: '#0b1320',
        borderWidth: 2,
        borderRadius: 3,
      },
      label: { show: false },
      labelLine: { show: false },
      emphasis: {
        scale: true,
        scaleSize: 4,
        itemStyle: { shadowBlur: 12, shadowColor: 'rgba(0,0,0,.45)' },
      },
      data: items.map((s) => ({
        name: s.name,
        value: Number(s.value),
        itemStyle: { color: s.color },
      })),
    }],
  });
}

function heatColor(pct) {
  const p = Math.max(-8, Math.min(8, Number(pct) || 0));
  if (p >= 0) {
    const a = 0.14 + Math.min(0.46, (p / 8) * 0.46);
    return `rgba(255,77,94,${a.toFixed(3)})`;
  }
  const a = 0.14 + Math.min(0.46, (-p / 8) * 0.46);
  return `rgba(22,199,132,${a.toFixed(3)})`;
}

export function sectorTreemap(el, sectors) {
  const items = (Array.isArray(sectors) ? sectors : [])
    .filter((s) => Number.isFinite(s.amountYi) && s.amountYi > 0)
    .slice(0, 60);
  if (!items.length) {
    el.innerHTML = '<div class="empty">暂无热力图数据</div>';
    return null;
  }
  return setOption(el, {
    animation: false,
    tooltip: {
      ...TOOLTIP,
      formatter: (p) => {
        const d = p.data;
        return `<div style="font-size:12px;color:#dbe7f6">${esc(d.name)}</div><div style="font-size:10px;color:#7f8fa8;margin-top:4px;line-height:1.7">涨跌幅 <b style="color:${d.pct >= 0 ? C.up : C.down}">${d.pct >= 0 ? '+' : ''}${Number(d.pct).toFixed(2)}%</b><br>主力净流入 <b style="color:${d.main >= 0 ? C.up : C.down}">${d.main >= 0 ? '+' : ''}${Number(d.main).toFixed(2)} 亿</b><br>成交额 ${Number(d.amount).toFixed(1)} 亿</div>`;
      },
    },
    series: [{
      type: 'treemap',
      width: '100%',
      height: '100%',
      roam: false,
      nodeClick: false,
      breadcrumb: { show: false },
      label: {
        show: true,
        color: '#fff',
        fontSize: 10,
        lineHeight: 15,
        overflow: 'truncate',
        ellipsis: '…',
        formatter: (p) => `${p.data.name}\n${p.data.pct >= 0 ? '+' : ''}${Number(p.data.pct).toFixed(2)}%`,
      },
      itemStyle: { borderColor: '#0a111d', borderWidth: 1, gapWidth: 1 },
      data: items.map((s) => ({
        name: s.name,
        value: Math.max(1, s.amountYi),
        pct: s.pct,
        main: s.main,
        amount: s.amountYi,
        itemStyle: { color: heatColor(s.pct) },
        // 小面积色块隐藏文字，避免标签互相覆盖；悬浮仍可查看详情。
        label: { show: s.amountYi >= 120 },
      })),
    }],
  });
}

export function gaugeChart(el, score, tone = 'flat') {
  const color = tone === 'up' ? C.up : tone === 'down' ? C.down : C.accent;
  const safe = Math.max(0, Math.min(100, Number(score) || 0));
  return setOption(el, {
    animation: false,
    series: [{
      type: 'gauge',
      startAngle: 210,
      endAngle: -30,
      min: 0,
      max: 100,
      center: ['50%', '56%'],
      radius: '92%',
      progress: { show: true, width: 9, roundCap: true, itemStyle: { color } },
      axisLine: { lineStyle: { width: 9, color: [[1, 'rgba(148,163,184,.12)']] } },
      pointer: { show: true, length: '56%', width: 3.5, itemStyle: { color } },
      anchor: { show: true, size: 7, itemStyle: { color, borderColor: '#0d1523', borderWidth: 2 } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      title: { show: false },
      detail: {
        valueAnimation: false,
        offsetCenter: [0, '22%'],
        fontSize: 34,
        fontWeight: 700,
        fontFamily: 'Bahnschrift',
        color: '#e9f0fa',
        formatter: () => String(Math.round(safe)),
      },
      data: [{ value: safe }],
    }],
  });
}

export function flowLine(el, flow) {
  const points = (flow && flow.points) || [];
  if (!points.length) {
    el.innerHTML = '<div class="empty">暂无分时资金数据</div>';
    return null;
  }
  const last = points[points.length - 1].main;
  const color = last >= 0 ? C.up : C.down;
  return setOption(el, {
    animation: false,
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      formatter: (ps) => {
        const p = ps[0];
        return `<div style="font-size:10px;color:#7f8fa8">${esc(p.axisValue)}</div><div style="margin-top:3px;font-size:10px;color:#9fb2c9">主力净流入 <b style="font-family:Bahnschrift;color:${Number(p.value) >= 0 ? C.up : C.down}">${Number(p.value).toFixed(2)} 亿</b></div>`;
      },
    },
    grid: { left: 48, right: 12, top: 12, bottom: 22 },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.t),
      boundaryGap: false,
      axisLine: { lineStyle: { color: C.line } },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 8, interval: Math.max(1, Math.floor(points.length / 6)) },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 8, formatter: (v) => `${v}亿` },
      splitLine: { lineStyle: { color: C.split } },
    },
    series: [{
      type: 'line',
      data: points.map((p) => p.main),
      smooth: 0.2,
      showSymbol: false,
      lineStyle: { width: 1.5, color },
      areaStyle: {
        color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: last >= 0 ? 'rgba(255,77,94,.22)' : 'rgba(22,199,132,.22)' },
          { offset: 1, color: 'rgba(0,0,0,0)' },
        ]),
      },
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { color: 'rgba(148,163,184,.2)', type: 'dashed' },
        data: [{ yAxis: 0 }],
      },
    }],
  });
}

let sparkSeq = 0;

export function sparkline(values, color) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (nums.length < 2) return '<span class="spark"></span>';
  const id = `sg${sparkSeq += 1}`;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = 100 / (nums.length - 1);
  const pts = nums.map((v, i) => [i * step, 30 - ((v - min) / span) * 26 - 2]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
  const area = `${line} L100 32 L0 32 Z`;
  const c = color || C.accent;
  return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c}" stop-opacity=".25"/>
      <stop offset="100%" stop-color="${c}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${c}" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

export function sectorMiniChart(el, kline) {
  return candleChart(el, kline, { zoomStart: 10 });
}

/* =========================================================
   作战中心：封板节奏 / 竞价分布 / 时间轴
   ========================================================= */
export function sealHistogram(el, bins) {
  const rows = Array.isArray(bins) ? bins : [];
  if (!rows.length) {
    el.innerHTML = '<div class="empty">暂无封板数据</div>';
    return null;
  }
  return setOption(el, {
    animation: false,
    legend: {
      top: 0,
      right: 6,
      itemWidth: 9,
      itemHeight: 6,
      itemGap: 10,
      textStyle: { color: C.muted, fontSize: 9 },
      data: ['封板', '炸板'],
    },
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(56,189,248,.04)' } },
      formatter: (ps) => {
        const row = rows[ps[0] && ps[0].dataIndex];
        if (!row) return '';
        return `<div style="font-size:11px;color:#dbe7f6">${esc(row.label)}</div>
          <div style="font-size:10px;color:#9fb2c9;margin-top:3px">封板 <b style="color:${C.up};font-family:Bahnschrift">${row.sealed}</b> · 炸板 <b style="color:${C.down};font-family:Bahnschrift">${row.broken}</b></div>`;
      },
    },
    grid: { left: 32, right: 8, top: 26, bottom: 24 },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.label),
      axisLine: { lineStyle: { color: C.line } },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 8, interval: 0, rotate: rows.length > 9 ? 28 : 0 },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 8 },
      splitLine: { lineStyle: { color: C.split } },
    },
    series: [
      {
        name: '封板',
        type: 'bar',
        stack: 'seal',
        barWidth: '52%',
        data: rows.map((r) => r.sealed),
        itemStyle: { color: 'rgba(255,77,94,.82)', borderRadius: [2, 2, 0, 0] },
      },
      {
        name: '炸板',
        type: 'bar',
        stack: 'seal',
        data: rows.map((r) => r.broken),
        itemStyle: { color: 'rgba(22,199,132,.72)' },
      },
    ],
  });
}

export function auctionBars(el, buckets, total = 0) {
  const rows = (Array.isArray(buckets) ? buckets : []).filter((b) => Number(b.count) > 0);
  if (!rows.length) {
    el.innerHTML = '<div class="empty">正在扫描全市场开盘价…</div>';
    return null;
  }
  const max = Math.max(...rows.map((b) => Number(b.count) || 0), 1);
  return setOption(el, {
    animation: false,
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(56,189,248,.04)' } },
      formatter: (ps) => {
        const row = rows[ps[0] && ps[0].dataIndex];
        if (!row) return '';
        const pct = total ? ((row.count / total) * 100).toFixed(1) : '--';
        return `<div style="font-size:11px;color:#dbe7f6">开盘 ${esc(row.label)}</div><div style="font-size:10px;color:#9fb2c9;margin-top:3px">${row.count} 家 · 占比 <b style="color:${row.tone === 'up' ? C.up : row.tone === 'down' ? C.down : C.flat};font-family:Bahnschrift">${pct}%</b></div>`;
      },
    },
    grid: { left: 52, right: 38, top: 4, bottom: 4 },
    xAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category',
      data: rows.map((b) => b.label),
      inverse: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#9fb2c9', fontSize: 8 },
    },
    series: [{
      type: 'bar',
      barWidth: '56%',
      label: {
        show: true,
        position: 'right',
        color: '#9fb2c9',
        fontFamily: 'Bahnschrift',
        fontSize: 8,
        formatter: (p) => String(p.value),
      },
      data: rows.map((b) => ({
        value: b.count,
        itemStyle: {
          color: b.tone === 'up'
            ? `rgba(255,77,94,${0.35 + 0.55 * (b.count / max)})`
            : b.tone === 'down'
              ? `rgba(22,199,132,${0.3 + 0.5 * (b.count / max)})`
              : 'rgba(148,163,184,.45)',
          borderRadius: 2,
        },
      })),
    }],
  });
}

export function timelineCumulative(el, events, playhead = null) {
  const list = (Array.isArray(events) ? events : []).slice().sort((a, b) => a.min - b.min);
  if (!list.length) {
    el.innerHTML = '<div class="empty">暂无封板事件</div>';
    return null;
  }
  const series = [
    { key: 'zt', name: '涨停累计', color: C.up, kinds: new Set(['seal', 'reseal']) },
    { key: 'zb', name: '炸板累计', color: C.down, kinds: new Set(['break']) },
    { key: 'dt', name: '跌停累计', color: C.gold, kinds: new Set(['limitdown']) },
  ];
  const points = { zt: [[565, 0]], zb: [[565, 0]], dt: [[565, 0]] };
  for (const e of list) {
    for (const s of series) {
      if (!s.kinds.has(e.kind)) continue;
      const last = points[s.key][points[s.key].length - 1][1];
      points[s.key].push([Math.max(565, Math.min(900, e.min)), last + 1]);
    }
  }
  for (const s of series) {
    const last = points[s.key][points[s.key].length - 1][1];
    points[s.key].push([900, last]);
  }
  const minuteLabel = (v) => {
    const m = Math.max(565, Math.min(900, Number(v)));
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  };
  return setOption(el, {
    animation: false,
    legend: {
      top: 0,
      right: 4,
      itemWidth: 9,
      itemHeight: 2,
      itemGap: 10,
      textStyle: { color: C.muted, fontSize: 9 },
      data: series.map((s) => s.name),
    },
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: 'rgba(56,189,248,.3)' } },
      formatter: (ps) => {
        if (!ps || !ps.length) return '';
        return `<div style="font-size:10px;color:#7f8fa8">${minuteLabel(ps[0].axisValue)}</div>` +
          ps.map((p) => `<div style="font-size:10px;color:#9fb2c9;margin-top:2px">${esc(p.seriesName)} <b style="color:${p.color};font-family:Bahnschrift">${p.value[1]}</b></div>`).join('');
      },
    },
    grid: { left: 30, right: 12, top: 26, bottom: 22 },
    xAxis: {
      type: 'value',
      min: 565,
      max: 900,
      interval: 30,
      axisLine: { lineStyle: { color: C.line } },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 8, formatter: minuteLabel },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 8 },
      splitLine: { lineStyle: { color: C.split } },
    },
    series: series.map((s, i) => ({
      name: s.name,
      type: 'line',
      step: 'end',
      showSymbol: false,
      data: points[s.key],
      lineStyle: { width: 1.7, color: s.color },
      itemStyle: { color: s.color },
      areaStyle: i === 0 ? {
        color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(255,77,94,.22)' },
          { offset: 1, color: 'rgba(255,77,94,0)' },
        ]),
      } : undefined,
      markLine: i === 0 && playhead !== null && Number.isFinite(Number(playhead))
        ? {
            silent: true,
            symbol: 'none',
            label: { show: false },
            lineStyle: { color: 'rgba(56,189,248,.75)', width: 1.2, type: 'solid' },
            data: [{ xAxis: Math.max(565, Math.min(900, Number(playhead))) }],
          }
        : undefined,
    })),
  });
}

/* =========================================================
   分时图：价格线 + 均价线 + 昨收基准 + 分钟成交量
   ========================================================= */
/* A 股完整交易时段分钟标签：09:30-11:30 + 13:00-15:00（含两端，共 242 个）。
   分时图按这套标签铺 X 轴，盘中数据只填已走过的分钟，右边缘固定停在 15:00 而不是「现在几点」。 */
const CN_INTRADAY_LABELS = (() => {
  const mins = [];
  for (let t = 9 * 60 + 30; t <= 11 * 60 + 30; t += 1) mins.push(t);
  for (let t = 13 * 60; t <= 15 * 60; t += 1) mins.push(t);
  return mins.map((t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
})();
const CN_INTRADAY_MARKS = new Set(['09:30', '10:00', '10:30', '11:00', '11:30', '13:00', '13:30', '14:00', '14:30', '15:00']);

export function intradayChart(el, options = {}) {
  const candles = Array.isArray(options.candles) ? options.candles : [];
  if (!el) return null;
  if (candles.length < 2) {
    el.innerHTML = '<div class="empty">暂无当天分时数据</div>';
    return null;
  }
  const preClose = Number(options.preClose);
  const times = candles.map((c) => String(c.d).slice(11, 16));
  const prices = candles.map((c) => Number(c.c));
  const volumes = candles.map((c) => Number(c.v) || 0);
  // 完整交易时段模式（A 股指数分时）：把实际分钟点对齐到 241 个标准标签，空缺留 null，
  // 这样 X 轴总是从 09:30 铺到 15:00，盘中右边缘停在当前时刻而不是把当前时刻当成终点。
  const fullSession = Boolean(options.fullSession);
  let cumAmount = 0;
  let cumVolume = 0;
  const hasAmount = candles.some((c) => Number(c.a) > 0);
  let cumPrice = 0;
  const computedAvg = candles.map((c, i) => {
    const a = Number(c.a);
    const v = Number(c.v) || 0;
    if (Number.isFinite(a) && a > 0) cumAmount += a;
    cumVolume += v;
    cumPrice += Number(c.c);
    if (i < 1) return null;
    if (hasAmount && cumVolume && cumAmount) return cumAmount / cumVolume;
    // 指数分时常常没有成交额，用累计均价近似「均价线」。
    return cumPrice / (i + 1);
  });
  // 期货/贵金属的分时接口自带官方均价，优先用源端均价而不是近似值。
  const srcAvg = Array.isArray(options.avgLine) ? options.avgLine : null;
  const avg = srcAvg && srcAvg.length === candles.length
    ? srcAvg.map((v, i) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : computedAvg[i]))
    : computedAvg;

  // 默认（期货/美股/历史分时）：X 轴就是实际分钟点。
  let axisLabels = times;
  let priceData = prices;
  let avgData = avg;
  let volumeData = volumes.map((v, i) => ({
    value: v,
    itemStyle: { color: prices[i] >= (prices[i - 1] ?? prices[i]) ? 'rgba(255,77,94,.55)' : 'rgba(22,199,132,.55)' },
  }));
  let labelToCandle = null;
  if (fullSession) {
    labelToCandle = new Map(times.map((t, i) => [t, i]));
    axisLabels = CN_INTRADAY_LABELS;
    priceData = CN_INTRADAY_LABELS.map((lb) => {
      const i = labelToCandle.get(lb);
      return i === undefined ? null : prices[i];
    });
    avgData = CN_INTRADAY_LABELS.map((lb) => {
      const i = labelToCandle.get(lb);
      return i === undefined ? null : avg[i];
    });
    volumeData = CN_INTRADAY_LABELS.map((lb) => {
      const i = labelToCandle.get(lb);
      if (i === undefined) return { value: null };
      return {
        value: volumes[i],
        itemStyle: { color: prices[i] >= (prices[i - 1] ?? prices[i]) ? 'rgba(255,77,94,.55)' : 'rgba(22,199,132,.55)' },
      };
    });
  }
  const last = prices[prices.length - 1];
  // 没有可靠的昨收时，用当日开盘（第一根分钟线）作为基准，避免默认画成红色。
  const up = Number.isFinite(preClose) ? last >= preClose : last >= prices[0];
  const main = up ? C.up : C.down;
  const rgb = up ? '255,77,94' : '22,199,132';
  const extent = Number.isFinite(preClose) ? [...prices, preClose] : prices;
  const lo = Math.min(...extent);
  const hi = Math.max(...extent);
  const pad = (hi - lo) * 0.09 || Math.max(hi * 0.002, 0.01);
  const yMin = lo - pad;
  const yMax = hi + pad;
  const hasVolume = volumes.some((v) => v > 0);
  const pctLabel = (v) => (Number.isFinite(preClose) && preClose ? `${(((v - preClose) / preClose) * 100).toFixed(2)}%` : '');

  return setOption(el, {
    animation: false,
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: 'rgba(56,189,248,.3)' } },
      formatter: (ps) => {
        const i = ps[0] && ps[0].dataIndex;
        const lb = axisLabels[i];
        const ci = labelToCandle ? labelToCandle.get(lb) : i;
        const c = ci === undefined ? null : candles[ci];
        if (!c) return `<div style="color:#7f8fa8;font-size:10px">${esc(lb || '')}</div><div style="font-size:10px;color:#5e6d84">该分钟暂无数据（交易时段未到）</div>`;
        const pct = Number.isFinite(preClose) && preClose ? ((Number(c.c) - preClose) / preClose) * 100 : null;
        const avgNow = avg[ci];
        return `<div style="color:#7f8fa8;font-size:10px;margin-bottom:3px">${esc(lb || times[ci])}</div>
          <div style="font-size:10px;color:#9fb2c9">价格 <b style="color:${main};font-family:Bahnschrift">${Number(c.c).toFixed(2)}</b>${pct === null ? '' : ` <b style="color:${main}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b>`}</div>
          ${avgNow ? `<div style="font-size:10px;color:#9fb2c9">均价 <b style="color:#f5c451;font-family:Bahnschrift">${Number(avgNow).toFixed(2)}</b></div>` : ''}
          <div style="font-size:10px;color:#7f8fa8">成交 <b style="color:#dbe7f6">${(Number(c.v) / 1e4).toFixed(0)} 万</b></div>`;
      },
    },
    grid: hasVolume
      ? [{ left: 52, right: 56, top: 12, height: '62%' }, { left: 52, right: 56, top: '78%', height: '16%' }]
      : [{ left: 52, right: 56, top: 12, height: '76%' }],
    xAxis: hasVolume
      ? [
          { type: 'category', data: axisLabels, boundaryGap: false, axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false }, axisLabel: fullSession ? { color: C.muted, fontSize: 9, interval: 0, formatter: (v) => (CN_INTRADAY_MARKS.has(v) ? v : '') } : { color: C.muted, fontSize: 9, interval: Math.max(1, Math.floor(times.length / 7)), hideOverlap: true }, splitLine: { show: false } },
          { type: 'category', data: axisLabels, gridIndex: 1, boundaryGap: false, axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false }, axisLabel: { show: false }, splitLine: { show: false } },
        ]
      : [{ type: 'category', data: axisLabels, boundaryGap: false, axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false }, axisLabel: fullSession ? { color: C.muted, fontSize: 9, interval: 0, formatter: (v) => (CN_INTRADAY_MARKS.has(v) ? v : '') } : { color: C.muted, fontSize: 9, interval: Math.max(1, Math.floor(times.length / 7)), hideOverlap: true }, splitLine: { show: false } }],
    yAxis: hasVolume
      ? [
          { min: yMin, max: yMax, scale: false, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.muted, fontSize: 9, formatter: (v) => Number(v).toFixed(2) }, splitLine: { lineStyle: { color: C.split } } },
          { min: yMin, max: yMax, position: 'right', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.muted, fontSize: 8, formatter: pctLabel }, splitLine: { show: false } },
          { gridIndex: 1, scale: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.muted, fontSize: 8, formatter: (v) => (v >= 1e4 ? `${(v / 1e4).toFixed(0)}万` : `${Math.round(v)}`) }, splitLine: { show: false } },
        ]
      : [
          { min: yMin, max: yMax, scale: false, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.muted, fontSize: 9, formatter: (v) => Number(v).toFixed(2) }, splitLine: { lineStyle: { color: C.split } } },
          { min: yMin, max: yMax, position: 'right', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.muted, fontSize: 8, formatter: pctLabel }, splitLine: { show: false } },
        ],
    series: [
      {
        name: '价格',
        type: 'line',
        data: priceData,
        connectNulls: true,
        showSymbol: false,
        smooth: false,
        lineStyle: { width: 1.6, color: main },
        itemStyle: { color: main },
        areaStyle: {
          color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: `rgba(${rgb},.26)` },
            { offset: 1, color: `rgba(${rgb},0)` },
          ]),
        },
        markLine: Number.isFinite(preClose) && preClose
          ? {
              silent: true,
              symbol: 'none',
              label: { show: true, position: 'insideEndTop', formatter: `昨收 ${preClose.toFixed(2)}`, color: C.muted, fontSize: 8 },
              lineStyle: { color: 'rgba(148,163,184,.55)', width: 1, type: 'dashed' },
              data: [{ yAxis: preClose }],
            }
          : undefined,
      },
      {
        name: '均价',
        type: 'line',
        data: avgData,
        showSymbol: false,
        smooth: true,
        connectNulls: true,
        lineStyle: { width: 1.1, color: '#f5c451', opacity: 0.9 },
        itemStyle: { color: '#f5c451' },
      },
      ...(hasVolume
        ? [{
            name: '成交量',
            type: 'bar',
            xAxisIndex: 1,
            yAxisIndex: 2,
            barWidth: '60%',
            data: volumeData,
          }]
        : []),
    ],
  });
}

/* =========================================================
   美股迷你分时（10 只热门股卡片）
   points: [[ 'HH:MM', price ], ...]
   ========================================================= */
export function usMiniChart(el, points, options = {}) {
  const list = (Array.isArray(points) ? points : []).filter((p) => Array.isArray(p) && Number.isFinite(Number(p[1])));
  if (!el) return null;
  if (list.length < 2) {
    el.innerHTML = '<div class="umi-empty">该时段暂无成交</div>';
    return null;
  }
  const preClose = Number(options.preClose);
  const base = Number.isFinite(preClose) && preClose > 0 ? preClose : Number(list[0][1]);
  const up = Number(list[list.length - 1][1]) >= base;
  const color = up ? C.up : C.down;
  const rgb = up ? '255,77,94' : '22,199,132';
  const values = list.map((p) => Number(p[1]));
  const times = list.map((p) => p[0]);
  return setOption(el, {
    animation: false,
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: 'rgba(56,189,248,.3)' } },
      formatter: (ps) => {
        const i = ps[0] && ps[0].dataIndex;
        if (i == null) return '';
        const pct = base ? ((values[i] - base) / base) * 100 : 0;
        return `<div style="font-size:10px;color:#7f8fa8">${esc(times[i])} 美东</div><div style="font-size:11px;color:${color};font-family:Bahnschrift">${values[i].toFixed(2)} <span style="font-size:10px">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span></div>`;
      },
    },
    grid: { left: 4, right: 4, top: 6, bottom: 4 },
    xAxis: { type: 'category', data: times, boundaryGap: false, show: false },
    yAxis: { type: 'value', scale: true, show: false, min: (v) => v.min - (v.max - v.min) * 0.15, max: (v) => v.max + (v.max - v.min) * 0.15 },
    series: [{
      type: 'line',
      data: values,
      showSymbol: false,
      smooth: true,
      lineStyle: { width: 1.3, color },
      itemStyle: { color },
      areaStyle: {
        color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: `rgba(${rgb},.3)` },
          { offset: 1, color: `rgba(${rgb},0)` },
        ]),
      },
      markLine: Number.isFinite(preClose) && preClose > 0
        ? { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: 'rgba(148,163,184,.4)', width: 1, type: 'dashed' }, data: [{ yAxis: preClose }] }
        : undefined,
    }],
  });
}

/* =========================================================
   板块资金：本期 vs 上期 对比（TOP10 流入 / 流出）
   data: { inflow: [{name,current,previous}], outflow: [...], currentLabel, previousLabel }
   ========================================================= */
export function sectorCompareBar(el, data, options = {}) {
  const inflow = (data && data.inflow ? data.inflow : []).filter((x) => Number.isFinite(Number(x.current)));
  const outflow = (data && data.outflow ? data.outflow : []).filter((x) => Number.isFinite(Number(x.current)));
  const rows = [...inflow, ...outflow];
  if (!el) return null;
  if (!rows.length) {
    el.innerHTML = '<div class="empty">暂无可对比的历史资金数据</div>';
    return null;
  }
  const names = rows.map((x) => (x.name && x.name.length > 8 ? `${x.name.slice(0, 8)}…` : x.name || ''));
  const currentLabel = data.currentLabel || options.currentLabel || '本期';
  const previousLabel = data.previousLabel || options.previousLabel || '上期';
  return setOption(el, {
    animation: false,
    legend: { top: 0, right: 8, itemWidth: 10, itemHeight: 3, textStyle: { color: C.muted, fontSize: 9 } },
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(56,189,248,.05)' } },
      formatter: (ps) => {
        const row = rows[ps[0].dataIndex];
        const fmt = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '--' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)} 亿`);
        return `<div style="font-size:11px;color:#dbe7f6">${esc(row.name)}</div>
          <div style="font-size:10px;color:#9fb2c9;margin-top:3px">${esc(currentLabel)} <b style="color:${row.current >= 0 ? C.up : C.down};font-family:Bahnschrift">${fmt(row.current)}</b></div>
          <div style="font-size:10px;color:#9fb2c9">${esc(previousLabel)} <b style="color:#94a3b8;font-family:Bahnschrift">${fmt(row.previous)}</b></div>`;
      },
    },
    grid: { left: 92, right: 46, top: 18, bottom: 6 },
    xAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.muted, fontSize: 8, formatter: (v) => `${v}亿` }, splitLine: { lineStyle: { color: C.split } } },
    yAxis: { type: 'category', data: names, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#9fb2c9', fontSize: 9 } },
    series: [
      {
        name: currentLabel,
        type: 'bar',
        barWidth: 7,
        itemStyle: { color: 'rgba(255,77,94,.8)' },
        data: rows.map((x) => ({ value: Number(x.current), itemStyle: { color: Number(x.current) >= 0 ? 'rgba(255,77,94,.8)' : 'rgba(22,199,132,.8)', borderRadius: 3 } })),
      },
      {
        name: previousLabel,
        type: 'bar',
        barWidth: 7,
        itemStyle: { color: 'rgba(148,163,184,.5)' },
        data: rows.map((x) => ({ value: Number.isFinite(Number(x.previous)) ? Number(x.previous) : null, itemStyle: { color: 'rgba(148,163,184,.5)', borderRadius: 3 } })),
      },
    ],
  });
}

/* =========================================================
   美股板块资金：横向条形图
   ========================================================= */
export function usSectorFlowBar(el, items) {
  const list = (Array.isArray(items) ? items : []).filter((x) => Number.isFinite(Number(x.flowYi)));
  if (!el) return null;
  if (!list.length) {
    el.innerHTML = '<div class="empty">暂无美股板块资金</div>';
    return null;
  }
  const sorted = [...list].sort((a, b) => b.flowYi - a.flowYi);
  return setOption(el, {
    animation: false,
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(56,189,248,.05)' } },
      formatter: (ps) => {
        const row = sorted[ps[0].dataIndex];
        return `<div style="font-size:11px;color:#dbe7f6">${esc(row.name)}</div>
          <div style="font-size:10px;color:#9fb2c9;margin-top:3px">资金流估算 <b style="color:${row.flowYi >= 0 ? C.up : C.down};font-family:Bahnschrift">${row.flowYi >= 0 ? '+' : ''}${Number(row.flowYi).toFixed(2)} 亿</b></div>
          <div style="font-size:10px;color:#9fb2c9">板块涨跌 <b style="color:${row.pct >= 0 ? C.up : C.down}">${row.pct >= 0 ? '+' : ''}${Number(row.pct).toFixed(2)}%</b> · 成交额 ${Number(row.amountYi).toFixed(0)} 亿</div>
          <div style="font-size:10px;color:#7f8fa8">${row.up} 涨 / ${row.down} 跌 / 共 ${row.count} 只</div>`;
      },
    },
    grid: { left: 76, right: 56, top: 4, bottom: 4 },
    xAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.muted, fontSize: 8, formatter: (v) => `${v}亿` }, splitLine: { lineStyle: { color: C.split } } },
    yAxis: { type: 'category', data: sorted.map((x) => x.name), inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#9fb2c9', fontSize: 9 } },
    series: [{
      type: 'bar',
      barWidth: 10,
      data: sorted.map((x) => ({
        value: Number(x.flowYi),
        itemStyle: { color: x.flowYi >= 0 ? 'rgba(255,77,94,.75)' : 'rgba(22,199,132,.75)', borderRadius: 3 },
      })),
      label: {
        show: true,
        position: 'right',
        formatter: (p) => `${Number(p.value) >= 0 ? '+' : ''}${Number(p.value).toFixed(1)}`,
        color: C.muted,
        fontFamily: 'Bahnschrift',
        fontSize: 8,
      },
    }],
  });
}

/* =========================================================
   美股详情：整幅分时图（04:00–20:00 延时交易全时段）
   points: [[ 'HH:MM', price ], ...]，来自 /api/us/minutes 的 pre/regular/post 拼接
   options: { preClose, segments: [{ label, time }] } 用竖线标出 09:30 / 16:00 分界
   ========================================================= */
export function usIntradayChart(el, points, options = {}) {
  const list = (Array.isArray(points) ? points : []).filter((p) => Array.isArray(p) && Number.isFinite(Number(p[1])));
  if (!el) return null;
  if (list.length < 2) {
    el.innerHTML = '<div class="empty">该时段暂无成交数据</div>';
    return null;
  }
  const preClose = Number(options.preClose);
  const base = Number.isFinite(preClose) && preClose > 0 ? preClose : Number(list[0][1]);
  const times = list.map((p) => p[0]);
  const values = list.map((p) => Number(p[1]));
  const last = values[values.length - 1];
  const up = last >= base;
  const color = up ? C.up : C.down;
  const rgb = up ? '255,77,94' : '22,199,132';

  // 左右两轴按同一价格区间换算，右轴显示相对昨收的百分比
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = Math.max(rawMax - rawMin, base * 0.001, 0.01);
  const pad = span * 0.16;
  const yMin = Math.min(rawMin, base) - pad;
  const yMax = Math.max(rawMax, base) + pad;
  const pctOf = (v) => (base ? ((v - base) / base) * 100 : 0);

  // 09:30 / 16:00 两条分界线，标出盘前 | 盘中 | 盘后
  const segmentLines = (options.segments || [
    { time: '09:30', label: '开盘' },
    { time: '16:00', label: '收盘' },
  ]).filter((s) => times.includes(s.time)).map((s) => ({
    xAxis: s.time,
    lineStyle: { color: 'rgba(148,163,184,.35)', width: 1, type: 'dashed' },
    label: { formatter: s.label, color: C.muted, fontSize: 8, position: 'start' },
  }));

  return setOption(el, {
    animation: false,
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'cross', lineStyle: { color: 'rgba(56,189,248,.28)' }, crossStyle: { color: 'rgba(56,189,248,.28)' } },
      formatter: (ps) => {
        const p = ps[0];
        if (!p) return '';
        const i = p.dataIndex;
        const diff = values[i] - base;
        const tone = diff >= 0 ? C.up : C.down;
        return `<div style="color:#7f8fa8;font-size:10px;margin-bottom:3px">${esc(times[i])} 美东</div>
          <div style="font-family:Bahnschrift;font-size:15px;color:${tone}">${values[i].toFixed(2)}
            <span style="font-size:10px">${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${diff >= 0 ? '+' : ''}${pctOf(values[i]).toFixed(2)}%)</span>
          </div>
          <div style="color:#7f8fa8;font-size:9px;margin-top:2px">昨收 ${base.toFixed(2)}</div>`;
      },
    },
    grid: { left: 52, right: 56, top: 18, bottom: 26 },
    xAxis: {
      type: 'category',
      data: times,
      boundaryGap: false,
      axisLine: { lineStyle: { color: C.line } },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 9, hideOverlap: true, interval: Math.max(1, Math.floor(times.length / 8)) },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        scale: true,
        min: yMin,
        max: yMax,
        position: 'left',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.muted, fontSize: 9, formatter: (v) => Number(v).toFixed(2) },
        splitLine: { lineStyle: { color: C.split } },
      },
      {
        type: 'value',
        min: pctOf(yMin),
        max: pctOf(yMax),
        position: 'right',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: C.muted, fontSize: 9, formatter: (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%` },
        splitLine: { show: false },
      },
    ],
    series: [{
      name: '价格',
      type: 'line',
      data: values,
      smooth: false,
      showSymbol: false,
      lineStyle: { width: 1.6, color },
      itemStyle: { color },
      areaStyle: {
        color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: `rgba(${rgb},.26)` },
          { offset: 1, color: `rgba(${rgb},0)` },
        ]),
      },
      markLine: {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: 'rgba(148,163,184,.45)', width: 1, type: 'dashed' },
        data: [{ yAxis: base }, ...segmentLines],
      },
    }],
  });
}

export { C as COLORS };
