// 临时验收脚本：用隔离实例验证 v2.4.0 的复权/指标接口与静态资源，跑完即删
import { startApp } from '../test/helpers/app.mjs';

const app = await startApp();
const c = app.client();

try {
  // 1) 注册并登录（隔离实例的临时 data/，不碰仓库数据）
  await c.req('/api/auth/register', {
    method: 'POST',
    json: { username: 'v24check', password: 'verify-2.4.0-pw' },
  });

  // 2) 复权三口径
  for (const fqt of [0, 1, 2]) {
    const r = await c.req(`/api/kline?secid=1.000001&klt=101&limit=120&fqt=${fqt}`);
    const b = r.body || {};
    const series = b.series || {};
    console.log(`kline fqt=${fqt}  status=${r.status}  fqt=${b.fqt}  fqtApplied=${b.fqtApplied}  candles=${(b.candles || []).length}  source=${b.source}`);
    console.log(`   series: kdjK=${Array.isArray(series.kdjK)} kdjD=${Array.isArray(series.kdjD)} kdjJ=${Array.isArray(series.kdjJ)} bollMid=${Array.isArray(series.bollMid)} bollUpper=${Array.isArray(series.bollUpper)}`);
    if (Array.isArray(series.kdjK) && Array.isArray(series.bollMid) && (b.candles || []).length === series.kdjK.length) {
      console.log('   length-aligned: OK');
    } else {
      console.log('   length-aligned: FAIL');
    }
  }

  // 3) 非法 fqt 应按不复权处理
  const bad = await c.req('/api/kline?secid=1.000001&klt=101&limit=60&fqt=9');
  console.log(`kline fqt=9(非法)  status=${bad.status}  fqt=${(bad.body || {}).fqt}（应为 0）`);

  // 4) 个股详情带 fqt
  const st = await c.req('/api/stock?secid=1.600519&risk=balanced&fqt=1');
  const sbody = st.body || {};
  console.log(`stock fqt=1  status=${st.status}  kline.fqt=${sbody.kline && sbody.kline.fqt}  kline.fqtApplied=${sbody.kline && sbody.kline.fqtApplied}  hasAdvice=${!!sbody.advice}`);

  // 5) 静态资源：页面版本串与新模块可访问
  for (const p of ['/', '/index.html', '/js/app.js?v=2.4.0', '/js/views/market.js?v=2.4.0', '/css/app.css?v=2.4.0']) {
    const r = await c.req(p);
    const text = String(r.text || '');
    console.log(`static ${p}  status=${r.status}  bytes=${text.length}${p.startsWith('/index') || p === '/' ? `  v2.4.0=${text.includes('v=2.4.0')}` : ''}`);
  }
} finally {
  await app.stop();
}
