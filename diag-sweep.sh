#!/bin/bash
BASE=https://gp.ufomhb.xyz
TOKEN=$(/data/node24/bin/node /tmp/make-session.mjs)
for ep in "/api/funds/watch?codes=510300,159915,512690,000001&risk=balanced" "/api/funds/estimate?codes=000001,005682" "/api/kline?secid=1.000001&klt=101&limit=40" "/api/us" "/api/sectors?type=industry" "/api/strategy" "/api/battle" "/api/timeline" "/api/overview" "/api/funds/daily-proxy?limit=50"; do
  r=$(curl -sS -m 60 -H "Cookie: gp_sid=$TOKEN" -o /tmp/e.txt -w "%{http_code} %{time_total}s" "$BASE$ep" 2>&1)
  echo "--- $ep -> $r bytes=$(wc -c < /tmp/e.txt)"
  if [ "${r%% *}" != "200" ]; then head -c 200 /tmp/e.txt; echo; fi
done
/data/node24/bin/node -e "import('node:sqlite').then(m=>{const db=new m.DatabaseSync('/data/gp/data/gp.sqlite');const h=require('node:crypto').createHash('sha256').update('$TOKEN').digest('hex');db.prepare('DELETE FROM sessions WHERE token_hash=?').run(h);console.log('session cleaned');})"
