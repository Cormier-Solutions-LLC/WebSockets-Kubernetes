import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildPlan, fileExists, loadContract, renderValues, stableJson, validateConfiguration,
} from "../../scripts/lib/bootstrap-contract.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const example = JSON.parse(await readFile(resolve(repositoryRoot, "bootstrap/config.example.json"), "utf8"));
const profiles = {
  "non-ha": JSON.parse(await readFile(resolve(repositoryRoot, "bootstrap/profiles/non-ha.json"), "utf8")),
  ha: JSON.parse(await readFile(resolve(repositoryRoot, "bootstrap/profiles/ha.json"), "utf8")),
};

function configuration(topology = "non-ha") {
  const result = structuredClone(example);
  result.topology = topology;
  result.kubernetes.failureDomains = topology === "ha" ? 3 : 1;
  return result;
}

test("both explicit topology profiles validate and render their availability controls", () => {
  const nonHa = configuration();
  const ha = configuration("ha");
  assert.deepEqual(validateConfiguration(nonHa), []);
  assert.deepEqual(validateConfiguration(ha), []);
  assert.deepEqual(renderValues(nonHa, profiles["non-ha"]), {
    ...renderValues(nonHa, profiles["non-ha"]),
    replicaCount: 1,
    topology: "non-ha",
    podDisruptionBudget: { enabled: false, minAvailable: 0 },
    topologySpreadConstraints: { enabled: false },
  });
  const haValues = renderValues(ha, profiles.ha);
  assert.equal(haValues.replicaCount, 3);
  assert.equal(haValues.autoscaling.minReplicas, 3);
  assert.equal(haValues.podDisruptionBudget.minAvailable, 2);
  assert.equal(haValues.topologySpreadConstraints.enabled, true);
});

test("HA rejects insufficient failure domains", () => {
  const config = configuration("ha");
  config.kubernetes.failureDomains = 2;
  assert.match(validateConfiguration(config).map(item => `${item.path}: ${item.message}`).join("\n"), /HA requires at least three failure domains/);
});

test("unknown fields and inline secrets fail closed with field paths", () => {
  const config = configuration();
  config.redis.password = "must-not-be-accepted";
  const errors = validateConfiguration(config);
  assert(errors.some(item => item.path === "$.redis.password" && item.message.includes("not a supported field")));
  assert(errors.some(item => item.path === "$.redis.password" && item.message.includes("inline secret")));
});

test("normalized plan and rendered values are deterministic and secret-reference-only", () => {
  const config = configuration("ha");
  const first = buildPlan("update", config, profiles.ha, { timeoutSeconds: 420 });
  const second = buildPlan("update", structuredClone(config), structuredClone(profiles.ha), { timeoutSeconds: 420 });
  assert.equal(stableJson(first), stableJson(second));
  assert.equal(first.valuesSha256, second.valuesSha256);
  assert.equal(first.safety.secretValuesAccepted, false);
  assert.equal(first.values.redis.credentialsSecret.name, config.redis.credentialsSecret);
  assert(!stableJson(first).includes("must-not-be-accepted"));
});

test("topology changes are classified and require backup and confirmation", () => {
  const config = configuration("ha");
  const plan = buildPlan("update", config, profiles.ha, { previousTopology: "non-ha" });
  assert.equal(plan.changeClass, "topology-conversion");
  assert.equal(plan.topology.conversion, true);
  assert.equal(plan.safety.requiresBackup, true);
  assert.equal(plan.safety.requiresTopologyConfirmation, true);
});

test("workspace bootstrap is non-mutating to cluster state and teardown is backed up", () => {
  const config = configuration();
  assert.equal(buildPlan("bootstrap", config, profiles["non-ha"]).safety.mutation, false);
  const teardown = buildPlan("teardown", config, profiles["non-ha"]);
  assert.equal(teardown.safety.requiresForce, true);
  assert.equal(teardown.safety.requiresBackup, true);
});

test("HA external Redis requires an explicit availability confirmation", () => {
  const config = configuration("ha");
  config.redis.mode = "external";
  config.redis.externalEndpoint = "redis.example.test:6379";
  config.redis.externalHaConfirmed = false;
  assert(validateConfiguration(config).some(item => item.path === "$.redis.externalHaConfirmed"));
  config.redis.externalHaConfirmed = true;
  assert.deepEqual(validateConfiguration(config), []);
});

test("requested shell profile must match the versioned configuration", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-test-"));
  const path = resolve(directory, "config.json");
  await writeFile(path, stableJson(configuration()));
  await assert.rejects(loadContract(repositoryRoot, path, "ha"), /does not match configuration topology/);
});

test("unsafe configured output paths are rejected before any mutation", () => {
  const config = configuration();
  config.paths.backupDirectory = "../outside";
  assert(validateConfiguration(config).some(item => item.path === "$.paths.backupDirectory"));
});

