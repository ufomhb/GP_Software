#!/bin/bash
echo "===ERROR_LINES_TODAY==="
grep -E "ERROR|WARN| 5[0-9][0-9] " /data/gp/logs/server.log 2>/dev/null | tail -25
echo "===SLOW_OR_5XX_COUNT==="
grep -cE " 5[0-9][0-9] " /data/gp/logs/server.log 2>/dev/null
echo "===REQ_AROUND_RESTART==="
grep -E "01:(1[5-9]|[2-4][0-9]):" /data/gp/logs/server.log 2>/dev/null | tail -20
echo "===LOG_FILES==="
ls -la /data/gp/logs/
