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
// jsdom 没有 canvas：给 echarts 一个最小替身，图表类渲染函数才不会在 getInstanceByDom/init 处报错。
// 这里只验证 DOM 输出，不验证像素。
const chartInstances = new Map();
window.echarts = {
  graphic: { LinearGradient: class { constructor() { this.type = 'linear'; } } },
  init: (el) => {
    const inst = {
      setOption() {}, on() {}, off() {}, resize() {}, dispose() {},
      getWidth: () => 600, getHeight: () => 200,
      getOption: () => ({}), convertFromPixel: () => 0,
    };
    chartInstances.set(el, inst);
    return inst;
  },
  getInstanceByDom: (el) => chartInstances.get(el) || null,
};
globalThis.echarts = window.echarts;
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

/* ---------------------------------------------------------
   自选股操作按钮 / 长按拖拽（v2.1.0 修复）
   --------------------------------------------------------- */
test('DOM：自选股 6 个操作按钮图标与动作一一对应（v2.14.0 加模拟买入）', () => {
  app.state.watchlist = [{ secid: '1.600519', code: '600519', name: '贵州茅台' }];
  app.state.watchData = {
    items: [{ quote: { secid: '1.600519', code: '600519', name: '贵州茅台', price: 1500, pct: 1.1, mainYi: 2 }, advice: null }],
  };
  app.renderWatchTable();
  const btns = [...document.querySelectorAll('#watchTable .watch-actions button')];
  assert.equal(btns.length, 6, '每行应有 6 个操作按钮');
  // 曾经出现「两个 K、两个 ×」的图标错乱，这里锁死图标顺序；
  // v2.14.0 起最前面是「买」（直接模拟买入），其后与「我的自选基金」对齐：K、↑↓、警、×
  assert.deepEqual(btns.map((b) => b.textContent.trim()), ['买', 'K', '↑', '↓', '警', '×']);
  assert.deepEqual(btns.map((b) => b.getAttribute('data-watch-action')), ['buy', 'chart', 'up', 'down', 'alert', 'remove']);
  // 「移出自选」按钮的 title 曾因缺一个引号被吃掉，导致按钮点击无效
  assert.equal(btns[5].getAttribute('title'), '移出自选');
});

test('DOM：长按拖拽能识别行、给出行反馈且松手后不留残影', async () => {
  const box = document.createElement('div');
  box.innerHTML = '<div class="watch-card-row" data-drag-secid="1.600519"><span class="wi-name">贵州茅台</span></div>'
    + '<div class="watch-card-row" data-drag-secid="0.000001"><span class="wi-name">平安银行</span></div>';
  document.body.appendChild(box);
  let reordered = null;
  app.bindTouchReorder(box, '.watch-card-row', 'dragSecid', (from, to) => { reordered = [from, to]; });

  const rows = [...box.querySelectorAll('.watch-card-row')];
  rows.forEach((r) => { r.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 40 }); });
  document.elementFromPoint = () => rows[1];
  const fire = (type, target, x, y) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    const pts = [{ clientX: x, clientY: y }];
    ev.touches = pts;
    ev.changedTouches = pts;
    target.dispatchEvent(ev);
  };

  fire('touchstart', rows[0], 10, 15);
  await new Promise((r) => setTimeout(r, 500)); // 长按阈值 420ms
  assert.ok(document.querySelector('.touch-drag-ghost'), '长按后应出现跟手浮动标签');
  fire('touchmove', rows[0], 12, 60);
  fire('touchend', rows[0], 12, 60);

  assert.deepEqual(reordered, ['1.600519', '0.000001'], '松手应触发一次重排');
  assert.equal(box.querySelectorAll('.dragging, .drag-over').length, 0, '松手后不能留下拖拽态');
  assert.equal(document.querySelector('.touch-drag-ghost'), null, '浮动标签必须清理');
  box.remove();
});

/* ---------------------------------------------------------
   基金：当日涨跌 + 当日估值 并排（v2.1.0）
   --------------------------------------------------------- */
test('DOM：自选基金表同时有「当日涨跌」与「当日估值」两列', () => {
  app.state.fundWatchlist = [
    { code: '510300', name: '沪深300ETF', type: 'etf' },
    { code: '005825', name: '联接基金', type: 'open' },
  ];
  app.state.fundWatchData = {
    items: [
      { code: '510300', name: '沪深300ETF', type: 'etf', price: 3.9, pct: 1.2, pctKind: 'market', navPctToday: 1.2, estimatePct: null },
      {
        code: '005825', name: '联接基金', type: 'open', price: 1.23,
        pct: 0.65, pctKind: 'estimate', estimate: 1.238,
        // 关键：当日涨跌（真实净值 0.80%）与当日估值（15:00 冻结的 0.65%）是**两个不同的数**
        navPctToday: 0.8, estimatePct: 0.65, estimateAt: '2026-11-17 15:00', estimateFrozen: true,
      },
    ],
  };
  app.state.fundHoldings = {};
  app.renderFundWatchTable();

  const head = [...document.querySelectorAll('#fundWatchTable thead th')].map((th) => th.textContent.trim());
  assert.ok(head.includes('当日涨跌'), '表头应有「当日涨跌」');
  assert.ok(head.includes('当日估值'), '表头应有「当日估值」');

  const rowOpen = document.querySelector('#fundWatchTable tbody tr[data-fund-code="005825"]');
  const rowEtf = document.querySelector('#fundWatchTable tbody tr[data-fund-code="510300"]');

  const dayCell = rowOpen.children[3].textContent;
  const estCell = rowOpen.querySelector('[data-col="est"]').textContent;
  assert.match(dayCell, /\+0\.80%/, '当日涨跌应取真实净值（+0.80%）');
  assert.match(dayCell, /今日净值/, '当日涨跌应标注净值口径');
  assert.match(estCell, /\+0\.65%/, '当日估值应取冻结的预估涨跌幅（+0.65%）');
  assert.match(estCell, /15:00 估值/, '冻结后的估值应标 15:00');
  assert.doesNotMatch(estCell, /\+0\.80%/, '两列不能是同一个数（防止估值与净值同源）');

  assert.match(rowEtf.querySelector('[data-col="est"]').textContent, /场内无估值/, 'ETF 无独立估值');
});

test('DOM：净值未公布时「当日涨跌」显示未出，不拿估值冒充', () => {
  const html = app.fundDayPctCell({
    type: 'open', navPctToday: null, navDate: '2026-11-16', pct: 0.65, pctKind: 'estimate',
  });
  assert.match(html, /当日未出/, '净值没出就明确写「当日未出」');
  assert.doesNotMatch(html, /\+0\.65%/, '不能用估值冒充当日涨跌');
});

test('DOM：估值单元格区分「15:00 冻结」与「盘中估值」，并给出与净值的偏差', () => {
  const frozen = app.fundEstimateCell({
    type: 'open', estimatePct: 0.65, estimateAt: '2026-11-17 15:00', estimateFrozen: true,
    navPctToday: 0.8, pctKind: 'nav',
  });
  assert.match(frozen, /15:00 估值/, '冻结估值要标 15:00');
  assert.match(frozen, /偏差/, '与净值同屏时应给出偏差');

  const live = app.fundEstimateCell({
    type: 'open', estimatePct: 0.42, estimateAt: '2026-11-17 10:30', estimateFrozen: false,
  });
  assert.match(live, /盘中估值/, '未到 15:00 应标盘中估值');
  assert.doesNotMatch(live, /偏差/, '净值未出没有偏差可比');
});

/* ---------------------------------------------------------
   全景：休市口径标注（v2.1.0）
   --------------------------------------------------------- */
test('DOM：休市时全景标出「上交易日 + 日期」，开盘时标「实时」', () => {
  const quote = (code, secid, price, pct) => ({
    code, secid, name: code, price, pct, change: price * pct / 100,
    high: price * 1.01, low: price * 0.99, prevClose: price / (1 + pct / 100), amount: 1e11,
  });
  const base = {
    updatedAt: Date.now(),
    dataDate: '2026-11-14',
    cn: [quote('000001', '1.000001', 3400, -0.5)],
    global: [], commodities: [], fx: [],
    breadth: { up: 2000, down: 2800, flat: 200 },
    marketFlow: { last: -120.5, date: '2026-11-14' },
    sessions: { cn: { state: 'closed', label: '已收盘', local: '15:30' } },
  };

  app.state.overview = base;
  app.state.heroSeries = [{ d: '2026-11-13', c: 3400 }, { d: '2026-11-14', c: 3390 }];
  app.renderHero();
  const stamp = document.querySelector('#heroStamp');
  assert.ok(stamp && !stamp.hidden, '#heroStamp 应显示');
  assert.match(stamp.textContent, /上交易日 11-14 收盘/, '休市应标出上一交易日日期');

  app.state.overview = { ...base, sessions: { cn: { state: 'open', label: '交易中', local: '10:30' } } };
  app.renderHero();
  assert.match(document.querySelector('#heroStamp').textContent, /实时/, '开盘应标实时');
});

test('DOM：板块资金与市场温度都标出日期与生成时间', () => {
  app.state.overview = {
    updatedAt: Date.now(), dataDate: '2026-11-14',
    cn: [], global: [], commodities: [], fx: [],
    sessions: { cn: { state: 'closed', label: '已收盘', local: '15:30' } },
  };
  app.state.sectors = {
    industry: {
      type: 'industry', total: 86, inflowCount: 30, netInflow: 12.5, updatedAt: Date.now(),
      items: [{ code: 'BK1', name: '半导体', main: 8.2, pct: 1.4 }, { code: 'BK2', name: '白酒', main: -5.1, pct: -1.1 }],
    },
  };
  app.state.sectorType = 'industry';
  app.renderSectorPanel();
  const sectorStamp = document.querySelector('#sectorStamp');
  assert.match(sectorStamp.textContent, /2026-11-14 数据/, '板块资金应标数据日');
  assert.match(sectorStamp.textContent, /更新 \d{2}:\d{2}:\d{2}/, '板块资金应标更新时间');

  app.state.advice = {
    score: 52, asOf: '2026-11-14', generatedAt: Date.now(),
    temperature: { tone: 'flat', label: '中性' }, oneLine: '结构行情',
    dimensions: [], focus: [], avoid: [],
  };
  app.renderPulse();
  const pulseStamp = document.querySelector('#pulseStamp');
  assert.match(pulseStamp.textContent, /2026-11-14 收盘口径/, '市场温度应标收盘口径日期');
  assert.match(pulseStamp.textContent, /生成 \d{2}:\d{2}:\d{2}/, '市场温度应标生成时间');
});

/* ---------------------------------------------------------
   顶栏：账号菜单 / 偏好设置 分离（v2.1.0）
   --------------------------------------------------------- */
test('DOM：账号抽屉含信息与退出，偏好设置不再重复账号项', () => {
  app.state.auth = {
    id: 'u1', username: 'tester', role: 'admin',
    createdAt: Date.now() - 86400000, lastLoginAt: Date.now(), loginCount: 7,
  };

  app.openAccount();
  const overlay = document.querySelector('#overlayRoot .overlay');
  assert.ok(overlay, '账号抽屉应打开');
  const text = overlay.textContent.replace(/\s+/g, ' ');
  for (const kw of ['账号设置', 'tester', '管理员', '注册时间', '最近登录', '修改密码', '更新履历', '退出登录']) {
    assert.ok(text.includes(kw), `账号抽屉缺内容：${kw}`);
  }
  assert.ok(overlay.querySelector('#acctLogout'), '退出登录按钮应在账号抽屉里');
  assert.equal(overlay.querySelector('#acctAdminRow').hidden, false, '管理员应看到后台管理入口');

  app.openSettings();
  const settings = document.querySelector('#overlayRoot .overlay');
  const st = settings.textContent.replace(/\s+/g, ' ');
  for (const kw of ['偏好设置', '刷新与风险', '自动刷新', '风险偏好', '浏览器通知']) {
    assert.ok(st.includes(kw), `偏好设置缺内容：${kw}`);
  }
  assert.equal(settings.querySelector('#acctLogout'), null, '偏好设置里不该再有退出按钮');
  assert.equal(settings.querySelector('#setAccountName'), null, '偏好设置里不该再有账号信息');
  assert.equal(settings.querySelector('#setAdminRow'), null, '偏好设置里不该再有后台入口');
  for (const id of ['setAuto', 'setInterval', 'setRisk', 'setSound', 'setNotify', 'setExport', 'setReset']) {
    assert.ok(settings.querySelector(`#${id}`), `偏好设置缺控件 #${id}`);
  }
});

/* ---------------------------------------------------------
   A股：涨跌榜 / 资金榜 左右合并（v2.1.0）
   --------------------------------------------------------- */
test('DOM：涨跌榜与资金榜各自合并为一张左右对照卡', () => {
  assert.equal(document.querySelectorAll('.rank-grid .rank-panel').length, 2, '应合并成 2 张卡');
  for (const id of ['rankGain', 'rankLoss', 'rankInflow', 'rankOutflow']) {
    assert.ok(document.querySelector(`#${id}`), `缺少榜单挂载点 #${id}`);
  }
  const mk = (code, pct) => ({ secid: `1.${code}`, code, name: `股票${code}`, price: 10, pct, mainYi: pct * 2 });
  app.state.ranks = {
    gain: [mk('600001', 5)], loss: [mk('600002', -4)],
    inflow: [mk('600003', 1)], outflow: [mk('600004', -1)],
  };
  app.renderRanks();
  assert.equal(document.querySelectorAll('.rank-split .mini-row').length, 4, '四个榜单各渲染一行');
});


/* ---------------------------------------------------------
   v2.4.0：K 线指标 / 复权控件、详情路由、条件预警
   --------------------------------------------------------- */
test('DOM：K 线指标与复权控件存在，syncKlineSegs 跟随已保存设置', () => {
  for (const id of ['cnIndSeg', 'cnFqtSeg']) {
    assert.ok(document.querySelector(`#${id}`), `缺少控件 #${id}`);
  }
  assert.ok(document.querySelectorAll('[data-ind]').length >= 4, '指标按钮应至少有 4 个');
  assert.ok(document.querySelectorAll('[data-fqt]').length >= 3, '复权按钮应至少有 3 个');

  const ind0 = document.querySelector('#cnIndSeg [data-ind="kdj"]');
  const fqt0 = document.querySelector('#cnFqtSeg [data-fqt="2"]');
  assert.equal(ind0.classList.contains('is-active'), false, '默认指标不是 KDJ');
  assert.equal(fqt0.classList.contains('is-active'), false, '默认复权不是后复权');

  app.state.settings.indicator = 'kdj';
  app.state.settings.fqt = 2;
  app.syncKlineSegs();
  assert.equal(document.querySelector('#cnIndSeg [data-ind="kdj"]').classList.contains('is-active'), true, 'KDJ 应被点亮');
  assert.equal(document.querySelector('#cnFqtSeg [data-fqt="2"]').classList.contains('is-active'), true, '后复权应被点亮');
  assert.equal(document.querySelector('#cnIndSeg [data-ind="macd"]').classList.contains('is-active'), false, 'MACD 应熄灭');

  // 复位，避免影响后续用例
  app.state.settings.indicator = 'macd';
  app.state.settings.fqt = 0;
  app.syncKlineSegs();
});

test('DOM：指标 / 复权取值对非法输入做回落，不会让图表用错口径', () => {
  app.state.settings.indicator = 'rsi';
  app.state.settings.fqt = 'abc';
  assert.equal(app.currentIndicator(), 'macd', '未知指标应回落 macd');
  assert.equal(app.currentFqt(), 0, '非法复权应回落不复权');

  app.state.settings.indicator = 'none';
  app.state.settings.fqt = '2';
  assert.equal(app.currentIndicator(), 'none', 'none 是合法值（关闭副图）');
  assert.equal(app.currentFqt(), 2, '字符串数字也要认');

  app.state.settings.indicator = 'macd';
  app.state.settings.fqt = 0;
});

test('DOM：详情路由能拼出可分享地址，旧视图路由仍然兼容', () => {
  assert.equal(app.detailHash('stock', '1.600519'), '#/stock/1.600519');
  assert.equal(app.detailHash('sector', 'BK0475'), '#/sector/BK0475');
  assert.equal(app.detailHash('fund', '510300'), '#/fund/510300');
  // 特殊字符必须被编码，不能破坏 hash 结构
  assert.match(app.detailHash('sector', 'BK 1/2'), /%20|%2F/);

  window.location.hash = '#/stock/1.600519';
  const detail = app.parseHashRoute();
  assert.deepEqual(detail.detail, { kind: 'stock', key: '1.600519' });
  assert.equal(detail.view, undefined, '详情路由不应同时带视图');

  window.location.hash = '#china';
  assert.deepEqual(app.parseHashRoute(), { view: 'china' });

  window.location.hash = '#nonsense';
  assert.deepEqual(app.parseHashRoute(), { view: 'dashboard' }, '未知视图回落全景');

  window.location.hash = '#/unknown/x';
  assert.deepEqual(app.parseHashRoute(), { view: 'dashboard' }, '未知详情类型回落全景');
  window.location.hash = '';
});

