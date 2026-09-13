import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildPlan, fileExists, inlineSecretPaths, loadContract, renderValues, stableJson, useCapturedDeploymentValues, validateConfiguration,
} from "../../scripts/lib/bootstrap-contract.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const example = JSON.parse(await readFile(resolve(repositoryRoot, "bootstrap/config.example.json"), "utf8"));
const bootstrapSchema = JSON.parse(await readFile(resolve(repositoryRoot, "bootstrap/config.schema.json"), "utf8"));
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
  assert.deepEqual(renderValues(nonHa, profiles["non-ha"]).autoscaling, { enabled: false, minReplicas: 1, maxReplicas: 1 });
  assert.equal(renderValues(nonHa, profiles["non-ha"]).observability.prometheusRule.ingressEnabled, false);
  const haValues = renderValues(ha, profiles.ha);
  assert.equal(haValues.replicaCount, 3);
  assert.equal(haValues.autoscaling.minReplicas, 3);
  assert.equal(haValues.podDisruptionBudget.minAvailable, 2);
  assert.equal(haValues.topologySpreadConstraints.enabled, true);
  assert.equal(haValues.topologySpreadConstraints.zoneWhenUnsatisfiable, "DoNotSchedule");
  assert.deepEqual(haValues.gateway.allowedOrigins, ha.ingress.allowedOrigins);
  assert.deepEqual(haValues.gateway.trustedNetworks, ha.networking.trustedProxyCidrs);
  assert.deepEqual(haValues.networkPolicy.ingressNamespaceSelector.matchLabels, ha.networking.directIngressNamespaceLabels);
  assert.deepEqual(haValues.networkPolicy.ingressPodSelector.matchLabels, ha.networking.directIngressPodLabels);
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
  assert.equal(values.observability.cluster, config.observability.cluster);
  assert.deepEqual(values.observability.otlp.egressNamespaceSelector, {});
  assert.deepEqual(values.observability.otlp.egressPodSelector, {});
  assert.deepEqual(values.observability.otlp.headersSecret, { name: "otel-headers", key: "headers" });
  assert.deepEqual(values.networkPolicy.monitoringNamespaceSelector.matchLabels, config.observability.monitoringNamespaceLabels);
});

test("the immutable image digest is optional but validated when supplied", () => {
  const withoutDigest = configuration();
  delete withoutDigest.image.digest;
  assert.deepEqual(validateConfiguration(withoutDigest), []);
  withoutDigest.image.digest = "sha256:not-a-digest";
  assert(validateConfiguration(withoutDigest).some(item => item.path === "$.image.digest"));
  withoutDigest.image.digest = "";
  withoutDigest.image.tag = "bad tag@sha";
  assert(validateConfiguration(withoutDigest).some(item => item.path === "$.image.tag"));
});

test("Helm backup values containing inline credentials are detected by path", () => {
  assert.deepEqual(inlineSecretPaths({ auth: { password: "exposed", apiKey: "exposed", existingSecret: "safe", passwordKey: "safe" }, tls: { privateKey: "exposed" } }), ["$.auth.password", "$.auth.apiKey", "$.tls.privateKey"]);
  assert.deepEqual(inlineSecretPaths({ serviceAccount: { automountServiceAccountToken: false } }), []);
  assert.deepEqual(inlineSecretPaths({ auth: { passwords: ["first", "second"] } }), ["$.auth.passwords[0]", "$.auth.passwords[1]"]);
  assert.deepEqual(inlineSecretPaths({ oauth: { clientSecret: "exposed" } }), ["$.oauth.clientSecret"]);
});

