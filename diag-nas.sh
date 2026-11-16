#!/bin/bash
echo "===TREE==="
ls -R /data/gp/public/js 2>&1 | head -40
echo "===IMPORTS==="
grep -oE "(from|import)[[:space:]]*\(?['\"][^'\"]+['\"]" /data/gp/public/js/app.js 2>&1 | sort -u | head -40
echo "===ASSETS==="
for f in / /login.html /admin.html /js/app.js /js/core.js /js/util.js /js/dom.js /js/api.js /js/charts.js /js/views/funds.js /css/app.css /vendor/echarts.min.js; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:8090$f")
  echo "$f -> $code"
done
echo "===DATA==="
ls -la /data/gp/data/ 2>&1 | head -20
