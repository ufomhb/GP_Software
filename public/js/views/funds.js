/* 基金页渲染（P2 从 app.js 抽出，第一个按视图拆的模块）
   只负责把 state 里的数据渲染成 DOM；数据加载与交互仍留在 app.js。
   依赖：core.js（state）、util.js（格式化/转义）、dom.js（$）。 */
import { state } from '../core.js?v=2.6.0';
import { isNum, nf, priceFmt, pctFmt, signedFmt, yiFmt, toneClass, cleanName, esc } from '../util.js?v=2.6.0';
import { $ } from '../dom.js?v=2.6.0';


function fundCategoryOf(name = '') {
  const s = String(name);
  if (/债|货币|现金|短融|存单|利率/.test(s)) return 'bond';
  if (/黄金|白银|有色|商品|原油|豆粕|能源化工/.test(s)) return 'gold';
  if (/纳指|纳斯达克|标普|道琼斯|恒生|港股|日经|德国|法国|美国|中概|海外|全球/.test(s)) return 'overseas';
  if (/沪深300|中证500|中证1000|中证A500|上证50|创业板|科创|宽基|全指|MSCI|A50/.test(s)) return 'broad';
  if (/医药|医疗|消费|白酒|食品|半导体|芯片|军工|新能源|光伏|证券|银行|地产|红利|人工智能|AI|机器人|通信|计算机|传媒|农业|化工|煤炭|钢铁|汽车|电力|环保|建材|旅游|游戏|云计算|大数据|创新药|科技/.test(s)) return 'sector';
  return 'mixed';
}

function getFundHolding(code) {
  const h = state.fundHoldings && state.fundHoldings[String(code)];
  if (!h) return null;
  const shares = Number(h.shares);
  const cost = Number(h.cost);
  if (!Number.isFinite(shares) || shares <= 0) return null;
  return { shares, cost: Number.isFinite(cost) && cost > 0 ? cost : null };
}

function fundHoldingRow(x) {
  const h = getFundHolding(x.code);
  if (!h) return { shares: null, marketValue: null, profit: null, profitPct: null, dayProfit: null, dayPending: false, pctDate: '' };
  const price = Number(x.price);
  const cost = h.cost;
  const marketValue = Number.isFinite(price) ? price * h.shares : null;
  const costValue = cost ? cost * h.shares : null;
  const profit = marketValue !== null && costValue !== null ? marketValue - costValue : null;
  const profitPct = profit !== null && costValue ? (profit / costValue) * 100 : null;
  // 当日盈亏只认「今天」的涨跌口径：昨天净值、未更新的，一律不给数，标成待更新。
  const fresh = !x.pctStale && x.pctKind !== 'stale' && isNum(x.pct);
  const dayProfit = marketValue !== null && fresh ? (marketValue * Number(x.pct)) / (100 + Number(x.pct)) : null;
  return {
    shares: h.shares,
    cost,
    marketValue,
    profit,
    profitPct,
    dayProfit,
    dayPending: !fresh,
    pctDate: fresh ? (x.pctDate || x.date || '') : (x.navDate || x.date || ''),
    navPct: isNum(x.navPct) ? Number(x.navPct) : null,
  };
}

function fundPortfolio() {
  const items = (state.fundWatchData && state.fundWatchData.items) || [];
  let marketValue = 0;
  let costValue = 0;
  let dayProfit = 0;
  let dayValue = 0;
  let counted = 0;
  let pending = 0;
  let fresh = 0;
  for (const x of items) {
    const r = fundHoldingRow(x);
    if (r.marketValue === null) continue;
    counted += 1;
    marketValue += r.marketValue;
    if (r.profit !== null && r.cost) costValue += r.cost * r.shares;
    if (r.dayPending) pending += 1;
    if (r.dayProfit !== null) {
      dayProfit += r.dayProfit;
      dayValue += r.marketValue;
      fresh += 1;
    }
  }
  return {
    counted,
    marketValue,
    costValue,
    profit: counted ? marketValue - costValue : null,
    profitPct: costValue > 0 ? ((marketValue - costValue) / costValue) * 100 : null,
    dayProfit: fresh ? dayProfit : null,
    dayPct: dayValue > 0 ? (dayProfit / dayValue) * 100 : null,
    dayFresh: fresh,
    dayPending: pending,
  };
}