test('DOM：价格 / 涨跌幅预警按快照判定，方向和阈值都对', () => {
  const q = { price: 12, pct: 3.5 };
  const above = { kind: 'price', op: 'above', value: 11 };
  const below = { kind: 'price', op: 'below', value: 13 };

  assert.equal(app.evalAlertRule(above, q, null).hit, true, '12 >= 11 应命中');
  assert.equal(app.evalAlertRule(above, { price: 10 }, null).hit, false, '10 < 11 不命中');
  assert.equal(app.evalAlertRule(below, q, null).hit, true, '12 <= 13 应命中');
  assert.equal(app.evalAlertRule({ kind: 'price', op: 'below', value: 11 }, q, null).hit, false);

  assert.equal(app.evalAlertRule({ kind: 'pct', op: 'above', value: 3 }, q, null).hit, true);
  assert.equal(app.evalAlertRule({ kind: 'pct', op: 'above', value: 4 }, q, null).hit, false);
  assert.equal(app.evalAlertRule({ kind: 'pct', op: 'below', value: -2 }, { pct: -3 }, null).hit, true);

  // 没有报价时任何比较都不该触发，避免误报
  assert.equal(app.evalAlertRule(above, null, null).hit, false);
});

test('DOM：量比预警用当日成交量对比前 5 日均量', () => {
  const kline = {
    candles: [
      { v: 100 }, { v: 100 }, { v: 100 }, { v: 100 }, { v: 100 }, { v: 500 },
    ],
    series: {},
    };
  const hitBig = app.evalAlertRule({ kind: 'volume', op: 'above', value: 2 }, { price: 10 }, kline);
  assert.equal(hitBig.hit, true, '量比 5 倍应命中「放量 2 倍」');
  assert.match(hitBig.note, /5\.00/, '触发说明应带出量比数值');

  const hitSmall = app.evalAlertRule({ kind: 'volume', op: 'below', value: 2 }, { price: 10 }, kline);
  assert.equal(hitSmall.hit, false, '量比 5 不会命中「缩量 2 倍」');

  // 样本不足 6 根时不动
  assert.equal(app.evalAlertRule({ kind: 'volume', op: 'above', value: 1 }, { price: 10 }, { candles: [{ v: 10 }] }).hit, false);
});

test('DOM：均线与 MACD 交叉只在「穿越那一根」触发', () => {
  const maGolden = {
    candles: [{ c: 9 }, { c: 11 }],
    series: { ma20: [10, 10] },
  };
  assert.equal(app.evalAlertRule({ kind: 'ma', op: 'golden' }, { price: 11 }, maGolden).hit, true, '9<10 且 11>10 应判金叉');
  assert.equal(app.evalAlertRule({ kind: 'ma', op: 'dead' }, { price: 11 }, maGolden).hit, false, '同一根不是死叉');

  const maDead = {
    candles: [{ c: 11 }, { c: 9 }],
    series: { ma20: [10, 10] },
  };
  assert.equal(app.evalAlertRule({ kind: 'ma', op: 'dead' }, { price: 9 }, maDead).hit, true, '11>10 且 9<10 应判死叉');

  const macdGolden = { candles: [], series: { dif: [-0.2, 0.1], dea: [0, 0] } };
  assert.equal(app.evalAlertRule({ kind: 'macd', op: 'golden' }, null, macdGolden).hit, true);
  assert.equal(app.evalAlertRule({ kind: 'macd', op: 'dead' }, null, macdGolden).hit, false);

  const macdDead = { candles: [], series: { dif: [0.2, -0.1], dea: [0, 0] } };
  assert.equal(app.evalAlertRule({ kind: 'macd', op: 'dead' }, null, macdDead).hit, true);

  // 已经在上方持续多根（不是刚穿越）不该算金叉
  const already = { candles: [{ c: 11 }, { c: 12 }], series: { ma20: [10, 10] } };
  assert.equal(app.evalAlertRule({ kind: 'ma', op: 'golden' }, { price: 12 }, already).hit, false, '持续在上方不算新金叉');
});

test('DOM：预警条件文案按类型给出单位，趋势类不显示数值', () => {
  assert.match(app.alertConditionText({ kind: 'price', op: 'above', value: 12 }), /价格 .*12\.00/);
  assert.match(app.alertConditionText({ kind: 'pct', op: 'below', value: -3 }), /-3\.00%/);
  assert.match(app.alertConditionText({ kind: 'volume', op: 'above', value: 2 }), /2\.00 倍/);
  assert.match(app.alertConditionText({ kind: 'ma', op: 'golden' }), /金叉/);
  assert.doesNotMatch(app.alertConditionText({ kind: 'ma', op: 'golden' }), /\.00/, '趋势类不带数值');
});

test('DOM：v1 价格预警自动迁移成 v2 结构，坏数据被丢弃', () => {
  const legacy = [{ id: 'a1', secid: '1.600519', code: '600519', name: '贵州茅台', type: 'below', price: 1500, active: false, createdAt: 1 }];
  const out = app.normalizeAlerts(legacy);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'price', 'type 应映射成 kind=price');
  assert.equal(out[0].op, 'below', '跌破要保留');
  assert.equal(out[0].value, 1500, 'price 应映射成 value');
  assert.equal(out[0].active, false, '已触发状态要保留');

  // 新结构原样保留；价格非法 / 缺 secid 的都丢掉
  const mixed = [
    { secid: '1.600519', kind: 'macd', op: 'golden' },
    { secid: '0.000001', kind: 'price', op: 'above', value: 'abc' },
    { kind: 'price', op: 'above', value: 5 },
  ];
  const out2 = app.normalizeAlerts(mixed);
  assert.equal(out2.length, 1, '只应保留合法的一条');
  assert.equal(out2[0].kind, 'macd');
  assert.equal(out2[0].value, null, '趋势类没有数值');
});

test('DOM：预警面板显示类型标签与「已触发」，恶意名称不注入', () => {
  app.state.alerts = app.normalizeAlerts([
    { id: 'x1', secid: '1.600519', code: '600519', name: '<b>茅台</b>', kind: 'pct', op: 'above', value: 5, active: true },
    {
      id: 'x2', secid: '0.000001', code: '000001', name: '平安银行',
      kind: 'price', op: 'below', value: 11, active: false, triggeredAt: Date.now(), triggerNote: '最新价 10.80',
    },
  ]);
  app.renderAlerts();
  const box = document.querySelector('#alertsPanel');
  assert.ok(box, '缺少 #alertsPanel');
  assert.equal(box.querySelectorAll('b').length, 0, '股票名里的 <b> 必须被转义');
  assert.equal(box.querySelectorAll('[onerror]').length, 0);
  assert.match(box.textContent, /涨跌幅/, '应显示预警类型标签');
  assert.match(box.textContent, /已触发/, '触发过的要标已触发');
  assert.match(box.textContent, /监控中/, '还在盯的要标监控中');
  assert.match(box.textContent, /1 条监控中/, '计数应只算 active');
});
test('DOM：v2.10.0 沪深300基金占比已移回 A 股页，基金页不再保留该模块', () => {
  assert.ok(document.querySelector('#view-china #csi300RatioPanel'), 'A 股页应有「头部沪深300基金 / 流通市值」');
  assert.equal(document.querySelector('#fundSectorView #csi300RatioPanel'), null, '基金页不应再保留该面板');
});

test('DOM：v2.10.0 基金页新增 板块总览 / 基金涨跌分布 / 场外基金 三个子页', () => {
  for (const [view, pane] of [
    ['theme', '#fundThemeView'],
    ['dist', '#fundDistView'],
    ['openfund', '#fundOpenFundView'],
  ]) {
    assert.ok(document.querySelector(`#fundSubnav [data-fund-view="${view}"]`), `缺少 ${view} 子页按钮`);
    assert.ok(document.querySelector(pane), `缺少 ${pane} 面板`);
  }
  assert.ok(document.querySelector('#fundThemeTable'), '板块总览要有表格');
  assert.ok(document.querySelector('#fundDistChart'), '涨跌分布要有图表容器');
  assert.ok(document.querySelector('#fundBoardTable'), '场外基金要有榜单表格');
  assert.ok(document.querySelector('#fundCompareOpen'), '基金页要有「基金比较」入口');
});

test('DOM：板块资金与基金页互相跳转的入口都在', () => {
  const toFunds = document.querySelector('#view-sectors [data-fund-pane="sector"][data-goto="funds"]');
  assert.ok(toFunds, '板块资金页应有「基金视角」跳转');
  const toSectors = document.querySelector('#fundSectorView [data-goto="sectors"]');
  assert.ok(toSectors, '基金板块资金子页应有回到全市场板块资金的入口');
});

/* ---------------------------------------------------------
   v2.4.1：A 股个股弹窗加宽、美股个股实时分时
   --------------------------------------------------------- */
function mountEmptyOverlay() {
  const root = document.querySelector('#overlayRoot');
  root.innerHTML = '<div class="overlay"><div class="modal"><div class="empty">loading</div></div></div>';
  return document.querySelector('#overlayRoot .overlay');
}

test('DOM：A 股个股弹窗用加宽版面，盘口 10 项全部渲染', () => {
  mountEmptyOverlay();
  app.renderStockModal({
    quote: {
      secid: '1.600519', code: '600519', name: '贵州茅台', price: 1500.5, pct: 1.2, change: 18,
      open: 1490, prevClose: 1482.5, high: 1510, low: 1488, amount: 8.6e9,
      turnover: 0.52, pe: 31.2, mktCapYi: 18900, mainYi: 2.4, mainPct: 3.1, industry: '酿酒行业',
    },
    advice: {
      score: 62, rating: { label: '偏强', tone: 'up' }, position: { text: '五成' },
      summary: '均线多头排列', levels: { s1: 1470, s2: 1450, r1: 1520, r2: 1550 },
      reasons: ['站上 MA20', 'MACD 红柱'], risks: ['量能不足'], disclaimer: '规则模型，非投资建议',
    },
    kline: {
      candles: [
        { d: '2026-11-17', o: 1480, c: 1482, h: 1490, l: 1475, v: 1000, pct: 0.5 },
        { d: '2026-11-18', o: 1490, c: 1500, h: 1510, l: 1488, v: 1200, pct: 1.2 },
      ],
      series: {},
    },
  });
  const modal = document.querySelector('#overlayRoot .modal');
  assert.ok(modal.classList.contains('modal-stock'), '个股弹窗应使用加宽版面 modal-stock');
  // 盘口 10 项：今开/昨收/最高/最低/成交额/换手率/市盈率/总市值/主力净流入/净流入占比
  const kv = [...modal.querySelectorAll('.modal-kv .kv')];
  assert.equal(kv.length, 10, `盘口应有 10 项，实际 ${kv.length}`);
  for (const label of ['今开', '昨收', '最高', '最低', '成交额', '换手率', '市盈率', '总市值', '主力净流入', '净流入占比']) {
    assert.ok(kv.some((x) => x.textContent.includes(label)), `盘口缺字段：${label}`);
  }
  assert.ok(modal.querySelector('#stockKline'), '应有 K 线容器');
  assert.ok(modal.querySelectorAll('[data-ind]').length >= 4, '应带副图指标切换');
  assert.ok(modal.querySelectorAll('[data-fqt]').length >= 3, '应带复权切换');
  assert.equal(modal.querySelectorAll('[onerror]').length, 0, '不允许注入属性');
});

test('DOM：美股个股分时把盘前/盘中/盘后拼成整日曲线，且不重复同一分钟', () => {
  const item = {
    symbol: 'AAPL', prevClose: 179, last: 182, pct: 1.6,
    days: [{
      day: '2026-11-18',
      pre: [['04:05', 180.1], ['04:06', 180.4]],
      regular: [['09:30', 181.0], ['09:31', 182.0]],
      post: [['16:05', 183.0]],
    }],
  };
  const all = app.usPointsFor(item, 'all');
  assert.equal(all.day, '2026-11-18');
  assert.deepEqual(all.points.map((p) => p[0]), ['04:05', '04:06', '09:30', '09:31', '16:05'], '顺序应为盘前→盘中→盘后');
  assert.equal(all.points.length, 5);
  assert.equal(app.usPointsFor(item, 'regular').points.length, 2, '只取盘中时 2 个点');
  assert.equal(app.usPointsFor(item, 'pre').points.length, 2);
  assert.equal(app.usPointsFor({ days: [] }, 'all').points.length, 0, '没有数据时返回空');

  // 同一分钟在两个时段重复出现时保留后者，曲线不能回折
  const dup = { days: [{ day: '2026-11-18', pre: [['09:30', 180]], regular: [['09:30', 181]] }] };
  assert.deepEqual(app.usPointsFor(dup, 'all').points, [['09:30', 181]]);
});

