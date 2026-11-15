'use strict';
/**
 * 日志文件（2026-11-15）
 *
 * 背景：服务原先只往 stdout 打日志，NAS 上是 journald、Windows 上是黑窗口，
 * 关掉窗口就丢；后台也没有地方看「刚才那个 500 到底报了什么」。
 * 这里把 console 输出同时落盘到 logs/，并按大小轮转，供后台「系统日志」菜单读取。
 *
 * 设计取舍：
 * - 同步追加（appendFileSync）：与项目其余同步 IO 风格一致，单行量级、无缓冲，崩溃不丢最后一行；
 * - 按大小轮转而不是按天：文件数固定（keep+1 个），后台首页不必按日期列一长串；
 * - 写失败不抛（磁盘满/只读挂载时服务必须继续跑），连续失败 3 次后自动摘掉 tee 并提示一次；
 * - 读取只给「末尾 N 行」：日志文件可能几十 MB，绝不全量读进内存。
 */

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const DEFAULTS = {
  dir: 'logs',
  name: 'server',
  maxBytes: 5 * 1024 * 1024, // 单文件 5 MB
  keep: 3, // 保留 server.log.1 ~ server.log.3
  tailBytes: 512 * 1024, // 每次最多回读 512 KB
  maxLines: 2000,
  maxFailures: 3,
};

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** 本地时间 `YYYY-MM-DD HH:mm:ss`（日志给人看，用本地时区） */
function stampOf(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 从文件尾部倒着读，最多 tailBytes 字节；start > 0 时丢掉被截断的首行 */
function readTail(file, tailBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buf, 0, length, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift();
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return { lines, size };
  } finally {
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
  }
}

function createLogFiles(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const dir = path.resolve(opts.dir);
  const name = String(opts.name || 'server');
  const current = path.join(dir, `${name}.log`);
  const rotated = (i) => path.join(dir, `${name}.log.${i}`);

  let bytes = null; // 当前文件大小缓存，避免每行 stat
  let failures = 0;
  let detached = false;
  let uninstallTee = null;
  const extras = []; // 额外日志源（例如 data/crash.log）

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function currentBytes() {
    if (bytes === null) {
      try { bytes = fs.statSync(current).size; } catch { bytes = 0; }
    }
    return bytes;
  }

  function rotate() {
    // server.log.keep 丢掉，其余依次后移，当前文件变成 .1
    try { fs.rmSync(rotated(opts.keep), { force: true }); } catch { /* 忽略 */ }
    for (let i = opts.keep - 1; i >= 1; i -= 1) {
      try { fs.renameSync(rotated(i), rotated(i + 1)); } catch { /* 不存在就跳过 */ }
    }
    try { fs.renameSync(current, rotated(1)); } catch { /* 不存在就跳过 */ }
    bytes = 0;
  }

  /** 追加一行（自动补换行、按需轮转）；返回是否写成功 */
  function write(text) {
    if (detached) return false;
    const line = text.endsWith('\n') ? text : `${text}\n`;
    try {
      ensureDir();
      if (currentBytes() + Buffer.byteLength(line) > opts.maxBytes) rotate();
      fs.appendFileSync(current, line, 'utf8');
      bytes = currentBytes() + Buffer.byteLength(line);
      failures = 0;
      return true;
    } catch (err) {
      failures += 1;
      if (failures >= opts.maxFailures && !detached) {
        detached = true;
        if (uninstallTee) uninstallTee();
        // 用原始 console 提示一次，避免再次进入 tee 递归
        process.stderr.write(`[log-files] 日志落盘连续失败 ${failures} 次，已停止写文件：${err.message}\n`);
      }
      return false;
    }
  }

  /** 把 console.* 镜像到文件；返回卸载函数 */
  function installConsoleTee(target = console) {
    const levels = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' };
    const original = {};
    for (const key of Object.keys(levels)) {
      if (typeof target[key] !== 'function') continue;
      original[key] = target[key];
      target[key] = (...args) => {
        // 先落盘再打印：进程被强杀时文件里已经有这一行
        write(`${stampOf()} ${levels[key]} ${util.format(...args)}`);
        original[key].apply(target, args);
      };
    }
    uninstallTee = () => {
      for (const key of Object.keys(original)) target[key] = original[key];
      uninstallTee = null;
    };
    return uninstallTee;
  }

  /** 注册额外日志源（不受轮转管理，只读），如 data/crash.log */
  function addSource({ id, label, file }) {
    if (!id || !file) return;
    extras.push({ id: String(id), label: String(label || id), file: path.resolve(file) });
  }

  function statOf(file) {
    try {
      const s = fs.statSync(file);
      return { size: s.size, mtime: s.mtimeMs };
    } catch {
      return { size: 0, mtime: 0 };
    }
  }

  /** 可选日志源列表：轮转文件（新→旧）+ 额外源 */
  function list() {
    const out = [];
    const cur = statOf(current);
    if (cur.size > 0) {
      out.push({ id: name, label: `${name}.log（当前）`, ...cur, current: true });
    }
    for (let i = 1; i <= opts.keep; i += 1) {
      const file = rotated(i);
      const s = statOf(file);
      if (s.size > 0) out.push({ id: `${name}.${i}`, label: `${name}.log.${i}（较早）`, ...s, current: false });
    }
    for (const e of extras) {
      const s = statOf(e.file);
      out.push({ id: e.id, label: e.label, ...s, current: false });
    }
    return out;
  }

  function resolveSource(id) {
    const want = String(id || '');
    if (want && want !== name) {
      for (let i = 1; i <= opts.keep; i += 1) {
        if (want === `${name}.${i}`) return { id: want, label: `${name}.log.${i}`, file: rotated(i) };
      }
      const hit = extras.find((e) => e.id === want);
      if (hit) return hit;
    }
    return { id: name, label: `${name}.log`, file: current };
  }

  /**
   * 读取某个日志源的末尾内容
   * @param {{ id?: string, lines?: number, filter?: string }} query
   * @returns {{ id, label, size, mtime, lines: string[], total, matched, truncated }}
   */
  function tail(query = {}) {
    const source = resolveSource(query.id);
    const wantLines = Math.max(1, Math.min(opts.maxLines, toInt(query.lines, 200)));
    const filter = String(query.filter || '').slice(0, 80).toLowerCase();
    const stat = statOf(source.file);
    if (!stat.size) {
      return { id: source.id, label: source.label, size: 0, mtime: 0, lines: [], total: 0, matched: 0, truncated: false };
    }
    let { lines } = readTail(source.file, opts.tailBytes);
    const total = lines.length;
    if (filter) lines = lines.filter((l) => l.toLowerCase().includes(filter));
    const matched = lines.length;
    const truncated = lines.length > wantLines;
    if (truncated) lines = lines.slice(-wantLines);
    return { id: source.id, label: source.label, ...stat, lines, total, matched, truncated };
  }

  return {
    dir,
    file: current,
    write,
    installConsoleTee,
    addSource,
    list,
    tail,
    isDetached: () => detached,
  };
}

module.exports = { createLogFiles, readTail, stampOf };
