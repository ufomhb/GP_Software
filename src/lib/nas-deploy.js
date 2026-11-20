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
// 数据库相关的两步（dbsafe / schema）是 2026-11-17 加的：
// 代码推送不会动 NAS 上的 data/gp.sqlite，所以推送前先做一致性快照，
// 重启后再核对「代码期望的结构」与「线上实际结构」是否一致。
const STEPS = [
  { id: 'preflight', label: '检查本机工具与 NAS 连通性', weight: 6 },
  { id: 'package', label: '打包本地最新代码', weight: 8 },
  { id: 'backup', label: '备份 NAS 现有代码', weight: 11 },
  { id: 'dbsafe', label: '备份 NAS 数据库快照', weight: 9 },
  { id: 'upload', label: '上传代码包到 NAS', weight: 22 },
  { id: 'extract', label: '解压覆盖到 /data/gp', weight: 7 },
  { id: 'migrate', label: '执行数据库结构迁移', weight: 11 },
  { id: 'restart', label: '重启 gp-terminal 服务', weight: 11 },
  { id: 'schema', label: '核对数据库结构', weight: 7 },
  { id: 'health', label: '健康检查与版本核对', weight: 8 },
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
    let nasNode = '/data/node24/bin/node';

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
      // NAS 上的 node 位置（数据库快照/结构核对要直接调它，不依赖登录 shell 的 PATH）
      const nodeProbe = await ssh('command -v node || ls -1 /data/node24/bin/node 2>/dev/null', { timeoutMs: 20000 });
      const nodeLine = String(nodeProbe.output || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
      if (nodeLine && /node/.test(nodeLine)) nasNode = nodeLine;
      pushLog('info', `NAS 上的 node：${nasNode}`);
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

      // 3.5 数据库快照：代码不推 data/，但改结构前必须先有一份可回滚的库。
      // VACUUM INTO 是在线一致性快照，服务在跑也能安全执行；失败只告警不阻断。
      setStep('dbsafe', 'running');
      const dbSnapName = `gp-before-${localVersion || 'x'}-${stamp}.sqlite`;
      const dbBackup = await ssh(
        `cd ${NAS_DIR} && if [ -f data/gp.sqlite ]; then ${nasNode} scripts/backup-sqlite.mjs /data/backup/gp-data/${dbSnapName}; else echo NO_SQLITE; fi`,
        { timeoutMs: 240000 },
      );
      if (!dbBackup.ok) {
        pushLog('warn', `数据库快照未成功（继续推送）：${String(dbBackup.output || '').trim().split(/\r?\n/).slice(-2).join(' / ')}`);
        setStep('dbsafe', 'done', '跳过/失败');
      } else if (/NO_SQLITE/.test(dbBackup.output || '')) {
        pushLog('info', 'NAS 上没有 SQLite 库（JSON 存储模式），跳过数据库快照');
        setStep('dbsafe', 'done', 'JSON 模式跳过');
      } else {
        pushLog('info', `数据库快照完成：${dbSnapName}`);
        setStep('dbsafe', 'done', dbSnapName);
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

      // 6. 数据库迁移：用刚上传的新代码把库升到新结构（脚本内部按 PRAGMA user_version 逐条执行）。
      // 特意放在重启之前：迁移失败时线上进程仍跑旧代码，可以立刻回滚文件，站点不受影响。
      setStep('migrate', 'running');
      const migrate = await ssh(`cd ${NAS_DIR} && ${nasNode} scripts/migrate.mjs`, { timeoutMs: 240000 });
      const migrateLines = String(migrate.output || '').trim().split(/\r?\n/).filter(Boolean);
      for (const line of migrateLines.slice(0, 12)) pushLog(migrate.ok ? 'info' : 'warn', line);
      if (!migrate.ok) {
        pushLog('warn', '迁移失败，回滚 /data/gp 代码到推送前的备份…');
        const restore = await ssh(`cd ${NAS_DIR} && tar xzf ${BACKUP_DIR}/${backupName} && echo CODE_RESTORED`, { timeoutMs: 180000 });
        if (/CODE_RESTORED/.test(restore.output || '')) {
          pushLog('info', `已回滚代码（${backupName}），数据库未改动，线上服务继续按旧代码运行`);
          throw new Error(`数据库迁移失败，代码已自动回滚、数据库未改动（数据库快照：${dbSnapName}）`);
        }
        throw new Error(`数据库迁移失败，且代码回滚未成功，请人工恢复：cd ${NAS_DIR} && tar xzf ${BACKUP_DIR}/${backupName}`);
      }
      setStep('migrate', 'done', migrateLines[0] || '无需迁移');

      // 6. restart
      setStep('restart', 'running');
      pushLog('info', `重启 ${NAS_SERVICE}…`);
      const restart = await ssh(`systemctl restart ${NAS_SERVICE}; sleep 3; systemctl is-active ${NAS_SERVICE}`, { timeoutMs: 90000, sshVersion });
      pushLog('info', String(restart.output || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' / '));
      if (!/\bactive\b/.test(restart.output || '') || /\bfailed\b/.test(restart.output || '')) {
        throw new Error(`重启后服务未进入 active 状态：${String(restart.output || '').trim().slice(-160)}`);
      }
      setStep('restart', 'done');

      // 7. schema：代码结构 vs 线上库结构对照。
      // 推送不动 data/gp.sqlite，所以「加列/改约束」这类改动不会自动生效；
      // 这里把问题变成一次明确的失败提示（而不是等某个接口静默 500）。
      setStep('schema', 'running');
      const schemaCheck = await ssh(`cd ${NAS_DIR} && ${nasNode} scripts/check-schema.mjs`, { timeoutMs: 120000 });
      const schemaLines = String(schemaCheck.output || '').trim().split(/\r?\n/).filter(Boolean);
      for (const line of schemaLines.slice(0, 14)) pushLog(schemaCheck.ok ? 'info' : 'warn', line);
      if (!schemaCheck.ok) {
        throw new Error('数据库结构与新代码不一致：服务已重启，缺表/缺列的接口会报错。请按上面的差异做迁移，或回滚代码（数据库快照已生成）');
      }
      setStep('schema', 'done', schemaLines[0] || '一致');

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

  /* ---------------------------------------------------------
     持仓数据互通（v2.9.2）
     ---------------------------------------------------------
     部署只同步代码、不动 NAS 的 data/，所以本机与线上的持仓是两套。
     这里复用同一把 SSH 私钥与同一套 scp 语义，把「本机账号的持仓 JSON」
     推给 NAS（在 NAS 上跑 scripts/portfolio-import.mjs），或反向拉回来。
     --------------------------------------------------------- */
  async function nasNodeBin() {
    const res = await ssh('command -v node', { timeoutMs: 20000 });
    const line = String(res.output || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((l) => /(^|\/)node$/.test(l));
    return line || '/data/node24/bin/node';
  }

  async function scpRun(from, to, { timeoutMs = 120000 } = {}) {
    // NAS 是 BusyBox：OpenSSH 9+ 默认走 SFTP 会失败，先用 -O 旧协议，失败再退回默认
    let res = await run(['scp', ...scpOptions(true), from, to], { timeoutMs });
    if (!res.ok) res = await run(['scp', ...scpOptions(false), from, to], { timeoutMs });
    return res;
  }

  /** 本机 → NAS：把导出的持仓 JSON 交给 NAS 上的 portfolio-import.mjs */
  async function pushPortfolio({ file, remoteFile, userId, mode = 'merge', dryRun = false } = {}) {
    if (!supported) throw Object.assign(new Error('只有本机才能把持仓推送到 NAS'), { status: 400 });
    if (!file || !fs.existsSync(file)) throw new Error('待推送的持仓文件不存在');
    if (!userId) throw new Error('缺少账号 ID');
    const remote = remoteFile || `/tmp/gp-portfolio-push-${Date.now()}.json`;
    const probe = await ssh(`cd ${NAS_DIR} && test -f scripts/portfolio-import.mjs && echo HAS_IMPORT`, { timeoutMs: 25000 });
    if (!/HAS_IMPORT/.test(String(probe.output || ''))) {
      throw new Error('NAS 上还没有 scripts/portfolio-import.mjs：请先用后台「部署到 NAS」推送一次代码，再做数据互通');
    }
    if (dryRun) return { ok: true, dryRun: true, remoteFile: remote };
    const up = await scpRun(file, `${NAS_USER}@${NAS_HOST}:${remote}`);
    if (!up.ok) throw new Error(`上传持仓文件失败：${String(up.output || '').trim().split(/\r?\n/).slice(-2).join(' / ') || 'scp 退出异常'}`);
    const node = await nasNodeBin();
    const cmd = `cd ${NAS_DIR} && ${node} scripts/portfolio-import.mjs ${remote} --user=${userId} --mode=${mode}`;
    const imported = await ssh(cmd, { timeoutMs: 180000 });
    await ssh(`rm -f ${remote}`, { timeoutMs: 20000 });
    if (!imported.ok) {
      throw new Error(`NAS 导入持仓失败：${String(imported.output || '').trim().split(/\r?\n/).slice(-3).join(' / ') || '脚本退出异常'}`);
    }
    return {
      ok: true,
      dryRun: false,
      remoteFile: remote,
      output: String(imported.output || '').trim().slice(-600),
    };
  }

  /** NAS → 本机：让 NAS 导出某账号的持仓 JSON 并拉回来 */
  async function pullPortfolio({ file, remoteFile, userId } = {}) {
    if (!supported) throw Object.assign(new Error('只有本机才能从 NAS 拉取持仓'), { status: 400 });
    if (!file) throw new Error('缺少本地落盘路径');
    if (!userId) throw new Error('缺少账号 ID');
    const remote = remoteFile || `/tmp/gp-portfolio-pull-${Date.now()}.json`;
    const probe = await ssh(`cd ${NAS_DIR} && test -f scripts/portfolio-export.mjs && echo HAS_EXPORT`, { timeoutMs: 25000 });
    if (!/HAS_EXPORT/.test(String(probe.output || ''))) {
      throw new Error('NAS 上还没有 scripts/portfolio-export.mjs：请先用后台「部署到 NAS」推送一次代码，再做数据互通');
    }
    const node = await nasNodeBin();
    const exported = await ssh(`cd ${NAS_DIR} && ${node} scripts/portfolio-export.mjs --user=${userId} --out=${remote}`, { timeoutMs: 120000 });
    if (!exported.ok) {
      throw new Error(`NAS 导出持仓失败：${String(exported.output || '').trim().split(/\r?\n/).slice(-3).join(' / ') || '脚本退出异常'}`);
    }
    const down = await scpRun(`${NAS_USER}@${NAS_HOST}:${remote}`, file);
    await ssh(`rm -f ${remote}`, { timeoutMs: 20000 });
    if (!down.ok) throw new Error(`下载持仓文件失败：${String(down.output || '').trim().split(/\r?\n/).slice(-2).join(' / ') || 'scp 退出异常'}`);
    return { ok: true, remoteFile: remote, output: String(exported.output || '').trim().slice(-600) };
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

  return {
    start,
    snapshot,
    snapshotWithNas,
    nasInfo,
    pushPortfolio,
    pullPortfolio,
    supported,
    path: { keyPath, rootDir, stateFile },
  };
}

module.exports = { createDeployToNas, STEPS, CODE_ITEMS, NAS_HOST };
