#!/bin/bash
BASE=https://gp.ufomhb.xyz
TOKEN=$(/data/node24/bin/node /tmp/make-session.mjs)
H="Cookie: gp_sid=$TOKEN"
t() {
  local ep="$1"
  local res=$(curl -sS -m 120 -H "$H" -o /tmp/t.txt -w "%{http_code} %{time_total}s" "$BASE$ep" 2>&1)
  echo "--- $ep -> $res  bytes=$(wc -c < /tmp/t.txt)"
}
echo "### 依赖链分段测速"
t "/api/funds/open-flow?limit=50"
t "/api/funds/flow?type=inflow&limit=10"
t "/api/index-periods"
echo "### daily-proxy 首次/二次（看缓存是否生效）"
t "/api/funds/daily-proxy?limit=50"
t "/api/funds/daily-proxy?limit=50"
/data/node24/bin/node -e "import('node:sqlite').then(m=>{const db=new m.DatabaseSync('/data/gp/data/gp.sqlite');const h=require('node:crypto').createHash('sha256').update('$TOKEN').digest('hex');db.prepare('DELETE FROM sessions WHERE token_hash=?').run(h);console.log('session cleaned');})"
