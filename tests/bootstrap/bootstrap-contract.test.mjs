import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildPlan, fileExists, inlineSecretPaths, loadContract, renderValues, stableJson, useCapturedDeploymentValues, validateConfiguration,
} from "../../scripts/lib/bootstrap-contract.mjs";
import { managedRedisChartOutput, patchSentinelService, prepareManagedRedisChart } from "../../scripts/lib/managed-redis-chart.mjs";
import { buildCertificateManifest, parseCertificateArguments } from "../../scripts/realtime-certificate.mjs";
import { normalizePasswordBytes, resolveRedisSecretOptions } from "../../scripts/realtime-redis-secret.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const example = JSON.parse(await readFile(resolve(repositoryRoot, "bootstrap/config.example.json"), "utf8"));
const haExample = JSON.parse(await readFile(resolve(repositoryRoot, "bootstrap/config.ha.example.json"), "utf8"));
const bootstrapSchema = JSON.parse(await readFile(resolve(repositoryRoot, "bootstrap/config.schema.json"), "utf8"));
const helmSchema = JSON.parse(await readFile(resolve(repositoryRoot, "helm/realtime-gateway/values.schema.json"), "utf8"));
const profiles = {
  "non-ha": JSON.parse(await readFile(resolve(repositoryRoot, "bootstrap/profiles/non-ha.json"), "utf8")),
  ha: JSON.parse(await readFile(resolve(repositoryRoot, "bootstrap/profiles/ha.json"), "utf8")),
};
let managedChartFixtureSha256;

function configuration(topology = "non-ha") {
  const result = structuredClone(example);
  result.topology = topology;
  result.kubernetes.failureDomains = topology === "ha" ? 3 : 1;
  if (managedChartFixtureSha256) result.redis.managedChartArchiveSha256 = managedChartFixtureSha256;
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
  assert.equal(haValues.ingressRoute.path, ha.ingress.webSocketPath);
  assert.equal(haValues.ingressRoute.fallbackPath, ha.ingress.httpFallbackPath);
});

test("the committed HA example is complete, secret-reference-only, and production shaped", () => {
  assert.deepEqual(validateConfiguration(haExample), []);
  assert.equal(haExample.topology, "ha");
  assert.equal(haExample.environment.class, "production");
  assert.equal(haExample.ingress.enabled, true);
  assert.equal(inlineSecretPaths(haExample).length, 0);
});

test("digest, Redis TLS, ingress origins, and OTLP egress are rendered from configuration", () => {
  const config = configuration();
  config.image.digest = `sha256:${"a".repeat(64)}`;
  config.image.pullSecretName = "registry.credentials";
  config.redis.mode = "external";
  config.redis.externalEndpoint = "redis.example.test:6380";
  config.redis.externalEgressCidrs = ["192.0.2.50/32"];
  config.redis.tls = true;
  config.observability.otlpEndpoint = "https://collector.example.test";
  config.observability.otlpHeadersSecret = "otel-headers";
  config.observability.otlpEgressCidrs = ["192.0.2.50/32"];
  const values = renderValues(config, profiles["non-ha"]);
  assert.equal(values.image.digest, config.image.digest);
  assert.equal(values.image.pullSecretName, "registry.credentials");
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
  withoutDigest.image.pullSecretName = "registry/credentials";
  assert(validateConfiguration(withoutDigest).some(item => item.path === "$.image.pullSecretName"));
});

