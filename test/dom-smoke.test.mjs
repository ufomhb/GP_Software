/**
 * 前端 DOM smoke 测试
 *
 * 用 jsdom 载入真实的 index.html，把 app.js 当模块加载（关掉自动 init），
 * 直接驱动渲染函数，断言两件事：
 *   1. 关键视图能渲染出内容（拆 app.js 之后的回归网）
 *   2. 来自服务端/上游的文本与 URL 不会变成可执行的 HTML/协议
 *
 * 注意：这里不启动后端、不发网络请求，纯渲染层断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');

// 建立 DOM 环境（模块顶层只做一次；app.js 的模块状态在多次用例间复用）
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8090/', pretendToBeVisual: true });
const { window } = dom;

for (const key of [
  'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
  'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle',
]) {
  if (window[key] === undefined) continue;
  try {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
  } catch { /* 少数内建属性不可覆盖（如 navigator），跳过即可 */ }
}
try {
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true });
} catch { /* 忽略 */ }
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (!window.matchMedia) {
  window.matchMedia = () => ({
    matches: false, media: '', onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}
// 渲染层不应该发请求；真发了就返回空 JSON，别抛异常
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.__GP_NO_AUTOBOOT__ = true;

const app = await import(pathToFileURL(join(ROOT, 'public', 'js', 'app.js')).href);

test('DOM：index.html 能载入，关键容器存在', () => {
  assert.ok(document.querySelector('#newsList'), '缺少 #newsList');
  assert.ok(document.querySelectorAll('.view').length >= 5, '视图区块太少');
});

test('DOM：esc() 转义五类字符', () => {
  const { esc } = app;
  assert.equal(esc(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(esc(null), '');
});

test('DOM：safeUrl 挡掉危险协议，放行 http(s) 与相对路径', () => {
  const { safeUrl } = app;
  assert.equal(safeUrl('https://finance.eastmoney.com/a/1.html'), 'https://finance.eastmoney.com/a/1.html');
  assert.equal(safeUrl('http://example.com/x'), 'http://example.com/x');
  assert.equal(safeUrl('/news/1.html'), '/news/1.html');
  assert.equal(safeUrl('#top'), '#top');
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('JavaScript:alert(1)'), '#');
  assert.equal(safeUrl('java\tscript:alert(1)'), '#', '含控制字符的伪协议也要挡');
  assert.equal(safeUrl('data:text/html,<script>x</script>'), '#');
  assert.equal(safeUrl(''), '#');
  assert.equal(safeUrl(null, '/fallback'), '/fallback');
});

test('DOM：快讯里的恶意标题/摘要/链接都被中和', () => {
  const payload = {
    items: [
      {
        title: '<img src=x onerror="window.__xss=1">',
        summary: '<script>window.__xss=2</script>',
        url: 'javascript:window.__xss=3',
        time: '2026-11-15 10:00:00',
        sentiment: 1,
      },
      { title: '正常标题 & 符号', summary: '', url: 'https://example.com/a', time: '2026-11-15 11:00:00', sentiment: 0 },
    ],
    sentiment: { label: '中性', positive: 0, negative: 0 },
  };
  app.state.news = payload;
  app.renderNewsList();

  const box = document.querySelector('#newsList');
  assert.equal(box.querySelectorAll('.news-item').length, 2, '两条快讯都要渲染');
  assert.equal(box.querySelectorAll('img').length, 0, '不允许注入 <img>');
  assert.equal(box.querySelectorAll('script').length, 0, '不允许注入 <script>');
  assert.equal(box.querySelectorAll('[onerror]').length, 0, '不允许出现 onerror 属性');
  assert.ok(!box.querySelector('.news-item').innerHTML.includes('<img'), '标签必须被转义成文本');

  const first = box.querySelector('.news-item');
  assert.equal(first.getAttribute('href'), '#', 'javascript: 链接要被替换成 #');
  const second = box.querySelectorAll('.news-item')[1];
  assert.equal(second.getAttribute('href'), 'https://example.com/a');
  assert.match(box.textContent, /正常标题 & 符号/, '文本原样显示（& 转义后仍是 &）');
});

test('DOM：榜单表格里的股票名/代码被转义', () => {
  const items = [
    { secid: '1.600519', code: '600519', name: '<b>贵州茅台</b>', price: 1500, pct: 1.23 },
    { secid: '0.000001', code: '000001', name: '平安银行', price: 11.2, pct: -0.5 },
  ];
  const host = document.createElement('div');
  app.renderRankTable(host, items, 'pct');
  assert.equal(host.querySelectorAll('.mini-row').length, 2);
  assert.equal(host.querySelectorAll('b').length, 0, '不允许注入标签');
  assert.match(host.textContent, /<b>贵州茅台<\/b>/, '原始尖括号应作为文本出现');
  assert.equal(host.querySelector('.mini-row').getAttribute('data-stock-secid'), '1.600519');
});

test('DOM：空数据渲染占位而不是报错', () => {
  app.state.news = { items: [] };
  app.renderNewsList();
  assert.match(document.querySelector('#newsList').textContent, /暂无快讯/);

  const host = document.createElement('div');
  app.renderRankTable(host, [], 'pct');
  assert.match(host.textContent, /暂无数据/);
  assert.doesNotThrow(() => app.renderRankTable(null, [{ name: 'x' }], 'pct'));
});

/* ---------------------------------------------------------
   基金页
   --------------------------------------------------------- */
test('DOM：基金页自选表渲染，基金名被转义', () => {
  const evilName = '<img src=x onerror="window.__xss=9">测试基金';
  app.state.fundWatchlist = [{ code: '510300', name: evilName, type: 'etf' }];
  app.state.fundWatchData = {
    items: [{
      code: '510300', name: evilName, type: 'etf',
      price: 3.912, pct: 1.23, pctKind: 'nav', pctDate: '2026-11-14',
      mainYi: 1.5, score: 66, rating: '偏强',
    }],
  };
  app.state.fundHoldings = {};

  app.renderFundWatchTable();
  const table = document.querySelector('#fundWatchTable');
  assert.ok(table, '缺少 #fundWatchTable');
  assert.equal(table.querySelectorAll('tbody tr').length, 1, '应有 1 行自选基金');
  assert.equal(table.querySelectorAll('img').length, 0, '不允许注入 <img>');
  assert.equal(table.querySelectorAll('[onerror]').length, 0);
  assert.match(table.textContent, /测试基金/);
  const row = table.querySelector('tbody tr');
  assert.equal(row.getAttribute('data-fund-code'), '510300');
  assert.match(document.querySelector('#fundWatchCount').textContent, /1 只/);
});

test('DOM：基金页摘要卡显示数量与平均涨跌', () => {
  app.state.fundWatchlist = [
    { code: '510300', name: '沪深300ETF', type: 'etf' },
    { code: '005825', name: '联接基金', type: 'open' },
  ];
  app.state.fundWatchData = {
    items: [
      { code: '510300', name: '沪深300ETF', type: 'etf', pct: 2, pctKind: 'nav', mainYi: 3 },
      { code: '005825', name: '联接基金', type: 'open', pct: 1, pctKind: 'nav', mainYi: 0 },
    ],
  };
  app.renderFundWatchSummary();
  const box = document.querySelector('#fundWatchSummary');
  assert.match(box.textContent, /自选基金数量/);
  assert.match(box.textContent, /2/, '数量应为 2');
  assert.match(box.textContent, /\+1\.50%/, '平均涨跌应为 +1.50%');
});

/* ---------------------------------------------------------
   策略页
   --------------------------------------------------------- */
test('DOM：策略页组合建议渲染，恶意基金名不注入', () => {
  const evil = '<script>window.__xss=5</script>债基';
  app.state.advice = {
    score: 52,
    asOf: '2026-11-14',
    nextDate: '2026-11-17',
    generatedAt: Date.now(),
    temperature: { tone: 'warm', label: '偏暖' },
    rating: { label: '中性偏弱', tone: 'flat' },
    position: { text: '五成', tone: 'flat' },
    review: { title: '今日复盘', summary: '指数震荡' },
    plan: { title: '明日计划', summary: '控制仓位' },
    oneLine: '结构行情',
    disclaimer: '仅供参考',
  };
  app.state.watchlist = [];
  app.state.watchData = { items: [] };
  app.state.fundWatchlist = [{ code: '110022', name: evil, type: 'open' }];
  app.state.fundWatchData = { items: [{ code: '110022', name: evil, type: 'open', pct: -2.4, pctKind: 'nav', mainYi: -1 }] };
  app.state.fundHoldings = {};

  app.renderPortfolioAdvice();
  const box = document.querySelector('#portfolioAdvicePanel');
  assert.ok(box, '缺少 #portfolioAdvicePanel');
  assert.equal(box.querySelectorAll('script').length, 0, '不允许注入 <script>');
  assert.equal(box.querySelectorAll('[onerror]').length, 0);
  assert.ok(box.textContent.trim().length > 20, '面板应有内容');
  assert.match(box.textContent, /债基/, '基金名应作为文本出现');
});

test('DOM：基金页三个持仓/资金流面板都能渲染（拆模块后回归）', () => {
  const evil = '基金<b>炸弹</b>';
  app.state.fundWatchlist = [{ code: '510300', name: evil, type: 'etf' }];
  app.state.fundWatchData = {
    items: [{
      code: '510300', name: evil, type: 'etf',
      price: 3.9, pct: 1.5, pctKind: 'nav', mainYi: 2.2, score: 61,
    }],
  };
  app.state.fundHoldings = { '510300': { shares: 1000, cost: 3.5 } };
  app.state.fundFlow = {
    items: [
      { code: '510300', name: '沪深300ETF', mainYi: 5.2, pct: 1.1 },
      { code: '512880', name: '证券ETF', mainYi: -3.4, pct: -0.8 },
    ],
    topInflow: { code: '510300', name: '沪深300ETF', mainYi: 5.2, pct: 1.1 },
    topOutflow: { code: '512880', name: '证券ETF', mainYi: -3.4, pct: -0.8 },
  };

  for (const fn of ['renderFundHoldSummary', 'renderFundHoldTable', 'renderFundSummary']) {
    assert.doesNotThrow(() => app[fn](), `${fn} 不应抛错`);
  }
  const holdTable = document.querySelector('#fundHoldTable');
  assert.ok(holdTable.querySelectorAll('tbody tr').length >= 1, '持仓表应有行');
  assert.equal(holdTable.querySelectorAll('b').length, 0, '基金名里的 <b> 必须被转义');
  assert.match(document.querySelector('#fundHoldSummary').textContent, /持有市值/);
  assert.match(document.querySelector('#fundSummary').textContent, /ETF|资金/);
});
