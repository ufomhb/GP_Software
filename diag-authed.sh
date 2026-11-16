#!/bin/bash
BASE=https://gp.ufomhb.xyz
TOKEN=$(/data/node24/bin/node /tmp/make-session.mjs)
echo "token_len=${#TOKEN}"
echo "=== ME ==="
curl -sS -m 20 -H "Cookie: gp_sid=$TOKEN" -w "\ncode=%{http_code} time=%{time_total}\n" "$BASE/api/auth/me"
for ep in "/api/overview" "/api/watchlist?secids=0.002415%2C1.600519&risk=balanced" "/api/portfolio" "/api/funds/hot" "/api/funds/warnings" "/api/changelog" "/api/news?limit=5" "/api/rank?type=gain&limit=3" "/api/source/status" "/api/sectors" "/api/funds/daily-proxy?limit=50" "/api/funds/sector-flow" "/api/admin/users"; do
  code_time=$(curl -sS -m 45 -H "Cookie: gp_sid=$TOKEN" -o /tmp/diag-ep.txt -w "%{http_code} %{time_total}s" "$BASE$ep" 2>&1)
  echo "--- $ep -> $code_time"
  head -c 120 /tmp/diag-ep.txt; echo
done
echo "=== CLEANUP ==="
/data/node24/bin/node -e "import('node:sqlite').then(m=>{const db=new m.DatabaseSync('/data/gp/data/gp.sqlite');const h=require('node:crypto').createHash('sha256').update('$TOKEN').digest('hex');const r=db.prepare(\"DELETE FROM sessions WHERE token_hash=?\").run(h);console.log('deleted',r.changes);})"
