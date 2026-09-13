import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildPlan, fileExists, inlineSecretPaths, loadContract, renderValues, stableJson, validateConfiguration,
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
    topologySpreadConstraints: { enabled: false, zoneWhenUnsatisfiable: "ScheduleAnyway" },
  });
  const haValues = renderValues(ha, profiles.ha);
  assert.equal(haValues.replicaCount, 3);
  assert.equal(haValues.autoscaling.minReplicas, 3);
  assert.equal(haValues.podDisruptionBudget.minAvailable, 2);
  assert.equal(haValues.topologySpreadConstraints.enabled, true);
  assert.equal(haValues.topologySpreadConstraints.zoneWhenUnsatisfiable, "DoNotSchedule");
  assert.deepEqual(haValues.gateway.allowedOrigins, ha.ingress.allowedOrigins);
  assert.deepEqual(haValues.networkPolicy.ingressPodSelector.matchLabels, ha.networking.traefikPodLabels);
});

test("digest, Redis TLS, ingress origins, and OTLP egress are rendered from configuration", () => {
  const config = configuration();
  config.image.digest = `sha256:${"a".repeat(64)}`;
  config.redis.mode = "external";
  config.redis.externalEndpoint = "redis.example.test:6380";
  config.redis.externalEgressCidrs = ["192.0.2.50/32"];
  config.redis.tls = true;
  config.observability.otlpEndpoint = "https://collector.example.test";
  config.observability.otlpHeadersSecret = "otel-headers";
  config.observability.otlpEgressCidrs = ["192.0.2.50/32"];
  const values = renderValues(config, profiles["non-ha"]);
  assert.equal(values.image.digest, config.image.digest);
  assert.equal(values.redis.tls, true);
  assert.equal(values.redis.port, 6380);
  assert.deepEqual(values.networkPolicy.externalRedisCidrs, config.redis.externalEgressCidrs);
  assert.deepEqual(values.gateway.allowedOrigins, config.ingress.allowedOrigins);
  assert.deepEqual(values.observability.otlp.egressCidrs, config.observability.otlpEgressCidrs);
  assert.deepEqual(values.observability.otlp.headersSecret, { name: "otel-headers", key: "headers" });
  assert.deepEqual(values.networkPolicy.monitoringNamespaceSelector.matchLabels, config.observability.monitoringNamespaceLabels);
});

test("the immutable image digest is optional but validated when supplied", () => {
  const withoutDigest = configuration();
  delete withoutDigest.image.digest;
  assert.deepEqual(validateConfiguration(withoutDigest), []);
  withoutDigest.image.digest = "sha256:not-a-digest";
  assert(validateConfiguration(withoutDigest).some(item => item.path === "$.image.digest"));
});

test("Helm backup values containing inline credentials are detected by path", () => {
  assert.deepEqual(inlineSecretPaths({ auth: { password: "exposed", apiKey: "exposed", existingSecret: "safe", passwordKey: "safe" }, tls: { privateKey: "exposed" } }), ["$.auth.password", "$.auth.apiKey", "$.tls.privateKey"]);
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
  config.redis.externalEgressCidrs = ["192.0.2.50/32"];
  config.redis.externalHaConfirmed = false;
  assert(validateConfiguration(config).some(item => item.path === "$.redis.externalHaConfirmed"));
  config.redis.externalHaConfirmed = true;
  assert.deepEqual(validateConfiguration(config), []);
});

test("managed Redis rejects an unsupported TLS mismatch while external Redis accepts TLS", () => {
  const config = configuration();
  config.redis.tls = true;
  assert(validateConfiguration(config).some(item => item.path === "$.redis.tls"));
  config.redis.mode = "external";
  config.redis.externalEndpoint = "redis.example.test:6380";
  config.redis.externalEgressCidrs = ["192.0.2.50/32"];
  assert.deepEqual(validateConfiguration(config), []);
});

test("OTLP URL credentials and path traversal segments fail closed", () => {
  const config = configuration();
  config.observability.otlpEndpoint = "https://user:token@collector.example.test";
  config.observability.otlpEgressCidrs = ["192.0.2.50/32"];
  config.paths.backupDirectory = ".backups/../scripts";
  const errors = validateConfiguration(config);
  assert(errors.some(item => item.path === "$.observability.otlpEndpoint" && item.message.includes("userinfo")));
  assert(errors.some(item => item.path === "$.paths.backupDirectory"));
});