test("a topology conversion stops before cluster access until explicitly confirmed", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-conversion-"));
  const config = configuration("ha");
  config.naming.suffix = "contract-test";
  const path = resolve(directory, "config.json");
  await writeFile(path, stableJson(config));
  const targetRoot = resolve(repositoryRoot, ".bootstrap/lifecycle/dev-realtime-contract-test");
  await mkdir(targetRoot, { recursive: true });
  await writeFile(resolve(targetRoot, "state.json"), stableJson({ topology: "non-ha" }));
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "update", "--config", path], { cwd: repositoryRoot }), error => error.code === 3 && /confirm-topology-change/.test(error.stdout));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("an existing target lock produces the safety-stop exit code", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-lock-"));
  const config = configuration();
  config.naming.suffix = "lock-test";
  const path = resolve(directory, "config.json");
  await writeFile(path, stableJson(config));
  const targetRoot = resolve(repositoryRoot, ".bootstrap/lifecycle/dev-realtime-lock-test");
  await mkdir(resolve(targetRoot, "operation.lock"), { recursive: true });
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "install", "--config", path], { cwd: repositoryRoot }), error => error.code === 3 && /target lock/.test(error.stdout));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

function normalizedPlan(stdout) {
  const events = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const event = events.find(item => item.phase === "plan" && item.message === "Normalized execution plan.");
  assert(event, "normalized plan event was not emitted");
  const { timestamp, level, phase, message, ...plan } = event;
  return plan;
}

async function fakeClusterTools(directory) {
  const helm = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${BOOTSTRAP_FAKE_FAIL:-}" == 'redis' && "$*" == *"$BOOTSTRAP_FAKE_REDIS_RELEASE"* && "\${1:-}" == 'upgrade' ]]; then printf '%s\\n' 'injected Redis failure' >&2; exit 9; fi
case "\${1:-}" in
  version) printf '%s\\n' 'v4.2.0+fake' ;;
  list) printf '[{"name":"%s"},{"name":"%s"}]\\n' "$BOOTSTRAP_FAKE_RELEASE" "$BOOTSTRAP_FAKE_REDIS_RELEASE" ;;
  get) printf '{}\\n' ;;
  lint|template|upgrade|uninstall) printf '%s\\n' 'ok' ;;
  *) printf 'unsupported fake helm command: %s\\n' "\${1:-}" >&2; exit 64 ;;
esac
`;
  const kubectl = `#!/usr/bin/env bash
set -euo pipefail
joined="$*"
if [[ "$joined" == 'config current-context' ]]; then printf '%s\\n' 'kind-example'
elif [[ "$joined" == *'cluster-info'* && "\${BOOTSTRAP_FAKE_FAIL:-}" == 'cluster' ]]; then printf '%s\\n' 'injected Kubernetes network failure' >&2; exit 9
elif [[ "$joined" == *'get nodes --output json'* ]]; then
  printf '%s\\n' '{"items":[{"metadata":{"labels":{"topology.kubernetes.io/zone":"zone-a"}},"spec":{},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"topology.kubernetes.io/zone":"zone-b"}},"spec":{},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"topology.kubernetes.io/zone":"zone-c"}},"spec":{},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}'
