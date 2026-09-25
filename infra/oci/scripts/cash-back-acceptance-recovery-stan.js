const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');

const ANNOTATION = 'betstan.dev/cash-back-recovery';
const DEPLOYMENT = 'gaming-resulting-depl';
const LOCK = 'gaming-mongo-migration-lock';
const fingerprint = (value) => createHash('sha256').update(value).digest('hex');

function recovery(outputDir) {
  const env = {
    ...process.env,
    NAMESPACE: process.env.OCI_K8S_NAMESPACE,
    LOCK_TOKEN: `cash-back-acceptance-${process.env.GITHUB_RUN_ID}-1`,
    OPERATION_ID: 'cash-back-acceptance',
    LOCK_LEASE_SECONDS: '21600',
    WAIT_ATTEMPTS: '60',
    WAIT_SECONDS: '2',
  };
  const sourceSha = env.SOURCE_SHA;
  const runId = env.GITHUB_RUN_ID;
  const namespace = env.OCI_K8S_NAMESPACE;
  if (
    env.GITHUB_ACTIONS !== 'true' || env.GITHUB_WORKFLOW !== 'oci-live-betting-activate'
    || env.GITHUB_REF_NAME !== 'master' || env.GITHUB_RUN_ATTEMPT !== '1'
    || env.GITHUB_SHA !== sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha ?? '')
    || !/^[1-9][0-9]*$/.test(runId ?? '')
    || !/^[1-9][0-9]*$/.test(env.INFRASTRUCTURE_RUN_ID ?? '')
    || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace ?? '')
    || !env.RUNNER_TEMP || !outputDir
  ) throw new Error('Worker interruption requires the exact protected activation context.');

  const maintenance = path.join(__dirname, 'live-data-maintenance-stan.sh');
  const lockScript = path.join(__dirname, 'shared-mongo-operation-lock-stan.sh');
  const stateFile = path.join(env.RUNNER_TEMP, `cash-back-interruption-${runId}-1.json`);
  const call = (stage, command, args, overrides = {}) => {
    const result = spawnSync(command, args, {
      env: { ...env, ...overrides }, encoding: 'utf8', timeout: 140000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Protected cash-back ${stage} failed (${result.error?.code ?? result.status}).`);
    }
    return result.stdout;
  };
  const kube = (stage, args) => call(stage, 'kubectl', [
    '--request-timeout=15s', ...args, '-n', namespace,
  ]);
  const deployment = () => JSON.parse(kube('deployment read', [
    'get', 'deployment', DEPLOYMENT, '-o', 'json',
  ]));
  const pods = () => JSON.parse(kube('pod read', [
    'get', 'pods', '-l', 'app=gaming-resulting', '-o', 'json',
  ])).items;
  const lockState = () => {
    let error;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const lock = JSON.parse(kube('lock read', ['get', 'configmap', LOCK, '-o', 'json']));
        const generation = Number(lock.data?.['fencing-generation']);
        if (
          !lock.metadata?.uid || !lock.metadata.resourceVersion
          || !Number.isSafeInteger(generation) || generation < 1
          || !['active', 'released'].includes(lock.data?.state)
        ) throw new Error('Protected cash-back lock evidence is malformed.');
        return lock;
      } catch (readError) {
        error = readError;
      }
    }
    throw error;
  };
  const wait = (replicas) => call('zero-pod/ready boundary', 'bash', [
    '-c', 'source "$1" ""; wait_for_deployment resulting "$2"',
    'cash-back-recovery', maintenance, String(replicas),
  ]);
  const image = (value) => value.spec?.template?.spec?.containers?.find(
    (container) => container.name === 'gaming-resulting',
  )?.image;
  const templateHash = (value) => fingerprint(JSON.stringify(value.spec?.template));
  const requireWorkload = (record, value, allowTemplateDrift = false) => {
    if (
      value.metadata?.uid !== record.deploymentUid
      || (!allowTemplateDrift && (
        templateHash(value) !== record.templateHash || image(value) !== record.image
      ))
    ) throw new Error('Resulting identity or template changed during recovery.');
  };
  const requireBinding = (record) => {
    if (
      record?.version !== 1 || record.runId !== runId || record.runAttempt !== '1'
      || record.sourceSha !== sourceSha || record.namespace !== namespace
      || record.infrastructureRunId !== env.INFRASTRUCTURE_RUN_ID
      || !record.deploymentUid || !/^[a-f0-9]{64}$/.test(record.templateHash ?? '')
      || !/@sha256:[a-f0-9]{64}$/.test(record.image ?? '')
      || !Number.isSafeInteger(record.replicas) || record.replicas < 1
      || !Array.isArray(record.beforePodIds) || record.beforePodIds.length !== record.replicas
      || record.beforePodIds.some((id) => typeof id !== 'string' || !id)
      || new Set(record.beforePodIds).size !== record.replicas
      || !record.lockUid || !Number.isSafeInteger(record.lockGeneration)
      || record.lockGeneration < 1 || !Number.isSafeInteger(record.revision)
      || record.revision < 0
      || typeof record.restored !== 'boolean'
      || (record.stopped !== undefined && typeof record.stopped !== 'boolean')
      || (record.maintenanceHeld !== undefined && typeof record.maintenanceHeld !== 'boolean')
      || (record.restored === true && (
        typeof record.stopped !== 'boolean' || !Array.isArray(record.afterPodIds)
        || record.afterPodIds.length !== record.replicas
        || record.afterPodIds.some((id) => typeof id !== 'string' || !id)
        || new Set(record.afterPodIds).size !== record.replicas
      ))
      || !['prepared', 'pause-intent', 'paused', 'restore-intent',
        'restored', 'release-intent', 'held', 'disable-intent'].includes(record.phase)
    ) throw new Error('Cash-back interruption handoff does not match this operation.');
  };
  const owned = (record, lock = lockState()) => {
    requireBinding(record);
    const data = lock.data;
    const leaseUntil = Number(data['lease-until-epoch']);
    const leaseDuration = Number(data['lease-duration-seconds']);
    const acquiredAt = Number(data['acquired-at-epoch']);
    if (
      lock.metadata.uid !== record.lockUid || data.state !== 'active'
      || data.holder !== env.LOCK_TOKEN || data['operation-id'] !== env.OPERATION_ID
      || data['source-sha'] !== sourceSha
      || Number(data['fencing-generation']) !== record.lockGeneration
      || !/^[1-9][0-9]*$/.test(data['lease-until-epoch'] ?? '')
      || !Number.isSafeInteger(leaseUntil) || !Number.isSafeInteger(acquiredAt) || acquiredAt < 1
      || !Number.isSafeInteger(leaseDuration) || leaseDuration < 60 || leaseDuration > 86400
      || leaseUntil <= Math.floor(Date.now() / 1000) + 300
    ) throw new Error('Cash-back lock ownership is foreign, expired or insufficient; no workload mutation is authorized.');
    return lock;
  };
  const released = (record, lock) => (
    record.phase === 'release-intent' && record.restored === true
    && lock.metadata.uid === record.lockUid && lock.data.state === 'released'
    && lock.data.holder === '' && lock.data['operation-id'] === env.OPERATION_ID
    && lock.data['source-sha'] === sourceSha
    && Number(lock.data['fencing-generation']) === record.lockGeneration + 1
  );
  const privateEvidence = (record) => {
    const temporary = `${stateFile}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, stateFile);
  };
  const handoff = (value = deployment()) => {
    const encoded = value.metadata?.annotations?.[ANNOTATION];
    if (!encoded) {
      if (fs.existsSync(stateFile)) throw new Error('Persisted cash-back interruption is missing from its Deployment.');
      return null;
    }
    const record = JSON.parse(encoded);
    if (
      record.runId !== runId && record.phase === 'release-intent'
      && record.restored === true && !record.maintenanceHeld && !fs.existsSync(stateFile)
    ) return null;
    requireBinding(record);
    if (fs.existsSync(stateFile)) {
      const local = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      requireBinding(local);
      if (
        local.revision > record.revision || local.deploymentUid !== record.deploymentUid
        || local.templateHash !== record.templateHash || local.image !== record.image
        || local.replicas !== record.replicas || local.lockUid !== record.lockUid
        || JSON.stringify(local.beforePodIds) !== JSON.stringify(record.beforePodIds)
      ) throw new Error('Private and cluster cash-back interruption evidence disagree.');
    }
    return record;
  };
  const persist = (record, phase, replicas, allowTemplateDrift = false) => {
    owned(record);
    const current = deployment();
    requireWorkload(record, current, allowTemplateDrift);
    const previous = current.metadata.annotations?.[ANNOTATION];
    if (previous !== undefined && record.revision !== 0) {
      const prior = JSON.parse(previous);
      if (
        prior.revision !== record.revision || prior.runId !== runId
        || prior.sourceSha !== sourceSha || prior.lockUid !== record.lockUid
        || prior.deploymentUid !== record.deploymentUid
      ) throw new Error('Cash-back interruption handoff changed before its mutation.');
    }
    const next = { ...record, phase, revision: record.revision + 1 };
    const encoded = JSON.stringify(next);
    const patch = [
      { op: 'test', path: '/metadata/uid', value: record.deploymentUid },
      { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
    ];
    if (previous !== undefined) patch.push({
      op: 'test', path: '/metadata/annotations/betstan.dev~1cash-back-recovery', value: previous,
    });
    patch.push({
      op: 'add', path: '/metadata/annotations',
      value: { ...(current.metadata.annotations ?? {}), [ANNOTATION]: encoded },
    });
    if (replicas !== undefined) patch.push({ op: 'replace', path: '/spec/replicas', value: replicas });
    let mutationError;
    try {
      kube(`handoff ${phase}`, ['patch', 'deployment', DEPLOYMENT, '--type=json', '--patch', JSON.stringify(patch)]);
    } catch (error) {
      mutationError = error;
    }
    const observed = deployment();
    requireWorkload(next, observed, allowTemplateDrift);
    if (
      observed.metadata.annotations?.[ANNOTATION] !== encoded
      || (replicas !== undefined && observed.spec.replicas !== replicas)
    ) throw mutationError ?? new Error('Cash-back handoff mutation was not observed.');
    privateEvidence(next);
    return next;
  };
  const acquire = (previous) => {
    if (previous.data.state !== 'released' || previous.data.holder !== '') {
      throw new Error('A held or expired lock cannot be adopted for cash-back acceptance.');
    }
    let acquisitionError;
    try {
      call('physical lock acquisition', lockScript, ['acquire']);
    } catch (error) {
      acquisitionError = error;
    }
    const current = lockState();
    if (
      current.metadata.uid !== previous.metadata.uid || current.data.state !== 'active'
      || current.data.holder !== env.LOCK_TOKEN || current.data['operation-id'] !== env.OPERATION_ID
      || current.data['source-sha'] !== sourceSha
      || Number(current.data['fencing-generation']) !== Number(previous.data['fencing-generation']) + 1
    ) throw acquisitionError ?? new Error('Cash-back lock acquisition was not observed.');
    return current;
  };
  const prepare = () => {
    call('source revalidation', path.join(__dirname, 'revalidate-live-activation-stan.sh'), []);
    const previous = deployment().metadata?.annotations?.[ANNOTATION];
    if (previous) {
      const prior = JSON.parse(previous);
      if (prior.phase !== 'release-intent' || prior.restored !== true) {
        throw new Error('An unfinished cash-back interruption cannot be replaced.');
      }
    }
    const lock = acquire(lockState());
    const original = deployment();
    const replicas = original.spec?.replicas;
    if (
      !original.metadata?.uid || !Number.isSafeInteger(replicas) || replicas < 1
      || !/@sha256:[a-f0-9]{64}$/.test(image(original) ?? '')
    ) throw new Error('Resulting interruption lacks an immutable ready workload.');
    wait(replicas);
    const originalPods = pods();
    if (originalPods.length !== replicas || originalPods.some((pod) => !pod.metadata?.uid)) {
      throw new Error('Resulting pod identity evidence is incomplete.');
    }
    return persist({
      version: 1, sourceSha, runId, runAttempt: '1', namespace,
      infrastructureRunId: env.INFRASTRUCTURE_RUN_ID,
      deploymentUid: original.metadata.uid, templateHash: templateHash(original),
      image: image(original), replicas, beforePodIds: originalPods.map((pod) => pod.metadata.uid),
      lockUid: lock.metadata.uid, lockGeneration: Number(lock.data['fencing-generation']),
      revision: 0, phase: 'prepared', restored: false,
    }, 'prepared');
  };
  const release = (record) => {
    const current = lockState();
    const verifyRestored = () => {
      requireWorkload(record, deployment());
      wait(record.replicas);
    };
    if (released(record, current)) {
      verifyRestored();
      return record;
    }
    owned(record, current);
    try {
      verifyRestored();
    } catch (error) {
      retainMaintenance(error);
    }
    let releaseError;
    try {
      call('physical lock release', lockScript, ['release']);
    } catch (error) {
      releaseError = error;
    }
    if (!released(record, lockState())) {
      throw releaseError ?? new Error('Cash-back lock release remains unresolved; no cleanup mutation was attempted.');
    }
    return record;
  };
  const retainMaintenance = (error) => {
    const current = handoff();
    if (!current) throw error;
    owned(current);
    call('retain maintenance after recovery failure', maintenance, ['hold']);
    owned(current);
    call('verify retained maintenance', maintenance, ['verify-held']);
    persist({ ...current, maintenanceHeld: true }, 'held', undefined, true);
    throw error;
  };
  const restore = () => {
    let record = handoff();
    if (!record) return null;
    const currentLock = lockState();
    if (released(record, currentLock)) return release(record);
    owned(record, currentLock);
    if (record.maintenanceHeld) throw new Error('Cash-back recovery remains maintenance-held; explicit operation recovery is required.');
    if (record.phase === 'release-intent' && record.restored === true) return release(record);
    try {
      const paused = record.stopped === true
        || ['pause-intent', 'paused', 'restore-intent'].includes(record.phase);
      record = persist(record, 'restore-intent', paused ? 0 : undefined);
      if (paused) wait(0);
      owned(record);
      call('clock before recovery', 'bash', [
        '-c', 'source "$1"; live_betting_check_mongo_clock "$2" "$3" "$4" "$5"',
        'cash-back-clock', path.resolve(__dirname, '../../azure/agents/live-betting-readiness-lib.sh'),
        namespace, sourceSha, runId, path.join(outputDir, 'recovery-clock'),
      ]);
      record = persist(record, 'restored', record.replicas);
      wait(record.replicas);
      const afterPods = pods();
      if (
        afterPods.length !== record.replicas || afterPods.some((pod) => !pod.metadata?.uid)
        || (paused && afterPods.some((pod) => record.beforePodIds.includes(pod.metadata.uid)))
      ) throw new Error('Resulting replacement was not observed.');
      record = persist({
        ...record, restored: true, stopped: paused,
        afterPodIds: afterPods.map((pod) => pod.metadata.uid),
      }, 'release-intent');
    } catch (error) {
      retainMaintenance(error);
    }
    // A lost release response is not a failed writer restoration.
    return release(record);
  };
  const pause = () => {
    let record = prepare();
    record = persist(record, 'pause-intent');
    record = persist(record, 'paused', 0);
    wait(0);
    if (pods().length !== 0) throw new Error('Resulting interruption did not reach zero pods.');
    return persist({ ...record, stopped: true }, 'paused');
  };
  const disable = () => {
    let record = handoff();
    if (!record) {
      record = prepare();
      record = persist({
        ...record, restored: true, stopped: false, afterPodIds: record.beforePodIds,
      }, 'restored');
    }
    const current = lockState();
    if (released(record, current)) {
      const acquired = acquire(current);
      record = persist({
        ...record, lockGeneration: Number(acquired.data['fencing-generation']),
      }, 'disable-intent');
    } else {
      owned(record, current);
      record = persist(record, 'disable-intent', undefined, true);
    }
    owned(record);
    call('disable live kickoffs', path.join(__dirname, 'live-betting-control-stan.sh'), [], {
      ACTION: 'disable', CONTROL_RUN_ID: runId, CONFIRMATION: 'DISABLE OCI LIVE BETTING',
      OUTPUT_DIR: outputDir,
    });
    if (!record.restored || record.maintenanceHeld) throw new Error('Live kickoffs disabled under the retained cash-back lock; recovery remains incomplete.');
    record = persist(record, 'release-intent');
    release(record);
  };
  return { pause, restore, disable };
}

async function withStoppedResulting(checkpoint, outputDir) {
  const control = recovery(outputDir);
  let result;
  let record;
  try {
    control.pause();
    result = await checkpoint();
  } finally {
    record = control.restore();
  }
  if (!record?.restored || !record.stopped) throw new Error('Protected interruption was not completed.');
  return {
    sourceSha: record.sourceSha, runId: record.runId, stopped: true, restored: true,
    replicas: record.replicas, deploymentFingerprint: fingerprint(record.deploymentUid),
    beforePodFingerprints: record.beforePodIds.map(fingerprint),
    afterPodFingerprints: record.afterPodIds.map(fingerprint),
    checkpoint: result,
  };
}

module.exports = { withStoppedResulting, recovery };

if (require.main === module) {
  try {
    const control = recovery(process.env.OUTPUT_DIR);
    if (process.argv[2] === 'recover') control.restore();
    else if (process.argv[2] === 'disable') control.disable();
    else throw new Error('Expected recover or disable action.');
    console.log(`cash_back_acceptance_recovery=${process.argv[2]} status=PASS`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
