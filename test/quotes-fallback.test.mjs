/**
 * 行情价格归一回归测试（v2.9.2）
 *
 * 背景：开盘前 / 集合竞价前 / 停牌时，行情源会把「现价」给成 0。
 * 0 流到模拟盘会让持仓市值变成 0、累计盈亏算成 -100%（用户实测「全亏」）。
 * 这里锁住三条规则：有成交价 → live；只有昨收 → prevClose（现价=昨收、涨跌幅 0）；
 * 都没有 → missing（全部置空，绝不伪造 0）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyQuotePriceFallback } = require('../lib/marketdata.js');
const { buildPortfolioDoc, validatePortfolioDoc, applyPortfolioImport } = require('../src/lib/portfolio-transfer.js');

test('价格归一：有真实成交价时原样保留并标 live', () => {
  const q = applyQuotePriceFallback({ secid: '1.600519', price: 1688.8, pct: 1.23, prevClose: 1668.2 });
  assert.equal(q.price, 1688.8);
  assert.equal(q.pct, 1.23);
  assert.equal(q.priceMode, 'live');
});

test('价格归一：现价 0 但有昨收 → 用昨收、涨跌幅 0、标 prevClose', () => {
  const q = applyQuotePriceFallback({
    secid: '1.600519', price: 0, pct: 0, change: 0, open: 0, high: 0, low: 0, prevClose: 1668.2,
  });
  assert.equal(q.price, 1668.2, '现价应回落到昨收');
  assert.equal(q.pct, 0, '涨跌幅按昨收算就是 0，不是缺失');
  assert.equal(q.change, 0);
  assert.equal(q.open, null, '开盘价 0 不能留着，置空');
  assert.equal(q.priceMode, 'prevClose');
});

test('价格归一：现价与昨收都没有 → 全部置空并标 missing', () => {
  const q = applyQuotePriceFallback({ secid: '0.000001', price: null, pct: null, prevClose: null });
  assert.equal(q.price, null);
  assert.equal(q.pct, null);
  assert.equal(q.change, null);
  assert.equal(q.priceMode, 'missing');
});

test('价格归一：负数/非法价格同样按缺失处理', () => {
  const a = applyQuotePriceFallback({ price: -1, prevClose: 10 });
  assert.equal(a.price, 10);
  assert.equal(a.priceMode, 'prevClose');
  const b = applyQuotePriceFallback({ price: 'abc', prevClose: '-', pct: '-' });
  assert.equal(b.price, null);
  assert.equal(b.priceMode, 'missing');
});

test('持仓互通：导出只带还在持有的条目，导入按模式合并', () => {
  const doc = buildPortfolioDoc({
    user: { id: 'u1', username: 'alice' },
    portfolio: {
      funds: [{ code: '510300', name: '沪深300ETF', type: 'etf' }],
      holdings: {
        '510300': { shares: 1000, cost: 3.8, updatedAt: 1 },
        '000001': { shares: 0, cost: 0, updatedAt: 2, removedAt: 2 },
      },
      watchlist: [{ secid: '1.600519', code: '600519', name: '贵州茅台' }],
    },
    storeMode: 'json',
  });
  assert.deepEqual(Object.keys(doc.holdings), ['510300'], '删除墓碑不能出现在导出里');
  const parsed = validatePortfolioDoc(JSON.parse(JSON.stringify(doc)));
  assert.equal(parsed.user.id, 'u1');

  const current = {
    funds: [{ code: '000960', name: '招商医药健康产业股票', type: 'open' }],
    holdings: { '000960': { shares: 500, cost: 2.1, updatedAt: 5 } },
    watchlist: [],
  };
  const merged = applyPortfolioImport(parsed, current, { mode: 'merge', now: 1000 });
  assert.deepEqual(merged.funds.map((f) => f.code), ['510300', '000960'], 'merge：导入在前、当前独有的保留');
  assert.equal(merged.holdings['510300'].shares, 1000);
  assert.equal(merged.holdings['000960'].shares, 500);
  assert.equal(merged.holdings['000960'].updatedAt, 999, '当前独有条目用稍旧时间戳，避免反向覆盖');

  const replaced = applyPortfolioImport(parsed, current, { mode: 'replace', now: 2000 });
  assert.deepEqual(Object.keys(replaced.holdings), ['510300']);
  assert.deepEqual(replaced.funds.map((f) => f.code), ['510300']);
});

test('持仓互通：格式版本 / 账号缺失要报错', () => {
  assert.throws(() => validatePortfolioDoc({ docVersion: 1, user: { id: 'u1' } }), /不支持的持仓文件格式/);
  assert.throws(() => validatePortfolioDoc({ docVersion: 2 }), /缺少账号 ID/);
});
