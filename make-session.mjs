import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('/data/gp/data/gp.sqlite');
const token = crypto.randomBytes(24).toString('hex');
const hash = crypto.createHash('sha256').update(token).digest('hex');
const userId = 'umwfudwtt2c4935'; // meng-haibo (admin)
const now = Date.now();
db.prepare('INSERT OR REPLACE INTO sessions (token_hash, user_id, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?,?)')
  .run(hash, userId, now, now + 3600_000, 'diag', 'diag');
console.log(token);
