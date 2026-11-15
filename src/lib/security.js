'use strict';
/**
 * 安全相关的纯函数（P2 从 server.js 抽出）
 *
 * 只放「不依赖仓库全局状态」的逻辑，方便单测：给请求/响应与配置，返回结果，不读文件、不碰数据库。
 * 配置（是否强制 CSP、Cookie 名、邀请码）由调用方传入。
 */
const crypto = require('node:crypto');

const CSP_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** 当前请求是否是 HTTPS（直连 TLS，或反向代理声明了 X-Forwarded-Proto） */
function requestIsHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

/** 给每个响应加安全响应头；CSP 默认只报告（Report-Only），cspEnforce=true 才强制 */
function setSecurityHeaders(req, res, cspEnforce = false) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(cspEnforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', CSP_POLICY);
  // HSTS 只在真正走 HTTPS 时下发，否则本机 http://127.0.0.1 会被浏览器记住
  if (requestIsHttps(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/** 日志里的敏感查询参数打码，避免 token / webhook 进日志文件 */
function redactQuery(search) {
  return String(search || '').replace(
    /([?&](?:token|sendkey|key|webhook|password|passwd|code|apikey|api_key)=)[^&]*/gi,
    '$1***',
  );
}

/**
 * 同源校验：浏览器对 POST 会带 Origin；跨站直接拒绝。
 * 没有 Origin / Sec-Fetch-Site 的客户端（curl、脚本）按放行处理。
 */
function isSameOriginRequest(req) {
  const headers = req.headers || {};
  const origin = String(headers.origin || '').trim();
  if (origin) {
    if (origin === 'null') return false;
    try {
      return new URL(origin).host === String(headers.host || '').trim();
    } catch {
      return false;
    }
  }
  const site = String(headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (site === 'same-origin' || site === 'none') return true;
  if (site === 'cross-site' || site === 'same-site') return false;
  return true;
}

/** 会话令牌 → 存储键（只存哈希，文件/库泄露不等于能登录） */
function sessionKey(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/** 邀请码比较：先哈希再时序安全比较，避免长度差异泄露与侧信道 */
function inviteMatches(code, expected) {
  if (!expected) return true;
  const got = crypto.createHash('sha256').update(String(code || '')).digest();
  const want = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(got, want);
}

/** 组装会话 Cookie；只有 HTTPS 才加 Secure，否则本机 http 会登录不上 */
function sessionCookie({ name, token, maxAgeSec, secure }) {
  const parts = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  CSP_POLICY,
  requestIsHttps,
  setSecurityHeaders,
  redactQuery,
  isSameOriginRequest,
  sessionKey,
  inviteMatches,
  sessionCookie,
};
