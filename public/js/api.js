/* HTTP 封装（P2 从 app.js 抽出）
   统一处理：超时、401 跳登录、错误信息提取。只依赖浏览器 fetch。 */

function redirectToLogin() {
  if (redirectToLogin.done) return;
  redirectToLogin.done = true;
  const next = encodeURIComponent(location.pathname + location.search + location.hash);
  location.replace(`/login.html?next=${next}`);
}

async function api(path, timeout = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path, { cache: 'no-store', signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      redirectToLogin();
      throw new Error('登录已失效，正在跳转登录页');
    }
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，请检查网络或稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function apiPost(path, body, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      redirectToLogin();
      throw new Error('登录已失效，正在跳转登录页');
    }
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export { redirectToLogin, api, apiPost };
