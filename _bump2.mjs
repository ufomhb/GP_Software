import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const FROM = '2.10.6';
const TO = '2.10.7';
const esc = (s) => s.replace(/\./g, '\\.');
const targets = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|html|css)$/.test(name)) targets.push(p);
  }
};
walk(join(ROOT, 'public'));
targets.push(join(ROOT, 'server.js'), join(ROOT, 'package.json'));

let changed = 0;
for (const file of targets) {
  const text = readFileSync(file, 'utf8');
  const next = text
    .replace(new RegExp(`VERSION = '${esc(FROM)}'`, 'g'), `VERSION = '${TO}'`)
    .replace(new RegExp(`APP_VERSION = '${esc(FROM)}'`, 'g'), `APP_VERSION = '${TO}'`)
    .replace(new RegExp(`"version": "${esc(FROM)}"`, 'g'), `"version": "${TO}"`)
    .replace(new RegExp(`\\?v=${esc(FROM)}`, 'g'), `?v=${TO}`);
  if (next !== text) {
    writeFileSync(file, next, 'utf8');
    changed += 1;
  }
}
console.log('files changed:', changed);