/* 「当日涨跌」列 = 真实净值涨跌幅（不是估值）。
   口径（2026-11-17 按用户要求改）：只要有一期准确净值就填上；
   只有「今天是交易日、已过 15:00、今天净值还没出」时才留 --，不拿昨天的涨跌冒充今天。
   显示最近一期净值时，副标题写「最新净值 · 日期」，一眼能看出不是今天。 */
function fundDayPctCell(x) {
  const type = x.type || 'open';
  if (type === 'etf' || x.pctKind === 'market') {
    return `${pctFmt(x.pct)}<div class="t-sub">场内实时</div>`;
  }
  const pct = isNum(x.navPctShow) ? x.navPctShow : x.navPctToday;
  const showDate = String(x.navPctShowDate || x.navDate || x.date || '').slice(5);
  const isToday = x.navPctIsToday === true
    || (x.navPctIsToday === undefined && isNum(x.navPctToday));
  if (isNum(pct)) {
    const lagging = x.navPctLagging === true;
    let tip;
    if (isToday) {
      tip = `今天已公布的净值涨跌幅${showDate ? `（净值日 ${showDate}）` : ''}`;
    } else if (lagging) {
      tip = `该基金净值公布有滞后（如 QDII / 境外市场基金），今天还拿不到当日净值，显示最近一期已公布的净值涨跌幅${showDate ? `（净值日 ${showDate}）` : ''}`;
    } else {
      tip = `今天还没到 15:00 收盘（或今天休市），显示最近一期已公布的净值涨跌幅${showDate ? `（净值日 ${showDate}）` : ''}`;
    }
    const sub = isToday
      ? (showDate ? `今日净值 · ${showDate}` : '今日净值')
      : (showDate ? `最新净值 · ${showDate}` : '最新净值');
    return `<span class="${toneClass(pct)}" title="${esc(tip)}">${pctFmt(pct)}</span><div class="t-sub">${esc(sub)}</div>`;
  }
  const navDate = showDate;
  const tip = `今天是交易日且已过 15:00，今日净值尚未公布${navDate ? `，最新净值日 ${navDate}` : ''}；预估涨跌幅见「当日估值」列`;
  return `<span class="muted" title="${esc(tip)}">--</span><div class="t-sub">${esc(`当日未出${navDate ? ` · ${navDate}` : ''}`)}</div>`;
}

/* 「当日估值」列 = 预估涨跌幅：15:00 收盘时的最终估值，冻结后不随净值公布而改变，
   这样才能和「当日涨跌」的真实净值对比，看估值准不准。
   注意：估值必须与「今日净值是否已出」无关——净值一公布就清空估值，两列就没法对比了。 */
function fundEstimateCell(x) {
  const type = x.type || 'open';
  if (type === 'etf' || x.pctKind === 'market') {
    return '<span class="muted">--</span><div class="t-sub">场内无估值</div>';
  }
  if (isNum(x.estimatePct)) {
    const hm = x.estimateAt ? String(x.estimateAt).slice(11, 16) : '';
    const frozen = x.estimateFrozen === true;
    const kindText = x.estimateKind === 'etf'
      ? '目标 ETF 场内涨跌穿透'
      : x.estimateKind === 'holdings'
        ? '前十大重仓涨跌穿透加权'
        : '天天基金官方盘中估值';
    let tip = frozen
      ? `15:00 收盘估值（来源：${kindText}；已冻结，不会因为晚上的准确净值而改动）${hm ? `　取值时刻 ${hm}` : ''}`
      : `盘中估值（来源：${kindText}）；还没到 15:00，仍会变动，15:00 后冻结成当日估值`;
    let diff = null;
    if (isNum(x.navPctToday)) {
      diff = Number(x.estimatePct) - Number(x.navPctToday);
      tip += `；与今日净值（${pctFmt(x.navPctToday)}）的偏差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} 个百分点`;
    }
    const sub = frozen ? '15:00 估值' : `盘中估值${hm ? ` ${hm}` : ''}`;
    const diffLine = diff === null
      ? ''
      : `<div class="t-sub ${diff >= 0 ? 'tone-up' : 'tone-down'}">差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp</div>`;
    return `<span class="${toneClass(x.estimatePct)}" title="${esc(tip)}">${pctFmt(x.estimatePct)}</span><div class="t-sub">${esc(sub)}</div>${diffLine}`;
  }
  // 没有独立估值时，用场内穿透估算兜底，但明确标出口径。
  if (x.pctKind === 'etf' || x.pctKind === 'holdings') {
    return `<span class="${toneClass(x.pct)}">${pctFmt(x.pct)}</span><div class="t-sub">穿透估算</div>`;
  }
  return '<span class="muted">--</span><div class="t-sub">暂无估值</div>';
}

