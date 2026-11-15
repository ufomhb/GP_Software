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
