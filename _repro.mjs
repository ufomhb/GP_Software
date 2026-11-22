import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8090/', pretendToBeVisual: true });
const { window } = dom;
for (const key of ['document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle']) {
  if (window[key] === undefined) continue;
  try { Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true }); } catch {}
}
try { Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true }); } catch {}
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
const chartInstances = new Map();
window.echarts = {
  graphic: { LinearGradient: class { constructor() { this.type = 'linear'; } } },
  init: (el) => { const inst = { setOption() {}, on() {}, off() {}, resize() {}, dispose() {}, getWidth: () => 600, getHeight: () => 200, getOption: () => ({}), convertFromPixel: () => 0 }; chartInstances.set(el, inst); return inst; },
  getInstanceByDom: (el) => chartInstances.get(el) || null,
};
globalThis.echarts = window.echarts;
globalThis.__GP_NO_AUTOBOOT__ = true;
const app = await import(pathToFileURL(join(ROOT, 'public', 'js', 'app.js')).href);

const holdings = {
  '021277': { shares: 10000, cost: 4.5, addedAt: 1795320000000 },
  '025209': { shares: 1000, cost: 1.5, addedAt: 1795320000000 },
};
const points = (code, last, closes) => ({ code, points: closes.map((c, i) => ({ d: last[i], c })) });
app.state.portfolios = [{ id: 'pwnhkl0', name: 'TEST', isDefault: false, holdings }];
app.state.activePortfolioId = 'pwnhkl0';
app.state.fundHoldings = holdings;
app.state.fundWatchlist = [
  { code: '021277', name: '广发全球精选股票(QDII)人民币C', type: 'open' },
  { code: '025209', name: '永赢先锋半导体智选混合发起C', type: 'open' },
];
app.state.fundWatchData = { items: [] };
app.state.fundPnl = {
  codes: '021277,025209',
  items: [
    points('021277', ['2026-11-17', '2026-11-18', '2026-11-19'], [4.9, 4.95, 4.9806]),
    points('025209', ['2026-11-18', '2026-11-19', '2026-11-20'], [1.58, 1.59, 1.5971]),
  ],
  index: null,
  missing: [],
};
console.log('daily =', app.computeFundDailyPnl(app.state.fundPnl.items, holdings));
console.log('pnl =', app.computeFundPnl(app.state.fundPnl));
app.renderFundPnl();
console.log('--- KPIs:', document.querySelector('#fundPnlKpis').textContent.replace(/\s+/g, ' ').trim());
console.log('--- note:', document.querySelector('#fundPnlNote').textContent);
app.renderFundPnlCalendar();
console.log('--- calendar:', document.querySelector('#fundPnlCalendar').textContent.replace(/\s+/g, ' ').trim().slice(0, 200));
console.log('--- cal meta:', document.querySelector('#fundPnlCalendarMeta').textContent);
console.log('--- cal note:', document.querySelector('#fundPnlCalendarNote').textContent);
app.renderFundVsIndex();
console.log('--- vsIndex:', document.querySelector('#fundVsIndex')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200));
