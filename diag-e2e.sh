#!/bin/bash
BASE=https://gp.ufomhb.xyz
CJ=/tmp/diag-cookies.txt
U="diagt$(date +%H%M%S)"
P="DiagPass#2026x"
rm -f "$CJ"

echo "=== REGISTER ==="
curl -sS -m 25 -c "$CJ" -w "\ncode=%{http_code} time=%{time_total}\n" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}" "$BASE/api/auth/register"
echo "=== LOGIN ==="
curl -sS -m 25 -c "$CJ" -w "\ncode=%{http_code} time=%{time_total}\n" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}" "$BASE/api/auth/login"
echo "=== COOKIE ==="
grep -i session "$CJ" | awk '{print $6, "len=" length($7)}'

for ep in "/api/auth/me" "/api/overview" "/api/watchlist?secids=0.002415%2C1.600519&risk=balanced" "/api/portfolio" "/api/funds/hot" "/api/funds/warnings" "/api/changelog" "/api/source/status" "/api/news?limit=5" "/api/rank?type=gain&limit=3"; do
  out=$(curl -sS -m 30 -b "$CJ" -o /tmp/diag-ep.txt -w "%{http_code} %{time_total}s" "$BASE$ep" 2>&1)
  echo "--- $ep -> $out"
  head -c 160 /tmp/diag-ep.txt; echo
done
echo "=== TEMP_USER=$U ==="
