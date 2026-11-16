#!/bin/bash
echo "===LOGIN_BADCRED==="
curl -s -m 8 -w "\ncode=%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{"username":"__diag_user__","password":"__diag_pw_123__"}' http://127.0.0.1:8090/api/auth/login
echo "===REGISTER_SHORT==="
curl -s -m 8 -w "\ncode=%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{"username":"ab","password":"123"}' http://127.0.0.1:8090/api/auth/register
echo "===HEAD_CORE==="
curl -sI -m 5 "http://127.0.0.1:8090/js/core.js" 2>&1 | grep -iE "HTTP/|cache-control|etag|content-length|content-type"
echo "===HEAD_APP==="
curl -sI -m 5 "http://127.0.0.1:8090/js/app.js?v=2.1.1" 2>&1 | grep -iE "HTTP/|cache-control|etag|content-length"
echo "===HEAD_INDEX==="
curl -sI -m 5 "http://127.0.0.1:8090/login.html" 2>&1 | grep -iE "HTTP/|cache-control|etag|content-length"
