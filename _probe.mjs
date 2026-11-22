const token = 'deadbeef'.repeat(8);
const base = 'http://127.0.0.1:8090';
const hdrs = { cookie: `gp_sid=${token}` };
const getJson = async (p) => (await fetch(base + p, { headers: hdrs })).json();
const pf = await getJson('/api/portfolio');
const pnl = await getJson('/api/funds/pnl-series?codes=021277,025209&days=800&index=1.000001');
const group = pf.portfolios.find((g) => g.id === 'pwnhkl0');
const holdings = group.holdings;
const start = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
for (const [code, h] of Object.entries(holdings)) console.log('holding', code, 'addedAt', h.addedAt, '=> start', start(h.addedAt));
const byCode = new Map(pnl.items.map((s) => [String(s.code), s.points]));
for (const [code] of Object.entries(holdings)) {
  const pts = byCode.get(code) || [];
  console.log(code, 'points', pts.length, 'range', pts[0] && pts[0].d, '->', pts[pts.length - 1] && pts[pts.length - 1].d);
}
const starts = Object.values(holdings).map((h) => start(h.addedAt));
const lastDates = pnl.items.map((s) => s.points[s.points.length - 1].d);
console.log('all dates before start?', lastDates.every((d) => d < starts[0]), { starts, lastDates });