test('DOM：美股个股详情渲染三段快照、整日分时图与时段切换', () => {
  mountEmptyOverlay();
  app.state.usData = {
    usBoard: {
      phase: 'regular', local: '10:32', label: '交易中',
      windows: { pre: '04:00–09:30', regular: '09:30–16:00', post: '16:00–20:00' },
    },
    topHot: [{
      symbol: 'AAPL', name: '苹果', market: 'NASDAQ', sectorName: '科技', industry: '消费电子',
      dollarVolumeYi: 128.5,
      sessions: {
        pre: { price: 180, pct: 0.5 }, regular: { price: 182, pct: 1.6 }, post: { price: 183, pct: 1.9 },
      },
    }],
    hot: [],
  };
  app.state.usSeg = 'all';
  const meta = app.usHotItemOf('AAPL');
  assert.ok(meta, '应从热度池里找到该股快照');
  assert.equal(meta.name, '苹果');

  app.renderUsStockModal('AAPL', meta, {
    symbol: 'AAPL', prevClose: 179, last: 182, pct: 1.6,
    days: [{ day: '2026-11-18', pre: [['04:05', 180.1]], regular: [['09:30', 181], ['09:31', 182]], post: [['16:05', 183]] }],
  }, {});

  const modal = document.querySelector('#overlayRoot .modal');
  assert.ok(modal.classList.contains('modal-stock'), '美股详情也用加宽版面');
  assert.ok(modal.querySelector('#usStockChart'), '应有分时图容器');
  assert.equal(modal.querySelectorAll('.us-sess-row').length, 3, '盘前/盘中/盘后三段都要列出');
  const live = modal.querySelector('.us-sess-row.is-live');
  assert.ok(live && live.textContent.includes('盘中'), '当前时段应高亮「盘中」');
  assert.match(modal.textContent, /苹果/, '应显示股票名');
  assert.match(modal.textContent, /昨收 179\.00/, '应显示昨收基准');
  assert.equal(modal.querySelectorAll('[data-us-seg]').length, 4, '应有整日/盘前/盘中/盘后四个切换');
  assert.ok(modal.querySelector('[data-us-seg="regular"]'), '应有盘中分段按钮');

  // 切换分段按钮后应记住选择
  modal.querySelector('[data-us-seg="post"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(app.state.usSeg, 'post', '点击盘后应把状态切到 post');

  app.state.usSeg = 'all';
  app.state.usData = null;
});

test('DOM：美股热度表每行都能点开详情（带 data-us-stock）', () => {
  app.state.usData = {
    usBoard: { phase: 'regular', local: '10:32', label: '交易中', windows: {} },
    indices: [], distribution: null,
    hot: [
      { rank: 1, symbol: 'NVDA', name: '英伟达', market: 'NASDAQ', sectorName: '科技', industry: '半导体', dollarVolumeYi: 300, sessions: {} },
      { rank: 2, symbol: 'MSFT', name: '微软', market: 'NASDAQ', sectorName: '科技', industry: '软件', dollarVolumeYi: 200, sessions: {} },
    ],
  };
  app.renderUS();
  const rows = [...document.querySelectorAll('#usHotColumns tbody tr[data-us-stock]')];
  assert.equal(rows.length, 2, '热度表两行都该带可点击标记');
  assert.equal(rows[0].getAttribute('data-us-stock'), 'NVDA');
  app.state.usData = null;
});

/* ---------------------------------------------------------
   v2.5.0：数据中心（龙虎榜 / 财经日历 / 可转债 / 条件选股）
   --------------------------------------------------------- */
test('DOM：数据中心四个子页都存在，切换时只有当前页可见', () => {
  assert.ok(document.querySelector('#view-data'), '缺少数据中心视图');
  const tabs = [...document.querySelectorAll('#dataTabSeg [data-data-tab]')].map((b) => b.dataset.dataTab);
  assert.deepEqual(tabs, ['longhu', 'calendar', 'cb', 'screener'], '四个子页顺序固定');
  assert.equal(document.querySelectorAll('[data-data-pane]').length, 4, '应有四个子页面板');

  app.switchDataTab('cb');
  const vis = [...document.querySelectorAll('[data-data-pane]')].filter((p) => !p.hidden).map((p) => p.dataset.dataPane);
  assert.deepEqual(vis, ['cb'], '切到可转债后只显示该页');
  assert.equal(document.querySelector('#dataTabSeg [data-data-tab="cb"]').classList.contains('is-active'), true);
  app.switchDataTab('longhu');
});

test('DOM：龙虎榜表格渲染字段并跳过缺失值，股票名被转义', () => {
  app.state.longhu = {
    date: '2026-11-18', count: 2, netTotalYi: 3.21,
    items: [
      { date: '2026-11-18', code: '002463', secucode: '002463.SZ', name: '<b>沪电股份</b>', close: 80.19, pct: 10, turnover: 5.42, buyYi: 16.18, sellYi: 13.79, netYi: 2.39, dealYi: 30, dealRatio: 41.07, reason: '日涨幅偏离值达7%', seatNote: '机构买入' },
      { date: '2026-11-18', code: '301396', secucode: '301396.SZ', name: '宏景科技', close: 114.6, pct: 20, turnover: null, buyYi: 4.2, sellYi: 4.1, netYi: null, dealRatio: null, reason: '', seatNote: '' },
    ],
  };
  app.renderLonghu();
  const table = document.querySelector('#longhuTable');
  assert.equal(table.querySelectorAll('tbody tr').length, 2, '两条记录都要渲染');
  assert.equal(table.querySelectorAll('b').length, 0, '股票名里的 <b> 必须被转义');
  assert.match(table.textContent, /沪电股份/);
  assert.match(table.textContent, /日涨幅偏离值达7%/);
  assert.match(table.textContent, /41\.1%/, '成交占比要显示');
  const first = table.querySelector('tbody tr');
  assert.equal(first.getAttribute('data-stock-secid'), '0.002463', '应能点开个股详情');
  assert.match(document.querySelector('#longhuMeta').textContent, /2026-11-18/);
  assert.match(document.querySelector('#longhuMeta').textContent, /3\.21/, '应显示上榜净额合计');
});

test('DOM：财经日历「解禁」与「分红」两种表头不串', () => {
  app.state.calendar = {
    type: 'lift', count: 1, since: '2026-11-18',
    items: [{ code: '002340', name: '格林美', date: '2026-11-18', marketYi: 278.29, sharesWan: 507834.76, ableSharesWan: 236.57, freeRatio: 0.0004, type: '股权激励限售股份' }],
  };
  app.renderCalendar();
  let table = document.querySelector('#calendarTable');
  assert.match(table.textContent, /解禁日/, '解禁表头');
  assert.match(table.textContent, /278\.29 亿/);
  assert.match(document.querySelector('#calendarTitle').textContent, /限售解禁/);

  app.state.calendar = {
    type: 'bonus', count: 1,
    items: [{ code: '000001', name: '平安银行', plan: '10送4.00派3.00元', cashPer10: 3, bonusPer10: 4, progress: '实施分配', noticeDate: '2026-11-01', recordDate: '2026-11-10', exDate: '2026-11-11' }],
  };
  app.renderCalendar();
  table = document.querySelector('#calendarTable');
  assert.match(table.textContent, /每10股派息/, '分红表头');
  assert.match(table.textContent, /10送4\.00派3\.00元/);
});

test('DOM：可转债表把缺失行情显示成 -- 而不是 0 或发行价', () => {
  app.state.cb = {
    count: 2, quoteCount: 1,
    items: [
      { code: '118078', name: '航亚转债', price: 133.9, pct: -6.32, stockCode: '688510', rating: 'AAsti', issueYi: 6, listingDate: '2026-11-16', expireDate: '2032-10-21' },
      { code: '123001', name: '暂无行情转债', price: null, pct: null, stockCode: '000001', rating: '', issueYi: 3, listingDate: '', expireDate: '' },
    ],
  };
  app.renderConvertibles();
  const table = document.querySelector('#cbTable');
  assert.equal(table.querySelectorAll('tbody tr').length, 2);
  const rows = [...table.querySelectorAll('tbody tr')];
  assert.match(rows[0].textContent, /133\.900/, '有行情时显示三位小数');
  assert.match(rows[0].textContent, /-6\.32%/, '涨跌要带符号');
  assert.match(rows[1].textContent, /--/, '没有行情时必须是 --');
  assert.doesNotMatch(rows[1].textContent, /0\.000/, '不能拿 0 冒充价格');
  assert.match(document.querySelector('#cbMeta').textContent, /有行情 1 只/);
});

test('DOM：选股结果表渲染指标，命中数为 0 时给出提示', () => {
  app.state.screener = {
    matched: 1, poolSize: 5000, scannedPages: 70,
    items: [{ code: '300308', secid: '0.300308', name: '中际旭创', price: 396.3, pct: 0.84, turnover: 3.75, amountYi: 164.39, pe: 40.44, pb: 4.95, mktCapYi: 46000, floatCapYi: 39000 }],
    note: '样本为新浪全市场快照',
  };
  app.renderScreener();
  let table = document.querySelector('#screenerTable');
  assert.match(table.textContent, /中际旭创/);
  assert.match(table.textContent, /40\.4/, 'PE 应显示');
  assert.match(document.querySelector('#screenerMeta').textContent, /样本 5000 只/);
  assert.match(document.querySelector('#screenerBadge').textContent, /1 只命中/);
  assert.equal(table.querySelector('tbody tr').getAttribute('data-stock-secid'), '0.300308');

  app.state.screener = { matched: 0, poolSize: 5000, scannedPages: 70, items: [] };
  app.renderScreener();
  table = document.querySelector('#screenerTable');
  assert.match(table.textContent, /没有符合条件的股票/, '空结果要有明确提示');
});

/* ---------------------------------------------------------
   v2.6.0：云端预警开关 + 模拟交易面板
   --------------------------------------------------------- */
test('DOM：预警面板带「云端预警」开关与同步按钮，并显示同步状态', () => {
  app.state.alerts = app.normalizeAlerts([
    { id: 'c1', secid: '1.600519', code: '600519', name: '贵州茅台', kind: 'price', op: 'above', value: 1600, active: true },
  ]);
  app.state.cloudAlerts = { enabled: true, items: [{ id: 'c1', active: true }], lastPush: { ok: true, at: Date.now() } };
  app.renderAlerts();
  const box = document.querySelector('#alertsPanel');
  assert.ok(box.querySelector('#cloudAlertToggle'), '应有云端预警开关');
  assert.equal(box.querySelector('#cloudAlertToggle').checked, true, '云端已开启时应勾选');
  assert.ok(box.querySelector('#cloudAlertSync'), '应有同步按钮');
  assert.match(box.textContent, /已同步 1 条/, '应显示同步条数');
  assert.match(box.textContent, /上次已推送/, '应显示上次推送结果');

  // 关闭状态：提示关掉页面就不再监控
  app.state.cloudAlerts = { enabled: false, items: [] };
  app.renderAlerts();
  assert.match(document.querySelector('#alertsPanel').textContent, /未开启/);
  assert.equal(document.querySelector('#cloudAlertToggle').checked, false);
  app.state.cloudAlerts = null;
});

test('DOM：模拟交易面板渲染账户/持仓/成交，没有数据时给引导', () => {
  app.state.paper = {
    initial: 1000000, cash: 800000, marketValue: 210000, total: 1010000,
    profit: 10000, profitPct: 1, positions: [], trades: [], updatedAt: Date.now(),
  };
  app.renderPaper();
  let box = document.querySelector('#paperPanel');
  assert.match(box.textContent, /模拟交易/, '标题');
  assert.match(box.textContent, /总资产/);
  assert.match(box.textContent, /1,000,000/, '总资产按千分位显示');
  assert.match(box.textContent, /还没有模拟持仓/, '空仓引导');
  assert.match(box.textContent, /还没有成交记录/, '无成交引导');
  assert.ok(box.querySelector('#paperBuyBtn'), '应有模拟买入按钮');

  app.state.paper = {
    initial: 1000000, cash: 700000, marketValue: 320000, total: 1020000,
    profit: 20000, profitPct: 2,
    positions: [
      { secid: '1.600519', code: '600519', name: '<b>贵州茅台</b>', shares: 100, cost: 1500, price: 1600, pct: 1.2, marketValue: 160000, profit: 10000, profitPct: 6.25 },
    ],
    trades: [
      { id: 't1', ts: Date.now(), secid: '1.600519', code: '600519', name: '贵州茅台', side: 'buy', price: 1500, shares: 100, amount: 150000, fee: 37.5, note: '', signal: { score: 62, rating: '偏强' } },
    ],
    updatedAt: Date.now(),
  };
  app.renderPaper();
  box = document.querySelector('#paperPanel');
  assert.equal(box.querySelectorAll('.paper-pos-table tbody tr').length, 1, '一条持仓');
  assert.equal(box.querySelectorAll('.paper-trade-table tbody tr').length, 1, '一条成交');
  assert.equal(box.querySelectorAll('.paper-pos-table b').length, 0, '股票名里的 <b> 必须被转义');
  assert.match(box.textContent, /评分 62/, '成交记录应带当日评分（信号留痕）');
  assert.ok(box.querySelector('[data-paper-sell]'), '持仓行应有卖出入口');

  app.state.paper = null;
});

/* ---------------------------------------------------------
   v2.7.0：叠层弹窗 / 自选表格式 / 新股·转债申购日历 / 席位明细
   --------------------------------------------------------- */
test('DOM：叠层只关最上面一层，个股详情必须保住', () => {
  app.state.stockModal = { secid: '1.600519', code: '600519', name: '贵州茅台' };
  const base = app.mountOverlay('<div class="modal" id="baseModal">个股详情</div>');
  // 模拟「基本面 / 龙虎榜」抽屉压在个股详情之上
  const layer = app.pushOverlay('<div class="drawer" id="layerDrawer">F10</div>', 'drawer-overlay');
  assert.ok(base.isConnected, '基座仍应在文档里');
  assert.ok(layer.isConnected, '叠层应已挂上');
  assert.equal(app.topLayer(), layer, 'topLayer 应返回最上层');
  assert.equal(document.querySelectorAll('#overlayRoot .overlay').length, 2, '应有两层');

  app.closeOverlay(); // 关抽屉
  assert.equal(document.getElementById('layerDrawer'), null, '叠层应被移除');
  assert.ok(document.getElementById('baseModal'), '关闭叠层后个股详情必须还在');
  assert.equal(app.topLayer(), null, '叠层已清空');
  assert.ok(app.state.stockModal, '个股详情状态不能被清掉');

  app.closeOverlay(); // 再关基座
  assert.equal(document.getElementById('baseModal'), null, '基座也关闭');
  assert.equal(app.state.stockModal, null);
  assert.equal(document.body.style.overflow, '', '全部关闭后恢复滚动');
});

test('DOM：我的自选是表格式列表，与自选基金同一套结构', () => {
  app.state.watchlist = [{ secid: '1.600519', code: '600519', name: '贵州茅台' }];
  app.state.watchData = {
    items: [{
      quote: { secid: '1.600519', code: '600519', name: '贵州茅台', price: 1500, pct: 1.1, mainYi: 2, industry: '白酒<img src=x onerror=1>' },
      advice: { score: 62, rating: { tone: 'up', label: '偏强' }, position: { text: '三成仓' } },
    }],
  };
  app.renderWatchTable();
  const table = document.querySelector('#watchTable table.fund-watch-table.watch-stock-table');
  assert.ok(table, '应渲染成 table.fund-watch-table（复用自选基金样式）');
  assert.equal(table.querySelectorAll('tbody tr').length, 1, '一行一只股票');
  const row = table.querySelector('tbody tr');
  assert.equal(row.dataset.dragSecid, '1.600519', '行上要带拖拽用的 secid');
  assert.equal(row.dataset.stockSecid, '1.600519', '点行能打开详情');
  assert.ok(row.querySelector('.fund-drag-grip'), '应有拖拽手柄');
  assert.ok(row.querySelector('.t-name'), '股票名用 t-name（与基金表一致）');
  assert.match(row.textContent, /白酒/, '行业列');
  assert.match(row.textContent, /偏强/, '评级徽标');
  assert.equal(table.querySelectorAll('img').length, 0, '行业等上游文本必须被转义，不能注入标签');
  // 6 个操作按钮顺序：买在前、K 随后、× 在最后；历史上出过重复图标
  const btns = [...row.querySelectorAll('.fund-watch-actions button')];
  assert.deepEqual(btns.map((b) => b.dataset.watchAction), ['buy', 'chart', 'up', 'down', 'alert', 'remove']);
});

test('DOM：新股申购日历（ipo）与转债申购日历（cbapply）能渲染', () => {
  app.state.calendar = {
    type: 'ipo', count: 1, since: '2026-11-19',
    items: [{
      code: '301661', name: '猎奇智能', applyCode: '301661', applyDate: '2026-11-26',
      ballotDate: '2026-11-30', listingDate: '', market: '深交所创业板',
      issuePrice: null, onlineApplyUpper: 2500, pe: null, industryPe: 37.03,
    }],
  };
  app.renderCalendar();
  let table = document.querySelector('#calendarTable');
  assert.ok(table.classList.contains('calendar-ipo'), '用 calendar-ipo 类做列精简');
  assert.match(table.textContent, /猎奇智能/);
  assert.match(table.textContent, /2026-11-26/, '申购日');
  assert.match(table.textContent, /待定/, '未定价要显示「待定」');
  assert.match(table.textContent, /2,500 股/, '申购上限');

  app.state.calendar = {
    type: 'cbapply', count: 1, since: '2026-11-19',
    items: [{
      code: '113712', name: '圣晖转债', applyCode: '754163', stockCode: '603163',
      applyDate: '2026-11-23', listingDate: '', rating: 'AA-', issueYi: 5.5, transferPrice: 66.46,
    }],
  };
  app.renderCalendar();
  table = document.querySelector('#calendarTable');
  assert.ok(table.classList.contains('calendar-cbapply'));
  assert.match(table.textContent, /754163/, '申购代码');
  assert.match(table.textContent, /AA-/, '评级');
  assert.match(table.textContent, /5.50 亿/, '发行规模');

  // 空列表要有针对性文案，而不是笼统的「暂无数据」
  app.state.calendar = { type: 'ipo', count: 0, items: [], since: '2026-11-19' };
  app.renderCalendar();
  assert.match(document.querySelector('#calendarTable').textContent, /近期暂无新股申购/);
  app.state.calendar = null;
});

test('DOM：龙虎榜席位明细区块按日期分组并标出机构与股通', () => {
  const html = app.renderSeatsBlock({
    items: [{
      date: '2026-11-18',
      reason: '日涨幅达到15%的前五只证券',
      orgNetYi: 1.25,
      seats: [
        { dept: '机构专用', buyYi: 2, sellYi: 0.75, netYi: 1.25, isOrg: true, isNorth: false },
        { dept: '沪股通专用', buyYi: 0.5, sellYi: null, netYi: 0.5, isOrg: false, isNorth: true },
      ],
    }],
    note: '席位为交易所公开披露',
  });
  const box = document.createElement('div');
  box.innerHTML = html;
  assert.match(box.textContent, /2026-11-18/, '上榜日');
  assert.match(box.textContent, /机构净额 \+1.25 亿/, '机构净额汇总');
  assert.match(box.textContent, /日涨幅达到15%/, '上榜原因');
  assert.equal(box.querySelectorAll('.seat-table tbody tr').length, 2, '两个席位');
  assert.match(box.textContent, /机构/, '机构标签');
  assert.match(box.textContent, /股通/, '沪深股通标签');
  // 拿不到数据时给降级文案而不是抛错
  assert.match(app.renderSeatsBlock(null), /席位明细加载失败/);
  assert.match(app.renderSeatsBlock({ items: [] }), /近期没有可用的席位明细/);
});


/* ---------------- v2.8.0：自选基金 / 自选股票 / 盈亏 / 排行榜 ---------------- */

test('DOM：导航拆成自选基金 / 自选股票 / 模拟交易，基金页不再有自选子页', () => {
  const tabs = [...document.querySelectorAll('.nav-tab')].map((b) => b.dataset.view);
  assert.ok(tabs.includes('fundwatch'), '缺少自选基金导航');
  assert.ok(tabs.includes('stockwatch'), '缺少自选股票导航');
  assert.ok(tabs.includes('paper'), '缺少模拟交易导航');
  assert.ok(!tabs.includes('watchlist'), '旧「自选·预警」导航应移除');

  assert.ok(document.querySelector('#view-fundwatch #fundWatchTable'), '自选基金板块要有自选表');
  assert.ok(document.querySelector('#view-fundwatch #fundPnlKpis'), '自选基金板块要有盈亏 KPI');
  assert.ok(document.querySelector('#view-fundwatch #fundPnlChart'), '自选基金板块要有市值曲线');
  assert.ok(document.querySelector('#view-fundwatch #fundPnlBars'), '自选基金板块要有月度盈亏');

  // v2.13.0：模拟交易独立成板块，自选股票只剩自选与预警
  assert.ok(document.querySelector('#view-paper #paperPanel'), '模拟交易应在自己的板块');
  assert.equal(document.querySelector('#view-stockwatch #paperPanel'), null, '自选股票里不应再有模拟账户');
  assert.ok(document.querySelector('#view-stockwatch #watchTable'), '我的自选应在自选股票');
  assert.ok(document.querySelector('#view-stockwatch #alertsPanel'), '条件预警跟着自选股票');

  assert.equal(document.querySelector('#fundWatchView'), null, '基金页不再有自选基金子页');
  assert.equal(document.querySelector('[data-fund-view="watch"]'), null, '基金子页导航不再有自选基金');
  assert.ok(document.querySelector('[data-goto="fundwatch"]'), '基金页要有跳到自选基金的入口');
});

test('DOM：v2.13.0 模拟交易板块包含全部模拟盘面板，两个板块互相有入口', () => {
  const paperView = document.querySelector('#view-paper');
  assert.ok(paperView, '缺少 #view-paper');
  for (const id of ['paperPanel', 'paperPnlCalendarPanel', 'paperRealizedPanel', 'paperOrderPanel', 'paperAutoPanel', 'paperReviewPanel']) {
    assert.ok(paperView.querySelector(`#${id}`), `模拟交易板块缺少 #${id}`);
  }
  // 自选股票那边连盈亏日历 / 委托 / 自动交易 / 复盘都不该留下
  for (const id of ['paperPnlCalendarPanel', 'paperOrderPanel', 'paperAutoPanel', 'paperReviewPanel']) {
    assert.equal(document.querySelector(`#view-stockwatch #${id}`), null, `自选股票里不该有 #${id}`);
  }
  assert.ok(document.querySelector('#view-paper [data-goto="stockwatch"]'), '模拟交易页要有回自选股票的入口');
  assert.ok(document.querySelector('#view-stockwatch [data-goto="paper"]'), '自选股票页要有去模拟交易的入口');
  // 视图 hash 认识新板块
  location.hash = '#paper';
  assert.equal(app.parseHashRoute().view, 'paper');
  location.hash = '';
});

test('DOM：旧 #watchlist 书签落到自选股票，新视图 hash 正常', () => {
  location.hash = '#watchlist';
  assert.equal(app.parseHashRoute().view, 'stockwatch');
  location.hash = '#fundwatch';
  assert.equal(app.parseHashRoute().view, 'fundwatch');
  location.hash = '#stockwatch';
  assert.equal(app.parseHashRoute().view, 'stockwatch');
  location.hash = '';
});

test('DOM：自选基金盈亏按份额加权，日/月/年口径都对', () => {
  const prevWatch = app.state.fundWatchlist;
  const prevHold = app.state.fundHoldings;
  const prevLive = app.state.fundWatchData;
  // 清掉实时行情：这里只验「净值序列」口径（实时点由下一条用例单独覆盖）
  app.state.fundWatchData = { items: [] };
  app.state.fundWatchlist = [
    { code: 'A1', name: '基金A', type: 'open' },
    { code: 'B1', name: '基金B', type: 'open' },
  ];
  // v2.10.7：老持仓没有建仓日会统一按 2026-11-01 裁剪，这条用例验的是加权口径，所以显式给更早的建仓日
  const early = Date.UTC(2025, 11, 1);
  app.state.fundHoldings = { A1: { shares: 100, cost: 1, addedAt: early }, B1: { shares: 50, cost: 2, addedAt: early } };
  const data = {
    items: [
      { code: 'A1', points: [{ d: '2026-01-02', c: 1 }, { d: '2026-06-01', c: 1.2 }, { d: '2026-11-18', c: 1.5 }, { d: '2026-11-19', c: 1.6 }] },
      { code: 'B1', points: [{ d: '2026-01-02', c: 2 }, { d: '2026-06-01', c: 2.2 }, { d: '2026-11-18', c: 2.4 }, { d: '2026-11-19', c: 2.5 }] },
    ],
    missing: [],
  };
  const calc = app.computeFundPnl(data);
  assert.ok(calc, '应能算出组合曲线');
  assert.equal(calc.rows.length, 4);
  assert.equal(calc.marketValue, 285, '100×1.6 + 50×2.5');
  assert.equal(calc.todayPnl, 15, '较前一交易日 +15');
  assert.equal(calc.todayPct, 5.56);
  assert.equal(calc.costValue, 200, '100×1 + 50×2');
  assert.equal(calc.cumulative, 85);
  assert.equal(calc.holdings, 2);
  assert.ok(calc.monthly.length >= 2, '应按月聚合出月度盈亏');

  // 没有持仓时返回 null，让渲染层走空态
  app.state.fundHoldings = {};
  assert.equal(app.computeFundPnl(data), null);
  app.state.fundWatchlist = prevWatch;
  app.state.fundHoldings = prevHold;
  app.state.fundWatchData = prevLive;
});

test('DOM：盈亏面板无持仓给引导，有持仓渲染 KPI 与说明', () => {
  const prevWatch = app.state.fundWatchlist;
  const prevHold = app.state.fundHoldings;
  const prevPnl = app.state.fundPnl;

  app.state.fundWatchlist = [];
  app.state.fundHoldings = {};
  app.state.fundPnl = null;
  app.renderFundPnl();
  assert.match(document.querySelector('#fundPnlKpis').textContent, /未录持仓/);
  assert.match(document.querySelector('#fundPnlNote').textContent, /份额与成本/);

  app.state.fundWatchlist = [{ code: 'A1', name: '基金A', type: 'open' }];
  app.state.fundHoldings = { A1: { shares: 100, cost: 1 } };
  app.state.fundPnl = {
    codes: 'A1',
    items: [{ code: 'A1', points: [{ d: '2026-11-18', c: 1.5 }, { d: '2026-11-19', c: 1.6 }] }],
    missing: [],
  };
  app.renderFundPnl();
  const kpi = document.querySelector('#fundPnlKpis').textContent;
  assert.match(kpi, /今日盈亏/);
  assert.match(kpi, /组合市值/);
  assert.match(document.querySelector('#fundPnlNote').textContent, /同一口径/, '说明要写清与「我的持仓」同口径');

  app.state.fundWatchlist = prevWatch;
  app.state.fundHoldings = prevHold;
  app.state.fundPnl = prevPnl;
});

test('DOM：模拟账户排行榜按总资产排序、标出自己并转义用户名', () => {
  const prevAuth = app.state.auth;
  const prevPaper = app.state.paper;
  const prevRank = app.state.paperRank;
  app.state.auth = { username: 'me' };
  app.state.paperRankSort = 'total';
  app.state.paper = {
    initial: 1000000, cash: 1000000, marketValue: 0, total: 1000000,
    profit: 0, profitPct: 0, positions: [], trades: [], rules: {},
  };
  app.state.paperRank = {
    items: [
      { username: 'me', total: 100, profit: 0, profitPct: 0, positionCount: 0, positions: [] },
      { username: '<b>x</b>', total: 200, profit: 100, profitPct: 100, positionCount: 1, positions: [{ name: '<i>坏', code: '600000', shares: 100 }] },
    ],
  };
  app.renderPaper();
  app.renderPaperRanking();
  const box = document.querySelector('#paperRankBody');
  assert.ok(box, '排行榜容器应存在');
  const rows = box.querySelectorAll('tbody tr');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /<b>x<\/b>/, '总资产高的排第一（文本被转义后原样显示）');
  assert.equal(box.querySelectorAll('b').length, 0, '用户名里的标签必须被转义');
  assert.ok(box.querySelector('tr.is-me'), '当前用户要高亮');
  assert.match(document.querySelector('#paperPanel').textContent, /所有登录用户都能看到/, '要写明可见性');

  // 切到按收益率排序：高收益率排第一
  app.state.paperRankSort = 'profit';
  app.renderPaperRanking();
  assert.match(document.querySelector('#paperRankBody tbody tr').textContent, /<b>x<\/b>/);

  app.state.auth = prevAuth;
  app.state.paper = prevPaper;
  app.state.paperRank = prevRank;
  app.state.paperRankSort = 'total';
});

