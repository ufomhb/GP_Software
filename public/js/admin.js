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
      body: JSON.stringify({ username, password }),
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
    system: '系统状态', logs: '系统日志', deploy: '部署到 NAS', strategy: '持仓策略', push: '定时推送', source: '数据源', net: '手机访问', changelog: '更新履历',
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
    push: loadPush,
    source: loadSource,
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
      <th>时间</th><th>用户</th><th>动作</th><th>结果</th><th>IP</th><th>说明</th>
    </tr></thead><tbody>${logins.map((item) => `
      <tr>
        <td class="nowrap">${esc(fmtClock(item.at))}</td>
        <td>${esc(item.username || '-')}</td>
        <td>${esc(ACTION_LABELS[item.action] || item.action || '-')}</td>
        <td>${item.ok ? '<span class="admin-badge ok">成功</span>' : '<span class="admin-badge fail">失败</span>'}</td>
        <td class="num">${esc(item.ip || '-')}</td>
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
          <div><b>${esc(item.username)}</b><br><small>${esc(item.ip || '')} · ${esc(item.ua || '').slice(0, 46)}</small></div>
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

/* ---------------- 更新履历 ---------------- */

async function loadChangelog() {
  try {
    const data = await api('/api/changelog', 15000);
    const versions = data.versions || [];
    $('#changelogList').innerHTML = versions.length
      ? versions.map((v) => `<div class="admin-version">
          <div class="admin-version-head"><b>v${esc(v.version)}</b><span>${esc(v.date || '')}</span><strong>${esc(v.title || '')}</strong></div>
          <ul>${(v.items || []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
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
const ST_BASIS_LABEL = { estimate: '15:00 估值', 'estimate-repaired': '估值（已修正）' };
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

/** 严格命中率 = 对/(对+错)；minSamples>0 且可判定样本不足时明确写「样本不足」 */
function stHitRate(right, decided, minSamples = 0) {
  if (!decided) return '—';
  if (minSamples && decided < minSamples) return '样本不足';
  return `${Math.round((right / decided) * 100)}%`;
}

/** 含中性口径 = 对/总条数（中性计入分母、不算对） */
function stCoverRate(right, total) {
  return total ? `${Math.round((right / total) * 100)}%` : '—';
}

/** 评价阈值：优先用接口给的 data.bands，缺字段时退回默认口径 */
function stBandVal(bands, key) {
  const v = stNum(bands && bands[key]);
  return v === null ? ST_DEFAULT_BANDS[key] : v;
}

/** 历史记录口径徽标（决策日用什么涨跌口径） */
function stBasisBadge(rec) {
  if (!rec) return '';
  let basis = rec.decisionBasis;
  if (!basis && Array.isArray(rec.items)) {
    const hit = rec.items.find((it) => it && it.decisionBasis);
    if (hit) basis = hit.decisionBasis;
  }
  let label = ST_BASIS_LABEL[basis] || '';
  if (!label && (basis === 'nav' || basis === undefined) && rec.late) label = '真实净值（旧口径）';
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

function renderStrategyToday(data) {
  const rec = data.todayRecord;
  const rows = [];
  rows.push(['记录状态', rec
    ? `已记录 · ${esc(fmtClock(rec.createdAt))}${rec.source === 'auto' ? '（自动）' : '（手动）'}${rec.late ? ' · 收盘后补记' : ''}`
    : '今天还没记录']);
  if (rec) {
    const c = (rec.snapshot && rec.snapshot.counts) || {};
    rows.push(['建议分布', `<span class="st-tag add">加 ${n(c.add)}</span> <span class="st-tag cut">减 ${n(c.cut)}</span> <span class="st-tag hold">不变 ${n(c.hold)}</span>${c.pending ? ` <span class="st-tag skip">未更新 ${n(c.pending)}</span>` : ''}`]);
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
  $('#stHitMeta').textContent = stats.days
    ? `${n(stats.days)} 个交易日 · ${n(stats.items)} 条建议`
    : '还没有可评价的记录';

  // 顶部两行：严格口径（对/(对+错)）与含中性口径（对/总条数），都列全 对/错/中性/未评/共
  const kv = (label, value) => `<div class="admin-kv"><span>${label}</span><b>${value}</b></div>`;
  const plain = `对 ${ov.right} / 错 ${ov.wrong} / 中性 ${ov.flat} / 未评 ${ov.skipped} / 共 ${ov.total}`;
  $('#stStats').innerHTML = kv('严格命中率',
    `${stHitRate(ov.right, ov.decided)} <span class="muted small">对/(对+错) · ${plain}</span>`)
    + kv('含中性口径',
      `${stCoverRate(ov.right, ov.total)} <span class="muted small">对/总条数 · ${plain}（中性计入分母、不算对）</span>`);

  // 按动作表：严格命中率旁标出「对/可判定」
  const actionRows = ST_ACTION_ORDER.map((action) => {
    const s = stTotals(byAction[action]);
    return `<tr>
      <td><span class="st-tag ${action}">${ST_ACTION_LABEL[action]}</span></td>
      <td>${s.total}</td>
      <td class="ok">${s.right}</td>
      <td class="bad">${s.wrong}</td>
      <td>${s.flat}</td>
      <td>${s.skipped}</td>
      <td>${stHitRate(s.right, s.decided)} <span class="st-hit-frac">${s.right}/${s.decided}</span></td>
    </tr>`;
  }).join('');
  $('#stActionTable').innerHTML = `<table class="admin-table st-table">
    <thead><tr><th>动作</th><th>条数</th><th>对</th><th>错</th><th>中性</th><th>未评</th><th>严格命中率</th></tr></thead>
    <tbody>${actionRows}</tbody></table>`;

  // 公式说明：阈值跟着 data.bands 走，规则调整后说明同步变化
  const addBand = stBandVal(data.bands, 'addBand');
  const cutBand = stBandVal(data.bands, 'cutBand');
  const holdBand = stBandVal(data.bands, 'holdBand');
  $('#stHitNote').innerHTML = '口径：'
    + `<b>加仓</b> → 次日估值/净值涨过 <b>+${addBand}%</b> 算对、跌过 <b>-${addBand}%</b> 算错；`
    + `<b>减仓</b> 反之 → 次日跌过 <b>-${cutBand}%</b> 算对、涨过 <b>+${cutBand}%</b> 算错；`
    + `<b>不变</b> → 次日 |涨跌| ≤ <b>${holdBand}%</b> 算对，超出记中性（不判对也不判错）。`
    + `严格命中率 = 对/(对+错)，中性/未评不进分母；「条数」= 该组建议总条数（含中性/未评）；`
    + `可判定样本不足 ${ST_MIN_SAMPLES} 条时命中率显示「样本不足」。`;

  // 按评分区间：看「评分门槛」是否定得合理（只统计加仓/减仓建议）
  const byScore = stats.byScore || {};
  const scoreKeys = ST_SCORE_ORDER.filter((k) => byScore[k])
    .concat(Object.keys(byScore).filter((k) => !ST_SCORE_ORDER.includes(k)));
  const scoreRows = scoreKeys.map((k) => {
    const s = stTotals(byScore[k]);
    return `<tr><td>${esc(k)}</td><td>${s.total}</td><td class="ok">${s.right}</td><td class="bad">${s.wrong}</td><td>${s.flat}</td><td>${s.skipped}</td><td>${stHitRate(s.right, s.decided, ST_MIN_SAMPLES)} <span class="st-hit-frac">${s.right}/${s.decided}</span></td></tr>`;
  }).join('');
  const scoreHasData = scoreKeys.some((k) => stTotals(byScore[k]).total > 0);
  $('#stScoreTable').innerHTML = scoreHasData
    ? `<table class="admin-table st-table">
      <thead><tr><th>评分区间</th><th>条数</th><th>对</th><th>错</th><th>中性</th><th>未评</th><th>严格命中率</th></tr></thead>
      <tbody>${scoreRows}</tbody></table>`
    : '<div class="admin-empty">还没有加仓/减仓建议的评价数据</div>';

  // 按市场氛围：没有数据就整块不渲染
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
        return `<tr><td>${stMarketBadge({ verdict: k })}</td><td>${s.total}</td><td class="ok">${s.right}</td><td class="bad">${s.wrong}</td><td>${s.flat}</td><td>${s.skipped}</td><td>${stHitRate(s.right, s.decided, ST_MIN_SAMPLES)} <span class="st-hit-frac">${s.right}/${s.decided}</span></td></tr>`;
      }).join('');
      $('#stMarketTable').innerHTML = `<table class="admin-table st-table">
        <thead><tr><th>市场氛围</th><th>条数</th><th>对</th><th>错</th><th>中性</th><th>未评</th><th>严格命中率</th></tr></thead>
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
  $('#stHistoryMeta').textContent = records.length ? `最近 ${records.length} 天（最多保留 300 天）` : '还没有记录';
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
      hitText = `严格 ${s.right}/${s.decided} · 中性 ${s.flat} · 含中性 ${s.right}/${s.total}(${stCoverRate(s.right, s.total)})${s.skipped ? ` · 未评 ${s.skipped}` : ''}`;
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

    return `<article class="st-day">
      <header class="st-day-head">
        <b>${esc(rec.date)}</b>${stBasisBadge(rec)}
        <span class="st-tag add">加 ${n(c.add)}</span>
        <span class="st-tag cut">减 ${n(c.cut)}</span>
        <span class="st-tag hold">不变 ${n(c.hold)}</span>
        ${c.pending ? `<span class="st-tag skip">未更新 ${n(c.pending)}</span>` : ''}
        <span class="st-day-hit">${hitText}</span>
        <button type="button" class="admin-link" data-st-toggle="${esc(rec.date)}">明细</button>
      </header>
      <div class="st-day-body" data-st-body="${esc(rec.date)}" hidden>
        <table class="admin-table st-table">
          <thead><tr><th>基金</th><th>建议</th><th>份额</th><th>决策日涨跌</th><th>次日净值</th><th>判定</th><th>说明</th></tr></thead>
          <tbody>${detail || '<tr><td colspan="7" class="muted">当天没有可给出动作的持仓</td></tr>'}</tbody>
        </table>
      </div>
    </article>`;
  }).join('');
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
  renderStrategyToday(data);
  renderStrategyStats(data);
  renderStrategySuggestions(data);
  renderStrategyParams(data);
  renderStrategyTune(data);
  renderStrategyHistory(data);
}

async function loadStrategy() {
  try {
    const data = await api('/api/admin/strategy', 30000);
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
  // 明细展开/收起（列表是动态渲染的，用事件委托）
  $('#stHistory').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-st-toggle]');
    if (!btn) return;
    const date = btn.getAttribute('data-st-toggle');
    const body = $('[data-st-body="' + date + '"]');
    if (body) body.hidden = !body.hidden;
  });
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
  setInterval(() => {
    if (state.section === 'logins') loadLogins();
    else if (state.section === 'stats') loadStats();
  }, 60000);
}

bindChrome();
checkSession();
