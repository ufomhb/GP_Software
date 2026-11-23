/* 模拟盘自动化视图（v2.12.0）
   ---------------------------------------------------------------
   委托单 / 条件单（止盈止损）/ 网格 / 定投 / 跟单 / 持仓预警 / 复盘报告。
   只负责 state → DOM 与少量按钮回调（小操作直接走 apiPost，成功后调 opts.reload），
   账本与撮合口径全部在服务端 src/services/paper-*.js。 */
import { state } from '../core.js?v=2.13.0';
import {
  isNum, nf, signedFmt, toneClass, cleanName, esc, timeText, pctFmt,
} from '../util.js?v=2.13.0';
import { $, $$, toast } from '../dom.js?v=2.13.0';
import { apiPost } from '../api.js?v=2.13.0';
import { fundPnlAreaChart } from '../charts.js?v=2.13.0';

const ORDER_STATUS_LABEL = {
  pending: '挂单中',
  partial: '部分成交',
  filled: '已成交',
  cancelled: '已撤单',
  expired: '已失效',
  rejected: '已拒绝',
};

const CONDITION_LABEL = {
  takeProfit: '止盈（浮盈 ≥ %）',
  stopLoss: '止损（浮亏 ≥ %）',
  priceAbove: '价格 ≥',
  priceBelow: '价格 ≤',
};

const PLAN_LABEL = { grid: '网格', dca: '定投' };
const FREQ_LABEL = { daily: '每个交易日', weekly: '每周', monthly: '每月' };
const WEEKDAY_LABEL = ['', '周一', '周二', '周三', '周四', '周五'];

export function paperOrderStatusLabel(status) {
  return ORDER_STATUS_LABEL[status] || status || '--';
}

export function conditionText(c) {
  if (!c) return '';
  const v = Number(c.value);
  if (c.kind === 'takeProfit') return `浮盈 ≥ ${nf(v, 2)}%`;
  if (c.kind === 'stopLoss') return `浮亏 ≥ ${nf(Math.abs(v), 2)}%`;
  if (c.kind === 'priceAbove') return `价格 ≥ ${nf(v, 3)}`;
  if (c.kind === 'priceBelow') return `价格 ≤ ${nf(v, 3)}`;
  return String(c.kind || '');
}

function pctCell(v) {
  if (!isNum(v)) return '<span class="muted">--</span>';
  return `<span class="${toneClass(v)}">${pctFmt(v)}</span>`;
}

function sideTag(side) {
  return `<span class="tag ${side === 'buy' ? 'in' : 'out'}">${side === 'buy' ? '买' : '卖'}</span>`;
}

/* ---------------- 委托单 ---------------- */

