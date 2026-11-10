import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Runtime, spawnRunner } from './runtime.js';

function fakeDocker() {
  const calls = [], containers = new Map();
  let count = 0;
  const fake = {
    calls, containers, cached: true, cli: true, daemon: true, execResult: { code: 0, stdout: 'guest output', stderr: '' },
    async runner(executable, args, options) {
      calls.push({ executable, args: [...args], options });
      if (!fake.cli) throw Object.assign(new Error('missing docker'), { code: 'ENOENT' });
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      const bad = (stderr = 'failed') => ({ code: 1, stdout: '', stderr });
      if (args[0] === '--version') return ok('Docker fake');
      if (!fake.daemon) return bad('Cannot connect to the Docker daemon');
      if (args[0] === 'info') return ok('"fake-version"');
      if (args[0] === 'image') return fake.cached ? ok(JSON.stringify([{ Os: 'linux', Architecture: 'amd64' }])) : bad('No such image');
      if (args[0] === 'stats') return ok(JSON.stringify({ CPUPerc: '1.2%', MemUsage: '12MiB / 2GiB', NetIO: '1kB / 2kB' }));
      const action = args[1];
      if (action === 'create') {
        const id = (++count).toString(16).padStart(64, '0');
        const labels = {};
        args.forEach((arg, index) => { if (arg === '--label') { const [key, value] = args[index + 1].split('='); labels[key] = value; } });
        containers.set(id, { Id: id, Config: { Labels: labels }, State: { Status: 'created', Running: false } });
        return ok(id);
      }
      const id = action === 'exec' ? args[args.indexOf('--workdir') + 2] : args.at(-1);
      if (action === 'commit') return ok('sha256:fake-snapshot');
      const container = containers.get(id);
      if (!container) return bad('Error: No such container');
      if (action === 'inspect') return ok(JSON.stringify([container]));
      if (action === 'start' || action === 'unpause') { container.State = { Status: 'running', Running: true }; return ok(id); }
      if (action === 'stop') { container.State = { Status: 'exited', Running: false }; return ok(id); }
      if (action === 'rm') { containers.delete(id); return ok(id); }
      if (action === 'exec') return fake.onExec ? fake.onExec(args, options) : fake.execResult;
      throw new Error(`Unexpected fake operation: ${action}`);
    },
  };
  return fake;
}