test("Helm backup values containing inline credentials are detected by path", () => {
  assert.deepEqual(inlineSecretPaths({ auth: { password: "exposed", apiKey: "exposed", existingSecret: "safe", passwordKey: "safe" }, tls: { privateKey: "exposed" } }), ["$.auth.password", "$.auth.apiKey", "$.tls.privateKey"]);
  assert.deepEqual(inlineSecretPaths({ serviceAccount: { automountServiceAccountToken: false } }), []);
  assert.deepEqual(inlineSecretPaths({ auth: { passwords: ["first", "second"] } }), ["$.auth.passwords[0]", "$.auth.passwords[1]"]);
  assert.deepEqual(inlineSecretPaths({ oauth: { clientSecret: "exposed" } }), ["$.oauth.clientSecret"]);
  assert.deepEqual(inlineSecretPaths({ auth: { password: 123456, tokens: [42] } }), ["$.auth.password", "$.auth.tokens[0]"]);
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
  assert.equal(first.managedRedis.values.replica.podManagementPolicy, "OrderedReady");
  assert.equal(first.managedRedis.values.replica.startupProbe.failureThreshold, 60);
  assert.equal(first.managedRedis.values.sentinel.startupProbe.failureThreshold, 60);
  assert.deepEqual(first.managedRedis.values.replica.dnsConfig.options, [
    { name: "timeout", value: "2" },
    { name: "attempts", value: "3" },
    { name: "single-request-reopen" },
  ]);
  assert.equal(first.managedRedis.values.sentinel.customStartupProbe.failureThreshold, 60);
  assert.match(first.managedRedis.values.sentinel.customStartupProbe.exec.command.at(-1), /REDIS_PASSWORD_FILE/);
  assert.match(first.managedRedis.values.sentinel.customStartupProbe.exec.command.at(-1), /SENTINEL DEBUG tilt-trigger 10000/);
  assert.equal(first.managedRedis.values.image.digest, config.redis.managedImages.redis.digest);
  assert.equal(first.managedRedis.values.sentinel.image.digest, config.redis.managedImages.sentinel.digest);
  assert.equal(first.managedRedis.values.metrics.image.digest, config.redis.managedImages.exporter.digest);
  assert.deepEqual(first.managedRedis.values.global.imagePullSecrets, []);
  assert.equal(first.managedRedis.chartArchiveSha256, config.redis.managedChartArchiveSha256);
  const resized = structuredClone(config);
  resized.resources.redisStorage = "16Gi";
  assert.notEqual(buildPlan("update", resized, profiles.ha).valuesSha256, first.valuesSha256);
  assert.equal(first.safety.secretValuesAccepted, false);
  assert.equal(first.values.redis.credentialsSecret.name, config.redis.credentialsSecret);
  assert(!stableJson(first).includes("must-not-be-accepted"));
});

test("managed Redis chart patch publishes not-ready Sentinel service endpoints idempotently", () => {
  const source = "apiVersion: v1\nkind: Service\nspec:\n  type: {{ .Values.sentinel.service.type }}\n";
  const patched = patchSentinelService(source);
  assert.match(patched, /spec:\n  publishNotReadyAddresses: true\n  type:/);
  assert.equal(patchSentinelService(patched), patched);
  assert.throws(() => patchSentinelService("kind: Service\n"), /does not match the reviewed patch contract/);
  assert.notEqual(
    managedRedisChartOutput(".bootstrap/lifecycle", "prod-realtime", "oci://registry.example.test/a/redis", "23.1.1"),
    managedRedisChartOutput(".bootstrap/lifecycle", "prod-realtime", "oci://registry.example.test/b/redis", "23.1.1"),
  );
});

test("managed Redis accepts top-level repositories and renders existing pull Secrets", () => {
  const config = configuration();
  config.redis.managedImages.redis.repository = "redis";
  config.redis.managedImages.sentinel.repository = "redis-sentinel";
  config.redis.managedImages.exporter.repository = "redis-exporter";
  config.redis.managedImagePullSecrets = ["private-registry.example"];
  assert.deepEqual(validateConfiguration(config), []);
  assert.deepEqual(buildPlan("install", config, profiles["non-ha"]).managedRedis.values.global.imagePullSecrets, ["private-registry.example"]);
  config.redis.managedImagePullSecrets.push("private-registry.example");
  assert(validateConfiguration(config).some(item => item.path === "$.redis.managedImagePullSecrets"));
});

test("managed Redis chart preparation terminates a command that exceeds its lifecycle deadline", { timeout: 10_000 }, async t => {
  if (process.platform === "win32") return t.skip("POSIX process termination is exercised on the Ubuntu CI image");
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-chart-timeout-"));
  const helm = resolve(directory, "helm");
  await writeFile(helm, "#!/usr/bin/env bash\ntrap 'exit 143' TERM\nsleep 30\n", { mode: 0o755 });
  const started = Date.now();
  await assert.rejects(prepareManagedRedisChart({
    chart: "oci://registry.example.test/charts/redis",
    version: "23.1.1",
    archiveSha256: `sha256:${"a".repeat(64)}`,
    outputDirectory: resolve(directory, "output"),
    helm,
    timeoutSeconds: 0.1,
  }), /exceeded the lifecycle deadline and was terminated/);
  assert(Date.now() - started < 6000);
});

