import { readFileSync, writeFileSync } from 'node:fs';

const p = 'data/changelog.json';
const list = JSON.parse(readFileSync(p, 'utf8'));
const entry = {
  version: '2.10.7',
  date: '2026-11-22',
  title: '旧版本没有建仓日的老持仓统一按 2026-11-01 计，盈亏日历 / 统计从这天起算（后台恢复同理）',
  items: [
    '改动：v2.10.0 之前不记建仓日，这些老持仓没有 addedAt。按用户要求，现在统一把 2026-11-01（上海时间 00:00）当作它们的建仓日，盈亏日历 / 盈亏统计都从这天起算——既不把建仓之前的净值算进盈亏，也不会让日历落到「加载中 / 未记录」。',
    '读取即生效：服务端 lib/store.js 新增 LEGACY_ADDED_AT 与 fillLegacyAddedAt()，GET /api/portfolio 时给「份额 > 0 但没有建仓日」的老持仓补上 2026-11-01（内存里补齐，下次保存自然落盘）；新录入的持仓仍用自己的真实建仓日，不会被改成 11-01。JSON（主持仓 / 额外组合）与 SQLite 两条路径都覆盖。',
    '后台恢复：删除历史「恢复」、旧回收站恢复、快照回滚里，老记录没有建仓日的统一按 2026-11-01 写回（不再用恢复时刻）；删除历史「详情」里建仓日显示「2026-11-01（旧记录默认）」，恢复确认框与后台说明也写清了这条口径。',
    '前端：「我的持仓」表格的建仓日列不再显示「未记录」，老持仓显示 11-01（悬停说明是旧版本数据，可在「仓」里改）；盈亏日历底部说明改成「v2.10.0 之前没记录建仓日的老持仓统一按 2026-11-01 计」；录入弹窗的建仓日提示同步。',
    '兼容：接口里老的 holdings 形状（只有 shares / cost）保持不变，只有 portfolios[].holdings 会带 addedAt；已经有真实建仓日的数据完全不受影响。',
    '测试：新增 3 项——服务端读取老数据自动补 2026-11-01 且后续保存不冲掉、恢复「旧记录没有建仓日」写回 2026-11-01、DOM 老持仓按 11-01 出日历与持仓表；portfolio / deletion-history / dom-smoke 全部通过。npm test 306 项全绿。',
    '说明：版本号 2.10.7；只在本机 8090 验证，未推 NAS；NAS 升级时 data/changelog.json 仍需单独同步。',
  ],
};
const rest = list.filter((x) => x && x.version !== entry.version);
writeFileSync(p, JSON.stringify([entry, ...rest], null, 2), 'utf8');
console.log('changelog entries:', rest.length + 1);
