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