test("HA rejects insufficient failure domains", () => {
  assert(bootstrapSchema.allOf.some(rule => rule.if?.properties?.topology?.const === "ha" && rule.then?.properties?.kubernetes?.properties?.failureDomains?.minimum === 3));
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
  assert.equal(first.managedRedis.values.global.storageClass, config.kubernetes.storageClass);
  assert.equal(first.managedRedis.values.master.persistence.size, config.resources.redisStorage);
  assert.equal(first.managedRedis.values.replica.topologySpreadConstraints[0].topologyKey, "topology.kubernetes.io/zone");
  const resized = structuredClone(config);
  resized.resources.redisStorage = "16Gi";
  assert.notEqual(buildPlan("update", resized, profiles.ha).valuesSha256, first.valuesSha256);
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
  assert(bootstrapSchema.allOf.some(rule => rule.if?.properties?.topology?.const === "ha" && rule.then?.properties?.redis?.properties?.externalHaConfirmed?.const === true));
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
  config.ingress.allowedOrigins = ["https://user:token@realtime.example.test"];
  const errors = validateConfiguration(config);
  assert(errors.some(item => item.path === "$.observability.otlpEndpoint" && item.message.includes("userinfo")));
  assert(errors.some(item => item.path === "$.paths.backupDirectory"));
  assert(errors.some(item => item.path === "$.ingress.allowedOrigins[0]"));
  config.observability.otlpEndpoint = "https://collector.example.test/v1/traces?api_key=secret";
  assert(validateConfiguration(config).some(item => item.path === "$.observability.otlpEndpoint" && item.message.includes("query string")));
  config.observability.otlpEndpoint = "https://collector.example.test/v1/traces";
  config.observability.otlpEgressCidrs = ["999.999.999.999/99"];
  assert(validateConfiguration(config).some(item => item.path === "$.observability.otlpEgressCidrs"));
});

test("MetalLB monitoring accepts IPv4 and IPv6 addresses and rejects malformed values", () => {
  const config = configuration();
  config.networking.metalLbAddress = "2001:db8::10";
  assert.deepEqual(validateConfiguration(config), []);
  config.networking.metalLbAddress = "999.999.1.1";
  assert(validateConfiguration(config).some(item => item.path === "$.networking.metalLbAddress"));
  config.networking.metalLbAddress = "deadbeef";
  assert(validateConfiguration(config).some(item => item.path === "$.networking.metalLbAddress"));
});

test("rollback plans use the exact captured gateway and managed Redis values", () => {
  const desired = buildPlan("rollback", configuration(), profiles["non-ha"]);
  const gateway = { image: { repository: "registry.example.test/cormier/realtime", tag: "captured" }, topology: "non-ha" };
  const redis = { architecture: "standalone", master: { persistence: { size: "32Gi" } } };
  const captured = useCapturedDeploymentValues(desired, gateway, redis, "oci://registry.example.test/charts/redis", "22.3.4");
  assert.deepEqual(captured.values, gateway);
  assert.deepEqual(captured.managedRedis.values, redis);
  assert.equal(captured.managedRedis.chartVersion, "22.3.4");
  assert.equal(captured.managedRedis.chart, "oci://registry.example.test/charts/redis");
  assert.notEqual(captured.valuesSha256, desired.valuesSha256);
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
  config.redis.externalEgressCidrs = ["192.0.2.50/32"];
  config.redis.externalEndpoint = "redis.example.test:99999";
  assert(validateConfiguration(config).some(item => item.path === "$.redis.externalEndpoint" && item.message.includes("65535")));
  config.redis.externalEndpoint = "....:6379";
  assert(validateConfiguration(config).some(item => item.path === "$.redis.externalEndpoint"));
  config.redis.externalEndpoint = "-bad:6379";
  assert(validateConfiguration(config).some(item => item.path === "$.redis.externalEndpoint"));
});

test("ingress mode selects explicit traffic sources and optional certificate monitoring", () => {
  const config = configuration();
  const direct = renderValues(config, profiles["non-ha"]);
  assert.deepEqual(direct.networkPolicy.ingressNamespaceSelector.matchLabels, config.networking.directIngressNamespaceLabels);
  config.networking.directIngressNamespaceLabels = {};
  assert(validateConfiguration(config).some(item => item.path === "$.networking.directIngressNamespaceLabels"));
  config.ingress.enabled = true;
  config.ingress.certificateName = "realtime-certificate";
  assert.deepEqual(validateConfiguration(config), []);
  const ingress = renderValues(config, profiles["non-ha"]);
  assert.deepEqual(ingress.networkPolicy.ingressNamespaceSelector.matchLabels, { "kubernetes.io/metadata.name": config.networking.traefikNamespace });
  assert.deepEqual(ingress.networkPolicy.ingressPodSelector.matchLabels, config.networking.traefikPodLabels);
  assert.equal(ingress.observability.platformMetrics.certificateName, "realtime-certificate");
});

