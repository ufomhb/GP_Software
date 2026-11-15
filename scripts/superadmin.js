'use strict';

/* =========================================================
   超级管理员账号工具（2026-11-15）
   用法：
     node scripts/superadmin.js                          # 自动生成 superadmin 与随机密码
     node scripts/superadmin.js --user=superadmin        # 指定用户名，密码自动生成
     node scripts/superadmin.js --user=superadmin --password=你的密码
     node scripts/superadmin.js --list                   # 只列出账号与角色
     node scripts/superadmin.js --user=superadmin --demote
   说明：
     - 账号密码仍按 users.json 的 scrypt 加盐格式保存，脚本不落明文；
     - 重复执行同一个用户 = 重置密码（角色仍为 super）；
     - 最后一个超级管理员不能被降级。
   ========================================================= */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const USERS_FILE = path.join(ROOT, 'data', 'users.json');

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (m) args.set(m[1], m[2] === undefined ? true : m[2]);
}

function readUsers() {
  try {
    const store = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (store && Array.isArray(store.users)) return store;
  } catch { /* 文件不存在时从空表开始 */ }
  return { users: [] };
}

function writeUsers(store) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function roleOf(user) {
  if (!user) return 'user';
  if (user.role === 'super' || user.role === 'admin' || user.role === 'user') return user.role;
  return user.primary ? 'admin' : 'user';
}

function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let body = '';
  for (let i = 0; i < bytes.length; i += 1) body += alphabet[bytes[i] % alphabet.length];
  return `Gp-${body}`;
}

const store = readUsers();
// 先把旧账号的 role 补齐（主账号 = admin，其余 = user）。
let migrated = false;
for (const user of store.users) {
  if (!user.role) {
    user.role = user.primary ? 'admin' : 'user';
    migrated = true;
  }
}

if (args.has('list')) {
  if (migrated) writeUsers(store);
  console.log('账号列表：');
  for (const u of store.users) {
    console.log(`  ${String(u.username).padEnd(18)} role=${roleOf(u).padEnd(5)} primary=${u.primary ? 'yes' : 'no'} 创建=${u.createdAt || '-'}`);
  }
  const supers = store.users.filter((u) => roleOf(u) === 'super').length;
  console.log(`\n超级管理员数量：${supers}`);
  process.exit(0);
}

const username = String(args.get('user') || args.get('username') || 'superadmin').trim();
if (!/^[\w\u4e00-\u9fa5.-]{3,20}$/.test(username)) {
  console.error('用户名需为 3-20 位中文、字母、数字、下划线、点或横线');
  process.exit(1);
}

const existing = store.users.find((u) => String(u.username).toLowerCase() === username.toLowerCase());

if (args.has('demote')) {
  if (!existing) {
    console.error(`用户 ${username} 不存在`);
    process.exit(1);
  }
  const supers = store.users.filter((u) => roleOf(u) === 'super');
  if (supers.length <= 1 && roleOf(existing) === 'super') {
    console.error('这是最后一个超级管理员，不能降级。');
    process.exit(1);
  }
  existing.role = existing.primary ? 'admin' : 'user';
  existing.updatedAt = new Date().toISOString();
  writeUsers(store);
  console.log(`已把 ${username} 降级为 ${existing.role}`);
  process.exit(0);
}

const password = String(args.get('password') || randomPassword());
if (password.length < 10) {
  console.error('超级管理员密码至少 10 位');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const now = new Date().toISOString();
let user = existing;
if (user) {
  user.salt = salt;
  user.hash = hashPassword(password, salt);
  user.role = 'super';
  user.updatedAt = now;
} else {
  user = {
    id: `u${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
    username,
    salt,
    hash: hashPassword(password, salt),
    primary: false,
    role: 'super',
    createdAt: now,
    updatedAt: now,
  };
  store.users.push(user);
}
writeUsers(store);

console.log('');
console.log('  ╔══════════════════════════════════════════════╗');
console.log('  ║          超级管理员账号已就绪                ║');
console.log('  ╚══════════════════════════════════════════════╝');
console.log(`  用户名: ${username}`);
console.log(`  密  码: ${password}`);
console.log(`  登录页: http://localhost:8090/admin.html`);
console.log('');
console.log('  请把密码保存到安全的地方；忘记后可再次执行本脚本重置。');
