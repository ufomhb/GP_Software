'use strict';
/**
 * 持仓数据互通（v2.9.2）
 * ---------------------------------------------------------------
 * 背景：本机（localhost:8090）和线上 NAS（gp.ufomhb.xyz）是两套独立的
 * `data/`。在手机/线上改的持仓只写到 NAS，回到本机看到的是本机那份，
 * 表现就是「昨天改的持仓今天回滚了」。
 *
 * 这里只做「与存储模式无关」的规范化转换与合并计算：
 *   - buildPortfolioDoc：把某个账号的持仓导出成一份可传输的 JSON
 *   - validatePortfolioDoc：校验导入文件（格式版本 / 账号 ID / 份额）
 *   - applyPortfolioImport：把导入内容合并进当前数据（merge / replace）
 * 具体的 SSH / 文件读写分别在 scripts/portfolio-*.mjs 与 src/lib/nas-deploy.js。
 */

const DOC_VERSION = 2;

function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 一组持仓 → 可传输形态（只留还持有的条目，带 addedAt 建仓日） */
function exportHoldings(map) {
  const out = {};
  for (const [code, h] of Object.entries(map || {})) {
    if (!code || !h || typeof h !== 'object') continue;
    const shares = toCount(h.shares);
    if (!shares) continue;
    const entry = { shares, cost: Number(h.cost) || 0 };
    if (Number(h.addedAt) > 0) entry.addedAt = Number(h.addedAt);
    out[String(code)] = entry;
  }
  return out;
}

function exportGroups(groups) {
  return (Array.isArray(groups) ? groups : [])
    .filter((g) => g && g.id && !g.isDefault && g.id !== 'default')
    .slice(0, 12)
    .map((g) => ({
      id: String(g.id),
      name: String(g.name || '').slice(0, 20),
      createdAt: Number(g.createdAt) || 0,
      holdings: exportHoldings(g.holdings),
    }));
}

/** 导出：holdings 只保留还在持有的条目，去掉墓碑与内部时间戳 */
function buildPortfolioDoc({ user, portfolio, source, storeMode } = {}) {
  if (!user || !user.id) throw new Error('导出持仓需要账号');
  return {
    ok: true,
    docVersion: DOC_VERSION,
    exportedAt: Date.now(),
    source: {
      host: String((source && source.host) || ''),
      store: String(storeMode || (source && source.store) || ''),
    },
    user: { id: String(user.id), username: String(user.username || '') },
    funds: Array.isArray(portfolio && portfolio.funds) ? portfolio.funds : [],
    holdings: exportHoldings(portfolio && portfolio.holdings),
    // v2.10.0：多份持仓组合（不含主持仓）
    portfolios: exportGroups(portfolio && portfolio.portfolios),
    watchlist: Array.isArray(portfolio && portfolio.watchlist) ? portfolio.watchlist : [],
  };
}

/** 校验导入文件：格式版本、账号、份额；返回规范化后的对象（份额 <= 0 的条目丢弃） */
function validatePortfolioDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('持仓文件内容不是合法 JSON 对象');
  if (Number(raw.docVersion) !== DOC_VERSION) {
    throw new Error(`不支持的持仓文件格式（docVersion=${raw.docVersion}），请两端都升级到同一版本`);
  }
  if (!raw.user || !String(raw.user.id || '').trim()) throw new Error('持仓文件缺少账号 ID');
  const holdings = {};
  for (const [code, v] of Object.entries(raw.holdings || {})) {
    if (!code || !v || typeof v !== 'object') continue;
    const shares = toCount(v.shares);
    if (!shares) continue;
    const entry = { shares, cost: Number(v.cost) || 0 };
    if (Number(v.addedAt) > 0) entry.addedAt = Number(v.addedAt);
    holdings[String(code)] = entry;
  }
  // v2.10.0：额外组合（缺字段 = 旧文件，视为没有额外组合）
  const portfolios = [];
  const seenGroup = new Set();
  for (const g of Array.isArray(raw.portfolios) ? raw.portfolios.slice(0, 12) : []) {
    const id = String((g && g.id) || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,19}$/.test(id) || id === 'default' || seenGroup.has(id)) continue;
    seenGroup.add(id);
    const groupHoldings = {};
    for (const [code, v] of Object.entries((g && g.holdings) || {})) {
      if (!code || !v || typeof v !== 'object') continue;
      const shares = toCount(v.shares);
      if (!shares) continue;
      const entry = { shares, cost: Number(v.cost) || 0 };
      if (Number(v.addedAt) > 0) entry.addedAt = Number(v.addedAt);
      groupHoldings[String(code)] = entry;
    }
    portfolios.push({
      id,
      name: String((g && g.name) || '').slice(0, 20) || '未命名组合',
      createdAt: Number(g && g.createdAt) || 0,
      holdings: groupHoldings,
    });
  }
  const funds = (Array.isArray(raw.funds) ? raw.funds : [])
    .map((f) => ({
      code: String((f && f.code) || ''),
      name: String((f && f.name) || ''),
      type: f && f.type === 'etf' ? 'etf' : 'open',
    }))
    .filter((f) => f.code)
    .slice(0, 30);
  const watchlist = (Array.isArray(raw.watchlist) ? raw.watchlist : [])
    .map((w) => ({
      secid: String((w && w.secid) || ''),
      code: String((w && w.code) || ''),
      name: String((w && w.name) || '').slice(0, 40),
    }))
    .filter((w) => w.secid)
    .slice(0, 200);
  return {
    docVersion: DOC_VERSION,
    exportedAt: Number(raw.exportedAt) || 0,
    source: raw.source && typeof raw.source === 'object' ? raw.source : {},
    user: { id: String(raw.user.id), username: String(raw.user.username || '') },
    funds,
    holdings,
    portfolios,
    watchlist,
  };
}