/* ---------------------------------------------------------
   v2.9.0：排行榜默认收起 / 比例下单 / 两处盈亏同口径
   --------------------------------------------------------- */

test('DOM：模拟账户排行榜默认收起，点按钮才展开并请求', () => {
  const prevRank = app.state.paperRank;
  const prevOpen = app.state.paperRankOpen;
  app.state.paper = {
    initial: 1000000, cash: 1000000, marketValue: 0, total: 1000000,
    profit: 0, profitPct: 0, positions: [], trades: [], rules: {},
  };
  app.state.paperRank = null;
  app.state.paperRankOpen = false;
  app.renderPaper();

  const box = document.querySelector('#paperRankBody');
  const toggle = document.querySelector('#paperRankToggle');
  assert.ok(box, '排行榜容器应存在');
  assert.equal(box.hidden, true, '默认必须收起（用户要求默认不显示）');
  assert.match(toggle.textContent, /展开排行榜/);
  assert.match(document.querySelector('#paperPanel').textContent, /默认收起/);

  // 点开：容器显示、按钮变成收起（数据由 loadPaperRanking 负责，这里只验交互）
  app.state.paperRank = { items: [] };
  toggle.click();
  assert.equal(app.state.paperRankOpen, true);
  assert.equal(document.querySelector('#paperRankBody').hidden, false);
  assert.match(document.querySelector('#paperRankToggle').textContent, /收起/);

  // 再点收起
  document.querySelector('#paperRankToggle').click();
  assert.equal(app.state.paperRankOpen, false);
  assert.equal(document.querySelector('#paperRankBody').hidden, true);

  app.state.paper = null;
  app.state.paperRank = prevRank;
  app.state.paperRankOpen = prevOpen;
});

test('DOM：模拟买卖按比例估算股数（买入按可用资金、卖出按持仓）', () => {  // 买入：10 万可用、价格 10 元、1/4 → 25000 / (10×1.00025) ≈ 2499 股 → 向下取整到 2400 股
  assert.equal(app.paperRatioShares({ side: 'buy', ratio: 0.25, price: 10, cash: 100000, lot: 100 }), 2400);
  // 1/3、1/2 同理按整手取整
  assert.equal(app.paperRatioShares({ side: 'buy', ratio: 0.3333, price: 10, cash: 100000, lot: 100 }), 3300);
  assert.equal(app.paperRatioShares({ side: 'buy', ratio: 0.5, price: 10, cash: 100000, lot: 100 }), 4900);
  // 全部：不能超过可用资金（含最低 5 元佣金）
  const all = app.paperRatioShares({ side: 'buy', ratio: 1, price: 10, cash: 100000, lot: 100 });
  assert.equal(all, 9900);
  assert.ok(all * 10 + 5 <= 100000, '含佣金后不能超过可用资金');
  // 资金不足一手 → 0
  assert.equal(app.paperRatioShares({ side: 'buy', ratio: 1, price: 5000, cash: 1000, lot: 100 }), 0);
  // 卖出：持仓 1234 股，1/4 → 300 股；全部 → 1234 股（允许零股清仓）
  assert.equal(app.paperRatioShares({ side: 'sell', ratio: 0.25, price: 10, held: 1234, lot: 100 }), 300);
  assert.equal(app.paperRatioShares({ side: 'sell', ratio: 1, price: 10, held: 1234, lot: 100 }), 1234);
  assert.equal(app.paperRatioShares({ side: 'sell', ratio: 0.5, price: 10, held: 0, lot: 100 }), 0);
});

test('DOM：模拟买卖弹窗显示报价、预计金额与费用', () => {  const prevPaper = app.state.paper;
  app.state.paper = {
    initial: 1000000, cash: 100000, marketValue: 0, total: 100000,
    profit: 0, profitPct: 0, positions: [], trades: [], rules: {},
  };
  app.openPaperTrade('buy');
  assert.ok(document.querySelector('#paperForm'), '应打开买入弹窗');
  assert.ok(document.querySelector('#paperSymbol'), '要有代码/名称搜索框');
  assert.ok(document.querySelector('#paperSymbolPop'), '要有搜索候选层');
  assert.ok(document.querySelector('#paperIntraday'), '要有分时图容器');
  assert.equal(document.querySelectorAll('#paperRatioSeg [data-paper-ratio]').length, 4, '1/4、1/3、1/2、全部 四个按钮');
  assert.match(document.querySelector('#paperPreview').textContent, /预计|选择标的/);

  // 选中标的（不联网，直接塞报价）+ 填股数 → 预览金额与佣金
  app.state.paperTrade.target = { secid: '1.600519', code: '600519', name: '贵州茅台' };
  app.state.paperTrade.quote = { secid: '1.600519', code: '600519', name: '贵州茅台', price: 1500, pct: 1.2 };
  document.querySelector('#paperShares').value = '100';
  app.renderPaperQuote();
  app.renderPaperPreview();
  const preview = document.querySelector('#paperPreview').textContent;
  assert.match(preview, /150,000/, '预计金额 = 100 × 1500');
  assert.match(preview, /佣金/);
  assert.match(document.querySelector('#paperQuote').textContent, /1,500|1500/, '报价卡要显示现价');
  assert.match(document.querySelector('#paperQuote').textContent, /可用资金/, '买入要显示可用资金');

  app.closeOverlay();
  app.state.paper = prevPaper;
});

test('DOM：盈亏统计与我的持仓用同一口径（今日盈亏 / 累计收益 / 组合市值一致）', () => {
  const prevWatch = app.state.fundWatchlist;
  const prevHold = app.state.fundHoldings;
  const prevLive = app.state.fundWatchData;
  const prevPnl = app.state.fundPnl;

  app.state.fundWatchlist = [{ code: 'A1', name: '基金A', type: 'open' }];
  app.state.fundHoldings = { A1: { shares: 100, cost: 1 } };
  // 实时价 1.6（今日 +1.27%），序列只到 1.5 → 旧口径会拿 1.5 当今日，两处对不上
  app.state.fundWatchData = {
    items: [{ code: 'A1', name: '基金A', price: 1.6, pct: 1.2658, pctKind: 'nav', pctStale: false, date: '2026-11-19' }],
    today: '2026-11-19',
  };
  app.state.fundPnl = {
    codes: 'A1',
    items: [{ code: 'A1', points: [{ d: '2026-11-18', c: 1.5 }, { d: '2026-11-19', c: 1.5 }] }],
    missing: [],
  };
  app.renderFundPnl();
  const pf = app.fundPortfolio();
  assert.equal(pf.marketValue, 160, '持有市值 = 100 × 1.6');
  assert.equal(pf.profit, 60);
  const kpi = document.querySelector('#fundPnlKpis').textContent;
  assert.ok(kpi.includes(app.esc('160.00')) || /160/.test(kpi), '组合市值要与持仓面板一致（含今日）');
  assert.match(kpi, /60\.00/, '累计收益 = 160 - 100，与持仓面板同一口径');
  assert.match(kpi, /今日盈亏/);
  // 曲线末尾也接上了今天的实时点
  const calc = app.computeFundPnl(app.state.fundPnl);
  assert.equal(calc.rows[calc.rows.length - 1].v, 160);
  assert.equal(calc.asOf, calc.rows[calc.rows.length - 1].d);

  app.state.fundWatchlist = prevWatch;
  app.state.fundHoldings = prevHold;
  app.state.fundWatchData = prevLive;
  app.state.fundPnl = prevPnl;
});

/* ---------------------------------------------------------
   v2.9.1：模拟买入被 HTML step 校验拦住（100 股非法）+ 股数校验提示
   --------------------------------------------------------- */

test('DOM：模拟买卖股数输入不再用 step 原生校验，100 股可直接提交', () => {
  const prevPaper = app.state.paper;
  app.state.paper = {
    initial: 1000000, cash: 1000000, marketValue: 0, total: 1000000,
    profit: 0, profitPct: 0, positions: [], trades: [], rules: {},
  };
  app.openPaperTrade('buy');
  const form = document.querySelector('#paperForm');
  const input = document.querySelector('#paperShares');
  assert.ok(form && input);
  assert.equal(form.hasAttribute('novalidate'), true, '表单要关掉浏览器原生校验');
  assert.equal(input.getAttribute('step'), '1', 'step 必须是 1（step=100 + min=1 会让 100 非法）');
  input.value = '100';
  assert.equal(form.checkValidity(), true, '100 股必须是合法值');

  // 纯校验函数：整手 / 非整手 / 资金不足 / 持仓不足 / 零股清仓
  assert.equal(app.paperValidateShares({ side: 'buy', shares: 100, secid: '1.600519', price: 10, cash: 100000 }).ok, true);
  assert.equal(app.paperValidateShares({ side: 'buy', shares: 200, secid: '1.600519', price: 10, cash: 100000 }).ok, true);
  const bad = app.paperValidateShares({ side: 'buy', shares: 150, secid: '1.600519', price: 10, cash: 100000 });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /100 股整数倍/);
  assert.match(bad.message, /100 或 200/, '要给出可改的具体数字');
  const poor = app.paperValidateShares({ side: 'buy', shares: 200, secid: '1.600519', price: 1000, cash: 100000 });
  assert.equal(poor.ok, false);
  assert.match(poor.message, /可用资金不足/);
  // 卖出：部分卖出必须整手；全仓允许零股
  assert.equal(app.paperValidateShares({ side: 'sell', shares: 150, secid: '1.600519', held: 150 }).ok, true);
  const partial = app.paperValidateShares({ side: 'sell', shares: 150, secid: '1.600519', held: 400 });
  assert.equal(partial.ok, false);
  assert.match(partial.message, /全部/);
  assert.equal(app.paperValidateShares({ side: 'sell', shares: 500, secid: '1.600519', held: 400 }).ok, false);
  // 非 A 股（港股/美股）不按 100 股
  assert.equal(app.paperValidateShares({ side: 'buy', shares: 15, secid: '116.00700', price: 300, cash: 100000 }).ok, true);

  app.closeOverlay();
  app.state.paper = prevPaper;
});

