#!/usr/bin/env node
/**
 * SQLite 在线快照备份（P1）
 *
 *   node scripts/backup-sqlite.mjs [输出路径]
 *   默认输出：data/backup/gp-YYYYMMDD-HHMM.sqlite
 *
 * 用 VACUUM INTO 生成一致性快照：即使服务正在跑，得到的也是完整可用的库文件。
 * NAS 上建议每天跑一次（可以挂到 gp-data-backup.timer 里）：
 *   node scripts/backup-sqlite.mjs /data/backup/gp-data/gp-$(date +%Y%m%d).sqlite
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = require(join(ROOT, 'lib', 'store.js'));

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const out = process.argv[2] || join(ROOT, 'data', 'backup', `gp-${stamp()}.sqlite`);

try {
  if (!existsSync(store.DB_FILE)) {
    console.error(`没有找到数据库：${store.DB_FILE}`);
    console.error('（先跑 node scripts/migrate-json-to-sqlite.mjs）');
    process.exit(1);
  }
  store.backupTo(out);
  const size = statSync(out).size;
  console.log(`快照完成：${out}（${(size / 1024).toFixed(1)} KB）`);
  store.close();
} catch (err) {
  console.error('备份失败：', err && err.stack ? err.stack : err);
  process.exit(1);
}