test("ServiceMonitor selectors and external Redis egress boundaries are explicit", () => {
  const config = configuration();
  config.observability.monitoringPodLabels = {};
  assert(validateConfiguration(config).some(item => item.path === "$.observability"));
  config.observability.serviceMonitor = false;
  assert.deepEqual(validateConfiguration(config), []);
  config.redis.mode = "external";
  config.redis.externalEndpoint = "redis.example.test:6379";
  assert(validateConfiguration(config).some(item => item.path === "$.redis.externalEgressCidrs"));
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

test("installed Helm topology remains authoritative when local state is absent", async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-conversion-"));
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-conversion-tools-"));
  await fakeClusterTools(fakeBin);
  const config = configuration("ha");
  config.naming.suffix = "contract-test";
  const path = resolve(directory, "config.json");
  await writeFile(path, stableJson(config));
  const targetRoot = resolve(repositoryRoot, ".bootstrap/lifecycle/dev-realtime-contract-test");
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "update", "--config", path], {
      cwd: repositoryRoot,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: "dev-realtime-contract-test", BOOTSTRAP_FAKE_REDIS_RELEASE: "dev-realtime-contract-test-redis", BOOTSTRAP_FAKE_TOPOLOGY: "non-ha" },
    }), error => error.code === 3 && /confirm-topology-change/.test(error.stdout));
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
if [[ -n "\${BOOTSTRAP_FAKE_LOG:-}" ]]; then printf '%s\\n' "$*" >> "$BOOTSTRAP_FAKE_LOG"; fi
if [[ "\${BOOTSTRAP_FAKE_FAIL:-}" == 'redis' && "$*" == *"$BOOTSTRAP_FAKE_REDIS_RELEASE"* && "\${1:-}" == 'upgrade' ]]; then printf '%s\\n' 'injected Redis failure' >&2; exit 9; fi
case "\${1:-}" in
  version) printf '%s\\n' 'v4.2.0+fake' ;;
  list) if [[ "\${BOOTSTRAP_FAKE_EMPTY_RELEASES:-}" == '1' ]]; then printf '[]\\n'; else printf '[{"name":"%s"},{"name":"%s"}]\\n' "$BOOTSTRAP_FAKE_RELEASE" "$BOOTSTRAP_FAKE_REDIS_RELEASE"; fi ;;
  get) if [[ "\${BOOTSTRAP_FAKE_INLINE_SECRET:-}" == '1' ]]; then printf '{"auth":{"password":"exposed"}}\\n'; else printf '{"topology":"%s","redis":{"mode":"%s"}}\\n' "\${BOOTSTRAP_FAKE_TOPOLOGY:-non-ha}" "\${BOOTSTRAP_FAKE_REDIS_MODE:-managed}"; fi ;;
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
        BOOTSTRAP_FAKE_TOPOLOGY: topology,
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

test("managed Redis uses the hardened ACL values and rollback removes releases absent from backup", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-rollback-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-rollback-config-"));
  const config = configuration();
  config.naming.suffix = "rollback-fresh";
  const configPath = resolve(directory, "config.json");
  const operationLog = resolve(directory, "helm.log");
  await writeFile(configPath, stableJson(config));
  const release = "dev-realtime-rollback-fresh";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  const targetBackups = resolve(repositoryRoot, `.backups/bootstrap/${release}`);
  const environment = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_TOPOLOGY: "non-ha", BOOTSTRAP_FAKE_LOG: operationLog };
  try {
    const installed = await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "install", "--config", configPath], { cwd: repositoryRoot, env: { ...environment, BOOTSTRAP_FAKE_EMPTY_RELEASES: "1" } });
    const backup = installed.stdout.trim().split(/\r?\n/).map(line => {
      try { return JSON.parse(line); } catch { return undefined; }
    }).find(event => event?.message === "Pre-change state captured.")?.backup;
    assert(backup);
    await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "rollback", "--config", configPath, "--backup", backup], { cwd: repositoryRoot, env: environment });
    const log = await readFile(operationLog, "utf8");
    assert.match(log, /--values cluster\/redis\/managed-values.yaml/);
    assert.match(log, /auth\.acl\.userSecret=dev-realtime-redis/);
    assert.match(log, /auth\.existingSecretPasswordKey=redis-password/);
    assert.match(log, /auth\.acl\.users\[0\]\.username=realtime/);
    assert.match(log, new RegExp(`uninstall ${release}-redis .*--ignore-not-found`));
    assert.match(log, new RegExp(`uninstall ${release} .*--ignore-not-found`));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(targetBackups, { recursive: true, force: true });
  }
});