/* ---------------------------------------------------------
   v2.9.2：口径标签 / 排行榜统计行 / 模拟盘实时 KPI / 登录页文案
   --------------------------------------------------------- */

test('DOM：基金两个面板都标出「今日盈亏」当前口径与时间点说明', () => {
  const loginHtml = readFileSync(join(ROOT, 'public', 'login.html'), 'utf8');
  assert.equal(/每天登录会被记录/.test(loginHtml), false, '登录页不该再出现「每天登录会被记录」');
  assert.match(loginHtml, /默认勾选/);
  assert.match(loginHtml, /7 天内不用再输密码/);

  const prevWatch = app.state.fundWatchlist;
  const prevHold = app.state.fundHoldings;
  const prevLive = app.state.fundWatchData;
  const prevPnl = app.state.fundPnl;

  app.state.fundWatchlist = [{ code: 'A1', name: '基金A', type: 'open' }];
  app.state.fundHoldings = { A1: { shares: 1000, cost: 1, updatedAt: Date.now() } };
  // 盘中：只有估值，没有今日净值
  app.state.fundWatchData = {
    items: [{ code: 'A1', name: '基金A', price: 1.2, pct: 0.8, pctKind: 'holdings', pctStale: false, estimatePct: 0.8, estimateFrozen: false, estimateKind: 'holdings', date: '2026-11-19' }],
    updatedAt: Date.now(),
    phase: 'open',
  };
  app.state.fundPnl = { codes: 'A1', items: [{ code: 'A1', points: [{ d: '2026-11-18', c: 1.1 }, { d: '2026-11-19', c: 1.1 }] }], missing: [] };
  app.renderFundHoldSummary();
  app.renderFundPnl();

  const holdCard = document.querySelector('#fundHoldSummary').textContent;
  assert.match(holdCard, /今日盈亏/, '我的持仓卡片要叫「今日盈亏」');
  assert.match(holdCard, /按当日估值/, '卡片副标题要写清当前口径');
  const holdBasis = document.querySelector('#fundHoldBasis').textContent;
  assert.match(holdBasis, /按当日估值/, '我的持仓面板要有口径标签');
  const pnlBasis = document.querySelector('#fundPnlBasis').textContent;
  assert.match(pnlBasis, /按当日估值/, '盈亏统计面板要有同一份口径标签');
  assert.match(document.querySelector('#fundPnlKpis').textContent, /今日盈亏/);

  // 收盘后已冻结 → 标签改成「按 15:00 估值终值」
  app.state.fundWatchData = {
    items: [{ code: 'A1', name: '基金A', price: 1.2, pct: 0.8, pctKind: 'holdings', pctStale: false, estimatePct: 0.8, estimateFrozen: true, estimateKind: 'holdings', date: '2026-11-19' }],
    updatedAt: Date.now(),
    phase: 'closed',
  };
  app.renderFundHoldSummary();
  assert.match(document.querySelector('#fundHoldBasis').textContent, /15:00 估值终值/);

  app.state.fundWatchlist = prevWatch;
  app.state.fundHoldings = prevHold;
  app.state.fundWatchData = prevLive;
  app.state.fundPnl = prevPnl;
});

test('DOM：排行榜统计行保留账号数，但不显示被管理员隐藏的数量', () => {
  const prevRank = app.state.paperRank;
  app.state.paperRankSort = 'total';
  app.state.paperRank = {
    items: [{ username: 'alice', total: 100, profit: 10, profitPct: 10, positions: [], positionCount: 0 }],
    hidden: 3,
    estimated: false,
    truncated: false,
    updatedAt: Date.now(),
  };
  app.renderPaperRanking();
  const text = document.querySelector('#paperRankBody').textContent;
  assert.match(text, /1 个账号/, '保留可见账号数');
  assert.equal(/被管理员隐藏/.test(text), false, '不再显示「另有 N 个账号被管理员隐藏」');
  app.state.paperRank = prevRank;
});

test('DOM：模拟盘 KPI 显示更新时刻、持仓浮盈与已实现，昨收仓带标记', () => {
  const prevPaper = app.state.paper;
  app.state.paper = {
    initial: 1000000, cash: 500000, marketValue: 520000, total: 1020000,
    profit: 20000, profitPct: 2, positionProfit: 22000, realizedProfit: -2000,
    pricesAsOf: Date.now(), anyPrevClose: true, prevCloseCount: 1,
    positions: [
      { secid: '1.600519', code: '600519', name: '贵州茅台', shares: 100, cost: 10, price: 12, priceMode: 'prevClose', pct: 0, marketValue: 1200, profit: 200, profitPct: 20 },
    ],
    trades: [], rules: {},
  };
  app.renderPaper();
  const panel = document.querySelector('#paperPanel');
  const kpis = panel.querySelector('.paper-kpis').textContent;
  assert.match(kpis, /更新/, '总资产要写更新时刻');
  assert.match(kpis, /持仓浮盈/, '累计盈亏要拆出持仓浮盈');
  assert.match(kpis, /已实现/, '累计盈亏要拆出已实现');
  assert.match(kpis, /按昨收估/, '有昨收估值时要写出来');
  assert.match(panel.querySelector('.paper-pos-table').textContent, /昨收/, '持仓现价旁要标昨收');
  app.state.paper = prevPaper;
});
﻿
/* ---------------------------------------------------------
   v2.10.0：基金页新增子页 / 自选基金多组合 / 盈亏日历 / 组合对比
   --------------------------------------------------------- */

test('DOM：界面配置能隐藏基金子页，并把当前子页回退到可见项', () => {
  const prevCfg = app.state.uiConfig;
  const prevView = app.state.fundView;
  app.state.uiConfig = {
    fundModules: { sector: true, theme: false, dist: true, openfund: false, openflow: false, proxy: false, flow: false, stock: false, bond: false },
  };
  app.state.fundView = 'openflow';
  app.applyFundModuleVisibility();
  assert.equal(app.state.fundView, 'sector', '被隐藏的子页要回退到第一个可见子页');
  assert.equal(document.querySelector('#fundSubnav [data-fund-view="openflow"]').hidden, true);
  assert.equal(document.querySelector('#fundSubnav [data-fund-view="proxy"]').hidden, true);
  assert.equal(document.querySelector('#fundSubnav [data-fund-view="dist"]').hidden, false);
  assert.equal(app.fundModuleVisible('sector'), true);
  assert.equal(app.fundModuleVisible('bond'), false);
  app.state.uiConfig = prevCfg;
  app.state.fundView = prevView;
  app.applyFundModuleVisibility();
});

test('DOM：逐日盈亏只统计建仓日之后，建仓前不生成数据', () => {
  const series = [{
    code: 'A1',
    points: [
      { d: '2026-01-02', c: 1 },
      { d: '2026-06-01', c: 1.2 },
      { d: '2026-11-19', c: 1.6 },
    ],
  }];
  const holdings = { A1: { shares: 100, cost: 1, addedAt: Date.UTC(2026, 5, 1) } };
  const daily = app.computeFundDailyPnl(series, holdings);
  assert.ok(daily, '有持仓就应算出来');
  assert.equal(daily.rows[0].d, '2026-06-01', '第一条必须从建仓日开始');
  assert.equal(daily.rows.length, 2);
  assert.equal(daily.rows[1].pnl, 40, '100 份 ×（1.6 − 1.2）');
  assert.equal(daily.rows[1].pct, 33.33, '40 ÷ 120 ≈ 33.33%');
  // 没有建仓日记录（v2.10.0 之前的老持仓）→ 统一按 2026-11-01 起算（v2.10.7，用户要求）
  const noStart = app.computeFundDailyPnl(series, { A1: { shares: 100, cost: 1 } });
  assert.equal(noStart.rows[0].d, '2026-11-19', '老持仓统一按 2026-11-01 起算，11-19 是第一个交易日');
  assert.equal(noStart.startDate, '2026-11-19');
  assert.equal(app.computeFundDailyPnl(series, {}), null, '没有持仓返回 null');
});

test('DOM：盈亏日历「日」视图是周一到周五网格，周末不占列', () => {
  const prevPortfolios = app.state.portfolios;
  const prevActive = app.state.activePortfolioId;
  const prevHold = app.state.fundHoldings;
  const prevPnl = app.state.fundPnl;
  const prevUnit = app.state.pnlUnit;
  const prevMetric = app.state.pnlMetric;
  const prevYm = app.state.pnlYearMonth;
  app.state.portfolios = [{ id: 'default', name: '主持仓', isDefault: true, holdings: { A1: { shares: 100, cost: 1, addedAt: Date.UTC(2026, 10, 1) } } }];
  app.state.activePortfolioId = 'default';
  app.state.fundHoldings = { A1: { shares: 100, cost: 1, addedAt: Date.UTC(2026, 10, 1) } };
  app.state.fundPnl = {
    items: [{
      code: 'A1',
      points: [
        { d: '2026-11-02', c: 1 },
        { d: '2026-11-03', c: 1.02 },
        { d: '2026-11-04', c: 1.01 },
      ],
    }],
    index: null,
    missing: [],
  };
  app.state.pnlUnit = 'day';
  app.state.pnlMetric = 'amount';
  app.state.pnlYearMonth = '2026-11';
  app.renderFundPnlCalendar();
  const box = document.querySelector('#fundPnlCalendar');
  assert.ok(box.querySelector('.pnl-calendar'), '缺少日历网格');
  const heads = [...box.querySelectorAll('.pnl-calendar-head')].map((el) => el.textContent.trim()).filter(Boolean);
  assert.deepEqual(heads, ['周一', '周二', '周三', '周四', '周五'], '表头必须是周一~周五');
  // 2026-11-07 / 08 是周末：不应出现 7、8 号格子
  const dayTexts = [...box.querySelectorAll('.pnl-calendar-day')].map((el) => el.textContent.trim());
  assert.ok(!dayTexts.includes('7') && !dayTexts.includes('8'), '周末不占列');
  assert.ok(dayTexts.includes('3'), '周二 3 号要有格子');
  const cells = [...box.querySelectorAll('.pnl-calendar-cell')];
  assert.ok(cells.some((c) => c.classList.contains('is-up')), '11-03 上涨应有红色格');
  // 没有当天数据的交易日要显示 --，不能显示「休」（用户反馈）
  const emptyCell = cells.find((c) => (c.querySelector('.pnl-calendar-day') || {}).textContent === '5');
  assert.ok(emptyCell, '11-05 应有格子（周四）');
  assert.equal(emptyCell.querySelector('.pnl-calendar-val').textContent.trim(), '--', '没有数据要显示 --');
  assert.ok(!box.textContent.includes('休'), '日历里不应出现「休」字');

  assert.ok(cells.some((c) => c.classList.contains('is-down')), '11-04 下跌应有绿色格');
  assert.match(document.querySelector('#fundPnlCalendarNote').textContent, /建仓日/, '要写明统计起点');

  // 月视图：12 个格子
  app.state.pnlUnit = 'month';
  app.renderFundPnlCalendar();
  assert.equal(box.querySelectorAll('.pnl-calendar-tile').length, 12, '月视图应有 12 个格子');
  // 年视图：至少 1 个格子
  app.state.pnlUnit = 'year';
  app.renderFundPnlCalendar();
  assert.ok(box.querySelectorAll('.pnl-calendar-tile').length >= 1, '年视图应有年份格子');

  app.state.portfolios = prevPortfolios;
  app.state.activePortfolioId = prevActive;
  app.state.fundHoldings = prevHold;
  app.state.fundPnl = prevPnl;
  app.state.pnlUnit = prevUnit;
  app.state.pnlMetric = prevMetric;
  app.state.pnlYearMonth = prevYm;
});

test('DOM：v2.10.6 建仓日晚于最新净值时不再卡「计算中」，盈亏日历与统计给出等待状态', () => {
  const prevPortfolios = app.state.portfolios;
  const prevActive = app.state.activePortfolioId;
  const prevHold = app.state.fundHoldings;
  const prevPnl = app.state.fundPnl;
  const prevWatch = app.state.fundWatchlist;
  const prevLive = app.state.fundWatchData;
  const prevUnit = app.state.pnlUnit;
  const prevMetric = app.state.pnlMetric;
  const prevYm = app.state.pnlYearMonth;
  // 后台恢复持仓会把原建仓日写回：2026-11-21 12:00（上海），而净值只公布到 11-19
  const holdings = { A1: { shares: 100, cost: 1, addedAt: Date.UTC(2026, 10, 21, 4) } };
  const series = [{ code: 'A1', points: [{ d: '2026-11-18', c: 1.5 }, { d: '2026-11-19', c: 1.6 }] }];
  const daily = app.computeFundDailyPnl(series, holdings);
  assert.ok(daily, '建仓后还没有新净值时不能返回 null（否则前端永远停在计算中）');
  assert.equal(daily.pending, true);
  assert.equal(daily.rows.length, 0, '建仓日之前不能生成逐日盈亏');
  assert.equal(daily.pendingStart, '2026-11-21');
  assert.equal(daily.lastNavDate, '2026-11-19');
  assert.equal(daily.marketValue, 160, '100 份 × 最新净值 1.6');
  assert.equal(app.fundPnlPending(holdings, series).pending, true);
  assert.equal(app.fundPnlPending({}, series), null, '没有持仓不算等待');

  app.state.portfolios = [{ id: 'default', name: '主持仓', isDefault: true, holdings }];
  app.state.activePortfolioId = 'default';
  app.state.fundHoldings = holdings;
  app.state.fundPnl = { items: series, index: null, missing: [] };
  app.state.pnlUnit = 'day';
  app.state.pnlMetric = 'amount';
  app.state.pnlYearMonth = '';
  app.renderFundPnlCalendar();
  const cal = document.querySelector('#fundPnlCalendar');
  assert.ok(cal.querySelector('.pnl-calendar'), '等待期间也要渲染日历网格，不能只剩一句「计算中」');
  assert.ok(!cal.textContent.includes('正在计算'), '不能停在「正在计算」');
  assert.match(document.querySelector('#fundPnlCalendarMeta').textContent, /等待新净值/);
  const calNote = document.querySelector('#fundPnlCalendarNote').textContent;
  assert.match(calNote, /还没有已公布净值/);
  assert.match(calNote, /建仓之前的涨跌不计入/);

  app.state.fundWatchlist = [{ code: 'A1', name: '基金A', type: 'open' }];
  app.state.fundWatchData = { items: [{ code: 'A1', name: '基金A', type: 'open', price: 1.6, pct: 0, pctKind: 'navbar' }] };
  app.renderFundPnl();
  const kpi = document.querySelector('#fundPnlKpis').textContent;
  assert.match(kpi, /今日盈亏/);
  assert.match(kpi, /组合市值/);
  assert.match(kpi, /建仓后暂无新净值/);
  assert.ok(!kpi.includes('净值历史不足'), '不要再说「净值历史不足」误导用户');
  assert.match(document.querySelector('#fundPnlNote').textContent, /还没有已公布净值/);
  assert.match(document.querySelector('#fundPnlChart').textContent, /还没有已公布净值/);

  // 我的持仓表要真的显示建仓日（v2.10.6 修 getFundHolding 丢掉 addedAt 的问题）
  app.renderFundHoldTable();
  const holdTable = document.querySelector('#fundHoldTable').textContent;
  assert.match(holdTable, /11-21/, '建仓日要显示 11-21');
  assert.ok(!holdTable.includes('未记录'), '有 addedAt 时不能显示「未记录」');

  app.state.portfolios = prevPortfolios;
  app.state.activePortfolioId = prevActive;
  app.state.fundHoldings = prevHold;
  app.state.fundPnl = prevPnl;
  app.state.fundWatchlist = prevWatch;
  app.state.fundWatchData = prevLive;
  app.state.pnlUnit = prevUnit;
  app.state.pnlMetric = prevMetric;
  app.state.pnlYearMonth = prevYm;
});

