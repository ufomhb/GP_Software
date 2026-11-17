'use strict';
/**
 * HTTP 路由分发（P2 从 server.js 外移，2026-11-15）
 *
 * 只做「路径 → 处理函数」的分发：鉴权、管理员、行情/数据接口三组。
 * 所有数据能力由 createHttpRoutes(deps) 注入，模块本身不读文件、不碰数据库。
 *
 * 依赖约定：deps 里的每一项都必须是 server.js 的顶层绑定；
 * 少传一个会在启动时抛 ReferenceError（而不是等到某个接口 500）。
 */
function createHttpRoutes(deps) {
  const {
    ALLOW_REGISTER,
    FUND_SORT_MAP,
    HOST,
    LOGIN_FAIL_LIMIT,
    LOGIN_FAIL_WINDOW,
    PORT,
    PUSH_FILE,
    ROLE_RANK,
    SECTOR_PERIODS,
    STATS_FILE,
    STATS_ONLINE_WINDOW,
    STOCK_FUND_TYPES,
    STORE_MODE,
    VERSION,
    accessUrls,
    analyze,
    applySourceConfig,
    clientIp,
    crypto,
    currentUser,
    dataStore,
    deployToNas,
    dropSession,
    estimateFundDayPctBatch,
    fetchFundMNFInfo,
    fetchQuoteList,
    flushStats,
    fs,
    getAdvice,
    getBattle,
    getChangelog,
    getChinaDistribution,
    getCsi300FundRatio,
    getDailyProxyBoard,
    getEtfFlow,
    getFlow,
    getFundCompare,
    getFundDetail,
    getFundHoldingsHistory,
    getFundMetrics,
    getFundSearch,
    getFundSectorFlow,
    getFundWarnings,
    getFundWatch,
    getHotFunds,
    getIndexCompare,
    getIndexPeriods,
    getIntraday,
    getKline,
    getLadder,
    getMetalsIntraday,
    getMoneyMoves,
    getNews,
    getOpenFundFlow,
    getOverview,
    getRank,
    getSearch,
    getSectorConfirm,
    getSectorExport,
    getSectorMembers,
    getSectorPeriod,
    getSectors,
    getStock,
    getStockFundDetail,
    getStockFundRank,
    getStockFundSectors,
    getSystemStatus,
    getTenDay,
    getTimelineData,
    getUSDashboard,
    getUSDistribution,
    getUsMinutes,
    getWatchlist,
    hashPassword,
    invalidateUserSessions,
    inviteMatches,
    isSuperUser,
    issueSession,
    lanAddresses,
    lastDateKeys,
    loadPortfolio,
    loadUsers,
    loginFails,
    loginKey,
    logsStore,
    num,
    probeSource,
    publicUser,
    recordLoginEvent,
    recordViewPing,
    registerAllowed,
    requireAdmin,
    requireSuper,
    resolveFundTodayPct,
    roleOf,
    runSource,
    sanitizePortfolio,
    savePortfolio,
    saveUsers,
    shanghaiToday,
    sourceStatus,
    statsDateKey,
    statsForDayUser,
    statsStore,
    topIpOf,
    userDataFile,
    userStatsSummary,
    verifyPassword,
  } = deps;

function handleAuth(req, res, url) {
  const p = url.pathname;
  if (p === '/api/auth/me') {
    const user = currentUser(req);
    return { ok: true, user: user ? publicUser(user) : null };
  }
  if (p === '/api/auth/register') {
    if (req.method !== 'POST') throw Object.assign(new Error('方法不允许'), { status: 405 });
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!/^[\w\u4e00-\u9fa5.-]{3,20}$/.test(username)) {
      throw Object.assign(new Error('用户名需为 3-20 位中文、字母、数字、下划线、点或横线'), { status: 400 });
    }
    if (password.length < 6 || password.length > 64) {
      throw Object.assign(new Error('密码长度需为 6-64 位'), { status: 400 });
    }
    const store = loadUsers();
    // P0：注册默认关闭；空库时允许创建第一个账号（bootstrap），之后需要 ALLOW_REGISTER=1 或邀请码。
    if (store.users.length > 0) {
      if (!ALLOW_REGISTER) {
        throw Object.assign(new Error('注册已关闭，请联系管理员开通账号'), { status: 403 });
      }
      if (!inviteMatches(body.invite)) {
        throw Object.assign(new Error('邀请码不正确'), { status: 403 });
      }
      if (!registerAllowed(req)) {
        throw Object.assign(new Error('注册过于频繁，请稍后再试'), { status: 429 });
      }
    }
    if (store.users.some((u) => String(u.username).toLowerCase() === username.toLowerCase())) {
      throw Object.assign(new Error('该用户名已被注册'), { status: 409 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: `u${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      username,
      salt,
      hash: hashPassword(password, salt),
      primary: store.users.length === 0,
      role: store.users.length === 0 ? 'admin' : 'user',
      createdAt: new Date().toISOString(),
    };
    store.users.push(user);
    saveUsers(store);
    // 主账号沿用推送配置里的持仓；其它账号从空白开始。
    if (!user.primary) savePortfolio(user, { funds: [], holdings: {}, watchlist: [] });
    issueSession(req, res, user);
    recordLoginEvent(req, { user, ok: true, action: 'register' });
    return { ok: true, user: publicUser(user) };
  }
  if (p === '/api/auth/login') {
    if (req.method !== 'POST') throw Object.assign(new Error('方法不允许'), { status: 405 });
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const ip = clientIp(req);
    const failKey = loginKey(req, username);
    const fail = loginFails.get(failKey);
    if (fail && Number(fail.until) > Date.now()) {
      const mins = Math.ceil((fail.until - Date.now()) / 60000);
      throw Object.assign(new Error(`尝试次数过多，请 ${mins} 分钟后再试`), { status: 429 });
    }
    const store = loadUsers();
    const user = store.users.find((u) => String(u.username).toLowerCase() === username.toLowerCase());
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      const fresh = fail && fail.since > Date.now() - LOGIN_FAIL_WINDOW ? fail : { count: 0, since: Date.now() };
      fresh.count = Number(fresh.count || 0) + 1;
      fresh.until = fresh.count >= LOGIN_FAIL_LIMIT ? Date.now() + LOGIN_FAIL_WINDOW : 0;
      loginFails.set(failKey, fresh);
      recordLoginEvent(req, { user: user || null, username, ok: false, action: 'login', reason: '用户名或密码错误' });
      throw Object.assign(new Error('用户名或密码错误'), { status: 401 });
    }
    loginFails.delete(failKey);
    user.lastLoginAt = new Date().toISOString();
    user.lastLoginIp = ip;
    user.loginCount = (Number(user.loginCount) || 0) + 1;
    saveUsers(store);
    issueSession(req, res, user);
    recordLoginEvent(req, { user, ok: true, action: 'login' });
    return { ok: true, user: publicUser(user) };
  }
  // 登录页的「修改密码」：校验旧密码后重设，并让该账号所有旧会话失效。
  if (p === '/api/auth/password') {
    if (req.method !== 'POST') throw Object.assign(new Error('方法不允许'), { status: 405 });
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const oldPassword = String(body.oldPassword || '');
    const newPassword = String(body.newPassword || '');
    const ip = clientIp(req);
    const failKey = loginKey(req, username);
    const fail = loginFails.get(failKey);
    if (fail && Number(fail.until) > Date.now()) {
      const mins = Math.ceil((fail.until - Date.now()) / 60000);
      throw Object.assign(new Error(`尝试次数过多，请 ${mins} 分钟后再试`), { status: 429 });
    }
    if (!username) throw Object.assign(new Error('请填写用户名'), { status: 400 });
    if (newPassword.length < 6 || newPassword.length > 64) {
      throw Object.assign(new Error('新密码长度需为 6-64 位'), { status: 400 });
    }
    const store = loadUsers();
    const user = store.users.find((u) => String(u.username).toLowerCase() === username.toLowerCase());
    if (!user || !verifyPassword(oldPassword, user.salt, user.hash)) {
      const fresh = fail && fail.since > Date.now() - LOGIN_FAIL_WINDOW ? fail : { count: 0, since: Date.now() };
      fresh.count = Number(fresh.count || 0) + 1;
      fresh.until = fresh.count >= LOGIN_FAIL_LIMIT ? Date.now() + LOGIN_FAIL_WINDOW : 0;
      loginFails.set(failKey, fresh);
      recordLoginEvent(req, { user: user || null, username, ok: false, action: 'password', reason: '原密码不正确' });
      throw Object.assign(new Error('用户名或原密码不正确'), { status: 400 });
    }
    if (verifyPassword(newPassword, user.salt, user.hash)) {
      throw Object.assign(new Error('新密码不能与原密码相同'), { status: 400 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    user.salt = salt;
    user.hash = hashPassword(newPassword, salt);
    user.updatedAt = new Date().toISOString();
    saveUsers(store);
    invalidateUserSessions(user.id);
    loginFails.delete(failKey);
    recordLoginEvent(req, { user, ok: true, action: 'password' });
    return { ok: true, username: user.username };
  }
  if (p === '/api/auth/logout') {
    dropSession(req, res);
    return { ok: true };
  }
  throw Object.assign(new Error('未知接口'), { status: 404 });
}

async function handleAdmin(req, res, url) {
  const actor = requireAdmin(req);
  const actorRank = ROLE_RANK[roleOf(actor)];
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/admin/users' && req.method === 'GET') {
    const todayKey = statsDateKey();
    const cutoff = Date.now() - STATS_ONLINE_WINDOW;
    const users = loadUsers().users
      .map((u) => {
        const today = statsForDayUser(todayKey, u.id);
        const week = userStatsSummary(u.id, 7);
        return {
          ...publicUser(u),
          lastLoginIp: u.lastLoginIp || '',
          today: today
            ? {
                requests: Number(today.requests) || 0,
                bytes: Number(today.bytes) || 0,
                activeMs: Number(today.activeMs) || 0,
                logins: Number(today.logins) || 0,
                lastSeen: Number(today.lastSeen) || 0,
                ip: topIpOf(today),
              }
            : null,
          week,
          online: Boolean(today && Number(today.lastSeen) > cutoff),
        };
      })
      .sort((a, b) => {
        if (a.primary !== b.primary) return a.primary ? -1 : 1;
        if (a.role !== b.role) return ROLE_RANK[b.role] - ROLE_RANK[a.role];
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });
    return { ok: true, users, onlineWindowSec: STATS_ONLINE_WINDOW / 1000 };
  }

  if (p === '/api/admin/users/role' && req.method === 'POST') {
    const body = req.body || {};
    const id = String(body.id || '');
    const nextRole = ['user', 'admin', 'super'].includes(String(body.role)) ? String(body.role) : 'user';
    const store = loadUsers();
    const target = store.users.find((u) => u.id === id);
    if (!target) throw Object.assign(new Error('用户不存在'), { status: 404 });
    const targetRole = roleOf(target);
    if (target.id === actor.id) throw Object.assign(new Error('不能修改自己的角色'), { status: 400 });
    if (targetRole === 'super' && actorRank < ROLE_RANK.super) {
      throw Object.assign(new Error('只有超级管理员可以修改超级管理员'), { status: 403 });
    }
    if (nextRole === 'super' && actorRank < ROLE_RANK.super) {
      throw Object.assign(new Error('只有超级管理员可以授予超级管理员'), { status: 403 });
    }
    if (target.primary && nextRole === 'user') {
      throw Object.assign(new Error('主账号必须保留管理员权限'), { status: 400 });
    }
    const admins = store.users.filter((u) => ROLE_RANK[roleOf(u)] >= ROLE_RANK.admin).length;
    if (ROLE_RANK[targetRole] >= ROLE_RANK.admin && ROLE_RANK[nextRole] < ROLE_RANK.admin && admins <= 1) {
      throw Object.assign(new Error('至少要保留一个管理员'), { status: 400 });
    }
    const supers = store.users.filter((u) => roleOf(u) === 'super').length;
    if (targetRole === 'super' && nextRole !== 'super' && supers <= 1) {
      throw Object.assign(new Error('至少要保留一个超级管理员'), { status: 400 });
    }
    target.role = nextRole;
    target.updatedAt = new Date().toISOString();
    saveUsers(store);
    recordLoginEvent(req, { user: actor, ok: true, action: 'role', reason: `${target.username}: ${targetRole} -> ${nextRole}` });
    return { ok: true, user: { id: target.id, username: target.username, role: nextRole } };
  }

  // 管理员重置某个用户的密码（不需要旧密码）；重置后该用户所有会话失效。
  if (p === '/api/admin/users/password' && req.method === 'POST') {
    const body = req.body || {};
    const id = String(body.id || '');
    const password = String(body.password || '');
    if (password.length < 6 || password.length > 64) {
      throw Object.assign(new Error('密码长度需为 6-64 位'), { status: 400 });
    }
    const store = loadUsers();
    const target = store.users.find((u) => u.id === id);
    if (!target) throw Object.assign(new Error('用户不存在'), { status: 404 });
    const targetRank = ROLE_RANK[roleOf(target)];
    if (targetRank >= actorRank && !isSuperUser(actor)) {
      throw Object.assign(new Error('不能重置同级或更高级别用户的密码'), { status: 403 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    target.salt = salt;
    target.hash = hashPassword(password, salt);
    target.updatedAt = new Date().toISOString();
    saveUsers(store);
    invalidateUserSessions(target.id);
    recordLoginEvent(req, { user: actor, ok: true, action: 'reset', reason: `重置 ${target.username} 的密码` });
    return { ok: true, id: target.id, username: target.username };
  }

  // 强制下线：清掉该用户全部会话（不删账号）。
  if (p === '/api/admin/users/kick' && req.method === 'POST') {
    const body = req.body || {};
    const id = String(body.id || '');
    const target = loadUsers().users.find((u) => u.id === id);
    if (!target) throw Object.assign(new Error('用户不存在'), { status: 404 });
    const targetRank = ROLE_RANK[roleOf(target)];
    if (targetRank >= actorRank && !isSuperUser(actor)) {
      throw Object.assign(new Error('不能强制同级或更高级别用户下线'), { status: 403 });
    }
    const changed = invalidateUserSessions(target.id);
    recordLoginEvent(req, { user: actor, ok: true, action: 'kick', reason: `强制下线 ${target.username}` });
    return { ok: true, username: target.username, sessions: changed };
  }

  // 概览：今日汇总 + 最近 N 天曲线 + 当前在线 + 最近登录事件
  if (p === '/api/admin/overview' && req.method === 'GET') {
    const days = Math.max(1, Math.min(30, Number(q.get('days') || 14)));
    const keys = lastDateKeys(days);
    const series = keys.map((date) => {
      const day = statsStore.days[date] || {};
      let requests = 0;
      let bytes = 0;
      let activeMs = 0;
      let logins = 0;
      let users = 0;
      for (const entry of Object.values(day)) {
        if (!entry) continue;
        users += 1;
        requests += Number(entry.requests) || 0;
        bytes += Number(entry.bytes) || 0;
        activeMs += Number(entry.activeMs) || 0;
        logins += Number(entry.logins) || 0;
      }
      return { date, requests, bytes, activeMs, logins, users };
    });
    const todayKey = keys[keys.length - 1];
    const today = statsStore.days[todayKey] || {};
    const cutoff = Date.now() - STATS_ONLINE_WINDOW;
    const online = Object.entries(today)
      .filter(([, entry]) => entry && Number(entry.lastSeen) > cutoff)
      .map(([userId, entry]) => ({
        userId,
        username: entry.username || userId,
        lastSeen: Number(entry.lastSeen) || 0,
        ip: topIpOf(entry),
        ua: entry.ua || '',
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
    const allUsers = loadUsers().users;
    let statsBytes = 0;
    try { statsBytes = fs.statSync(STORE_MODE === 'sqlite' ? dataStore.DB_FILE : STATS_FILE).size; } catch { statsBytes = 0; }
    return {
      ok: true,
      serverTime: Date.now(),
      today: series[series.length - 1],
      series,
      online,
      onlineWindowSec: STATS_ONLINE_WINDOW / 1000,
      users: {
        total: allUsers.length,
        admins: allUsers.filter((u) => roleOf(u) === 'admin').length,
        supers: allUsers.filter((u) => roleOf(u) === 'super').length,
        primary: allUsers.filter((u) => u.primary).length,
      },
      recentLogins: statsStore.logins.slice(-10).reverse(),
      statsFileBytes: statsBytes,
      statsDays: Object.keys(statsStore.days).length,
    };
  }

  // 使用统计：按天 × 用户展开
  if (p === '/api/admin/stats' && req.method === 'GET') {
    const days = Math.max(1, Math.min(30, Number(q.get('days') || 14)));
    const userId = String(q.get('userId') || '');
    const keys = lastDateKeys(days);
    const rows = [];
    for (const date of keys.slice().reverse()) {
      const day = statsStore.days[date] || {};
      for (const [id, entry] of Object.entries(day)) {
        if (userId && id !== userId) continue;
        if (!entry) continue;
        rows.push({
          date,
          userId: id,
          username: entry.username || id,
          requests: Number(entry.requests) || 0,
          api: Number(entry.api) || 0,
          assets: Number(entry.assets) || 0,
          bytes: Number(entry.bytes) || 0,
          activeMs: Number(entry.activeMs) || 0,
          logins: Number(entry.logins) || 0,
          lastSeen: Number(entry.lastSeen) || 0,
          views: entry.views || {},
          ip: topIpOf(entry),
          ua: entry.ua || '',
        });
      }
    }
    const series = keys.map((date) => {
      const day = statsStore.days[date] || {};
      const out = { date, requests: 0, bytes: 0, activeMs: 0, logins: 0, users: 0 };
      for (const [id, entry] of Object.entries(day)) {
        if (!entry) continue;
        if (userId && id !== userId) continue;
        out.users += 1;
        out.requests += Number(entry.requests) || 0;
        out.bytes += Number(entry.bytes) || 0;
        out.activeMs += Number(entry.activeMs) || 0;
        out.logins += Number(entry.logins) || 0;
      }
      return out;
    });
    const totals = series.reduce(
      (acc, item) => ({
        requests: acc.requests + item.requests,
        bytes: acc.bytes + item.bytes,
        activeMs: acc.activeMs + item.activeMs,
        logins: acc.logins + item.logins,
      }),
      { requests: 0, bytes: 0, activeMs: 0, logins: 0 },
    );
    const known = new Map();
    for (const u of loadUsers().users) known.set(u.id, u.username);
    for (const day of Object.values(statsStore.days)) {
      for (const [id, entry] of Object.entries(day || {})) {
        if (entry && entry.username && !known.has(id)) known.set(id, entry.username);
      }
    }
    return {
      ok: true,
      days,
      userId,
      series,
      rows,
      totals,
      users: [...known.entries()].map(([id, username]) => ({ id, username })).sort((a, b) => String(a.username).localeCompare(String(b.username))),
    };
  }

  // 登录 / 改密 / 强制下线等事件
  if (p === '/api/admin/logins' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(500, Number(q.get('limit') || 80)));
    const userId = String(q.get('userId') || '');
    const action = String(q.get('action') || '');
    const onlyFailed = q.get('ok') === '0';
    const list = statsStore.logins.filter((item) => {
      if (userId && item.userId !== userId) return false;
      if (action && item.action !== action) return false;
      if (onlyFailed && item.ok) return false;
      return true;
    });
    return { ok: true, total: list.length, logins: list.slice(-limit).reverse() };
  }

  if (p === '/api/admin/logins/clear' && req.method === 'POST') {
    requireSuper(req);
    const count = statsStore.logins.length;
    statsStore.logins = [];
    flushStats();
    recordLoginEvent(req, { user: actor, ok: true, action: 'clear', reason: `清空 ${count} 条登录日志` });
    return { ok: true, cleared: count };
  }

  if (p === '/api/admin/system' && req.method === 'GET') {
    const status = await getSystemStatus();
    let statsFileBytes = 0;
    try { statsFileBytes = fs.statSync(STORE_MODE === 'sqlite' ? dataStore.DB_FILE : STATS_FILE).size; } catch { statsFileBytes = 0; }
    return { ...status, ok: true, statsFileBytes, statsDays: Object.keys(statsStore.days).length };
  }

  // 系统日志：只回「末尾 N 行」，可带关键词过滤；文件白名单由 logsStore 内部维护，
  // 前端传的 file 只是 id（如 server / server.1 / crash），不接受任意路径。
  if (p === '/api/admin/logs' && req.method === 'GET') {
    const view = logsStore.tail({
      id: String(q.get('file') || ''),
      lines: Number(q.get('lines') || 200),
      filter: q.get('q') || '',
    });
    return { ok: true, files: logsStore.list(), ...view };
  }

  /* ---------------------------------------------------------
     部署：把本机最新代码推送到 NAS（2026-11-17）
     - status 只读，管理员都能看进度与版本对比；
     - start 会重启线上服务，只允许 super，且仅限本机开发环境可用；
     - 前端靠轮询 status 显示进度（响应层只输出 JSON）。
     --------------------------------------------------------- */
  if (p === '/api/admin/deploy/status' && req.method === 'GET') {
    return deployToNas.snapshotWithNas();
  }

  if (p === '/api/admin/deploy/start' && req.method === 'POST') {
    requireSuper(req);
    // 显式确认位：防止误点、脚本误触发（路由回归测试也会打到这个端点）。
    const body = req.body || {};
    if (body.confirm !== true) throw Object.assign(new Error('缺少确认参数 confirm=true'), { status: 400 });
    const started = deployToNas.start();
    recordLoginEvent(req, { user: actor, ok: true, action: 'deploy', reason: `推送到 NAS（任务 ${started.id}）` });
    return { ok: true, jobId: started.id };
  }

  throw Object.assign(new Error('未知接口'), { status: 404 });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  if (p.startsWith('/api/auth/')) return handleAuth(req, res, url);
  if (p.startsWith('/api/admin/')) return handleAdmin(req, res, url);
  if (p === '/api/changelog') return getChangelog();
  if (p === '/api/health') {
    return { ok: true, version: VERSION, time: new Date().toISOString() };
  }
  // 前端心跳：记录页面访问与在线时长（每 60 秒一次；切页时额外记一次 view）
  if (p === '/api/activity/ping' && req.method === 'POST') {
    const user = currentUser(req);
    if (!user) throw Object.assign(new Error('未登录'), { status: 401 });
    const body = req.body || {};
    recordViewPing(req, user, body.view, body.activeSec, body.event);
    return { ok: true };
  }
  // 手机 / 局域网访问地址（设置页「手机访问」用）
  if (p === '/api/net') {
    const urls = accessUrls();
    return {
      ok: true,
      port: PORT,
      host: HOST,
      urls,
      mobile: urls.filter((u) => !u.includes('127.0.0.1')),
      lan: lanAddresses(),
      lanEnabled: HOST === '0.0.0.0' || HOST === '::',
    };
  }
  // 自选基金 / 持仓：按当前登录账号隔离。主账号的数据同时是推送用的那一份。
  if (p === '/api/portfolio' && req.method === 'GET') {
    const user = currentUser(req);
    const portfolio = loadPortfolio(user);
    let updatedAt = null;
    try {
      if (STORE_MODE === 'sqlite') {
        updatedAt = fs.statSync(dataStore.DB_FILE).mtimeMs;
      } else {
        updatedAt = user && user.primary
          ? fs.statSync(PUSH_FILE).mtimeMs
          : fs.statSync(userDataFile(user.id)).mtimeMs;
      }
    } catch {
      updatedAt = null;
    }
    return {
      ok: true,
      user: user ? publicUser(user) : null,
      funds: portfolio.funds,
      holdings: portfolio.holdings,
      watchlist: portfolio.watchlist,
      updatedAt,
    };
  }
  if (p === '/api/portfolio' && req.method === 'POST') {
    const user = currentUser(req);
    if (!user) throw Object.assign(new Error('未登录'), { status: 401 });
    const body = req.body || {};
    const cleaned = sanitizePortfolio(body);
    const current = loadPortfolio(user);
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    // 只更新前端明确传上来的字段，避免某个客户端少传 watchlist 就把服务器数据清空。
    savePortfolio(user, {
      funds: has('funds') ? cleaned.funds : current.funds,
      holdings: has('holdings') ? cleaned.holdings : current.holdings,
      watchlist: has('watchlist') ? cleaned.watchlist : current.watchlist,
    });
    return {
      ok: true,
      funds: has('funds') ? cleaned.funds.length : current.funds.length,
      holdings: Object.keys(has('holdings') ? cleaned.holdings : current.holdings).length,
      watchlist: has('watchlist') ? cleaned.watchlist.length : current.watchlist.length,
    };
  }
  if (p === '/api/source/status') return sourceStatus();
  // 数据源切换属于全局配置，2026-11-15 起移到后台管理，只有管理员能改。
  if (p === '/api/source/config') {
    if (req.method === 'POST') requireAdmin(req);
    return applySourceConfig(req, q);
  }
  if (p === '/api/source/probe') return probeSource(q.get('cap') || '');
  if (p === '/api/overview') return getOverview();
  if (p === '/api/csi300-ratio') return getCsi300FundRatio(Number(q.get('top') || 10));
  if (p === '/api/us') return getUSDashboard();
  if (p === '/api/us/minutes') {
    const symbols = (q.get('symbols') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return getUsMinutes(symbols);
  }
  if (p === '/api/distribution') {
    return q.get('market') === 'us' ? getUSDistribution() : getChinaDistribution();
  }
  if (p === '/api/advice') return getAdvice(q.get('risk') || 'balanced');
  if (p === '/api/battle') return getBattle();
  if (p === '/api/sector-confirm') return getSectorConfirm();
  if (p === '/api/money-moves') return getMoneyMoves();
  if (p === '/api/ladder') return getLadder();
  if (p === '/api/timeline') return getTimelineData();
  if (p === '/api/ten-day') {
    return getTenDay(q.get('dir') === 'down' ? 'down' : 'up', q.get('force') === '1');
  }
  if (p === '/api/sector/export') {
    const code = q.get('code');
    if (!code) throw new Error('缺少板块代码');
    return getSectorExport(code);
  }
  if (p === '/api/sector/members') {
    const code = q.get('code');
    if (!code) throw new Error('缺少板块代码');
    return getSectorMembers(code, q.get('name') || '', q.get('type') === 'industry' ? 'industry' : 'concept');
  }
  if (p === '/api/intraday') {
    return getIntraday(q.get('secid') || '1.000001', q.get('date'));
  }
  if (p === '/api/metals/intraday') {
    const codes = (q.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return getMetalsIntraday(codes);
  }
  if (p === '/api/index-compare') return getIndexCompare(Number(q.get('days') || 250));
  if (p === '/api/index-periods') return getIndexPeriods();
  if (p === '/api/kline') {
    const secid = q.get('secid') || '1.000001';
    const klt = Number(q.get('klt') || 101);
    const limit = Math.max(30, Math.min(3000, Number(q.get('limit') || 160)));
    const allowed = new Set([1, 5, 15, 30, 60, 101, 102, 103]);
    if (!allowed.has(klt)) throw new Error('不支持的 K 线周期');
    const kline = await getKline(secid, klt, limit);
    let analysis = null;
    try { analysis = analyze(kline.candles); } catch { /* 数据不足时仍返回 K 线 */ }
    return { ...kline, analysis };
  }
  if (p === '/api/stock') {
    const secid = q.get('secid');
    if (!secid) throw new Error('缺少 secid');
    return getStock(secid, q.get('risk') || 'balanced');
  }
  if (p === '/api/quotes') {
    const secids = (q.get('secids') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const items = await fetchQuoteList(secids, 'stock');
    return { items, updatedAt: Date.now() };
  }
  if (p === '/api/watchlist') {
    const secids = (q.get('secids') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return getWatchlist(secids, q.get('risk') || 'balanced');
  }
  if (p === '/api/sectors') {
    return getSectors(q.get('type') === 'concept' ? 'concept' : 'industry');
  }
  if (p === '/api/sectors/period') {
    return getSectorPeriod(
      q.get('type') === 'concept' ? 'concept' : 'industry',
      SECTOR_PERIODS[q.get('period')] ? q.get('period') : 'today',
    );
  }
  if (p === '/api/sector/constituents') {
    const code = q.get('code');
    if (!code) throw new Error('缺少板块代码');
    try {
      const { data } = await runSource('sectorDetail', [code]);
      return data;
    } catch {
      // 成分股接口偶发限流时，不阻断板块走势抽屉。
      return {
        code,
        items: [],
        unavailable: true,
        note: '成分股接口暂时不可用，板块走势仍可查看',
        updatedAt: Date.now(),
      };
    }
  }
  if (p === '/api/sector/kline') {
    const code = q.get('code');
    if (!code) throw new Error('缺少板块代码');
    return getKline(`90.${code}`, 101, 120);
  }
  if (p === '/api/rank') {
    const type = ['gain', 'loss', 'inflow', 'outflow', 'amount'].includes(q.get('type'))
      ? q.get('type')
      : 'gain';
    return getRank(type, Math.min(50, Number(q.get('limit') || 20)));
  }
  if (p === '/api/news') {
    return getNews(Math.min(50, Number(q.get('limit') || 40)));
  }
  if (p === '/api/search') return getSearch(q.get('q'));
  if (p === '/api/flow') {
    const secid = q.get('secid') || '1.000001';
    return getFlow(secid);
  }
  if (p === '/api/funds/open-flow') {
    return getOpenFundFlow(q.get('category') || 'all', q.get('limit') || 50);
  }
  if (p === '/api/funds/daily-proxy') {
    return getDailyProxyBoard(Math.min(100, Math.max(10, Number(q.get('limit') || 50))));
  }
  if (p === '/api/funds/flow') {
    const type = q.get('type') === 'outflow' ? 'outflow' : 'inflow';
    const category = ['equity', 'bond', 'commodity', 'money'].includes(q.get('category'))
      ? q.get('category')
      : 'all';
    return getEtfFlow(type, Math.min(50, Number(q.get('limit') || 30)), category);
  }
  if (p === '/api/funds/search') return getFundSearch(q.get('q'));
  if (p === '/api/funds/watch') {
    const codes = (q.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return getFundWatch(codes, q.get('risk') || 'balanced');
  }
  // 穿透估算明细：排查「当日涨跌」是怎么算出来的（也用于核对是否与官方净值接近）。
  // ?asof=pre 时额外给出「假设当日净值还没公布」时 14:30 会采用的涨跌口径。
  if (p === '/api/funds/estimate') {
    const codes = (q.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (!codes.length) return { ok: true, items: [] };
    const today = shanghaiToday();
    const infoRows = await fetchFundMNFInfo(codes).catch(() => []);
    const infoMap = new Map(infoRows.map((r) => [r.FCODE, r]));
    const map = await estimateFundDayPctBatch(codes.map((code) => ({ code, name: (infoMap.get(code) || {}).SHORTNAME || '' })));
    const asIfPre = q.get('asof') === 'pre';
    return {
      ok: true,
      today,
      items: codes.map((code) => {
        const info = infoMap.get(code);
        const item = { code, name: (info && info.SHORTNAME) || '', ...(map.get(code) || {}) };
        if (asIfPre && info) {
          item.navDate = String(info.PDATE || '');
          item.navPct = num(info.NAVCHGRT);
          item.preview = resolveFundTodayPct({
            navDate: '1970-01-01',
            navPct: num(info.NAVCHGRT),
            gsz: 0,
            gszzl: null,
            gzTime: '',
            est: map.get(code) || null,
            today,
          });
        }
        return item;
      }),
    };
  }
  if (p === '/api/funds/detail') {
    const code = q.get('code');
    if (!code) throw new Error('缺少基金代码');
    return getFundDetail(code, q.get('type'));
  }
  if (p === '/api/funds/metrics') {
    const code = q.get('code');
    if (!code) throw new Error('缺少基金代码');
    return getFundMetrics(code, q.get('type'));
  }
  if (p === '/api/funds/stock-rank') {
    const ft = STOCK_FUND_TYPES[q.get('type')] ? q.get('type') : 'gp';
    const sort = FUND_SORT_MAP[q.get('sort')] ? q.get('sort') : 'year';
    return getStockFundRank(ft, sort, Math.min(50, Number(q.get('limit') || 30)), q.get('sector') || '');
  }
  if (p === '/api/funds/stock-detail') {
    const code = q.get('code');
    if (!code) throw new Error('缺少基金代码');
    return getStockFundDetail(code);
  }
  if (p === '/api/funds/holdings-history') {
    const code = q.get('code');
    if (!code) throw new Error('缺少基金代码');
    return { code, quarters: await getFundHoldingsHistory(code), updatedAt: Date.now() };
  }
  if (p === '/api/funds/compare') {
    const codes = (q.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return getFundCompare(codes);
  }
  if (p === '/api/funds/sectors') {
    const ft = STOCK_FUND_TYPES[q.get('type')] ? q.get('type') : 'gp';
    const sort = ['day', 'week', 'month', 'year'].includes(q.get('sort')) ? q.get('sort') : 'day';
    return getStockFundSectors(ft, sort);
  }
  if (p === '/api/funds/sector-flow') return getFundSectorFlow();
  if (p === '/api/funds/hot') return getHotFunds();
  if (p === '/api/funds/warnings') return getFundWarnings();
  const err = new Error('未知接口');
  err.status = 404;
  throw err;
}

  return { handleAuth, handleAdmin, handleApi, requiredDeps: Object.keys(deps) };
}

module.exports = { createHttpRoutes };
