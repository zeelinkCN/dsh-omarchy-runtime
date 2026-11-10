import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const LABEL_OWNER = 'io.dsh.omarchy.owner';
const LABEL_WORKSPACE = 'io.dsh.omarchy.workspace';
const MAX_OUTPUT = 128 * 1024;
const CAVEATS = [
  'Containers are not a strict security sandbox; Arch may run as root.',
  'Idle suspension stops containers to release RAM; it does not pause them.',
  'Disk quotas are unsupported. Snapshots include rootfs only, not project bind mounts.',
  'Images must already be cached locally; this runtime never downloads images.',
];

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function safeId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    throw failure('INVALID_WORKSPACE_ID', 'Workspace IDs must contain 1–64 letters, numbers, underscores or hyphens.');
  }
  return id;
}
function bounded(value, bytes = MAX_OUTPUT) {
  const text = Buffer.from(String(value || '')).subarray(0, bytes).toString('utf8');
  // A cut UTF-8 sequence becomes a three-byte replacement character; remove it
  // if decoding would otherwise exceed the byte budget.
  return Buffer.byteLength(text) > bytes ? text.slice(0, -1) : text;
}
function positive(value, name, allowZero = false) {
  if (!Number.isFinite(value) || value < (allowZero ? 0 : Number.MIN_VALUE)) throw failure('INVALID_CONFIG', `${name} must be ${allowZero ? 'nonnegative' : 'positive'}.`);
  return value;
}

// Runner contract: runner(executable, argv, {timeoutMs, signal, maxOutputBytes})
// resolves {code, stdout, stderr, timedOut?, aborted?, stdoutTruncated?, stderrTruncated?}.
// Arguments are never interpreted by a host shell.
function spawnRunner(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(failure('ABORTED', 'Operation aborted.'));
    let child;
    try { child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    const limit = options.maxOutputBytes || MAX_OUTPUT;
    const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 }, truncated = {};
    let timedOut = false, aborted = false, settled = false;
    const capture = (stream, chunk) => {
      const remaining = Math.max(0, limit - sizes[stream]);
      if (chunk.length > remaining) truncated[stream] = true;
      if (remaining) { chunks[stream].push(chunk.subarray(0, remaining)); sizes[stream] += Math.min(remaining, chunk.length); }
    };
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    const abort = () => { aborted = true; child.kill('SIGKILL'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs || 30000);
    timer.unref?.();
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ code: code ?? -1, signal, stdout: bounded(Buffer.concat(chunks.stdout), limit), stderr: bounded(Buffer.concat(chunks.stderr), limit), timedOut, aborted,
        stdoutTruncated: !!truncated.stdout, stderrTruncated: !!truncated.stderr });
    });
  });
}

/**
 * Standalone Docker runtime. Instantiate once per dataDir (registry writes and
 * lifecycle operations are serialized within that instance). Hosts schedule
 * sweep() themselves. A zero idle threshold disables that policy. dispose()
 * closes this object without deleting or stopping persistent containers.
 *
 * ensureWorkspace/resume/stop/suspend -> workspace record with inspected state.
 * exec -> bounded {workspaceId, exitCode, stdout, stderr, timedOut, ...}.
 * status -> diagnostics, errors, workspaces and capability flags.
 * snapshot -> cached rootfs image metadata; restore rejects explicitly.
 */
class Runtime {
  constructor({ dataDir, engine = 'docker', executable, image = 'archlinux:base', cpus = 2, memoryMB = 2048, idleMinutes = 10, ephemeralMinutes = 30, runner = spawnRunner } = {}) {
    if (!dataDir || typeof dataDir !== 'string') throw failure('INVALID_CONFIG', 'dataDir is required.');
    if (!['docker', 'podman'].includes(engine)) throw failure('UNSUPPORTED_ENGINE', 'Only Docker and Podman CLI backends are supported.');
    if (typeof image !== 'string' || !image || image.startsWith('-')) throw failure('INVALID_CONFIG', 'A valid cached Docker image reference is required.');
    if (typeof runner !== 'function') throw failure('INVALID_CONFIG', 'runner must be a function.');
    this.dataDir = path.resolve(dataDir);
    this.engine = engine; this.image = image;
    this.cpus = positive(cpus, 'cpus'); this.memoryMB = positive(memoryMB, 'memoryMB');
    this.idleMinutes = positive(idleMinutes, 'idleMinutes', true);
    this.ephemeralMinutes = positive(ephemeralMinutes, 'ephemeralMinutes', true);
    this.runner = runner;
    this.executable = executable || (process.platform === 'win32' ? `${engine}.exe` : engine);
    this.platform = process.arch === 'arm64' ? 'linux/amd64' : undefined;
    this._registry = null; this._tail = Promise.resolve(); this._busy = new Map(); this._logs = []; this._disposed = false;
  }