test("Redis password normalization removes only trailing line endings", () => {
  assert.equal(normalizePasswordBytes(Buffer.from("0123456789abcdef\n")).toString(), "0123456789abcdef");
  assert.equal(normalizePasswordBytes(Buffer.from("0123456789abcdef\r\n")).toString(), "0123456789abcdef");
  assert.throws(() => normalizePasswordBytes(Buffer.from("short\n")), /at least 16 bytes/);
  assert.throws(() => normalizePasswordBytes(Buffer.from("01234567\n89abcdef")), /embedded CR or LF/);
  assert.throws(() => normalizePasswordBytes(Buffer.from("01234567\0abcdefghi")), /must not contain NUL bytes/);
  assert.throws(() => normalizePasswordBytes(Buffer.from("                \n")), /must not contain only whitespace/);
});

test("managed Redis rejects duplicate administrator and ACL Secret keys", () => {
  const config = configuration();
  config.redis.adminCredentialKey = config.redis.credentialKey;
  assert(validateConfiguration(config).some(item => item.path === "$.redis.adminCredentialKey"));
});

test("WebSocket routing rejects case-insensitive collisions with fallback and fixed endpoints", () => {
  for (const path of ["/realtime/tickets", "/REALTIME/TICKETS", "/health/startup", "/health/live", "/health/ready", "/metrics"]) {
    const config = configuration();
    config.ingress.webSocketPath = path;
    assert(validateConfiguration(config).some(item => item.path === "$.ingress.webSocketPath"), path);
  }
  const collision = configuration();
  collision.ingress.webSocketPath = "/Realtime/Ws";
  collision.ingress.httpFallbackPath = "/realtime/ws";
  assert(validateConfiguration(collision).some(item => item.path === "$.ingress.httpFallbackPath"));
  const custom = configuration();
  custom.ingress.webSocketPath = "/health/custom";
  assert.deepEqual(validateConfiguration(custom), []);
});

test("credential and Certificate helpers derive target identities from configuration", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-helper-config-"));
  const config = structuredClone(haExample);
  config.kubernetes.context = "prod-context";
  const configPath = resolve(directory, "config.json");
  const adminPasswordPath = resolve(directory, "admin.txt");
  const realtimePasswordPath = resolve(directory, "realtime.txt");
  await writeFile(configPath, stableJson(config));
  await writeFile(adminPasswordPath, "0123456789abcdef0123456789abcdef");
  await writeFile(realtimePasswordPath, "fedcba9876543210fedcba9876543210");
  try {
    const secret = await resolveRedisSecretOptions({ config: configPath, adminPasswordFile: "admin", realtimePasswordFile: "realtime", kubectl: "kubectl" });
    assert.equal(secret.context, config.kubernetes.context);
    assert.equal(secret.namespace, config.kubernetes.namespace);
    assert.equal(secret.secretName, config.redis.credentialsSecret);
    assert.equal(secret.adminKey, config.redis.adminCredentialKey);
    assert.equal(secret.realtimeKey, config.redis.credentialKey);
    const certificateOptions = parseCertificateArguments(["--config", configPath, "--issuer-name", "letsencrypt-prod", "--dry-run"]);
    const certificate = buildCertificateManifest(config, certificateOptions);
    assert.equal(certificate.metadata.name, config.ingress.certificateName);
    assert.equal(certificate.metadata.namespace, config.kubernetes.namespace);
    assert.equal(certificate.spec.secretName, config.ingress.tlsSecretName);
    assert.deepEqual(certificate.spec.dnsNames, [config.ingress.host]);
    assert.equal(certificate.spec.issuerRef.name, "letsencrypt-prod");
    const secretDryRun = await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-redis-secret.mjs"), "--config", configPath, "--admin-password-file", adminPasswordPath, "--realtime-password-file", realtimePasswordPath, "--dry-run"], { cwd: repositoryRoot });
    assert.deepEqual(JSON.parse(secretDryRun.stdout), { changed: false, dryRun: true, namespace: config.kubernetes.namespace, secretName: config.redis.credentialsSecret });
    const certificateDryRun = await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-certificate.mjs"), "--config", configPath, "--issuer-name", "letsencrypt-prod", "--dry-run"], { cwd: repositoryRoot });
    assert.equal(JSON.parse(certificateDryRun.stdout).tlsSecret, config.ingress.tlsSecretName);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  config.observability.otlpEgressCidrs = ["192.0.2.50/32"];
  config.observability.otlpEndpoint = "https://collector.example.test:8443/v1/traces";
  assert(validateConfiguration(config).some(item => item.path === "$.observability.otlpEgressPorts" && item.message.includes("8443")));
});

