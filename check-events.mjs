import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/data/gp/data/gp.sqlite', { readOnly: true });
const q = (sql, label) => {
  try { console.log(`--- ${label} ---`); console.log(JSON.stringify(db.prepare(sql).all(), null, 0)); }
  catch (e) { console.log(`--- ${label} ERR: ${e.message}`); }
};
console.log('login_events columns:', JSON.stringify(db.prepare('PRAGMA table_info(login_events)').all().map(c => c.name)));
q('SELECT * FROM login_events ORDER BY rowid DESC LIMIT 12', 'LAST LOGINS');
console.log('sessions columns:', JSON.stringify(db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name)));
q('SELECT * FROM sessions ORDER BY rowid DESC LIMIT 10', 'LIVE SESSIONS');
console.log('stats_views columns:', JSON.stringify(db.prepare('PRAGMA table_info(stats_views)').all().map(c => c.name)));
q('SELECT * FROM stats_views ORDER BY rowid DESC LIMIT 12', 'RECENT VIEWS');
