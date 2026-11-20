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

/** 导出：holdings 只保留还在持有的条目，去掉墓碑与内部时间戳 */
function buildPortfolioDoc({ user, portfolio, source, storeMode } = {}) {
  if (!user || !user.id) throw new Error('导出持仓需要账号');
  const holdings = {};
  for (const [code, h] of Object.entries((portfolio && portfolio.holdings) || {})) {
    if (!code || !h || typeof h !== 'object') continue;
    const shares = toCount(h.shares);
    if (!shares) continue;
    holdings[String(code)] = { shares, cost: Number(h.cost) || 0 };
  }
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
    holdings,
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
    holdings[String(code)] = { shares, cost: Number(v.cost) || 0 };
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
      holdings[String(code)] = { shares, cost: Number(h.cost) || 0, updatedAt: stamp };
    }
  };
  addHoldings(doc && doc.holdings, now);
  if (!replace) addHoldings(current && current.holdings, now - 1); // 当前有、导入没有的保留（稍旧，防止反向覆盖）
  return {
    funds: replace ? (doc.funds || []) : unionByCode(doc.funds, current && current.funds),
    holdings,
    watchlist: replace ? (doc.watchlist || []) : unionByCode(doc.watchlist, current && current.watchlist),
  };
}

function summarizePortfolio(doc) {
  const holdings = (doc && doc.holdings) || {};
  return {
    funds: Array.isArray(doc && doc.funds) ? doc.funds.length : 0,
    holdings: Object.values(holdings).filter((h) => toCount(h.shares) > 0).length,
    watchlist: Array.isArray(doc && doc.watchlist) ? doc.watchlist.length : 0,
  };
}

module.exports = {
  DOC_VERSION,
  buildPortfolioDoc,
  validatePortfolioDoc,
  applyPortfolioImport,
  summarizePortfolio,
};
