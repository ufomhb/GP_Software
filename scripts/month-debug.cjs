const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 19225;
const profile = path.join(os.tmpdir(), 'edge-gp-mobile-profile4'); fs.rmSync(profile, { recursive: true, force: true });
const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  let target = null;
  for (let i = 0; i < 60; i += 1) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = list.find((t) => t.type === 'page'); if (target) break; } catch {} await sleep(200); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails)); else if (m.method === 'Runtime.consoleAPICalled') errors.push(m.params.type + ':' + m.params.args.map((a) => a.value || a.description || '').join(' ')); };
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { EX: r.exceptionDetails.text }; return r.result ? r.result.value : undefined; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:18090/login.html' }); await sleep(1500);
  await evaluate(`document.getElementById('username').value='mobiletest';document.getElementById('password').value='mobile12345';document.getElementById('authForm').requestSubmit();`); await sleep(2500);
  await evaluate(`location.hash='#paper'`); await sleep(5000);
  await evaluate(`document.querySelector('[data-paper-open]').click()`); await sleep(3000);
  console.log('minute html starts', String(await evaluate(`document.querySelector('#paperHoldingChart').innerHTML.slice(0,80)`)));
  await evaluate(`document.querySelector('[data-paper-holding-tab="month"]').click()`); await sleep(3000);
  console.log('month after 3s', await evaluate(`({text:document.querySelector('#paperHoldingChart').textContent.slice(0,40), canvas:document.querySelectorAll('#paperHoldingChart canvas').length, tab:document.querySelector('#paperHoldingSeg .is-active').textContent})`));
  console.log('resources', await evaluate(`performance.getEntriesByType('resource').filter(x=>x.name.includes('/api/kline')).map(x=>({n:x.name.split('?')[1],ms:Math.round(x.duration),size:x.transferSize}))`));
  console.log('errors', errors);
  ws.close(); child.kill();
}
main().catch((e) => { console.error(e); try { child.kill(); } catch {}; process.exit(1); });
