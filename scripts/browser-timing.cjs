const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 19224;
const profile = path.join(os.tmpdir(), 'edge-gp-mobile-profile3'); fs.rmSync(profile, { recursive: true, force: true });
const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  let target = null;
  for (let i = 0; i < 60; i += 1) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = list.find((t) => t.type === 'page'); if (target) break; } catch {} await sleep(200); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result ? r.result.value : undefined; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:18090/login.html' }); await sleep(1500);
  await evaluate(`document.getElementById('username').value='mobiletest';document.getElementById('password').value='mobile12345';document.getElementById('authForm').requestSubmit();`); await sleep(2500);
  const urls = [
    '/api/kline?secid=0.300308&klt=103&limit=120&fqt=1',
    '/api/kline?secid=0.300308&klt=5&limit=260&fqt=1',
    '/api/kline?secid=0.300308&klt=101&limit=180&fqt=1',
    '/api/intraday?secid=0.300308&date=2026-11-28',
    '/api/intraday?secid=0.300308&date=2026-11-27',
  ];
  for (const u of urls) {
    const out = await evaluate(`(async()=>{const t=performance.now();try{const r=await fetch(${JSON.stringify(u)});const j=await r.json();return {ms:Math.round(performance.now()-t),status:r.status,n:(j.candles||[]).length,err:j.error||''};}catch(e){return {ms:Math.round(performance.now()-t),status:'ERR',err:String(e)};}})()`);
    console.log(u, out);
  }
  ws.close(); child.kill();
}
main().catch((e) => { console.error(e); try { child.kill(); } catch {}; process.exit(1); });