test("backup rejects and removes snapshots containing inline Helm credentials", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-secret-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-secret-config-"));
  const config = configuration();
  config.naming.suffix = "secret-backup";
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, stableJson(config));
  const release = "dev-realtime-secret-backup";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  const targetBackups = resolve(repositoryRoot, `.backups/bootstrap/${release}`);
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "backup", "--config", configPath], { cwd: repositoryRoot, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_INLINE_SECRET: "1" } }), error => error.code === 1 && /Refusing to persist inline credential values/.test(error.stdout));
    const entries = await fileExists(targetBackups) ? await (await import("node:fs/promises")).readdir(targetBackups) : [];
    assert.equal(entries.length, 0);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(targetBackups, { recursive: true, force: true });
  }
});

test("Redis mode changes require an explicit migration", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-mode-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-mode-config-"));
  const config = configuration();
  config.naming.suffix = "mode-change";
  config.redis.mode = "external";
  config.redis.externalEndpoint = "redis.example.test:6380";
  config.redis.externalEgressCidrs = ["192.0.2.50/32"];
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, stableJson(config));
  const release = "dev-realtime-mode-change";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "update", "--config", configPath], { cwd: repositoryRoot, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_REDIS_MODE: "managed" } }), error => error.code === 3 && /requires an explicit migration/.test(error.stdout));
  } finally { await rm(targetRoot, { recursive: true, force: true }); }
});

test("rollback classifies conversion from installed topology to backup topology", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-rollback-topology-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-rollback-topology-config-"));
  const config = configuration();
  config.naming.suffix = "rollback-topology";
  config.kubernetes.failureDomains = 3;
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, stableJson(config));
  const release = "dev-realtime-rollback-topology";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  const backup = resolve(repositoryRoot, `.backups/bootstrap/${release}/fixture`);
  await mkdir(backup, { recursive: true });
  await writeFile(resolve(backup, "plan.json"), stableJson({ target: { context: "kind-example", namespace: "dev-realtime", release } }));
  await writeFile(resolve(backup, "releases.json"), stableJson([{ name: release }, { name: `${release}-redis` }]));
  await writeFile(resolve(backup, `${release}.values.json`), stableJson({ topology: "ha", replicaCount: 3, redis: { mode: "managed" } }));
  await writeFile(resolve(backup, `${release}-redis.values.json`), stableJson({ architecture: "replication" }));
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "rollback", "--config", configPath, "--backup", backup], { cwd: repositoryRoot, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_TOPOLOGY: "non-ha" } }), error => error.code === 3 && /confirm-topology-change/.test(error.stdout));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(resolve(repositoryRoot, `.backups/bootstrap/${release}`), { recursive: true, force: true });
  }
});

test("name suffix override updates the plan and shared naming manifest", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-name-config-"));
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, stableJson(configuration()));
  const namingPath = resolve(repositoryRoot, ".bootstrap/naming.json");
  const priorNaming = await fileExists(namingPath) ? await readFile(namingPath, "utf8") : undefined;
  try {
    const result = await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "plan", "--config", configPath, "--name-suffix", "contract-name"], { cwd: repositoryRoot });
    assert.equal(normalizedPlan(result.stdout).target.application, "realtime-contract-name");
    const naming = JSON.parse(await readFile(namingPath, "utf8"));
    assert.equal(naming.application, "realtime-contract-name");
    assert.equal(naming.redisInstancePrefix, "cormier:realtime:contract-name");
  } finally {
    if (priorNaming === undefined) await rm(namingPath, { force: true });
    else await writeFile(namingPath, priorNaming);
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
