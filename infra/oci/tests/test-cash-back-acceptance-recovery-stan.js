const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fork, spawnSync: execute } = require('node:child_process');
const { once } = require('node:events');

const helper = path.resolve(__dirname, '../scripts/cash-back-acceptance-recovery-stan.js');
const source = fs.readFileSync(helper, 'utf8');
const annotation = 'betstan.dev/cash-back-recovery';
const ownedDirectories = new Set();
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(kind = 'healthy', existing, action) {
  const directory = existing ?? fs.mkdtempSync(path.join(os.tmpdir(), 'betstan-cash-back-recovery-test-'));
  if (!existing) ownedDirectories.add(directory);
  const stateFile = path.join(directory, 'cluster.json');
  const lockFile = path.join(directory, 'lock.json');
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  let state;
  if (existing) {
    state = JSON.parse(fs.readFileSync(stateFile));
    kind = state.kind;
  } else {
    state = {
      kind, calls: [], podGeneration: 1, held: false, fence: false,
      writers: { backoffice: 1, gamemaster: 1, event: 1, slip: 1, moderation: 1, resulting: 1, bet: 1 },
      deployment: {
        metadata: { uid: 'fixture-deployment', resourceVersion: '1', annotations: {} },
        spec: { replicas: 1, template: { spec: { containers: [{
          name: 'gaming-resulting', image: `fixture@sha256:${'a'.repeat(64)}`,
        }] } } },
      },
    };
    write(stateFile, state);
    write(lockFile, {
      metadata: { name: 'gaming-mongo-migration-lock', uid: 'fixture-lock', resourceVersion: '1' },
      data: {
        state: 'released', holder: '', 'operation-id': 'previous-deployment',
        'source-sha': 'a'.repeat(40), 'fencing-generation': '1',
        'acquired-at-epoch': '1', 'lease-duration-seconds': '0',
        'lease-until-epoch': '0', 'released-at-epoch': '2',
      },
    });
    fs.mkdirSync(path.join(directory, 'bin'));
    fs.writeFileSync(path.join(directory, 'bin/kubectl'), `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.FIXTURE_LOCK_FILE;
const args = process.argv.slice(2);
const current = JSON.parse(fs.readFileSync(file));
if (args[0] === 'get' && args[1] === 'configmap') {
  console.log(JSON.stringify(current));
} else if (args[0] === 'create') {
  process.exitCode = 1;
} else if (args[0] === 'replace') {
  const next = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (next.metadata.uid !== current.metadata.uid
    || next.metadata.resourceVersion !== current.metadata.resourceVersion) {
    process.exitCode = 1;
  } else {
    next.metadata.resourceVersion = String(Number(current.metadata.resourceVersion) + 1);
    fs.writeFileSync(file, JSON.stringify(next));
  }
} else {
  throw new Error('Unexpected lock provider request');
}
`, { mode: 0o700 });
  }
  const lock = () => JSON.parse(fs.readFileSync(lockFile));
  const setLock = (value) => write(lockFile, value);
  const save = () => write(stateFile, state);
  const record = () => JSON.parse(state.deployment.metadata.annotations[annotation]);
  const assertOwned = () => {
    const current = lock();
    assert.equal(current.data.state, 'active');
    assert.equal(current.data.holder, 'cash-back-acceptance-123-1');
    assert.equal(current.data['operation-id'], 'cash-back-acceptance');
    assert.equal(current.data['source-sha'], 'a'.repeat(40));
    assert.ok(Number(current.data['lease-until-epoch']) > Date.now() / 1000);
  };
  const makeForeign = (expired = false) => {
    const current = lock();
    current.data.state = 'active';
    current.data.holder = 'foreign-owner';
    current.data['operation-id'] = 'foreign-operation';
    current.data['source-sha'] = 'b'.repeat(40);
    current.data['fencing-generation'] = String(Number(current.data['fencing-generation']) + 1);
    current.data['acquired-at-epoch'] = String(Math.floor(Date.now() / 1000) - 60);
    current.data['lease-duration-seconds'] = '21600';
    current.data['lease-until-epoch'] = String(Math.floor(Date.now() / 1000) + (expired ? -1 : 21600));
    setLock(current);
  };
  if (!existing && kind.startsWith('foreign-initial')) makeForeign(kind.endsWith('expired'));
  const env = {
    ...process.env, SOURCE_SHA: 'a'.repeat(40), GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF_NAME: 'master',
    GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW: 'oci-live-betting-activate',
    INFRASTRUCTURE_RUN_ID: '122', OCI_K8S_NAMESPACE: 'fixture', RUNNER_TEMP: directory,
    OUTPUT_DIR: directory,
    FIXTURE_LOCK_FILE: lockFile, PATH: `${path.join(directory, 'bin')}:${process.env.PATH}`,
  };
  if (kind === 'wrong-source') env.GITHUB_SHA = 'b'.repeat(40);
  let releasedReads = 0;
  const spawnSync = (command, args, options) => {
    state.calls.push({ command: path.basename(command), args: [...args] });
    save();
    const ok = (value = '') => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value) });
    if (command.endsWith('revalidate-live-activation-stan.sh')) return ok();
    if (command.endsWith('shared-mongo-operation-lock-stan.sh')) {
      if (args[0] === 'release' && kind === 'release-false-success') makeForeign();
      if (args[0] === 'release' && kind === 'release-not-committed') return { status: 1 };
      const result = execute(command, args, { ...options, env: { ...options.env, ...env,
        LOCK_TOKEN: options.env.LOCK_TOKEN, OPERATION_ID: options.env.OPERATION_ID,
        LOCK_LEASE_SECONDS: options.env.LOCK_LEASE_SECONDS,
      } });
      if (args[0] === 'acquire' && kind === 'acquire-lost-response') {
        assert.equal(result.status, 0);
        return { status: 1 };
      }
      if (args[0] === 'release' && kind === 'release-lost-response') {
        assert.equal(result.status, 0);
        assert.equal(lock().data.state, 'released');
        return { status: 1 };
      }
      return result;
    }
    if (command.endsWith('live-data-maintenance-stan.sh')) {
      assertOwned();
      if (args[0] === 'hold') {
        state.fence = true;
        state.held = true;
        Object.keys(state.writers).forEach((service) => { state.writers[service] = 0; });
        state.deployment.spec.replicas = 0;
        state.deployment.metadata.resourceVersion = String(Number(state.deployment.metadata.resourceVersion) + 1);
        save();
      } else {
        assert.equal(args[0], 'verify-held');
        assert.equal(state.fence, true);
        assert.ok(Object.values(state.writers).every((replicas) => replicas === 0));
      }
      return ok();
    }
    if (command.endsWith('live-betting-control-stan.sh')) {
      assertOwned();
      assert.equal(options.env.ACTION, 'disable');
      state.kickoffsDisabled = true;
      save();
      return ok();
    }
    if (command === 'bash') {
      if (args[1].includes('wait_for_deployment')) {
        assert.equal(state.deployment.spec.replicas, Number(args.at(-1)));
        if (kind === 'lingering-pods' && Number(args.at(-1)) === 0 && !state.held) return { status: 1 };
      } else {
        assert.ok(args[1].includes('live_betting_check_mongo_clock'));
        if (kind.includes('clock-failure')) return { status: 1 };
      }
      return ok();
    }
    assert.equal(command, 'kubectl');
    if (args.includes('configmap')) {
      if (lock().data.state === 'released' && lock().data['operation-id'] === 'cash-back-acceptance') {
        releasedReads += 1;
        if (
          (kind === 'post-release-read-failure' && releasedReads === 1)
          || kind === 'post-release-unreadable'
        ) return { status: 1 };
      }
      return ok(lock());
    }
    if (args.includes('patch')) {
      assertOwned();
      const patch = JSON.parse(args[args.indexOf('--patch') + 1]);
      const nextRecord = JSON.parse(patch.find((operation) => (
        operation.op === 'add' && operation.path === '/metadata/annotations'
      )).value[annotation]);
      if (kind === 'pause-not-committed' && nextRecord.phase === 'paused') return { status: 1 };
      if (patch.some((operation) => operation.path === '/spec/replicas' && operation.value === 0)) {
        assert.ok(['pause-intent', 'paused', 'restore-intent', 'restored'].includes(record().phase));
        assert.equal(record().replicas, 1);
        assert.ok(fs.existsSync(path.join(directory, 'cash-back-interruption-123-1.json')));
      }
      for (const operation of patch) {
        const fields = operation.path.slice(1).split('/').map((part) => part.replace(/~1/g, '/'));
        const target = fields.slice(0, -1).reduce((value, key) => value[key], state.deployment);
        const key = fields.at(-1);
        if (operation.op === 'test') assert.deepEqual(target[key], operation.value);
        else target[key] = operation.value;
      }
      const previous = state.writers.resulting;
      state.writers.resulting = state.deployment.spec.replicas;
      if (previous === 0 && state.writers.resulting > 0) state.podGeneration += 1;
      state.deployment.metadata.resourceVersion = String(Number(state.deployment.metadata.resourceVersion) + 1);
      save();
      if (kind === 'pause-lost-response' && record().phase === 'paused') return { status: 1 };
      return ok();
    }
    if (args.includes('deployment')) return ok(state.deployment);
    assert.ok(args.includes('pods'));
    return ok({ items: state.deployment.spec.replicas ? [{ metadata: { uid: `pod-${state.podGeneration}` } }] : [] });
  };
  const fixtureProcess = { env, pid: process.pid, argv: ['node', helper, action] };
  const context = {
    __dirname: path.dirname(helper), process: fixtureProcess,
    console: action ? { log: () => {}, error: () => {} } : console,
    module: { exports: {} },
    require: (name) => name === 'child_process' ? { spawnSync } : require(name),
  };
  if (action) context.require.main = context.module;
  vm.runInNewContext(source, context, { filename: helper });
  const exported = context.module.exports;
  return {
    state, directory, env, lock, setLock, makeForeign, save, record, fixtureProcess,
    interrupt: (checkpoint) => exported.withStoppedResulting(checkpoint, directory),
    control: () => exported.recovery(directory),
  };
}