function keyOf(item) {
  if (!item || typeof item !== 'object') return '';
  return String(item.code || item.secid || '').trim();
}

/** 两个列表按代码求并集：导入的在前（顺序以导入为准），当前独有的追加在后 */
function unionByCode(imported, current) {
  const list = Array.isArray(imported) ? imported.slice() : [];
  const seen = new Set(list.map(keyOf).filter(Boolean));
  for (const item of Array.isArray(current) ? current : []) {
    const key = keyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push(item);
  }
  return list;
}

/**
 * 把导入内容合并进当前数据。
 * mode=merge：自选/持仓求并集，导入的持仓份额覆盖当前（用户是主动选择方向的）
 * mode=replace：完全以导入内容为准
 * 任何写入都打上「现在」的时间戳，保证其它设备下次合并时会接受这份数据。
 */
function applyPortfolioImport(doc, current, { mode = 'merge', now = Date.now() } = {}) {
  const replace = mode === 'replace';
  const holdings = {};
  const addHoldings = (map, stamp) => {
    for (const [code, h] of Object.entries(map || {})) {
      if (!code || !h || typeof h !== 'object') continue;
      const shares = toCount(h.shares);
      if (!shares) continue;
      const entry = { shares, cost: Number(h.cost) || 0, updatedAt: stamp };
      if (Number(h.addedAt) > 0) entry.addedAt = Number(h.addedAt);
      holdings[String(code)] = entry;
    }
  };
  addHoldings(doc && doc.holdings, now);
  if (!replace) addHoldings(current && current.holdings, now - 1); // 当前有、导入没有的保留（稍旧，防止反向覆盖）
  // v2.10.0：额外组合按 id 合并（导入的优先；merge 时保留本地独有组合）
  const groupMap = new Map();
  const addGroups = (groups, stamp) => {
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || !g.id || g.isDefault || g.id === 'default') continue;
      const groupHoldings = {};
      for (const [code, h] of Object.entries(g.holdings || {})) {
        const shares = toCount(h && h.shares);
        if (!code || !shares) continue;
        const entry = { shares, cost: Number(h.cost) || 0, updatedAt: stamp };
        if (Number(h.addedAt) > 0) entry.addedAt = Number(h.addedAt);
        groupHoldings[String(code)] = entry;
      }
      groupMap.set(String(g.id), {
        id: String(g.id),
        name: String(g.name || '').slice(0, 20) || '未命名组合',
        createdAt: Number(g.createdAt) || stamp,
        updatedAt: stamp,
        holdings: groupHoldings,
      });
    }
  };
  addGroups(doc && doc.portfolios, now);
  if (!replace) {
    for (const g of Array.isArray(current && current.portfolios) ? current.portfolios : []) {
      if (!g || g.isDefault || g.id === 'default') continue;
      if (groupMap.has(String(g.id))) continue;
      groupMap.set(String(g.id), g);
    }
  }
  return {
    funds: replace ? (doc.funds || []) : unionByCode(doc.funds, current && current.funds),
    holdings,
    portfolios: [...groupMap.values()],
    watchlist: replace ? (doc.watchlist || []) : unionByCode(doc.watchlist, current && current.watchlist),
  };
}

function summarizePortfolio(doc) {
  const holdings = (doc && doc.holdings) || {};
  return {
    funds: Array.isArray(doc && doc.funds) ? doc.funds.length : 0,
    holdings: Object.values(holdings).filter((h) => toCount(h.shares) > 0).length,
    watchlist: Array.isArray(doc && doc.watchlist) ? doc.watchlist.length : 0,
    groups: Array.isArray(doc && doc.portfolios) ? doc.portfolios.length : 0,
  };
}

module.exports = {
  DOC_VERSION,
  buildPortfolioDoc,
  validatePortfolioDoc,
  applyPortfolioImport,
  summarizePortfolio,
};
