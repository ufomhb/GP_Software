'use strict';

/* =========================================================
   寰球智投 · 后台管理脚本（2026-11-15）
   仅通过 /api/admin/* 读取数据；权限由服务端校验。
   ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const VIEW_LABELS = {
  dashboard: '全景', china: 'A股', global: '全球', us: '美股', commodities: '期货·金银',
  sectors: '板块资金', funds: '基金', strategy: '智能策略', watchlist: '自选·预警',
};
const ROLE_LABELS = { super: '超级管理员', admin: '管理员', user: '普通用户' };
const ACTION_LABELS = {
  login: '登录', register: '注册', password: '修改密码', reset: '重置密码',
  role: '角色变更', kick: '强制下线', clear: '清空日志', deploy: '推送部署', strategy: '策略记录',
  paper: '模拟交易', portfolio: '持仓数据',
};

const state = {
  me: null,
  section: 'overview',
  statsDays: 14,
  loginsLoaded: false,
  users: [],
  chartSeries: [],
  deploy: null,
  deployTimer: null,
  strategy: null,
  strategyTips: new Map(), // tooltip key -> HTML，每次渲染 strategy 时重建
  strategySource: 'all', // v2.9.0：历史记录来源过滤（实盘 / 回测 / 全部）
  paper: null, // v2.9.0：后台「模拟交易」快照
};

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 属性里的 URL 清洗：只放行 http(s) 与相对路径（esc 挡不住 javascript: 协议） */
function safeUrl(value, fallback = '#') {
  const raw = String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!raw) return fallback;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
  if (/^https?:/i.test(raw)) return raw;
  return fallback;
}

function n(v) { return Number(v) || 0; }

function fmtBytes(bytes) {
  const v = n(bytes);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDuration(ms) {
  const sec = Math.round(n(ms) / 1000);
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

function fmtDateTime(ts) {
  if (!ts) return '-';
  try {
    return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Hong_Kong' });
  } catch { return String(ts); }
}

function fmtClock(ts) {
  if (!ts) return '-';
  try {
    return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Hong_Kong' }).replace(/^\d+\//, '');
  } catch { return String(ts); }
}

function ago(ts) {
  if (!ts) return '-';
  const diff = Date.now() - n(ts);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

/* =========================================================
   设备信息（v2.8.0）
   ---------------------------------------------------------
   登录事件里已经存了原始 User-Agent，这里只做展示层解析：
   系统 · 浏览器 · 设备类型，原始 UA 放进 title 便于排查。
   ========================================================= */
function parseUa(raw) {
  const ua = String(raw || '');
  if (!ua) return { os: '', browser: '', type: '', text: '未知设备' };
  let os = '其他系统';
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/iPhone|iPod/.test(ua)) os = 'iOS';
  else if (/iPad/.test(ua)) os = 'iPadOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  let browser = '未知浏览器';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/MicroMessenger/.test(ua)) browser = '微信';
  else if (/QQBrowser/.test(ua)) browser = 'QQ 浏览器';
  else if (/CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  const ver = (ua.match(/(?:Edg|CriOS|Chrome|Firefox|QQBrowser|Version)\/(\d+)/) || [])[1];
  const type = /iPad|Tablet/.test(ua) ? '平板' : (/Mobile|iPhone|Android/.test(ua) ? '手机' : '桌面');
  const text = `${os} · ${browser}${ver ? ` ${ver}` : ''} · ${type}`;
  return { os, browser, type, text };
}

function deviceCell(ua) {
  if (!ua) return '<span class="muted">未知设备</span>';
  const d = parseUa(ua);
  return `<span title="${esc(ua)}">${esc(d.text)}</span>`;
}

function topView(views) {
  const entries = Object.entries(views || {});
  if (!entries.length) return '<span class="muted">-</span>';
  entries.sort((a, b) => n(b[1]) - n(a[1]));
  return entries.slice(0, 3).map(([view, count]) => `${esc(VIEW_LABELS[view] || view)} ${n(count)}`).join(' · ');
}

function toast(message, type = 'info', ms = 3600) {
  let box = $('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = '<span class="t-dot"></span><div></div>';
  el.lastElementChild.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

function redirectToAdminLogin() {
  $('#adminApp').hidden = true;
  $('#adminLogin').hidden = false;
}

async function api(path, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path, { cache: 'no-store', signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      redirectToAdminLogin();
      throw new Error('登录已失效，请重新登录');
    }
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function apiPost(path, body, timeout = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      redirectToAdminLogin();
      throw new Error('登录已失效，请重新登录');
    }
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 登录 / 框架 ---------------- */

function isAdmin(role) { return role === 'admin' || role === 'super'; }

function showApp() {
  $('#adminLogin').hidden = true;
  $('#adminApp').hidden = false;
  $('#adminUser').textContent = state.me.username;
  $('#adminRole').textContent = ROLE_LABELS[state.me.role] || state.me.role;
  $('#loginClear').hidden = state.me.role !== 'super';
  switchSection('overview');
}

function showLogin(message = '', ok = false) {
  $('#adminApp').hidden = true;
  $('#adminLogin').hidden = false;
  const msg = $('#adminLoginMsg');
  msg.textContent = message;
  msg.classList.toggle('ok', !!ok);
}

async function checkSession() {
  try {
    const data = await api('/api/auth/me', 8000);
    const user = data && data.user;
    if (!user) {
      showLogin();
      return;
    }
    if (!isAdmin(user.role)) {
      showLogin(`当前账号「${user.username}」是${ROLE_LABELS[user.role] || '普通用户'}，没有后台权限。请退出后使用管理员账号登录。`);
      return;
    }
    state.me = user;
    showApp();
  } catch {
    showLogin();
  }
}

async function doLogin(ev) {
  ev.preventDefault();
  const username = $('#adminUsername').value.trim();
  const password = $('#adminPassword').value;
  const btn = $('#adminLoginBtn');
  const msg = $('#adminLoginMsg');
  if (!username || !password) { msg.textContent = '请填写用户名和密码'; return; }
  btn.disabled = true;
  msg.textContent = '登录中…';
  msg.classList.remove('ok');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        remember: !!($('#adminRemember') && $('#adminRemember').checked),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `登录失败 (${res.status})`);
    const me = await api('/api/auth/me', 8000);
    if (!me.user || !isAdmin(me.user.role)) {
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      throw new Error('该账号没有后台权限，请使用超级管理员或管理员账号');
    }
    state.me = me.user;
    $('#adminPassword').value = '';
    showApp();
    toast(`欢迎，${me.user.username}`, 'ok');
  } catch (err) {
    msg.textContent = err.message;
    btn.disabled = false;
  }
}

function switchSection(section) {
  state.section = section;
  if (section !== 'deploy') clearTimeout(state.deployTimer);
  $$('#adminNav button').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.sec === section));
  $$('.admin-section').forEach((sec) => sec.classList.toggle('is-active', sec.id === `sec-${section}`));
  const titles = {
    overview: '概览', users: '用户管理', logins: '登录记录', stats: '使用统计',
    system: '系统状态', logs: '系统日志', deploy: '部署到 NAS', strategy: '持仓策略',
    dataops: '持仓数据',
    paper: '模拟交易', push: '定时推送', source: '数据源', ui: '界面管理', net: '手机访问', changelog: '更新履历',
  };
  $('#adminTitle').textContent = titles[section] || '后台管理';
  $('#adminRefreshAt').textContent = '';
  loadSection(section);
}

function loadSection(section) {
  const loaders = {
    overview: loadOverview,
    users: loadUsers,
    logins: loadLogins,
    stats: loadStats,
    system: loadSystem,
    logs: loadLogs,
    deploy: loadDeploy,
    strategy: loadStrategy,
    dataops: loadDataOps,
    paper: loadPaper,
    push: loadPush,
    source: loadSource,
    ui: loadUi,
    net: loadNet,
    changelog: loadChangelog,
  };
  if (loaders[section]) loaders[section]();
}

/* ---------------- 概览 ---------------- */

function renderCards(box, cards) {
  if (!box) return;
  box.innerHTML = cards.map((card) => `
    <div class="admin-stat ${card.tone || ''}">
      <span>${esc(card.label)}</span>
      <b>${card.value == null ? '-' : card.value}</b>
      <small>${card.sub == null ? '' : card.sub}</small>
    </div>`).join('');
}

function renderBars(box, series, key, format, extraClass = '') {
  if (!box) return;
  if (!series || !series.length) { box.innerHTML = '<div class="admin-empty">暂无数据</div>'; return; }
  const values = series.map((item) => n(item[key]));
  const max = Math.max(...values, 1);
  box.innerHTML = `<div class="admin-bars ${extraClass}">${series.map((item, i) => {
    const value = n(item[key]);
    const h = Math.max(value > 0 ? 3 : 1, Math.round((value / max) * 100));
    return `<div class="admin-bar-col" title="${esc(item.date)} · ${esc(format(value))}"><span style="height:${h}%"></span><i>${esc(String(item.date).slice(5))}</i></div>`;
  }).join('')}</div>`;
}

function loginRows(logins) {
  if (!logins || !logins.length) return '<div class="admin-empty">暂无记录</div>';
  return `<table class="admin-table"><thead><tr>
      <th>时间</th><th>用户</th><th>动作</th><th>结果</th><th>IP</th><th>设备</th><th>说明</th>
    </tr></thead><tbody>${logins.map((item) => `
      <tr>
        <td class="nowrap">${esc(fmtClock(item.at))}</td>
        <td>${esc(item.username || '-')}</td>
        <td>${esc(ACTION_LABELS[item.action] || item.action || '-')}</td>
        <td>${item.ok ? '<span class="admin-badge ok">成功</span>' : '<span class="admin-badge fail">失败</span>'}</td>
        <td class="num">${esc(item.ip || '-')}</td>
        <td class="nowrap">${deviceCell(item.ua)}</td>
        <td class="muted">${esc(item.reason || '')}</td>
      </tr>`).join('')}</tbody></table>`;
}

async function loadOverview() {
  try {
    const data = await api('/api/admin/overview?days=14');
    const today = data.today || {};
    const users = data.users || {};
    renderCards($('#ovCards'), [
      { label: '用户总数', value: users.total || 0, sub: `管理员 ${users.admins || 0} · 超级管理员 ${users.supers || 0}` },
      { label: '今日请求', value: n(today.requests).toLocaleString('zh-CN'), sub: `活跃账号 ${today.users || 0} 个`, tone: 'accent' },
      { label: '今日流量', value: fmtBytes(today.bytes), sub: `API + 静态资源`, tone: 'gold' },
      { label: '今日登录', value: n(today.logins), sub: `使用时长 ${fmtDuration(today.activeMs)}`, tone: 'green' },
      { label: '当前在线', value: (data.online || []).length, sub: `${Math.round(n(data.onlineWindowSec) / 60)} 分钟内活跃` },
      { label: '统计存储', value: fmtBytes(data.statsFileBytes), sub: `已保留 ${data.statsDays || 0} 天` },
    ]);
    const series = data.series || [];
    renderBars($('#ovChart'), series, 'bytes', fmtBytes);
    const totalBytes = series.reduce((sum, item) => sum + n(item.bytes), 0);
    $('#ovChartNote').textContent = `合计 ${fmtBytes(totalBytes)} · 每根柱子是一天`;
    const online = data.online || [];
    $('#ovOnlineNote').textContent = online.length ? `${online.length} 人在线` : '当前无活跃用户';
    $('#ovOnline').innerHTML = online.length
      ? online.map((item) => `
        <div class="admin-list-item">
          <div><b>${esc(item.username)}</b><br><small>${esc(item.ip || '')} · ${deviceCell(item.ua)}</small></div>
          <small>${esc(ago(item.lastSeen))}</small>
        </div>`).join('')
      : '<div class="admin-empty">最近 5 分钟没有用户活动</div>';
    const box = $('#ovLogins');
    box.innerHTML = loginRows((data.recentLogins || []).slice(0, 8));
  } catch (err) {
    toast(`读取概览失败：${err.message}`, 'err');
  }
  $('#adminRefreshAt').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

/* ---------------- 用户管理 ---------------- */

function roleOptions(current, actorRole) {
  const roles = ['user', 'admin'];
  if (actorRole === 'super') roles.push('super');
  return roles.map((role) => `<option value="${role}" ${current === role ? 'selected' : ''}>${ROLE_LABELS[role]}</option>`).join('');
}

async function loadUsers() {
  try {
    const data = await api('/api/admin/users');
    state.users = data.users || [];
    const rows = state.users.map((u) => {
      const self = state.me && u.id === state.me.id;
      const canEdit = !self && !(u.role === 'super' && state.me.role !== 'super');
      return `<tr>
        <td><b>${esc(u.username)}</b> ${u.primary ? '<span class="admin-badge admin">主账号</span>' : ''} ${u.online ? '<span class="admin-badge online">在线</span>' : ''}</td>
        <td>${esc(ROLE_LABELS[u.role] || u.role)}</td>
        <td class="nowrap muted">${esc((u.createdAt || '').slice(0, 10))}</td>
        <td class="nowrap">${u.lastLoginAt ? esc(fmtClock(new Date(u.lastLoginAt).getTime())) : '<span class="muted">从未登录</span>'}${u.lastLoginIp ? `<br><small class="muted">${esc(u.lastLoginIp)}</small>` : ''}</td>
        <td class="num">${n(u.today && u.today.requests).toLocaleString('zh-CN')}<br><small class="muted">${fmtBytes(u.today && u.today.bytes)}</small></td>
        <td class="num">${fmtDuration(u.week && u.week.activeMs)}<br><small class="muted">${n(u.week && u.week.requests)} 次请求</small></td>
        <td><select data-user-role="${esc(u.id)}" ${canEdit ? '' : 'disabled'}>${roleOptions(u.role, state.me.role)}</select></td>
        <td class="ops">
          <button type="button" class="admin-btn" data-reset="${esc(u.id)}" data-name="${esc(u.username)}">重置密码</button>
          <button type="button" class="admin-btn danger" data-kick="${esc(u.id)}" data-name="${esc(u.username)}">强制下线</button>
        </td>
      </tr>`;
    }).join('');
    $('#usersTable').innerHTML = `<table class="admin-table"><thead><tr>
      <th>用户</th><th>角色</th><th>创建</th><th>最近登录</th><th>今日请求 / 流量</th><th>近 7 天使用</th><th>权限</th><th>操作</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
    $$('[data-user-role]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.getAttribute('data-user-role');
        try {
          await apiPost('/api/admin/users/role', { id, role: sel.value });
          toast('权限已更新', 'ok');
          loadUsers();
        } catch (err) {
          toast(`修改失败：${err.message}`, 'err');
          loadUsers();
        }
      });
    });
    $$('[data-reset]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-name');
        const password = window.prompt(`为「${name}」设置新密码（6-64 位）：`);
        if (password == null) return;
        if (password.length < 6 || password.length > 64) { toast('密码长度需为 6-64 位', 'warn'); return; }
        try {
          await apiPost('/api/admin/users/password', { id: btn.getAttribute('data-reset'), password });
          toast(`已重置「${name}」的密码，并强制其重新登录`, 'ok');
        } catch (err) {
          toast(`重置失败：${err.message}`, 'err');
        }
      });
    });
    $$('[data-kick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-name');
        if (!window.confirm(`确认让「${name}」所有登录会话立即失效？`)) return;
        try {
          const res = await apiPost('/api/admin/users/kick', { id: btn.getAttribute('data-kick') });
          toast(`已强制「${name}」下线（清理 ${res.sessions || 0} 个会话）`, 'ok');
          loadUsers();
        } catch (err) {
          toast(`操作失败：${err.message}`, 'err');
        }
      });
    });
  } catch (err) {
    $('#usersTable').innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
  }
}

/* ---------------- 登录记录 ---------------- */

function userFilterOptions(users, selected) {
  return '<option value="">全部用户</option>' + users.map((u) => (
    `<option value="${esc(u.id)}" ${selected === u.id ? 'selected' : ''}>${esc(u.username)}</option>`
  )).join('');
}

async function ensureUserOptions() {
  if (state.users && state.users.length) return state.users;
  try {
    const data = await api('/api/admin/users');
    state.users = data.users || [];
  } catch { state.users = []; }
  return state.users;
}

async function loadLogins() {
  const users = await ensureUserOptions();
  const userSel = $('#loginUserFilter');
  if (userSel && userSel.options.length <= 1) userSel.innerHTML = userFilterOptions(users);
  const userId = userSel ? userSel.value : '';
  const action = $('#loginActionFilter') ? $('#loginActionFilter').value : '';
  const query = new URLSearchParams({ limit: '120' });
  if (userId) query.set('userId', userId);
  if (action) query.set('action', action);
  try {
    const data = await api(`/api/admin/logins?${query.toString()}`);
    $('#loginsTable').innerHTML = loginRows(data.logins);
    if (!state.loginsLoaded) {
      state.loginsLoaded = true;
      $('#loginRefresh').addEventListener('click', loadLogins);
      userSel.addEventListener('change', loadLogins);
      $('#loginActionFilter').addEventListener('change', loadLogins);
      $('#loginClear').addEventListener('click', async () => {
        if (!window.confirm('确认清空全部登录日志？此操作不可撤销。')) return;
        try {
          const res = await apiPost('/api/admin/logins/clear', {});
          toast(`已清空 ${res.cleared || 0} 条登录日志`, 'ok');
          loadLogins();
        } catch (err) {
          toast(`清空失败：${err.message}`, 'err');
        }
      });
    }
  } catch (err) {
    $('#loginsTable').innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
  }
}

/* ---------------- 使用统计 ---------------- */

async function loadStats() {
  const days = Number($('#statsDays').value || 14);
  state.statsDays = days;
  const userSel = $('#statsUser');
  const users = await ensureUserOptions();
  if (userSel && userSel.options.length <= 1) userSel.innerHTML = userFilterOptions(users);
  const userId = userSel ? userSel.value : '';
  const query = new URLSearchParams({ days: String(days) });
  if (userId) query.set('userId', userId);
  try {
    const data = await api(`/api/admin/stats?${query.toString()}`, 30000);
    const totals = data.totals || {};
    renderCards($('#statsCards'), [
      { label: '请求总数', value: n(totals.requests).toLocaleString('zh-CN'), sub: `近 ${days} 天`, tone: 'accent' },
      { label: '传输流量', value: fmtBytes(totals.bytes), sub: 'API 返回值 + 页面资源' },
      { label: '使用时长', value: fmtDuration(totals.activeMs), sub: '按页面可见时的 60 秒心跳累计', tone: 'green' },
      { label: '登录次数', value: n(totals.logins), sub: `${(data.series || []).filter((s) => n(s.users) > 0).length} 天有使用记录`, tone: 'gold' },
    ]);
    const series = data.series || [];
    $('#statsChart').innerHTML = '<div class="admin-chart-title">每日请求数</div><div id="statsChartReq"></div><div class="admin-chart-title">每日流量</div><div id="statsChartBytes"></div>';
    renderBars($('#statsChartReq'), series, 'requests', (v) => `${n(v).toLocaleString('zh-CN')} 次`);
    renderBars($('#statsChartBytes'), series, 'bytes', fmtBytes, 'bytes');
    const rows = (data.rows || []).map((row) => `<tr>
      <td class="nowrap">${esc(row.date)}</td>
      <td><b>${esc(row.username)}</b></td>
      <td class="num">${n(row.logins)}</td>
      <td class="num">${n(row.requests).toLocaleString('zh-CN')}</td>
      <td class="num">${fmtBytes(row.bytes)}</td>
      <td class="num">${fmtDuration(row.activeMs)}</td>
      <td class="nowrap muted">${esc(fmtClock(row.lastSeen))}</td>
      <td class="muted">${topView(row.views)}</td>
    </tr>`).join('');
    $('#statsTable').innerHTML = rows
      ? `<table class="admin-table"><thead><tr>
          <th>日期</th><th>用户</th><th>登录</th><th>请求</th><th>流量</th><th>使用时长</th><th>最后活动</th><th>访问页面</th>
        </tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="admin-empty">这段时间还没有统计数据</div>';
    if (!state.statsBound) {
      state.statsBound = true;
      $('#statsRefresh').addEventListener('click', loadStats);
      $('#statsDays').addEventListener('change', loadStats);
      userSel.addEventListener('change', loadStats);
    }
  } catch (err) {
    $('#statsTable').innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
  }
}

/* ---------------- 系统状态 ---------------- */

async function loadSystem() {
  try {
    const sys = await api('/api/admin/system', 30000);
    const info = [
      ['服务版本', `v${sys.version || '-'}`, ''],
      ['运行时长', fmtDuration(n(sys.uptime) * 1000), ''],
      ['最近部署', sys.deployedAt ? fmtDateTime(new Date(sys.deployedAt).getTime()) : '-', ''],
      ['系统平台', sys.platform || '-', ''],
      ['磁盘', sys.disk || '本机非 Linux 部署，未读取', ''],
    ];
    $('#sysInfo').innerHTML = `<div class="admin-kv-list">${info.map(([k, v]) => `<div class="admin-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
    const statsInfo = [
      ['统计文件', fmtBytes(sys.statsFileBytes)],
      ['保留天数', `${sys.statsDays || 0} 天`],
      ['登录日志上限', '2000 条'],
      ['在线判定窗口', '5 分钟'],
    ];
    $('#sysStats').innerHTML = `<div class="admin-kv-list">${statsInfo.map(([k, v]) => `<div class="admin-kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;

    const services = Object.entries(sys.services || {});
    const timers = Object.entries(sys.timers || {});
    const backups = sys.backups || [];
    const svcHtml = services.map(([k, v]) => `<div class="admin-kv"><span>${esc(k)}</span><b class="${v === 'active' ? 'ok' : 'bad'}">${esc(v)}</b></div>`).join('');
    const timerHtml = timers.map(([k, v]) => `<div class="admin-kv"><span>${esc(k)}</span><b class="${v === 'active' ? 'ok' : 'bad'}">${esc(v)}</b></div>`).join('');
    const backupHtml = backups.length ? backups.map((b) => `<div class="admin-kv"><span>备份</span><b>${esc(b)}</b></div>`).join('') : '<div class="admin-empty">暂无备份记录</div>';
    $('#sysServices').innerHTML = `${services.length ? `<div class="admin-sub">服务</div>${svcHtml}` : '<div class="admin-empty">本机非 Linux 部署（Windows），无 systemd 服务</div>'}
      ${timers.length ? `<div class="admin-sub">定时任务</div>${timerHtml}` : ''}
      <div class="admin-sub">最近备份</div>${backupHtml}`;
    $('#sysRepo').textContent = sys.repo || '';
    const box = $('#sysCommits');
    try {
      const res = await fetch('https://api.github.com/repos/ufomhb/GP_Software/commits?per_page=5', { cache: 'no-store' });
      if (!res.ok) throw new Error('GitHub API 不可达');
      const list = await res.json();
      box.innerHTML = list.map((c) => `<div class="admin-list-item"><div><code>${esc(String(c.sha).slice(0, 7))}</code> ${esc(String((c.commit && c.commit.message) || '').split('\n')[0])}</div><small>${esc((c.commit && c.commit.author && c.commit.author.date) || '')}</small></div>`).join('');
    } catch {
      box.innerHTML = `<div class="admin-empty">GitHub API 不可达（网络限制）。<a href="${esc(safeUrl(sys.repo || 'https://github.com/ufomhb/GP_Software'))}" target="_blank" rel="noreferrer">直接打开仓库 →</a></div>`;
    }
  } catch (err) {
    $('#sysInfo').innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
  }
}

/* ---------------- 定时推送 ---------------- */

function collectPushBody() {
  const channel = $('#pushChannel').value;
  const token = String($('#pushToken').value || '').trim();
  const body = {
    enabled: $('#pushEnabled').checked,
    channel,
    weekdaysOnly: true,
    slots: [
      { key: 'strategy', label: '持仓策略（加仓/减仓/不变）', time: String($('#slotStrategyTime').value || '14:30').slice(0, 5), enabled: $('#slotStrategyEnabled').checked },
      { key: 'valuation', label: '当日基金估值', time: String($('#slotValuationTime').value || '19:30').slice(0, 5), enabled: $('#slotValuationEnabled').checked },
    ],
  };
  if (token && !token.includes('****')) {
    if (channel === 'wecom' || channel === 'custom') body.webhook = token;
    else body.token = token;
  }
  return body;
}

function bindPushOnce() {
  if (state.pushBound) return;
  state.pushBound = true;
  $('#pushChannel').addEventListener('change', () => {
    $('#pushTokenHint').textContent = {
      serverchan: 'Server酱 SendKey（SCT 开头）',
      pushplus: 'PushPlus token',
      wecom: '企业微信群机器人 webhook 地址',
      custom: '自定义 POST webhook 地址（JSON: {title, content}）',
    }[$('#pushChannel').value] || '';
  });
  $('#pushSave').addEventListener('click', async () => {
    try {
      await apiPost('/api/push/config', collectPushBody());
      toast('推送设置已保存', 'ok');
      loadPush();
    } catch (err) { toast(`保存失败：${err.message}`, 'err'); }
  });
  $$('[data-push-preview]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slot = btn.dataset.pushPreview;
      try {
        btn.disabled = true;
        const data = await api(`/api/push/preview?slot=${encodeURIComponent(slot)}`, 60000);
        const pre = $('#pushPreview');
        pre.hidden = false;
        pre.textContent = `${data.title || ''}\n\n${data.content || ''}`;
      } catch (err) { toast(`预览失败：${err.message}`, 'err'); }
      finally { btn.disabled = false; }
    });
  });
  $$('[data-push-test]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slot = btn.dataset.pushTest;
      const label = slot === 'valuation' ? '当日估值' : '持仓策略';
      try {
        btn.disabled = true;
        btn.textContent = '发送中…';
        const body = collectPushBody();
        body.slot = slot;
        const data = await apiPost('/api/push/test', body, 90000);
        const sent = data.sent || {};
        const extra = sent.pushid ? `，受理单号 ${sent.pushid}` : '';
        toast(`「${label}」已提交（${sent.endpoint || sent.channel || 'ok'}${extra}）`, 'ok', 6000);
        $('#pushStatus').textContent = data.hint
          ? `「${label}」已受理${extra}。${data.hint}`
          : `「${label}」已受理${extra}。若微信未收到，请检查 Server酱控制台的消息通道与免费额度。`;
        loadPush();
      } catch (err) {
        toast(`${label} 测试失败：${err.message}`, 'err', 8000);
      } finally {
        btn.disabled = false;
        btn.textContent = '测试';
      }
    });
  });
}

