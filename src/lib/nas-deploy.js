'use strict';
/**
 * 推送代码到 NAS（后台「部署」板块的后端引擎，2026-11-17）
 *
 * 设计要点：
 * 1) 只在「本机开发机」上可用：判据是 process.platform === 'win32'。在 NAS 上运行时
 *    入口返回 supported:false，前端显示「本机才有源文件」，不会误点。
 * 2) 子进程不用管道 stdio：DSH 沙箱下 spawn + pipe 会 EPERM，因此把子进程输出
 *    直接重定向到临时日志文件描述符，再增量读文件拼进度。这种方式在沙箱内、
 *    双击启动.bat 的正常环境里都成立。
 * 3) 全程 execFile 语义（argv 数组、不经 shell），绕开 PowerShell 引号坑；
 *    远端命令只用单引号包一层、内部不嵌双引号。
 * 4) 同一时间只允许一个推送任务；前端靠 GET status 轮询进度（响应层只输出 JSON）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const NAS_HOST = '192.168.31.175';
const NAS_USER = 'root';
const NAS_DIR = '/data/gp';
const NAS_SERVICE = 'gp-terminal';
const REMOTE_PKG = '/tmp/gp-deploy.tar.gz';
const BACKUP_DIR = '/data/backup/gp-code';

// 只同步代码，不同步 data/（NAS 上的 data 是运行时数据）；
// data/changelog.json 是版本履历，必须随代码发布，否则后台「更新履历」不更新。
const CODE_ITEMS = ['server.js', 'package.json', 'src', 'lib', 'public', 'scripts', 'data/changelog.json'];

// 每一步的权重（百分比），步内还可按 scp 打印的百分比细化为子进度。
const STEPS = [
  { id: 'preflight', label: '检查本机工具与 NAS 连通性', weight: 8 },
  { id: 'package', label: '打包本地最新代码', weight: 10 },
  { id: 'backup', label: '备份 NAS 现有代码', weight: 14 },
  { id: 'upload', label: '上传代码包到 NAS', weight: 30 },
  { id: 'extract', label: '解压覆盖到 /data/gp', weight: 10 },
  { id: 'restart', label: '重启 gp-terminal 服务', weight: 14 },
  { id: 'health', label: '健康检查与版本核对', weight: 14 },
];

const LOG_LIMIT = 260;          // 状态里保留的日志条数
const NAS_INFO_TTL = 30000;     // NAS 版本信息缓存时长（轮询时避免每次 SSH）
const PENDING_TTL = 5000;       // 本地改动扫描缓存

function createDeployToNas(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, '..', '..');
  const localVersion = options.version || '';
  const stateFile = path.join(rootDir, 'data', 'deploy-state.json');
  const keyPath = path.join(os.homedir(), '.ssh', 'id_ed25519_minas');

  const supported = process.platform === 'win32';

  /** 当前（或最近一次）推送任务 */
  let job = null;
  let nasInfoCache = { at: 0, data: null };
  let pendingCache = { at: 0, data: null };
  let lastDeploy = readJson(stateFile, null);

  function readJson(file, fallback) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function writeLastDeploy(next) {
    lastDeploy = next;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(next, null, 2), 'utf8');
    } catch {
      /* 写状态失败不影响推送本身 */
    }
  }

  /* ---------- 子进程：输出重定向到文件，避免管道 ---------- */

  let seqLog = 0;
  let tmpDir = null;
  function getTmpDir() {
    if (tmpDir) return tmpDir;
    tmpDir = path.join(os.tmpdir(), 'gp-deploy');
    fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }

  function run(argv, opts = {}) {
    const { cwd, timeoutMs = 120000, onLine } = opts;
    return new Promise((resolve) => {
      const logPath = path.join(getTmpDir(), `step-${Date.now()}-${(seqLog += 1)}.log`);
      fs.writeFileSync(logPath, '');
      const fd = fs.openSync(logPath, 'a');
      let child = null;
      let tailTimer = null;
      let hardTimer = null;
      let seenLines = 0;
      let timedOut = false;
      let done = false;

      function collect() {
        let text;
        try {
          text = fs.readFileSync(logPath, 'utf8');
        } catch {
          return;
        }
        const lines = text.split(/\r?\n/);
        const upto = lines.length - 1; // 最后一行可能还没写完，先不消费
        for (let i = seenLines; i < upto; i += 1) {
          const line = lines[i];
          if (line && onLine) onLine(line);
        }
        if (upto > seenLines) seenLines = upto;
      }

      function finish(code) {
        if (done) return;
        done = true;
        if (tailTimer) clearInterval(tailTimer);
        if (hardTimer) clearTimeout(hardTimer);
        collect();
        try { fs.closeSync(fd); } catch { /* 已关闭 */ }
        let output = '';
        try { output = fs.readFileSync(logPath, 'utf8'); } catch { output = ''; }
        try { fs.unlinkSync(logPath); } catch { /* 临时文件删不掉就算了 */ }
        resolve({ ok: code === 0 && !timedOut, code: timedOut ? 'timeout' : code, output, timedOut });
      }

      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd,
          windowsHide: true,
          stdio: ['ignore', fd, fd], // 关键：不用管道
        });
      } catch (err) {
        try { fs.closeSync(fd); } catch { /* 忽略 */ }
        resolve({ ok: false, code: 'spawn_error', output: String(err && err.message), timedOut: false });
        return;
      }

      child.on('error', (err) => {
        try {
          const fdErr = fs.openSync(logPath, 'a');
          fs.writeSync(fdErr, `[spawn 失败] ${err && err.code ? err.code : ''} ${err && err.message ? err.message : ''}\n`);
          fs.closeSync(fdErr);
        } catch { /* 写不进去就只靠退出码 */ }
        finish(-1);
      });
      child.on('close', (code) => finish(code));

      tailTimer = setInterval(collect, 400);
      hardTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* 进程可能已退出 */ }
      }, timeoutMs);
    });
  }

  /* ---------- 远端命令构造 ---------- */

  function sshArgs(remoteCmd) {
    // BatchMode 保证不会卡在密码提示；StrictHostKeyChecking=accept-new 只首次信任主机指纹。
    return [
      '-i', keyPath,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=12',
      `${NAS_USER}@${NAS_HOST}`,
      remoteCmd,
    ];
  }

  function ssh(remoteCmd, opts = {}) {
    return run(['ssh', ...sshArgs(remoteCmd)], opts);
  }

  /**
   * scp 选项。注意 scp 语义是 `scp [选项] 源... 目的地`：
   * 远端地址必须放在最后，本地文件在它前面（顺序写反会把远端当源文件去读）。
   */
  function scpOptions(useLegacy) {
    const args = ['-i', keyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
    if (useLegacy) args.push('-O'); // NAS 是 BusyBox，没有 sftp-server，必须用旧 scp 协议
    return args;
  }

  /* ---------- 任务日志 ---------- */

  function pushLog(level, text) {
    if (!job) return;
    job.seq += 1;
    job.log.push({ seq: job.seq, at: Date.now(), level, text: String(text).slice(0, 400) });
    if (job.log.length > LOG_LIMIT) job.log.splice(0, job.log.length - LOG_LIMIT);
  }

  function setStep(id, status, detail) {
    if (!job) return;
    const idx = STEPS.findIndex((s) => s.id === id);
    if (idx < 0) return;
    job.stepIndex = idx;
    job.current = id;
    job.steps[idx].status = status; // pending / running / done / failed
    if (detail) job.steps[idx].detail = String(detail).slice(0, 200);
    let base = 0;
    for (let i = 0; i < STEPS.length; i += 1) {
      if (i < idx) base += STEPS[i].weight;
      else if (i === idx && status === 'done') base += STEPS[i].weight;
    }
    if (status === 'running') job.basePercent = base;
    job.percent = Math.min(100, base);
  }

  /* ---------- 本地未推送改动 ---------- */

  function collectFiles(dirpath, acc, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dirpath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dirpath, entry.name);
      if (entry.isDirectory()) collectFiles(full, acc, depth + 1);
      else if (entry.isFile()) acc.push(full);
    }
  }

  function scanPending() {
    const now = Date.now();
    if (pendingCache.data && now - pendingCache.at < PENDING_TTL) return pendingCache.data;
    const since = lastDeploy && lastDeploy.at ? Number(lastDeploy.at) : 0;
    const files = [];
    for (const item of CODE_ITEMS) {
      const full = path.join(rootDir, item);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const acc = [];
        collectFiles(full, acc, 0);
        files.push(...acc);
      } else {
        files.push(full);
      }
    }
    let count = 0;
    let latestMtime = 0;
    const changed = [];
    for (const file of files) {
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtime > latestMtime) latestMtime = mtime;
      if (mtime > since) {
        count += 1;
        if (changed.length < 8) changed.push(path.relative(rootDir, file));
      }
    }
    const data = {
      totalFiles: files.length,
      changedCount: count,
      changedFiles: changed,
      latestMtime,
      since,
    };
    pendingCache = { at: now, data };
    return data;
  }

  /* ---------- NAS 当前状态（按需缓存） ---------- */

  async function nasInfo(force = false) {
    const now = Date.now();
    if (!force && nasInfoCache.data && now - nasInfoCache.at < NAS_INFO_TTL) return nasInfoCache.data;
    const res = await ssh('grep -m1 version /data/gp/package.json; systemctl is-active gp-terminal', { timeoutMs: 30000 });
    let version = '';
    const m = /"version"\s*:\s*"([^"]+)"/.exec(res.output || '');
    if (m) version = m[1];
    let service = '';
    const lines = String(res.output || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/^(active|inactive|failed|activating)/.test(line)) service = line;
    }
    const data = {
      reachable: res.ok,
      version,
      service,
      checkedAt: now,
      message: res.ok ? '' : `无法连接 NAS（${res.timedOut ? '超时' : 'SSH 失败'}）`,
    };
    nasInfoCache = { at: now, data };
    return data;
  }

  /* ---------- 推送主流程 ---------- */

  async function runDeploy() {
    const startedAt = Date.now();
    const pkgPath = path.join(getTmpDir(), 'gp-deploy.tar.gz');
    let sshVersion = '';
    let nasBefore = '';

    try {
      // 1. preflight
      setStep('preflight', 'running');
      pushLog('info', '检查本机 scp / ssh 与部署私钥…');
      if (!fs.existsSync(keyPath)) throw new Error(`缺少部署私钥：${keyPath}`);
      const ver = await run(['ssh', '-V'], { timeoutMs: 15000 });
      const vm = /OpenSSH.*?(\d+)\.(\d+)/.exec(ver.output || '');
      sshVersion = vm ? `${vm[1]}.${vm[2]}` : '';
      pushLog('info', `本机 OpenSSH 版本：${sshVersion || '未知（按默认协议上传）'}`);
      const ping = await ssh('echo PRE_OK; grep -m1 version /data/gp/package.json; systemctl is-active gp-terminal', { timeoutMs: 30000 });
      if (!ping.ok) throw new Error(`无法连接 NAS ${NAS_HOST}：${ping.timedOut ? '连接超时' : 'SSH 认证或网络失败'}`);
      const pm = /"version"\s*:\s*"([^"]+)"/.exec(ping.output || '');
      nasBefore = pm ? pm[1] : '';
      pushLog('info', `NAS 当前版本：${nasBefore || '未知'}，服务状态：${/active/.test(ping.output) ? 'active' : '见日志'}`);
      setStep('preflight', 'done');

      // 2. package
      setStep('package', 'running');
      const items = CODE_ITEMS.filter((item) => fs.existsSync(path.join(rootDir, item)));
      pushLog('info', `打包 ${items.length} 项：${items.join(' ')}`);
      try { fs.unlinkSync(pkgPath); } catch { /* 上次残留 */ }
      const tar = await run(['tar', '-czf', pkgPath, ...items], {
        cwd: rootDir,
        timeoutMs: 180000,
        onLine: (line) => pushLog('warn', line),
      });
      if (!tar.ok) throw new Error(`打包失败：${String(tar.output || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') || 'tar 退出异常'}`);
      const size = fs.statSync(pkgPath).size;
      pushLog('info', `代码包大小 ${(size / 1024 / 1024).toFixed(2)} MB`);
      setStep('package', 'done', `${(size / 1024 / 1024).toFixed(2)} MB`);

      // 3. backup
      setStep('backup', 'running');
      const stamp = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14);
      const backupName = `gp-before-${localVersion || 'x'}-${stamp}.tar.gz`;
      const backup = await ssh(
        `mkdir -p ${BACKUP_DIR} && cd ${NAS_DIR} && tar czf ${BACKUP_DIR}/${backupName} server.js package.json src lib public scripts data/changelog.json && ls -l ${BACKUP_DIR}/${backupName}`,
        { timeoutMs: 180000, sshVersion },
      );
      if (!backup.ok) {
        // 备份失败不阻断推送（例如 NAS 磁盘满），但要明确留痕
        pushLog('warn', `备份未成功（继续推送）：${String(backup.output || '').trim().split(/\r?\n/).slice(-2).join(' / ')}`);
        setStep('backup', 'done', '跳过/失败');
      } else {
        pushLog('info', `备份完成：${backupName}`);
        setStep('backup', 'done', backupName);
      }

      // 4. upload
      setStep('upload', 'running');
      pushLog('info', `上传到 ${REMOTE_PKG}…`);
      // OpenSSH 9 起 scp 默认走 SFTP，而 NAS 是 BusyBox 没有 sftp-server，所以优先用 -O 旧协议。
      const major = Number(String(sshVersion || '').split('.')[0]) || 0;
      const useLegacy = !sshVersion || major >= 9;
      const remoteTarget = `${NAS_USER}@${NAS_HOST}:${REMOTE_PKG}`;
      const uploadProgress = (line) => {
        pushLog('info', line);
        const pm2 = /(\d{1,3})%/.exec(line);
        if (pm2 && job) {
          const sub = Math.min(100, Number(pm2[1]));
          const step = STEPS.find((s) => s.id === 'upload');
          job.percent = Math.min(99, Math.round(job.basePercent + (step.weight * sub) / 100));
        }
      };
      // 注意参数顺序：本地文件在前，远端地址在最后（scp 的语义是 源... 目的地）
      let upload = await run(['scp', ...scpOptions(useLegacy), pkgPath, remoteTarget], {
        timeoutMs: 300000,
        onLine: uploadProgress,
      });
      if (!upload.ok) {
        const retryLegacy = !useLegacy;
        pushLog('warn', retryLegacy ? '默认协议失败，改用 -O（旧 scp 协议）重试…' : '旧协议失败，改用默认（SFTP）协议重试…');
        upload = await run(['scp', ...scpOptions(retryLegacy), pkgPath, remoteTarget], {
          timeoutMs: 300000,
          onLine: uploadProgress,
        });
      }
      if (!upload.ok) throw new Error(`上传失败：${String(upload.output || '').trim().split(/\r?\n/).slice(-3).join(' / ') || 'scp 退出异常'}`);
      setStep('upload', 'done');

      // 5. extract
      setStep('extract', 'running');
      const extract = await ssh(`cd ${NAS_DIR} && tar xzf ${REMOTE_PKG} && echo EXTRACT_OK && grep -m1 version package.json`, { timeoutMs: 180000, sshVersion });
      if (!/EXTRACT_OK/.test(extract.output || '')) {
        throw new Error(`解压失败：${String(extract.output || '').trim().split(/\r?\n/).slice(-3).join(' / ')}`);
      }
      pushLog('info', '代码已覆盖到 /data/gp');
      setStep('extract', 'done');

      // 6. restart
      setStep('restart', 'running');
      pushLog('info', `重启 ${NAS_SERVICE}…`);
      const restart = await ssh(`systemctl restart ${NAS_SERVICE}; sleep 3; systemctl is-active ${NAS_SERVICE}`, { timeoutMs: 90000, sshVersion });
      pushLog('info', String(restart.output || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' / '));
      if (!/\bactive\b/.test(restart.output || '') || /\bfailed\b/.test(restart.output || '')) {
        throw new Error(`重启后服务未进入 active 状态：${String(restart.output || '').trim().slice(-160)}`);
      }
      setStep('restart', 'done');

      // 7. health
      setStep('health', 'running');
      const health = await ssh('curl -s http://127.0.0.1:8090/api/health', { timeoutMs: 60000, sshVersion });
      let nasVersion = '';
      try {
        const parsed = JSON.parse(String(health.output || '').trim());
        nasVersion = String(parsed.version || '');
      } catch {
        nasVersion = '';
      }
      if (!nasVersion) {
        pushLog('warn', '健康接口未返回可解析的 JSON，请看下面原始输出');
        pushLog('warn', String(health.output || '').trim().slice(0, 300));
        throw new Error('健康检查失败：/api/health 返回异常');
      }
      pushLog('info', `NAS 健康检查通过，线上版本：${nasVersion}`);
      if (localVersion && nasVersion !== localVersion) {
        pushLog('warn', `版本不一致：本机 ${localVersion} / NAS ${nasVersion}（若刚改过版本号，请确认 package.json 已随包上传）`);
      }
      const errTail = await ssh(`tail -n 12 ${NAS_DIR}/logs/server.log 2>/dev/null`, { timeoutMs: 30000, sshVersion });
      const errLines = String(errTail.output || '').split(/\r?\n/).filter((l) => /error|Error|ERROR|stack/.test(l)).slice(-4);
      for (const line of errLines) pushLog('warn', `启动日志：${line.slice(0, 200)}`);
      // 刚做完健康检查，直接把这批结果写进缓存，前端下一次轮询就能看到 NAS 版本（省一次 SSH）
      nasInfoCache = {
        at: Date.now(),
        data: {
          reachable: true,
          version: nasVersion,
          service: 'active',
          checkedAt: Date.now(),
          message: '',
        },
      };
      pendingCache = { at: 0, data: null };
      setStep('health', 'done', `线上版本 ${nasVersion}`);

      job.status = 'success';
      job.percent = 100;
      const durationMs = Date.now() - startedAt;
      writeLastDeploy({
        at: Date.now(),
        ok: true,
        fromVersion: localVersion,
        nasVersion,
        previousNasVersion: nasBefore,
        durationMs,
        backup: backupName,
      });
      pushLog('info', `推送完成，用时 ${(durationMs / 1000).toFixed(1)} 秒`);
    } catch (err) {
      job.status = 'failed';
      job.error = err.message || String(err);
      if (job.steps[job.stepIndex] && job.steps[job.stepIndex].status === 'running') {
        job.steps[job.stepIndex].status = 'failed';
      }
      pushLog('error', `推送失败：${job.error}`);
      writeLastDeploy({
        at: Date.now(),
        ok: false,
        fromVersion: localVersion,
        nasVersion: '',
        previousNasVersion: nasBefore,
        durationMs: Date.now() - startedAt,
        error: job.error,
      });
    } finally {
      try { fs.unlinkSync(pkgPath); } catch { /* 临时包删不掉不影响 */ }
      job.finishedAt = Date.now();
    }
  }

  function newJob() {
    return {
      id: `dep-${Date.now().toString(36)}`,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      percent: 0,
      basePercent: 0,
      stepIndex: 0,
      current: '',
      error: '',
      seq: 0,
      log: [],
      steps: STEPS.map((s) => ({ id: s.id, label: s.label, weight: s.weight, status: 'pending', detail: '' })),
    };
  }

  function start() {
    if (!supported) {
      throw Object.assign(new Error('本机才有源文件，NAS 上不能自行推送'), { status: 400 });
    }
    if (job && job.status === 'running') {
      throw Object.assign(new Error('已有推送任务正在进行'), { status: 409 });
    }
    job = newJob();
    runDeploy();
    return { id: job.id };
  }

  function snapshot() {
    const pending = supported ? scanPending() : null;
    return {
      ok: true,
      supported,
      platform: process.platform,
      host: NAS_HOST,
      target: `${NAS_DIR} · ${NAS_SERVICE}`,
      localVersion,
      last: lastDeploy,
      pending,
      job: job
        ? {
            id: job.id,
            status: job.status,
            percent: job.percent,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            current: job.current,
            error: job.error,
            steps: job.steps.map((s) => ({ ...s })),
            log: job.log.slice(-120),
          }
        : null,
      nas: nasInfoCache.data || null,
    };
  }

  /** 供 status 接口异步补 NAS 实时信息（缓存期内不重复 SSH） */
  async function snapshotWithNas() {
    const snap = snapshot();
    if (supported) {
      try {
        snap.nas = await nasInfo();
      } catch {
        snap.nas = snap.nas || { reachable: false, version: '', message: 'NAS 状态查询失败' };
      }
    }
    return snap;
  }

  return { start, snapshot, snapshotWithNas, nasInfo, supported, path: { keyPath, rootDir, stateFile } };
}

module.exports = { createDeployToNas, STEPS, CODE_ITEMS, NAS_HOST };
