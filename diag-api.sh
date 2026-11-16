#!/bin/bash
echo "===LOGIN_BADCRED==="
curl -s -m 8 -o /tmp/r1.txt -w "code=%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{"username":"__diag_user__","password":"__diag_pw__"}' http://127.0.0.1:8090/api/login
head -c 300 /tmp/r1.txt; echo
echo "===SESSION==="
curl -s -m 8 -w "\ncode=%{http_code}\n" http://127.0.0.1:8090/api/session
echo "===AUTH_ME==="
curl -s -m 8 -w "\ncode=%{http_code}\n" http://127.0.0.1:8090/api/auth/me
echo "===OVERVIEW==="
curl -s -m 10 -w "\ncode=%{http_code}\n" http://127.0.0.1:8090/api/overview
echo "===STATUS_API==="
curl -s -m 8 -w "\ncode=%{http_code}\n" http://127.0.0.1:8090/api/status
echo "===LOG_TAIL==="
tail -n 15 /data/gp/logs/server.log