async function main() {
  let cases = 0;
  const workflow = path.resolve(__dirname, '../../../.github/workflows/oci-live-betting-activate.yml');
  const parsed = execute('ruby', ['-ryaml', '-rjson', '-e',
    'puts JSON.generate(YAML.load_file(ARGV.fetch(0)))', workflow], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const steps = JSON.parse(parsed.stdout).jobs['activate-and-validate'].steps;
  const cleanupIndex = steps.findIndex((step) => step.id === 'cash_back_recovery');
  assert.equal(cleanupIndex, steps.findIndex((step) => step.id === 'journey') + 1);
  const cleanup = steps[cleanupIndex];
  assert.ok(cleanup.if.includes('always()') && cleanup.if.includes("'cancelled'"));
  assert.equal(cleanup.run, 'node ./infra/oci/scripts/cash-back-acceptance-recovery-stan.js recover');
  for (const id of ['failure_disable', 'final_disable']) {
    const step = steps.find((item) => item.id === id);
    assert.equal(step.run, 'node ./infra/oci/scripts/cash-back-acceptance-recovery-stan.js disable');
    assert.ok(step.if.includes('always()'));
  }
  assert.equal(steps.find((step) => step.id === 'commit').run, './infra/oci/scripts/live-betting-control-stan.sh');
  const recoveryAction = cleanup.run.split(' ').at(-1);
  cases += 1;
  for (const kind of ['healthy', 'acquire-lost-response', 'release-lost-response', 'post-release-read-failure', 'pause-lost-response']) {
    const current = fixture(kind);
    const result = await current.interrupt(async () => {
      assert.equal(current.state.deployment.spec.replicas, 0);
      assert.equal(current.lock().data.state, 'active');
      assert.equal(current.record().stopped, true);
      const privateFile = path.join(current.directory, 'cash-back-interruption-123-1.json');
      assert.equal(fs.statSync(privateFile).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(fs.readFileSync(privateFile)), current.record());
      return { pendingObservedWithZeroWorkers: true };
    });
    assert.equal(result.stopped, true);
    assert.equal(result.restored, true);
    assert.equal(current.state.deployment.spec.replicas, 1);
    assert.equal(current.lock().data.state, 'released');
    assert.equal(current.state.held, false);
    assert.notEqual(result.beforePodFingerprints[0], result.afterPodFingerprints[0]);
    current.control().restore();
    cases += 1;
  }
  const callback = fixture();
  await assert.rejects(() => callback.interrupt(async () => {
    throw new Error('original acceptance failure');
  }), /original acceptance failure/);
  assert.equal(callback.lock().data.state, 'released');
  cases += 1;
  const uncommitted = fixture('pause-not-committed');
  await assert.rejects(() => uncommitted.interrupt(async () => {
    assert.fail('Unconfirmed pause reached the acceptance callback');
  }), /handoff paused/);
  assert.equal(uncommitted.state.deployment.spec.replicas, 1);
  assert.equal(uncommitted.lock().data.state, 'released');
  cases += 1;
  for (const kind of ['wrong-source', 'foreign-initial', 'foreign-initial-expired']) {
    const current = fixture(kind);
    await assert.rejects(() => current.interrupt(async () => ({})));
    assert.equal(current.state.deployment.spec.replicas, 1);
    assert.equal(current.state.held, false);
    assert.ok(!current.state.calls.some((call) => call.args.includes('acquire')));
    cases += 1;
  }
  for (const kind of ['clock-failure', 'lingering-pods', 'template-drift']) {
    const current = fixture(kind);
    await assert.rejects(() => current.interrupt(async () => {
      if (kind === 'template-drift') {
        current.state.deployment.spec.template.spec.containers[0].image = `changed@sha256:${'b'.repeat(64)}`;
      }
    }));
    assert.equal(current.state.fence, true);
    assert.ok(Object.values(current.state.writers).every((replicas) => replicas === 0));
    assert.equal(current.lock().data.state, 'active');
    assert.equal(current.record().maintenanceHeld, true);
    cases += 1;
  }
  for (const kind of ['foreign-resume', 'expired-foreign-resume', 'expired-own', 'generation-drift', 'lock-uid-drift']) {
    const current = fixture();
    let mutations;
    await assert.rejects(() => current.interrupt(async () => {
      if (kind.includes('foreign')) current.makeForeign(kind.startsWith('expired'));
      else {
        const value = current.lock();
        if (kind === 'expired-own') value.data['lease-until-epoch'] = '1';
        if (kind === 'generation-drift') value.data['fencing-generation'] = '10';
        if (kind === 'lock-uid-drift') value.metadata.uid = 'foreign-lock';
        current.setLock(value);
      }
      mutations = current.state.calls.filter((call) => call.args.includes('patch')).length;
    }));
    assert.throws(() => current.control().disable());
    assert.equal(current.state.calls.filter((call) => call.args.includes('patch')).length, mutations);
    assert.equal(current.state.held, false);
    assert.equal(current.state.kickoffsDisabled, undefined);
    cases += 1;
  }
  for (const kind of ['release-not-committed', 'post-release-unreadable', 'release-false-success']) {
    const current = fixture(kind);
    await assert.rejects(() => current.interrupt(async () => ({})));
    assert.equal(current.state.deployment.spec.replicas, 1);
    assert.equal(current.state.held, false);
    assert.equal(current.record().restored, true);
    if (kind !== 'release-not-committed') {
      assert.throws(() => current.control().disable());
      assert.equal(current.state.kickoffsDisabled, undefined);
    }
    cases += 1;
  }
  const missing = fixture();
  let beforeMissing;
  await assert.rejects(() => missing.interrupt(async () => {
    delete missing.state.deployment.metadata.annotations[annotation];
    beforeMissing = missing.state.calls.filter((call) => call.args.includes('patch')).length;
  }), /missing from its Deployment/);
  assert.equal(missing.state.calls.filter((call) => call.args.includes('patch')).length, beforeMissing);
  assert.equal(missing.state.held, false);
  cases += 1;
  const guarded = fixture();
  await guarded.interrupt(async () => ({}));
  guarded.control().disable();
  guarded.control().disable();
  assert.equal(guarded.state.kickoffsDisabled, true);
  assert.equal(guarded.lock().data.state, 'released');
  guarded.makeForeign();
  const before = guarded.state.calls.filter((call) => call.command === 'live-betting-control-stan.sh').length;
  assert.throws(() => guarded.control().disable());
  assert.equal(guarded.state.calls.filter((call) => call.command === 'live-betting-control-stan.sh').length, before);
  cases += 1;

  for (const kind of ['killed-worker', 'killed-clock-failure']) {
    const initial = fixture(kind);
    const child = fork(__filename, ['--worker', initial.directory], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let timeout;
    try {
      const [message] = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => { throw new Error('Interruption worker exited before zero-pod checkpoint'); }),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Interruption worker missed its bounded checkpoint')), 60000);
        }),
      ]);
      assert.equal(message.paused, true);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const interrupted = fixture(kind, initial.directory);
      assert.equal(interrupted.state.deployment.spec.replicas, 0);
      assert.equal(interrupted.record().phase, 'paused');
      assert.equal(interrupted.record().replicas, 1);
      const recovered = fixture(kind, initial.directory, recoveryAction);
      if (kind === 'killed-clock-failure') {
        assert.equal(recovered.fixtureProcess.exitCode, 1);
        assert.equal(recovered.state.fence, true);
        assert.equal(recovered.record().maintenanceHeld, true);
        assert.ok(Object.values(recovered.state.writers).every((replicas) => replicas === 0));
        assert.equal(recovered.lock().data.state, 'active');
      } else {
        assert.equal(recovered.fixtureProcess.exitCode, undefined);
        assert.equal(recovered.state.deployment.spec.replicas, 1);
        assert.equal(recovered.lock().data.state, 'released');
      }
      assert.equal(fs.existsSync(path.join(initial.directory, 'acceptance-success.json')), false);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    cases += 1;
  }
  console.log(`oci_cash_back_recovery_operator=PASS cases=${cases}`);
}

if (process.argv[2] === '--worker') {
  const current = fixture(undefined, process.argv[3]);
  current.interrupt(async () => {
    process.send({ paused: true });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }).then(() => {
    fs.writeFileSync(path.join(current.directory, 'acceptance-success.json'), '{}');
  }).catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => {
    for (const directory of ownedDirectories) fs.rmSync(directory, { recursive: true });
  });
}
