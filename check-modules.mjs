import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const root = 'public/js';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(root);
const exportsMap = new Map();

function collectExports(src) {
  const names = new Set();
  // export function/const/let/var/class/async function
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  // export default
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}

for (const f of files) exportsMap.set(resolve(f), collectExports(readFileSync(f, 'utf8')));

let problems = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const defaultName = m[1];
    const named = m[2];
    const spec = m[3];
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(f), spec);
    const exp = exportsMap.get(target);
    if (!exp) { console.log(`[MISSING FILE] ${f} -> ${spec}`); problems++; continue; }
    if (defaultName && !exp.has('default')) { console.log(`[NO DEFAULT] ${f} imports default from ${spec}`); problems++; }
    if (named) {
      for (const part of named.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const local = t.split(/\s+as\s+/)[0].trim();
        if (!exp.has(local)) { console.log(`[MISSING EXPORT] ${f}: '${local}' not exported by ${spec}`); problems++; }
      }
    }
  }
}
console.log(problems === 0 ? 'OK: 所有 import 都能在目标模块找到对应 export' : `发现 ${problems} 处模块契约问题`);