async function loadPush() {
  bindPushOnce();
  try {
    const data = await api('/api/push/config', 20000);
    const cfg = data.config || {};
    $('#pushEnabled').checked = Boolean(cfg.enabled);
    $('#pushChannel').value = cfg.channel || 'serverchan';
    $('#pushToken').value = cfg.token || cfg.webhook || '';
    const slotOf = (key) => (Array.isArray(cfg.slots) ? cfg.slots.find((s) => s.key === key) : null) || {};
    const st = slotOf('strategy');
    const va = slotOf('valuation');
    $('#slotStrategyEnabled').checked = st.enabled !== false;
    $('#slotStrategyTime').value = st.time || '14:30';
    $('#slotValuationEnabled').checked = va.enabled !== false;
    $('#slotValuationTime').value = va.time || '19:30';
    $('#pushStatus').textContent = cfg.lastResult
      ? `最近发送：${fmtDateTime(cfg.lastResult.at)} · ${cfg.lastResult.label || cfg.lastResult.slot || ''} · ${cfg.lastResult.summary || ''}`
      : '还没有发送记录';
    $('#pushChannel').dispatchEvent(new Event('change'));
  } catch (err) {
    $('#pushStatus').textContent = `读取推送配置失败：${err.message}`;
  }
}

/* ---------------- 数据源 ---------------- */

