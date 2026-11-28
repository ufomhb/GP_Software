/* 盈亏日历网格（v2.11.0，从 views/fundwatch.js 抽出）
   ---------------------------------------------------------------
   自选基金与模拟盘共用同一套「日 / 月 / 年」日历 DOM：
   - 日：周一~周五 5 列 × 每周一行，周末不占列；
   - 月：一年 12 格；年：每年 1 格；
   - metric='amount' 显示金额，'rate' 显示收益率。
   只做 DOM；分桶计算由调用方传入（fundCalendarBuckets / paperCalendarBuckets）。 */
import { isNum, nf, signedFmt, toneClass, esc } from '../util.js?v=2.14.1';

export const WEEK_LABELS = ['周一', '周二', '周三', '周四', '周五'];

export function fmtCalendarValue(value, metric) {
  if (!isNum(value)) return '--';
  if (metric === 'rate') return `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
  return `${value >= 0 ? '+' : ''}${nf(value, 2)}`;
}

/** 日历网格 HTML（日 / 月 / 年共用；pending 与正常数据都走同一个渲染） */
export function calendarGridHtml(buckets, unit, metric) {
  if (unit === 'day') {
    return `<div class="pnl-calendar">
      <div class="pnl-calendar-head"></div>${WEEK_LABELS.map((w) => `<div class="pnl-calendar-head">${w}</div>`).join('')}
      ${(buckets.weeks || []).map((week, wi) => `<div class="pnl-calendar-week">${wi + 1}</div>${week.map((cell) => {
        if (!cell) return '<div class="pnl-calendar-cell is-empty"></div>';
        // 没有当天数据（非交易日 / 净值未出 / 建仓前）一律显示 --，不要写「休」误导用户
        if (!cell.hasData) return `<div class="pnl-calendar-cell is-rest"><div class="pnl-calendar-day">${cell.day}</div><div class="pnl-calendar-val muted">--</div></div>`;
        const tone = Number(cell.pnl) > 0 ? 'is-up' : Number(cell.pnl) < 0 ? 'is-down' : '';
        return `<div class="pnl-calendar-cell ${tone}" title="${esc(`${cell.d} · ${signedFmt(cell.pnl, 2)}`)}"><div class="pnl-calendar-day">${cell.day}</div><div class="pnl-calendar-val ${toneClass(cell.pnl)}">${fmtCalendarValue(cell.value, metric)}</div></div>`;
      }).join('')}`).join('')}
    </div>`;
  }
  if (unit === 'month') {
    return `<div class="pnl-calendar-months">${(buckets.tiles || []).map((t) => {
      const tone = Number(t.pnl) > 0 ? 'is-up' : Number(t.pnl) < 0 ? 'is-down' : '';
      return `<div class="pnl-calendar-tile ${t.hasData ? tone : ''}" data-calendar-month="${esc(t.month)}"><span>${esc(t.label)}</span><b class="${toneClass(t.pnl)}">${t.hasData ? fmtCalendarValue(t.value, metric) : '--'}</b></div>`;
    }).join('')}</div>`;
  }
  return `<div class="pnl-calendar-years">${(buckets.tiles || []).map((t) => {
    const tone = Number(t.pnl) > 0 ? 'is-up' : Number(t.pnl) < 0 ? 'is-down' : '';
    return `<div class="pnl-calendar-tile ${tone}"><span>${esc(t.label)}</span><b class="${toneClass(t.pnl)}">${fmtCalendarValue(t.value, metric)}</b></div>`;
  }).join('') || '<div class="empty">还没有跨年数据</div>'}</div>`;
}