elif [[ "$joined" == *'get secret'* && "\${BOOTSTRAP_FAKE_FAIL:-}" == 'credential' ]]; then exit 0
elif [[ "$joined" == *'go-template='* ]]; then printf '%s\\n' 'realtime' 'redis-password'
elif [[ "$joined" == *'auth can-i'* && "\${BOOTSTRAP_FAKE_FAIL:-}" == 'permission' ]]; then printf '%s\\n' 'no'
elif [[ "$joined" == *'auth can-i'* ]]; then printf '%s\\n' 'yes'
elif [[ "$joined" == *'rollout status'* && "\${BOOTSTRAP_FAKE_FAIL:-}" == 'rollout' ]]; then printf '%s\\n' 'injected rollout failure' >&2; exit 9
else printf '%s\\n' 'fake-resource'
fi
`;
  const helmPath = resolve(directory, "helm");
  const kubectlPath = resolve(directory, "kubectl");
  await writeFile(helmPath, helm, { mode: 0o755 });
  await writeFile(kubectlPath, kubectl, { mode: 0o755 });
}

function shellInvocation(shell, action, configPath, extra = []) {
  return shell === "bash"
    ? ["bash", [resolve(repositoryRoot, "scripts/realtime-bootstrap.sh"), action, "--config", configPath, ...extra]]
    : ["pwsh", ["-NoProfile", "-File", resolve(repositoryRoot, "scripts/Realtime-Bootstrap.ps1"), "-Action", action, "-Config", configPath, ...extra.map(value => value === "--force" ? "-Force" : value === "--confirm-topology-change" ? "-ConfirmTopologyChange" : value)]];
}

test("Bash and PowerShell wrappers emit the same normalized plan and exit semantics", async t => {
  if (process.platform === "win32") return t.skip("cross-shell parity runs on the Ubuntu CI image");
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-parity-"));
  const path = resolve(directory, "config.json");
  await writeFile(path, stableJson(configuration("ha")));
  const bash = await execute("bash", [resolve(repositoryRoot, "scripts/realtime-bootstrap.sh"), "plan", "--config", path, "--profile", "ha"], { cwd: repositoryRoot });
  const powershell = await execute("pwsh", ["-NoProfile", "-File", resolve(repositoryRoot, "scripts/Realtime-Bootstrap.ps1"), "-Action", "plan", "-Config", path, "-Profile", "ha"], { cwd: repositoryRoot });
  assert.deepEqual(normalizedPlan(bash.stdout), normalizedPlan(powershell.stdout));
});

test("both entry points reject an invalid topology with a non-zero exit", async t => {
  if (process.platform === "win32") return t.skip("cross-shell parity runs on the Ubuntu CI image");
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-failure-"));
  const path = resolve(directory, "config.json");
  const invalid = configuration("ha");
  invalid.kubernetes.failureDomains = 1;
  await writeFile(path, stableJson(invalid));
  await assert.rejects(execute("bash", [resolve(repositoryRoot, "scripts/realtime-bootstrap.sh"), "plan", "--config", path], { cwd: repositoryRoot }));
  await assert.rejects(execute("pwsh", ["-NoProfile", "-File", resolve(repositoryRoot, "scripts/Realtime-Bootstrap.ps1"), "-Action", "plan", "-Config", path], { cwd: repositoryRoot }));
});

test("both shells execute the complete lifecycle for both profiles with identical safety semantics", { timeout: 60_000 }, async t => {
  if (process.platform === "win32") return t.skip("the hermetic Bash/PowerShell lifecycle matrix runs on Ubuntu CI");
  if (process.env.BOOTSTRAP_SKIP_LIFECYCLE === "1") return t.skip("the lifecycle runs in its dedicated CI matrix");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-tools-"));
  await fakeClusterTools(fakeBin);
  const shells = process.env.BOOTSTRAP_TEST_SHELLS?.split(",").filter(Boolean) ?? ["bash", "pwsh"];
  for (const shell of shells) {
    const topologies = process.env.BOOTSTRAP_TEST_PROFILES?.split(",").filter(Boolean) ?? ["non-ha", "ha"];
    for (const topology of topologies) {
      const suffix = `${shell}-${topology}`;
      const config = configuration(topology);
      config.naming.suffix = suffix;
      const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-lifecycle-"));
      const configPath = resolve(directory, "config.json");
      await writeFile(configPath, stableJson(config));
      const release = `dev-realtime-${suffix}`;
      const environment = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        BOOTSTRAP_FAKE_RELEASE: release,
        BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`,
      };
      const invoke = async (action, extra = [], additionalEnvironment = {}) => {
        const [file, args] = shellInvocation(shell, action, configPath, extra);
        return execute(file, args, { cwd: repositoryRoot, env: { ...environment, ...additionalEnvironment } });
      };
      const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
      const targetBackups = resolve(repositoryRoot, `.backups/bootstrap/${release}`);
      try {
        await invoke("install");
        await invoke("install");
        await invoke("update");
        await invoke("validate");
        await invoke("recover");
        const captured = await invoke("backup");
        const backupEvent = captured.stdout.trim().split(/\r?\n/).map(line => {
          try { return JSON.parse(line); } catch { return undefined; }
        }).find(event => event?.message === "Pre-change state captured.");
        assert(backupEvent?.backup);
        const rollbackExtra = shell === "bash" ? ["--backup", backupEvent.backup] : ["-Backup", backupEvent.backup];
        await invoke("rollback", rollbackExtra);
        await assert.rejects(invoke("update", [], { BOOTSTRAP_FAKE_FAIL: "rollout" }), error => error.code === 1 && /injected rollout failure/.test(error.stderr));
        assert.equal(await fileExists(resolve(targetRoot, "operation.lock")), false);
        await invoke("teardown", shell === "bash" ? ["--force"] : ["-Force"]);
      } finally {
        await rm(targetRoot, { recursive: true, force: true });
        await rm(targetBackups, { recursive: true, force: true });
      }
    }
  }
});

test("cluster, permission, credential, Redis, and rollout failures stop safely and release the lock", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("the hermetic failure matrix runs on Ubuntu CI");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-failures-"));
  await fakeClusterTools(fakeBin);
  for (const failure of ["cluster", "permission", "credential", "redis", "rollout"]) {
    const config = configuration();
    config.naming.suffix = `failure-${failure}`;
    const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-failure-config-"));
    const configPath = resolve(directory, "config.json");
    await writeFile(configPath, stableJson(config));
    const release = `dev-realtime-failure-${failure}`;
    const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
    const targetBackups = resolve(repositoryRoot, `.backups/bootstrap/${release}`);
    try {
      await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "install", "--config", configPath], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          BOOTSTRAP_FAKE_FAIL: failure,
          BOOTSTRAP_FAKE_RELEASE: release,
          BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`,
        },
      }), error => error.code === 1);
      assert.equal(await fileExists(resolve(targetRoot, "operation.lock")), false);
      if (["redis", "rollout"].includes(failure)) assert.equal(await fileExists(targetBackups), true);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
      await rm(targetBackups, { recursive: true, force: true });
    }
  }
});

test("timeouts are bounded by the versioned CLI contract", async () => {
  await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "plan", "--timeout-seconds", "59"], { cwd: repositoryRoot }), error => error.code === 2 && /60 through 1800/.test(error.stdout));
});
