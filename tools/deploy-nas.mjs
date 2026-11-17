#!/usr/bin/env node
'use strict';
/**
 * 命令行推送代码到 NAS（2026-11-17）
 *
 * 与后台「部署到 NAS」按钮共用同一套引擎（src/lib/nas-deploy.js），
 * 这样两条入口的行为、备份策略、健康检查口径完全一致。
 *
 * 用法：
 *   node tools/deploy-nas.mjs          # 推送并打印进度
 *   node tools/deploy-nas.mjs --dry    # 只检查连通性与待推送文件，不实际推送
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createDeployToNas } = require('../src/lib/nas-deploy.js');
const version = require('../package.json').version;
const dry = process.argv.includes('--dry');

const engine = createDeployToNas({ rootDir: ROOT, version });

if (!engine.supported) {
  console.error(`本机才有源文件：当前 platform=${process.platform}，推送需在 Windows 开发机上执行。`);
  process.exit(1);
}

(async () => {
  const pre = engine.snapshot();
  console.log(`[deploy] 本机版本 v${version}，目标 ${pre.host} · ${pre.target}`);
  console.log(`[deploy] 待打包文件 ${pre.pending.totalFiles} 个，其中比上次推送更新 ${pre.pending.changedCount} 个`);
  if (pre.last) {
    console.log(`[deploy] 上次推送：${new Date(pre.last.at).toLocaleString('zh-CN', { hour12: false })} · ${pre.last.ok ? '成功' : '失败'}`);
  }
  if (dry) {
    console.log('[deploy] --dry：只做预检，不推送');
    process.exit(0);
  }

  const { id } = engine.start();
  console.log(`[deploy] 任务 ${id} 已启动`);

  const startedAt = Date.now();
  const printed = new Map();
  const timer = setInterval(() => {
    const job = engine.snapshot().job;
    if (!job) return;
    for (const step of job.steps) {
      if (step.status === 'pending' || printed.get(step.id) === step.status) continue;
      printed.set(step.id, step.status);
      const mark = step.status === 'done' ? '✓' : step.status === 'running' ? '…' : step.status === 'failed' ? '✗' : '·';
      console.log(`[${String(job.percent).padStart(3)}%] ${mark} ${step.label}${step.detail ? ' — ' + step.detail : ''}`);
    }
    if (job.status !== 'running') {
      clearInterval(timer);
      const secs = ((job.finishedAt - startedAt) / 1000).toFixed(1);
      if (job.status === 'success') {
        console.log(`[deploy] 推送完成，用时 ${secs}s`);
        process.exit(0);
      }
      console.error(`[deploy] 推送失败（${secs}s）：${job.error}`);
      for (const e of job.log.slice(-8)) console.error(`  ${e.level.toUpperCase()} ${e.text}`);
      process.exit(1);
    }
  }, 1000);
})();
