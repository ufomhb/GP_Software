'use strict';
/**
 * 出站地址安全（P2 从 server.js 抽出）
 *
 * webhook 由管理员填写，必须挡住内网 / 回环 / 云元数据地址：
 * 否则管理员账号一旦被拿下，推送配置就变成打 NAS 内网的跳板。
 */
const net = require('node:net');
const dns = require('node:dns');

/** 配置类错误统一按 400 返回（否则前端只会看到「服务暂时不可用」） */
function outboundError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 是否属于内网 / 回环 / 链路本地 / 保留地址 */
function isPrivateAddress(ip) {
  const raw = String(ip || '').trim().toLowerCase();
  if (!raw) return true;
  const v = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 0 || b === 168)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网段
    if (a >= 224) return true; // 组播 / 保留
    return false;
  }
  if (net.isIPv6(v)) {
    if (v === '::' || v === '::1' || v === '0:0:0:0:0:0:0:1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(v)) return true; // fe80::/10 链路本地
    return false;
  }
  return true; // 解析不出 IP 时按不安全处理
}

/**
 * 校验出站地址：只允许 https，拒绝内网主机名与内网 IP，域名要解析后再逐个复查（防 DNS rebinding 到内网）。
 * 失败抛 outboundError（status=400），由请求处理层原样回给管理员。
 */
async function assertSafeOutboundUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    throw outboundError('webhook 地址格式不正确');
  }
  if (parsed.protocol !== 'https:') throw outboundError('webhook 必须是 https 地址');
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw outboundError('webhook 缺少主机名');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    throw outboundError('webhook 不能指向内网地址');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw outboundError('webhook 不能指向内网地址');
    return;
  }
  let addrs = [];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw outboundError('webhook 域名无法解析');
  }
  if (!addrs.length) throw outboundError('webhook 域名无法解析');
  for (const item of addrs) {
    if (isPrivateAddress(item.address)) throw outboundError('webhook 不能指向内网地址');
  }
}

module.exports = { outboundError, isPrivateAddress, assertSafeOutboundUrl };