function fundPctCell(x) {
  const stale = x.pctStale || x.pctKind === 'stale' || !isNum(x.pct);
  const kindLabel = x.pctLabel || '';
  const shortDate = (d) => (d ? String(d).slice(5) : '');
  if (stale) {
    const navDate = shortDate(x.navDate || x.date);
    const full = isNum(x.navPct)
      ? `当日涨跌未出，最新 ${navDate} 净值 ${Number(x.navPct) > 0 ? '+' : ''}${Number(x.navPct).toFixed(2)}%`
      : '当日涨跌未出';
    return `<span class="muted" title="${esc(full)}">--</span><div class="t-sub">${esc(`当日未出${navDate ? ` · ${navDate}` : ''}`)}</div>`;
  }
  const sub = x.pctKind === 'holdings' || x.pctKind === 'etf'
    ? `${kindLabel} · ${shortDate(x.pctDate || x.date)}`
    : kindLabel;
  return `${pctFmt(x.pct)}${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}`;
}

function renderFundSummary() {
  const el = $('#fundSummary');
  if (!el) return;
  const f = state.fundFlow;
  if (!f) {
    el.innerHTML = Array.from({ length: 4 }).map(() => '<div class="summary-card"><div class="sc-label">加载中</div><div class="sc-value">--</div></div>').join('');
    return;
  }
  if (f.unavailable) {
    el.innerHTML = Array.from({ length: 4 }).map(() => '<div class="summary-card"><div class="sc-label">ETF 资金流</div><div class="sc-value">不可用</div><div class="sc-sub">需东方财富接口</div></div>').join('');
    return;
  }
  const topIn = f.topInflow || [...(f.items || [])].sort((a, b) => b.mainYi - a.mainYi)[0];
  const topOut = f.topOutflow || [...(f.items || [])].sort((a, b) => a.mainYi - b.mainYi)[0];
  el.innerHTML = `
    <div class="summary-card"><div class="sc-label">ETF 样本主力净流入</div><div class="sc-value ${toneClass(f.totalNet)}">${yiFmt(f.totalNet)}</div><div class="sc-sub">${f.universe} 只样本 · ${f.date || '--'}</div></div>
    <div class="summary-card"><div class="sc-label">净流入 / 净流出</div><div class="sc-value"><span class="tone-up">${f.inflowCount}</span> <span class="muted">/</span> <span class="tone-down">${f.outflowCount}</span></div><div class="sc-sub">ETF 数量对比</div></div>
    <div class="summary-card"><div class="sc-label">资金最强</div><div class="sc-value">${esc(topIn ? topIn.name : '--')}</div><div class="sc-sub ${topIn ? toneClass(topIn.mainYi) : ''}">${topIn ? yiFmt(topIn.mainYi) : '--'}</div></div>
    <div class="summary-card"><div class="sc-label">资金最弱</div><div class="sc-value">${esc(topOut ? topOut.name : '--')}</div><div class="sc-sub ${topOut ? toneClass(topOut.mainYi) : ''}">${topOut ? yiFmt(topOut.mainYi) : '--'}</div></div>`;
}