test("MetalLB monitoring accepts IPv4 and IPv6 addresses and rejects malformed values", () => {
  const config = configuration();
  config.networking.metalLbAddress = "2001:db8::10";
  assert.deepEqual(validateConfiguration(config), []);
  config.networking.metalLbAddress = "999.999.1.1";
  assert(validateConfiguration(config).some(item => item.path === "$.networking.metalLbAddress"));
  config.networking.metalLbAddress = "deadbeef";
  assert(validateConfiguration(config).some(item => item.path === "$.networking.metalLbAddress"));
  config.networking.metalLbAddress = ":::";
  assert(validateConfiguration(config).some(item => item.path === "$.networking.metalLbAddress"));
  assert.deepEqual(helmSchema.properties.observability.properties.platformMetrics.properties.metalLbAddress.anyOf, [{ format: "ipv4" }, { format: "ipv6" }]);
  assert.equal(bootstrapSchema.$defs.ipv6Address.format, "ipv6");
  const cidrPattern = new RegExp(bootstrapSchema.$defs.cidr.pattern);
  assert(cidrPattern.test("2001:db8::/32"));
  assert.equal(cidrPattern.test(":::/128"), false);
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
  assert(bootstrapSchema.allOf.some(rule => rule.if?.properties?.ingress?.properties?.enabled?.const === true
    && rule.then?.properties?.ingress?.properties?.host?.minLength === 1
    && rule.then?.properties?.ingress?.properties?.tlsSecretName?.minLength === 1));
});

test("Secret references accept Kubernetes DNS subdomain names", () => {
  const config = configuration();
  config.redis.credentialsSecret = "realtime.redis-auth";
  config.ingress.tlsSecretName = "realtime.gateway-tls";
  config.observability.otlpHeadersSecret = "telemetry.headers";
  config.observability.otlpEndpoint = "https://collector.example.test";
  config.observability.otlpEgressCidrs = ["192.0.2.50/32"];
  assert.deepEqual(validateConfiguration(config), []);
});

