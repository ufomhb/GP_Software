import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/data/gp/data/gp.sqlite', { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('TABLES:', tables.map(t => t.name).join(', '));
for (const t of tables) {
  try {
    const c = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get();
    console.log(`  ${t.name}: ${c.n}`);
  } catch (e) { console.log(`  ${t.name}: ERR ${e.message}`); }
}
try {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
  console.log('USERS:', JSON.stringify(users));
} catch (e) { console.log('USERS ERR:', e.message); }
try {
  const s = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
  console.log('SESSIONS:', JSON.stringify(s));
} catch (e) { console.log('SESSIONS ERR:', e.message); }