test("proxy trust, observability labels, and resource units fail closed", () => {
  const config = configuration();
  config.networking.trustedProxyCidrs = [];
  config.observability.cluster = "Cluster_A";
  config.resources.gatewayMemory = "1m";
  config.resources.redisStorage = "1m";
  config.networking.traefikPodLabels = { "bad key": "bad value" };
  config.kubernetes.namespace = "a".repeat(64);
  const paths = validateConfiguration(config).map(item => item.path);
  assert(paths.includes("$.networking.trustedProxyCidrs"));
  assert(paths.includes("$.observability.cluster"));
  assert(paths.includes("$.resources.gatewayMemory"));
  assert(paths.includes("$.resources.redisStorage"));
  assert(paths.some(path => path.startsWith("$.networking.traefikPodLabels")));
  assert(paths.includes("$.kubernetes.namespace"));
  config.networking.trustedProxyCidrs = ["2001:db8::/32"];
  config.observability.cluster = "a".repeat(64);
  assert(validateConfiguration(config).some(item => item.path === "$.observability.cluster"));
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
  config.paths.generatedDirectory = ".bootstrap/alternate-lock-output";
  const path = resolve(directory, "config.json");
  await writeFile(path, stableJson(config));
  const targetRoot = resolve(repositoryRoot, ".bootstrap/alternate-lock-output/dev-realtime-lock-test");
  const lockPath = resolve(repositoryRoot, ".bootstrap/locks/dev-realtime-lock-test");
  await mkdir(lockPath, { recursive: true });
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "install", "--config", path], { cwd: repositoryRoot }), error => error.code === 3 && /target lock/.test(error.stdout));
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "plan", "--config", path], { cwd: repositoryRoot }), error => error.code === 3 && /target lock/.test(error.stdout));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
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
if [[ -n "\${BOOTSTRAP_FAKE_DELAY:-}" ]]; then sleep "$BOOTSTRAP_FAKE_DELAY"; fi
if [[ "\${BOOTSTRAP_FAKE_FAIL:-}" == 'redis' && "$*" == *"$BOOTSTRAP_FAKE_REDIS_RELEASE"* && "\${1:-}" == 'upgrade' ]]; then printf '%s\\n' 'injected Redis failure' >&2; exit 9; fi
case "\${1:-}" in
  version) printf '%s\\n' 'v4.2.0+fake' ;;
  list) if [[ "\${BOOTSTRAP_FAKE_EMPTY_RELEASES:-}" == '1' ]]; then printf '[]\\n'; else printf '[{"name":"%s","chart":"realtime-gateway-0.1.0","revision":"3"},{"name":"%s","chart":"redis-%s","revision":"4"}]\\n' "$BOOTSTRAP_FAKE_RELEASE" "$BOOTSTRAP_FAKE_REDIS_RELEASE" "\${BOOTSTRAP_FAKE_REDIS_CHART_VERSION:-23.1.1}"; fi ;;
  get) if [[ "\${BOOTSTRAP_FAKE_INLINE_SECRET:-}" == '1' ]]; then printf '{"auth":{"password":"exposed"}}\\n'; elif [[ "\${3:-}" == "$BOOTSTRAP_FAKE_REDIS_RELEASE" ]]; then printf '{"architecture":"standalone","commonAnnotations":{"cormier.solutions/managed-chart":"%s"}}\\n' "\${BOOTSTRAP_FAKE_INSTALLED_REDIS_CHART:-oci://registry-1.docker.io/bitnamicharts/redis}"; else printf '{"topology":"%s","redis":{"mode":"%s"}}\\n' "\${BOOTSTRAP_FAKE_TOPOLOGY:-non-ha}" "\${BOOTSTRAP_FAKE_REDIS_MODE:-managed}"; fi ;;
  lint|template|upgrade|uninstall|rollback) printf '%s\\n' 'ok' ;;
  *) printf 'unsupported fake helm command: %s\\n' "\${1:-}" >&2; exit 64 ;;
esac
`;
  const kubectl = `#!/usr/bin/env bash