test('DOM：v2.10.7 老持仓没有建仓日时统一按 2026-11-01 起算（盈亏日历与持仓表）', () => {
  const prevPortfolios = app.state.portfolios;
  const prevActive = app.state.activePortfolioId;
  const prevHold = app.state.fundHoldings;
  const prevPnl = app.state.fundPnl;
  const prevWatch = app.state.fundWatchlist;
  const prevLive = app.state.fundWatchData;
  const prevUnit = app.state.pnlUnit;
  const prevMetric = app.state.pnlMetric;
  const prevYm = app.state.pnlYearMonth;
  // v2.10.0 之前的老持仓：只有 shares / cost，没有 addedAt
  const holdings = { A1: { shares: 100, cost: 1 } };
  const items = [{
    code: 'A1',
    points: [
      { d: '2026-10-30', c: 1.5 },
      { d: '2026-11-02', c: 1.52 },
      { d: '2026-11-03', c: 1.6 },
    ],
  }];
  const daily = app.computeFundDailyPnl(items, holdings);
  assert.ok(daily, '老持仓也要算得出来');
  assert.equal(daily.rows[0].d, '2026-11-02', '2026-11-01 之前（10-30）不计入');
  assert.equal(daily.rows.length, 2);
  assert.equal(daily.startDate, '2026-11-02');

  app.state.portfolios = [{ id: 'default', name: '主持仓', isDefault: true, holdings }];
  app.state.activePortfolioId = 'default';
  app.state.fundHoldings = holdings;
  app.state.fundPnl = { items, index: null, missing: [] };
  app.state.fundWatchlist = [{ code: 'A1', name: '基金A', type: 'open' }];
  app.state.fundWatchData = { items: [{ code: 'A1', name: '基金A', type: 'open', price: 1.61, pct: 0, pctKind: 'navbar' }] };
  app.state.pnlUnit = 'day';
  app.state.pnlMetric = 'amount';
  app.state.pnlYearMonth = '';
  app.renderFundPnlCalendar();
  const cal = document.querySelector('#fundPnlCalendar');
  assert.ok(cal.querySelector('.pnl-calendar'), '老持仓应正常渲染日历');
  const cells = [...cal.querySelectorAll('.pnl-calendar-cell')];
  const day2 = cells.find((c) => (c.querySelector('.pnl-calendar-day') || {}).textContent === '2');
  assert.ok(day2 && !day2.classList.contains('is-rest'), '11-02 应有真实数据（不是 --）');
  assert.match(document.querySelector('#fundPnlCalendarNote').textContent, /2026-11-01/, '说明要写清老数据统一按 2026-11-01');

  app.renderFundHoldTable();
  const table = document.querySelector('#fundHoldTable').textContent;
  assert.match(table, /11-01/, '老持仓的建仓日显示 11-01');
  assert.ok(!table.includes('未记录'), '不再显示「未记录」');

  app.state.portfolios = prevPortfolios;
  app.state.activePortfolioId = prevActive;
  app.state.fundHoldings = prevHold;
  app.state.fundPnl = prevPnl;
  app.state.fundWatchlist = prevWatch;
  app.state.fundWatchData = prevLive;
  app.state.pnlUnit = prevUnit;
  app.state.pnlMetric = prevMetric;
  app.state.pnlYearMonth = prevYm;
});

test('DOM：今日盈亏 TOP5 分开盈利与亏损，没有盈利时默认落到亏损 TAB', () => {
  const prevHold = app.state.fundHoldings;
  const prevData = app.state.fundWatchData;
  const prevTab = app.state.topMoversTab;
  const prevPortfolios = app.state.portfolios;
  const prevActive = app.state.activePortfolioId;
  app.state.portfolios = [{ id: 'default', name: '主持仓', isDefault: true, holdings: { A1: { shares: 100, cost: 1 }, B1: { shares: 100, cost: 1 } } }];
  app.state.activePortfolioId = 'default';
  app.state.fundHoldings = { A1: { shares: 100, cost: 1 }, B1: { shares: 100, cost: 1 } };
  app.state.fundWatchData = {
    items: [
      { code: 'A1', name: '基金A', type: 'open', price: 1.2, pct: 2, pctKind: 'navbar' },
      { code: 'B1', name: '基金B', type: 'open', price: 1, pct: -3, pctKind: 'navbar' },
    ],
  };
  app.state.topMoversTab = 'profit';
  app.renderFundTopMovers();
  const box = document.querySelector('#fundTopMovers');
  assert.match(box.textContent, /基金A/, '盈利 TAB 应列出上涨的基金');
  const winners = app.fundTopMovers(app.state.fundWatchData.items, app.state.fundHoldings, 5);
  assert.equal(winners.winners.length, 1);
  assert.equal(winners.losers.length, 1);
  assert.ok(winners.winners[0].dayProfit > 0);
  assert.ok(winners.losers[0].dayProfit < 0);

  // 只有亏损时：默认落在亏损 TAB
  app.state.fundHoldings = { B1: { shares: 100, cost: 1 } };
  app.state.topMoversTab = 'profit';
  app.renderFundTopMovers();
  assert.equal(app.state.topMoversTab, 'loss', '没有盈利时必须默认显示亏损 TOP5');
  assert.match(document.querySelector('#fundTopMovers').textContent, /基金B/);

  app.state.fundHoldings = prevHold;
  app.state.fundWatchData = prevData;
  app.state.topMoversTab = prevTab;
  app.state.portfolios = prevPortfolios;
  app.state.activePortfolioId = prevActive;
});

test('DOM：组合 vs 上证的基准日与超额计算', () => {
  const prevHold = app.state.fundHoldings;
  app.state.fundHoldings = { A1: { shares: 100, cost: 1, addedAt: Date.UTC(2026, 0, 1) } };
  const data = {
    items: [{
      code: 'A1',
      points: [
        { d: '2026-01-02', c: 1 },
        { d: '2026-11-18', c: 1.1 },
        { d: '2026-11-19', c: 1.2 },
      ],
    }],
    index: {
      name: '上证指数',
      points: [
        { d: '2026-01-02', c: 3000 },
        { d: '2026-11-18', c: 3150 },
        { d: '2026-11-19', c: 3300 },
      ],
    },
  };
  const calc = app.portfolioVsIndex(data, 'all');
  assert.ok(calc, '应能算出组合 vs 上证');
  assert.equal(calc.baseDate, '2026-01-02');
  assert.equal(calc.myPct, 20, '组合从 100 涨到 120');
  assert.equal(calc.indexPct, 10, '上证从 3000 涨到 3300');
  assert.equal(calc.excess, 10, '跑赢 10 个百分点');
  const year = app.portfolioVsIndex(data, 'year');
  assert.ok(year, '今年区间能算出来');
  assert.equal(year.baseDate, '2026-01-02', '没有更早的交易日时以区间首日为基准');
  assert.equal(year.myPct, 20);
  app.state.fundHoldings = prevHold;
});

test('DOM：多份持仓 TAB 渲染与切换后持仓视图跟着换', () => {
  const prevPortfolios = app.state.portfolios;
  const prevActive = app.state.activePortfolioId;
  const prevHold = app.state.fundHoldings;
  app.state.portfolios = [
    { id: 'default', name: '主持仓', isDefault: true, holdings: { A1: { shares: 100, cost: 1 } } },
    { id: 'p2', name: '父母养老', isDefault: false, holdings: { B1: { shares: 50, cost: 2 } } },
  ];
  app.state.activePortfolioId = 'default';
  app.state.fundHoldings = { A1: { shares: 100, cost: 1 } };
  app.renderPortfolioTabs();
  const tabs = [...document.querySelectorAll('#fundPortfolioTabs [data-portfolio-tab]')];
  assert.equal(tabs.length, 2, '两份组合应有两个 TAB');
  assert.ok(tabs[0].classList.contains('is-active'), '默认组合排第一且选中');
  assert.match(document.querySelector('#fundPortfolioTabs').textContent, /父母养老/);
  app.switchPortfolio('p2');
  assert.equal(app.state.activePortfolioId, 'p2');
  assert.deepEqual(Object.keys(app.state.fundHoldings), ['B1'], '切组合后持仓视图要换成该组合的');
  app.state.portfolios = prevPortfolios;
  app.state.activePortfolioId = prevActive;
  app.state.fundHoldings = prevHold;
});

test('DOM：基金涨跌分布 / 板块总览 / 场外基金榜能渲染，恶意名称被转义', () => {
  const evil = '<img src=x onerror="window.__x=1">';
  const prevDist = app.state.fundDist;
  app.state.fundDist = {
    scope: 'equity',
    up: 12,
    down: 30,
    flat: 3,
    total: 45,
    upRatio: 26.7,
    date: '2026-11-20',
    buckets: [
      { label: '≤-5%', tone: 'down', count: 4 },
      { label: '0%（平盘）', tone: 'flat', count: 3 },
      { label: '≥5%', tone: 'up', count: 2 },
    ],
  };
  app.renderFundDistribution();
  assert.match(document.querySelector('#fundDistSummary').textContent, /上涨家数/);
  assert.match(document.querySelector('#fundDistMeta').textContent, /2026-11-20/);

  const prevThemes = app.state.fundThemes;
  app.state.fundThemes = {
    themes: [{
      sector: evil, etfCount: 2, fundCount: 10, upCount: 8, downCount: 4, avgDay: 1.2, avgMonth: 3.3,
      streak: 3, day5: 2.1, leaderEtf: { code: '510300', name: evil }, leaderStock: null,
    }],
    fundCount: 10,
    etfCount: 2,
    stockCount: 10,
    date: '2026-11-20',
  };
  app.renderFundThemeOverview();
  const themeBox = document.querySelector('#fundThemeTable');
  assert.equal(themeBox.querySelectorAll('img').length, 0, '主题名里的 HTML 必须被转义');
  assert.match(themeBox.textContent, /3 天/, '应显示连涨天数');

  const prevBoard = app.state.fundBoard;
  app.state.fundBoard = {
    tab: 'gain',
    items: [{ code: '000001', name: evil, type: 'open', typeLabel: '混合型', nav: 1.2, day: 3.4, week: 5, month: 6, year: 7, sector: '混合均衡' }],
    count: 1,
    date: '2026-11-20',
  };
  app.renderFundBoard();
  const boardBox = document.querySelector('#fundBoardTable');
  assert.equal(boardBox.querySelectorAll('img').length, 0, '基金名里的 HTML 必须被转义');
  assert.match(boardBox.textContent, /混合均衡/, '要显示关联板块');

  app.state.fundDist = prevDist;
  app.state.fundThemes = prevThemes;
  app.state.fundBoard = prevBoard;
});
﻿
test('DOM：v2.10.2 我的持仓面板排在今日盈亏 TOP5 之前', () => {
  const section = document.querySelector('#view-fundwatch');
  const kids = [...section.children];
  const tabs = section.querySelector('#fundPortfolioTabs');
  const hold = section.querySelector('.fund-hold-panel');
  const top = section.querySelector('#fundTopMoversPanel');
  assert.ok(tabs && hold && top, '组合 TAB / 我的持仓 / TOP5 都要存在');
  assert.ok(kids.indexOf(tabs) < kids.indexOf(hold), '组合 TAB 应在我的持仓上面');
  assert.ok(kids.indexOf(hold) < kids.indexOf(top), '我的持仓应在今日盈亏 TOP5 上面');
});

/* ---------------------------------------------------------
   v2.10.3：我的持仓改用「当日涨跌 / 当日估值」，并支持持仓调整与可恢复删除
   --------------------------------------------------------- */

test('DOM：v2.10.3 我的持仓表用「当日涨跌 / 当日估值」两列，并带改 / 删按钮', () => {
  const prevWatch = app.state.fundWatchlist;
  const prevHold = app.state.fundHoldings;
  const prevLive = app.state.fundWatchData;
  app.state.fundWatchlist = [{ code: 'A1', name: '基金A', type: 'open' }];
  app.state.fundHoldings = { A1: { shares: 1000, cost: 1 } };
  app.state.fundWatchData = {
    items: [{
      code: 'A1', name: '基金A', type: 'open', price: 1.2, pct: 0.8, pctKind: 'holdings', pctStale: false,
      navPctToday: 1.1, estimatePct: 0.8, estimateFrozen: true, estimateKind: 'holdings', estimateAt: '2026-11-19 15:00', date: '2026-11-19',
    }],
  };
  app.renderFundHoldTable();
  const table = document.querySelector('#fundHoldTable table');
  assert.ok(table, '持仓表要能渲染');
  const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  assert.ok(heads.includes('当日涨跌'), '要有「当日涨跌」列');
  assert.ok(heads.includes('当日估值'), '要有「当日估值」列');
  assert.equal(heads.includes('今日盈亏'), false, '「今日盈亏」列已被当日涨跌 / 当日估值替换');
  const bodyText = table.querySelector('tbody').textContent;
  assert.match(bodyText, /今日净值|最新净值/, '当日涨跌要标明净值日口径');
  assert.match(bodyText, /15:00 估值|盘中估值/, '当日估值要标明口径');
  const btns = [...table.querySelectorAll('[data-hold-action]')];
  assert.deepEqual(btns.map((b) => b.getAttribute('data-hold-action')), ['edit', 'delete'], '每行要有改 / 删两个动作');
  assert.match(btns[1].getAttribute('title'), /回收站|后台/, '删除按钮要说明后台可恢复');
  app.state.fundWatchlist = prevWatch;
  app.state.fundHoldings = prevHold;
  app.state.fundWatchData = prevLive;
});

test('DOM：v2.10.3 组合 TAB 旁有「持仓调整」，弹窗列出已持有与未持有的自选基金', () => {
  const prevPortfolios = app.state.portfolios;
  const prevActive = app.state.activePortfolioId;
  const prevHold = app.state.fundHoldings;
  const prevWatch = app.state.fundWatchlist;
  const prevLive = app.state.fundWatchData;
  app.state.portfolios = [{ id: 'default', name: '主持仓', isDefault: true, holdings: { A1: { shares: 100, cost: 1 } } }];
  app.state.activePortfolioId = 'default';
  app.state.fundHoldings = { A1: { shares: 100, cost: 1 } };
  app.state.fundWatchlist = [
    { code: 'A1', name: '基金A', type: 'open' },
    { code: 'B2', name: '基金B', type: 'etf' },
  ];
  app.state.fundWatchData = { items: [{ code: 'A1', price: 1.2 }, { code: 'B2', price: 2 }] };
  app.renderPortfolioTabs();
  const actions = document.querySelector('#fundPortfolioTabs .fund-portfolio-actions');
  assert.ok(actions, '组合操作区要存在');
  assert.match(actions.textContent, /新建/);
  assert.match(actions.textContent, /重命名/);
  const adjust = actions.querySelector('[data-portfolio-adjust]');
  assert.ok(adjust, '新建 / 重命名旁边要有「持仓调整」');
  assert.equal(adjust.textContent.trim(), '持仓调整');

  app.openPortfolioAdjust();
  const modal = document.querySelector('.modal.modal-adjust');
  assert.ok(modal, '持仓调整弹窗要打开');
  const rows = [...modal.querySelectorAll('tbody tr[data-adjust-code]')];
  assert.equal(rows.length, 2, '已持有的和自选里未持有的都要列出来');
  assert.equal(rows[0].getAttribute('data-adjust-code'), 'A1', '已持有的排在前面');
  assert.equal(rows[0].querySelector('[data-adjust-shares]').value, '100', '当前份额要预填');
  assert.equal(rows[1].querySelector('[data-adjust-shares]').value, '', '未持有的份额留空');
  assert.ok(rows[0].querySelector('[data-adjust-delete]'), '已持有的行有删除按钮');
  assert.equal(rows[1].querySelector('[data-adjust-delete]'), null, '未持有的行没有删除按钮');
  app.closeOverlay();

  app.state.portfolios = prevPortfolios;
  app.state.activePortfolioId = prevActive;
  app.state.fundHoldings = prevHold;
  app.state.fundWatchlist = prevWatch;
  app.state.fundWatchData = prevLive;
});

test('DOM：v2.10.3 持仓调整批量保存与删除都会改当前组合（删除写墓碑）', () => {
  const prevPortfolios = app.state.portfolios;
  const prevActive = app.state.activePortfolioId;
  const prevHold = app.state.fundHoldings;
  app.state.portfolios = [{
    id: 'default', name: '主持仓', isDefault: true,
    holdings: { A1: { shares: 100, cost: 1 }, B2: { shares: 50, cost: 2 } },
  }];
  app.state.activePortfolioId = 'default';
  app.state.fundHoldings = { ...app.state.portfolios[0].holdings };

  app.savePortfolioHoldingsBatch([
    { code: 'A1', shares: 300, cost: 1.5 },
    { code: 'B2', shares: 0, cost: 0 },
    { code: 'C3', shares: 20, cost: 3 },
  ]);
  const group = app.state.portfolios.find((g) => g.id === 'default');
  assert.equal(group.holdings.A1.shares, 300, '份额要按输入更新');
  assert.equal(group.holdings.A1.cost, 1.5);
  assert.equal(group.holdings.B2.shares, 0, '填 0 = 清仓（写墓碑，不直接消失）');
  assert.ok(group.holdings.B2.updatedAt > 0, '墓碑要带时间戳，多端合并才不会把旧数据带回来');
  assert.equal(group.holdings.C3.shares, 20, '未持有的自选基金可以补录');
  assert.equal(group.holdings.A1.addedAt > 0, true, '建仓日要保留 / 自动补上');

  const prevConfirm = window.confirm;
  window.confirm = () => true;
  try {
    assert.equal(app.deleteFundHolding('A1', '基金A'), true, '确认后应该删除');
  } finally {
    window.confirm = prevConfirm;
  }
  assert.equal(group.holdings.A1.shares, 0, '删除同样写墓碑，后台据此留档');
  assert.equal(app.state.fundHoldings.A1.shares, 0, 'state.fundHoldings 要跟着当前组合');

  app.state.portfolios = prevPortfolios;
  app.state.activePortfolioId = prevActive;
  app.state.fundHoldings = prevHold;
});

test('DOM：后台「持仓数据」页展示「持仓删除历史」，带详情 / 恢复', () => {
  const adminHtml = readFileSync(join(ROOT, 'public', 'admin.html'), 'utf8');
  for (const id of ['phUser', 'phReload', 'phPending', 'phList']) {
    assert.ok(adminHtml.includes(`id="${id}"`), `后台缺少 #${id}`);
  }
  assert.match(adminHtml, /持仓删除历史/);
  assert.match(adminHtml, /只记录被删的那个 TAB/);
  const adminJs = readFileSync(join(ROOT, 'public', 'js', 'admin.js'), 'utf8');
  assert.match(adminJs, /loadDeletionHistory/);
  assert.match(adminJs, /\/api\/admin\/portfolio\/deletions/);
  assert.match(adminJs, /data-del-detail/);
  assert.match(adminJs, /data-del-restore/);
});