function renderFundWatchSummary() {
  const el = $('#fundWatchSummary');
  if (!el) return;
  const items = (state.fundWatchData && state.fundWatchData.items) || [];
  if (!items.length) {
    el.innerHTML = Array.from({ length: 3 }).map(() => '<div class="summary-card"><div class="sc-label">自选基金</div><div class="sc-value">--</div></div>').join('');
    return;
  }
  const fresh = items.filter((x) => !x.pctStale && x.pctKind !== 'stale' && isNum(x.pct));
  const pending = items.length - fresh.length;
  const avg = fresh.length ? fresh.reduce((s, x) => s + Number(x.pct), 0) / fresh.length : null;
  const etfNet = items.filter((x) => x.type === 'etf').reduce((s, x) => s + (Number(x.mainYi) || 0), 0);
  const best = [...fresh].sort((a, b) => Number(b.pct) - Number(a.pct))[0];
  el.innerHTML = `
    <div class="summary-card"><div class="sc-label">自选基金数量</div><div class="sc-value">${items.length}</div><div class="sc-sub">ETF + 场外基金</div></div>
    <div class="summary-card"><div class="sc-label">平均日涨跌</div><div class="sc-value ${avg === null ? '' : toneClass(avg)}">${avg === null ? '--' : pctFmt(avg)}</div><div class="sc-sub">${fresh.length}/${items.length} 只有当日口径${pending ? ` · ${pending} 只未更新` : ''}</div></div>
    <div class="summary-card"><div class="sc-label">ETF 资金净流入</div><div class="sc-value ${toneClass(etfNet)}">${yiFmt(etfNet)}</div><div class="sc-sub">仅 ETF 口径</div></div>
    <div class="summary-card"><div class="sc-label">表现最好</div><div class="sc-value">${esc(best ? cleanName(best.name || state.fundWatchlist.find((f) => f.code === best.code)?.name) : '--')}</div><div class="sc-sub ${best ? toneClass(best.pct) : ''}">${best ? pctFmt(best.pct) : '当日数据未出'}</div></div>`;
}