set -euo pipefail
joined="$*"
if [[ -n "\${BOOTSTRAP_FAKE_LOG:-}" ]]; then printf 'kubectl %s\\n' "$*" >> "$BOOTSTRAP_FAKE_LOG"; fi
if [[ "\${BOOTSTRAP_FAKE_WARN:-}" == '1' ]]; then printf '%s\\n' 'benign kubeconfig warning' >&2; fi
if [[ "$joined" == 'config current-context' ]]; then printf '%s\\n' 'kind-example'
elif [[ "$joined" == *'cluster-info'* && "\${BOOTSTRAP_FAKE_FAIL:-}" == 'cluster' ]]; then printf '%s\\n' 'injected Kubernetes network failure' >&2; exit 9
elif [[ "$joined" == *'get nodes --output json'* ]]; then
  if [[ "\${BOOTSTRAP_FAKE_TAINTED_NODES:-}" == '1' ]]; then
    printf '%s\\n' '{"items":[{"metadata":{"labels":{"topology.kubernetes.io/zone":"zone-a"}},"spec":{},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"topology.kubernetes.io/zone":"zone-b"}},"spec":{},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"topology.kubernetes.io/zone":"zone-c"}},"spec":{"taints":[{"key":"dedicated","effect":"NoSchedule"}]},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}'
  else
    printf '%s\\n' '{"items":[{"metadata":{"labels":{"topology.kubernetes.io/zone":"zone-a"}},"spec":{},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"topology.kubernetes.io/zone":"zone-b"}},"spec":{},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"topology.kubernetes.io/zone":"zone-c"}},"spec":{},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}'
  fi
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

test("PowerShell delegates unsupported actions to the shared exit-code contract", async () => {
  await assert.rejects(execute("pwsh", ["-NoProfile", "-File", resolve(repositoryRoot, "scripts/Realtime-Bootstrap.ps1"), "-Action", "unsupported-action"], { cwd: repositoryRoot }), error => error.code === 2 && /Action must be one of/.test(error.stdout));
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
        assert.equal(await fileExists(resolve(repositoryRoot, `.bootstrap/locks/${release}`)), false);
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
    const redisValues = JSON.parse(await readFile(resolve(targetRoot, "redis-values.json"), "utf8"));
    assert.equal(redisValues.auth.acl.userSecret, "dev-realtime-redis");
    assert.equal(redisValues.auth.existingSecretPasswordKey, "redis-password");
    assert.equal(redisValues.auth.acl.users[0].username, "realtime");
    assert.equal(redisValues.master.pdb.create, false);
    assert.equal(redisValues.replica.pdb.create, false);
    const updated = await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "update", "--config", configPath], { cwd: repositoryRoot, env: { ...environment, BOOTSTRAP_FAKE_INSTALLED_REDIS_CHART: "oci://mirror.example.test/charts/redis" } });
    const updateBackup = updated.stdout.trim().split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(event => event?.message === "Pre-change state captured.")?.backup;
    const capturedPlan = JSON.parse(await readFile(resolve(updateBackup, "plan.json"), "utf8"));
    assert.equal(capturedPlan.managedRedis.chart, "oci://mirror.example.test/charts/redis");
    await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "rollback", "--config", configPath, "--backup", backup], { cwd: repositoryRoot, env: environment });
    const log = await readFile(operationLog, "utf8");
    assert.match(log, /--values cluster\/redis\/managed-values.yaml/);
    assert.match(log, new RegExp(`--values .*${release}[/\\\\]redis-values\\.json`));
    assert.match(log, new RegExp(`kubectl rollout restart deployment/${release}`));
    assert.match(log, new RegExp(`uninstall ${release}-redis .*--ignore-not-found`));
    assert.match(log, new RegExp(`uninstall ${release} .*--ignore-not-found`));
    assert.doesNotMatch(log, /get namespace metallb-system/);
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
  await writeFile(resolve(backup, "plan.json"), stableJson({ target: { context: "kind-example", namespace: "dev-realtime", release }, managedRedis: { chart: config.redis.managedChart } }));
  await writeFile(resolve(backup, "releases.json"), stableJson([{ name: release, chart: "realtime-gateway-0.1.0", revision: "3" }, { name: `${release}-redis`, chart: "redis-23.1.1", revision: "4" }]));
  await writeFile(resolve(backup, `${release}.values.json`), stableJson({ topology: "ha", replicaCount: 3, redis: { mode: "managed" } }));
  await writeFile(resolve(backup, `${release}-redis.values.json`), stableJson({ architecture: "replication" }));
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "rollback", "--config", configPath, "--backup", backup], { cwd: repositoryRoot, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_TOPOLOGY: "non-ha" } }), error => error.code === 3 && /confirm-topology-change/.test(error.stdout));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(resolve(repositoryRoot, `.backups/bootstrap/${release}`), { recursive: true, force: true });
  }
});

