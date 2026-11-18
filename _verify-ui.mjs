/**
 * v2.7.0 交互验收（临时脚本，验完删除）
 * 隔离实例（临时目录 + 随机端口）+ Edge 无头 + CDP：
 *   1) 个股详情 → 基本面/龙虎榜 → 关闭后个股详情仍在
 *   2) 个股详情 → 个股资讯 → 关闭后个股详情仍在
 *   3) 个股详情 → 查看大盘策略 → 个股详情仍在，策略在新标签页
 *   4) 自选页：模拟交易面板在我的自选之前；自选股是表格式列表（桌面 + 手机）
 *   5) 数据中心 → 财经日历 → 新股申购 / 转债申购
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './test/helpers/app.mjs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9351;
const OUT = path.resolve('docs/screenshots/v2.7.0');
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return {
    ws,
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
let edge = null;
let client = null;
const results = [];

try {
  const reg = await fetch(`${app.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'uishot', password: 'uishot-pass-1' }),
  });
  if (!reg.ok) throw new Error(`注册失败 ${reg.status} ${await reg.text()}`);
  const raw = reg.headers.getSetCookie().find((c) => c.startsWith('gp_sid=')) || '';
  const token = raw.split(';')[0].split('=')[1];
  if (!token) throw new Error('没有拿到 gp_sid');
  const host = new URL(app.base).hostname;
  console.log('instance', app.base);

  const profile = path.join(OUT, 'edge-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 80; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      break;
    } catch { await wait(300); }
  }
  if (!version) throw new Error('Edge 调试端口没有启动');
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Network.enable');
  await client.send('Runtime.enable');
  await client.send('Network.setCookie', {
    name: 'gp_sid', value: token, domain: host, path: '/', httpOnly: true, sameSite: 'Lax',
  });

  const evalJs = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate 失败：${JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails)}`);
    return r.result.value;
  };
  const shot = async (name) => {
    const s = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    console.log('saved', name);
  };
  const viewport = async (width, height, mobile) => {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: mobile ? 2 : 1, mobile, screenWidth: width, screenHeight: height,
    });
  };
  const goto = async (hash) => {
    await client.send('Page.navigate', { url: `${app.base}/?t=${Date.now()}${hash}` });
    await wait(4200);
  };
  const check = (label, ok, detail = '') => {
    results.push({ label, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  /* ---------- 桌面 1440：个股详情叠层 ---------- */
  await viewport(1440, 900, false);
  await goto('#/stock/1.600519');
  const baseReady = await evalJs("!!document.querySelector('#overlayRoot .overlay .modal-stock')");
  check('个股详情打开', baseReady);
  await shot('01-stock-detail');

  // 1) 基本面 / 龙虎榜
  await evalJs("document.querySelector('[data-f10-open]').click()");
  await wait(6000);
  let st = await evalJs(`(() => {
    const layers = document.querySelectorAll('#overlayRoot .overlay-layer');
    return {
      layers: layers.length,
      base: !!document.querySelector('#overlayRoot .overlay .modal-stock'),
      drawer: !!document.querySelector('#overlayRoot .overlay-layer .drawer'),
      tabs: layers.length ? layers[0].querySelectorAll('#f10Tabs button').length : 0,
    };
  })()`);
  check('F10 以叠层打开且个股详情仍在', st.layers === 1 && st.base && st.drawer, JSON.stringify(st));
  await shot('02-f10-over-stock');

  // 切到第 5 个页签（个股龙虎榜 + 机构与席位明细）
  await evalJs("Array.from(document.querySelectorAll('#overlayRoot .overlay-layer #f10Tabs button')).pop().click()");
  await wait(1200);
  const seatInfo = await evalJs(`(() => {
    const layer = document.querySelector('#overlayRoot .overlay-layer');
    const panes = layer.querySelectorAll('[data-f10-pane]');
    const last = panes[panes.length - 1];
    return {
      visible: last.hidden === false,
      seats: layer.querySelectorAll('.seat-table').length,
      text: last.textContent.replace(/\\s+/g, ' ').slice(0, 160),
    };
  })()`);
  check('个股龙虎榜页签含机构席位明细', seatInfo.visible && seatInfo.seats > 0, JSON.stringify(seatInfo));
  await shot('03-f10-seats');

  await evalJs("document.querySelector('#overlayRoot .overlay-layer .modal-close').click()");
  await wait(900);
  st = await evalJs(`(() => ({
    layers: document.querySelectorAll('#overlayRoot .overlay-layer').length,
    base: !!document.querySelector('#overlayRoot .overlay .modal-stock'),
    hash: location.hash,
  }))()`);
  check('关闭 F10 后回到个股详情', st.layers === 0 && st.base, JSON.stringify(st));
  await shot('04-back-to-stock');

  // 2) 个股资讯
  await evalJs("document.querySelector('[data-news-open]').click()");
  await wait(5000);
  st = await evalJs(`(() => ({
    layers: document.querySelectorAll('#overlayRoot .overlay-layer').length,
    base: !!document.querySelector('#overlayRoot .overlay .modal-stock'),
    drawer: !!document.querySelector('#overlayRoot .overlay-layer .drawer'),
    news: document.querySelectorAll('#overlayRoot .overlay-layer .news-item').length,
  }))()`);
  check('个股资讯以叠层打开且个股详情仍在', st.layers === 1 && st.base && st.drawer, JSON.stringify(st));
  await shot('05-news-over-stock');
  await evalJs("document.querySelector('#overlayRoot .overlay-layer .modal-close').click()");
  await wait(800);
  st = await evalJs(`(() => ({
    layers: document.querySelectorAll('#overlayRoot .overlay-layer').length,
    base: !!document.querySelector('#overlayRoot .overlay .modal-stock'),
  }))()`);
  check('关闭资讯后回到个股详情', st.layers === 0 && st.base, JSON.stringify(st));

  // 3) 查看大盘策略（新标签页，本页个股详情不动）
  // 注意：window.open 需要真实用户手势，programmatic click() 不算，
  // 所以这里用 CDP 发真实鼠标事件（否则会走「弹窗被拦截」的兜底分支）。
  const before = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).length;
  const pt = await evalJs("(() => { const b = document.querySelector('[data-strategy-new]'); b.scrollIntoView({block:'center'}); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  await wait(400);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await wait(3500);
  const after = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json());
  st = await evalJs(`(() => ({
    layers: document.querySelectorAll('#overlayRoot .overlay-layer').length,
    base: !!document.querySelector('#overlayRoot .overlay .modal-stock'),
    hash: location.hash,
  }))()`);
  const newTab = after.some((t) => String(t.url).includes('#strategy'));
  check('查看大盘策略：个股详情保留 + 新标签页打开策略', st.base && st.layers === 0 && newTab && after.length > before, JSON.stringify({ st, newTab, tabs: after.length, before }));
  await shot('06-strategy-newtab');

  /* ---------- 自选页：面板顺序 + 表格式列表 ---------- */
  await goto('#watchlist');
  await evalJs("Array.from(document.querySelectorAll('[data-demo-watch]')).slice(0, 4).forEach((b) => b.click())");
  await wait(6000);
  const watchInfo = await evalJs(`(() => {
    const panels = Array.from(document.querySelectorAll('#view-watchlist > article.panel'));
    const table = document.querySelector('#watchTable table.fund-watch-table.watch-stock-table');
    const fundTable = document.querySelector('#watchFundList table.fund-watch-table');
    const paper = document.querySelector('#paperPanel');
    return {
      order: panels.map((p) => p.id || (p.querySelector('h3') || {}).textContent || '?'),
      paperFirst: panels[0] === paper,
      rows: table ? table.querySelectorAll('tbody tr').length : 0,
      sameClass: !!table && !!fundTable,
      actions: table ? table.querySelector('[data-watch-action]') ? Array.from(table.querySelector('tbody tr:first-child').querySelectorAll('[data-watch-action]')).map((b) => b.dataset.watchAction) : [] : [],
      head: table ? Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim()) : [],
    };
  })()`);
  check('自选页：模拟交易面板排在「我的自选」之前', watchInfo.paperFirst, JSON.stringify(watchInfo.order));
  check('自选股是表格式列表（与自选基金同款类名）', watchInfo.rows > 0 && watchInfo.sameClass, JSON.stringify(watchInfo));
  await shot('07-watchlist-table');
  // 只截「我的自选 / 我的自选基金」两块面板（整页太长，单独给证据）
  const clipOf = async (selector, name) => {
    const box = await evalJs(`(() => {
      const el = ${selector};
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x + window.scrollX), y: Math.max(0, r.y + window.scrollY), width: r.width, height: Math.min(r.height, 1600) };
    })()`);
    if (box.width < 10 || box.height < 10) return;
    const s = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, scale: 1 } });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64'));
    console.log('saved', name);
  };
  await clipOf("document.querySelector('#watchTable').closest('article.panel')", '07b-watch-panel');
  await clipOf("document.querySelector('#watchFundList').closest('article.panel')", '07c-fund-watch-panel');

  /* ---------- 手机 390 下的自选表 ---------- */
  await viewport(390, 844, true);
  await wait(800);
  await clipOf("document.querySelector('#watchTable').closest('article.panel')", '08-watchlist-mobile');
  const mobileInfo = await evalJs(`(() => {
    const t = document.querySelector('#watchTable table');
    const visible = Array.from(t.querySelectorAll('thead th')).filter((th) => th.offsetParent !== null).map((th) => th.textContent.trim());
    const btns = Array.from(t.querySelectorAll('tbody tr:first-child [data-watch-action]')).filter((b) => b.offsetParent !== null).map((b) => b.dataset.watchAction);
    return { visible, btns, overflow: t.scrollWidth - t.clientWidth };
  })()`);
  check('手机端自选表列精简且不横向溢出', mobileInfo.overflow <= 1, JSON.stringify(mobileInfo));

  /* ---------- 数据中心：新股 / 转债申购日历 ---------- */
  await viewport(1440, 900, false);
  await goto('#data');
  await evalJs("document.querySelector('[data-data-tab=\"calendar\"]').click()");
  await wait(1500);
  await evalJs("document.querySelector('[data-cal-type=\"ipo\"]').click()");
  await wait(7000);
  let cal = await evalJs(`(() => {
    const t = document.querySelector('#calendarTable');
    return { cls: t.className, rows: t.querySelectorAll('tbody tr').length, text: t.textContent.replace(/\\s+/g, ' ').slice(0, 220) };
  })()`);
  check('新股申购日历有数据', cal.cls.includes('calendar-ipo') && cal.rows > 0, JSON.stringify(cal));
  await shot('09-calendar-ipo');

  await evalJs("document.querySelector('[data-cal-type=\"cbapply\"]').click()");
  await wait(7000);
  cal = await evalJs(`(() => {
    const t = document.querySelector('#calendarTable');
    return { cls: t.className, rows: t.querySelectorAll('tbody tr').length, text: t.textContent.replace(/\\s+/g, ' ').slice(0, 220) };
  })()`);
  check('转债申购日历有数据', cal.cls.includes('calendar-cbapply') && cal.rows > 0, JSON.stringify(cal));
  await shot('10-calendar-cbapply');

  await viewport(390, 844, true);
  await wait(1000);
  await shot('11-calendar-ipo-mobile');
  const mobileCal = await evalJs(`(() => {
    const t = document.querySelector('#calendarTable');
    const visible = Array.from(t.querySelectorAll('thead th')).filter((th) => th.offsetParent !== null).map((th) => th.textContent.trim());
    return { visible, overflow: t.scrollWidth - t.clientWidth };
  })()`);
  check('手机端申购日历列精简且不横向溢出', mobileCal.overflow <= 1, JSON.stringify(mobileCal));

  /* ---------- 汇总 ---------- */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(' -', f.label, f.detail);
    process.exitCode = 2;
  }
} finally {
  try { client && client.ws.close(); } catch { /* ignore */ }
  try { edge && edge.kill(); } catch { /* ignore */ }
  await app.stop();
}