function renderFundWatchTable() {
  const el = $('#fundWatchTable');
  if (!el) return;
  if ($('#fundWatchCount')) $('#fundWatchCount').textContent = `${state.fundWatchlist.length} 只`;
  if (!state.fundWatchlist.length) {
    el.innerHTML = '<div class="empty">还没有自选基金。在上方搜索基金代码或名称，加入自选后可查看 ETF 资金流或场外基金净值。</div>';
    return;
  }
  const items = (state.fundWatchData && state.fundWatchData.items) || [];
  if (!items.length) {
    el.innerHTML = '<div class="empty">正在加载自选基金…</div>';
    return;
  }
  const order = new Map(state.fundWatchlist.map((f, i) => [f.code, i]));
  const meta = new Map(state.fundWatchlist.map((f) => [f.code, f]));
  const sorted = [...items].sort((a, b) => (order.get(a.code) ?? 999) - (order.get(b.code) ?? 999));
  el.innerHTML = `
    <div class="table-scroll"><table class="table fund-watch-table">
      <thead><tr><th>基金</th><th data-col="type">类型</th><th data-col="nav">最新</th><th title="真实净值涨跌幅：今日净值已出就显示今日；未出则显示最近一期已公布净值（QDII 等滞后披露的基金同样回退显示）；只有普通基金在交易日 15:00 后等当日净值时才显示 --">当日涨跌</th><th data-col="est" title="15:00 收盘时的预估涨跌幅，冻结后不随准确净值改动；今日净值公布后仍保留，便于与当日涨跌对比">当日估值</th><th data-col="flow">主力净流入</th><th data-col="mv">持有市值</th><th>持有收益</th><th data-col="score">技术评分</th><th data-col="rating">评级 / 仓位</th><th>操作</th></tr></thead>
      <tbody>${sorted.map((x) => {
        const m = meta.get(x.code) || {};
        const type = x.type || m.type || 'open';
        const name = m.name || x.name || x.code;
        const av = x.advice;
        const hr = fundHoldingRow(x);
        return `<tr data-fund-code="${esc(x.code)}" data-fund-name="${esc(cleanName(name))}" data-fund-type="${esc(type)}">
          <td><span class="t-name">${esc(cleanName(name))}</span><span class="t-code">${esc(x.code)}</span></td>
          <td data-col="type"><span class="fund-tag ${type}">${type === 'etf' ? 'ETF' : '场外'}</span></td>
          <td data-col="nav" class="t-price">${priceFmt(x.price)}${x.pctKind === 'holdings' || x.pctKind === 'etf' ? '<div class="t-sub">估算净值</div>' : ''}</td>
          <td class="t-chg ${toneClass(x.navPctShow ?? x.navPctToday ?? (type === 'etf' ? x.pct : null))}">${fundDayPctCell(x)}</td>
          <td data-col="est" class="t-chg">${fundEstimateCell(x)}</td>
          <td data-col="flow" class="t-chg ${toneClass(x.mainYi)}">${type === 'etf' ? yiFmt(x.mainYi) : '--'}</td>
          <td data-col="mv" class="t-price">${hr.marketValue === null ? '<span class="muted">--</span>' : nf(hr.marketValue, 2)}</td>
          <td class="t-chg ${toneClass(hr.profit)}">${hr.profit === null ? '<span class="muted">--</span>' : `${signedFmt(hr.profit, 2)}<div class="t-sub">${isNum(hr.profitPct) ? `${hr.profitPct >= 0 ? '+' : ''}${Number(hr.profitPct).toFixed(2)}%` : ''}</div>`}</td>
          <td data-col="score" class="t-price ${av && av.score >= 60 ? 'tone-up' : av && av.score < 45 ? 'tone-down' : ''}">${av ? av.score : '--'}</td>
          <td data-col="rating">${av ? `<span class="badge tone-${av.rating.tone}">${esc(av.rating.label)}</span><div class="t-sub">${esc(av.position.text)}</div>` : '--'}</td>
          <td><div class="fund-watch-actions">
            <button data-fund-action="hold" data-code="${esc(x.code)}" data-name="${esc(cleanName(name))}" title="录入持仓">仓</button>
            <button data-fund-action="detail" data-code="${esc(x.code)}" title="查看详情">K</button>
            <button data-fund-action="up" data-code="${esc(x.code)}" title="上移">↑</button>
            <button data-fund-action="down" data-code="${esc(x.code)}" title="下移">↓</button>
            <button class="del" data-fund-action="remove" data-code="${esc(x.code)}" title="移除">×</button>
          </div></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function renderFundHoldSummary() {
  const el = $('#fundHoldSummary');
  if (!el) return;
  const p = fundPortfolio();
  const items = (state.fundWatchData && state.fundWatchData.items) || [];
  const held = items.filter((x) => getFundHolding(x.code));
  if (!held.length) {
    el.innerHTML = `<div class="summary-card"><div class="sc-label">我的持仓</div><div class="sc-value">未录入</div><div class="sc-sub">在下方表格点「仓」录入份额与成本</div></div>
      <div class="summary-card"><div class="sc-label">自选基金</div><div class="sc-value">${items.length}</div><div class="sc-sub">ETF + 场外基金</div></div>`;
    return;
  }
  el.innerHTML = `
    <div class="summary-card"><div class="sc-label">持有市值</div><div class="sc-value">${nf(p.marketValue, 2)}</div><div class="sc-sub">${held.length} 只已录入份额的基金</div></div>
    <div class="summary-card"><div class="sc-label">累计收益</div><div class="sc-value ${toneClass(p.profit)}">${signedFmt(p.profit, 2)}</div><div class="sc-sub ${toneClass(p.profitPct)}">${isNum(p.profitPct) ? `${p.profitPct >= 0 ? '+' : ''}${Number(p.profitPct).toFixed(2)}%` : '需录入成本净值'}</div></div>
    <div class="summary-card"><div class="sc-label">当日盈亏</div><div class="sc-value ${toneClass(p.dayProfit)}">${p.dayProfit === null ? '--' : signedFmt(p.dayProfit, 2)}</div><div class="sc-sub">${p.dayProfit === null
      ? '当日涨跌还没出来，暂不计算'
      : `${isNum(p.dayPct) ? `${p.dayPct >= 0 ? '+' : ''}${Number(p.dayPct).toFixed(2)}%` : ''}${p.dayPending ? ` · 其中 ${p.dayPending} 只当日未出` : ''}`}</div></div>
    <div class="summary-card"><div class="sc-label">投入本金</div><div class="sc-value">${nf(p.costValue, 2)}</div><div class="sc-sub">份额 × 成本净值</div></div>`;
}

function renderFundHoldTable() {
  const el = $('#fundHoldTable');
  if (!el) return;
  const items = (state.fundWatchData && state.fundWatchData.items) || [];
  const rows = items.filter((x) => getFundHolding(x.code));
  if (!rows.length) {
    el.innerHTML = '<div class="empty">还没有录入持仓。切换「自选基金」页签，在表格里点「仓」填写份数与成本净值，就能看到持有收益、当日盈亏和组合结构。</div>';
    return;
  }
  const withR = rows.map((x) => ({ x, r: fundHoldingRow(x) })).filter((o) => o.r.marketValue !== null);
  const total = withR.reduce((s, o) => s + o.r.marketValue, 0);
  el.innerHTML = `<div class="table-scroll"><table class="table fund-hold-table">
    <thead><tr><th>基金</th><th data-col="shares">份额</th><th data-col="cost">成本净值</th><th data-col="nav">最新</th><th>市值</th><th>持有收益</th><th data-col="ret">收益率</th><th>当日盈亏</th><th data-col="weight">占比</th></tr></thead>
    <tbody>${withR.sort((a, b) => b.r.marketValue - a.r.marketValue).map(({ x, r }) => {
      const type = x.type || 'open';
      const share = total > 0 ? (r.marketValue / total) * 100 : null;
      return `<tr data-fund-code="${esc(x.code)}" data-fund-name="${esc(cleanName(x.name))}" data-fund-type="${esc(type)}">
        <td><span class="t-name">${esc(cleanName(x.name) || x.code)}</span><span class="t-code">${esc(x.code)} · <span class="fund-tag ${type}">${type === 'etf' ? 'ETF' : '场外'}</span></span></td>
        <td data-col="shares" class="t-price">${nf(r.shares, 2)}</td>
        <td data-col="cost" class="t-price">${r.cost ? nf(r.cost, 4) : '--'}</td>
        <td data-col="nav" class="t-price">${priceFmt(x.price)}${x.pctKind === 'holdings' || x.pctKind === 'etf' ? '<div class="t-sub">估算净值</div>' : ''}</td>
        <td class="t-price">${nf(r.marketValue, 2)}</td>
        <td class="t-chg ${toneClass(r.profit)}">${signedFmt(r.profit, 2)}</td>
        <td data-col="ret" class="t-chg ${toneClass(r.profitPct)}">${isNum(r.profitPct) ? `${r.profitPct >= 0 ? '+' : ''}${Number(r.profitPct).toFixed(2)}%` : '--'}</td>
        <td class="t-chg ${toneClass(r.dayProfit)}">${r.dayPending
          ? `<span class="muted" title="${esc(`当日涨跌未出，最新 ${String(r.pctDate || '').slice(5)}${r.navPct !== null ? ` 净值 ${r.navPct > 0 ? '+' : ''}${r.navPct.toFixed(2)}%` : ''}`)}">--</span><div class="t-sub">${esc(`当日未出${r.pctDate ? ` · ${String(r.pctDate).slice(5)}` : ''}`)}</div>`
          : signedFmt(r.dayProfit, 2)}</td>
        <td data-col="weight" class="t-dim">${isNum(share) ? `${share.toFixed(1)}%` : '--'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>
  <div class="fund-hold-actions"><button class="btn small" id="fundHoldExport">导出持仓 JSON</button><span class="muted small">份额与成本只保存在本机浏览器，不会上传。当日涨跌还没出的基金不给当日盈亏，避免拿昨天的净值冒充今天。</span></div>`;
}

export {
  fundCategoryOf,
  getFundHolding,
  fundHoldingRow,
  fundPortfolio,
  fundPctCell,
  fundDayPctCell,
  fundEstimateCell,
  renderFundSummary,
  renderFundWatchSummary,
  renderFundWatchTable,
  renderFundHoldSummary,
  renderFundHoldTable,
};
