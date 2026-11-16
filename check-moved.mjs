import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk('public/js');
const info = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const declared = new Set();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  const imported = new Set();
  for (const m of src.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g)) {
    if (m[1]) imported.add(m[1]);
    if (m[2]) for (const part of m[2].split(',')) {
      const t = part.trim(); if (!t) continue;
      imported.add(t.split(/\s+as\s+/)[1] ? t.split(/\s+as\s+/)[1].trim() : t);
    }
  }
  info.set(resolve(f), { src, declared, imported });
}

let hits = 0;
for (const [file, { src, declared, imported }] of info) {
  for (const [otherFile, other] of info) {
    if (otherFile === file) continue;
    for (const name of other.declared) {
      if (declared.has(name) || imported.has(name)) continue;
      const re = new RegExp(`(^|[^\\w$.])${name}\\s*\\(`, 'm');
      if (re.test(src)) {
        console.log(`[CALL WITHOUT IMPORT] ${file}\n    -> ${name}() 定义在 ${otherFile}`);
        hits++;
      }
    }
  }
}
console.log(hits ? `共 ${hits} 处可疑跨模块调用` : 'OK: 没有发现"调用未导入的跨模块函数"');