test("Certificate and storage-class references accept DNS subdomains and reject path syntax", () => {
  const config = configuration();
  config.ingress.certificateName = "realtime.gateway-cert";
  config.kubernetes.storageClass = "storage.fast";
  assert.deepEqual(validateConfiguration(config), []);
  config.kubernetes.storageClass = "fast/storage";
  assert(validateConfiguration(config).some(item => item.path === "$.kubernetes.storageClass"));
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

test("an orphaned managed Redis release still requires topology-conversion confirmation", async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-orphan-redis-"));
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-orphan-redis-tools-"));
  await fakeClusterTools(fakeBin);
  const config = configuration("ha");
  config.naming.suffix = "orphan-redis";
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, stableJson(config));
  const release = "dev-realtime-orphan-redis";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "update", "--config", configPath], { cwd: repositoryRoot, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_ORPHAN_REDIS: "1", BOOTSTRAP_FAKE_REDIS_ARCHITECTURE: "standalone" } }), error => error.code === 3 && /confirm-topology-change/.test(error.stdout));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
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
  const chartFixtureRoot = resolve(directory, "chart-fixture");
  const chartFixture = resolve(directory, "redis-fixture.tgz");
  await mkdir(resolve(chartFixtureRoot, "redis/templates/sentinel"), { recursive: true });
  await writeFile(resolve(chartFixtureRoot, "redis/Chart.yaml"), "apiVersion: v2\nname: redis\nversion: 23.1.1\n");
  await writeFile(resolve(chartFixtureRoot, "redis/templates/sentinel/service.yaml"), "apiVersion: v1\nkind: Service\nspec:\n  type: {{ .Values.sentinel.service.type }}\n");
  await execute("tar", ["--sort=name", "--mtime=UTC 1970-01-01", "--owner=0", "--group=0", "--numeric-owner", "-czf", chartFixture, "redis"], { cwd: chartFixtureRoot });
  managedChartFixtureSha256 = `sha256:${createHash("sha256").update(await readFile(chartFixture)).digest("hex")}`;
  const shellChartFixture = chartFixture.replaceAll("'", "'\\''");
  const helm = `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${BOOTSTRAP_FAKE_LOG:-}" ]]; then printf '%s\\n' "$*" >> "$BOOTSTRAP_FAKE_LOG"; fi
if [[ -n "\${BOOTSTRAP_FAKE_DELAY:-}" ]]; then sleep "$BOOTSTRAP_FAKE_DELAY"; fi
if [[ "\${BOOTSTRAP_FAKE_FAIL:-}" == 'redis' && "$*" == *"$BOOTSTRAP_FAKE_REDIS_RELEASE"* && "\${1:-}" == 'upgrade' ]]; then printf '%s\\n' 'injected Redis failure' >&2; exit 9; fi
case "\${1:-}" in
  version) printf '%s\\n' 'v4.2.0+fake' ;;
  list) if [[ "\${BOOTSTRAP_FAKE_EMPTY_RELEASES:-}" == '1' ]]; then printf '[]\\n'; elif [[ "\${BOOTSTRAP_FAKE_ORPHAN_REDIS:-}" == '1' ]]; then printf '[{"name":"%s","chart":"redis-%s","revision":"4"}]\\n' "$BOOTSTRAP_FAKE_REDIS_RELEASE" "\${BOOTSTRAP_FAKE_REDIS_CHART_VERSION:-23.1.1}"; else printf '[{"name":"%s","chart":"realtime-gateway-0.1.0","revision":"3"},{"name":"%s","chart":"redis-%s","revision":"4"}]\\n' "$BOOTSTRAP_FAKE_RELEASE" "$BOOTSTRAP_FAKE_REDIS_RELEASE" "\${BOOTSTRAP_FAKE_REDIS_CHART_VERSION:-23.1.1}"; fi ;;
  get) if [[ "\${BOOTSTRAP_FAKE_INLINE_SECRET:-}" == '1' ]]; then printf '{"auth":{"password":"exposed"}}\\n'; elif [[ "\${3:-}" == "$BOOTSTRAP_FAKE_REDIS_RELEASE" && "\${BOOTSTRAP_FAKE_LEGACY_REDIS:-}" == '1' ]]; then printf '{"fullnameOverride":"%s","architecture":"%s","auth":{"existingSecret":"%s","existingSecretPasswordKey":"redis-password","acl":{"userSecret":"%s","users":[{"username":"realtime","keys":"~%s:*","channels":"&%s:*"}]}}}\\n' "$BOOTSTRAP_FAKE_REDIS_RELEASE" "\${BOOTSTRAP_FAKE_REDIS_ARCHITECTURE:-standalone}" "\${BOOTSTRAP_FAKE_REDIS_SECRET:-dev-realtime-redis}" "\${BOOTSTRAP_FAKE_REDIS_SECRET:-dev-realtime-redis}" "\${BOOTSTRAP_FAKE_REDIS_PREFIX:-cormier:realtime:dev}" "\${BOOTSTRAP_FAKE_REDIS_PREFIX:-cormier:realtime:dev}"; elif [[ "\${3:-}" == "$BOOTSTRAP_FAKE_REDIS_RELEASE" ]]; then printf '{"architecture":"%s","commonAnnotations":{"cormier.solutions/managed-chart":"%s"}}\\n' "\${BOOTSTRAP_FAKE_REDIS_ARCHITECTURE:-standalone}" "\${BOOTSTRAP_FAKE_INSTALLED_REDIS_CHART:-oci://registry-1.docker.io/bitnamicharts/redis}"; else printf '{"topology":"%s","redis":{"mode":"%s"}}\\n' "\${BOOTSTRAP_FAKE_TOPOLOGY:-non-ha}" "\${BOOTSTRAP_FAKE_REDIS_MODE:-managed}"; fi ;;
  pull) version=''; destination=''; shift; while (( $# )); do case "$1" in --version) version="$2"; shift 2;; --destination) destination="$2"; shift 2;; *) shift;; esac; done; cp '${shellChartFixture}' "$destination/redis-$version.tgz" ;;
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

async function seedManagedChartCache(fakeBin, release, chart = "oci://registry-1.docker.io/bitnamicharts/redis", version = "23.1.1", legacy = false) {
  await prepareManagedRedisChart({
    chart,
    version,
    archiveSha256: managedChartFixtureSha256,
    outputDirectory: legacy
      ? resolve(repositoryRoot, `.bootstrap/lifecycle/${release}/charts/redis-${version}`)
      : managedRedisChartOutput(resolve(repositoryRoot, ".bootstrap/lifecycle"), release, chart, version),
    helm: resolve(fakeBin, "helm"),
  });
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
  const script = resolve(repositoryRoot, "scripts/Realtime-Bootstrap.ps1");
  await assert.rejects(execute("pwsh", ["-NoProfile", "-File", script, "-Action", "unsupported-action"], { cwd: repositoryRoot }), error => error.code === 2 && /Action must be one of/.test(error.stdout));
  await assert.rejects(execute("pwsh", ["-NoProfile", "-File", script, "-Action", "plan", "-Topology", "invalid"], { cwd: repositoryRoot }), error => error.code === 2);
  await assert.rejects(execute("pwsh", ["-NoProfile", "-File", script, "-Action", "plan", "-NameSuffix", "INVALID"], { cwd: repositoryRoot }), error => error.code === 2);
  await assert.rejects(execute("pwsh", ["-NoProfile", "-File", script, "-Action", "plan", "-TimeoutSeconds", "5"], { cwd: repositoryRoot }), error => error.code === 2);
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
      const operationLog = resolve(directory, "operations.log");
      await writeFile(configPath, stableJson(config));
      const release = `dev-realtime-${suffix}`;
      const environment = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        BOOTSTRAP_FAKE_RELEASE: release,
        BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`,
        BOOTSTRAP_FAKE_TOPOLOGY: topology,
        BOOTSTRAP_FAKE_LOG: operationLog,
      };
      const invoke = async (action, extra = [], additionalEnvironment = {}) => {
        const [file, args] = shellInvocation(shell, action, configPath, extra);
        return execute(file, args, { cwd: repositoryRoot, env: { ...environment, ...additionalEnvironment } });
      };
      const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
      const targetBackups = resolve(repositoryRoot, `.backups/bootstrap/${release}`);
      try {
        await invoke("install", [], { BOOTSTRAP_FAKE_EMPTY_RELEASES: "1" });
        await invoke("install");
        await invoke("update");
        await invoke("validate");
        await writeFile(operationLog, "");
        await invoke("recover");
        const recoverLog = await readFile(operationLog, "utf8");
        const redisStatefulSet = topology === "ha" ? `${release}-redis-node` : `${release}-redis-master`;
        assert.match(recoverLog, new RegExp(`kubectl rollout restart statefulset/${redisStatefulSet}`));
        assert.match(recoverLog, new RegExp(`kubectl rollout status statefulset/${redisStatefulSet}`));
        assert.doesNotMatch(recoverLog, /^pull /m);
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
    await seedManagedChartCache(fakeBin, release, "oci://mirror.example.test/charts/redis");
    const updated = await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "update", "--config", configPath], { cwd: repositoryRoot, env: { ...environment, BOOTSTRAP_FAKE_INSTALLED_REDIS_CHART: "oci://mirror.example.test/charts/redis" } });
    const updateBackup = updated.stdout.trim().split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(event => event?.message === "Pre-change state captured.")?.backup;
    const capturedPlan = JSON.parse(await readFile(resolve(updateBackup, "plan.json"), "utf8"));
    assert.equal(capturedPlan.managedRedis.chart, "oci://mirror.example.test/charts/redis");
    assert.match(capturedPlan.managedRedis.chartArchiveSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(await fileExists(resolve(updateBackup, capturedPlan.managedRedis.chartArchiveFile)), true);
    await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "recover", "--config", configPath], { cwd: repositoryRoot, env: environment });
    await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "rollback", "--config", configPath, "--backup", backup], { cwd: repositoryRoot, env: environment });
    const log = await readFile(operationLog, "utf8");
    assert.match(log, /--values cluster\/redis\/managed-values.yaml/);
    assert.match(log, new RegExp(`--values .*${release}[/\\\\]redis-values\\.json`));
    assert.match(log, new RegExp(`kubectl rollout restart deployment/${release}`));
    const redisRestart = log.indexOf(`kubectl rollout restart statefulset/${release}-redis-master`);
    const redisReady = log.indexOf(`kubectl rollout status statefulset/${release}-redis-master`);
    const gatewayRestart = log.lastIndexOf(`kubectl rollout restart deployment/${release}`);
    assert(redisRestart >= 0 && redisReady > redisRestart && gatewayRestart > redisReady);
    assert.match(log, new RegExp(`uninstall ${release}-redis .*--ignore-not-found`));
    assert.match(log, new RegExp(`uninstall ${release} .*--ignore-not-found`));
    assert.doesNotMatch(log, /get namespace metallb-system/);
    assert.match(log, /list --namespace dev-realtime --filter .* --max 2 --output json/);
    assert.match(log, /--history-max 0/);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(targetBackups, { recursive: true, force: true });
  }
});