/* ---------------------------------------------------------
   v2.10.4：板块总览表头排序 / 连跌负数 / 场外基金对比计数
   --------------------------------------------------------- */

test('DOM：板块总览表头可排序，连跌用负数显示（v2.10.4）', () => {
  const prevThemes = app.state.fundThemes;
  const prevSort = app.state.fundThemeSort;
  const prevDir = app.state.fundThemeSortDir;
  const themes = [
    { sector: '主题A', avgDay: 2, streak: 3, day5: 1, avgMonth: 5, upCount: 2, downCount: 0, etfCount: 1, fundCount: 3, leaderEtf: { name: 'A' }, leaderStock: null },
    { sector: '主题B', avgDay: -1, streak: -2, day5: -3, avgMonth: -4, upCount: 0, downCount: 2, etfCount: 1, fundCount: 2, leaderEtf: { name: 'B' }, leaderStock: null },
    { sector: '主题C', avgDay: 0.5, streak: 0, day5: null, avgMonth: null, upCount: 1, downCount: 1, etfCount: 1, fundCount: 2, leaderEtf: { name: 'C' }, leaderStock: null },
  ];
  app.state.fundThemes = { themes, fundCount: 7, etfCount: 3, stockCount: 4, date: '2026-11-20' };
  app.state.fundThemeSort = 'day';
  app.state.fundThemeSortDir = 'desc';
  app.renderFundThemeOverview();
  const table = document.querySelector('#fundThemeTable');
  const sortables = [...table.querySelectorAll('thead th[data-fund-theme-sort]')].map((th) => th.dataset.fundThemeSort);
  assert.deepEqual(sortables, ['day', 'streak', 'day5', 'month'], '四个可排序列都要可点');
  const rowSectors = () => [...table.querySelectorAll('tbody tr')].map((tr) => tr.dataset.fundTheme);
  assert.deepEqual(rowSectors(), ['主题A', '主题C', '主题B'], '按当日涨跌降序');
  assert.match(table.textContent, /-2 天/, '连跌天数用负数显示');
  assert.match(table.textContent, /3 天/, '连涨天数显示正数');
  assert.equal(app.sortFundThemes(themes, 'streak', 'asc').map((t) => t.sector).join(','), '主题B,主题C,主题A', '升序：-2 → 0 → +3');
  assert.equal(app.sortFundThemes(themes, 'day5', 'desc').map((t) => t.sector).join(','), '主题A,主题B,主题C', '缺数据的排最后');
  const active = table.querySelector('thead th.is-sorted');
  assert.ok(active, '当前排序列要有标记');
  assert.equal(active.dataset.fundThemeSort, 'day');
  assert.match(active.textContent, /▼/, '降序箭头');

  app.state.fundThemes = prevThemes;
  app.state.fundThemeSort = prevSort;
  app.state.fundThemeSortDir = prevDir;
});

test('DOM：场外基金勾选对比后「已选」计数与按钮同步（v2.10.4）', () => {
  const prevCompare = app.state.compareFunds;
  const prevView = app.state.fundView;
  const prevBoard = app.state.fundBoard;
  const prevTab = app.state.fundBoardTab;
  app.state.compareFunds = [];
  app.state.fundView = 'openfund';
  app.state.fundBoardTab = 'gain';
  app.state.fundBoard = {
    tab: 'gain',
    items: [
      { code: '000001', name: '基金A', type: 'open', typeLabel: '混合型', nav: 1.2, day: 1.5, week: 2, month: 3, year: 4, sector: '混合均衡' },
      { code: '000002', name: '基金B', type: 'open', typeLabel: '混合型', nav: 1.1, day: 1.2, week: 1, month: 2, year: 3, sector: '混合均衡' },
    ],
    count: 2,
    date: '2026-11-20',
  };
  app.renderFundBoard();
  app.renderFundBoardCompareBar();
  const bar = document.querySelector('#fundBoardCompareBar');
  const count = document.querySelector('#fundBoardCompareCount');
  const btn = document.querySelector('#fundBoardCompareBtn');
  assert.equal(bar.hidden, false, '场外基金页要显示「已选」对比条');
  assert.equal(count.textContent, '0');
  assert.equal(btn.disabled, true, '不足 2 只时不能开始对比');

  app.toggleCompareFund('000001', '基金A', true);
  app.toggleCompareFund('000002', '基金B', true);
  assert.equal(count.textContent, '2', '勾选后计数必须跟着更新');
  assert.equal(btn.disabled, false, '选满 2 只后按钮可点');

  app.renderFundBoard();
  const checked = [...document.querySelectorAll('#fundBoardTable [data-compare-code]')].map((cb) => cb.checked);
  assert.deepEqual(checked, [true, true], '重渲染后勾选状态要保留');

  app.toggleCompareFund('000002', '基金B', false);
  assert.equal(count.textContent, '1');
  assert.equal(btn.disabled, true, '取消到不足 2 只时按钮要重新禁用');

  app.state.compareFunds = prevCompare;
  app.state.fundView = prevView;
  app.state.fundBoard = prevBoard;
  app.state.fundBoardTab = prevTab;
});


/* ---------------------------------------------------------
   v2.11.0：模拟盘最大可买 / 当日盈亏 / 已实现 / 盈亏日历 / 排行详情
   --------------------------------------------------------- */

test('DOM：v2.11.0 最大可买与服务端同口径（整手 / 最低佣金边界）', () => {
  assert.equal(app.paperMaxBuyShares({ price: 10, cash: 100000, secid: '1.600519' }), 9900);
  assert.equal(app.paperMaxBuyShares({ price: 10, cash: 1005, secid: '1.600519' }), 100);
  assert.equal(app.paperMaxBuyShares({ price: 10, cash: 1004.9, secid: '1.600519' }), 0);
  assert.equal(app.paperMaxBuyShares({ price: 3, cash: 100, secid: '105.AAPL' }), 31);
  assert.equal(app.paperMaxBuyShares({ price: 0, cash: 100000, secid: '1.600519' }), 0);
  assert.equal(app.paperMaxBuyShares({ price: 10, cash: 0, secid: '1.600519' }), 0);
  // 超量校验提示必须带「最多可买 N 股」
  const poor = app.paperValidateShares({ side: 'buy', shares: 9900, secid: '1.600519', price: 10, cash: 5000, held: 0 });
  assert.equal(poor.ok, false);
  assert.match(poor.message, /最多可买/);
});

test('DOM：v2.11.0 持仓表显示当日盈亏与已实现，KPI 显示起点 / 追加 / 本金', () => {
  const prev = app.state.paper;
  app.state.paper = {
    initial: 1000000,
    injected: 100000,
    principal: 1100000,
    cash: 900000,
    marketValue: 205000,
    costValue: 190000,
    total: 1105000,
    profit: 5000,
    profitPct: 0.45,
    positionProfit: 15000,
    realizedProfit: -10000,
    positions: [{
      secid: '1.600519', code: '600519', name: '<b>危险名</b>', shares: 100, cost: 1900,
      price: 2050, priceMode: 'live', pct: 1.2, dayPnl: 2400, marketValue: 205000,
      profit: 15000, profitPct: 7.89, realizedAmount: 189.4, realizedPct: 18.85,
    }],
    realized: [{
      secid: '1.600519', code: '600519', name: '<b>危险名</b>', sellShares: 100, sellAmount: 1200,
      costBasis: 1005, realized: 189.4, realizedPct: 18.85, holding: true, holdingShares: 100,
      unrealized: 150, totalProfit: 339.4, lastAt: 1795440000000, rounds: 1, incomplete: false,
    }],
    trades: [{
      id: 't1', ts: 1795440000000, secid: '1.600519', code: '600519', name: '贵州茅台',
      side: 'sell', price: 12, shares: 100, amount: 1200, fee: 5.6, realized: 189.4, realizedPct: 18.85,
      signal: { score: 30, rating: '防御' },
    }],
    capital: { injected: 100000, events: [{ at: 1795440000000, amount: 100000 }] },
    rules: {},
  };
  app.renderPaper();
  const panel = document.querySelector('#paperPanel');
  const kpis = panel.querySelector('.paper-kpis').textContent;
  assert.match(kpis, /起点/, '总资产副行要写起点');
  assert.match(kpis, /追加/, '总资产副行要写追加');
  assert.match(kpis, /本金/, '总资产副行要写本金');

  const posRow = panel.querySelector('.paper-pos-table tbody tr');
  assert.match(posRow.textContent, /2,400/, '当日盈亏要显示金额');
  assert.match(posRow.textContent, /189\.40/, '持仓行要显示已实现');
  assert.equal(panel.querySelectorAll('.paper-pos-table b').length, 0, '股票名里的标签必须被转义');

  const tradeRow = panel.querySelector('.paper-trade-table tbody tr');
  assert.match(tradeRow.textContent, /189\.40/, '卖出成交要显示已实现');
  assert.match(panel.textContent, /增量资金/, '有追加资金时给出说明');
  app.state.paper = prev;
});

test('DOM：v2.11.0 个股累计收益表保留已清仓标的、转义名称、给出合计', () => {
  const prev = app.state.paper;
  app.state.paper = {
    initial: 1000000, injected: 0, principal: 1000000, cash: 1000000,
    marketValue: 0, total: 1000000, profit: 0, profitPct: 0,
    positions: [], trades: [],
    realized: [
      { secid: '1.600519', code: '600519', name: '<b>坏</b>', sellShares: 100, sellAmount: 1200, costBasis: 1005, realized: 189.4, realizedPct: 18.85, holding: false, unrealized: null, totalProfit: 189.4, lastAt: 1, rounds: 1, incomplete: false },
      { secid: '0.300750', code: '300750', name: '宁德时代', sellShares: 100, sellAmount: 19000, costBasis: 20000, realized: -1000, realizedPct: -5, holding: false, unrealized: null, totalProfit: -1000, lastAt: 2, rounds: 1, incomplete: true },
    ],
  };
  app.renderPaperRealized();
  const box = document.querySelector('#paperRealizedTable');
  assert.ok(box.querySelector('.paper-realized-table'), '缺少累计收益表');
  assert.equal(box.querySelectorAll('tbody tr').length, 2, '清仓标的仍保留');
  assert.match(box.textContent, /已清仓/);
  assert.match(box.textContent, /历史不完整/);
  assert.equal(box.querySelectorAll('b').length, 0, '名称里的标签必须被转义');
  const meta = document.querySelector('#paperRealizedMeta').textContent;
  assert.match(meta, /合计已实现/);
  assert.match(meta, /未计入合计/, '历史不完整的标的要说明不计入合计');
  app.state.paper = prev;
});

test('DOM：v2.11.0 模拟盘盈亏日历 日/月/年 + 金额/收益率 + 空状态', () => {
  const prevPaper = app.state.paper;
  const prevPnl = app.state.paperPnl;
  const prevUnit = app.state.paperCalendarUnit;
  const prevMetric = app.state.paperCalendarMetric;
  const prevYm = app.state.paperCalendarYearMonth;
  const prevYear = app.state.paperCalendarYear;
  app.state.paper = {
    initial: 1000000, injected: 0, principal: 1000000, cash: 900000, marketValue: 120000,
    total: 1020000, profit: 20000, profitPct: 2, positions: [], trades: [{ id: 't1', ts: 1, side: 'buy' }],
    realized: [], capital: { injected: 0, events: [] },
  };
  app.state.paperPnl = {
    rows: [
      { d: '2026-11-19', pnl: -5, pct: -0.01, mv: 999995, base: 1000000, flow: 0 },
      { d: '2026-11-20', pnl: 100, pct: 0.01, mv: 1000095, base: 999995, flow: 0 },
      { d: '2026-11-23', pnl: 100, pct: 0.01, mv: 1000195, base: 1000095, flow: 0 },
    ],
    todayFlow: 0, days: 800, startDate: '2026-11-19', endDate: '2026-11-23',
    missing: [], estimated: false, truncated: false,
  };
  app.state.paperCalendarUnit = 'day';
  app.state.paperCalendarMetric = 'amount';
  app.state.paperCalendarYearMonth = '2026-11';
  app.state.paperCalendarYear = '2026';
  app.renderPaperPnlCalendar();
  const box = document.querySelector('#paperPnlCalendar');
  assert.ok(box.querySelector('.pnl-calendar'), '缺少日历网格');
  const heads = [...box.querySelectorAll('.pnl-calendar-head')].map((el) => el.textContent.trim()).filter(Boolean);
  assert.deepEqual(heads, ['周一', '周二', '周三', '周四', '周五'], '日视图只占周一~周五');
  assert.match(document.querySelector('#paperPnlKpis').textContent, /今日盈亏/);
  assert.match(document.querySelector('#paperPnlKpis').textContent, /累计盈亏/);
  assert.match(document.querySelector('#paperPnlCalendarMeta').textContent, /按金额/);

  app.state.paperCalendarMetric = 'rate';
  app.renderPaperPnlCalendar();
  assert.match(document.querySelector('#paperPnlCalendarMeta').textContent, /按收益率/);

  app.state.paperCalendarUnit = 'month';
  app.renderPaperPnlCalendar();
  assert.equal(box.querySelectorAll('.pnl-calendar-tile').length, 12, '月视图 12 格');

  app.state.paperCalendarUnit = 'year';
  app.renderPaperPnlCalendar();
  assert.ok(box.querySelectorAll('.pnl-calendar-tile').length >= 1, '年视图至少 1 格');

  // 没有成交 → 空状态，不请求也不显示「计算中」
  app.state.paper.trades = [];
  app.state.paperPnl = null;
  app.state.paperCalendarUnit = 'day';
  app.renderPaperPnlCalendar();
  assert.match(box.textContent, /还没有模拟成交/);

  app.state.paper = prevPaper;
  app.state.paperPnl = prevPnl;
  app.state.paperCalendarUnit = prevUnit;
  app.state.paperCalendarMetric = prevMetric;
  app.state.paperCalendarYearMonth = prevYm;
  app.state.paperCalendarYear = prevYear;
});

test('DOM：v2.11.0 排行榜每行可点开持仓详情，详情含完整持仓但不显示账号 ID', () => {
  const prevPaper = app.state.paper;
  const prevRank = app.state.paperRank;
  const prevOpen = app.state.paperRankOpen;
  app.state.paper = {
    initial: 1000000, injected: 0, principal: 1000000, cash: 1000000, marketValue: 0,
    total: 1000000, profit: 0, profitPct: 0, positions: [], trades: [], rules: {},
  };
  app.state.paperRank = {
    items: [{ username: 'detailTarget', total: 1200000, profit: 200000, profitPct: 20, positionCount: 1, positions: [{ name: '贵州茅台', code: '600519', shares: 100 }] }],
    at: Date.now(),
  };
  app.state.paperRankOpen = true;
  app.renderPaper();
  const body = document.querySelector('#paperRankBody');
  const btn = body.querySelector('[data-paper-detail]');
  assert.ok(btn, '排行榜行要有看持仓入口');
  assert.equal(btn.dataset.paperDetail, 'detailTarget');

  app.renderPaperDetail({
    username: 'detailTarget', isSelf: false,
    initial: 1000000, injected: 0, principal: 1000000, cash: 300000, marketValue: 900000,
    costValue: 800000, total: 1200000, profit: 200000, profitPct: 20,
    positionProfit: 100000, realizedProfit: 100000, positionCount: 1,
    positions: [{ secid: '1.600519', code: '600519', name: '<b>茅台</b>', shares: 100, cost: 8000, price: 9000, marketValue: 900000, profit: 100000, profitPct: 12.5, realizedAmount: 189.4, priceMode: 'live' }],
    realized: [{ secid: '1.600519', code: '600519', name: '茅台', sellShares: 100, costBasis: 1005, realized: 189.4, realizedPct: 18.85, holding: true }],
    updatedAt: Date.now(),
  });
  const overlay = document.querySelector('.overlay, .modal-overlay');
  assert.ok(overlay, '详情弹窗应打开');
  assert.match(document.body.textContent, /detailTarget 的模拟持仓/);
  assert.match(document.body.textContent, /持仓明细/);
  assert.match(document.body.textContent, /189\.40/);
  assert.ok(!document.body.textContent.includes('userId'), '不显示账号 ID');
  app.closeOverlay();

  app.state.paper = prevPaper;
  app.state.paperRank = prevRank;
  app.state.paperRankOpen = prevOpen;
});

/* =========================================================
   v2.12.0：委托 / 自动交易 / 复盘 / 排行榜周期列
   ========================================================= */

test('DOM：v2.12.0 index.html 有委托、自动交易、复盘三个新面板', () => {
  for (const id of ['#paperOrderPanel', '#paperOrderBody', '#paperOrderMeta', '#paperAutoPanel', '#paperAutoSeg', '#paperAutoBody', '#paperReviewPanel', '#paperReviewBody', '#paperReviewChart']) {
    assert.ok(document.querySelector(id), `缺少 ${id}`);
  }
});

