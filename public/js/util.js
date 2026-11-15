/* 前端通用工具层（P2 从 app.js 抽出）
   只放纯函数：数字/涨跌格式化、名称清洗、HTML 转义、URL 清洗。
   任何来自服务端或上游的文本进 innerHTML 前必须过 esc()；进 href/src 前必须再过 safeUrl()。 */

function isNum(v) {
  return v !== null && v !== '' && Number.isFinite(Number(v));
}

function nf(v, digits = 2) {
  if (!isNum(v)) return '--';
  return Number(v).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function priceFmt(v) {
  if (!isNum(v)) return '--';
  const a = Math.abs(Number(v));
  if (a >= 1000) return nf(v, 2);
  if (a >= 100) return nf(v, 2);
  if (a >= 10) return nf(v, 3);
  if (a >= 1) return nf(v, 4);
  return nf(v, 4);
}

function stockFmt(v) {
  return nf(v, 2);
}

function pctFmt(v, digits = 2) {
  if (!isNum(v)) return '--';
  return `${Number(v) >= 0 ? '+' : ''}${nf(v, digits)}%`;
}

function signedFmt(v, digits = 2) {
  if (!isNum(v)) return '--';
  return `${Number(v) >= 0 ? '+' : ''}${nf(v, digits)}`;
}

function yiFmt(v, digits = 1) {
  if (!isNum(v)) return '--';
  return `${Number(v) >= 0 ? '+' : ''}${nf(v, digits)} 亿`;
}

function compactAmount(v) {
  if (!isNum(v)) return '--';
  const n = Number(v);
  if (Math.abs(n) >= 1e12) return `${nf(n / 1e12, 2)} 万亿`;
  if (Math.abs(n) >= 1e8) return `${nf(n / 1e8, 1)} 亿`;
  if (Math.abs(n) >= 1e4) return `${nf(n / 1e4, 0)} 万`;
  return nf(n, 0);
}

function toneOf(v) {
  if (!isNum(v)) return 'flat';
  return Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : 'flat';
}

function toneClass(v) {
  return `tone-${toneOf(v)}`;
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, '');
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (s) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[s]));
}

/**
 * 属性里的 URL 清洗：只放行 http(s) 与相对路径。
 * esc() 只能防住引号闭合，防不住 `javascript:alert(1)` 这种协议本身带执行能力的情况。
 */
function safeUrl(value, fallback = '#') {
  const raw = String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!raw) return fallback;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw; // 相对路径 / 锚点
  if (/^https?:/i.test(raw)) return raw; // 只允许 http(s)
  return fallback; // javascript: / data: / vbscript: 等
}

function timeText(ts) {
  if (!ts) return '--:--:--';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

export {
  isNum,
  nf,
  priceFmt,
  stockFmt,
  pctFmt,
  signedFmt,
  yiFmt,
  compactAmount,
  toneOf,
  toneClass,
  cleanName,
  esc,
  safeUrl,
  timeText,
};