export function renderPaperOrders() {
  const box = $('#paperOrderBody');
  if (!box) return;
  const meta = $('#paperOrderMeta');
  const paper = state.paper;
  const orders = (paper && paper.orders) || [];
  const active = orders.filter((o) => o && (o.status === 'pending' || o.status === 'partial'));
  const done = orders.filter((o) => o && !(o.status === 'pending' || o.status === 'partial'));
  if (!orders.length) {
    box.innerHTML = '<div class="empty">还没有委托记录。下「限价委托」后会出现在这里，可随时撤单。</div>';
    if (meta) meta.textContent = '没有委托';
    return;
  }
  const rows = [...active, ...done].map((o) => {
    const status = paperOrderStatusLabel(o.status);
    const isActive = o.status === 'pending' || o.status === 'partial';
    const filled = Number(o.filledShares) || 0;
    const shares = Number(o.shares) || 0;
    const progress = shares > 0 ? Math.round((filled / shares) * 100) : 0;
    return `<tr class="${isActive ? 'paper-order-active' : ''}">
      <td class="t-dim">${o.createdAt ? esc(timeText(o.createdAt)) : '--'}<div class="t-sub">${esc((o.expiresDate || '') ? `${o.expiresDate} 15:00 前有效` : '')}</div></td>
      <td><span class="t-name">${esc(cleanName(o.name) || o.code || '')}</span><span class="t-sub">${esc(o.code || '')}</span></td>
      <td>${sideTag(o.side)}</td>
      <td>${o.type === 'limit' ? `限价 ${nf(o.limitPrice, 3)}` : '市价'}<div class="t-sub">${esc(o.source === 'condition' ? '条件单' : o.source === 'grid' ? '网格' : o.source === 'dca' ? '定投' : o.source === 'follow' ? '跟单' : '手动')}</div></td>
      <td>${nf(filled, 0)} / ${nf(shares, 0)}<div class="t-sub">${progress}%</div></td>
      <td>${o.avgPrice === null || o.avgPrice === undefined ? '--' : nf(o.avgPrice, 3)}</td>
      <td><span class="badge ${isActive ? '' : 'muted'}">${esc(status)}</span>${o.lastCheck && o.lastCheck.reason && isActive ? `<div class="t-sub">${esc(o.lastCheck.reason)}</div>` : ''}${o.rejectReason ? `<div class="t-sub">${esc(o.rejectReason)}</div>` : ''}${o.cancelReason ? `<div class="t-sub">${esc(o.cancelReason)}</div>` : ''}</td>
      <td>${isActive ? `<button class="text-link" data-paper-cancel-order="${esc(o.id)}">撤单</button>` : '<span class="muted">--</span>'}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="table-scroll tall-table"><table class="table paper-order-table">
    <thead><tr><th>委托时间</th><th>标的</th><th>方向</th><th>类型 / 委托价</th><th>已成交 / 委托</th><th>成交均价</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  if (meta) {
    meta.textContent = active.length
      ? `${active.length} 笔未结 · 共 ${orders.length} 笔委托（每 60 秒自动撮合一次）`
      : `${orders.length} 笔委托 · 当前没有未结委托`;
  }
  $$('[data-paper-cancel-order]', box).forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await apiPost('/api/paper/order/cancel', { orderId: btn.dataset.paperCancelOrder });
        toast('已撤单', 'ok');
        if (state.paperReload) state.paperReload();
      } catch (err) {
        toast(`撤单失败：${err.message}`, 'err');
        btn.disabled = false;
      }
    });
  });
}

/* ---------------- 自动交易（条件单 / 网格 / 定投 / 跟单） ---------------- */

function holdingOptions(selected = '') {
  const list = (state.paper && state.paper.positions) || [];
  return list.map((p) => `<option value="${esc(p.secid)}" data-code="${esc(p.code || '')}" data-name="${esc(p.name || '')}"${p.secid === selected ? ' selected' : ''}>${esc(cleanName(p.name) || p.code || p.secid)}（${nf(p.shares, 0)} 股）</option>`).join('');
}

function conditionRow(c) {
  const active = c.status === 'active';
  return `<tr class="${active ? '' : 'is-dim'}">
    <td><span class="t-name">${esc(cleanName(c.name) || c.code || '')}</span><span class="t-sub">${esc(c.code || '')}</span></td>
    <td>${esc(conditionText(c))}</td>
    <td>${c.side === 'buy' ? '买入' : '卖出'}${c.shares > 0 ? ` ${nf(c.shares, 0)} 股` : ' 可用全部'}</td>
    <td><span class="badge ${active ? '' : 'muted'}">${active ? '监控中' : c.status === 'triggered' ? '已触发' : '已取消'}</span>${c.lastError ? `<div class="t-sub">${esc(c.lastError)}</div>` : ''}${c.lastCheck && c.lastCheck.reason && active ? `<div class="t-sub">${esc(c.lastCheck.reason)}</div>` : ''}</td>
    <td>${active ? `<button class="text-link" data-paper-cancel-cond="${esc(c.id)}">取消</button>` : `<span class="t-dim">${c.triggeredAt ? esc(timeText(c.triggeredAt)) : '--'}</span>`}</td>
  </tr>`;
}

function planRowsHtml() {
  const plans = (state.paper && state.paper.plans) || [];
  if (!plans.length) return '<tr><td colspan="6"><div class="empty small">还没有网格 / 定投计划。用下面的表单新建一个，服务端每分钟按规则自动执行。</div></td></tr>';
  return plans.map((p) => {
    const active = p.status === 'active';
    const pauseBtn = active
      ? `<button class="text-link" data-paper-plan-status="paused" data-paper-plan-id="${esc(p.id)}">暂停</button>`
      : `<button class="text-link" data-paper-plan-status="active" data-paper-plan-id="${esc(p.id)}">启用</button>`;
    const detail = p.kind === 'grid'
      ? `${nf(p.lower, 2)} ~ ${nf(p.upper, 2)} · ${nf(p.grids, 0)} 格 · 每格 ${nf(p.sharesPerGrid, 0)} 股${Number.isFinite(Number(p.gridIndex)) ? ` · 当前第 ${Number(p.gridIndex) + 1} 段` : ''}`
      : `每期 ${nf(p.amount, 0)} 元 · ${esc(FREQ_LABEL[p.freq] || p.freq)}${p.freq === 'weekly' ? `（${esc(WEEKDAY_LABEL[p.weekday] || '')}）` : ''}${p.freq === 'monthly' ? `（每月 ${nf(p.dayOfMonth, 0)} 日）` : ''} · 下次 ${esc(p.nextDateKey || '--')}`;
    return `<tr class="${active ? '' : 'is-dim'}">
      <td><span class="badge">${esc(PLAN_LABEL[p.kind] || p.kind)}</span></td>
      <td><span class="t-name">${esc(cleanName(p.name) || p.code || '')}</span><span class="t-sub">${esc(p.code || '')}</span></td>
      <td class="t-dim">${esc(detail)}</td>
      <td>${nf(p.runs, 0)} 次${p.lastAction ? `<div class="t-sub">${esc(p.lastAction)}</div>` : ''}${p.lastError ? `<div class="t-sub tone-down">${esc(p.lastError)}</div>` : ''}</td>
      <td><span class="badge ${active ? '' : 'muted'}">${active ? '运行中' : p.status === 'paused' ? '已暂停' : '已停止'}</span></td>
      <td>${pauseBtn} <button class="text-link" data-paper-plan-del="${esc(p.id)}">删除</button></td>
    </tr>`;
  }).join('');
}

function followRowsHtml() {
  const following = (state.paper && state.paper.following) || [];
  const followers = (state.paper && state.paper.followers) || [];
  const mine = following.map((f) => `<div class="paper-follow-row"><span>跟单 <b>${esc(f.target)}</b> · 比例 ${nf(Number(f.ratio) * 100, 0)}%${f.maxShares ? ` · 单笔上限 ${nf(f.maxShares, 0)} 股` : ''}</span><button class="text-link" data-paper-unfollow="${esc(f.target)}">取消跟单</button></div>`).join('');
  const who = followers.map((f) => `<div class="paper-follow-row"><span>${esc(f.target)} 在跟你的单 · 比例 ${nf(Number(f.ratio) * 100, 0)}%</span></div>`).join('');
  return `${mine || '<p class="muted small">还没有跟单别人。跟单后，对方每笔成交会按比例复制到你的账户（只复制一层，不链式扩散）。</p>'}
    <div class="modal-section-title mt8">跟我的单（${followers.length}）</div>
    ${who || '<p class="muted small">暂时没有人在跟你的单。</p>'}`;
}

function alertRowsHtml() {
  const alerts = (state.paper && state.paper.alerts) || { enabled: false, items: [] };
  const items = (alerts.items || []).map((a) => {
    const label = a.kind === 'holdingPct' ? '持仓收益率' : a.kind === 'accountPct' ? '账户收益率' : a.kind === 'pct' ? '当日涨跌幅' : '价格';
    const opText = a.op === 'below' ? '低于' : a.kind === 'holdingPct' || a.kind === 'accountPct' || a.kind === 'pct' ? '高于' : '突破';
    return `<div class="paper-follow-row"><span>${esc(a.name || a.code || '账户')} · ${label} ${opText} ${nf(a.value, 2)}${a.kind === 'priceAbove' ? '' : '%'}</span>
      ${a.active ? `<button class="text-link" data-paper-alert-del="${esc(a.id)}">删除</button>` : '<span class="badge muted">已触发</span>'}</div>`;
  }).join('');
  return `<label class="paper-toggle"><input type="checkbox" id="paperAlertEnabled"${alerts.enabled ? ' checked' : ''}> 开启持仓条件预警（关闭页面也会每 60 秒检查，命中走推送）</label>
    ${items || '<p class="muted small">还没有预警规则：止盈/止损/持仓收益率/账户收益率都能设一条。</p>'}`;
}

export function renderPaperAuto(opts = {}) {
  const box = $('#paperAutoBody');
  if (!box) return;
  const tab = ['condition', 'plan', 'follow', 'alert'].includes(state.paperAutoTab) ? state.paperAutoTab : 'condition';
  const seg = $('#paperAutoSeg');
  if (seg) [...seg.querySelectorAll('[data-paper-auto-tab]')].forEach((b) => b.classList.toggle('is-active', b.dataset.paperAutoTab === tab));
  const conditions = (state.paper && state.paper.conditions) || [];
  const positions = (state.paper && state.paper.positions) || [];
  if (!state.paper) { box.innerHTML = '<div class="empty">加载中…</div>'; return; }

  if (tab === 'condition') {
    box.innerHTML = `
      <p class="muted small">止盈 / 止损按「持仓收益率」触发，价格条件按现价触发；命中后按市价卖出（0 股 = 可用全部），服务端每分钟检查一次。</p>
      <div class="table-scroll"><table class="table paper-cond-table">
        <thead><tr><th>标的</th><th>条件</th><th>动作</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${conditions.map(conditionRow).join('') || '<tr><td colspan="5"><div class="empty small">还没有条件单。先在持仓里选一只，再填止盈/止损或价格条件。</div></td></tr>'}</tbody>
      </table></div>
      <form class="paper-auto-form mt12" id="paperCondForm" autocomplete="off">
        <label class="input-wrap"><span>标的</span><select id="paperCondSymbol">${holdingOptions() || '<option value="">先买入一只股票</option>'}</select></label>
        <label class="input-wrap"><span>条件</span><select id="paperCondKind">
          <option value="takeProfit">止盈（浮盈 ≥ X%）</option>
          <option value="stopLoss">止损（浮亏 ≥ X%）</option>
          <option value="priceAbove">价格 ≥ X 元</option>
          <option value="priceBelow">价格 ≤ X 元</option>
        </select></label>
        <label class="input-wrap"><span>触发值</span><input id="paperCondValue" type="number" min="0" step="0.01" placeholder="如 8（% ）或 1500（元）"></label>
        <label class="input-wrap"><span>股数（0=全部）</span><input id="paperCondShares" type="number" min="0" step="100" value="0"></label>
        <button class="btn small primary" type="submit">新增条件单</button>
      </form>`;
    $$('[data-paper-cancel-cond]', box).forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await apiPost('/api/paper/condition/cancel', { id: btn.dataset.paperCancelCond });
        toast('条件单已取消', 'ok');
        if (opts.reload) opts.reload();
      } catch (err) { toast(`取消失败：${err.message}`, 'err'); btn.disabled = false; }
    }));
    const form = $('#paperCondForm');
    if (form) form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const symbol = $('#paperCondSymbol');
      const opt = symbol && symbol.selectedOptions ? symbol.selectedOptions[0] : null;
      const secid = symbol ? symbol.value : '';
      if (!secid) { toast('先选一个持仓标的', 'warn'); return; }
      const body = {
        secid,
        code: opt ? opt.dataset.code || '' : '',
        name: opt ? opt.dataset.name || '' : '',
        kind: $('#paperCondKind').value,
        value: Number($('#paperCondValue').value),
        shares: Number($('#paperCondShares').value),
        side: $('#paperCondKind').value === 'priceAbove' ? 'buy' : 'sell',
      };
      if (!(body.value > 0)) { toast('触发值必须大于 0（止盈 / 止损填百分数，如 8 表示 8%）', 'warn'); return; }
      if (body.kind === 'priceAbove' || body.kind === 'priceBelow') body.side = 'sell';
      try {
        await apiPost('/api/paper/condition', body);
        toast('条件单已保存', 'ok');
        if (opts.reload) opts.reload();
      } catch (err) { toast(`保存失败：${err.message}`, 'err'); }
    });
    return;
  }

  if (tab === 'plan') {
    box.innerHTML = `
      <p class="muted small">网格：价格每跌一格买「每格股数」，每涨一格卖同样股数（一次 tick 只走一格）；定投：按周期买入固定金额，跳过周末。</p>
      <div class="table-scroll tall-table"><table class="table paper-plan-table">
        <thead><tr><th>类型</th><th>标的</th><th>规则</th><th>已执行</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${planRowsHtml()}</tbody>
      </table></div>
      <div class="paper-auto-grid mt12">
        <form class="paper-auto-form" id="paperGridForm" autocomplete="off">
          <div class="modal-section-title">新建网格</div>
          <label class="input-wrap"><span>标的</span><select id="paperGridSymbol">${holdingOptions() || '<option value="">先买入一只股票</option>'}</select></label>
          <label class="input-wrap"><span>下界</span><input id="paperGridLower" type="number" min="0" step="0.01" placeholder="如 10"></label>
          <label class="input-wrap"><span>上界</span><input id="paperGridUpper" type="number" min="0" step="0.01" placeholder="如 20"></label>
          <label class="input-wrap"><span>格数</span><input id="paperGridGrids" type="number" min="2" max="30" step="1" value="6"></label>
          <label class="input-wrap"><span>每格股数</span><input id="paperGridShares" type="number" min="100" step="100" value="100"></label>
          <button class="btn small primary" type="submit">创建网格</button>
        </form>
        <form class="paper-auto-form" id="paperDcaForm" autocomplete="off">
          <div class="modal-section-title">新建定投</div>
          <label class="input-wrap"><span>标的</span><select id="paperDcaSymbol">${holdingOptions() || '<option value="">先买入一只股票</option>'}</select></label>
          <label class="input-wrap"><span>每期金额（元，≥1000）</span><input id="paperDcaAmount" type="number" min="1000" step="1000" value="5000"></label>
          <label class="input-wrap"><span>周期</span><select id="paperDcaFreq">
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
            <option value="daily">每个交易日</option>
          </select></label>
          <label class="input-wrap"><span>周几 / 每月几号</span><input id="paperDcaDay" type="number" min="1" max="28" step="1" value="1"></label>
          <button class="btn small primary" type="submit">创建定投</button>
        </form>
      </div>`;
    $$('[data-paper-plan-status]', box).forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await apiPost('/api/paper/plan/update', { id: btn.dataset.paperPlanId, status: btn.dataset.paperPlanStatus });
        toast(btn.dataset.paperPlanStatus === 'active' ? '计划已启用' : '计划已暂停', 'ok');
        if (opts.reload) opts.reload();
      } catch (err) { toast(`操作失败：${err.message}`, 'err'); btn.disabled = false; }
    }));
    $$('[data-paper-plan-del]', box).forEach((btn) => btn.addEventListener('click', async () => {
      if (!window.confirm('确定删除这个计划？已经成交的部分不受影响。')) return;
      btn.disabled = true;
      try {
        await apiPost('/api/paper/plan/delete', { id: btn.dataset.paperPlanDel });
        toast('计划已删除', 'ok');
        if (opts.reload) opts.reload();
      } catch (err) { toast(`删除失败：${err.message}`, 'err'); btn.disabled = false; }
    }));
    const gridForm = $('#paperGridForm');
    if (gridForm) gridForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const sel = $('#paperGridSymbol');
      const opt = sel && sel.selectedOptions ? sel.selectedOptions[0] : null;
      const body = {
        kind: 'grid',
        secid: sel ? sel.value : '',
        code: opt ? opt.dataset.code || '' : '',
        name: opt ? opt.dataset.name || '' : '',
        lower: Number($('#paperGridLower').value),
        upper: Number($('#paperGridUpper').value),
        grids: Number($('#paperGridGrids').value),
        sharesPerGrid: Number($('#paperGridShares').value),
      };
      if (!body.secid) { toast('先选一个持仓标的', 'warn'); return; }
      if (!(body.lower > 0) || !(body.upper > body.lower)) { toast('下界必须小于上界', 'warn'); return; }
      if (!(body.sharesPerGrid > 0)) { toast('每格股数必须大于 0', 'warn'); return; }
      try {
        await apiPost('/api/paper/plan', body);
        toast('网格已创建', 'ok');
        if (opts.reload) opts.reload();
      } catch (err) { toast(`创建失败：${err.message}`, 'err'); }
    });
    const dcaForm = $('#paperDcaForm');
    if (dcaForm) dcaForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const sel = $('#paperDcaSymbol');
      const opt = sel && sel.selectedOptions ? sel.selectedOptions[0] : null;
      const freq = $('#paperDcaFreq').value;
      const day = Number($('#paperDcaDay').value);
      const body = {
        kind: 'dca',
        secid: sel ? sel.value : '',
        code: opt ? opt.dataset.code || '' : '',
        name: opt ? opt.dataset.name || '' : '',
        amount: Number($('#paperDcaAmount').value),
        freq,
        weekday: freq === 'weekly' ? Math.max(1, Math.min(5, day)) : 1,
        dayOfMonth: freq === 'monthly' ? Math.max(1, Math.min(28, day)) : 1,
      };
      if (!body.secid) { toast('先选一个持仓标的', 'warn'); return; }
      if (!(body.amount >= 1000)) { toast('每期金额至少 1000 元', 'warn'); return; }
      try {
        await apiPost('/api/paper/plan', body);
        toast('定投已创建', 'ok');
        if (opts.reload) opts.reload();
      } catch (err) { toast(`创建失败：${err.message}`, 'err'); }
    });
    return;
  }

  if (tab === 'follow') {
    const allowFollow = state.paper.allowFollow !== false;
    box.innerHTML = `
      <p class="muted small">跟单只复制「一层」：你跟的人成交后，按比例给你买/卖同样的标的（整手取整）；对方关闭跟单或你资金不足时，那一笔自动跳过。</p>
      ${followRowsHtml()}
      <div class="paper-auto-grid mt12">
        <form class="paper-auto-form" id="paperFollowForm" autocomplete="off">
          <div class="modal-section-title">跟单别人</div>
          <label class="input-wrap"><span>用户名</span><input id="paperFollowName" type="text" maxlength="40" placeholder="排行榜里的用户名"></label>
          <label class="input-wrap"><span>复制比例</span><select id="paperFollowRatio">
            <option value="0.5">50%</option>
            <option value="1">100%</option>
            <option value="0.3">30%</option>
            <option value="0.2">20%</option>
          </select></label>
          <label class="input-wrap"><span>单笔股数上限（0=不限）</span><input id="paperFollowMax" type="number" min="0" step="100" value="0"></label>
          <button class="btn small primary" type="submit">开始跟单</button>
        </form>
        <div class="paper-auto-form">
          <div class="modal-section-title">我的跟单权限</div>
          <label class="paper-toggle"><input type="checkbox" id="paperAllowFollow"${allowFollow ? ' checked' : ''}> 允许别人跟我的单</label>
          <p class="muted small mt8">关掉后，别人不能再新增跟单；已经跟单的人自动跳过你的新成交。</p>
        </div>
      </div>`;
    $$('[data-paper-unfollow]', box).forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await apiPost('/api/paper/unfollow', { username: btn.dataset.paperUnfollow });
        toast('已取消跟单', 'ok');
        if (opts.reload) opts.reload();
      } catch (err) { toast(`取消失败：${err.message}`, 'err'); btn.disabled = false; }
    }));
    const followForm = $('#paperFollowForm');
    if (followForm) followForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = ($('#paperFollowName').value || '').trim();
      if (!name) { toast('输入要跟单的用户名', 'warn'); return; }
      try {
        await apiPost('/api/paper/follow', {
          username: name,
          ratio: Number($('#paperFollowRatio').value),
          maxShares: Number($('#paperFollowMax').value) || 0,
        });
        toast(`已开始跟单 ${name}`, 'ok');
        if (opts.reload) opts.reload();
      } catch (err) { toast(`跟单失败：${err.message}`, 'err'); }
    });
    const allow = $('#paperAllowFollow');
    if (allow) allow.addEventListener('change', async () => {
      try {
        await apiPost('/api/paper/follow/allow', { allow: allow.checked });
        toast(allow.checked ? '已允许别人跟单' : '已关闭跟单', 'ok');
      } catch (err) { toast(`设置失败：${err.message}`, 'err'); allow.checked = !allow.checked; }
    });
    return;
  }

  // tab === 'alert'
  box.innerHTML = `
    <p class="muted small">持仓条件预警复用自选股预警的规则与推送通道：可以按「持仓收益率」「账户收益率」「当日涨跌幅」「价格」设阈值，命中后推送并自动失效（可重复添加）。</p>
    ${alertRowsHtml()}
    ${state.paper.alerts && state.paper.alerts.enabled ? `
    <form class="paper-auto-form mt12" id="paperAlertForm" autocomplete="off">
      <label class="input-wrap"><span>标的</span><select id="paperAlertSymbol">${holdingOptions() || '<option value="">先买入一只股票</option>'}</select></label>
      <label class="input-wrap"><span>类型</span><select id="paperAlertKind">
        <option value="holdingPct">持仓收益率（%）</option>
        <option value="accountPct">账户累计收益率（%）</option>
        <option value="pct">当日涨跌幅（%）</option>
        <option value="price">价格（元）</option>
      </select></label>
      <label class="input-wrap"><span>方向</span><select id="paperAlertOp">
        <option value="above">高于 / 突破</option>
        <option value="below">低于 / 跌破</option>
      </select></label>
      <label class="input-wrap"><span>阈值</span><input id="paperAlertValue" type="number" step="0.01" placeholder="如 8 或 -5"></label>
      <button class="btn small primary" type="submit">新增预警</button>
    </form>` : '<p class="muted small">先勾上上面的开关，才能新增预警规则。</p>'}`;

  const enable = $('#paperAlertEnabled');
  if (enable) enable.addEventListener('change', async () => {
    try {
      const cur = (state.paper.alerts && state.paper.alerts.items) || [];
      await apiPost('/api/paper/alerts', { enabled: enable.checked, items: cur });
      if (opts.reload) opts.reload();
    } catch (err) { toast(`设置失败：${err.message}`, 'err'); enable.checked = !enable.checked; }
  });
  $$('[data-paper-alert-del]', box).forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const cur = ((state.paper.alerts && state.paper.alerts.items) || []).filter((a) => String(a.id) !== btn.dataset.paperAlertDel);
      await apiPost('/api/paper/alerts', { enabled: true, items: cur });
      toast('预警已删除', 'ok');
      if (opts.reload) opts.reload();
    } catch (err) { toast(`删除失败：${err.message}`, 'err'); btn.disabled = false; }
  }));
  const alertForm = $('#paperAlertForm');
  if (alertForm) alertForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const sel = $('#paperAlertSymbol');
    const opt = sel && sel.selectedOptions ? sel.selectedOptions[0] : null;
    const kind = $('#paperAlertKind').value;
    const value = Number($('#paperAlertValue').value);
    if (!(value > 0)) { toast('阈值必须大于 0（低于方向会自动取负判断）', 'warn'); return; }
    if (kind !== 'accountPct' && !(sel && sel.value)) { toast('先选一个持仓标的', 'warn'); return; }
    const items = ((state.paper.alerts && state.paper.alerts.items) || []).concat([{
      id: `pa-${Date.now()}-${Math.floor(Math.random() * 999)}`,
      secid: kind === 'accountPct' ? '' : sel.value,
      code: opt ? opt.dataset.code || '' : '',
      name: opt ? opt.dataset.name || '' : '',
      kind,
      op: $('#paperAlertOp').value,
      value,
    }]);
    try {
      await apiPost('/api/paper/alerts', { enabled: true, items });
      toast('预警已保存', 'ok');
      if (opts.reload) opts.reload();
    } catch (err) { toast(`保存失败：${err.message}`, 'err'); }
  });
}

/* ---------------- 复盘报告 ---------------- */

function reviewCard(label, main, sub = '', tone = '') {
  return `<div class="summary-card"><div class="sc-label">${esc(label)}</div><div class="sc-value ${tone}">${main}</div><div class="sc-sub">${esc(sub)}</div></div>`;
}

export function renderPaperReview() {
  const box = $('#paperReviewBody');
  if (!box) return;
  const meta = $('#paperReviewMeta');
  const note = $('#paperReviewNote');
  const chart = $('#paperReviewChart');
  const data = state.paperReview;
  const paper = state.paper;
  if (!paper) { box.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (!data) {
    box.innerHTML = '<div class="empty">正在生成复盘报告…</div>';
    if (chart) chart.innerHTML = '';
    if (meta) meta.textContent = '统计中';
    return;
  }
  if (data.error) {
    box.innerHTML = `<div class="empty">复盘报告加载失败：${esc(data.error)}</div>`;
    if (meta) meta.textContent = '加载失败';
    return;
  }
  if (!data.trades) {
    box.innerHTML = '<div class="empty">还没有成交，无法统计胜率与盈亏比。先做几笔模拟交易再来看。</div>';
    if (chart) chart.innerHTML = '<div class="empty small">成交后显示权益曲线</div>';
    if (meta) meta.textContent = '没有成交';
    if (note) note.textContent = '口径：胜率 = 盈利的卖出笔数 / 全部卖出笔数；盈亏比 = 平均盈利单 / 平均亏损单（亏损取绝对值）。';
    return;
  }
  const winRate = isNum(data.winRate) ? `${nf(data.winRate, 1)}%` : '--';
  const pf = isNum(data.profitFactor) ? nf(data.profitFactor, 2) : '--';
  const payoff = isNum(data.payoffRatio) ? nf(data.payoffRatio, 2) : '--';
  const mdd = isNum(data.mdd) ? `-${nf(data.mdd, 2)}%` : '--';
  const topW = isNum(data.topWeight) ? `${nf(data.topWeight, 1)}%` : '--';
  const toneWin = Number(data.winRate) >= 50 ? 'tone-up' : Number(data.winRate) > 0 ? 'tone-down' : 'muted';
  const tonePf = Number(data.profitFactor) >= 1 ? 'tone-up' : Number(data.profitFactor) > 0 ? 'tone-down' : 'muted';
  box.innerHTML = `<div class="fund-summary-grid">
      ${reviewCard('胜率', winRate, `${nf(data.winCount, 0)} 胜 / ${nf(data.sells, 0)} 笔卖出`, toneWin)}
      ${reviewCard('盈亏比', payoff, `平均盈 ${nf(data.avgWin, 2)} / 平均亏 ${nf(data.avgLoss, 2)}`, isNum(data.payoffRatio) && data.payoffRatio >= 1 ? 'tone-up' : 'tone-down')}
      ${reviewCard('利润因子', pf, `总盈利 / 总亏损`, tonePf)}
      ${reviewCard('最大回撤', mdd, data.mddFrom ? `${esc(data.mddFrom)} → ${esc(data.mddTo || '')}` : '快照不足')}
      ${reviewCard('集中度', topW, data.topName ? `最大持仓：${esc(cleanName(data.topName))}` : '空仓 / 全现金')}
      ${reviewCard('交易笔数', `${nf(data.trades, 0)}`, `买 ${nf(data.buys, 0)} / 卖 ${nf(data.sells, 0)}${isNum(data.avgHoldDays) ? ` · 平均持有 ${nf(data.avgHoldDays, 1)} 天` : ''}`)}
    </div>
    <div class="table-scroll mt12"><table class="table paper-review-table">
      <thead><tr><th>指标</th><th>数值</th><th>说明</th></tr></thead>
      <tbody>
        <tr><td>累计已实现（卖出落袋）</td><td class="${toneClass(data.realizedTotal)}">${signedFmt(data.realizedTotal, 2)}</td><td class="t-dim">只算卖出，不含持仓浮盈</td></tr>
        <tr><td>账户累计收益率</td><td>${pctCell(data.totalPct)}</td><td class="t-dim">= 累计盈亏 / 本金（含追加资金）</td></tr>
        <tr><td>今日 / 本周 / 本月 / 今年</td><td>${pctCell(data.todayPct)} / ${pctCell(data.weekPct)} / ${pctCell(data.monthPct)} / ${pctCell(data.yearPct)}</td><td class="t-dim">按日终总资产，入金不算收益</td></tr>
        <tr><td>赫芬达尔集中度（HHI）</td><td>${isNum(data.hhi) ? nf(data.hhi, 3) : '--'}</td><td class="t-dim">1 = 全现金或单一持仓；越小越分散</td></tr>
        <tr><td>最好的一笔</td><td class="${toneClass(data.bestTrade && data.bestTrade.realized)}">${data.bestTrade ? `${signedFmt(data.bestTrade.realized, 2)} · ${esc(cleanName(data.bestTrade.name) || data.bestTrade.code || '')}` : '--'}</td><td class="t-dim">${data.bestTrade && data.bestTrade.at ? esc(timeText(data.bestTrade.at)) : ''}</td></tr>
        <tr><td>最差的一笔</td><td class="${toneClass(data.worstTrade && data.worstTrade.realized)}">${data.worstTrade ? `${signedFmt(data.worstTrade.realized, 2)} · ${esc(cleanName(data.worstTrade.name) || data.worstTrade.code || '')}` : '--'}</td><td class="t-dim">${data.worstTrade && data.worstTrade.at ? esc(timeText(data.worstTrade.at)) : ''}</td></tr>
      </tbody>
    </table></div>`;
  if (chart) {
    const points = (data.curve || []).map((p) => ({ d: p.d, v: p.v }));
    fundPnlAreaChart(chart, points, { label: '总资产', emptyText: '权益快照不足两天，暂时画不出曲线' });
  }
  if (meta) meta.textContent = `共 ${nf(data.trades, 0)} 笔成交 · 权益快照 ${nf(data.equityDays, 0)} 天`;
  if (note) {
    note.textContent = '口径：胜率 = 盈利的卖出笔数 / 全部卖出笔数；盈亏比 = 平均盈利单 / 平均亏损单（亏损取绝对值）；利润因子 = 总盈利 / 总亏损；最大回撤按「剔除入金后」的日终权益曲线算；集中度 = 单一最大持仓市值 / 总资产。';
  }
}