async function loadSource() {
  try {
    const status = await api('/api/source/status', 15000);
    state.source = status;
    $$('#srcMode button').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.mode === status.mode));
    $('#srcStrict').checked = Boolean(status.strict);
    $('#sourceModeNote').textContent = status.mode === 'auto'
      ? '自动容错：东财 → 腾讯 → 同花顺 → 新浪，失败自动切换'
      : `优先使用 ${status.mode}${status.strict ? '（已关闭回退）' : ''}`;
    const labels = { eastmoney: '东方财富', tencent: '腾讯行情', ths: '同花顺', sina: '新浪财经' };
    $('#srcList').innerHTML = (status.capabilities || []).map((cap) => {
      const active = (cap.providers || []).find((p) => p.key === cap.active) || {};
      const tone = cap.builtin ? 'warn' : active.state === 'ok' ? 'ok' : active.state === 'fail' ? 'fail' : '';
      const detail = cap.builtin
        ? cap.note || '内置多源回退'
        : `${cap.desc || ''}${cap.active ? ` · 当前 ${labels[cap.active] || cap.active}` : ''}${active.state === 'fail' ? ` · ${active.error || '失败'}` : ''}`;
      const select = cap.builtin
        ? '<span class="admin-badge user">内置</span>'
        : `<select data-source-cap="${esc(cap.key)}">
            <option value="auto" ${!cap.override ? 'selected' : ''}>自动</option>
            ${(cap.providers || []).filter((p) => p.registered).map((p) => `<option value="${esc(p.key)}" ${cap.override === p.key ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
          </select>`;
      return `<div class="admin-source-row">
        <div class="sr-main"><div class="sr-label"><i class="admin-dot ${tone}"></i>${esc(cap.label)}</div><div class="sr-sub">${esc(detail)}</div></div>
        ${select}
      </div>`;
    }).join('');
    $$('[data-source-cap]').forEach((sel) => {
      sel.addEventListener('change', () => updateSource({ cap: sel.dataset.sourceCap, provider: sel.value }));
    });
    if (!state.sourceBound) {
      state.sourceBound = true;
      $('#srcMode').addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-mode]');
        if (btn) updateSource({ mode: btn.dataset.mode });
      });
      $('#srcStrict').addEventListener('change', () => updateSource({ strict: $('#srcStrict').checked }));
      $('#srcProbe').addEventListener('click', async () => {
        const btn = $('#srcProbe');
        btn.disabled = true;
        btn.textContent = '检测中…';
        try {
          const data = await api('/api/source/probe', 120000);
          state.source = data.status;
          toast('数据源检测完成', 'ok');
          loadSource();
        } catch (err) { toast(`检测失败：${err.message}`, 'err'); }
        finally { btn.disabled = false; btn.textContent = '重新检测'; }
      });
    }
  } catch (err) {
    $('#srcList').innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
  }
}

async function updateSource(patch) {
  try {
    const data = await apiPost('/api/source/config', patch, 30000);
    state.source = data.status;
    toast('数据源已更新', 'ok');
    loadSource();
  } catch (err) {
    toast(`切换失败：${err.message}`, 'err');
  }
}

/* ---------------- 手机访问 ---------------- */

async function loadNet() {
  try {
    const data = await api('/api/net', 15000);
    const mobile = data.mobile || [];
    $('#netNote').textContent = data.lanEnabled ? '已监听局域网' : '当前只监听本机';
    $('#netUrls').innerHTML = mobile.length
      ? mobile.map((url) => `<button type="button" class="admin-net-url" data-net-url="${esc(url)}"><b>${esc(url)}</b><span>手机连同一 Wi-Fi 打开 · 点一下复制</span></button>`).join('')
      : `<div class="admin-empty">当前只监听 127.0.0.1，手机还不能访问。用 <code>node server.js --host=0.0.0.0</code> 重启后重试。</div>`;
    $$('[data-net-url]').forEach((btn) => btn.addEventListener('click', () => copyText(btn.dataset.netUrl)));
    if (!state.netBound) {
      state.netBound = true;
      $('#netReload').addEventListener('click', loadNet);
      $('#netCopy').addEventListener('click', () => {
        if (!mobile.length) { toast('当前没有可用的手机地址', 'warn'); return; }
        copyText(mobile[0]);
      });
    }
  } catch (err) {
    $('#netUrls').innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast(`已复制：${text}`, 'ok', 2600);
      return;
    }
  } catch { /* 退回 toast */ }
  toast(text, 'ok', 5000);
}

/* ---------------- 更新履历 ----------------
   v2.12.0：客户端只显示「用户能感知」的功能点，后台保留完整明细。
   这里把两套都列出来：上面是完整明细（实现 / 口径 / 测试 / 部署），
   下面是同一版本在客户端展示的那几条，方便确认对外口径。 */

async function loadChangelog() {
  try {
    const data = await api('/api/changelog', 15000);
    const versions = data.versions || [];
    $('#changelogList').innerHTML = versions.length
      ? `<p class="admin-note">客户端更新履历只显示「用户能感知的 UI / 功能点」，实现细节（接口、字段、测试、部署）只在后台这份明细里。下面每个版本都带一份「客户端展示」预览。</p>`
        + versions.map((v) => `<div class="admin-version">
          <div class="admin-version-head"><b>v${esc(v.version)}</b><span>${esc(v.date || '')}</span><strong>${esc(v.title || '')}</strong></div>
          <div class="admin-version-tag">完整明细（后台）</div>
          <ul>${(v.items || []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
          <div class="admin-version-tag">客户端展示（用户看到的版本）</div>
          <ul class="admin-version-client">${(v.clientItems || []).map((item) => `<li>${esc(item)}</li>`).join('') || '<li class="muted">（这条版本没有可展示的功能点）</li>'}</ul>
        </div>`).join('')
      : '<div class="admin-empty">暂无记录</div>';
  } catch (err) {
    $('#changelogList').innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
  }
}

/* ---------------- 系统日志 ---------------- */

/**
 * 一行日志的样式：错误红色、警告金色，其余常规色。
 * 日志里可能带用户名 / URL / UA 等外部输入，所以一律 textContent 写入，绝不拼 innerHTML。
 */
function logLineClass(line) {
  if (/\[ERROR\]|uncaughtException|unhandledRejection|\berror\b|失败|异常|不可用/i.test(line)) return 'log-err';
  if (/\[WARN\]|\bwarn(ing)?\b|超时|回退|降级/i.test(line)) return 'log-warn';
  return '';
}

function fillLogSelect(select, files) {
  const prev = select.value;
  if (!files.length) {
    select.innerHTML = '<option value="">（暂无日志文件）</option>';
    return;
  }
  select.innerHTML = files
    .map((f) => `<option value="${esc(f.id)}">${esc(f.label)} · ${esc(fmtBytes(f.size))}</option>`)
    .join('');
  if (prev && files.some((f) => f.id === prev)) select.value = prev;
  else select.value = files[0].id;
}

async function loadLogs() {
  const body = $('#logsBody');
  if (!body) return;
  const params = new URLSearchParams({ lines: String($('#logsLines').value || '200') });
  const id = $('#logsFile').value;
  const query = String($('#logsQuery').value || '').trim();
  if (id) params.set('file', id);
  if (query) params.set('q', query);
  try {
    const data = await api(`/api/admin/logs?${params.toString()}`, 15000);
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    fillLogSelect($('#logsFile'), data.files || []);
    body.textContent = '';
    const rows = Array.isArray(data.lines) ? data.lines : [];
    if (!rows.length) {
      const empty = document.createElement('span');
      empty.className = 'log-empty';
      empty.textContent = data.size
        ? '没有匹配的行（换个关键词，或把行数调大）'
        : '日志为空：服务刚启动，或已关闭落盘（LOG_TO_FILE=0）';
      body.appendChild(empty);
    } else {
      const frag = document.createDocumentFragment();
      for (const line of rows) {
        const el = document.createElement('span');
        const cls = logLineClass(line);
        el.className = cls ? `log-line ${cls}` : 'log-line';
        el.textContent = line;
        frag.appendChild(el);
      }
      body.appendChild(frag);
    }
    $('#logsMeta').textContent = [
      data.label || '',
      data.size ? fmtBytes(data.size) : '',
      data.mtime ? `更新于 ${ago(data.mtime)}` : '',
      query ? `命中 ${n(data.matched)} / 扫描 ${n(data.total)} 行` : `${n(data.total)} 行`,
      data.truncated ? `只显示最后 ${$('#logsLines').value} 行` : '',
    ].filter(Boolean).join(' · ');
    if (atBottom) body.scrollTop = body.scrollHeight;
  } catch (err) {
    body.innerHTML = `<span class="log-empty">读取失败：${esc(err.message)}</span>`;
    $('#logsMeta').textContent = '读取失败';
  }
}

function bindLogs() {
  $('#logsRefresh').addEventListener('click', () => loadLogs());
  $('#logsFile').addEventListener('change', () => loadLogs());
  $('#logsLines').addEventListener('change', () => loadLogs());
  let typing = 0;
  $('#logsQuery').addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => loadLogs(), 320);
  });
  $('#logsCopy').addEventListener('click', () => copyText($('#logsBody').textContent || ''));
  setInterval(() => {
    if (state.section === 'logs' && $('#logsAuto').checked) loadLogs();
  }, 5000);
}

/* ---------------- 部署到 NAS ---------------- */

const DEP_ICON = { pending: '○', running: '◐', done: '●', failed: '✕' };

function depStatusClass(status) {
  return ['pending', 'running', 'done', 'failed'].includes(status) ? status : 'pending';
}

function renderDeploySteps(steps) {
  const box = $('#depSteps');
  if (!box) return;
  if (!steps || !steps.length) {
    box.innerHTML = '<li class="admin-empty">尚未推送</li>';
    return;
  }
  box.innerHTML = steps.map((s) => `
    <li class="dep-step ${depStatusClass(s.status)}">
      <i>${DEP_ICON[depStatusClass(s.status)]}</i>
      <span>${esc(s.label)}</span>
      ${s.detail ? `<small>${esc(s.detail)}</small>` : ''}
    </li>`).join('');
}

function renderDeployLog(log) {
    const box = $('#depLog');
    if (!box) return;
    if (!log || !log.length) {
      box.textContent = '等待推送…';
      return;
    }
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
    box.textContent = log.map((e) => {
      const mark = e.level === 'error' ? '✗' : e.level === 'warn' ? '!' : '·';
      const time = fmtClock(e.at);
      return `${mark} ${time}  ${e.text}`;
    }).join('\n');
    if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderDeploy(data) {
  const isSuper = state.me && state.me.role === 'super';
  const supported = Boolean(data && data.supported);
  const job = data && data.job;
  const running = Boolean(job && job.status === 'running');
  const nas = (data && data.nas) || {};
  const pending = (data && data.pending) || {};
  const last = (data && data.last) || null;

  $('#depTarget').textContent = supported
    ? `${data.host} · ${data.target}`
    : `${data.platform} 上运行`;

  const nasVersion = nas.version
    ? `v${esc(nas.version)}`
    : nas.reachable === false
      ? `<span class="muted">${esc(nas.message || '无法连接')}</span>`
      : '-';

  const infoRows = [
    ['本机版本', `v${esc((data && data.localVersion) || '-')}`],
    ['NAS 线上版本', nasVersion],
    ['NAS 服务状态', nas.service ? esc(nas.service) : '-'],
    ['未推送改动', pending.changedCount
      ? `<b>${n(pending.changedCount)}</b> 个文件比上次推送更新`
      : '无（本地与 NAS 一致）'],
    ['上次推送', last
      ? `${esc(fmtDateTime(last.at))} · ${last.ok ? '成功' : '失败'}${last.nasVersion ? ` · 线上 v${esc(last.nasVersion)}` : ''}`
      : '从未推送'],
  ];
  $('#depInfo').innerHTML = infoRows.map(([label, value]) => `
    <div class="admin-kv"><span>${label}</span><b>${value}</b></div>`).join('');

  // 进度条
  const wrap = $('#depProgressWrap');
  if (job) {
    wrap.hidden = false;
    const pct = Math.max(2, Math.min(100, n(job.percent)));
    const fill = $('#depProgressFill');
    fill.style.width = `${pct}%`;
    fill.classList.toggle('is-failed', job.status === 'failed');
    fill.classList.toggle('is-done', job.status === 'success');
    $('#depProgressNum').textContent = `${n(job.percent)}%`;
    const statusText = job.status === 'running' ? '推送中…' : job.status === 'success' ? '已完成' : '推送失败';
    const used = job.finishedAt || (job.status === 'running' ? Date.now() : job.startedAt);
    $('#depJobMeta').textContent = `${statusText}${job.startedAt ? ` · 用时 ${fmtDuration(used - job.startedAt)}` : ''}`;
    renderDeploySteps(job.steps);
    renderDeployLog(job.log);
  } else {
    wrap.hidden = true;
    $('#depJobMeta').textContent = '—';
    renderDeploySteps(null);
    renderDeployLog(null);
  }

  // 按钮与提示
  const btn = $('#depStart');
  btn.disabled = running || !supported || !isSuper;
  btn.textContent = running ? '推送中…' : '推送到 NAS';

  let hint = '';
  if (!supported) {
    hint = '当前服务运行在 NAS 上，源文件只在本机开发机；请在本机后台点推送。';
  } else if (!isSuper) {
    hint = '只有超级管理员能发起推送（当前账号可以查看进度）。';
  } else if (running) {
    hint = '正在推送，请勿关闭页面；完成后会自动刷新状态。';
  } else if (pending.changedCount) {
    const names = (pending.changedFiles || []).join('、');
    hint = `检测到 <b>${n(pending.changedCount)}</b> 个本地文件比上次推送更新：${esc(names)}${pending.changedCount > (pending.changedFiles || []).length ? ' 等' : ''}`;
  } else {
    hint = '本地代码与 NAS 一致，没有需要推送的改动。';
  }
  $('#depNote').innerHTML = hint;

  // 正在跑就继续轮询
  if (running && state.section === 'deploy') scheduleDeployPoll(900);
}

function scheduleDeployPoll(delay = 900) {
  clearTimeout(state.deployTimer);
  state.deployTimer = setTimeout(() => {
    if (state.section === 'deploy') loadDeploy();
  }, delay);
}

async function loadDeploy() {
  try {
    const data = await api('/api/admin/deploy/status', 30000);
    state.deploy = data;
    renderDeploy(data);
  } catch (err) {
    $('#depInfo').innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
    $('#depNote').textContent = err.message;
  }
}

async function startDeploy() {
  const data = state.deploy || {};
  if (!data.supported) {
    toast('本机才能推送：当前运行在 NAS 上', 'err');
    return;
  }
  const version = data.localVersion ? `v${data.localVersion}` : '最新';
  const ok = window.confirm(
    `确认把本机 ${version} 的代码推送到 NAS 吗？\n\n`
    + '推送流程：备份 NAS 现有代码 → 上传 → 覆盖 /data/gp → 重启 gp-terminal → 健康检查。\n'
    + '期间线上站点会短暂不可用（约 10–30 秒）。',
  );
  if (!ok) return;

  const btn = $('#depStart');
  btn.disabled = true;
  try {
    await apiPost('/api/admin/deploy/start', { confirm: true }, 30000);
    toast('推送已开始，正在上传…', 'ok');
    await loadDeploy();
  } catch (err) {
    toast(`推送启动失败：${err.message}`, 'err');
    btn.disabled = false;
    await loadDeploy();
  }
}

function bindDeploy() {
  $('#depRefresh').addEventListener('click', () => loadDeploy());
  $('#depStart').addEventListener('click', startDeploy);
}

/* ---------------- 持仓策略 ---------------- */

// 页面输入框 → 规则 / 评价口径字段的映射（顺序即页面顺序）
const ST_RULE_FIELDS = [
  ['ruleAddScore', 'addScore'], ['ruleAddDip', 'addDip'],
  ['ruleStrongScore', 'strongScore'], ['ruleStrongDip', 'strongDip'],
  ['ruleCutScore', 'cutScore'], ['ruleCutRise', 'cutRise'], ['ruleCutDip', 'cutDip'],
  ['ruleWeakScore', 'weakScore'],
  ['ruleConcPct', 'concentrationPct'], ['ruleConcTarget', 'concentrationTargetPct'],
  ['ruleBaseRatio', 'baseRatio'], ['ruleStrongRatio', 'strongRatio'], ['ruleMarketWeight', 'marketWeight'],
];
const ST_BAND_FIELDS = [
  ['bandAdd', 'addBand'], ['bandCut', 'cutBand'], ['bandHold', 'holdBand'], ['bandWindow', 'evalWindow'],
];
const ST_DEFAULT_RULES = {
  addScore: 65, addDip: 1.2, strongScore: 80, strongDip: 2,
  cutScore: 45, cutRise: 0.8, cutDip: 1.2, weakScore: 35,
  concentrationPct: 40, concentrationTargetPct: 30,
  baseRatio: 10, strongRatio: 20, marketWeight: 1,
};
const ST_DEFAULT_BANDS = { addBand: 0.3, cutBand: 0.3, holdBand: 0.8, evalWindow: 3 };

const ST_ACTION_LABEL = { add: '加仓', cut: '减仓', hold: '不变' };
const ST_ACTION_ORDER = ['add', 'cut', 'hold'];
const ST_SCORE_ORDER = ['<35', '35-45', '45-65', '65-80', '>=80', '无评分'];
const ST_MARKET_ORDER = ['偏多', '震荡', '偏空', '未知'];
const ST_MARKET_CLS = { '偏多': 'st-up', '偏空': 'st-down', '震荡': 'st-flat', '未知': 'st-flat' };
const ST_BASIS_LABEL = {
  estimate: '15:00 估值',
  'estimate-repaired': '估值（已修正）',
  'estimate-replay': '15:00 估值（回测重建）',
};
const ST_MIN_SAMPLES = 3; // 可判定样本少于 3 条时不给百分比，避免小样本误导
const ST_VERDICT = {
  right: { icon: '✓', label: '合理', cls: 'ok' },
  wrong: { icon: '✗', label: '不合理', cls: 'bad' },
  flat: { icon: '~', label: '中性', cls: 'flat' },
  skipped: { icon: '?', label: '未评价', cls: 'skip' },
};

/** 数字或 null：区分「字段缺失」和「值就是 0」 */
function stNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** A 股习惯：>0 红（--up）、<0 绿（--down）、0 灰（--flat） */
function stPctCls(v) {
  const p = stNum(v);
  if (p === null) return '';
  return p > 0 ? 'st-up' : p < 0 ? 'st-down' : 'st-flat';
}

function stPctText(v) {
  const p = stNum(v);
  return p === null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
}

function stPctHtml(v) {
  return stNum(v) === null
    ? '<span class="muted">—</span>'
    : `<span class="${stPctCls(v)}">${stPctText(v)}</span>`;
}

/** 把统计对象统一成 { right, wrong, flat, skipped, total, decided }，缺字段时自算 */
function stTotals(entry) {
  const e = entry || {};
  const right = n(e.right);
  const wrong = n(e.wrong);
  const flat = n(e.flat);
  const skipped = n(e.skipped);
  let decided = stNum(e.decided);
  if (decided === null) decided = right + wrong;
  let total = stNum(e.total);
  if (total === null) {
    const coverage = stNum(e.coverageRate);
    if (coverage !== null && coverage > 0 && decided > 0) total = Math.round(decided / coverage);
    else total = Math.max(n(e.n), right + wrong + flat + skipped);
  }
  return { right, wrong, flat, skipped, total, decided };
}

/** 含中性命中率 = 对/总条数（中性、未评都算进分母，不算对） */
function stCoverRate(right, total) {
  return total ? `${Math.round((right / total) * 100)}%` : '—';
}

/** 分组表用：可判定样本不足时给「样本不足」，避免小样本 100% 误导 */
function stCoverRateValue(right, total, decided, minSamples = 0) {
  if (minSamples && decided < minSamples) return '样本不足';
  return stCoverRate(right, total);
}

/** 评分区间：与后端 bucketOfScore 保持一致（只用于把明细映射回区间表） */
function stBucketOfScore(score) {
  const s = stNum(score);
  if (s === null) return '无评分';
  if (s < 35) return '<35';
  if (s < 45) return '35-45';
  if (s < 65) return '45-65';
  if (s < 80) return '65-80';
  return '>=80';
}

function stVerdictText(it) {
  const v = ST_VERDICT[it && it.verdict];
  return v ? v.label : '待评价';
}

/** 评价阈值：优先用接口给的 data.bands，缺字段时退回默认口径 */
function stBandVal(bands, key) {
  const v = stNum(bands && bands[key]);
  return v === null ? ST_DEFAULT_BANDS[key] : v;
}

/** 历史记录口径文字（决策日用什么涨跌口径）；没有可识别口径时返回空串 */
function stBasisLabel(rec) {
  if (!rec) return '';
  let basis = rec.decisionBasis;
  if (!basis && Array.isArray(rec.items)) {
    const hit = rec.items.find((it) => it && it.decisionBasis);
    if (hit) basis = hit.decisionBasis;
  }
  let label = ST_BASIS_LABEL[basis] || '';
  if (!label && (basis === 'nav' || basis === undefined) && rec.late) label = '真实净值（旧口径）';
  return label;
}

/** 历史记录口径徽标 */
function stBasisBadge(rec) {
  const label = stBasisLabel(rec);
  return label ? ` <span class="st-basis">${esc(label)}</span>` : '';
}

/** 市场氛围：当天记录里的 market 优先（旧记录可能没有），否则用实时行情 liveMarket */
function stMarketOf(data, rec) {
  if (rec && rec.market) return rec.market;
  if (data && data.liveMarket) return data.liveMarket;
  const snap = data && data.snapshot;
  return (snap && snap.liveMarket) || null;
}

function stMarketBadge(mkt) {
  const verdict = (mkt && mkt.verdict) || '未知';
  const cls = ST_MARKET_CLS[verdict] || 'st-flat';
  return `<span class="st-mkt ${cls}">${esc(verdict)}</span>`;
}

/** 今日建议卡片里的「市场氛围」一行 */
function stMarketRowHtml(data, rec) {
  const mkt = stMarketOf(data, rec);
  if (!mkt) {
    return '<div class="admin-kv st-mkt-row"><span>市场氛围</span><div class="st-mkt-cell muted">今天没有市场氛围数据</div></div>';
  }
  const score = stNum(mkt.score);
  const cnScore = stNum(mkt.cnScore);
  const extScore = stNum(mkt.extScore);
  const head = [stMarketBadge(mkt)];
  if (score !== null) head.push(`综合 <b>${score > 0 ? '+' : ''}${score.toFixed(1)}</b> 分`);
  const sub = [];
  if (cnScore !== null) sub.push(`A股 ${cnScore > 0 ? '+' : ''}${cnScore.toFixed(1)}`);
  if (extScore !== null) sub.push(`外围 ${extScore > 0 ? '+' : ''}${extScore.toFixed(1)}`);
  if (sub.length) head.push(`<span class="muted small">${sub.join(' · ')}</span>`);
  return `<div class="admin-kv st-mkt-row">
    <span>市场氛围</span>
    <div class="st-mkt-cell">
      <div>${head.join(' ')}</div>
      <div class="st-mkt-line">${esc(mkt.summary || 'A股盘面数据暂缺')}</div>
      <div class="st-mkt-line muted">外围：${esc(mkt.ext || '外围数据暂缺')}</div>
      <div class="muted small">加减仓评分已按市场氛围调整（权重见「策略参数」）</div>
    </div>
  </div>`;
}

/* ---------------- 悬停明细 tooltip ---------------- */

function stTipLine(html) { return `<div class="st-tip-line">${html}</div>`; }

/** 注册一条 tooltip，返回可直接拼进标签的 data-st-tip 属性 */
function stTipRegister(key, html) {
  if (!state.strategyTips) state.strategyTips = new Map();
  state.strategyTips.set(String(key), html || '');
  return ` data-st-tip="${esc(key)}"`;
}

/** 所有已评价的条目（records 的 eval.items） */
function stTipEvalRows(data) {
  const rows = [];
  for (const rec of (data.records || [])) {
    const ev = rec && rec.eval;
    for (const it of ((ev && ev.items) || [])) rows.push({ rec, it });
  }
  return rows;
}

/** 列表行 tooltip：日期 名称（代码） 评分 · 建议 → 判定（次日%） */
function stTipItemLine(rec, it) {
  const score = stNum(it.score);
  const scoreText = score === null ? '评分 —' : `评分 ${score}`;
  const next = stNum(it.evalPct) === null ? '次日 —' : `次日 ${stPctHtml(it.evalPct)}`;
  return stTipLine(`${esc(rec.date)} ${esc(it.name)}（${esc(it.code)}） ${esc(scoreText)} · ${ST_ACTION_LABEL[it.action] || esc(it.action)} → ${esc(stVerdictText(it))}（${next}）`);
}

function stTipGroupHtml(title, rows, limit = 20) {
  const parts = [`<b>${esc(title)}（共 ${rows.length} 条）</b>`];
  rows.slice(0, limit).forEach(({ rec, it }) => parts.push(stTipItemLine(rec, it)));
  if (rows.length > limit) parts.push(stTipLine(`…共 ${rows.length} 条`));
  return parts.join('');
}

/** 按动作表某一行：展示这一行的全部建议明细 */
function stActionTipHtml(data, action) {
  const rows = stTipEvalRows(data).filter(({ it }) => it.action === action);
  return stTipGroupHtml(`${ST_ACTION_LABEL[action]}建议明细`, rows);
}

/** 评分区间某一行：展示该区间里的加仓/减仓建议 */
function stScoreTipHtml(data, bucket) {
  const rows = stTipEvalRows(data)
    .filter(({ it }) => (it.action === 'add' || it.action === 'cut') && stBucketOfScore(it.score) === bucket);
  return stTipGroupHtml(`评分区间 ${bucket} 的加仓/减仓建议`, rows);
}

/** 按市场氛围某一行：展示该氛围下记录的建议 */
function stMarketTipHtml(data, verdict) {
  const rows = stTipEvalRows(data)
    .filter(({ rec }) => rec && rec.market && String(rec.market.verdict) === String(verdict));
  return stTipGroupHtml(`市场氛围「${verdict}」下的建议`, rows);
}

/** 历史记录头部 tooltip：日期/来源/口径/分布/命中率/市场氛围/每条明细 */
function stHistoryTipHtml(rec) {
  const c = (rec.snapshot && rec.snapshot.counts) || {};
  const ev = rec.eval;
  const sum = ev && ev.summary;
  const s = stTotals(sum);
  const basis = stBasisLabel(rec);
  const source = rec.source === 'auto' ? '自动' : '手动';
  const parts = [];
  parts.push(`<b>${esc(rec.date)}</b> <span class="muted">${esc(source)}${rec.late ? ' · 收盘后补记' : ''} · ${esc(basis || '口径未标注')}</span>`);
  parts.push(stTipLine(`建议分布：加 ${n(c.add)} · 减 ${n(c.cut)} · 不变 ${n(c.hold)}${c.pending ? ` · 未更新 ${n(c.pending)}` : ''}`));
  if (sum) {
    parts.push(stTipLine(`含中性命中率：<b>${stCoverRate(s.right, s.total)}</b>（对 ${s.right}/${s.total}）`));
    parts.push(stTipLine(`对 ${s.right} · 错 ${s.wrong} · 中性 ${s.flat} · 未评 ${s.skipped} · 共 ${s.total}`));
  } else {
    parts.push(stTipLine('含中性命中率：次日待评价'));
  }
  const mkt = rec.market;
  if (mkt) {
    const score = stNum(mkt.score);
    parts.push(stTipLine(`市场氛围：${stMarketBadge(mkt)}${score === null ? '' : ` 分值 ${score}`}`));
    if (mkt.summary) parts.push(stTipLine(`A股：${esc(mkt.summary)}`));
    if (mkt.ext) parts.push(stTipLine(`外围：${esc(mkt.ext)}`));
  } else {
    parts.push(stTipLine('市场氛围：无（旧记录未采集）'));
  }
  const items = (ev && ev.items) || rec.items || [];
  const limit = 12;
  items.slice(0, limit).forEach((it) => parts.push(stHistoryTipItemLine(it)));
  if (items.length > limit) parts.push(stTipLine(`…共 ${items.length} 条`));
  return parts.join('');
}

function stHistoryTipItemLine(it) {
  const shares = n(it.shares).toLocaleString('zh-CN');
  const target = n(it.targetShares).toLocaleString('zh-CN');
  const next = stNum(it.evalPct) === null ? '次日 —' : `次日 ${stPctHtml(it.evalPct)}`;
  return stTipLine(`${esc(it.name)}（${esc(it.code)}） ${ST_ACTION_LABEL[it.action] || esc(it.action)} ${shares}→${target} ｜ ${esc(stVerdictText(it))} ｜ ${next}`);
}

function stTipMove(ev) {
  const tip = $('#stTip');
  if (!tip || tip.hidden) return;
  const pad = 14;
  const vw = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
  const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 0;
  tip.style.left = `${ev.clientX + pad}px`;
  tip.style.top = `${ev.clientY + pad}px`;
  const rect = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { width: 0, height: 0 };
  if (vw && ev.clientX + pad + rect.width > vw - 8) {
    tip.style.left = `${Math.max(8, ev.clientX - rect.width - pad)}px`;
  }
  if (vh && ev.clientY + pad + rect.height > vh - 8) {
    tip.style.top = `${Math.max(8, ev.clientY - rect.height - pad)}px`;
  }
}

function stTipShow(html, ev) {
  const tip = $('#stTip');
  if (!tip) return;
  tip.innerHTML = html == null ? '' : String(html);
  tip.hidden = false;
  stTipMove(ev || { clientX: 0, clientY: 0 });
}

function stTipHide() {
  const tip = $('#stTip');
  if (!tip) return;
  tip.hidden = true;
  tip.innerHTML = '';
}

/** 全局只绑一次：mouseover 找最近的 [data-st-tip]，mousemove 跟随，mouseout 收起 */
function stTipBind() {
  const hostOf = (ev) => (ev && ev.target && ev.target.closest ? ev.target.closest('[data-st-tip]') : null);
  document.addEventListener('mouseover', (ev) => {
    const host = hostOf(ev);
    if (!host) return;
    const key = host.getAttribute('data-st-tip');
    const html = state.strategyTips && state.strategyTips.get(key);
    if (html) stTipShow(html, ev);
  });
  document.addEventListener('mousemove', (ev) => {
    const tip = $('#stTip');
    if (tip && !tip.hidden) stTipMove(ev);
  });
  document.addEventListener('mouseout', (ev) => {
    const host = hostOf(ev);
    if (!host) return;
    const to = ev.relatedTarget;
    if (to && host.contains && host.contains(to)) return;
    stTipHide();
  });
}

/* ---------------- 策略参数 / 自动调参弹窗 ---------------- */

function stModalOpen(modal) {
  const el = typeof modal === 'string' ? $(modal) : modal;
  if (!el) return;
  el.hidden = false;
  if (document.body) document.body.classList.add('admin-modal-open');
}

function stModalClose(modal) {
  const el = typeof modal === 'string' ? $(modal) : modal;
  if (!el) return;
  el.hidden = true;
  if (document.body) document.body.classList.remove('admin-modal-open');
  // 兜底：还有别的弹窗开着就保持滚动锁
  const stillOpen = $$('.admin-modal').some((m) => m && !m.hidden);
  if (stillOpen && document.body) document.body.classList.add('admin-modal-open');
}

/** 全局只绑一次：两个入口按钮 + 遮罩/× + Esc */
function stModalBind() {
  const openParams = $('#stOpenParams');
  if (openParams) openParams.addEventListener('click', () => stModalOpen('#stParamsModal'));
  const openTune = $('#stOpenTune');
  if (openTune) openTune.addEventListener('click', () => stModalOpen('#stTuneModal'));
  document.addEventListener('click', (ev) => {
    const closer = ev && ev.target && ev.target.closest ? ev.target.closest('[data-st-close]') : null;
    if (!closer) return;
    stModalClose(closer.closest('.admin-modal'));
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const open = $$('.admin-modal').find((m) => m && !m.hidden);
    if (open) stModalClose(open);
  });
}

/** 展开/收起「评分区间 / 按市场氛围」明细 */
function stToggleMore() {
  const body = $('#stMoreBody');
  const btn = $('#stMoreToggle');
  if (!body || !btn) return;
  const expand = body.hidden;
  body.hidden = !expand;
  btn.textContent = expand ? '收起评分区间 / 按市场氛围明细' : '展开评分区间 / 按市场氛围明细';
  btn.setAttribute('aria-expanded', expand ? 'true' : 'false');
}

function renderStrategyToday(data) {
  const rec = data.todayRecord;
  const rows = [];
  rows.push(['记录状态', rec
    ? `已记录 · ${esc(fmtClock(rec.createdAt))}${rec.source === 'auto' ? '（自动）' : '（手动）'}${rec.late ? ' · 收盘后补记' : ''}`
    : '今天还没记录']);
  if (rec) {
    const c = (rec.snapshot && rec.snapshot.counts) || {};
    rows.push(['建议分布', `<span class="st-tag add">加 ${n(c.add)}</span> <span class="st-tag cut">减 ${n(c.cut)}</span> <span class="st-tag hold">不变 ${n(c.hold)}</span>${c.observe ? ` <span class="st-tag skip">观察 ${n(c.observe)}</span>` : ''}${c.pending ? ` <span class="st-tag skip">未更新 ${n(c.pending)}</span>` : ''}`]);
    const mv = rec.snapshot && rec.snapshot.marketValue;
    if (mv) rows.push(['当时市值', `${n(mv).toLocaleString('zh-CN')} 元 · 当日 ${rec.snapshot.portfolioPct === null ? '—' : `${Number(rec.snapshot.portfolioPct).toFixed(2)}%`}`]);
  }
  // 「市场氛围」放最上面：先看大环境，再看当天动作
  $('#stToday').innerHTML = stMarketRowHtml(data, rec) + rows.map(([label, value]) => `
    <div class="admin-kv"><span>${label}</span><b>${value}</b></div>`).join('');

  const time = fmtClock(Date.now());
  $('#stNote').innerHTML = data.isWeekday
    ? `今天是交易日（${esc(data.today)}），14:35 之后会自动记录当天建议；也可以随时手动记录。当前 ${esc(time)}。`
    : `今天不是工作日，不会自动记录；如需留档可手动记录。`;
}

function renderStrategyStats(data) {
  const stats = data.stats || {};
  const overall = stats.overall || {};
  const byAction = stats.byAction || {};
  const ov = stTotals(overall);
  const liveDays = n((data.statsLive || {}).days);
  const bfDays = n((data.statsBackfill || {}).days);
  $('#stHitMeta').textContent = stats.days
    ? `${n(stats.days)} 个交易日 · ${n(stats.items)} 条建议（实盘 ${liveDays} 天 / 回测 ${bfDays} 天）`
    : '还没有可评价的记录';

  // v2.9.1：三列并列——方向性命中率（严格）、覆盖率、中性率。
  // 「不变」中性多不代表策略差，主指标改为方向性命中率，中性率单独展示。
  const strictRate = ov.decided > 0 ? `${((ov.right / ov.decided) * 100).toFixed(0)}%` : '--';
  const coverage = ov.total > 0 ? `${((ov.decided / ov.total) * 100).toFixed(0)}%` : '--';
  const neutral = ov.total > 0 ? `${((ov.flat / ov.total) * 100).toFixed(0)}%` : '--';
  const kpiTip = stTipRegister('kpi',
    '<b>口径说明</b>：方向性命中率 = 对/(对+错)，是策略真实的方向判断力；'
    + '覆盖率 = 可判定/全部；中性率 = 中性/全部（「不变」遇到大波动会记中性，中性多不等于错）。'
    + '<br>自动调参用的是「方向性命中率 × √覆盖率」，并做前后验证。');
  $('#stStats').innerHTML = `<div class="st-kpi"${kpiTip}>
      <span class="st-kpi-label">方向性命中率</span>
      <b class="st-kpi-value">${strictRate}</b>
    </div>
    <div class="st-kpi-sub">
      覆盖率 <b>${coverage}</b> · 中性率 <b>${neutral}</b> · 对 ${ov.right} / 错 ${ov.wrong} / 中性 ${ov.flat} / 未评 ${ov.skipped} · 共 ${ov.total} 条（可判定 ${ov.decided}）
    </div>
    <div class="st-kpi-sub">含中性命中率（对/全部） ${stCoverRate(ov.right, ov.total)}</div>`;

  // 按动作表：最后一列 = 对/条数（含中性口径）
  const actionRows = ST_ACTION_ORDER.map((action) => {
    const s = stTotals(byAction[action]);
    return `<tr${stTipRegister(`row:${action}`, stActionTipHtml(data, action))}>
      <td><span class="st-tag ${action}">${ST_ACTION_LABEL[action]}</span></td>
      <td>${s.total}</td>
      <td class="ok">${s.right}</td>
      <td class="bad">${s.wrong}</td>
      <td>${s.flat}</td>
      <td>${s.skipped}</td>
      <td>${stCoverRate(s.right, s.total)} <span class="st-hit-frac">${s.right}/${s.total}</span></td>
    </tr>`;
  }).join('');
  $('#stActionTable').innerHTML = `<table class="admin-table st-table">
    <thead><tr><th>动作</th><th>条数</th><th>对</th><th>错</th><th>中性</th><th>未评</th><th>含中性命中率</th></tr></thead>
    <tbody>${actionRows}</tbody></table>`;

  // 公式说明：以含中性口径为主，阈值跟着 data.bands 走
  const addBand = stBandVal(data.bands, 'addBand');
  const cutBand = stBandVal(data.bands, 'cutBand');
  const holdBand = stBandVal(data.bands, 'holdBand');
  $('#stHitNote').innerHTML = '方向性命中率 = <b>对 / (对 + 错)</b>；覆盖率 = 可判定/全部；中性率 = 中性/全部。<br>'
    + `判定：加仓 次日涨过 <b>+${addBand}%</b> 算对、跌过 <b>-${addBand}%</b> 算错；`
    + `减仓反之（次日跌过 <b>-${cutBand}%</b> 算对）；`
    + `不变 次日 |涨跌| ≤ <b>按基金自身波动自适应</b>（ATR14% × 0.55，夹在 1.2%~3.0%，没有 ATR 时用 ${holdBand}%）算对，超出记中性。<br>`
    + `样本 = <b>实盘记录 + 回测记录</b>；自动调参用「方向性命中率 × √覆盖率」，前 70% 训练、后 30% 验证，验证不改善不采纳。<br>`
    + `可判定样本不足 ${ST_MIN_SAMPLES} 条的评分区间 / 市场氛围行显示「样本不足」；鼠标停在任意一行可看具体明细。`;

  // 按评分区间（折叠区，仅统计加仓/减仓建议）
  const byScore = stats.byScore || {};
  const scoreKeys = ST_SCORE_ORDER.filter((k) => byScore[k])
    .concat(Object.keys(byScore).filter((k) => !ST_SCORE_ORDER.includes(k)));
  const scoreRows = scoreKeys.map((k) => {
    const s = stTotals(byScore[k]);
    return `<tr${stTipRegister(`score:${k}`, stScoreTipHtml(data, k))}><td>${esc(k)}</td><td>${s.total}</td><td class="ok">${s.right}</td><td class="bad">${s.wrong}</td><td>${s.flat}</td><td>${s.skipped}</td><td>${stCoverRateValue(s.right, s.total, s.decided, ST_MIN_SAMPLES)} <span class="st-hit-frac">${s.right}/${s.total}</span></td></tr>`;
  }).join('');
  const scoreHasData = scoreKeys.some((k) => stTotals(byScore[k]).total > 0);
  $('#stScoreTable').innerHTML = scoreHasData
    ? `<table class="admin-table st-table">
      <thead><tr><th>评分区间</th><th>条数</th><th>对</th><th>错</th><th>中性</th><th>未评</th><th>含中性命中率</th></tr></thead>
      <tbody>${scoreRows}</tbody></table>`
    : '<div class="admin-empty">还没有加仓/减仓建议的评价数据</div>';

  // 按市场氛围（折叠区，没有数据就整块不渲染）
  const byMarket = stats.byMarket || {};
  const marketBlock = $('#stMarketBlock');
  if (marketBlock) {
    const marketKeys = ST_MARKET_ORDER.filter((k) => byMarket[k])
      .concat(Object.keys(byMarket).filter((k) => !ST_MARKET_ORDER.includes(k)));
    const marketKeysWithData = marketKeys.filter((k) => stTotals(byMarket[k]).total > 0);
    marketBlock.hidden = marketKeysWithData.length === 0;
    if (marketKeysWithData.length) {
      const marketRows = marketKeysWithData.map((k) => {
        const s = stTotals(byMarket[k]);
        return `<tr${stTipRegister(`market:${k}`, stMarketTipHtml(data, k))}><td>${stMarketBadge({ verdict: k })}</td><td>${s.total}</td><td class="ok">${s.right}</td><td class="bad">${s.wrong}</td><td>${s.flat}</td><td>${s.skipped}</td><td>${stCoverRateValue(s.right, s.total, s.decided, ST_MIN_SAMPLES)} <span class="st-hit-frac">${s.right}/${s.total}</span></td></tr>`;
      }).join('');
      $('#stMarketTable').innerHTML = `<table class="admin-table st-table">
        <thead><tr><th>市场氛围</th><th>条数</th><th>对</th><th>错</th><th>中性</th><th>未评</th><th>含中性命中率</th></tr></thead>
        <tbody>${marketRows}</tbody></table>`;
    }
  }
}

function renderStrategySuggestions(data) {
  const list = data.suggestions || [];
  $('#stSuggestions').innerHTML = list.length
    ? list.map((s) => `<li class="st-sug ${esc(s.level || 'info')}">${esc(s.text)}</li>`).join('')
    : '<li class="admin-empty">样本还不够，先积累几天记录再看建议</li>';
}

function renderStrategyParams(data) {
  const rules = data.rules || {};
  const bands = data.bands || {};
  for (const [id, key] of ST_RULE_FIELDS) {
    const el = $(`#${id}`);
    if (el) el.value = rules[key] === undefined ? '' : rules[key];
  }
  for (const [id, key] of ST_BAND_FIELDS) {
    const el = $(`#${id}`);
    if (el) el.value = bands[key] === undefined ? '' : bands[key];
  }
}

function renderStrategyHistory(data) {
  const records = data.records || [];
  const srcLabel = state.strategySource === 'live' ? '实盘' : state.strategySource === 'backfill' ? '回测' : '全部';
  $('#stHistoryMeta').textContent = records.length
    ? `最近 ${records.length} 天（${srcLabel}，最多保留 300 天）`
    : '还没有记录';
  if (!records.length) {
    $('#stHistory').innerHTML = '<div class="admin-empty">还没有记录。点上面的「记录今日建议」开始积累，第二天会自动用已公布净值评价。</div>';
    return;
  }
  $('#stHistory').innerHTML = records.map((rec) => {
    const c = (rec.snapshot && rec.snapshot.counts) || {};
    const ev = rec.eval;
    const sum = ev && ev.summary;
    let hitText = '次日待评价';
    if (sum) {
      const s = stTotals(sum);
      hitText = `含中性 ${s.right}/${s.total}(${stCoverRate(s.right, s.total)})${s.flat ? ` · 中性 ${s.flat}` : ''}${s.skipped ? ` · 未评 ${s.skipped}` : ''}`;
    }
    const items = (ev && ev.items) || rec.items || [];
    const detail = items.map((it) => {
      const v = ST_VERDICT[it.verdict] || null;
      // 决策日涨跌：有真实净值（navPct）且与展示口径不同时，用小字补一行「净值 X%」
      const pctVal = stNum(it.pct);
      const navPct = stNum(it.navPct);
      const navHint = navPct !== null && (pctVal === null || Math.abs(navPct - pctVal) >= 0.005)
        ? `<div class="muted small">净值 ${stPctText(navPct)}</div>`
        : '';
      const share = it.action === 'hold' || it.delta === 0
        ? `${n(it.shares).toLocaleString('zh-CN')} 份（不变）`
        : `${n(it.shares).toLocaleString('zh-CN')} → ${n(it.targetShares).toLocaleString('zh-CN')}`;
      return `<tr>
        <td>${esc(it.name)}<div class="t-sub muted">${esc(it.code)}</div></td>
        <td><span class="st-tag ${esc(it.action)}">${ST_ACTION_LABEL[it.action] || esc(it.action)}</span></td>
        <td>${share}</td>
        <td>${stPctHtml(it.pct)}${navHint}</td>
        <td>${stPctHtml(it.evalPct)}</td>
        <td>${v ? `<span class="st-verdict ${v.cls}">${v.icon} ${v.label}</span>` : '<span class="muted">待评价</span>'}</td>
        <td class="st-reason">${esc(it.note || it.reason || '')}</td>
      </tr>`;
    }).join('');

    const tipAttr = stTipRegister(`hist:${rec.date}`, stHistoryTipHtml(rec));
    const observeRows = (rec.observe || []).map((it) => `<tr>
        <td>${esc(it.name)}<div class="t-sub muted">${esc(it.code)}</div></td>
        <td><span class="st-tag ${esc(it.action)}">${ST_ACTION_LABEL[it.action] || esc(it.action)}</span></td>
        <td class="st-reason">${esc(it.reason || '')}</td>
      </tr>`).join('');
    return `<article class="st-day">
      <header class="st-day-head"${tipAttr}>
        <b>${esc(rec.date)}</b>${rec.backfill ? ' <span class="st-tag skip">回测</span>' : ''}${stBasisBadge(rec)}
        <span class="st-tag add">加 ${n(c.add)}</span>
        <span class="st-tag cut">减 ${n(c.cut)}</span>
        <span class="st-tag hold">不变 ${n(c.hold)}</span>
        ${c.observe ? `<span class="st-tag skip">观察 ${n(c.observe)}</span>` : ''}
        ${c.pending ? `<span class="st-tag skip">未更新 ${n(c.pending)}</span>` : ''}
        <span class="st-day-hit">${hitText}</span>
        <button type="button" class="admin-link" data-st-toggle="${esc(rec.date)}">明细</button>
      </header>
      <div class="st-day-body" data-st-body="${esc(rec.date)}" hidden>
        <table class="admin-table st-table">
          <thead><tr><th>基金</th><th>建议</th><th>份额</th><th>决策日涨跌</th><th>次日净值</th><th>判定</th><th>说明</th></tr></thead>
          <tbody>${detail || '<tr><td colspan="7" class="muted">当天没有可给出动作的持仓</td></tr>'}</tbody>
        </table>
        ${observeRows ? `<div class="st-block-head" style="margin-top:8px">观察（有信号但被过滤，未计入命中率）</div>
        <table class="admin-table st-table">
          <thead><tr><th>基金</th><th>原信号</th><th>过滤器说明</th></tr></thead>
          <tbody>${observeRows}</tbody>
        </table>` : ''}
      </div>
    </article>`;
  }).join('');
}

/** 近半年回测卡：上次结果 + 回测命中率 + 按动作表 */
function renderStrategyBackfill(data) {
  const bf = data.backfill || null;
  const st = data.statsBackfill || {};
  const meta = $('#stBfMeta');
  if (meta) {
    meta.textContent = bf
      ? `上次：${bf.from || '--'} → ${bf.to || '--'} · ${n(bf.records)} 天记录 · 覆盖 ${n(bf.days)} 个交易日`
      : '还没有跑过回测';
  }
  const note = $('#stBfNote');
  if (note) {
    note.innerHTML = '回测口径：逐日按现有规则重建 <b>15:00 当日估值</b>（重仓股穿透 / 目标 ETF 穿透），不用收盘后已公布净值；'
      + '技术评分、「加/减/不变」规则、次日判定窗口都与实盘一致，回测记录同样计入命中率与自动调参。'
      + '近似之处：权重复用最新季报、沿用当前份额、市场氛围只按三大指数（历史涨跌家数 / 成交额不可得）。';
  }
  const ov = stTotals(st.overall || {});
  const box = $('#stBfStats');
  if (box) {
    box.innerHTML = st.days
      ? `<div class="st-kpi"><span class="st-kpi-label">回测含中性命中率</span><b class="st-kpi-value">${stCoverRate(ov.right, ov.total)}</b></div>
         <div class="st-kpi-sub">对 ${ov.right} · 错 ${ov.wrong} · 中性 ${ov.flat} · 未评 ${ov.skipped} · 共 ${ov.total} · 可判定 ${ov.decided} 条</div>`
      : '<div class="admin-empty">还没有回测记录，点上面的「回测最近半年」生成</div>';
  }
  const byAction = st.byAction || {};
  const rows = ST_ACTION_ORDER.map((action) => {
    const s = stTotals(byAction[action]);
    return `<tr><td><span class="st-tag ${action}">${ST_ACTION_LABEL[action]}</span></td><td>${s.total}</td><td class="ok">${s.right}</td><td class="bad">${s.wrong}</td><td>${s.flat}</td><td>${s.skipped}</td><td>${stCoverRate(s.right, s.total)} <span class="st-hit-frac">${s.right}/${s.total}</span></td></tr>`;
  }).join('');
  const table = $('#stBfAction');
  if (table) {
    table.innerHTML = st.days
      ? `<table class="admin-table st-table"><thead><tr><th>动作</th><th>条数</th><th>对</th><th>错</th><th>中性</th><th>未评</th><th>含中性命中率</th></tr></thead><tbody>${rows}</tbody></table>`
      : '';
  }
}

async function stBackfill() {
  const btn = $('#stBackfillRun');
  if (!btn) return;
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '回测中（首次可能要 20~40 秒）…';
  try {
    const res = await apiPost('/api/admin/strategy/backfill', { days: 130 }, 180000);
    const tune = res.tune;
    const tuneText = tune && tune.tuned
      ? `；已按新样本调参：${tune.tune.changes.map((c) => `${c.field} ${c.from}→${c.to}`).join('，')}`
      : '';
    const skipText = res.skipped ? `，${n(res.skipped)} 个标的日缺行情已跳过` : '';
    toast(`回测完成：${n(res.records)} 天记录（${res.from || '--'} → ${res.to || '--'}）${skipText}${tuneText}`, 'ok', 8000);
    await loadStrategy();
  } catch (err) {
    toast(`回测失败：${err.message}`, 'err', 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

/* ---- 参数体检（v2.9.1）：历史重放 + 坐标搜索 + 前后验证 ---- */

function stCheckRow(c) {
  const fmt = (v) => (v === null || v === undefined ? '--' : `${(Number(v) * 100).toFixed(1)}%`);
  const obj = (v) => (v === null || v === undefined ? '--' : Number(v).toFixed(2));
  return `<tr class="${c.isBest ? 'st-check-best' : ''}">
    <td><code>${esc(c.field)}</code> ${esc(String(c.from))} → <b>${esc(String(c.to))}</b></td>
    <td class="num">${obj(c.train.objective)}</td>
    <td class="num">${fmt(c.train.hitRate)}<div class="t-sub">${n(c.train.decided)} 条</div></td>
    <td class="num">${obj(c.validate.objective)}</td>
    <td class="num">${fmt(c.validate.hitRate)}<div class="t-sub">${n(c.validate.decided)} 条</div></td>
  </tr>`;
}

function renderStrategyCheck(data) {
  const box = $('#stCheckBody');
  if (!box) return;
  if (!data) {
    box.innerHTML = '<div class="admin-empty">点「体检一次」用历史数据对比参数，不会改任何设置</div>';
    const applyBtn = $('#stCheckApply');
    if (applyBtn) applyBtn.disabled = true;
    return;
  }
  const base = data.baseline || {};
  const best = data.best || null;
  const candidates = (data.candidates || []).slice(0, 6).map((c) => ({
    ...c,
    isBest: best && c.field === best.field && String(c.to) === String(best.to),
  }));
  const meta = $('#stCheckMeta');
  if (meta) {
    const s = data.sample || {};
    meta.textContent = `${s.from || '--'} → ${s.to || '--'} · ${n(s.records)} 天记录 · ${n(s.codes)} 只 · 目标 = 方向性命中率 × √覆盖率`;
  }
  const baseObj = (v) => (v === null || v === undefined ? '--' : Number(v).toFixed(2));
  box.innerHTML = `<div class="admin-kv-list">
      <div class="admin-kv"><span>当前参数（训练 / 验证）</span><b>${baseObj(base.train && base.train.objective)} / ${baseObj(base.validate && base.validate.objective)}</b></div>
      <div class="admin-kv"><span>训练段</span><b>${n(base.train && base.train.decided)} 条可判定 · 方向性命中率 ${base.train && base.train.hitRate !== null ? `${(base.train.hitRate * 100).toFixed(0)}%` : '--'}</b></div>
      <div class="admin-kv"><span>验证段</span><b>${n(base.validate && base.validate.decided)} 条可判定 · 方向性命中率 ${base.validate && base.validate.hitRate !== null ? `${(base.validate.hitRate * 100).toFixed(0)}%` : '--'}</b></div>
    </div>
    ${candidates.length
      ? `<table class="admin-table st-table mt10"><thead><tr><th>候选参数</th><th>训练目标</th><th>训练命中率</th><th>验证目标</th><th>验证命中率</th></tr></thead><tbody>${candidates.map(stCheckRow).join('')}</tbody></table>`
      : '<div class="admin-empty">没有可比较的候选参数</div>'}
    <p class="admin-note">${best
      ? `建议：<b>${esc(best.field)} ${esc(String(best.from))} → ${esc(String(best.to))}</b>（验证段目标 ${baseObj(base.validate && base.validate.objective)} → ${baseObj(best.validate.objective)}，验证命中率 ${best.validate.hitRate !== null ? `${(best.validate.hitRate * 100).toFixed(0)}%` : '--'}）。采纳后会自动记入调参历史，可回滚。`
      : `没有找到「训练与验证同时改善 ≥ ${((data.minDelta || 0.03) * 100).toFixed(0)}%」的参数，说明当前参数在这段历史上已经是较优解；可以等积累更多样本再体检。`}</p>`;
  const applyBtn = $('#stCheckApply');
  if (applyBtn) applyBtn.disabled = !best;
}

async function stCheckRun() {
  const btn = $('#stCheckRun');
  if (!btn) return;
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '体检中（重放历史，约 20~40 秒）…';
  try {
    const data = await apiPost('/api/admin/strategy/tune/search', { days: 130 }, 180000);
    state.strategyCheck = data;
    renderStrategyCheck(data);
    toast(data.best
      ? `体检完成：建议 ${data.best.field} ${data.best.from} → ${data.best.to}`
      : '体检完成：当前参数在训练与验证上都已较优，暂不建议改', data.best ? 'ok' : 'info', 8000);
  } catch (err) {
    toast(`体检失败：${err.message}`, 'err', 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function stCheckApply() {
  const data = state.strategyCheck;
  if (!data || !data.best) { toast('先体检，拿到建议再采纳', 'warn'); return; }
  const best = data.best;
  if (!window.confirm(`采纳参数体检建议：${best.field} 从 ${best.from} 改为 ${best.to}？\n采纳后会记入调参历史，可一键回滚。`)) return;
  const btn = $('#stCheckApply');
  btn.disabled = true;
  try {
    await apiPost('/api/admin/strategy/tune/apply', { field: best.field, to: best.to }, 30000);
    toast(`已采纳建议：${best.field} → ${best.to}`, 'ok');
    state.strategyCheck = null;
    renderStrategyCheck(null);
    await loadStrategy();
  } catch (err) {
    toast(`采纳失败：${err.message}`, 'err');
    btn.disabled = false;
  }
}

function renderStrategyTune(data) {
  const cfg = data.autoTune || {};
  const enabled = $('#stTuneEnabled');
  if (enabled) enabled.value = cfg.enabled === false ? '0' : '1';
  if ($('#stTuneMinSamples')) $('#stTuneMinSamples').value = cfg.minSamples === undefined ? 5 : cfg.minSamples;
  if ($('#stTuneMinHit')) $('#stTuneMinHit').value = cfg.minHitRate === undefined ? 0.5 : cfg.minHitRate;
  if ($('#stTuneStep')) $('#stTuneStep').value = cfg.step === undefined ? 5 : cfg.step;

  const tunes = data.tunes || [];
  const last = tunes[0];
  $('#stTuneMeta').textContent = cfg.enabled === false
    ? '已关闭，只给建议'
    : last
      ? `最近一次：${esc(last.date)}${last.trigger === 'manual' ? '（手动运行）' : '（自动）'}${last.rolledBackAt ? ' · 已回滚' : ''}`
      : '开启，等样本凑够就开始自动调';

  $('#stTuneHistory').innerHTML = tunes.length
    ? tunes.map((t) => {
      const changes = (t.changes || []).map((c) => `${esc(c.field)} ${esc(c.from)} → ${esc(c.to)}（命中 ${(Number(c.hitRate) * 100).toFixed(0)}%，${n(c.samples)} 条样本）`).join('；');
      const rolled = t.rolledBackAt ? ' <span class="st-tag skip">已回滚</span>' : '';
      return `<li class="st-sug ${t.trigger === 'manual' ? 'info' : 'ok'}">${esc(fmtDateTime(t.at))}${t.trigger === 'manual' ? '（手动）' : ''}${rolled} · ${changes || '无变更'}</li>`;
    }).join('')
    : '<li class="admin-empty">还没有自动调参记录</li>';
}

function renderStrategy(data) {
  state.strategy = data;
  state.strategyTips = new Map(); // 每次重渲染都重建 tooltip 索引，避免旧 key 残留
  renderStrategyToday(data);
  renderStrategyStats(data);
  renderStrategySuggestions(data);
  renderStrategyParams(data);
  renderStrategyTune(data);
  renderStrategyBackfill(data);
  renderStrategyCheck(state.strategyCheck);
  renderStrategyHistory(data);
}

async function loadStrategy() {
  try {
    const query = new URLSearchParams({
      limit: '150',
      source: state.strategySource || 'all',
    });
    const data = await api(`/api/admin/strategy?${query.toString()}`, 40000);
    renderStrategy(data);
  } catch (err) {
    $('#stToday').innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
    $('#stNote').textContent = err.message;
  }
}

async function stRecord(force) {
  const btn = force ? $('#stReRecord') : $('#stRecord');
  btn.disabled = true;
  try {
    const res = await apiPost('/api/admin/strategy/record', { force }, 60000);
    if (res.recorded) {
      const c = res.counts || {};
      toast(`已记录 ${res.date}：加 ${n(c.add)} 减 ${n(c.cut)} 不变 ${n(c.hold)}`, 'ok');
    } else {
      toast('今天已经记录过了，需要更新请点「覆盖重记」', 'warn');
    }
    await loadStrategy();
  } catch (err) {
    toast(`记录失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function stEvaluate() {
  const btn = $('#stEvaluate');
  btn.disabled = true;
  try {
    const res = await apiPost('/api/admin/strategy/evaluate', {}, 60000);
    toast(res.evaluated > 0 ? `补评价完成，新评价 ${res.evaluated} 天` : '暂时没有可评价的记录（次日净值还没出）', res.evaluated > 0 ? 'ok' : 'info');
    await loadStrategy();
  } catch (err) {
    toast(`评价失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function stCollectParams() {
  const rules = {};
  const bands = {};
  for (const [id, key] of ST_RULE_FIELDS) {
    const el = $(`#${id}`);
    if (el) rules[key] = Number(el.value);
  }
  for (const [id, key] of ST_BAND_FIELDS) {
    const el = $(`#${id}`);
    if (el) bands[key] = Number(el.value);
  }
  return { rules, bands };
}

async function stSave() {
  const btn = $('#stSave');
  btn.disabled = true;
  try {
    const res = await apiPost('/api/admin/strategy/config', stCollectParams(), 30000);
    renderStrategyParams({ rules: res.rules, bands: res.bands });
    toast('参数已保存，推送与记录立即生效', 'ok');
    await loadStrategy();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function stReset() {
  for (const [id, key] of ST_RULE_FIELDS) {
    const el = $(`#${id}`);
    if (el) el.value = ST_DEFAULT_RULES[key];
  }
  for (const [id, key] of ST_BAND_FIELDS) {
    const el = $(`#${id}`);
    if (el) el.value = ST_DEFAULT_BANDS[key];
  }
  toast('已填入默认值，记得点「保存参数」', 'info');
}

async function stTuneSave() {
  const btn = $('#stTuneSave');
  btn.disabled = true;
  try {
    const autoTune = {
      enabled: $('#stTuneEnabled').value === '1',
      minSamples: Number($('#stTuneMinSamples').value),
      minHitRate: Number($('#stTuneMinHit').value),
      step: Number($('#stTuneStep').value),
    };
    const res = await apiPost('/api/admin/strategy/auto-tune', { autoTune }, 30000);
    toast(`自动调参已${res.autoTune.enabled ? '开启' : '关闭'}`, 'ok');
    await loadStrategy();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function stTuneRun() {
  const btn = $('#stTuneRun');
  btn.disabled = true;
  try {
    const res = await apiPost('/api/admin/strategy/auto-tune', { run: true, force: true }, 60000);
    if (res.tuned) {
      const list = res.tune.changes.map((c) => `${c.field} ${c.from}→${c.to}`).join('，');
      toast(`已自动调参：${list}`, 'ok');
    } else {
      toast(`本次没有调整：${res.reason || '样本不足或命中率达标'}`, 'info');
    }
    await loadStrategy();
  } catch (err) {
    toast(`运行失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function stTuneRollback() {
  if (!window.confirm('把上一次自动调参改掉的评分门槛改回去？')) return;
  const btn = $('#stTuneRollback');
  btn.disabled = true;
  try {
    const res = await apiPost('/api/admin/strategy/rollback', {}, 30000);
    if (res.ok) toast('已回滚上一次自动调参', 'ok');
    else toast(res.reason === 'no-tune-history' ? '没有可回滚的调参记录' : '回滚失败', 'warn');
    await loadStrategy();
  } catch (err) {
    toast(`回滚失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function bindStrategy() {
  $('#stRefresh').addEventListener('click', () => loadStrategy());
  $('#stRecord').addEventListener('click', () => stRecord(false));
  $('#stReRecord').addEventListener('click', () => {
    if (window.confirm('用今天各持仓基金的 15:00 当日估值重新评估并覆盖今天的记录？不会使用已公布的真实净值。已经做过的次日评价不受影响。')) stRecord(true);
  });
  $('#stEvaluate').addEventListener('click', stEvaluate);
  $('#stSave').addEventListener('click', stSave);
  $('#stReset').addEventListener('click', stReset);
  $('#stTuneSave').addEventListener('click', stTuneSave);
  $('#stTuneRun').addEventListener('click', stTuneRun);
  $('#stTuneRollback').addEventListener('click', stTuneRollback);
  const bfBtn = $('#stBackfillRun');
  if (bfBtn) bfBtn.addEventListener('click', stBackfill);
  const checkBtn = $('#stCheckRun');
  if (checkBtn) checkBtn.addEventListener('click', stCheckRun);
  const checkApply = $('#stCheckApply');
  if (checkApply) checkApply.addEventListener('click', stCheckApply);
  // 历史记录来源切换：实盘 / 回测 / 全部（回测记录多，方便对照）
  $$('#stHistorySource [data-st-source]').forEach((btn) => btn.addEventListener('click', () => {
    state.strategySource = btn.dataset.stSource || 'all';
    $$('#stHistorySource [data-st-source]').forEach((b) => b.classList.toggle('is-active', b === btn));
    loadStrategy();
  }));
  const moreToggle = $('#stMoreToggle');
  if (moreToggle) moreToggle.addEventListener('click', stToggleMore);
  // 明细展开/收起（列表是动态渲染的，用事件委托）
  $('#stHistory').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-st-toggle]');
    if (!btn) return;
    const date = btn.getAttribute('data-st-toggle');
    const body = $('[data-st-body="' + date + '"]');
    if (body) body.hidden = !body.hidden;
  });
}

/* ---------------- 模拟交易（v2.9.0） ----------------
   管理员可以：改全局初始资金、把用户排除出排行榜（黑名单）、
   查看任意用户的模拟持仓、按指定初始资金重置某个账户。
   --------------------------------------------------- */

async function loadPaper() {
  try {
    const data = await api('/api/admin/paper', 30000);
    state.paper = data;
    renderPaperAdmin(data);
  } catch (err) {
    const box = $('#paperUsers');
    if (box) box.innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
  }
}

function renderPaperAdmin(data) {
  const cfg = data.config || {};
  const users = data.users || [];
  const totals = data.totals || {};
  const cards = $('#paperCards');
  if (cards) {
    renderCards(cards, [
      { label: '模拟账户', value: n(totals.users), sub: `已交易 ${n(totals.traded)} 个` },
      { label: '排行榜隐藏', value: n(totals.hidden), sub: '黑名单（仍可自己交易）' },
      { label: '全局初始资金', value: n(cfg.initial).toLocaleString('zh-CN'), sub: '新账号 / 重置用', tone: 'accent' },
      { label: '累计增量资金', value: n(totals.injected || 0).toLocaleString('zh-CN'), sub: '本金 = 初始 + 追加' },
      { label: '未结委托', value: n(totals.activeOrders || 0), sub: '限价单等待成交' },
      { label: '条件单 / 计划', value: `${n(totals.conditions || 0)} / ${n(totals.plans || 0)}`, sub: '止盈止损 + 网格定投' },
      { label: '跟单关系', value: n(totals.followers || 0), sub: '被跟单人收到的订阅' },
      { label: '除权事件', value: n(totals.corporate || 0), sub: '分红除权记账' },
    ]);
  }
  const initialInput = $('#paperInitial');
  if (initialInput && document.activeElement !== initialInput) initialInput.value = String(n(cfg.initial));
  // v2.12.0：费率 / 规则 / 委托有效期回填（正在编辑的输入框不覆盖）
  const fees = cfg.fees || {};
  const feeFields = [
    ['#paperFeeRate', Number(fees.rate || 0) * 10000, 2],
    ['#paperFeeMin', Number(fees.min || 0), 0],
    ['#paperTaxRate', Number(fees.taxRate || 0) * 10000, 2],
    ['#paperSlippage', Number(fees.slippageBps || 0), 0],
  ];
  for (const [sel, val, digits] of feeFields) {
    const el = $(sel);
    if (el && document.activeElement !== el) el.value = String(Number(val.toFixed(digits)));
  }
  const trading = cfg.trading || {};
  for (const [sel, val] of [['#paperTradingT1', trading.t1], ['#paperTradingLimit', trading.limitCheck], ['#paperTradingSuspend', trading.suspend]]) {
    const el = $(sel);
    if (el) el.checked = val !== false;
  }
  const validDays = $('#paperOrderValidDays');
  if (validDays && document.activeElement !== validDays) validDays.value = String(n((cfg.order || {}).validDays || 1));
  const tradingHint = $('#paperTradingHint');
  if (tradingHint) {
    tradingHint.textContent = `当前：T+1 ${trading.t1 === false ? '关' : '开'} · 涨跌停校验 ${trading.limitCheck === false ? '关' : '开'} · 停牌拦截 ${trading.suspend === false ? '关' : '开'} · 限价单默认 ${n((cfg.order || {}).validDays || 1)} 个交易日内有效`;
  }
  const feeHint = $('#paperFeesHint');
  if (feeHint) {
    feeHint.textContent = `当前：佣金 ${(Number(fees.rate || 0) * 10000).toFixed(2)} 万（最低 ${n(fees.min || 0)} 元）· 卖出印花税 ${(Number(fees.taxRate || 0) * 10000).toFixed(2)} 万 · 滑点 ${n(fees.slippageBps || 0)} bp（只影响市价单）`;
  }
  renderPaperCapitalBatches(cfg.capitalBatches || []);
  renderPaperDividendList(data.corporateEvents || []);
  const meta = $('#paperMeta');
  if (meta) {
    meta.textContent = `${users.length} 个用户 · 隐藏 ${n(totals.hidden)} 个 · 初始资金 ${n(cfg.initial).toLocaleString('zh-CN')} 元 · 未结委托 ${n(totals.activeOrders || 0)} 笔 · 持仓取价：${data.estimated ? '部分按成本估算' : '实时'}`;
  }
  const rows = users.map((u) => {
    const profit = Number(u.profit) || 0;
    const tone = profit > 0 ? 'ok' : profit < 0 ? 'bad' : '';
    return `<tr>
      <td><b>${esc(u.username)}</b>${u.primary ? ' <span class="admin-badge admin">主账号</span>' : ''}</td>
      <td><button type="button" class="admin-btn ${u.hidden ? '' : 'primary'}" data-paper-hide="${esc(u.id)}" data-hidden="${u.hidden ? '1' : '0'}">${u.hidden ? '已隐藏' : '进排行榜'}</button></td>
      <td class="num">${n(u.initial).toLocaleString('zh-CN')}</td>
      <td class="num">${n(u.injected || 0).toLocaleString('zh-CN')}</td>
      <td class="num">${n(u.principal || u.initial).toLocaleString('zh-CN')}</td>
      <td class="num">${n(u.cash).toLocaleString('zh-CN')}</td>
      <td class="num">${n(u.marketValue).toLocaleString('zh-CN')}</td>
      <td class="num">${n(u.total).toLocaleString('zh-CN')}</td>
      <td class="num ${tone}">${profit > 0 ? '+' : ''}${n(profit).toLocaleString('zh-CN')}<br><small class="muted">${n(u.profitPct).toFixed(2)}%</small></td>
      <td class="num">${n(u.positionCount)}</td>
      <td class="num muted">${n(u.orderCount || 0)} / ${(u.conditions || []).filter((c) => c.status === 'active').length} / ${(u.plans || []).filter((p) => p.status === 'active').length}<br><small class="muted">挂单 / 条件 / 计划${u.followers ? ` · 跟 ${n(u.followers)}` : ''}</small></td>
      <td class="nowrap muted">${u.updatedAt ? esc(fmtClock(u.updatedAt)) : '未交易'}</td>
      <td class="ops">
        <button type="button" class="admin-btn" data-paper-view="${esc(u.id)}">查看持仓</button>
        <button type="button" class="admin-btn danger" data-paper-reset="${esc(u.id)}" data-name="${esc(u.username)}" data-initial="${n(u.initial)}">重置</button>
      </td>
    </tr>`;
  }).join('');
  const box = $('#paperUsers');
  if (box) {
    box.innerHTML = `<table class="admin-table"><thead><tr>
      <th>用户</th><th>排行榜</th><th>初始资金</th><th>累计追加</th><th>本金</th><th>可用资金</th><th>持仓市值</th><th>总资产</th><th>累计盈亏</th><th>持仓数</th><th>自动化</th><th>最近操作</th><th>操作</th>
    </tr></thead><tbody>${rows || '<tr><td colspan="13"><div class="admin-empty">还没有用户</div></td></tr>'}</tbody></table>`;
  }
  $$('[data-paper-hide]').forEach((btn) => btn.addEventListener('click', () => togglePaperHidden(btn.getAttribute('data-paper-hide'))));
  $$('[data-paper-view]').forEach((btn) => btn.addEventListener('click', () => showPaperDetail(btn.getAttribute('data-paper-view'))));
  $$('[data-paper-reset]').forEach((btn) => btn.addEventListener('click', () => resetPaperUser(
    btn.getAttribute('data-paper-reset'),
    btn.getAttribute('data-name'),
    Number(btn.getAttribute('data-initial')) || n(cfg.initial),
  )));
}

/** 切换某用户是否进入排行榜（黑名单 = 不显示） */
async function togglePaperHidden(id) {
  const data = state.paper || {};
  const cfg = data.config || {};
  const hidden = new Set(cfg.hiddenUserIds || []);
  const user = (data.users || []).find((u) => u.id === id);
  if (!user) return;
  if (hidden.has(id)) {
    hidden.delete(id);
  } else {
    if (!window.confirm(`把「${user.username}」从排行榜隐藏？他仍然可以正常模拟交易，只是别人看不到他的账户。`)) return;
    hidden.add(id);
  }
  try {
    await apiPost('/api/admin/paper/config', { hiddenUserIds: [...hidden] }, 20000);
    toast(hidden.has(id) ? `已把「${user.username}」从排行榜隐藏` : `已让「${user.username}」重新进入排行榜`, 'ok');
    await loadPaper();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

async function savePaperInitial() {
  const input = $('#paperInitial');
  if (!input) return;
  const initial = Number(input.value);
  if (!Number.isFinite(initial) || initial < 10000 || initial > 100000000) {
    toast('初始资金需在 10,000 ~ 100,000,000 元之间', 'warn');
    return;
  }
  const btn = $('#paperSaveInitial');
  btn.disabled = true;
  try {
    await apiPost('/api/admin/paper/config', { initial }, 20000);
    toast(`全局初始资金已改为 ${initial.toLocaleString('zh-CN')} 元（只影响新账号与后续重置）`, 'ok');
    await loadPaper();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- v2.12.0：费率 / 交易规则 / 分红除权 ---------------- */

async function savePaperFees() {
  const rate = Number($('#paperFeeRate') ? $('#paperFeeRate').value : 0) / 10000;
  const min = Number($('#paperFeeMin') ? $('#paperFeeMin').value : 0);
  const taxRate = Number($('#paperTaxRate') ? $('#paperTaxRate').value : 0) / 10000;
  const slippageBps = Number($('#paperSlippage') ? $('#paperSlippage').value : 0);
  if (!Number.isFinite(rate) || rate < 0 || rate > 0.01) { toast('佣金率需在 0 ~ 100（万分）之间', 'warn'); return; }
  if (!Number.isFinite(min) || min < 0 || min > 100) { toast('最低佣金需在 0 ~ 100 元之间', 'warn'); return; }
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 0.02) { toast('印花税需在 0 ~ 200（万分）之间', 'warn'); return; }
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 100) { toast('滑点需在 0 ~ 100 bp 之间', 'warn'); return; }
  const btn = $('#paperSaveFees');
  if (btn) btn.disabled = true;
  try {
    await apiPost('/api/admin/paper/config', { fees: { rate, min, taxRate, slippageBps } }, 20000);
    toast('费率已保存（对新的成交生效）', 'ok');
    await loadPaper();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function savePaperTrading() {
  const t1 = $('#paperTradingT1') ? $('#paperTradingT1').checked : true;
  const limitCheck = $('#paperTradingLimit') ? $('#paperTradingLimit').checked : true;
  const suspend = $('#paperTradingSuspend') ? $('#paperTradingSuspend').checked : true;
  const validDays = Number($('#paperOrderValidDays') ? $('#paperOrderValidDays').value : 1);
  if (!Number.isFinite(validDays) || validDays < 1 || validDays > 30) { toast('有效期需在 1 ~ 30 个交易日之间', 'warn'); return; }
  const btn = $('#paperSaveTrading');
  if (btn) btn.disabled = true;
  try {
    await apiPost('/api/admin/paper/config', { trading: { t1, limitCheck, suspend }, order: { validDays } }, 20000);
    toast(`交易规则已保存：T+1 ${t1 ? '开' : '关'} · 涨跌停 ${limitCheck ? '开' : '关'} · 停牌 ${suspend ? '开' : '关'}`, 'ok');
    await loadPaper();
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderPaperDividendList(events) {
  const box = $('#paperDivList');
  if (!box) return;
  const list = Array.isArray(events) ? events : [];
  if (!list.length) {
    box.innerHTML = '<div class="admin-empty">还没有分红除权事件</div>';
    return;
  }
  const rows = list.slice().reverse().map((e) => `<tr>
    <td><b>${esc(e.name || e.code || e.secid)}</b><br><small class="muted">${esc(e.secid)}</small></td>
    <td class="nowrap">${esc(e.exDate || '')}</td>
    <td class="num">${n(e.cashPerShare).toFixed(4)}</td>
    <td class="num">${n(e.shareRatio).toFixed(2)}</td>
    <td class="muted">${esc(e.note || '')}</td>
    <td class="ops"><button type="button" class="admin-btn danger" data-paper-div-del="${esc(e.id)}">删除</button></td>
  </tr>`).join('');
  box.innerHTML = `<table class="admin-table"><thead><tr><th>标的</th><th>除权日</th><th>每股现金分红</th><th>每 10 股送转</th><th>备注</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
  $$('[data-paper-div-del]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!window.confirm('删除这条分红除权事件？已经入账的历史记录不会回滚。')) return;
    btn.disabled = true;
    try {
      await apiPost('/api/admin/paper/dividends/remove', { id: btn.getAttribute('data-paper-div-del') }, 20000);
      toast('已删除', 'ok');
      await loadPaper();
    } catch (err) {
      toast(`删除失败：${err.message}`, 'err');
      btn.disabled = false;
    }
  }));
}

async function addPaperDividend() {
  const rawCode = String($('#paperDivCode') ? $('#paperDivCode').value : '').trim();
  if (!rawCode) { toast('填标的代码（600519 或 1.600519）', 'warn'); return; }
  // 只给 6 位代码时按沪深规则补 secid：6 开头沪市，其余深市
  const secid = /^\d+\.[0-9A-Za-z]+$/.test(rawCode)
    ? rawCode
    : (/^[0-9]{6}$/.test(rawCode) ? `${/^(6|9|5)/.test(rawCode) ? '1' : '0'}.${rawCode}` : '');
  if (!secid) { toast('标的不合法：填 6 位代码或带市场的 secid（如 1.600519）', 'warn'); return; }
  const exDate = String($('#paperDivExDate') ? $('#paperDivExDate').value : '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate)) { toast('选除权除息日', 'warn'); return; }
  const cashPerShare = Number($('#paperDivCash') ? $('#paperDivCash').value : 0);
  const shareRatio = Number($('#paperDivRatio') ? $('#paperDivRatio').value : 0);
  if (!(cashPerShare >= 0) || !(shareRatio >= 0) || (cashPerShare === 0 && shareRatio === 0)) {
    toast('每股现金分红和送转股至少填一项（可填 0）', 'warn');
    return;
  }
  const btn = $('#paperDivAdd');
  if (btn) btn.disabled = true;
  try {
    await apiPost('/api/admin/paper/dividends', {
      secid,
      code: secid.split('.')[1] || '',
      name: String($('#paperDivName') ? $('#paperDivName').value : '').trim(),
      exDate,
      cashPerShare,
      shareRatio,
      note: `每 10 股送转 ${shareRatio} 股 / 每股派 ${cashPerShare} 元`,
    }, 20000);
    toast('已新增分红除权事件，除权日会按持仓自动入账', 'ok');
    if ($('#paperDivCode')) $('#paperDivCode').value = '';
    if ($('#paperDivName')) $('#paperDivName').value = '';
    if ($('#paperDivCash')) $('#paperDivCash').value = '';
    if ($('#paperDivRatio')) $('#paperDivRatio').value = '';
    await loadPaper();
  } catch (err) {
    toast(`新增失败：${err.message}`, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------------- 增量资金（v2.11.0） ----------------
   给全部账户各加等额资金：现金 +amount、本金 = 初始 + 累计追加；
   累计盈亏不被抬高，收益率分母同步变大。批次重复提交幂等。
   --------------------------------------------------- */

let paperCapitalPendingId = '';

function renderPaperCapitalBatches(batches) {
  const box = $('#paperCapitalBatches');
  if (!box) return;
  const list = Array.isArray(batches) ? batches : [];
  if (!list.length) {
    box.innerHTML = '<div class="admin-empty">还没有增量资金记录</div>';
    return;
  }
  const rows = list.slice().reverse().map((b) => `<tr>
    <td class="nowrap muted">${esc(fmtClock(b.at))}</td>
    <td class="num">+${n(b.amount).toLocaleString('zh-CN')}</td>
    <td class="num">${n(b.users)} 个</td>
    <td class="num">${n(b.total).toLocaleString('zh-CN')}</td>
    <td>${b.onlyTraded ? '仅已有模拟记录' : '全部账户'}</td>
    <td class="muted">${esc(b.note || '—')}${b.by ? ` · ${esc(b.by)}` : ''}</td>
  </tr>`).join('');
  box.innerHTML = `<table class="admin-table"><thead><tr><th>时间</th><th>每户增加</th><th>账户数</th><th>合计</th><th>范围</th><th>备注 / 操作者</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function submitPaperCapital() {
  const amountInput = $('#paperCapitalAmount');
  const noteInput = $('#paperCapitalNote');
  const onlyTraded = $('#paperCapitalOnlyTraded') ? $('#paperCapitalOnlyTraded').checked : false;
  const amount = Number(amountInput ? amountInput.value : 0);
  if (!Number.isFinite(amount) || amount < 1000 || amount > 100000000) {
    toast('每个账户增加的金额需在 1,000 ~ 100,000,000 元之间', 'warn');
    return;
  }
  const note = String(noteInput ? noteInput.value : '').slice(0, 60);
  const cmd = $('#paperCapitalBtn');
  const text = `确定给${onlyTraded ? '已有模拟记录的' : '全部'}账户各增加 ${amount.toLocaleString('zh-CN')} 元？\n\n现金与本金同步增加，累计盈亏不会被抬高；该操作不可撤销。`;
  if (!window.confirm(text)) return;
  // 同一批次只生成一次 id：超时 / 重试复用，服务端幂等，不会重复加钱
  if (!paperCapitalPendingId) paperCapitalPendingId = `cap-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const batchId = paperCapitalPendingId;
  if (cmd) { cmd.disabled = true; cmd.textContent = '提交中…'; }
  const hint = $('#paperCapitalHint');
  if (hint) hint.textContent = '正在给目标账户增加资金，请稍候（提交期间不要关闭页面）…';
  try {
    const res = await apiPost('/api/admin/paper/inject', { amount, note, onlyTraded, batchId }, 60000);
    paperCapitalPendingId = '';
    toast(res.duplicate
      ? '该批次已经执行过，本次未重复加钱'
      : `已给 ${n(res.users)} 个账户各增加 ${n(res.amount).toLocaleString('zh-CN')} 元（合计 ${n(res.total).toLocaleString('zh-CN')} 元）`, 'ok');
    await loadPaper();
  } catch (err) {
    // 结果未知时保留 batchId：再点一次「给全部账户增加」会带同一批次号重试
    if (hint) hint.textContent = `提交失败：${err.message}。如不确定是否已执行，可直接再点一次（同一批次会按幂等处理）。`;
    toast(`增量资金失败：${err.message}`, 'err');
  } finally {
    if (cmd) { cmd.disabled = false; cmd.textContent = '给全部账户增加'; }
  }
}

async function resetPaperUser(id, name, currentInitial) {
  const raw = window.prompt(`把「${name}」的模拟账户清空并按初始资金重开。输入初始资金（元）：`, String(currentInitial || 1000000));
  if (raw === null) return;
  const initial = Number(raw);
  if (!Number.isFinite(initial) || initial < 10000 || initial > 100000000) {
    toast('初始资金需在 10,000 ~ 100,000,000 元之间', 'warn');
    return;
  }
  try {
    await apiPost('/api/admin/paper/reset', { id, initial }, 30000);
    toast(`已重置「${name}」的模拟盘（初始 ${initial.toLocaleString('zh-CN')} 元）`, 'ok');
    await loadPaper();
  } catch (err) {
    toast(`重置失败：${err.message}`, 'err');
  }
}

function showPaperDetail(id) {
  const data = state.paper || {};
  const user = (data.users || []).find((u) => u.id === id);
  const wrap = $('#paperDetailWrap');
  const box = $('#paperDetail');
  if (!user || !wrap || !box) return;
  const title = $('#paperDetailTitle');
  if (title) title.textContent = `${user.username} 的模拟持仓`;
  const rows = (user.positions || []).map((p) => `<tr>
    <td><span class="t-name">${esc(p.name || p.code)}</span><span class="t-code">${esc(p.code)}</span></td>
    <td class="num">${n(p.shares).toLocaleString('zh-CN')}</td>
    <td class="num">${n(p.cost).toFixed(3)}</td>
    <td class="num">${n(p.price).toFixed(3)}</td>
    <td class="num">${n(p.marketValue).toLocaleString('zh-CN')}</td>
    <td class="num ${p.profit > 0 ? 'ok' : p.profit < 0 ? 'bad' : ''}">${p.profit > 0 ? '+' : ''}${n(p.profit).toLocaleString('zh-CN')}</td>
    <td class="num">${p.profitPct === null || p.profitPct === undefined ? '--' : `${n(p.profitPct).toFixed(2)}%`}</td>
    <td class="num ${p.realizedAmount > 0 ? 'ok' : p.realizedAmount < 0 ? 'bad' : ''}">${p.realizedAmount ? `${p.realizedAmount > 0 ? '+' : ''}${n(p.realizedAmount).toLocaleString('zh-CN')}` : '--'}</td>
  </tr>`).join('');
  const orderRows = (user.orders || []).slice(0, 8).map((o) => `<tr>
    <td class="nowrap muted">${o.createdAt ? esc(fmtClock(o.createdAt)) : '--'}</td>
    <td>${esc(o.name || o.code || '')}<br><small class="muted">${esc(o.code || '')}</small></td>
    <td>${o.side === 'buy' ? '买' : '卖'}</td>
    <td>${o.type === 'limit' ? `限价 ${n(o.limitPrice).toFixed(3)}` : '市价'}</td>
    <td class="num">${n(o.filledShares)} / ${n(o.shares)}</td>
    <td>${esc(o.status || '')}${o.lastCheck && o.lastCheck.reason ? `<br><small class="muted">${esc(o.lastCheck.reason)}</small>` : ''}</td>
  </tr>`).join('');
  const condCount = (user.conditions || []).filter((c) => c.status === 'active').length;
  const planCount = (user.plans || []).filter((p) => p.status === 'active').length;
  box.innerHTML = `<div class="admin-kv-list">
      <div class="admin-kv"><span>初始资金 / 累计追加 / 本金</span><b>${n(user.initial).toLocaleString('zh-CN')} / ${n(user.injected || 0).toLocaleString('zh-CN')} / ${n(user.principal || user.initial).toLocaleString('zh-CN')} 元</b></div>
      <div class="admin-kv"><span>可用资金</span><b>${n(user.cash).toLocaleString('zh-CN')} 元</b></div>
      <div class="admin-kv"><span>持仓市值 / 总资产</span><b>${n(user.marketValue).toLocaleString('zh-CN')} / ${n(user.total).toLocaleString('zh-CN')} 元</b></div>
      <div class="admin-kv"><span>累计盈亏</span><b>${user.profit > 0 ? '+' : ''}${n(user.profit).toLocaleString('zh-CN')} 元（${n(user.profitPct).toFixed(2)}%）</b></div>
      <div class="admin-kv"><span>自动化</span><b>未结委托 ${n(user.orderCount || 0)} 笔 · 条件单 ${n(condCount)} 条 · 计划 ${n(planCount)} 个 · 跟单 ${n(user.followers || 0)} 人${user.allowFollow === false ? ' · 已关闭跟单' : ''}</b></div>
      ${(user.periods && user.periods.todayPct !== null) ? `<div class="admin-kv"><span>今日 / 本月 / 今年</span><b>${user.periods.todayPct === null ? '--' : `${user.periods.todayPct.toFixed(2)}%`} / ${user.periods.monthPct === null ? '--' : `${user.periods.monthPct.toFixed(2)}%`} / ${user.periods.yearPct === null ? '--' : `${user.periods.yearPct.toFixed(2)}%`} · 最大回撤 ${user.periods.mdd === null ? '--' : `${user.periods.mdd.toFixed(2)}%`}</b></div>` : ''}
    </div>
    ${rows ? `<table class="admin-table"><thead><tr><th>标的</th><th>份额</th><th>成本</th><th>现价</th><th>市值</th><th>浮盈</th><th>收益率</th><th>已实现</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="admin-empty">该账户当前空仓</div>'}
    ${orderRows ? `<h3 class="mt12">最近委托</h3><table class="admin-table"><thead><tr><th>时间</th><th>标的</th><th>方向</th><th>类型</th><th>成交 / 委托</th><th>状态</th></tr></thead><tbody>${orderRows}</tbody></table>` : ''}
    ${(user.corporate || []).length ? `<h3 class="mt12">分红除权入账</h3><table class="admin-table"><thead><tr><th>除权日</th><th>现金</th><th>股数变化</th><th>备注</th></tr></thead><tbody>${user.corporate.map((c) => `<tr><td>${esc(c.exDate || '')}</td><td class="num">+${n(c.cash).toLocaleString('zh-CN')}</td><td class="num">${n(c.sharesBefore)} → ${n(c.sharesAfter)}</td><td class="muted">${esc(c.note || '')}</td></tr>`).join('')}</tbody></table>` : ''}`;
  wrap.hidden = false;
  wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function bindPaper() {
  const save = $('#paperSaveInitial');
  if (save) save.addEventListener('click', savePaperInitial);
  const capital = $('#paperCapitalBtn');
  if (capital) capital.addEventListener('click', submitPaperCapital);
  // v2.12.0：费率 / 交易规则 / 分红除权
  const feeBtn = $('#paperSaveFees');
  if (feeBtn) feeBtn.addEventListener('click', savePaperFees);
  const ruleBtn = $('#paperSaveTrading');
  if (ruleBtn) ruleBtn.addEventListener('click', savePaperTrading);
  const divBtn = $('#paperDivAdd');
  if (divBtn) divBtn.addEventListener('click', addPaperDividend);
  // 改了金额 / 范围 / 备注就当成新的批次，避免沿用上一次的 batchId 被幂等吞掉
  ['#paperCapitalAmount', '#paperCapitalNote', '#paperCapitalOnlyTraded'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', () => { paperCapitalPendingId = ''; });
    el.addEventListener('change', () => { paperCapitalPendingId = ''; });
  });
  const close = $('#paperDetailClose');
  if (close) close.addEventListener('click', () => { const wrap = $('#paperDetailWrap'); if (wrap) wrap.hidden = true; });
}

/* ---------------- 持仓保存历史 / 本机 ⇄ NAS 数据互通（v2.9.2） ----------------
   背景：本机与线上 NAS 是两套 data/，用户在一边改的持仓另一边看不到；
   以前同步失败也没有任何提示。这里把「每次保存的快照」和「两边单向同步」
   做成两个可操作的卡片，先解释再动手，每次操作都留痕。
   -------------------------------------------------------------------------- */

async function loadPortfolioUsers(force = false) {
  if (!force && state.portfolioUsers && Date.now() - (state.portfolioUsersAt || 0) < 30000) {
    return state.portfolioUsers;
  }
  const data = await api('/api/admin/users');
  state.portfolioUsers = data.users || [];
  state.portfolioUsersAt = Date.now();
  return state.portfolioUsers;
}

function fillPortfolioUserSelect(sel, users) {
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = users
    .map((u) => `<option value="${esc(u.id)}">${esc(u.username)}${u.primary ? '（主账号）' : ''}</option>`)
    .join('');
  if (prev && users.some((u) => u.id === prev)) sel.value = prev;
}

/* ---------------- 持仓删除历史（v2.10.5） ----------------
   用户删掉「我的持仓」里的一个 TAB 或其中一只基金时，服务端只记录
   被删的那个 TAB（TAB 名称 + 基金 / 份额 / 成本 / 建仓日）。这里按 TAB
   展示删除记录，「详情」看当时的 TAB 数据，「恢复」按原状态写回。
   旧版本记录没有建仓日的，统一按 LEGACY_ADDED_DATE（2026-11-01）显示 / 恢复（v2.10.7）。
   -------------------------------------------------------------------------- */
// 与服务端 lib/store.js 的 LEGACY_ADDED_AT、前端 core.js 的 LEGACY_ADDED_DATE 保持一致
const LEGACY_ADDED_DATE = '2026-11-01';

function fmtDayOnly(ts) {
  if (!ts) return '-';
  try {
    return new Date(Number(ts)).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
  } catch { return String(ts); }
}

async function loadDeletionHistory() {
  const sel = $('#phUser');
  const box = $('#phList');
  const meta = $('#phMeta');
  if (!box) return;
  try {
    const users = await loadPortfolioUsers();
    fillPortfolioUserSelect(sel, users);
    const uid = (sel && sel.value) || (users[0] && users[0].id);
    if (!uid) {
      box.innerHTML = '<div class="admin-empty">还没有账号</div>';
      return;
    }
    if (sel && !sel.value) sel.value = uid;
    const pendingOnly = $('#phPending') && $('#phPending').checked ? '&pending=1' : '';
    const data = await api(`/api/admin/portfolio/deletions?userId=${encodeURIComponent(uid)}${pendingOnly}`);
    const items = data.items || [];
    const pending = items.filter((it) => !it.restoredAt).length;
    if (meta) {
      meta.textContent = `${data.user.username} · ${items.length} 条删除记录（待恢复 ${pending}）· 留档 ${data.retentionDays || 365} 天`;
    }
    if (!items.length) {
      box.innerHTML = `<div class="admin-empty">${pendingOnly ? '没有待恢复的删除记录' : '还没有删除记录（用户删除「我的持仓」里的 TAB / 基金后会出现在这里）'}</div>`;
      return;
    }
    const fundTable = (funds) => `<table class="admin-table admin-trash-snap"><thead><tr><th>基金</th><th>代码</th><th>份额</th><th>成本净值</th><th>建仓日</th></tr></thead><tbody>${(funds || []).map((f) => `<tr>
      <td>${esc(f.name || f.code)}</td>
      <td class="muted">${esc(f.code)}</td>
      <td class="num">${n(f.shares).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</td>
      <td class="num">${f.cost ? Number(f.cost).toFixed(4) : '-'}</td>
      <td class="nowrap">${f.addedAt ? esc(fmtDayOnly(f.addedAt)) : `<span title="旧版本没记录建仓日：恢复时统一按 ${LEGACY_ADDED_DATE} 写回">${LEGACY_ADDED_DATE}<span class="muted">（旧记录默认）</span></span>`}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">没有基金记录</td></tr>'}</tbody></table>`;
    box.innerHTML = `<table class="admin-table"><thead><tr>
        <th>删除时间</th><th>TAB 名称</th><th>删除类型</th><th>基金数</th><th>状态</th><th>操作</th>
      </tr></thead><tbody>${items.map((it) => {
        const tabName = it.portfolioName || (it.portfolioId === 'default' ? '主持仓' : it.portfolioId);
        const funds = Array.isArray(it.funds) ? it.funds : [];
        const tabFunds = Array.isArray(it.tabHoldings) ? it.tabHoldings : [];
        const count = Number(it.tabHoldingCount) || tabFunds.length || funds.length;
        const showTabFunds = tabFunds.length > 0 && (it.tabDeleted || tabFunds.length !== funds.length);
        return `<tr>
        <td class="nowrap">${esc(fmtClock(it.deletedAt))}</td>
        <td>${esc(tabName)}</td>
        <td>${it.tabDeleted ? '整个 TAB' : '单只基金'}</td>
        <td class="num">${count}</td>
        <td>${it.restoredAt ? `<span class="muted">已恢复 ${esc(fmtClock(it.restoredAt))}</span>` : '<span class="tone-up">待恢复</span>'}</td>
        <td class="nowrap">
          <button type="button" class="admin-btn" data-del-detail="${esc(it.id)}">详情</button>
          ${it.restoredAt ? '' : `<button type="button" class="admin-btn" data-del-restore="${esc(it.id)}" data-tab="${esc(tabName)}" data-count="${count}">恢复</button>`}
        </td>
      </tr>
      <tr class="admin-del-detail" data-del-detail-row="${esc(it.id)}" hidden><td colspan="6">
        <div class="admin-trash-detail-head">「${esc(tabName)}」· 删除于 ${esc(fmtClock(it.deletedAt))}${it.tabDeleted ? ' · 整个 TAB 被删除' : ''}</div>
        <div class="admin-del-section">本次删除的${it.tabDeleted ? ' TAB 数据' : '持仓'}（${funds.length} 只）</div>
        ${fundTable(funds)}
        ${showTabFunds ? `<div class="admin-del-section">删除时该 TAB 下的全部持仓（${tabFunds.length} 只，恢复时按这份写回）</div>${fundTable(tabFunds)}` : ''}
      </td></tr>`;
      }).join('')}</tbody></table>`;
    $$('[data-del-detail]', box).forEach((btn) => btn.addEventListener('click', () => {
      const row = box.querySelector(`[data-del-detail-row="${btn.getAttribute('data-del-detail')}"]`);
      if (row) row.hidden = !row.hidden;
    }));
    $$('[data-del-restore]', box).forEach((btn) => btn.addEventListener('click', () => {
      restoreDeletionEventEntry(uid, btn.getAttribute('data-del-restore'), btn.getAttribute('data-tab'), Number(btn.getAttribute('data-count')) || 0);
    }));
  } catch (err) {
    box.innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
  }
}

async function restoreDeletionEventEntry(userId, id, tabName, count) {
  if (!window.confirm(`按删除前的状态恢复「${tabName || '这个 TAB'}」（${count || 0} 只基金）？\n会保留原来的份额 / 成本 / 建仓日，盈亏统计仍从原建仓日开始（旧记录没有建仓日的按 ${LEGACY_ADDED_DATE} 恢复）；TAB 已被删除的会按原名称重建；现在已经有持仓的基金会跳过。`)) return;
  try {
    const out = await apiPost('/api/admin/portfolio/deletions/restore', { userId, id }, 30000);
    toast(out.message || '已恢复', 'ok', 6000);
    await loadDeletionHistory();
  } catch (err) {
    toast(`恢复失败：${err.message}`, 'err', 6000);
  }
}

async function transferPortfolioData(direction) {
  const sel = $('#ptUser');
  const result = $('#ptResult');
  try {
    const users = await loadPortfolioUsers();
    fillPortfolioUserSelect(sel, users);
    const uid = (sel && sel.value) || (users[0] && users[0].id);
    if (!uid) { toast('还没有账号', 'warn'); return; }
    const mode = ($('#ptMode') && $('#ptMode').value) || 'merge';
    const label = direction === 'pull' ? 'NAS → 本机' : '本机 → NAS';
    const modeText = mode === 'replace' ? '整体覆盖（以来源为准）' : '合并（推荐）';
    if (!window.confirm(`${label}\n账号：${sel.options[sel.selectedIndex].textContent}\n模式：${modeText}\n\n操作前后都会留备份/快照，继续？`)) return;
    if (result) result.textContent = '正在执行…（首次连接 NAS 可能需要 10~30 秒）';
    const out = await apiPost('/api/admin/portfolio/transfer', { direction, userId: uid, mode }, 180000);
    if (result) result.textContent = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${out.message || '完成'}`;
    toast(out.message || '数据互通完成', 'ok', 5000);
    await loadDeletionHistory();
  } catch (err) {
    if (result) result.textContent = `失败：${err.message}`;
    toast(`数据互通失败：${err.message}`, 'err', 7000);
  }
}

function bindPortfolioCards() {
  const sel = $('#phUser');
  if (sel && !sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', loadDeletionHistory);
  }
  const reload = $('#phReload');
  if (reload && !reload.dataset.bound) {
    reload.dataset.bound = '1';
    reload.addEventListener('click', loadDeletionHistory);
  }
  const pending = $('#phPending');
  if (pending && !pending.dataset.bound) {
    pending.dataset.bound = '1';
    pending.addEventListener('change', loadDeletionHistory);
  }
  const push = $('#ptPush');
  if (push && !push.dataset.bound) {
    push.dataset.bound = '1';
    push.addEventListener('click', () => transferPortfolioData('push'));
  }
  const pull = $('#ptPull');
  if (pull && !pull.dataset.bound) {
    pull.dataset.bound = '1';
    pull.addEventListener('click', () => transferPortfolioData('pull'));
  }
}

/** 切到「持仓数据」页（v2.9.3 从模拟交易拆出）：先填账号下拉，再拉删除历史。
    之前「数据互通」卡的账号下拉要等点了按钮才填，刚进页面是空的，这次一并补上。 */
async function loadDataOps() {
  await loadDeletionHistory();
  try {
    const users = await loadPortfolioUsers();
    fillPortfolioUserSelect($('#ptUser'), users);
  } catch (err) {
    const box = $('#ptResult');
    if (box) box.textContent = `账号列表读取失败：${err.message}`;
  }
}

function bindDataOps() {
  bindPortfolioCards();
}

/* ---------------- 界面管理（v2.10.0） ---------------- */

const UI_FUND_MODULES = [
  ['sector', '板块资金', 'ETF 主力净流入 + 资金主线 + 板块明细'],
  ['theme', '板块总览', '基金主题按当日涨跌 / 连涨天数排序，点开看当日分时与历史走势'],
  ['dist', '基金涨跌分布', '上涨 / 下跌家数与分档柱状图、净值日'],
  ['openfund', '场外基金', '涨幅榜 / 跌幅榜 / 热门榜 / ETF 榜，含基金比较'],
  ['openflow', '场外资金流', '基金季报申购赎回（用户反馈参考性不强，默认隐藏）'],
  ['proxy', '每日代理', '目标 ETF 资金流按规模分摊（默认隐藏）'],
  ['flow', 'ETF 资金流', 'ETF 当日主力净流入明细（默认隐藏）'],
  ['stock', '股票型基金', '股票 / 指数 / 混合型基金排行与情报（默认隐藏）'],
  ['bond', '债基', '债券型基金排行（默认隐藏）'],
];
const UI_FUND_DEFAULTS = {
  sector: true, theme: true, dist: true, openfund: true,
  openflow: false, proxy: false, flow: false, stock: false, bond: false,
};

function renderUiModules() {
  const box = $('#uiModules');
  if (!box) return;
  const cfg = (state.uiConfig && state.uiConfig.fundModules) || UI_FUND_DEFAULTS;
  box.innerHTML = UI_FUND_MODULES.map(([key, label, desc]) => `
    <label class="admin-row admin-ui-row">
      <span><b>${esc(label)}</b><small>${esc(desc)}</small></span>
      <input type="checkbox" data-ui-module="${esc(key)}" ${cfg[key] !== false ? 'checked' : ''}>
    </label>`).join('');
}

async function loadUi() {
  const box = $('#uiModules');
  if (box) box.innerHTML = '<div class="admin-empty">加载中…</div>';
  try {
    const data = await api('/api/ui/config', 12000);
    state.uiConfig = data;
    renderUiModules();
    if ($('#uiMeta')) {
      $('#uiMeta').textContent = data.updatedAt
        ? `最后保存 ${new Date(data.updatedAt).toLocaleString('zh-CN', { hour12: false })}`
        : '尚未保存过（当前为代码内置默认）';
    }
  } catch (err) {
    if (box) box.innerHTML = `<div class="admin-empty">读取失败：${esc(err.message)}</div>`;
  }
}

async function saveUi(fundModules) {
  const patch = fundModules || {};
  if (!fundModules) {
    $$('[data-ui-module]').forEach((el) => { patch[el.dataset.uiModule] = el.checked; });
  }
  const btn = $('#uiSave');
  if (btn) btn.disabled = true;
  try {
    const data = await apiPost('/api/admin/ui/config', { fundModules: patch }, 15000);
    state.uiConfig = data.config;
    renderUiModules();
    if ($('#uiMeta')) $('#uiMeta').textContent = `已保存 ${new Date(data.config.updatedAt).toLocaleString('zh-CN', { hour12: false })}`;
    toast('界面设置已保存，前端刷新后生效', 'ok');
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function bindUi() {
  $('#uiSave') && $('#uiSave').addEventListener('click', () => saveUi());
  $('#uiReset') && $('#uiReset').addEventListener('click', () => saveUi({ ...UI_FUND_DEFAULTS }));
}

/* ---------------- 启动 ---------------- */

function bindChrome() {
  $('#adminLoginForm').addEventListener('submit', doLogin);
  $('#adminLogout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.replace('/admin.html');
  });
  $$('#adminNav button').forEach((btn) => btn.addEventListener('click', () => switchSection(btn.dataset.sec)));
  $$('[data-goto-sec]').forEach((btn) => btn.addEventListener('click', () => switchSection(btn.dataset.gotoSec)));
  $('#adminRefresh').addEventListener('click', () => loadSection(state.section));
  bindLogs();
  bindDeploy();
  bindStrategy();
  bindPaper();
  bindDataOps();
  bindUi();
  stTipBind();
  stModalBind();
  setInterval(() => {
    if (state.section === 'logins') loadLogins();
    else if (state.section === 'stats') loadStats();
  }, 60000);
}

bindChrome();
checkSession();
