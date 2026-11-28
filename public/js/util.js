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

/**
 * v2.14.0：说明文字收进「?」小图标，悬停 / 键盘聚焦 / 手机点按都能展开。
 * 仍把全文放进 aria-label，读屏用户不依赖 hover。
 */
function hintIcon(text, label = '说明') {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  return `<span class="hint-tip" tabindex="0" role="note" aria-label="${esc(label)}：${esc(t)}">`
    + '<span class="hint-q" aria-hidden="true">?</span>'
    + `<span class="hint-bubble" role="tooltip">${esc(t)}</span></span>`;
}

/** 把原本直接铺在页面上的「口径说明」整段替换成 ? 图标（用于动态更新的 note 节点） */
function setNoteTip(el, text) {
  if (!el) return;
  const t = String(text == null ? '' : text).trim();
  el.classList.add('note-tip');
  el.innerHTML = t ? `${hintIcon(t, '口径说明')}<span class="hint-label">口径说明</span>` : '';
}

/** 模板里直接拼一行「? 口径说明」（v2.15.0，app.js 生成的面板用） */
function noteTipHtml(text, label = '说明') {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  return `<p class="note-tip muted small">${hintIcon(t, label)}<span class="hint-label">${esc(label)}</span></p>`;
}

/* ---------------------------------------------------------
   v2.15.0：「?」说明气泡定位
   ---------------------------------------------------------
   原来气泡是 .hint-tip 的绝对定位子元素（left:50%），窄屏上会超出屏幕，
   也会被 .table-scroll / .modal 这类 overflow 容器裁掉。
   现在展开时把气泡临时挂到 body，用 position:fixed 夹在视口内；收起时放回原位。
   --------------------------------------------------------- */
let floatingBubble = null;
let floatingHome = null;

function hideHintBubble() {
  if (!floatingBubble) return;
  const bubble = floatingBubble;
  const home = floatingHome;
  floatingBubble = null;
  floatingHome = null;
  bubble.classList.remove('is-floating');
  bubble.removeAttribute('style');
  if (home && home.isConnected) home.appendChild(bubble);
  else bubble.remove();
}

function positionHintBubble(bubble, tip) {
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  bubble.style.maxWidth = `${Math.max(160, Math.min(320, vw - 16))}px`;
  const bw = bubble.offsetWidth || 0;
  const bh = bubble.offsetHeight || 0;
  const r = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  const pad = 8;
  let left = r.left + r.width / 2 - bw / 2;
  if (vw) left = Math.max(pad, Math.min(left, vw - bw - pad));
  let top = r.bottom + pad;
  if (vh && top + bh > vh - pad) top = Math.max(pad, r.top - pad - bh);
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
}

function showHintBubble(tip) {
  if (!tip || typeof document === 'undefined') return;
  const bubble = tip.querySelector('.hint-bubble');
  if (!bubble) return;
  if (floatingBubble === bubble) { positionHintBubble(bubble, tip); return; }
  if (floatingBubble) hideHintBubble();
  floatingHome = tip;
  floatingBubble = bubble;
  bubble.classList.add('is-floating');
  document.body.appendChild(bubble);
  positionHintBubble(bubble, tip);
}

/** 把 `[data-hint-note]` 元素里的说明文字换成 ? 图标（保留 label 与 aria） */
function upgradeHintNote(el) {
  if (!el || el.nodeType !== 1 || el.dataset.hintDone) return;
  const text = (el.textContent || '').trim();
  if (!text) return;
  const label = el.dataset.hintLabel || '说明';
  el.dataset.hintDone = '1';
  el.classList.add('note-tip');
  el.innerHTML = `${hintIcon(text, label)}<span class="hint-label">${esc(label)}</span>`;
}

function initHintNotes(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || !scope.querySelectorAll) return;
  if (scope.matches && scope.matches('[data-hint-note]')) upgradeHintNote(scope);
  scope.querySelectorAll('[data-hint-note]').forEach(upgradeHintNote);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const tipOf = (target) => (target && target.closest ? target.closest('.hint-tip') : null);
  document.addEventListener('mouseover', (e) => {
    const tip = tipOf(e.target);
    if (tip && !tip.contains(e.relatedTarget)) showHintBubble(tip);
  });
  document.addEventListener('mouseout', (e) => {
    const tip = tipOf(e.target);
    if (tip && !tip.contains(e.relatedTarget)) hideHintBubble();
  });
  document.addEventListener('focusin', (e) => {
    const tip = tipOf(e.target);
    if (tip) showHintBubble(tip);
  });
  document.addEventListener('focusout', (e) => {
    if (tipOf(e.target)) hideHintBubble();
  });
  // 滚动 / 旋转屏幕后气泡要跟着锚点走：聚焦 ? 图标时浏览器会把它滚进视口，
  // 这里如果直接收起，点按图标会「闪一下就没了」。
  const followHintBubble = () => {
    if (!floatingBubble || !floatingHome) return;
    const r = floatingHome.getBoundingClientRect();
    const vh = window.innerHeight || 0;
    if (vh && (r.bottom < 0 || r.top > vh)) { hideHintBubble(); return; }
    positionHintBubble(floatingBubble, floatingHome);
  };
  window.addEventListener('scroll', followHintBubble, { capture: true, passive: true });
  window.addEventListener('resize', followHintBubble, { passive: true });

  const startHintNotes = () => {
    initHintNotes(document);
    if (typeof MutationObserver === 'undefined') return;
    new MutationObserver((list) => {
      list.forEach((m) => {
        m.addedNodes.forEach((node) => {
          if (!node || node.nodeType !== 1) return;
          if (node.matches && node.matches('[data-hint-note]')) upgradeHintNote(node);
          else if (node.querySelectorAll) node.querySelectorAll('[data-hint-note]').forEach(upgradeHintNote);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startHintNotes);
  else startHintNotes();
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
  hintIcon,
  setNoteTip,
  noteTipHtml,
  initHintNotes,
};
