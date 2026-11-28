const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 19222;
const OUT = path.join(process.cwd(), 'docs', 'screenshots', 'v2.14.0-mobile');
fs.mkdirSync(OUT, { recursive: true });
const profile = path.join(os.tmpdir(), 'edge-gp-mobile-profile');
fs.rmSync(profile, { recursive: true, force: true });
const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  return res.json();
}
async function main() {
  let target = null;
  for (let i = 0; i < 50; i += 1) {
    try {
      const list = await json('/json/list');
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {}
    await sleep(200);
  }
  if (!target) throw new Error('no CDP target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push((msg.params.exceptionDetails && msg.params.exceptionDetails.text) || 'exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('shot', name);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: 'http://127.0.0.1:18090/login.html' });
  await sleep(1800);
  await evaluate(`document.getElementById('username').value='mobiletest';document.getElementById('password').value='mobile12345';document.getElementById('remember').checked=true;document.getElementById('authForm').requestSubmit();`);
  await sleep(3200);
  console.log('after login', await evaluate('location.href'));
  await evaluate(`location.hash='#paper'`);
  await sleep(6000);
  await evaluate(`document.querySelector('#view-paper').scrollIntoView({block:'start'})`);
  await sleep(600);
  console.log('paper overflow', await evaluate(`({sw:document.documentElement.scrollWidth,iw:innerWidth,body:document.body.scrollWidth})`));
  await shot('01-paper-panel');
  // 持仓行是否有买入按钮、成交折叠
  console.log('pos buy buttons', await evaluate(`document.querySelectorAll('[data-paper-buy]').length`));
  console.log('trade rows', await evaluate(`document.querySelectorAll('.paper-trade-table tbody tr').length`));
  console.log('trades toggle', await evaluate(`(document.querySelector('#paperTradesToggle')||{}).textContent||''`));
  // 打开持仓详情
  await evaluate(`document.querySelector('[data-paper-open]').click()`);
  await sleep(3500);
  await shot('02-holding-minute');
  console.log('detail overflow', await evaluate(`({sw:document.documentElement.scrollWidth,iw:innerWidth,modal:!!document.querySelector('.paper-holding-modal')})`));
  // 切日K
  await evaluate(`document.querySelector('[data-paper-holding-tab="day"]').click()`);
  await sleep(3000);
  await shot('03-holding-day');
  // 月K
  await evaluate(`document.querySelector('[data-paper-holding-tab="month"]').click()`);
  await sleep(2500);
  await shot('04-holding-month');
  // 关闭详情
  await evaluate(`document.querySelector('.paper-holding-modal [data-close]').click()`);
  await sleep(500);
  // 展开成交
  await evaluate(`document.querySelector('#paperTradesToggle') && document.querySelector('#paperTradesToggle').click()`);
  await sleep(500);
  console.log('trade rows expanded', await evaluate(`document.querySelectorAll('.paper-trade-table tbody tr').length`));
  await evaluate(`document.querySelector('.paper-trade-head').scrollIntoView({block:'center'})`);
  await sleep(300);
  await shot('05-trades-expanded');
  // 排行榜展开
  await evaluate(`document.querySelector('#paperRankToggle').click()`);
  await sleep(3500);
  await evaluate(`document.querySelector('#paperRankBody').scrollIntoView({block:'start'})`);
  await sleep(400);
  await shot('06-ranking');
  console.log('rank period chips', await evaluate(`[...document.querySelectorAll('#paperRankBody .paper-rank-periods')].length + ' / ' + (document.querySelector('#paperRankBody .paper-rank-periods')||{}).textContent`));
  console.log('rank overflow', await evaluate(`({sw:document.documentElement.scrollWidth,iw:innerWidth})`));
  console.log('console errors', errors);
  ws.close();
  child.kill();
}
main().catch((err) => { console.error(err); try { child.kill(); } catch {}; process.exit(1); });
