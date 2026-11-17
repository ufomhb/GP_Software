'use strict';
/**
 * 数据存储层（P1，2026-11-15）
 *
 * 同一组接口，两套实现，由环境变量选择：
 *   STORE=json    → data/*.json（现状，默认；回滚用）
 *   STORE=sqlite  → data/gp.sqlite（事务 + 原子提交，防并发丢写与崩溃损坏）
 *
 * 设计要点：
 * - 对外函数名/入参/返回结构与改造前完全一致，调用方一行不用改。
 * - node:sqlite 的 DatabaseSync 是同步 API，正好对上现有同步数据函数。
 * - json 模式保留「主账号持仓镜像到 push-config」的旧行为，
 *   这样切回 STORE=json 时文件仍然是完整的；sqlite 模式只有 portfolio_* 一张真源。
 * - 统计（stats）在 sqlite 模式下做增量同步：只写变化过的「天 + 账号」。
 */
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'gp.sqlite');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PUSH_FILE = path.join(DATA_DIR, 'push-config.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const USERDATA_DIR = path.join(DATA_DIR, 'userdata');
const STORE_ERROR_LOG = path.join(DATA_DIR, 'store-errors.log');

const MODE = String(process.env.STORE || 'json').trim().toLowerCase() === 'sqlite' ? 'sqlite' : 'json';

/* =========================================================
   通用 JSON 文件读写（server.js 的行情缓存也复用这两个）
   ========================================================= */
function noteStoreError(file, err) {
  const line = `[${new Date().toISOString()}] ${path.basename(file)}: ${(err && err.message) || err}\n`;
  console.error(`[STORE] ${line.trim()}`);
  try {
    fs.mkdirSync(path.dirname(STORE_ERROR_LOG), { recursive: true });
    fs.appendFileSync(STORE_ERROR_LOG, line, 'utf8');
  } catch { /* 日志写不进去也不能影响主流程 */ }
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code !== 'ENOENT') noteStoreError(file, err);
    return fallback;
  }
}

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows 上目标文件被杀毒 / 编辑器占用时 rename 可能失败：退回直接覆盖并留痕。
    noteStoreError(file, err);
    fs.writeFileSync(file, text, 'utf8');
    try { fs.unlinkSync(tmp); } catch { /* 临时文件清不掉也不影响主流程 */ }
  }
}

/* =========================================================
   SQLite 句柄与建表
   ========================================================= */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  username_lc   TEXT NOT NULL UNIQUE,
  salt          TEXT NOT NULL,
  hash          TEXT NOT NULL,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','super')),
  created_at    TEXT,
  updated_at    TEXT,
  last_login_at TEXT,
  last_login_ip TEXT,
  login_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER,
  expires_at INTEGER,
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS portfolio_funds (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT 'open',
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, code)
);

CREATE TABLE IF NOT EXISTS portfolio_holdings (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  shares     REAL NOT NULL DEFAULT 0,
  cost       REAL NOT NULL DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (user_id, code)
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secid      TEXT NOT NULL,
  code       TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_at   INTEGER,
  PRIMARY KEY (user_id, secid)
);

CREATE TABLE IF NOT EXISTS push_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  enabled        INTEGER NOT NULL DEFAULT 0,
  channel        TEXT NOT NULL DEFAULT 'serverchan',
  token          TEXT NOT NULL DEFAULT '',
  webhook        TEXT NOT NULL DEFAULT '',
  time           TEXT NOT NULL DEFAULT '14:30',
  weekdays_only  INTEGER NOT NULL DEFAULT 1,
  slots_json     TEXT NOT NULL DEFAULT '[]',
  last_sent_json TEXT NOT NULL DEFAULT '{}',
  last_result_json TEXT NOT NULL DEFAULT 'null',
  follow_up_json TEXT NOT NULL DEFAULT '{}',
  updated_at     INTEGER
);

CREATE TABLE IF NOT EXISTS stats_daily (
  day        TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  requests   INTEGER NOT NULL DEFAULT 0,
  api        INTEGER NOT NULL DEFAULT 0,
  assets     INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0,
  active_ms  INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER,
  last_seen  INTEGER,
  logins     INTEGER NOT NULL DEFAULT 0,
  ua         TEXT,
  PRIMARY KEY (day, user_id)
);

CREATE TABLE IF NOT EXISTS stats_views (
  day     TEXT NOT NULL,
  user_id TEXT NOT NULL,
  view    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, view)
);

CREATE TABLE IF NOT EXISTS stats_ips (
  day     TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ip      TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, ip)
);

CREATE TABLE IF NOT EXISTS login_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  user_id  TEXT,
  username TEXT,
  ok       INTEGER NOT NULL DEFAULT 0,
  action   TEXT,
  reason   TEXT,
  ip       TEXT,
  ua       TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_at ON login_events(at);