test("rollback rejects cross-mode restoration and restores the captured Redis chart version", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-rollback-version-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-rollback-version-config-"));
  const config = configuration();
  config.naming.suffix = "rollback-version";
  const configPath = resolve(directory, "config.json");
  const release = "dev-realtime-rollback-version";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  const backup = resolve(repositoryRoot, `.backups/bootstrap/${release}/fixture`);
  const operationLog = resolve(directory, "operations.log");
  await writeFile(configPath, stableJson(config));
  await mkdir(backup, { recursive: true });
  await writeFile(resolve(backup, "plan.json"), stableJson({ target: { context: "kind-example", namespace: "dev-realtime", release }, managedRedis: { chart: "oci://mirror.example.test/charts/redis" } }));
  await writeFile(resolve(backup, "releases.json"), stableJson([{ name: release, chart: "realtime-gateway-0.1.0", revision: "3" }, { name: `${release}-redis`, chart: "redis-22.3.4", revision: "4" }]));
  await writeFile(resolve(backup, `${release}.values.json`), stableJson({ replicaCount: 1, redis: { mode: "managed" } }));
  await writeFile(resolve(backup, `${release}-redis.values.json`), stableJson({ architecture: "standalone" }));
  const environment = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_LOG: operationLog };
  try {
    await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "rollback", "--config", configPath, "--backup", backup], { cwd: repositoryRoot, env: environment });
    const operations = await readFile(operationLog, "utf8");
    assert.match(operations, new RegExp(`upgrade --install ${release}-redis oci://mirror\\.example\\.test/charts/redis --version 22\\.3\\.4`));
    assert.match(operations, new RegExp(`rollback ${release} 3 .*--kube-context kind-example`));
    assert.match(operations, /kubectl .*--context kind-example/);
    assert.doesNotMatch(operations, /^lint /m);
    const rollbackPlan = JSON.parse(await readFile(resolve(targetRoot, "plan.json"), "utf8"));
    const rollbackState = JSON.parse(await readFile(resolve(targetRoot, "state.json"), "utf8"));
    assert.deepEqual(rollbackPlan.values, { replicaCount: 1, redis: { mode: "managed" } });
    assert.deepEqual(rollbackPlan.managedRedis.values, { architecture: "standalone" });
    assert.equal(rollbackPlan.managedRedis.chartVersion, "22.3.4");
    assert.equal(rollbackState.valuesSha256, rollbackPlan.valuesSha256);
    await writeFile(resolve(backup, `${release}.values.json`), stableJson({ topology: "non-ha", redis: { mode: "external" } }));
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "rollback", "--config", configPath, "--backup", backup], { cwd: repositoryRoot, env: environment }), error => error.code === 3 && /Redis mode rollback conversion.*explicit migration/.test(error.stdout));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(resolve(repositoryRoot, `.backups/bootstrap/${release}`), { recursive: true, force: true });
  }
});

test("teardown skips desired-state prerequisites while retaining target and deletion checks", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-teardown-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-teardown-config-"));
  const config = configuration();
  config.naming.suffix = "teardown-preflight";
  const configPath = resolve(directory, "config.json");
  const operationLog = resolve(directory, "operations.log");
  const release = "dev-realtime-teardown-preflight";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  const targetBackups = resolve(repositoryRoot, `.backups/bootstrap/${release}`);
  await writeFile(configPath, stableJson(config));
  await mkdir(targetRoot, { recursive: true });
  await writeFile(resolve(targetRoot, "state.json"), stableJson({ contractVersion: 1, topology: "non-ha" }));
  try {
    await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "backup", "--config", configPath], { cwd: repositoryRoot, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_FAIL: "credential", BOOTSTRAP_FAKE_LOG: operationLog } });
    await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "teardown", "--config", configPath, "--force"], { cwd: repositoryRoot, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_FAIL: "credential", BOOTSTRAP_FAKE_LOG: operationLog } });
    const log = await readFile(operationLog, "utf8");
    assert.match(log, /kubectl auth can-i delete deployments\.apps/);
    assert.doesNotMatch(log, /kubectl get (?:secret|storageclass|nodes)/);
    assert.match(log, new RegExp(`uninstall ${release} .*--ignore-not-found`));
    assert.equal(await fileExists(resolve(targetRoot, "state.json")), false);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(targetBackups, { recursive: true, force: true });
  }
});

