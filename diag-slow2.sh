#!/bin/bash
# ASCII only - avoid PowerShell pipe encoding damage
BASE=https://gp.ufomhb.xyz
TOKEN=$(/data/node24/bin/node /tmp/make-session.mjs)
echo "=== dep: open-flow (loadOpenFundFlowRaw) ==="
curl -sS -m 150 -H "Cookie: gp_sid=$TOKEN" -o /tmp/a.txt -w "code=%{http_code} time=%{time_total}s bytes=%{size_download}\n" "$BASE/api/funds/open-flow?limit=50"
echo "=== dep: funds flow (etf daily flow) ==="
curl -sS -m 150 -H "Cookie: gp_sid=$TOKEN" -o /tmp/b.txt -w "code=%{http_code} time=%{time_total}s bytes=%{size_download}\n" "$BASE/api/funds/flow?type=inflow&limit=10"
echo "=== dep: index-periods (etf universe) ==="
curl -sS -m 150 -H "Cookie: gp_sid=$TOKEN" -o /tmp/c.txt -w "code=%{http_code} time=%{time_total}s bytes=%{size_download}\n" "$BASE/api/index-periods"
echo "=== daily-proxy warm ==="
curl -sS -m 60 -H "Cookie: gp_sid=$TOKEN" -o /tmp/d.txt -w "code=%{http_code} time=%{time_total}s bytes=%{size_download}\n" "$BASE/api/funds/daily-proxy?limit=50"
/data/node24/bin/node -e "import('node:sqlite').then(m=>{const db=new m.DatabaseSync('/data/gp/data/gp.sqlite');const h=require('node:crypto').createHash('sha256').update('$TOKEN').digest('hex');db.prepare('DELETE FROM sessions WHERE token_hash=?').run(h);console.log('session cleaned');})"