`;

/* =========================================================
   Schema 版本与增量迁移（2026-11-17，方案 A）
   ---------------------------------------------------------
   约定：
   - SCHEMA_VERSION =「当前代码期望的库版本」；
   - SCHEMA 字符串永远只描述**最终结构**：新库直接一次性建全，不走迁移；
   - 老库靠 MIGRATIONS 一条条升上来，每条带版本号，在独立事务里执行，
     提交成功才写 PRAGMA user_version；失败整条回滚并抛错（不会留下半截结构）；
   - 改结构时的标准动作：改 SCHEMA（让新库正确）+ 往 MIGRATIONS 追加一条（让老库跟上），
     两个改动必须同一次提交，否则新旧库结构会分叉。
   ========================================================= */
const SCHEMA_VERSION = 1;

const MIGRATIONS = [
  // 示例（新增列时照着写，注意版本号必须连续递增）：
  // {
  //   version: 2,
  //   name: '给 users 加备注列',
  //   sql: ["ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT ''"],
  // },
];

/* ---------------- 结构对照与版本工具 ---------------- */

function tableNames(dbc) {
  return dbc
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

function columnNames(dbc, table) {
  return dbc.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

/**
 * 把 SCHEMA 在 :memory: 库里建一遍，与目标库逐表逐列对比。
 * 返回 { missingTables, missingColumns, extraColumns }：
 * - missing* 是「代码要但库里没有」→ 必须迁移；
 * - extraColumns 是库里多出来的历史列 → 无害，只提示。
 */
function schemaDrift(dbc) {
  const { DatabaseSync } = require('node:sqlite');
  const expected = new DatabaseSync(':memory:');
  try {
    expected.exec(SCHEMA);
    const expTables = tableNames(expected);
    const liveTables = tableNames(dbc);
    const missingTables = expTables.filter((t) => !liveTables.includes(t));
    const missingColumns = [];
    const extraColumns = [];
    for (const table of expTables) {
      if (!liveTables.includes(table)) continue;
      const expCols = columnNames(expected, table);
      const liveCols = columnNames(dbc, table);
      const meta = new Map();
      for (const row of expected.prepare(`PRAGMA table_info(${table})`).all()) {
        meta.set(String(row.name), {
          notNull: Boolean(row.notnull),
          hasDefault: row.dflt_value !== null && row.dflt_value !== undefined,
        });
      }
      for (const column of expCols) {
        if (liveCols.includes(column)) continue;
        const info = meta.get(column) || { notNull: false, hasDefault: true };
        missingColumns.push({ table, column, notNull: info.notNull, hasDefault: info.hasDefault });
      }
      for (const column of liveCols) {
        if (!expCols.includes(column)) extraColumns.push({ table, column });
      }
    }
    return { missingTables, missingColumns, extraColumns };
  } finally {
    expected.close();
  }
}

function readUserVersion(dbc) {
  try {
    const row = dbc.prepare('PRAGMA user_version').get();
    return Number(row && row.user_version) || 0;
  } catch {
    return 0;
  }
}

function setUserVersion(dbc, version) {
  const v = Math.max(0, Math.trunc(Number(version) || 0));
  dbc.exec(`PRAGMA user_version = ${v}`);
}

/** 当前库还差哪些迁移（当前版本之后、目标版本之前的） */
function pendingMigrations(current, { migrations = MIGRATIONS, targetVersion = SCHEMA_VERSION } = {}) {
  return migrations
    .filter((m) => m.version > current && m.version <= targetVersion)
    .sort((a, b) => a.version - b.version);
}

/**
 * 把库升到 targetVersion。
 * - 版本 0 视为「还没纳入版本管理」：结构已经和 SCHEMA 一致就认领为当前版本，
 *   结构有缺则保留 0 并给出告警（让部署核对继续报错，不被版本号掩盖）。
 * - 每条迁移单独事务；失败回滚并抛错，不写版本号，下次启动会重试。
 */
function runMigrations(dbc, { migrations = MIGRATIONS, targetVersion = SCHEMA_VERSION, log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const from = readUserVersion(dbc);
  const report = { from, to: from, applied: [], adopted: false, warnings: [] };

  if (from > targetVersion) {
    report.warnings.push(`数据库版本 v${from} 高于代码期望 v${targetVersion}，可能回滚过代码，保持不动`);
    return report;
  }

  if (from === 0) {
    const drift = schemaDrift(dbc);
    if (drift.missingTables.length || drift.missingColumns.length) {
      report.warnings.push(
        `结构漂移（缺 ${drift.missingTables.length} 表 / ${drift.missingColumns.length} 列），暂不写版本号，请先迁移`,
      );
      return report;
    }
    setUserVersion(dbc, targetVersion);
    report.adopted = true;
    report.to = targetVersion;
    say(`[store] 已把现有库认领为 schema v${targetVersion}`);
    return report;
  }

  for (const migration of pendingMigrations(from, { migrations, targetVersion })) {
    dbc.exec('BEGIN');
    try {
      const statements = Array.isArray(migration.sql) ? migration.sql : migration.sql ? [migration.sql] : [];
      for (const sql of statements) dbc.exec(sql);
      if (typeof migration.run === 'function') migration.run(dbc);
      setUserVersion(dbc, migration.version);
      dbc.exec('COMMIT');
      report.applied.push({ version: migration.version, name: migration.name || '' });
      say(`[store] 迁移 v${migration.version} ${migration.name || ''} 完成`);
    } catch (err) {
      try { dbc.exec('ROLLBACK'); } catch { /* 回滚失败也要抛原始错误 */ }
      throw new Error(
        `迁移 v${migration.version}「${migration.name || ''}」失败，已回滚，库仍是 v${readUserVersion(dbc)}：${err && err.message ? err.message : err}`,
      );
    }
  }

  report.to = readUserVersion(dbc);
  return report;
}

/** 打开库之后调用：自动把库升到 SCHEMA_VERSION；失败直接抛出，避免带旧结构静默跑 */
function migrateOnOpen(dbc) {
  try {
    const report = runMigrations(dbc, { log: (msg) => console.log(msg) });
    for (const warning of report.warnings) console.warn(`[store] ${warning}`);
    return report;
  } catch (err) {
    console.error('[store] 自动迁移失败，服务不启动，以免带旧结构产生 500。');
    console.error(`[store] ${err && err.message ? err.message : err}`);
    console.error('[store] 处理办法：恢复数据库快照（/data/backup/gp-data/gp-before-*.sqlite）或回滚代码。');
    throw err;
  }
}

/**
 * 供后台/CLI 查询：当前版本、目标版本、待执行迁移、结构漂移。
 *
 * 注意：判定依据是「库文件是否存在」，**不看 MODE**。
 * 原因：MODE 由进程启动时的 STORE 环境变量决定；在 SSH 会话里跑迁移脚本时
 * 没有 STORE=sqlite，MODE 会是 json，但 NAS 上确实有一个 SQLite 库，
 * 若按 MODE 短路就会把真实的迁移需求误报成「没有库、无需迁移」。
 */
function schemaStatus(dbFile = DB_FILE) {
  if (!fs.existsSync(dbFile)) {
    return {
      mode: MODE,
      dbFile,
      hasDb: false,
      currentVersion: 0,
      targetVersion: SCHEMA_VERSION,
      pending: [],
      drift: { missingTables: [], missingColumns: [], extraColumns: [] },
    };
  }
  const { DatabaseSync } = require('node:sqlite');
  const probe = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const currentVersion = readUserVersion(probe);
    return {
      mode: MODE,
      dbFile,
      hasDb: true,
      currentVersion,
      targetVersion: SCHEMA_VERSION,
      pending: pendingMigrations(currentVersion),
      drift: schemaDrift(probe),
    };
  } finally {
    probe.close();
  }
}

let db = null;

function openDb(targetFile = DB_FILE) {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 只有 sqlite 模式（或迁移脚本显式调用）才会走到这里，因此 json 模式零依赖不变。
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(targetFile);
  db.exec(SCHEMA);
  // 建表之后立刻把版本升到代码期望的版本：改结构后重启即生效（老库自动迁移）。
  migrateOnOpen(db);
  return db;
}

function closeDb() {
  if (!db) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
  try { db.close(); } catch { /* 忽略 */ }
  db = null;
  statsBaseline = null;
  loginsBaseline = null;
}

/* =========================================================
   一、账号
   ========================================================= */
function normalizeUserRoles(users) {
  let changed = false;
  for (const user of users) {
    if (user.role !== 'super' && user.role !== 'admin' && user.role !== 'user') {
      user.role = user.primary ? 'admin' : 'user';
      changed = true;
    }
  }
  return changed;
}

function userRowToObject(row) {
  return {
    id: row.id,
    username: row.username,
    salt: row.salt,
    hash: row.hash,
    primary: Boolean(row.is_primary),
    role: row.role,
    createdAt: row.created_at || undefined,
    updatedAt: row.updated_at || undefined,
    lastLoginAt: row.last_login_at || undefined,
    lastLoginIp: row.last_login_ip || undefined,
    loginCount: Number(row.login_count) || 0,
  };
}

function loadUsers() {
  if (MODE === 'json') {
    const store = readJsonFile(USERS_FILE, { users: [] });
    if (!store || !Array.isArray(store.users)) return { users: [] };
    if (normalizeUserRoles(store.users)) saveUsers(store);
    return store;
  }
  const rows = openDb().prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC').all();
  const users = rows.map(userRowToObject);
  if (normalizeUserRoles(users)) saveUsers({ users });
  return { users };
}

function saveUsers(store) {
  const users = Array.isArray(store && store.users) ? store.users : [];
  if (MODE === 'json') {
    writeJsonFile(USERS_FILE, { ...(store || {}), users });
    return;
  }
  const conn = openDb();
  const upsert = conn.prepare(`
    INSERT INTO users (id, username, username_lc, salt, hash, is_primary, role,
      created_at, updated_at, last_login_at, last_login_ip, login_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      username=excluded.username, username_lc=excluded.username_lc, salt=excluded.salt,
      hash=excluded.hash, is_primary=excluded.is_primary, role=excluded.role,
      created_at=excluded.created_at, updated_at=excluded.updated_at,
      last_login_at=excluded.last_login_at, last_login_ip=excluded.last_login_ip,
      login_count=excluded.login_count
  `);
  const ids = [];
  conn.exec('BEGIN');
  try {
    for (const u of users) {
      if (!u || !u.id || !u.username) continue;
      ids.push(String(u.id));
      upsert.run(
        String(u.id),
        String(u.username),
        String(u.username).toLowerCase(),
        String(u.salt || ''),
        String(u.hash || ''),
        u.primary ? 1 : 0,
        ['super', 'admin', 'user'].includes(u.role) ? u.role : 'user',
        u.createdAt || null,
        u.updatedAt || null,
        u.lastLoginAt || null,
        u.lastLoginIp || null,
        Number(u.loginCount) || 0,
      );
    }
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      conn.prepare(`DELETE FROM users WHERE id NOT IN (${marks})`).run(...ids);
    } else {
      conn.exec('DELETE FROM users');
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/* =========================================================
   二、会话（键 = sha256(token)）
   ========================================================= */
function loadSessions() {
  if (MODE === 'json') {
    const store = readJsonFile(SESSIONS_FILE, {});
    if (!store || typeof store !== 'object' || Array.isArray(store)) return {};
    // 只保留格式合法的键（sha256 = 64 位十六进制）。
    // 注意：旧版本存的明文 token 也是 64 位十六进制、无法从格式上区分，升级后它们已经对不上
    //（查表用的是 sha256(token)），要让它们彻底消失直接删 data/sessions.json 即可。
    const out = {};
    for (const [key, value] of Object.entries(store)) {
      if (/^[0-9a-f]{64}$/.test(key) && value && value.userId) out[key] = value;
    }
    return out;
  }
  const rows = openDb().prepare('SELECT token_hash, user_id, created_at, expires_at FROM sessions').all();
  const out = {};
  for (const row of rows) {
    out[row.token_hash] = {
      userId: row.user_id,
      expiresAt: Number(row.expires_at) || 0,
      createdAt: Number(row.created_at) || 0,
    };
  }
  return out;
}

function saveSessions(store) {
  const entries = Object.entries(store || {}).filter(([key, v]) => /^[0-9a-f]{64}$/.test(key) && v && v.userId);
  if (MODE === 'json') {
    writeJsonFile(SESSIONS_FILE, Object.fromEntries(entries));
    return;
  }
  const conn = openDb();
  const insert = conn.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
  );
  conn.exec('BEGIN');
  try {
    conn.exec('DELETE FROM sessions');
    for (const [key, value] of entries) {
      insert.run(
        key,
        String(value.userId),
        Number(value.createdAt) || 0,
        Number(value.expiresAt) || 0,
      );
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/* =========================================================
   三、自选 / 持仓 / 自选股
   ========================================================= */
function userDataFile(userId) {
  return path.join(USERDATA_DIR, `${String(userId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

function loadPortfolio(user) {
  if (!user) return { funds: [], holdings: {}, watchlist: [] };
  if (MODE === 'json') {
    const data = readJsonFile(userDataFile(user.id), null);
    const watchlist = data && Array.isArray(data.watchlist) ? data.watchlist : [];
    // 主账号的自选与持仓直接读推送配置：推送和页面永远是同一份。
    if (user.primary) {
      const cfg = loadPushConfig() || {};
      return { funds: cfg.funds || [], holdings: cfg.holdings || {}, watchlist };
    }
    return {
      funds: (data && Array.isArray(data.funds) && data.funds) || [],
      holdings: (data && data.holdings && typeof data.holdings === 'object' && !Array.isArray(data.holdings))
        ? data.holdings
        : {},
      watchlist,
    };
  }
  const conn = openDb();
  const funds = conn
    .prepare('SELECT code, name, type FROM portfolio_funds WHERE user_id = ? ORDER BY sort_order ASC, code ASC')
    .all(String(user.id))
    .map((row) => ({ code: row.code, name: row.name, type: row.type === 'etf' ? 'etf' : 'open' }));
  const holdings = {};
  for (const row of conn
    .prepare('SELECT code, shares, cost FROM portfolio_holdings WHERE user_id = ? ORDER BY rowid')
    .all(String(user.id))) {
    holdings[row.code] = { shares: Number(row.shares) || 0, cost: Number(row.cost) || 0 };
  }
  const watchlist = conn
    .prepare('SELECT secid, code, name FROM watchlist WHERE user_id = ? ORDER BY sort_order ASC, secid ASC')
    .all(String(user.id))
    .map((row) => ({ secid: row.secid, code: row.code, name: row.name }));
  return { funds, holdings, watchlist };
}

function savePortfolio(user, portfolio) {
  if (!user) return;
  const payload = {
    funds: Array.isArray(portfolio && portfolio.funds) ? portfolio.funds : [],
    holdings: portfolio && portfolio.holdings && typeof portfolio.holdings === 'object' && !Array.isArray(portfolio.holdings)
      ? portfolio.holdings
      : {},
    watchlist: Array.isArray(portfolio && portfolio.watchlist) ? portfolio.watchlist : [],
    updatedAt: Date.now(),
  };
  if (MODE === 'json') {
    if (user.primary) savePushConfig({ funds: payload.funds, holdings: payload.holdings });
    writeJsonFile(userDataFile(user.id), payload);
    return;
  }
  savePortfolioSqlite(user.id, payload);
}

/* =========================================================
   四、推送配置（sqlite 模式不再存 funds/holdings）
   ========================================================= */
function loadPushConfig() {
  if (MODE === 'json') {
    const raw = readJsonFile(PUSH_FILE, null);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  }
  const row = openDb().prepare('SELECT * FROM push_config WHERE id = 1').get();
  if (!row) return null;
  return {
    enabled: Boolean(row.enabled),
    channel: row.channel,
    token: row.token,
    webhook: row.webhook,
    time: row.time,
    weekdaysOnly: Boolean(row.weekdays_only),
    slots: safeParse(row.slots_json, []),
    lastSent: safeParse(row.last_sent_json, {}),
    lastResult: safeParse(row.last_result_json, null),
    followUp: safeParse(row.follow_up_json, {}),
    updatedAt: Number(row.updated_at) || undefined,
  };
}

function safeParse(text, fallback) {
  if (text === undefined || text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function savePushConfig(cfg) {
  const safe = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  if (MODE === 'json') {
    writeJsonFile(PUSH_FILE, safe);
    return;
  }
  // sqlite 模式：funds/holdings 属于 portfolio_*，写在这里只会造成两份真源。
  openDb()
    .prepare(`
      INSERT INTO push_config (id, enabled, channel, token, webhook, time, weekdays_only,
        slots_json, last_sent_json, last_result_json, follow_up_json, updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        enabled=excluded.enabled, channel=excluded.channel, token=excluded.token,
        webhook=excluded.webhook, time=excluded.time, weekdays_only=excluded.weekdays_only,
        slots_json=excluded.slots_json, last_sent_json=excluded.last_sent_json,
        last_result_json=excluded.last_result_json, follow_up_json=excluded.follow_up_json,
        updated_at=excluded.updated_at
    `)
    .run(
      safe.enabled ? 1 : 0,
      String(safe.channel || 'serverchan'),
      String(safe.token || ''),
      String(safe.webhook || ''),
      String(safe.time || '14:30'),
      safe.weekdaysOnly === false ? 0 : 1,
      JSON.stringify(Array.isArray(safe.slots) ? safe.slots : []),
      JSON.stringify(safe.lastSent && typeof safe.lastSent === 'object' ? safe.lastSent : {}),
      JSON.stringify(safe.lastResult === undefined ? null : safe.lastResult),
      JSON.stringify(safe.followUp === undefined ? null : safe.followUp),
      Date.now(),
    );
}

/* =========================================================
   五、使用统计
   ========================================================= */
let statsBaseline = null; // Map<'day\u0001uid', entryJson>
let loginsBaseline = null; // 上次落盘的 logins 数组（判断是否为纯追加）

function statsSnapshot(days) {
  const out = new Map();
  for (const [day, users] of Object.entries(days || {})) {
    for (const [uid, entry] of Object.entries(users || {})) {
      out.set(`${day}\u0001${uid}`, JSON.stringify(entry || {}));
    }
  }
  return out;
}

function loadStats() {
  let stats;
  if (MODE === 'json') {
    const raw = readJsonFile(STATS_FILE, { days: {}, logins: [] });
    stats = { days: {}, logins: [] };
    if (raw && raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) stats.days = raw.days;
    if (raw && Array.isArray(raw.logins)) stats.logins = raw.logins;
  } else {
    const conn = openDb();
    const days = {};
    for (const row of conn.prepare('SELECT * FROM stats_daily').all()) {
      if (!days[row.day]) days[row.day] = {};
      days[row.day][row.user_id] = {
        username: row.username || '',
        requests: Number(row.requests) || 0,
        api: Number(row.api) || 0,
        assets: Number(row.assets) || 0,
        bytes: Number(row.bytes) || 0,
        activeMs: Number(row.active_ms) || 0,
        firstSeen: Number(row.first_seen) || 0,
        lastSeen: Number(row.last_seen) || 0,
        logins: Number(row.logins) || 0,
        views: {},
        ips: {},
        ua: row.ua || '',
      };
    }
    for (const row of conn.prepare('SELECT day, user_id, view, count FROM stats_views').all()) {
      const entry = days[row.day] && days[row.day][row.user_id];
      if (entry) entry.views[row.view] = Number(row.count) || 0;
    }
    for (const row of conn.prepare('SELECT day, user_id, ip, count FROM stats_ips').all()) {
      const entry = days[row.day] && days[row.day][row.user_id];
      if (entry) entry.ips[row.ip] = Number(row.count) || 0;
    }
    const logins = conn
      .prepare('SELECT at, user_id, username, ok, action, reason, ip, ua FROM login_events ORDER BY at ASC, id ASC')
      .all()
      .map((row) => ({
        at: Number(row.at) || 0,
        userId: row.user_id || null,
        username: row.username || '',
        ok: Boolean(row.ok),
        action: row.action || '',
        reason: row.reason || '',
        ip: row.ip || '',
        ua: row.ua || '',
      }));
    stats = { days, logins };
  }
  statsBaseline = statsSnapshot(stats.days);
  loginsBaseline = stats.logins.slice();
  return stats;
}

function saveStats(stats) {
  const state = { days: {}, logins: [] };
  if (stats && stats.days && typeof stats.days === 'object' && !Array.isArray(stats.days)) state.days = stats.days;
  if (stats && Array.isArray(stats.logins)) state.logins = stats.logins;
  if (MODE === 'json') {
    writeJsonFile(STATS_FILE, state);
    statsBaseline = statsSnapshot(state.days);
    loginsBaseline = state.logins.slice();
    return;
  }
  saveStatsSqlite(state);
}

/* =========================================================
   六、运维：初始化 / 备份 / 迁移
   ========================================================= */
function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (MODE === 'sqlite') openDb();
  return MODE;
}

function backupTo(file) {
  if (!fs.existsSync(DB_FILE)) throw new Error(`数据库不存在：${DB_FILE}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.unlinkSync(file); // VACUUM INTO 要求目标不存在
  openDb().exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`);
  return file;
}

function checkpoint() {
  if (MODE !== 'sqlite' || !db) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
}

function readJsonUsers() {
  const store = readJsonFile(USERS_FILE, { users: [] });
  const users = store && Array.isArray(store.users) ? store.users : [];
  normalizeUserRoles(users);
  return users;
}

function readJsonSessions() {
  const store = readJsonFile(SESSIONS_FILE, {});
  if (!store || typeof store !== 'object' || Array.isArray(store)) return {};
  const out = {};
  for (const [key, value] of Object.entries(store)) {
    if (/^[0-9a-f]{64}$/.test(key) && value && value.userId) out[key] = value;
  }
  return out;
}

function readJsonPortfolio(user) {
  const data = readJsonFile(userDataFile(user.id), null);
  const watchlist = data && Array.isArray(data.watchlist) ? data.watchlist : [];
  if (user.primary) {
    const cfg = readJsonFile(PUSH_FILE, {}) || {};
    return { funds: Array.isArray(cfg.funds) ? cfg.funds : [], holdings: cfg.holdings || {}, watchlist };
  }
  return {
    funds: (data && Array.isArray(data.funds) && data.funds) || [],
    holdings: (data && data.holdings && typeof data.holdings === 'object' && !Array.isArray(data.holdings))
      ? data.holdings
      : {},
    watchlist,
  };
}

/**
 * JSON → SQLite 迁移。幂等（upsert）。
 * @param {{dryRun?: boolean, verify?: boolean}} opts
 */
function migrateFromJson(opts = {}) {
  const users = readJsonUsers();
  const sessions = readJsonSessions();
  const pushRaw = readJsonFile(PUSH_FILE, {}) || {};
  const statsRaw = readJsonFile(STATS_FILE, { days: {}, logins: [] }) || {};
  const portfolios = users.map((u) => ({ user: u, data: readJsonPortfolio(u) }));
  const report = {
    mode: 'json→sqlite',
    dryRun: Boolean(opts.dryRun),
    users: users.length,
    sessions: Object.keys(sessions).length,
    portfolios: portfolios.length,
    funds: portfolios.reduce((n, p) => n + p.data.funds.length, 0),
    holdings: portfolios.reduce((n, p) => n + Object.keys(p.data.holdings).length, 0),
    watchlist: portfolios.reduce((n, p) => n + p.data.watchlist.length, 0),
    statsDays: Object.keys(statsRaw.days || {}).length,
    loginEvents: Array.isArray(statsRaw.logins) ? statsRaw.logins.length : 0,
    warnings: [],
  };
  if (!users.length) report.warnings.push('users.json 为空：没有可迁移的账号');
  if (!users.some((u) => u.primary)) report.warnings.push('没有 primary 账号：push-config 里的 funds/holdings 无处挂载');
  if (opts.dryRun) return report;

  // 1) 账号（先写，外键才能成立）
  saveUsersSqlite(users);
  // 2) 会话（丢掉已经找不到对应用户的孤儿会话，否则外键会拦下整批插入）
  const conn = openDb();
  const knownIds = new Set(users.map((u) => String(u.id)));
  let orphanSessions = 0;
  conn.exec('BEGIN');
  try {
    conn.exec('DELETE FROM sessions');
    const insert = conn.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)');
    for (const [key, value] of Object.entries(sessions)) {
      if (!knownIds.has(String(value.userId))) { orphanSessions += 1; continue; }
      insert.run(key, String(value.userId), Number(value.createdAt) || 0, Number(value.expiresAt) || 0);
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  if (orphanSessions) report.warnings.push(`跳过 ${orphanSessions} 条找不到用户的会话`);
  // 3) 持仓 / 自选
  for (const item of portfolios) {
    savePortfolioSqlite(item.user.id, item.data);
  }
  // 4) 推送配置（没有配置文件时不建行，行为和「文件不存在」一致）
  const { funds: _f, holdings: _h, ...pushRest } = pushRaw;
  if (Object.keys(pushRest).length) savePushConfigSqlite(pushRest);
  // 5) 统计
  const days = statsRaw.days && typeof statsRaw.days === 'object' ? statsRaw.days : {};
  const logins = Array.isArray(statsRaw.logins) ? statsRaw.logins : [];
  statsBaseline = new Map(); // 强制全量写入
  loginsBaseline = [];
  saveStatsSqlite({ days, logins });

  if (opts.verify) report.verify = verifyAgainstJson();
  return report;
}

// 迁移内部用：绕过 MODE 判断，直接写 sqlite
function saveUsersSqlite(users) {
  const conn = openDb();
  const upsert = conn.prepare(`
    INSERT INTO users (id, username, username_lc, salt, hash, is_primary, role,
      created_at, updated_at, last_login_at, last_login_ip, login_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      username=excluded.username, username_lc=excluded.username_lc, salt=excluded.salt,
      hash=excluded.hash, is_primary=excluded.is_primary, role=excluded.role,
      created_at=excluded.created_at, updated_at=excluded.updated_at,
      last_login_at=excluded.last_login_at, last_login_ip=excluded.last_login_ip,
      login_count=excluded.login_count
  `);
  conn.exec('BEGIN');
  try {
    for (const u of users) {
      if (!u || !u.id || !u.username) continue;
      upsert.run(
        String(u.id),
        String(u.username),
        String(u.username).toLowerCase(),
        String(u.salt || ''),
        String(u.hash || ''),
        u.primary ? 1 : 0,
        ['super', 'admin', 'user'].includes(u.role) ? u.role : 'user',
        u.createdAt || null,
        u.updatedAt || null,
        u.lastLoginAt || null,
        u.lastLoginIp || null,
        Number(u.loginCount) || 0,
      );
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

function savePortfolioSqlite(userId, data) {
  const conn = openDb();
  const uid = String(userId);
  const insertFund = conn.prepare('INSERT INTO portfolio_funds (user_id, code, name, type, sort_order) VALUES (?,?,?,?,?)');
  const insertHold = conn.prepare('INSERT INTO portfolio_holdings (user_id, code, shares, cost, updated_at) VALUES (?,?,?,?,?)');
  const insertWatch = conn.prepare('INSERT INTO watchlist (user_id, secid, code, name, sort_order, added_at) VALUES (?,?,?,?,?,?)');
  conn.exec('BEGIN');
  try {
    conn.prepare('DELETE FROM portfolio_funds WHERE user_id = ?').run(uid);
    conn.prepare('DELETE FROM portfolio_holdings WHERE user_id = ?').run(uid);
    conn.prepare('DELETE FROM watchlist WHERE user_id = ?').run(uid);
    (data.funds || []).forEach((f, i) => {
      if (!f || !f.code) return;
      insertFund.run(uid, String(f.code), String(f.name || ''), f.type === 'etf' ? 'etf' : 'open', i);
    });
    for (const [code, h] of Object.entries(data.holdings || {})) {
      if (!code || !h) continue;
      insertHold.run(uid, String(code), Number(h.shares) || 0, Number(h.cost) || 0, Date.now());
    }
    (data.watchlist || []).forEach((w, i) => {
      if (!w || !w.secid) return;
      insertWatch.run(uid, String(w.secid), String(w.code || ''), String(w.name || ''), i, Date.now());
    });
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

function savePushConfigSqlite(cfg) {
  const safe = cfg && typeof cfg === 'object' ? cfg : {};
  openDb()
    .prepare(`
      INSERT INTO push_config (id, enabled, channel, token, webhook, time, weekdays_only,
        slots_json, last_sent_json, last_result_json, follow_up_json, updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        enabled=excluded.enabled, channel=excluded.channel, token=excluded.token,
        webhook=excluded.webhook, time=excluded.time, weekdays_only=excluded.weekdays_only,
        slots_json=excluded.slots_json, last_sent_json=excluded.last_sent_json,
        last_result_json=excluded.last_result_json, follow_up_json=excluded.follow_up_json,
        updated_at=excluded.updated_at
    `)
    .run(
      safe.enabled ? 1 : 0,
      String(safe.channel || 'serverchan'),
      String(safe.token || ''),
      String(safe.webhook || ''),
      String(safe.time || '14:30'),
      safe.weekdaysOnly === false ? 0 : 1,
      JSON.stringify(Array.isArray(safe.slots) ? safe.slots : []),
      JSON.stringify(safe.lastSent && typeof safe.lastSent === 'object' ? safe.lastSent : {}),
      JSON.stringify(safe.lastResult === undefined ? null : safe.lastResult),
      JSON.stringify(safe.followUp === undefined ? null : safe.followUp),
      Date.now(),
    );
}

function saveStatsSqlite(state) {
  const next = statsSnapshot(state.days);
  const prev = statsBaseline || new Map();
  const conn = openDb();
  const upsertDaily = conn.prepare(`
    INSERT INTO stats_daily (day, user_id, username, requests, api, assets, bytes, active_ms,
      first_seen, last_seen, logins, ua)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(day, user_id) DO UPDATE SET
      username=excluded.username, requests=excluded.requests, api=excluded.api, assets=excluded.assets,
      bytes=excluded.bytes, active_ms=excluded.active_ms, first_seen=excluded.first_seen,
      last_seen=excluded.last_seen, logins=excluded.logins, ua=excluded.ua
  `);
  const deleteDaily = conn.prepare('DELETE FROM stats_daily WHERE day = ? AND user_id = ?');
  const deleteViews = conn.prepare('DELETE FROM stats_views WHERE day = ? AND user_id = ?');
  const deleteIps = conn.prepare('DELETE FROM stats_ips WHERE day = ? AND user_id = ?');
  const insertView = conn.prepare('INSERT INTO stats_views (day, user_id, view, count) VALUES (?,?,?,?)');
  const insertIp = conn.prepare('INSERT INTO stats_ips (day, user_id, ip, count) VALUES (?,?,?,?)');
  const insertLogin = conn.prepare(
    'INSERT INTO login_events (at, user_id, username, ok, action, reason, ip, ua) VALUES (?,?,?,?,?,?,?,?)',
  );
  conn.exec('BEGIN');
  try {
    for (const [key, json] of next) {
      if (prev.get(key) === json) continue;
      const [day, uid] = key.split('\u0001');
      const entry = JSON.parse(json);
      upsertDaily.run(
        day, uid, String(entry.username || ''), Number(entry.requests) || 0, Number(entry.api) || 0,
        Number(entry.assets) || 0, Number(entry.bytes) || 0, Number(entry.activeMs) || 0,
        Number(entry.firstSeen) || 0, Number(entry.lastSeen) || 0, Number(entry.logins) || 0,
        String(entry.ua || ''),
      );
      deleteViews.run(day, uid);
      for (const [view, count] of Object.entries(entry.views || {})) {
        insertView.run(day, uid, String(view).slice(0, 32), Number(count) || 0);
      }
      deleteIps.run(day, uid);
      for (const [ip, count] of Object.entries(entry.ips || {})) {
        insertIp.run(day, uid, String(ip).slice(0, 64), Number(count) || 0);
      }
    }
    for (const key of prev.keys()) {
      if (next.has(key)) continue;
      const [day, uid] = key.split('\u0001');
      deleteDaily.run(day, uid);
      deleteViews.run(day, uid);
      deleteIps.run(day, uid);
    }
    conn.exec('DELETE FROM login_events');
    for (const ev of state.logins) {
      insertLogin.run(
        Number(ev.at) || 0, ev.userId || null, String(ev.username || ''), ev.ok ? 1 : 0,
        String(ev.action || ''), String(ev.reason || ''), String(ev.ip || ''), String(ev.ua || ''),
      );
    }
    conn.exec('DELETE FROM login_events WHERE id NOT IN (SELECT id FROM login_events ORDER BY id DESC LIMIT 2000)');
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  statsBaseline = next;
  loginsBaseline = state.logins.slice();
}

/** 迁移后逐项比对：数据库 vs 源 JSON */
function verifyAgainstJson() {
  const problems = [];
  const users = readJsonUsers();
  const dbUsers = openDb().prepare('SELECT * FROM users').all();
  if (dbUsers.length !== users.length) problems.push(`账号数不一致：db=${dbUsers.length} json=${users.length}`);
  const byId = new Map(dbUsers.map((r) => [r.id, r]));
  for (const u of users) {
    const row = byId.get(u.id);
    if (!row) { problems.push(`缺账号 ${u.username}`); continue; }
    if (row.hash !== u.hash || row.salt !== u.salt) problems.push(`账号 ${u.username} 的哈希/盐不一致`);
    if (String(row.role) !== String(u.role)) problems.push(`账号 ${u.username} 角色不一致`);
    if (Boolean(row.is_primary) !== Boolean(u.primary)) problems.push(`账号 ${u.username} primary 标记不一致`);
  }
  const sessions = readJsonSessions();
  const dbSessions = openDb().prepare('SELECT token_hash, expires_at FROM sessions').all();
  if (dbSessions.length !== Object.keys(sessions).length) {
    problems.push(`会话数不一致：db=${dbSessions.length} json=${Object.keys(sessions).length}`);
  }
  const sessMap = new Map(dbSessions.map((r) => [r.token_hash, Number(r.expires_at)]));
  for (const [key, v] of Object.entries(sessions)) {
    if (sessMap.get(key) !== Number(v.expiresAt)) problems.push(`会话 ${key.slice(0, 8)}… 过期时间不一致`);
  }
  const sortedMap = (o) => {
    const out = {};
    for (const k of Object.keys(o || {}).sort()) out[k] = o[k];
    return JSON.stringify(out);
  };
  for (const u of users) {
    const expected = readJsonPortfolio(u);
    const actual = loadPortfolioSqlite(u.id);
    if (JSON.stringify(expected.funds) !== JSON.stringify(actual.funds)) {
      problems.push(`账号 ${u.username} 自选基金不一致（json=${expected.funds.length} db=${actual.funds.length}）`);
    }
    // 持仓是键值表，顺序没有语义：按 key 排序后比较。
    if (sortedMap(expected.holdings) !== sortedMap(actual.holdings)) {
      problems.push(`账号 ${u.username} 持仓不一致`);
    }
    if (JSON.stringify(expected.watchlist) !== JSON.stringify(actual.watchlist)) {
      problems.push(`账号 ${u.username} 自选股不一致`);
    }
  }
  const pushRaw = readJsonFile(PUSH_FILE, {}) || {};
  const pushRest = (() => {
    const { funds: _f, holdings: _h, ...rest } = pushRaw;
    return rest;
  })();
  const dbPush = loadPushConfigSqlite();
  const strip = (o) => {
    // funds/holdings 已搬到 portfolio_*；updatedAt 是数据库自带的时间戳，不参与比较。
    const { funds: _f, holdings: _h, updatedAt: _u, ...rest } = o || {};
    const keys = Object.keys(rest).sort();
    const out = {};
    for (const k of keys) out[k] = rest[k];
    return JSON.stringify(out);
  };
  if (Object.keys(pushRest).length && strip(pushRaw) !== strip(dbPush)) {
    const a = JSON.parse(strip(pushRaw));
    const b = JSON.parse(strip(dbPush));
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) problems.push(`推送配置字段 ${k} 不一致`);
    }
  } else if (!Object.keys(pushRest).length && dbPush) {
    problems.push('源 JSON 没有推送配置，但库里有一行 push_config');
  }
  const statsRaw = readJsonFile(STATS_FILE, { days: {}, logins: [] }) || {};
  const dbStats = loadStatsSqlite();
  const sum = (days) => {
    let requests = 0; let bytes = 0; let logins = 0;
    for (const users of Object.values(days || {})) {
      for (const entry of Object.values(users || {})) {
        requests += Number(entry.requests) || 0;
        bytes += Number(entry.bytes) || 0;
        logins += Number(entry.logins) || 0;
      }
    }
    return { requests, bytes, logins };
  };
  const a = sum(statsRaw.days);
  const b = sum(dbStats.days);
  for (const k of ['requests', 'bytes', 'logins']) {
    if (a[k] !== b[k]) problems.push(`统计 ${k} 不一致：json=${a[k]} db=${b[k]}`);
  }
  if ((statsRaw.logins || []).length !== dbStats.logins.length) {
    problems.push(`登录事件数不一致：json=${(statsRaw.logins || []).length} db=${dbStats.logins.length}`);
  }
  return { ok: problems.length === 0, problems };
}

// 迁移校验用：不依赖 MODE 的只读查询
function loadPortfolioSqlite(userId) {
  const conn = openDb();
  const uid = String(userId);
  const funds = conn
    .prepare('SELECT code, name, type FROM portfolio_funds WHERE user_id = ? ORDER BY sort_order ASC, code ASC')
    .all(uid)
    .map((row) => ({ code: row.code, name: row.name, type: row.type === 'etf' ? 'etf' : 'open' }));
  const holdings = {};
  for (const row of conn
    .prepare('SELECT code, shares, cost FROM portfolio_holdings WHERE user_id = ? ORDER BY rowid')
    .all(String(uid))) {
    holdings[row.code] = { shares: Number(row.shares) || 0, cost: Number(row.cost) || 0 };
  }
  const watchlist = conn
    .prepare('SELECT secid, code, name FROM watchlist WHERE user_id = ? ORDER BY sort_order ASC, secid ASC')
    .all(uid)
    .map((row) => ({ secid: row.secid, code: row.code, name: row.name }));
  return { funds, holdings, watchlist };
}

function loadPushConfigSqlite() {
  const row = openDb().prepare('SELECT * FROM push_config WHERE id = 1').get();
  if (!row) return null;
  return {
    enabled: Boolean(row.enabled),
    channel: row.channel,
    token: row.token,
    webhook: row.webhook,
    time: row.time,
    weekdaysOnly: Boolean(row.weekdays_only),
    slots: safeParse(row.slots_json, []),
    lastSent: safeParse(row.last_sent_json, {}),
    lastResult: safeParse(row.last_result_json, null),
    followUp: safeParse(row.follow_up_json, {}),
    updatedAt: Number(row.updated_at) || undefined,
  };
}

function loadStatsSqlite() {
  const conn = openDb();
  const days = {};
  for (const row of conn.prepare('SELECT * FROM stats_daily').all()) {
    if (!days[row.day]) days[row.day] = {};
    days[row.day][row.user_id] = {
      username: row.username || '',
      requests: Number(row.requests) || 0,
      api: Number(row.api) || 0,
      assets: Number(row.assets) || 0,
      bytes: Number(row.bytes) || 0,
      activeMs: Number(row.active_ms) || 0,
      firstSeen: Number(row.first_seen) || 0,
      lastSeen: Number(row.last_seen) || 0,
      logins: Number(row.logins) || 0,
      views: {},
      ips: {},
      ua: row.ua || '',
    };
  }
  const logins = conn
    .prepare('SELECT at, user_id, username, ok, action, reason, ip, ua FROM login_events ORDER BY at ASC, id ASC')
    .all()
    .map((row) => ({
      at: Number(row.at) || 0,
      userId: row.user_id || null,
      username: row.username || '',
      ok: Boolean(row.ok),
      action: row.action || '',
      reason: row.reason || '',
      ip: row.ip || '',
      ua: row.ua || '',
    }));
  return { days, logins };
}

module.exports = {
  mode: MODE,
  DB_FILE,
  SCHEMA,
  SCHEMA_VERSION,
  MIGRATIONS,
  init,
  close: closeDb,
  checkpoint,
  backupTo,
  migrateFromJson,
  verifyAgainstJson,
  // schema 版本与迁移（2026-11-17，方案 A）
  migrateOnOpen,
  runMigrations,
  schemaStatus,
  schemaDrift,
  // 通用文件读写（server.js 的行情缓存复用）
  readJsonFile,
  writeJsonFile,
  // 数据接口（与改造前同名同签名）
  loadUsers,
  saveUsers,
  loadSessions,
  saveSessions,
  loadPortfolio,
  savePortfolio,
  loadPushConfig,
  savePushConfig,
  loadStats,
  saveStats,
  // 仅迁移/校验用
  loadPortfolioSqlite,
  loadStatsSqlite,
  saveUsersSqlite,
  savePortfolioSqlite,
  savePushConfigSqlite,
  saveStatsSqlite,
  openDb,
};
