/* DOM 小工具（P2 从 app.js 抽出）
   选择器、轻提示、防抖；不依赖业务状态，任何视图模块都可以直接 import。 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function toast(message, type = 'info', ms = 3600) {
  const root = $('#toastRoot');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = '<span class="t-dot"></span><div></div>';
  el.querySelector('div').textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export { $, $$, toast, debounce };