async function setup(t, config = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omarchy-runtime-test-'));
  const fake = fakeDocker();
  const runtime = new Runtime({ dataDir, runner: fake.runner, ...config });
  t.after(async () => { await runtime.dispose(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { runtime, fake, dataDir };
}
const actions = fake => fake.calls.map(call => call.args[1]);

test('status reports absent CLI and never executes a host fallback', async t => {
  const { runtime, fake } = await setup(t);
  fake.cli = false;
  const status = await runtime.status();
  assert.equal(status.available, false);
  assert.equal(status.cliAvailable, false);
  assert.equal(status.errors[0].code, 'ENGINE_UNAVAILABLE');
  assert.equal(status.platform, process.platform);
  assert.equal(status.arch, process.arch);
  assert.equal(status.capabilities.hostFallback, false);
  await assert.rejects(runtime.exec({ command: 'echo NEVER_RUN_ON_HOST' }), { code: 'ENGINE_UNAVAILABLE' });
  assert.ok(fake.calls.every(call => call.executable === (process.platform === 'win32' ? 'docker.exe' : 'docker')));
  assert.equal(fake.calls.some(call => call.args.includes('echo NEVER_RUN_ON_HOST')), false);
});

test('status distinguishes unavailable daemon and uncached images', async t => {
  const { runtime, fake } = await setup(t);
  fake.daemon = false;
  let status = await runtime.status();
  assert.equal(status.cliAvailable, true);
  assert.equal(status.daemonAvailable, false);
  fake.daemon = true; fake.cached = false;
  status = await runtime.status();
  assert.equal(status.available, false);
  assert.equal(status.imageCached, false);
  assert.equal(status.errors[0].code, 'IMAGE_NOT_CACHED');
  await assert.rejects(runtime.ensureWorkspace({ workspaceId: 'uncached' }), { code: 'IMAGE_NOT_CACHED' });
  assert.ok(!actions(fake).includes('create'));
  assert.ok(!fake.calls.some(call => call.args.includes('pull')));
});

test('Podman runtime accepts discovered executable and UI workspace modes', async t => {
  const { runtime, fake } = await setup(t, { engine: 'podman', executable: '/opt/podman/bin/podman' });
  const workspace = await runtime.ensureWorkspace({ workspaceId: 'ui-shared', mode: 'shared' });
  assert.equal(workspace.mode, 'persistent');
  assert.equal(fake.calls[0].executable, '/opt/podman/bin/podman');
  const status = await runtime.status();
  assert.equal(status.workspaces[0].usage.cpu, '1.2%');
});

test('create uses bounded resources, bridge networking and security options', async t => {
  const { runtime, fake } = await setup(t);
  const record = await runtime.ensureWorkspace({ workspaceId: 'project-1' });
  assert.equal(record.state, 'running');
  const args = fake.calls.find(call => call.args[1] === 'create').args;
  for (const [flag, value] of [['--network', 'bridge'], ['--cpus', '2'], ['--memory', '2048m'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--pids-limit', '256']]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.equal(args.includes('--privileged'), false);
  assert.equal(args.includes('--mount'), false);
  assert.equal(args.includes('archlinux:base'), true);
  if (process.arch === 'arm64') {
    assert.equal(args[args.indexOf('--platform') + 1], 'linux/amd64');
    assert.match((await runtime.status()).warnings.join(' '), /emulation/);
  }
  assert.equal((await runtime.status()).capabilities.diskCap, false);
});

test('project bind resolves one absolute directory and rejects unsafe paths', async t => {
  const { runtime, fake, dataDir } = await setup(t);
  const project = path.join(dataDir, 'project');
  await fs.mkdir(project);
  await runtime.ensureWorkspace({ workspaceId: 'bound', projectPath: project });
  const args = fake.calls.find(call => call.args[1] === 'create').args;
  assert.equal(args[args.indexOf('--mount') + 1], `type=bind,source=${await fs.realpath(project)},target=/workspace`);
  await assert.rejects(runtime.ensureWorkspace({ workspaceId: 'root', projectPath: path.parse(dataDir).root }), { code: 'UNSAFE_PROJECT_PATH' });
  await assert.rejects(runtime.ensureWorkspace({ workspaceId: 'relative', projectPath: './project' }), { code: 'INVALID_PROJECT_PATH' });
  const other = path.join(dataDir, 'other'); await fs.mkdir(other);
  await assert.rejects(runtime.ensureWorkspace({ workspaceId: 'bound', projectPath: other }), { code: 'WORKSPACE_CONFLICT' });
});

test('safe IDs reject traversal, shell syntax and excessive length', async t => {
  const { runtime, fake } = await setup(t);
  for (const workspaceId of ['../escape', '-flag', 'x;rm', 'x/y', '', 'x'.repeat(65), '__proto__']) await assert.rejects(runtime.ensureWorkspace({ workspaceId }), { code: 'INVALID_WORKSPACE_ID' });
  assert.equal(fake.calls.length, 0);
});

test('concurrent ensure/resume/stop serialize without duplicate containers', async t => {
  const { runtime, fake } = await setup(t);
  const records = await Promise.all(Array.from({ length: 8 }, () => runtime.ensureWorkspace({ workspaceId: 'same' })));
  assert.ok(records.every(record => record.containerId === records[0].containerId));
  assert.equal(actions(fake).filter(action => action === 'create').length, 1);
  const results = await Promise.all([runtime.stop('same'), runtime.resume('same'), runtime.suspend('same')]);
  assert.deepEqual(results.map(result => result.state), ['exited', 'running', 'exited']);
  assert.equal((await runtime.status()).workspaces[0].state, 'exited');
});

test('registry is persistent, atomic and reopens with stable ownership', async t => {
  const { runtime, fake, dataDir } = await setup(t);
  const original = await runtime.ensureWorkspace({ workspaceId: 'persisted' });
  const registry = JSON.parse(await fs.readFile(path.join(dataDir, 'registry.json'), 'utf8'));
  assert.equal(registry.workspaces.persisted.containerId, original.containerId);
  assert.equal((await fs.readdir(dataDir)).filter(name => name.endsWith('.tmp')).length, 0);
  const reopened = new Runtime({ dataDir, runner: fake.runner });
  assert.equal((await reopened.status()).workspaces[0].state, 'running');
  await reopened.stop('persisted');
  assert.equal((await runtime.status()).workspaces[0].state, 'exited');
  await reopened.dispose();
});

test('corrupt registry fails closed before Docker operations', async t => {
  const { runtime, fake, dataDir } = await setup(t);
  await fs.writeFile(path.join(dataDir, 'registry.json'), '{broken');
  await assert.rejects(runtime.status(), { code: 'REGISTRY_INVALID' });
  assert.equal(fake.calls.length, 0);
  // Setup cleanup calls dispose, which must also report the corrupt registry.
  await fs.unlink(path.join(dataDir, 'registry.json'));
});

test('states come from inspect, missing containers are not silently recreated', async t => {
  const { runtime, fake } = await setup(t);
  const record = await runtime.ensureWorkspace({ workspaceId: 'states' });
  fake.containers.get(record.containerId).State.Status = 'paused';
  assert.equal((await runtime.status()).workspaces[0].state, 'paused');
  assert.equal((await runtime.resume('states')).state, 'running');
  fake.containers.delete(record.containerId);
  assert.equal((await runtime.status()).workspaces[0].state, 'missing');
  await assert.rejects(runtime.ensureWorkspace({ workspaceId: 'states' }), { code: 'CONTAINER_MISSING' });
  assert.equal((await runtime.destroy('states')).state, 'destroyed');
});

test('ownership tampering blocks stop, resume, destroy, exec and snapshot', async t => {
  const { runtime, fake } = await setup(t);
  const record = await runtime.ensureWorkspace({ workspaceId: 'owned' });
  fake.containers.get(record.containerId).Config.Labels['io.dsh.omarchy.owner'] = 'another-owner';
  const before = fake.calls.length;
  for (const operation of [() => runtime.stop('owned'), () => runtime.resume('owned'), () => runtime.destroy('owned'), () => runtime.exec({ workspaceId: 'owned', command: 'secret' }), () => runtime.snapshot('owned')]) await assert.rejects(operation(), { code: 'OWNERSHIP_MISMATCH' });
  assert.ok(fake.calls.slice(before).every(call => call.args[1] === 'inspect'));
  const status = await runtime.status();
  assert.equal(status.workspaces[0].state, 'unknown');
  assert.equal(status.workspaces[0].error.code, 'OWNERSHIP_MISMATCH');
});

test('inspect failure reports unknown and never removes a container', async t => {
  const { runtime, fake } = await setup(t);
  await runtime.ensureWorkspace({ workspaceId: 'inspect-fails' });
  const original = runtime.runner;
  runtime.runner = async (...args) => args[1][1] === 'inspect' ? { code: 1, stdout: '', stderr: 'permission denied' } : original(...args);
  assert.equal((await runtime.status()).workspaces[0].error.code, 'INSPECT_FAILED');
  await assert.rejects(runtime.destroy('inspect-fails'), { code: 'INSPECT_FAILED' });
  assert.ok(!actions(fake).includes('rm'));
});

test('exec is guest-only, uses guest and CLI timeouts, bounds output and redacts logs', async t => {
  const { runtime, fake } = await setup(t);
  const secret = 'echo SUPER_SECRET_VALUE';
  fake.execResult = { code: 124, stdout: 'x'.repeat(200000), stderr: 'y'.repeat(200000) };
  const result = await runtime.exec({ workspaceId: 'exec', command: secret, cwd: '/tmp', timeoutSec: 2 });
  const call = fake.calls.find(call => call.args[1] === 'exec');
  assert.deepEqual(call.args.slice(-7), ['timeout', '--signal=TERM', '--kill-after=5s', '2s', '/bin/bash', '-lc', secret]);
  assert.equal(call.options.timeoutMs, 12000);
  assert.equal(call.options.maxOutputBytes, 128 * 1024);
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 128 * 1024);
  assert.ok(Buffer.byteLength(result.stderr) <= 128 * 1024);
  assert.equal(result.commandPreview, '<command redacted>');
  assert.equal(JSON.stringify(runtime.logs()).includes(secret), false);
  assert.equal(runtime.logs().find(log => log.action === 'exec').preview, '<command redacted>');
});

test('active exec excludes idle sweep and destructive lifecycle calls', async t => {
  const { runtime, fake } = await setup(t, { idleMinutes: 0.000001, ephemeralMinutes: 0.000001 });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  fake.onExec = () => new Promise(resolve => { release = resolve; entered(); });
  const execution = runtime.exec({ workspaceId: 'busy', command: 'long command' });
  await started;
  runtime._registry.workspaces.busy.lastActiveAt = 0;
  assert.equal((await runtime.status()).workspaces[0].busy, 1);
  assert.deepEqual((await runtime.sweep()).actions, []);
  await assert.rejects(runtime.stop('busy'), { code: 'WORKSPACE_BUSY' });
  await assert.rejects(runtime.destroy('busy'), { code: 'WORKSPACE_BUSY' });
  await assert.rejects(runtime.snapshot('busy'), { code: 'WORKSPACE_BUSY' });
  release({ code: 0, stdout: '', stderr: '' }); await execution;
  assert.equal((await runtime.status()).workspaces[0].busy, 0);
  runtime._registry.workspaces.busy.lastActiveAt = 0;
  assert.deepEqual((await runtime.sweep()).actions, [{ workspaceId: 'busy', action: 'stop' }]);
  assert.ok(!actions(fake).includes('pause'));
});

test('concurrent exec reservations remain busy until every command finishes', async t => {
  const { runtime, fake } = await setup(t, { idleMinutes: 1 });
  const releases = [];
  let bothEntered;
  const entered = new Promise(resolve => { bothEntered = resolve; });
  fake.onExec = () => new Promise(resolve => { releases.push(resolve); if (releases.length === 2) bothEntered(); });
  const first = runtime.exec({ workspaceId: 'parallel', command: 'first' });
  const second = runtime.exec({ workspaceId: 'parallel', command: 'second' });
  await entered;
  assert.equal((await runtime.status()).workspaces[0].busy, 2);
  releases[0]({ code: 0, stdout: '', stderr: '' }); await first;
  assert.equal((await runtime.status()).workspaces[0].busy, 1);
  runtime._registry.workspaces.parallel.lastActiveAt = 0;
  assert.deepEqual((await runtime.sweep()).actions, []);
  releases[1]({ code: 0, stdout: '', stderr: '' }); await second;
  assert.equal((await runtime.status()).workspaces[0].busy, 0);
});

test('aborted Docker exec retains a busy reservation for its guest timeout', async t => {
  const { runtime, fake } = await setup(t, { idleMinutes: 1 });
  fake.execResult = { code: -1, stdout: '', stderr: '', aborted: true };
  const result = await runtime.exec({ workspaceId: 'abort', command: 'sleep 1', timeoutSec: 1 });
  assert.equal(result.aborted, true);
  assert.equal((await runtime.status()).workspaces[0].busy, 1);
  runtime._registry.workspaces.abort.lastActiveAt = 0;
  assert.deepEqual((await runtime.sweep()).actions, []);
});

test('idle sweep destroys ephemeral containers and stops persistent containers', async t => {
  const { runtime, fake } = await setup(t, { idleMinutes: 1, ephemeralMinutes: 1 });
  await runtime.ensureWorkspace({ workspaceId: 'persistent' });
  await runtime.ensureWorkspace({ workspaceId: 'ephemeral', mode: 'ephemeral' });
  for (const record of Object.values(runtime._registry.workspaces)) record.lastActiveAt = 0;
  assert.deepEqual((await runtime.sweep()).actions, [{ workspaceId: 'persistent', action: 'stop' }, { workspaceId: 'ephemeral', action: 'destroy' }]);
  const status = await runtime.status();
  assert.deepEqual(status.workspaces.map(item => [item.id, item.state]), [['persistent', 'exited']]);
  assert.equal(fake.containers.size, 1);
});

test('sweep surfaces ownership errors and preserves foreign containers', async t => {
  const { runtime, fake } = await setup(t, { ephemeralMinutes: 1 });
  const record = await runtime.ensureWorkspace({ workspaceId: 'foreign', mode: 'ephemeral' });
  runtime._registry.workspaces.foreign.lastActiveAt = 0;
  fake.containers.get(record.containerId).Config.Labels['io.dsh.omarchy.workspace'] = 'different';
  assert.equal((await runtime.sweep()).actions[0].error.code, 'OWNERSHIP_MISMATCH');
  assert.equal(fake.containers.size, 1);
});

test('snapshots commit rootfs only; restore explicitly fails without mutation', async t => {
  const { runtime, fake } = await setup(t);
  const workspace = await runtime.ensureWorkspace({ workspaceId: 'snap' });
  const snapshot = await runtime.snapshot('snap', 'Before changes');
  assert.equal(snapshot.scope, 'rootfs-only');
  assert.equal(snapshot.projectBindIncluded, false);
  const call = fake.calls.find(call => call.args[1] === 'commit');
  assert.equal(call.args.at(-2), workspace.containerId);
  assert.equal(call.args.at(-1), snapshot.image);
  const before = fake.calls.length;
  await assert.rejects(runtime.restore('snap', snapshot.id), { code: 'RESTORE_UNSUPPORTED' });
  assert.equal(fake.calls.length, before);
  const destroyed = await runtime.destroy('snap');
  assert.equal(destroyed.retainedSnapshots[0].id, snapshot.id);
});

test('invalid configuration, commands, and aborted input fail early', async t => {
  assert.throws(() => new Runtime(), { code: 'INVALID_CONFIG' });
  assert.throws(() => new Runtime({ dataDir: '.', engine: 'host' }), { code: 'UNSUPPORTED_ENGINE' });
  assert.throws(() => new Runtime({ dataDir: '.', cpus: -1 }), { code: 'INVALID_CONFIG' });
  const { runtime, fake } = await setup(t);
  await assert.rejects(runtime.exec({ command: '' }), { code: 'INVALID_COMMAND' });
  await assert.rejects(runtime.exec({ command: 'pwd', cwd: 'relative' }), { code: 'INVALID_CWD' });
  await assert.rejects(runtime.exec({ command: 'pwd', timeoutSec: 86401 }), { code: 'INVALID_TIMEOUT' });
  await assert.rejects(runtime.exec({ command: 'pwd' }, AbortSignal.abort()), { code: 'ABORTED' });
  assert.equal(fake.calls.length, 0);
});

test('runner errors do not leak command arguments into thrown errors or logs', async t => {
  const { runtime, fake } = await setup(t);
  fake.onExec = () => { throw new Error('DO_NOT_LEAK_SECRET'); };
  await assert.rejects(runtime.exec({ workspaceId: 'error', command: 'DO_NOT_LEAK_SECRET', timeoutSec: 0.001 }), error => error.code === 'ENGINE_ERROR' && !error.message.includes('DO_NOT_LEAK_SECRET'));
  assert.equal(JSON.stringify(runtime.logs()).includes('DO_NOT_LEAK_SECRET'), false);
});

test('dispose prevents new operations and preserves containers', async t => {
  const { runtime, fake } = await setup(t);
  await runtime.ensureWorkspace({ workspaceId: 'keep' });
  await runtime.dispose();
  await assert.rejects(runtime.ensureWorkspace({ workspaceId: 'new' }), { code: 'DISPOSED' });
  assert.equal(fake.containers.size, 1);
  assert.equal((await runtime.dispose()).disposed, true);
});

test('spawnRunner bounds streams, handles timeouts and never invokes a shell', async () => {
  // These tests run only harmless Node processes; lifecycle tests never invoke Docker.
  const output = await spawnRunner(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000));process.stderr.write("y".repeat(10000))'], { maxOutputBytes: 256, timeoutMs: 5000 });
  assert.equal(output.code, 0);
  assert.equal(output.stdout.length, 256);
  assert.equal(output.stderr.length, 256);
  assert.equal(output.stdoutTruncated, true);
  assert.equal(output.stderrTruncated, true);
  const timed = await spawnRunner(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 });
  assert.equal(timed.timedOut, true);
  const controller = new AbortController();
  const aborted = spawnRunner(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  assert.equal((await aborted).aborted, true);
  await assert.rejects(spawnRunner(process.execPath, [], { signal: AbortSignal.abort() }), { code: 'ABORTED' });
});
