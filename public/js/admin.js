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
  role: '角色变更', kick: '强制下线', clear: '清空日志',
};

const state = {
  me: null,
  section: 'overview',
  statsDays: 14,
  loginsLoaded: false,
  users: [],
  chartSeries: [],
};

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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
  $$('#adminNav button').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.sec === section));
  $$('.admin-section').forEach((sec) => sec.classList.toggle('is-active', sec.id === `sec-${section}`));
  const titles = {
    overview: '概览', users: '用户管理', logins: '登录记录', stats: '使用统计',
    system: '系统状态', push: '定时推送', source: '数据源', net: '手机访问', changelog: '更新履历',
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
      ['最近部署', sys.deployedAt || '-', ''],
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
      box.innerHTML = `<div class="admin-empty">GitHub API 不可达（网络限制）。<a href="${esc(sys.repo || 'https://github.com/ufomhb/GP_Software')}" target="_blank" rel="noreferrer">直接打开仓库 →</a></div>`;
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
  setInterval(() => {
    if (state.section === 'logins') loadLogins();
    else if (state.section === 'stats') loadStats();
  }, 60000);
}

bindChrome();
checkSession();
