# 界面预览图

这些 PNG 是 README 里引用的界面截图，原先散落在仓库根目录，2026-11-15 统一收进本目录。

## 现用（16 张）

| 文件 | 对应界面 |
| --- | --- |
| `preview-dashboard.png` | 全景页（A 股 / 全球 / 期货 / 外汇总览） |
| `preview-funds.png` | 基金页 |
| `preview-stockfunds.png` | 股票型基金情报 |
| `preview-bond.png` | 债基排行 |
| `preview-us.png` | 美股专题 |
| `preview-china-distribution.png` | A 股涨跌分布 |
| `preview-china-five.png` | 五大指数分屏独立走势 |
| `preview-csi300-ratio.png` | 头部沪深 300 基金占比 |
| `preview-intraday-1m.png` | 最近交易日 1 分钟分时弹窗 |
| `preview-intraday-day.png` | 超范围日期的日线摘要弹窗 |
| `preview-strategy-v2.png` | 策略页 |
| `preview-strategy-battle.png` | 智能策略作战总览 |
| `preview-strategy-sectors.png` | 板块确认（200 板块评分） |
| `preview-strategy-portfolio.png` | 自选组合建议（股票 + 基金） |
| `preview-watchlist-v2.png` | 自选基金拖动排序 |
| `preview-sectors-v2.png` | 板块资金 TOP10 排序 |

## archive/（3 张）

被新版本替代、README 已不再引用的历史截图，保留是为了对照改动：

| 文件 | 说明 |
| --- | --- |
| `preview-strategy.png` | 旧策略页，v1.2 起由 `preview-strategy-v2.png` 取代 |
| `final-sectors.png` | 板块页早期验收截图 |
| `final-us.png` | 美股页早期验收截图 |

## 重新截图

后台/前台页面的截图脚本在 `tools/`（`shot.js` / `shot-battle.js` / `shot-admin.js`，用 CDP 驱动 Chrome），输出可以直接覆盖本目录文件；截图后记得同步更新 README 顶部「界面预览」的引用路径（`docs/screenshots/...`）。
