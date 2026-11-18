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
test('DOM：自选股 5 个操作按钮图标与动作一一对应', () => {
  app.state.watchlist = [{ secid: '1.600519', code: '600519', name: '贵州茅台' }];
  app.state.watchData = {
    items: [{ quote: { secid: '1.600519', code: '600519', name: '贵州茅台', price: 1500, pct: 1.1, mainYi: 2 }, advice: null }],
  };
  app.renderWatchTable();
  const btns = [...document.querySelectorAll('#watchTable .watch-actions button')];
  assert.equal(btns.length, 5, '每行应有 5 个操作按钮');
  // 曾经出现「两个 K、两个 ×」的图标错乱，这里锁死图标顺序
  assert.deepEqual(btns.map((b) => b.textContent.trim()), ['↑', '↓', 'K', '警', '×']);
  assert.deepEqual(btns.map((b) => b.getAttribute('data-watch-action')), ['up', 'down', 'chart', 'alert', 'remove']);
  // 「移出自选」按钮的 title 曾因缺一个引号被吃掉，导致按钮点击无效
  assert.equal(btns[4].getAttribute('title'), '移出自选');
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
test('DOM：沪深300基金占比已迁入基金页，A 股页不再有该模块', () => {
  assert.ok(document.querySelector('#fundSectorView #csi300RatioPanel'), '基金页板块资金子页应有该面板');
  assert.equal(document.querySelector('#view-china #csi300RatioPanel'), null, 'A 股页不应再保留该面板');
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