test("update adopts only a verified legacy managed Redis release", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-legacy-redis-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-legacy-redis-config-"));
  const config = configuration();
  config.naming.suffix = "legacy-adopt";
  config.redis.managedChart = "oci://mirror.example.test/charts/redis";
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, stableJson(config));
  const release = "dev-realtime-legacy-adopt";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  const targetBackups = resolve(repositoryRoot, `.backups/bootstrap/${release}`);
  const environment = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_LEGACY_REDIS: "1", BOOTSTRAP_FAKE_REDIS_SECRET: config.redis.credentialsSecret, BOOTSTRAP_FAKE_REDIS_PREFIX: `${config.redis.instancePrefix}:${config.naming.suffix}` };
  try {
    await seedManagedChartCache(fakeBin, release, config.redis.legacyManagedChart, "23.1.1", true);
    const updated = await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "update", "--config", configPath], { cwd: repositoryRoot, env: environment });
    const backup = updated.stdout.trim().split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(event => event?.message === "Pre-change state captured.")?.backup;
    assert(backup);
    assert.equal(JSON.parse(await readFile(resolve(backup, "plan.json"), "utf8")).managedRedis.chart, config.redis.legacyManagedChart);
    assert.match(updated.stdout, /Adopting verified legacy managed Redis release metadata/);
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "update", "--config", configPath], { cwd: repositoryRoot, env: { ...environment, BOOTSTRAP_FAKE_REDIS_PREFIX: "wrong:prefix" } }), error => error.code === 1 && /does not match the verified legacy deployment contract/.test(error.stdout));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(targetBackups, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("standalone backup captures installed managed Redis while desired configuration is external", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-drift-backup-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-drift-backup-config-"));
  const config = configuration();
  config.naming.suffix = "drift-backup";
  config.redis.mode = "external";
  config.redis.externalEndpoint = "redis.example.test:6379";
  config.redis.externalEgressCidrs = ["192.0.2.50/32"];
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, stableJson(config));
  const release = "dev-realtime-drift-backup";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  const targetBackups = resolve(repositoryRoot, `.backups/bootstrap/${release}`);
  try {
    await seedManagedChartCache(fakeBin, release);
    const result = await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "backup", "--config", configPath], { cwd: repositoryRoot, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis` } });
    const backup = result.stdout.trim().split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(event => event?.message === "Pre-change state captured.")?.backup;
    const captured = JSON.parse(await readFile(resolve(backup, "plan.json"), "utf8"));
    assert.equal(captured.managedRedis.chart, "oci://registry-1.docker.io/bitnamicharts/redis");
    assert.equal(captured.managedRedis.chartVersion, "23.1.1");
    assert.match(captured.managedRedis.chartArchiveSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(await fileExists(resolve(backup, captured.managedRedis.chartArchiveFile)), true);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(targetBackups, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup refuses to mint managed Redis chart provenance from a registry download", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") return t.skip("hermetic cluster tools run on the Ubuntu CI image");
  const fakeBin = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-provenance-tools-"));
  await fakeClusterTools(fakeBin);
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-provenance-config-"));
  const config = configuration();
  config.naming.suffix = "missing-provenance";
  const configPath = resolve(directory, "config.json");
  const operationLog = resolve(directory, "operations.log");
  await writeFile(configPath, stableJson(config));
  const release = "dev-realtime-missing-provenance";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  const targetBackups = resolve(repositoryRoot, `.backups/bootstrap/${release}`);
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "backup", "--config", configPath], {
      cwd: repositoryRoot,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_LOG: operationLog },
    }), error => error.code === 1 && /chart provenance is unavailable/.test(error.stdout));
    const operations = await readFile(operationLog, "utf8");
    assert.doesNotMatch(operations, /^pull /m);
    const entries = await fileExists(targetBackups) ? await (await import("node:fs/promises")).readdir(targetBackups) : [];
    assert.equal(entries.length, 0);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(targetBackups, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
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

test("rollback rejects a cross-target backup with the safety-stop exit code", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cormier-bootstrap-cross-target-config-"));
  const config = configuration();
  config.naming.suffix = "cross-target";
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, stableJson(config));
  const release = "dev-realtime-cross-target";
  const targetRoot = resolve(repositoryRoot, `.bootstrap/lifecycle/${release}`);
  const backup = resolve(repositoryRoot, `.backups/bootstrap/${release}/mismatch`);
  await mkdir(backup, { recursive: true });
  await writeFile(resolve(backup, "plan.json"), stableJson({ target: { context: "another-context", namespace: "dev-realtime", release } }));
  try {
    await assert.rejects(execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "rollback", "--config", configPath, "--backup", backup], { cwd: repositoryRoot }), error => error.code === 3 && /Backup target does not match/.test(error.stdout));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(resolve(repositoryRoot, `.backups/bootstrap/${release}`), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
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
  const chartArchiveFile = "redis-22.3.4.tgz";
  await writeFile(resolve(backup, chartArchiveFile), await readFile(resolve(fakeBin, "redis-fixture.tgz")));
  await writeFile(resolve(backup, "plan.json"), stableJson({ target: { context: "kind-example", namespace: "dev-realtime", release }, managedRedis: { chart: "oci://mirror.example.test/charts/redis", chartArchiveFile, chartArchiveSha256: managedChartFixtureSha256 } }));
  await writeFile(resolve(backup, "releases.json"), stableJson([{ name: release, chart: "realtime-gateway-0.1.0", revision: "3" }, { name: `${release}-redis`, chart: "redis-22.3.4", revision: "4" }]));
  const capturedGatewayValues = { replicaCount: 1, redis: { mode: "managed", credentialsSecret: { name: "captured.redis-auth", passwordKey: "realtime" }, managedAdminPasswordKey: "redis-password" } };
  await writeFile(resolve(backup, `${release}.values.json`), stableJson(capturedGatewayValues));
  await writeFile(resolve(backup, `${release}-redis.values.json`), stableJson({ architecture: "standalone" }));
  const environment = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, BOOTSTRAP_FAKE_RELEASE: release, BOOTSTRAP_FAKE_REDIS_RELEASE: `${release}-redis`, BOOTSTRAP_FAKE_LOG: operationLog };
  try {
    await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "rollback", "--config", configPath, "--backup", backup], { cwd: repositoryRoot, env: environment });
    const operations = await readFile(operationLog, "utf8");
    assert.match(operations, new RegExp(`upgrade --install ${release}-redis .*redis-22\\.3\\.4-[a-f0-9]{12}[/\\\\]redis`));
    assert.doesNotMatch(operations, new RegExp(`upgrade --install ${release}-redis .*--version`));
    assert.doesNotMatch(operations, /^pull /m);
    assert.match(operations, new RegExp(`rollback ${release} 3 .*--kube-context kind-example`));
    assert.match(operations, /kubectl .*--context kind-example/);
    assert.match(operations, /get secret captured\.redis-auth/);
    assert.doesNotMatch(operations, /^lint /m);
    const rollbackPlan = JSON.parse(await readFile(resolve(targetRoot, "plan.json"), "utf8"));
    const rollbackState = JSON.parse(await readFile(resolve(targetRoot, "state.json"), "utf8"));
    assert.deepEqual(rollbackPlan.values, capturedGatewayValues);
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
  await seedManagedChartCache(fakeBin, release);
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
  await seedManagedChartCache(fakeBin, release);
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

test("configured and overridden name suffixes isolate Redis and update the shared naming manifest", async () => {
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
    const configured = configuration();
    configured.naming.suffix = "configured-name";
    await writeFile(configPath, stableJson(configured));
    const configuredResult = await execute(process.execPath, [resolve(repositoryRoot, "scripts/realtime-bootstrap.mjs"), "plan", "--config", configPath], { cwd: repositoryRoot });
    assert.equal(normalizedPlan(configuredResult.stdout).values.redis.instancePrefix, "cormier:realtime:dev:configured-name");
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
