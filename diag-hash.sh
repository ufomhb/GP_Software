#!/bin/bash
cd /data/gp
echo "===HASHES==="
sha256sum server.js package.json public/index.html public/login.html public/js/app.js public/js/core.js public/js/util.js public/js/dom.js public/js/api.js public/js/charts.js public/js/views/funds.js 2>&1