  _serial(operation, allowDisposed = false) {
    const run = this._tail.then(async () => {
      if (this._disposed && !allowDisposed) throw failure('DISPOSED', 'Runtime is disposed.');
      await this._load();
      return operation();
    });
    this._tail = run.catch(() => {});
    return run;
  }

  async _load() {
    if (this._registry) return;
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.dataDir, 'registry.json'), 'utf8'));
      if (value.version !== 1 || typeof value.owner !== 'string' || !/^[a-f0-9-]{36}$/.test(value.owner) || !value.workspaces || typeof value.workspaces !== 'object' || Array.isArray(value.workspaces)) throw new Error('Invalid registry schema');
      for (const [id, record] of Object.entries(value.workspaces)) {
        safeId(id);
        if (record.id !== id || !/^[a-f0-9]{12,64}$/.test(record.containerId) || !['persistent', 'ephemeral'].includes(record.mode) || !Number.isFinite(record.lastActiveAt) || !Array.isArray(record.snapshots)) throw new Error('Invalid workspace record');
      }
      this._registry = value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw failure('REGISTRY_INVALID', `Cannot read runtime registry: ${error.message}`);
      this._registry = { version: 1, owner: randomUUID(), workspaces: {} };
      await this._save();
    }
  }

  async _save() {
    const temp = path.join(this.dataDir, `registry.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(this._registry, null, 2));
      await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp, path.join(this.dataDir, 'registry.json'));
    } finally {
      await handle?.close();
      await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  _event(action, id, extra = {}) {
    this._logs.push({ at: new Date().toISOString(), action, workspaceId: id, ...extra });
    if (this._logs.length > 200) this._logs.shift();
  }

  async _run(args, options = {}, allowFailure = false) {
    let result;
    try { result = await this.runner(this.executable, args, { timeoutMs: 30000, maxOutputBytes: MAX_OUTPUT, ...options }); }
    catch (error) {
      // Never include argv or runner error messages: exec arguments may contain secrets.
      throw failure(error.code === 'ENOENT' ? 'ENGINE_UNAVAILABLE' : error.code === 'ABORTED' ? 'ABORTED' : 'ENGINE_ERROR', error.code === 'ENOENT' ? 'Container engine CLI is unavailable.' : 'Container engine CLI could not complete the operation.');
    }
    result = { ...result, stdout: bounded(result.stdout), stderr: bounded(result.stderr),
      stdoutTruncated: !!result.stdoutTruncated || Buffer.byteLength(String(result.stdout || '')) > MAX_OUTPUT,
      stderrTruncated: !!result.stderrTruncated || Buffer.byteLength(String(result.stderr || '')) > MAX_OUTPUT };
    if (!allowFailure && (result.code !== 0 || result.timedOut || result.aborted)) {
      throw failure(result.aborted ? 'ABORTED' : result.timedOut ? 'CLI_TIMEOUT' : 'ENGINE_ERROR', `Container engine ${args[0]} failed${result.timedOut ? ' (timeout)' : ''}.`);
    }
    return result;
  }

  async _inspect(record) {
    const result = await this._run(['container', 'inspect', record.containerId], {}, true);
    if (result.code !== 0) {
      if (/no such (object|container)/i.test(result.stderr)) return { state: 'missing', raw: null };
      throw failure('INSPECT_FAILED', 'Docker container inspection failed.');
    }
    let value;
    try { value = JSON.parse(result.stdout)[0]; if (!value?.State || !value?.Config) throw new Error(); }
    catch { throw failure('INSPECT_FAILED', 'Docker returned invalid inspection data.'); }
    if (value.Config.Labels?.[LABEL_OWNER] !== this._registry.owner || value.Config.Labels?.[LABEL_WORKSPACE] !== record.id) throw failure('OWNERSHIP_MISMATCH', 'Container ownership labels do not match this runtime and workspace.');
    return { state: value.State.Status || (value.State.Running ? 'running' : 'exited'), raw: value };
  }

  _record(id) {
    safeId(id);
    if (!Object.hasOwn(this._registry.workspaces, id)) throw failure('WORKSPACE_NOT_FOUND', 'Workspace does not exist.');
    return this._registry.workspaces[id];
  }

  _view(record, state) { return { ...record, snapshots: record.snapshots.map(item => ({ ...item })), state, busy: this._busy.get(record.id) || 0 }; }

  async _cachedImage(image) {
    const result = await this._run(['image', 'inspect', image], {}, true);
    if (result.code !== 0) throw failure('IMAGE_NOT_CACHED', `Required image is not cached locally: ${image}. Download it explicitly outside this runtime.`);
    let details;
    try { details = JSON.parse(result.stdout)[0]; if (!details) throw new Error(); }
    catch { throw failure('IMAGE_INSPECT_FAILED', 'Docker returned invalid image inspection data.'); }
    if (details.Os && details.Os !== 'linux') throw failure('IMAGE_PLATFORM_MISMATCH', 'The runtime requires a Linux image.');
    if (this.platform && details.Architecture && details.Architecture !== 'amd64') throw failure('IMAGE_PLATFORM_MISMATCH', 'On arm64 hosts this runtime requires a cached linux/amd64 image.');
    return details;
  }

  _createArgs(record, image) {
    const args = ['container', 'create', '--name', `dsh-omarchy-${this._registry.owner.slice(0, 8)}-${record.id}-${randomUUID().slice(0, 8)}`,
      '--label', `${LABEL_OWNER}=${this._registry.owner}`, '--label', `${LABEL_WORKSPACE}=${record.id}`,
      '--network', 'bridge', '--cpus', String(this.cpus), '--memory', `${this.memoryMB}m`, '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '256'];
    if (this.platform) args.push('--platform', this.platform);
    if (record.projectPath) args.push('--mount', `type=bind,source=${record.projectPath},target=/workspace`);
    args.push('--workdir', '/workspace', '--entrypoint', '/bin/bash', image, '-lc', 'while :; do sleep 3600; done');
    return args;
  }

  status() {
    return this._serial(async () => {
      const diagnostics = { platform: os.platform(), arch: os.arch(), engine: this.engine, executable: this.executable, available: false, cliAvailable: false, daemonAvailable: false,
        image: this.image, imageCached: false, guestPlatform: this.platform || 'linux/native', warnings: [...CAVEATS] };
      if (this.platform) diagnostics.warnings.push('linux/amd64 on arm64 requires engine emulation and may be slower or unavailable.');
      const errors = [];
      try {
        await this._run(['--version']); diagnostics.cliAvailable = true;
        await this._run(['info', '--format', '{{json .ServerVersion}}']); diagnostics.daemonAvailable = true;
        try { await this._cachedImage(this.image); diagnostics.imageCached = true; diagnostics.available = true; } catch (error) { errors.push({ code: error.code, message: error.message }); }
      } catch (error) { errors.push({ code: error.code, message: error.message }); }
      const workspaces = [];
      for (const record of Object.values(this._registry.workspaces)) {
        if (!diagnostics.daemonAvailable) { workspaces.push(this._view(record, 'unknown')); continue; }
        try {
          const inspected = await this._inspect(record);
          const view = this._view(record, inspected.state);
          view.network = { address: inspected.raw?.NetworkSettings?.IPAddress || null, mode: 'bridge' };
          if (inspected.state === 'running') {
            try {
              const sampled = await this._run(['stats', '--no-stream', '--format', '{{json .}}', record.containerId], { timeoutMs: 5000 }, true);
              if (sampled.code === 0) {
                const stats = JSON.parse(sampled.stdout);
                view.usage = { cpu: stats.CPUPerc || null, memory: stats.MemUsage || null, memoryPercent: stats.MemPerc || null, network: stats.NetIO || null, disk: stats.BlockIO || null };
              }
            } catch { /* Stats are optional; retain the inspected workspace state. */ }
          }
          workspaces.push(view);
        }
        catch (error) { workspaces.push({ ...this._view(record, 'unknown'), error: { code: error.code, message: error.message } }); }
      }
      return { ...diagnostics, diagnostics, errors, workspaces, capabilities: { exec: true, projectBind: true, suspend: 'stop', diskCap: false, snapshot: 'rootfs-only', restore: false, strictSecuritySandbox: false, hostFallback: false } };
    });
  }

  async _ensure({ workspaceId, projectPath, mode = 'persistent' } = {}) {
    const id = safeId(workspaceId ?? `ws-${randomUUID()}`);
    mode = mode === 'shared' || mode === 'isolated' ? 'persistent' : mode;
    if (!['persistent', 'ephemeral'].includes(mode)) throw failure('INVALID_MODE', 'mode must be shared, isolated or ephemeral.');
    let resolved;
    if (projectPath != null) {
      if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw failure('INVALID_PROJECT_PATH', 'projectPath must be an absolute directory path.');
      resolved = await fs.realpath(projectPath);
      if (!(await fs.stat(resolved)).isDirectory() || resolved.includes(',') || /[\r\n\0]/.test(resolved)) throw failure('INVALID_PROJECT_PATH', 'Project bind path is not a supported directory.');
      const forbidden = [path.parse(resolved).root, os.homedir(), '/var/run', '/run', '/proc', '/sys', '/dev', '/etc', '/Applications'];
      if (forbidden.some(item => resolved === item || (['/var/run', '/run', '/proc', '/sys', '/dev'].includes(item) && resolved.startsWith(`${item}${path.sep}`)))) throw failure('UNSAFE_PROJECT_PATH', 'Bind a specific project directory, not a host system directory or home/root.');
    }
    if (Object.hasOwn(this._registry.workspaces, id)) {
      const record = this._record(id);
      if (resolved && resolved !== record.projectPath) throw failure('WORKSPACE_CONFLICT', 'Workspace is bound to a different project.');
      const inspected = await this._inspect(record);
      if (inspected.state === 'missing') throw failure('CONTAINER_MISSING', 'Workspace container is missing; destroy the stale record before recreating.');
      if (inspected.state === 'paused') await this._run(['container', 'unpause', record.containerId]);
      else if (inspected.state !== 'running') await this._run(['container', 'start', record.containerId]);
      record.lastActiveAt = Date.now(); await this._save();
      return this._view(record, (await this._inspect(record)).state);
    }
    await this._cachedImage(this.image);
    const record = { id, mode, projectPath: resolved || null, image: this.image, createdAt: Date.now(), lastActiveAt: Date.now(), snapshots: [] };
    const created = await this._run(this._createArgs(record, this.image));
    record.containerId = created.stdout.trim();
    if (!/^[a-f0-9]{12,64}$/.test(record.containerId)) throw failure('CREATE_FAILED', 'Docker did not return a valid container ID.');
    // Save before start so an interrupted start never loses track of the owned container.
    this._registry.workspaces[id] = record; await this._save();
    await this._inspect(record);
    await this._run(['container', 'start', record.containerId]);
    this._event('create', id);
    return this._view(record, (await this._inspect(record)).state);
  }

  ensureWorkspace(options = {}) { return this._serial(() => this._ensure(options)); }

  async exec({ workspaceId, projectPath, command, cwd = '/workspace', timeoutSec = 60 } = {}, signal) {
    if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw failure('INVALID_COMMAND', 'command must be a nonempty string without NUL.');
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) throw failure('INVALID_CWD', 'cwd must be an absolute guest path.');
    positive(timeoutSec, 'timeoutSec');
    if (timeoutSec > 86400) throw failure('INVALID_TIMEOUT', 'timeoutSec must not exceed 86400.');
    if (signal?.aborted) throw failure('ABORTED', 'Operation aborted.');
    const record = await this._serial(async () => {
      const workspace = await this._ensure({ workspaceId, projectPath });
      const record = this._record(workspace.id);
      this._busy.set(record.id, (this._busy.get(record.id) || 0) + 1);
      this._event('exec', record.id, { preview: '<command redacted>' });
      return { ...record };
    });
    // Abort detaches the Docker client, but guest timeout remains in force and the
    // busy reservation remains until that maximum lifetime passes.
    let releaseDelay = 0;
    try {
      const result = await this._run(['container', 'exec', '--workdir', cwd, record.containerId, 'timeout', '--signal=TERM', '--kill-after=5s', `${timeoutSec}s`, '/bin/bash', '-lc', command],
        { signal, timeoutMs: Math.ceil((timeoutSec + 10) * 1000) }, true);
      if (result.aborted) releaseDelay = (timeoutSec + 5) * 1000;
      return { workspaceId: record.id, ...result, exitCode: result.code, timedOut: !!result.timedOut || result.code === 124 || result.code === 137, commandPreview: '<command redacted>' };
    } catch (error) {
      if (error.code === 'ABORTED' || error.code === 'ENGINE_ERROR') releaseDelay = (timeoutSec + 5) * 1000;
      throw error;
    } finally {
      const release = () => this._serial(async () => {
        const busy = (this._busy.get(record.id) || 1) - 1;
        if (busy) this._busy.set(record.id, busy); else this._busy.delete(record.id);
        if (Object.hasOwn(this._registry.workspaces, record.id)) { this._registry.workspaces[record.id].lastActiveAt = Date.now(); await this._save(); }
      }, true);
      if (releaseDelay) { const timer = setTimeout(() => release().catch(() => {}), releaseDelay); timer.unref?.(); }
      else await release();
    }
  }

  async _stop(record) {
    if (this._busy.get(record.id)) throw failure('WORKSPACE_BUSY', 'Workspace has an active command.');
    const inspected = await this._inspect(record);
    if (inspected.state === 'missing') return this._view(record, 'missing');
    if (inspected.state === 'paused') await this._run(['container', 'unpause', record.containerId]);
    if (!['exited', 'created', 'dead'].includes(inspected.state)) await this._run(['container', 'stop', '--time', '10', record.containerId]);
    this._event('stop', record.id);
    return this._view(record, (await this._inspect(record)).state);
  }
  stop(id) { return this._serial(() => this._stop(this._record(id))); }
  suspend(id) { return this.stop(id); }
  resume(id) { return this._serial(async () => { const record = this._record(id); return this._ensure({ workspaceId: id, mode: record.mode }); }); }

  async _destroy(record) {
    if (this._busy.get(record.id)) throw failure('WORKSPACE_BUSY', 'Workspace has an active command.');
    if ((await this._inspect(record)).state !== 'missing') await this._run(['container', 'rm', '--force', record.containerId]);
    delete this._registry.workspaces[record.id]; await this._save();
    this._event('destroy', record.id);
    return { workspaceId: record.id, state: 'destroyed', retainedSnapshots: record.snapshots.map(item => ({ ...item })) };
  }
  destroy(id) { return this._serial(() => this._destroy(this._record(id))); }

  snapshot(id, name) {
    return this._serial(async () => {
      const record = this._record(id);
      if (this._busy.get(id)) throw failure('WORKSPACE_BUSY', 'Workspace has an active command.');
      if (name != null && (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(name))) throw failure('INVALID_SNAPSHOT_NAME', 'Snapshot name must be 1–64 simple characters.');
      if ((await this._inspect(record)).state === 'missing') throw failure('CONTAINER_MISSING', 'Workspace container is missing.');
      const snapshotId = randomUUID();
      const image = `dsh-omarchy-snapshot:${this._registry.owner.slice(0, 8)}-${snapshotId}`;
      await this._run(['container', 'commit', '--pause=true', '--change', `LABEL ${LABEL_OWNER}=${this._registry.owner}`, '--change', `LABEL ${LABEL_WORKSPACE}=${id}`, record.containerId, image]);
      const snapshot = { id: snapshotId, name: name || snapshotId, image, createdAt: Date.now(), scope: 'rootfs-only', projectBindIncluded: false };
      record.snapshots.push(snapshot); await this._save(); this._event('snapshot', id);
      return { ...snapshot };
    });
  }

  restore(id, snapshotId) {
    return this._serial(async () => {
      this._record(id);
      throw failure('RESTORE_UNSUPPORTED', 'Automatic rootfs replacement is unsupported because it risks losing the current container. Snapshots are cached Docker images; project bind data is never included.');
    });
  }

  sweep() {
    return this._serial(async () => {
      const actions = [], now = Date.now();
      for (const record of Object.values(this._registry.workspaces)) {
        if (this._busy.get(record.id)) continue;
        const threshold = record.mode === 'ephemeral' ? this.ephemeralMinutes : this.idleMinutes;
        if (!threshold || now - record.lastActiveAt < threshold * 60000) continue;
        try {
          if (record.mode === 'ephemeral') { await this._destroy(record); actions.push({ workspaceId: record.id, action: 'destroy' }); }
          else if (['running', 'paused', 'restarting'].includes((await this._inspect(record)).state)) { await this._stop(record); actions.push({ workspaceId: record.id, action: 'stop' }); }
        } catch (error) { actions.push({ workspaceId: record.id, error: { code: error.code, message: error.message } }); }
      }
      return { actions };
    });
  }

  logs() { return this._logs.map(entry => ({ ...entry })); }
  dispose() { return this._serial(async () => { this._disposed = true; return { disposed: true }; }, true); }
}

export { Runtime, spawnRunner };
export default Runtime;
