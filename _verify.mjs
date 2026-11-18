// 临时验收脚本：在隔离实例里跑一遍新增的 /api 端点（用完删除）
import { startApp, bootstrapAdmin } from './test/helpers/app.mjs';

const app = await startApp({ env: { ALLOW_REGISTER: '1' } });
try {
  const admin = await bootstrapAdmin(app, 'verifier', 'verify123');
  const show = async (p) => {
    const r = await admin.req(p, { signal: AbortSignal.timeout(90000) });
    const body = JSON.stringify(r.body);
    console.log(`\n### ${p} -> ${r.status} len=${body.length}`);
    console.log(body.slice(0, 1200));
  };
  await show('/api/longhu/seats?code=688613&limit=60');
  await show('/api/longhu/seats?code=600519&limit=60');
  await show('/api/calendar?type=ipo&limit=5');
  await show('/api/calendar?type=cbapply&limit=5');
  await show('/api/calendar?type=lift&limit=2');
} finally {
  await app.stop();
}