test('DOM：v2.12.0 委托面板显示委托价 / 成交进度 / 撤单按钮，名称被转义', () => {
  const prev = app.state.paper;
  app.state.paper = {
    orders: [
      {
        id: 'o1', secid: '1.600519', code: '600519', name: '<b>坏</b>', side: 'buy', type: 'limit',
        limitPrice: 10, shares: 200, filledShares: 100, avgPrice: 10, status: 'partial',
        createdAt: Date.now(), expiresAt: Date.now() + 3600000, expiresDate: '2026-11-24',
        source: 'manual', lastCheck: { at: Date.now(), price: 10, reason: '限价 10 未触及' },
        remainingShares: 100, progressPct: 50, canCancel: true, active: true,
      },
      { id: 'o2', secid: '0.000001', code: '000001', name: '平安银行', side: 'sell', type: 'market', shares: 100, filledShares: 100, avgPrice: 11, status: 'filled', createdAt: Date.now(), canCancel: false, active: false },
    ],
  };
  app.renderPaperOrders();
  const box = document.querySelector('#paperOrderBody');
  assert.ok(box.querySelector('.paper-order-table'), '缺少委托表');
  assert.equal(box.querySelectorAll('tbody tr').length, 2);
  assert.match(box.textContent, /限价 10\.000/);
  assert.match(box.textContent, /部分成交/);
  assert.match(box.textContent, /已成交/);
  assert.equal(box.querySelectorAll('[data-paper-cancel-order]').length, 1, '只有未结委托能撤单');
  assert.equal(box.querySelectorAll('b').length, 0, '标的名称必须被转义');
  const meta = document.querySelector('#paperOrderMeta').textContent;
  assert.match(meta, /1 笔未结/);
  app.state.paper = prev;
});

test('DOM：v2.12.0 自动交易四个 TAB 都能渲染（条件单 / 网格定投 / 跟单 / 持仓预警）', () => {
  const prevPaper = app.state.paper;
  const prevTab = app.state.paperAutoTab;
  const prevSort = app.state.paperRankSort;
  const paper = {
    initial: 1000000, cash: 900000, total: 1000000, positions: [{ secid: '1.600519', code: '600519', name: '贵州茅台', shares: 100, available: 0, locked: 100 }],
    conditions: [{ id: 'c1', secid: '1.600519', code: '600519', name: '贵州茅台', kind: 'stopLoss', value: 5, side: 'sell', shares: 0, status: 'active', lastError: '' }],
    plans: [{ id: 'p1', kind: 'grid', secid: '1.600519', code: '600519', name: '贵州茅台', lower: 1000, upper: 2000, grids: 5, sharesPerGrid: 100, gridIndex: 2, status: 'active', runs: 3, levels: [1000, 1200, 1400, 1600, 1800, 2000] }],
    following: [{ target: 'detailTarget', ratio: 0.5, maxShares: 200 }],
    followers: [{ target: 'someone', ratio: 0.3 }],
    allowFollow: true,
    alerts: { enabled: true, items: [{ id: 'pa1', secid: '1.600519', code: '600519', name: '贵州茅台', kind: 'holdingPct', op: 'above', value: 8, active: true }] },
    rules: { fees: { rate: 0.00025, min: 5, taxRate: 0.0005, slippageBps: 0 }, trading: { t1: true, limitCheck: true, suspend: true }, order: { validDays: 1 } },
  };
  app.state.paper = paper;

  app.state.paperAutoTab = 'condition';
  app.renderPaperAuto();
  let box = document.querySelector('#paperAutoBody');
  assert.match(box.textContent, /浮亏 ≥ 5\.00%/);
  assert.ok(box.querySelector('[data-paper-cancel-cond]'), '监控中的条件单要能取消');
  assert.ok(box.querySelector('#paperCondForm'), '缺少条件单表单');

  app.state.paperAutoTab = 'plan';
  app.renderPaperAuto();
  box = document.querySelector('#paperAutoBody');
  assert.match(box.textContent, /1,000\.00 ~ 2,000\.00/);
  assert.match(box.textContent, /当前第 3 段/);
  assert.ok(box.querySelector('[data-paper-plan-status]'), '计划要能暂停');
  assert.ok(box.querySelector('#paperGridForm') && box.querySelector('#paperDcaForm'));

  app.state.paperAutoTab = 'follow';
  app.renderPaperAuto();
  box = document.querySelector('#paperAutoBody');
  assert.match(box.textContent, /跟单 detailTarget/);
  assert.match(box.textContent, /50%/);
  assert.ok(box.querySelector('[data-paper-unfollow]'));
  assert.ok(box.querySelector('#paperAllowFollow'));

  app.state.paperAutoTab = 'alert';
  app.renderPaperAuto();
  box = document.querySelector('#paperAutoBody');
  assert.match(box.textContent, /持仓收益率 高于 8\.00%/);
  assert.ok(box.querySelector('#paperAlertEnabled'));

  app.state.paper = prevPaper;
  app.state.paperAutoTab = prevTab;
  app.state.paperRankSort = prevSort;
});

test('DOM：v2.12.0 复盘面板显示胜率 / 盈亏比 / 回撤 / 集中度，空态给引导', () => {
  const prevReview = app.state.paperReview;
  const prevPaper = app.state.paper;
  app.state.paper = { trades: [{ id: 't1' }], total: 1010000, profit: 10000, profitPct: 1 };
  app.state.paperReview = {
    trades: 4, buys: 2, sells: 2, winCount: 1, lossCount: 1, winRate: 50, avgWin: 195, avgLoss: -105,
    payoffRatio: 1.86, profitFactor: 1.86, realizedTotal: 90, avgHoldDays: 2.5,
    mdd: 10, mddFrom: '2026-11-03', mddTo: '2026-11-04', topWeight: 39.8, topName: '<b>茅台</b>', hhi: 0.5,
    totalPct: 3, todayPct: 0.98, weekPct: 3, monthPct: 3, yearPct: 3, equityDays: 4,
    bestTrade: { name: '茅台', realized: 195, at: 1 }, worstTrade: { name: '平安', realized: -105, at: 2 },
    curve: [{ d: '2026-11-03', v: 100000 }, { d: '2026-11-04', v: 101000 }],
  };
  app.renderPaperReview();
  const box = document.querySelector('#paperReviewBody');
  assert.match(box.textContent, /胜率/);
  assert.match(box.textContent, /50\.0%/);
  assert.match(box.textContent, /盈亏比/);
  assert.match(box.textContent, /最大回撤/);
  assert.match(box.textContent, /-10\.00%/);
  assert.match(box.textContent, /集中度/);
  assert.match(box.textContent, /39\.8%/);
  assert.equal(box.querySelectorAll('b').length, 0, '集中度里的名称也要转义');
  const meta = document.querySelector('#paperReviewMeta').textContent;
  assert.match(meta, /权益快照 4 天/);

  // 空态：没有成交时给引导，不是空白
  app.state.paper = { trades: [] };
  app.state.paperReview = { trades: 0, curve: [] };
  app.renderPaperReview();
  assert.match(document.querySelector('#paperReviewBody').textContent, /还没有成交/);

  app.state.paperReview = prevReview;
  app.state.paper = prevPaper;
});

test('DOM：v2.12.0 排行榜带今日/本周/本月/今年/回撤列，可按回撤排序', () => {
  const prevRank = app.state.paperRank;
  const prevOpen = app.state.paperRankOpen;
  const prevSort = app.state.paperRankSort;
  app.state.paperRankOpen = true;
  app.state.paperRank = {
    ok: true,
    items: [
      { username: 'AAA', total: 1100000, profit: 100000, profitPct: 10, todayPct: 1.2, weekPct: 2.3, monthPct: 3.4, yearPct: 4.5, mdd: 8.1, equityDays: 30, positionCount: 0, positions: [], updatedAt: 1 },
      { username: 'BBB', total: 1050000, profit: 50000, profitPct: 5, todayPct: -0.5, weekPct: null, monthPct: null, yearPct: null, mdd: 2.4, equityDays: 2, positionCount: 0, positions: [], updatedAt: 2 },
    ],
    estimated: false,
    truncated: false,
    updatedAt: Date.now(),
  };
  app.state.paperRankSort = 'mdd';
  app.renderPaperRanking();
  const head = document.querySelector('#paperRankBody thead').textContent;
  for (const label of ['今日', '本周', '本月', '今年', '回撤']) {
    assert.match(head, new RegExp(label), `表头缺少 ${label}`);
  }
  const firstRow = document.querySelector('#paperRankBody tbody tr');
  assert.match(firstRow.textContent, /BBB/, '按回撤从小到大排序，回撤小的在前');
  assert.match(document.querySelector('#paperRankBody thead').textContent, /累计收益率/);

  app.state.paperRank = prevRank;
  app.state.paperRankOpen = prevOpen;
  app.state.paperRankSort = prevSort;
});
/* ---------------------------------------------------------
   v2.14.0：模拟交易功能优化（买入入口 / 持仓图表 / 成交折叠 / 手机排行 / 说明图标）
   --------------------------------------------------------- */

function paperFixture(tradeCount = 1) {
  const base = Date.now();
  return {
    initial: 1000000, cash: 800000, marketValue: 160000, total: 1010000,
    profit: 10000, profitPct: 1,
    rules: { fees: { rate: 0.00025, min: 5, taxRate: 0.0005, slippageBps: 0 }, trading: { t1: true, limitCheck: true, suspend: true } },
    positions: [{
      secid: '1.600519', code: '600519', name: '贵州茅台', shares: 100, available: 100,
      cost: 1500, price: 1600, pct: 1.2, marketValue: 160000, profit: 10000, profitPct: 6.25,
      realizedAmount: null, realizedPct: null,
    }],
    trades: Array.from({ length: tradeCount }, (_, i) => ({
      id: `t${i}`, ts: base - i * 60000, secid: '1.600519', code: '600519', name: '贵州茅台',
      side: i % 2 ? 'sell' : 'buy', price: 1500 + i, shares: 100, amount: 150000, fee: 37.5,
      realized: i % 2 ? 250 : null, realizedPct: i % 2 ? 1.2 : null, note: '',
      signal: { score: 62, rating: '偏强' },
    })),
    updatedAt: base,
  };
}

test('DOM：v2.14.0 持仓行有买入按钮、点击股票名打开详情，且不再有客户端重置入口', () => {
  const prev = app.state.paper;
  app.state.paper = paperFixture(2);
  app.renderPaper();
  const box = document.querySelector('#paperPanel');
  assert.equal(box.querySelector('#paperResetBtn'), null, '客户端不应再有「重置账户」按钮');
  assert.doesNotMatch(box.textContent, /重置账户/, '文案里也不应出现重置入口');
  assert.ok(box.querySelector('[data-paper-buy]'), '卖出旁边要有买入按钮');
  assert.equal(box.querySelector('[data-paper-buy]').textContent.trim(), '买入');
  assert.ok(box.querySelector('[data-paper-open]'), '点击持仓个股应能打开图表详情');
  assert.ok(box.querySelectorAll('.hint-tip').length >= 2, '说明文字应收进 ? 图标');
  app.state.paper = prev;
});

test('DOM：v2.14.0 最近成交默认只显示最新 5 条，可展开 / 收起', () => {
  const prev = app.state.paper;
  const prevOpen = app.state.paperTradesOpen;
  app.state.paperTradesOpen = false;
  app.state.paper = paperFixture(8);
  app.renderPaper();
  let box = document.querySelector('#paperPanel');
  assert.equal(box.querySelectorAll('.paper-trade-table tbody tr').length, 5, '默认 5 条');
  const toggle = box.querySelector('#paperTradesToggle');
  assert.ok(toggle, '超过 5 条时要给展开按钮');
  assert.match(toggle.textContent, /展开全部 8 条/);
  toggle.click();
  box = document.querySelector('#paperPanel');
  assert.equal(box.querySelectorAll('.paper-trade-table tbody tr').length, 8, '展开后显示全部');
  assert.match(box.querySelector('#paperTradesToggle').textContent, /收起/);
  box.querySelector('#paperTradesToggle').click();
  assert.equal(document.querySelectorAll('#paperPanel .paper-trade-table tbody tr').length, 5, '再点收回 5 条');
  app.state.paper = prev;
  app.state.paperTradesOpen = prevOpen;
});

test('DOM：v2.14.0 持仓个股详情有四周期 tab、买卖按钮和图表容器', () => {
  const prev = app.state.paper;
  app.state.paper = paperFixture(3);
  app.state.paperHoldingTab = 'minute';
  app.openPaperHolding('1.600519', '贵州茅台', '600519');
  const modal = document.querySelector('.paper-holding-modal');
  assert.ok(modal, '应打开持仓详情弹窗');
  assert.match(modal.textContent, /贵州茅台/);
  const tabs = [...modal.querySelectorAll('[data-paper-holding-tab]')].map((b) => b.textContent.trim());
  assert.deepEqual(tabs, ['分时', '五日', '日K', '月K']);
  assert.ok(modal.querySelector('#paperHoldingBuy'), '分时页可直接买入');
  assert.ok(modal.querySelector('#paperHoldingSell'), '分时页可直接卖出');
  assert.ok(modal.querySelector('#paperHoldingChart'), '要有图表容器');
  assert.ok(modal.querySelector('#paperHoldingKpis'), '要有持仓成本 / 浮盈信息');
  app.closeOverlay();
  app.state.paper = prev;
});

test('v2.14.0 历史买卖点能映射到分时 / 五日 / 日K / 月K 的 X 轴', () => {
  const prev = app.state.paper;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const ts = Date.parse(`${today}T10:31:00+08:00`);
  app.state.paper = { trades: [
    { ts, secid: '1.600519', side: 'buy', price: 1500 },
    { ts: Date.parse('2026-11-20T14:05:00+08:00'), secid: '1.600519', side: 'sell', price: 1580 },
  ] };

  // 分时：只标今日，取 HH:MM
  const minute = app.paperHoldingMarks('1.600519', 'minute', [{ d: `${today} 10:31` }]);
  assert.deepEqual(minute, [{ at: '10:31', price: 1500, side: 'buy' }]);

  // 后面的周期用例只留 11-20 那笔卖出，避免今天的买入落到最后一根 K 线上
  app.state.paper = { trades: [{ ts: Date.parse('2026-11-20T14:05:00+08:00'), secid: '1.600519', side: 'sell', price: 1580 }] };

  // 五日：取该分钟之后（含）的第一根 5 分钟线
  const five = app.paperHoldingMarks('1.600519', 'five', [
    { d: '2026-11-20 14:00' }, { d: '2026-11-20 14:05' },
  ]);
  assert.equal(five.length, 1);
  assert.equal(five[0].at, '2026-11-20 14:05');
  assert.equal(five[0].side, 'sell');

  // 日K：命中同一天的日线
  const day = app.paperHoldingMarks('1.600519', 'day', [{ d: '2026-11-20' }, { d: '2026-11-21' }]);
  assert.equal(day[0].at, '2026-11-20');

  // 月K：命中同月的月线
  const month = app.paperHoldingMarks('1.600519', 'month', [{ d: '2026-10-01' }, { d: '2026-11-01' }]);
  assert.equal(month[0].at, '2026-11-01');
  app.state.paper = prev;
});

test('DOM：v2.14.0 手机排行榜在用户名下带今日/本周/本月/今年收益标签', () => {
  const prevRank = app.state.paperRank;
  const prevOpen = app.state.paperRankOpen;
  const prevSort = app.state.paperRankSort;
  app.state.paperRankOpen = true;
  app.state.paperRank = { items: [{
    username: 'AAA', total: 1100000, profit: 100000, profitPct: 10,
    todayPct: 1.2, weekPct: 2.3, monthPct: 3.4, yearPct: 4.5, mdd: 8.1,
    equityDays: 30, positionCount: 0, positions: [], updatedAt: 1,
  }], updatedAt: Date.now() };
  app.state.paperRankSort = 'total';
  app.renderPaperRanking();
  const chips = document.querySelector('#paperRankBody .paper-rank-periods');
  assert.ok(chips, '手机端用户名下要有周期收益标签');
  assert.match(chips.textContent, /今日/);
  assert.match(chips.textContent, /本周/);
  assert.match(chips.textContent, /本月/);
  assert.match(chips.textContent, /今年/);
  assert.match(chips.textContent, /1\.20%/);
  app.state.paperRank = prevRank;
  app.state.paperRankOpen = prevOpen;
  app.state.paperRankSort = prevSort;
});

test('DOM：v2.14.0 模拟买入弹窗直接列出自选股（超过 6 只也能选）', () => {
  const prevPaper = app.state.paper;
  const prevWatch = app.state.watchlist;
  app.state.paper = paperFixture(1);
  app.state.watchlist = Array.from({ length: 8 }, (_, i) => ({ secid: `1.60000${i}`, code: `60000${i}`, name: `股票${i}` }));
  app.openPaperTrade('buy');
  const form = document.querySelector('#paperForm');
  assert.ok(form, '应打开买入弹窗');
  assert.equal(form.querySelectorAll('[data-paper-pick]').length, 8, '自选股应全部列出');
  assert.match(form.textContent, /从自选股选择（8 只/);
  app.closeOverlay();
  app.state.paper = prevPaper;
  app.state.watchlist = prevWatch;
});