test("external Redis skips unused storage and HA excludes untolerated nodes", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-capacity-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-capacity-config-"));
  const operationLog = resolve(directory, "operations.log");
  const external = configuration();
  external.naming.suffix = "external-storage";
  external.redis.mode = "external";
  external.redis.externalEndpoint = "redis.example.test:6379";
  external.redis.externalEgressCidrs = ["192.0.2.50/32"];
  const externalPath = resolve(directory, "external.json");
  await writeFile(externalPath, stableJson(external));
  const environment = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: "dev-realtime-external-storage", BOOTSTRAP_FAKE_REDIS_RELEASE: "dev-realtime-external-storage-redis", BOOTSTRAP_FAKE_LOG: operationLog, BOOTSTRAP_FAKE_WARN: "1" };
  try {
    await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "validate", "--config", externalPath], { cwd: repositoryRoot, env: environment });
    const externalLog = await readFile(operationLog, "utf8");
    assert.doesNotMatch(externalLog, /kubectl get storageclass/);
    assert.doesNotMatch(externalLog, /kubectl get (?:namespace traefik|service traefik)/);

    const ha = configuration("ha");
    ha.naming.suffix = "tainted-capacity";
    const haPath = resolve(directory, "ha.json");
    await writeFile(haPath, stableJson(ha));
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "validate", "--config", haPath], { cwd: repositoryRoot, env: { ...environment, BOOTSTRAP_FAKE_TAINTED_NODES: "1" } }), error => error.code === 1 && /ready schedulable nodes/.test(error.stdout));
  } finally {
    await rm(resolve(repositoryRoot, ".bootstrap/lifecycle/dev-realtime-external-storage"), { recursive: true, force: true });
    await rm(resolve(repositoryRoot, ".bootstrap/lifecycle/dev-realtime-tainted-capacity"), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale lifecycle locks are recovered with bounded owner metadata", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-stale-lock-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-stale-lock-config-"));
  const config = configuration();
  config.naming.suffix = "stale-lock";
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, stableJson(config));
  const release = "dev-realtime-stale-lock";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  const targetBackups = resolve(repositoryRoot, `.backups/bootstrap/${release}`);
  const lockPath = resolve(repositoryRoot, `.bootstrap/locks/${release}`);
  await mkdir(lockPath, { recursive: true });
  await writeFile(resolve(lockPath, "owner.json"), stableJson({ createdAt: new Date().toISOString(), hostname: hostname(), pid: 999999 }));
  try {
    const environment = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis` };
    await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "backup", "--config", configPath], { cwd: repositoryRoot, env: environment });
    assert.equal(await fileExists(lockPath), false);
    await mkdir(lockPath, { recursive: true });
    await writeFile(resolve(lockPath, "owner.json"), stableJson({ createdAt: new Date().toISOString(), hostname: hostname(), pid: 999999 }));
    const contenders = await Promise.allSettled(Array.from({ length: 6 }, () => execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "backup", "--config", configPath], { cwd: repositoryRoot, env: { ...environment, BOOTSTRAP_FAKE_DELAY: "0.2" } })));
    assert.equal(contenders.filter(result => result.status === "fulfilled").length, 1);
    assert(contenders.filter(result => result.status === "rejected").every(result => result.reason.code === 3 && /target lock/.test(result.reason.stdout)));
    assert.equal(await fileExists(lockPath), false);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(targetBackups, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
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
    assert.equal(naming.redisInstancePrefix, "cormier:realtime:dev:contract-name");
    assert.equal(await fileExists(resolve(repositoryRoot, ".bootstrap/locks/naming-manifest")), false);
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
      assert.equal(await fileExists(resolve(repositoryRoot, `.bootstrap/locks/${release}`)), false);
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
