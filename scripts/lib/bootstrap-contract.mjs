import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const contractVersion = 1;
export const actions = Object.freeze([
  "prerequisites", "plan", "bootstrap", "backup", "install", "update", "validate", "rollback", "recover", "teardown",
]);

const dnsLabel = /^(?=.{1,63}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const dnsSubdomain = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
const labelName = /^(?=.{1,63}$)[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const registryRepository = /^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/;
const imageTag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const secretKey = /^[A-Za-z0-9._-]+$/;
const redisPrefix = /^[A-Za-z0-9:_-]+$/;
const memoryQuantity = /^[1-9][0-9]*(?:Mi|Gi)$/;
const storageQuantity = /^[1-9][0-9]*(?:Mi|Gi|Ti)$/;
const secretValueKey = /(?:password|token|secret|credential|private.?key|api.?key|authorization|cookie)s?$/i;

function isSecretReferenceField(key, parentPath = "") {
  return /Secret$/i.test(key) || /(?:password|token|credential|secret)Key$/i.test(key) || (key === "key" && /secret/i.test(parentPath.split(".").at(-1) ?? ""));
}

function isCidr(value) {
  if (typeof value !== "string") return false;
  const separator = value.lastIndexOf("/");
  if (separator < 1) return false;
  const address = value.slice(0, separator);
  const prefix = Number(value.slice(separator + 1));
  const family = isIP(address);
  return Number.isInteger(prefix) && ((family === 4 && prefix >= 0 && prefix <= 32) || (family === 6 && prefix >= 0 && prefix <= 128));
}

function isLabelKey(value) {
  if (typeof value !== "string" || !value) return false;
  const slash = value.indexOf("/");
  if (slash < 0) return labelName.test(value);
  return value.indexOf("/", slash + 1) < 0 && dnsSubdomain.test(value.slice(0, slash)) && labelName.test(value.slice(slash + 1));
}

function isLabelValue(value) {
  return typeof value === "string" && labelName.test(value);
}

function validateLabels(labels, path, errors) {
  for (const [key, value] of Object.entries(labels)) {
    if (!isLabelKey(key)) errors.push(problem(`${path}.${key}`, "must use Kubernetes label-key syntax"));
    if (!isLabelValue(value)) errors.push(problem(`${path}.${key}`, "must be a non-empty Kubernetes label value"));
  }
}

function problem(path, message) {
  return { path, message };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, path, errors) {
  if (!isRecord(value)) {
    errors.push(problem(path, "must be an object"));
    return {};
  }
  return value;
}

function requireKeys(value, path, required, errors, optional = []) {
  for (const key of required) {
    if (!(key in value)) errors.push(problem(`${path}.${key}`, "is required"));
  }
  const supported = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) errors.push(problem(`${path}.${key}`, "is not a supported field"));
  }
}

function requireString(value, path, errors, pattern, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    errors.push(problem(path, allowEmpty ? "must be a string" : "must be a non-empty string"));
  } else if (pattern && value.length > 0 && !pattern.test(value)) {
    errors.push(problem(path, "has an invalid format"));
  }
}

export function validateConfiguration(input) {
  const errors = [];
  const config = requireRecord(input, "$", errors);
  const topKeys = ["schemaVersion", "environment", "naming", "paths", "image", "kubernetes", "networking", "redis", "ingress", "observability", "resources", "topology"];
  requireKeys(config, "$", topKeys, errors);
  if (config.schemaVersion !== contractVersion) errors.push(problem("$.schemaVersion", `must equal ${contractVersion}`));

  const environment = requireRecord(config.environment, "$.environment", errors);
  requireKeys(environment, "$.environment", ["name", "class"], errors);
  requireString(environment.name, "$.environment.name", errors, /^[a-z0-9]{1,10}$/);
  if (!["development", "test", "staging", "production"].includes(environment.class)) errors.push(problem("$.environment.class", "must be development, test, staging, or production"));

  const naming = requireRecord(config.naming, "$.naming", errors);
  requireKeys(naming, "$.naming", ["suffix"], errors);
  requireString(naming.suffix, "$.naming.suffix", errors, /^(?:|(?=.{1,27}$)[a-z0-9]+(?:-[a-z0-9]+)*)$/, true);

  const paths = requireRecord(config.paths, "$.paths", errors);
  requireKeys(paths, "$.paths", ["generatedDirectory", "backupDirectory", "logDirectory"], errors);
  requireString(paths.generatedDirectory, "$.paths.generatedDirectory", errors, /^\.bootstrap(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)*$/);
  requireString(paths.backupDirectory, "$.paths.backupDirectory", errors, /^\.backups(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)*$/);
  requireString(paths.logDirectory, "$.paths.logDirectory", errors, /^\.logs(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)*$/);

  const image = requireRecord(config.image, "$.image", errors);
  requireKeys(image, "$.image", ["repository", "tag", "pullPolicy"], errors, ["digest"]);
  requireString(image.repository, "$.image.repository", errors, registryRepository);
  requireString(image.tag, "$.image.tag", errors, imageTag);
  if (image.digest !== undefined) requireString(image.digest, "$.image.digest", errors, /^sha256:[a-f0-9]{64}$/, true);
  if (!["Always", "IfNotPresent", "Never"].includes(image.pullPolicy)) errors.push(problem("$.image.pullPolicy", "must be Always, IfNotPresent, or Never"));

  const kubernetes = requireRecord(config.kubernetes, "$.kubernetes", errors);
  requireKeys(kubernetes, "$.kubernetes", ["context", "namespace", "storageClass", "failureDomains"], errors);
  requireString(kubernetes.context, "$.kubernetes.context", errors);
  requireString(kubernetes.namespace, "$.kubernetes.namespace", errors, dnsLabel);
  requireString(kubernetes.storageClass, "$.kubernetes.storageClass", errors);
  if (!Number.isInteger(kubernetes.failureDomains) || kubernetes.failureDomains < 1) errors.push(problem("$.kubernetes.failureDomains", "must be an integer greater than zero"));

  const redis = requireRecord(config.redis, "$.redis", errors);
  requireKeys(redis, "$.redis", ["mode", "externalEndpoint", "externalHaConfirmed", "externalEgressCidrs", "tls", "credentialsSecret", "credentialKey", "adminCredentialKey", "username", "instancePrefix"], errors);
  if (!["external", "managed"].includes(redis.mode)) errors.push(problem("$.redis.mode", "must be external or managed"));
  requireString(redis.externalEndpoint, "$.redis.externalEndpoint", errors, undefined, redis.mode !== "external");
  if (typeof redis.externalHaConfirmed !== "boolean") errors.push(problem("$.redis.externalHaConfirmed", "must be boolean"));
  if (typeof redis.tls !== "boolean") errors.push(problem("$.redis.tls", "must be boolean"));
  if (redis.mode === "managed" && redis.tls === true) errors.push(problem("$.redis.tls", "managed Redis TLS requires certificate configuration and is not supported by this contract; use false or an external TLS endpoint"));
  if (redis.mode === "external" && !/^[A-Za-z0-9.-]+:[1-9][0-9]{0,4}$/.test(redis.externalEndpoint)) errors.push(problem("$.redis.externalEndpoint", "must be a host and port supplied by configuration"));
  if (redis.mode === "external") {
    const port = Number(redis.externalEndpoint.split(":").at(-1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(problem("$.redis.externalEndpoint", "must use a TCP port from 1 through 65535"));
  }
  const externalEgressCidrs = Array.isArray(redis.externalEgressCidrs) ? redis.externalEgressCidrs : [];
  if (!Array.isArray(redis.externalEgressCidrs) || externalEgressCidrs.some(cidr => !isCidr(cidr))) errors.push(problem("$.redis.externalEgressCidrs", "must contain valid IPv4 or IPv6 CIDRs"));
  if (redis.mode === "external" && externalEgressCidrs.length === 0) errors.push(problem("$.redis.externalEgressCidrs", "external Redis requires at least one explicit egress CIDR"));
  requireString(redis.credentialsSecret, "$.redis.credentialsSecret", errors, dnsLabel);
  requireString(redis.credentialKey, "$.redis.credentialKey", errors, secretKey);
  requireString(redis.adminCredentialKey, "$.redis.adminCredentialKey", errors, secretKey);
  requireString(redis.username, "$.redis.username", errors, /^[A-Za-z0-9_-]+$/);
  requireString(redis.instancePrefix, "$.redis.instancePrefix", errors, redisPrefix);
  if (redis.mode === "managed" && redis.credentialKey !== redis.username) errors.push(problem("$.redis.credentialKey", "must match redis.username for the managed Redis ACL mapping"));

  const ingress = requireRecord(config.ingress, "$.ingress", errors);
  requireKeys(ingress, "$.ingress", ["enabled", "host", "allowedOrigins", "entryPoint", "tlsSecretName"], errors);
  if (typeof ingress.enabled !== "boolean") errors.push(problem("$.ingress.enabled", "must be boolean"));
  requireString(ingress.host, "$.ingress.host", errors, /^(?:[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/, !ingress.enabled);
  if (!Array.isArray(ingress.allowedOrigins) || ingress.allowedOrigins.length === 0) errors.push(problem("$.ingress.allowedOrigins", "must contain at least one configured HTTP(S) origin"));
  else ingress.allowedOrigins.forEach((origin, index) => {
    const path = `$.ingress.allowedOrigins[${index}]`;
    requireString(origin, path, errors, /^https?:\/\/[^@/?#]+\/?$/);
    if (typeof origin === "string") {
      try {
        const parsed = new URL(origin);
        if (parsed.username || parsed.password) errors.push(problem(path, "must not contain URL userinfo"));
      } catch { errors.push(problem(path, "must be a valid HTTP(S) origin")); }
    }
  });
  requireString(ingress.entryPoint, "$.ingress.entryPoint", errors, /^[A-Za-z0-9._-]+$/);
  requireString(ingress.tlsSecretName, "$.ingress.tlsSecretName", errors, dnsLabel, !ingress.enabled);

  const observability = requireRecord(config.observability, "$.observability", errors);
  requireKeys(observability, "$.observability", ["cluster", "serviceMonitor", "monitoringNamespaceLabels", "monitoringPodLabels", "otlpEndpoint", "otlpHeadersSecret", "otlpHeadersKey", "otlpEgressCidrs", "otlpEgressNamespaceLabels", "otlpEgressPodLabels", "otlpEgressPorts"], errors);
  requireString(observability.cluster, "$.observability.cluster", errors, /^(?=.{1,63}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  if (typeof observability.serviceMonitor !== "boolean") errors.push(problem("$.observability.serviceMonitor", "must be boolean"));
  requireString(observability.otlpEndpoint, "$.observability.otlpEndpoint", errors, /^https?:\/\//, true);
  if (typeof observability.otlpEndpoint === "string" && observability.otlpEndpoint) {
    try {
      const endpoint = new URL(observability.otlpEndpoint);
      if (endpoint.username || endpoint.password) errors.push(problem("$.observability.otlpEndpoint", "must not contain URL userinfo; configure authentication through the headers Secret"));
      if (endpoint.search || endpoint.hash) errors.push(problem("$.observability.otlpEndpoint", "must not contain a query string or fragment; configure authentication through the headers Secret"));
    } catch { errors.push(problem("$.observability.otlpEndpoint", "must be a valid HTTP(S) URL")); }
  }
  requireString(observability.otlpHeadersSecret, "$.observability.otlpHeadersSecret", errors, dnsLabel, true);
  requireString(observability.otlpHeadersKey, "$.observability.otlpHeadersKey", errors, secretKey);
  if (observability.otlpHeadersSecret && !observability.otlpEndpoint) errors.push(problem("$.observability.otlpHeadersSecret", "requires an enabled OTLP endpoint"));
  const monitoringNamespaceLabels = requireRecord(observability.monitoringNamespaceLabels, "$.observability.monitoringNamespaceLabels", errors);
  const monitoringPodLabels = requireRecord(observability.monitoringPodLabels, "$.observability.monitoringPodLabels", errors);
  if (observability.serviceMonitor && (Object.keys(monitoringNamespaceLabels).length === 0 || Object.keys(monitoringPodLabels).length === 0)) errors.push(problem("$.observability", "ServiceMonitor requires explicit monitoring namespace and pod selectors"));
  for (const [path, labels] of [["$.observability.monitoringNamespaceLabels", monitoringNamespaceLabels], ["$.observability.monitoringPodLabels", monitoringPodLabels]]) validateLabels(labels, path, errors);
  const otlpEgressCidrs = Array.isArray(observability.otlpEgressCidrs) ? observability.otlpEgressCidrs : [];
  if (!Array.isArray(observability.otlpEgressCidrs) || otlpEgressCidrs.some(cidr => !isCidr(cidr))) errors.push(problem("$.observability.otlpEgressCidrs", "must contain valid IPv4 or IPv6 CIDRs"));
  const otlpNamespaceLabels = requireRecord(observability.otlpEgressNamespaceLabels, "$.observability.otlpEgressNamespaceLabels", errors);
  const otlpPodLabels = requireRecord(observability.otlpEgressPodLabels, "$.observability.otlpEgressPodLabels", errors);
  if (!Array.isArray(observability.otlpEgressPorts) || observability.otlpEgressPorts.length === 0 || observability.otlpEgressPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) errors.push(problem("$.observability.otlpEgressPorts", "must contain valid TCP ports"));
  if (observability.otlpEndpoint && otlpEgressCidrs.length === 0 && Object.keys(otlpNamespaceLabels).length === 0) errors.push(problem("$.observability", "an enabled OTLP endpoint requires an egress CIDR or namespace selector"));
  validateLabels(otlpNamespaceLabels, "$.observability.otlpEgressNamespaceLabels", errors);
  validateLabels(otlpPodLabels, "$.observability.otlpEgressPodLabels", errors);

  const resources = requireRecord(config.resources, "$.resources", errors);
  requireKeys(resources, "$.resources", ["gatewayCpu", "gatewayMemory", "redisStorage"], errors);
  requireString(resources.gatewayCpu, "$.resources.gatewayCpu", errors, /^[1-9][0-9]*m$/);
  requireString(resources.gatewayMemory, "$.resources.gatewayMemory", errors, memoryQuantity);
  requireString(resources.redisStorage, "$.resources.redisStorage", errors, storageQuantity);

  if (!["ha", "non-ha"].includes(config.topology)) errors.push(problem("$.topology", "must explicitly be ha or non-ha"));
  if (config.topology === "ha" && kubernetes.failureDomains < 3) errors.push(problem("$.kubernetes.failureDomains", "HA requires at least three failure domains"));
  if (config.topology === "ha" && redis.mode === "external" && !redis.externalEndpoint) errors.push(problem("$.redis.externalEndpoint", "HA external Redis requires a configured managed-service endpoint"));
  if (config.topology === "ha" && redis.mode === "external" && redis.externalHaConfirmed !== true) errors.push(problem("$.redis.externalHaConfirmed", "must confirm that the external service supplies persistence, quorum, failover, and recovery"));

  const networking = requireRecord(config.networking, "$.networking", errors);
  requireKeys(networking, "$.networking", ["traefikNamespace", "traefikService", "traefikPodLabels", "trustedProxyCidrs", "metalLbNamespace", "metalLbAddress", "advertisementMode"], errors);
  requireString(networking.traefikNamespace, "$.networking.traefikNamespace", errors, dnsLabel);
  requireString(networking.traefikService, "$.networking.traefikService", errors, dnsLabel);
  const traefikPodLabels = requireRecord(networking.traefikPodLabels, "$.networking.traefikPodLabels", errors);
  if (Object.keys(traefikPodLabels).length === 0) errors.push(problem("$.networking.traefikPodLabels", "must contain at least one label"));
  validateLabels(traefikPodLabels, "$.networking.traefikPodLabels", errors);
  const trustedProxyCidrs = Array.isArray(networking.trustedProxyCidrs) ? networking.trustedProxyCidrs : [];
  if (!Array.isArray(networking.trustedProxyCidrs) || trustedProxyCidrs.length === 0 || trustedProxyCidrs.some(cidr => !isCidr(cidr))) errors.push(problem("$.networking.trustedProxyCidrs", "must contain at least one valid IPv4 or IPv6 CIDR"));
  requireString(networking.metalLbNamespace, "$.networking.metalLbNamespace", errors, dnsLabel);
  requireString(networking.metalLbAddress, "$.networking.metalLbAddress", errors);
  if (typeof networking.metalLbAddress === "string" && isIP(networking.metalLbAddress) === 0) errors.push(problem("$.networking.metalLbAddress", "must be a valid IPv4 or IPv6 address"));
  if (!["l2", "bgp"].includes(networking.advertisementMode)) errors.push(problem("$.networking.advertisementMode", "must be l2 or bgp"));

  function rejectInlineSecrets(value, path = "$") {
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (secretValueKey.test(key) && !isSecretReferenceField(key, path)) errors.push(problem(childPath, "inline secret values are forbidden; configure a Secret name and key"));
      if (isRecord(child)) rejectInlineSecrets(child, childPath);
    }
  }
  rejectInlineSecrets(config);
  return errors;
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function stableJson(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function deploymentValuesSha256(gateway, managedRedis) {
  return createHash("sha256").update(stableJson({ gateway, managedRedis })).digest("hex");
}

export function useCapturedDeploymentValues(plan, gatewayValues, managedRedisValues, managedRedisChartVersion) {
  const captured = structuredClone(plan);
  captured.values = stable(gatewayValues);
  captured.managedRedis = managedRedisValues === undefined ? null : stable({
    chart: "oci://registry-1.docker.io/bitnamicharts/redis",
    chartVersion: managedRedisChartVersion,
    values: managedRedisValues,
  });
  captured.valuesSha256 = deploymentValuesSha256(captured.values, captured.managedRedis);
  return stable(captured);
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, secretValueKey.test(key) && !isSecretReferenceField(key) ? "[REDACTED]" : redact(child)]));
}

export function inlineSecretPaths(value, path = "$") {
  if (!isRecord(value)) return [];
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const credentialField = secretValueKey.test(key) && !isSecretReferenceField(key, path);
    if (credentialField && typeof child === "string" && child.length > 0) paths.push(childPath);
    if (credentialField && Array.isArray(child)) child.forEach((item, index) => { if (typeof item === "string" && item.length > 0) paths.push(`${childPath}[${index}]`); });
    if (isRecord(child)) paths.push(...inlineSecretPaths(child, childPath));
    if (Array.isArray(child)) child.forEach((item, index) => { if (isRecord(item)) paths.push(...inlineSecretPaths(item, `${childPath}[${index}]`)); });
  }
  return paths;
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON from ${path}: ${error.message}`);
  }
}

export async function loadContract(repositoryRoot, configPath, requestedProfile) {
  const absoluteConfig = isAbsolute(configPath) ? configPath : resolve(repositoryRoot, configPath);
  const config = await readJson(absoluteConfig);
  const errors = validateConfiguration(config);
  if (errors.length) throw new Error(`Configuration is invalid:\n${errors.map(item => `- ${item.path}: ${item.message}`).join("\n")}`);
  if (requestedProfile && requestedProfile !== config.topology) throw new Error(`Requested profile '${requestedProfile}' does not match configuration topology '${config.topology}'.`);
  const profile = await readJson(resolve(repositoryRoot, "bootstrap", "profiles", `${config.topology}.json`));
  return { config, profile, configPath: absoluteConfig };
}

export function releaseNames(config) {
  const application = config.naming.suffix ? `realtime-${config.naming.suffix}` : "realtime";
  const release = `${config.environment.name}-${application}`;
  const redisRelease = `${release}-redis`;
  if (release.length > 53 || redisRelease.length > 53) throw new Error("Derived Helm release name exceeds 53 characters; shorten the environment or naming suffix.");
  return { application, release, redisRelease };
}

export function renderValues(config, profile) {
  const names = releaseNames(config);
  return stable({
    autoscaling: profile.gateway.autoscaling,
    deploymentStrategy: { maxSurge: profile.gateway.maxSurge, maxUnavailable: profile.gateway.maxUnavailable },
    fullnameOverride: names.release,
    gateway: { allowedOrigins: config.ingress.allowedOrigins, trustedNetworks: config.networking.trustedProxyCidrs, shutdownDrainSeconds: 25 },
    image: config.image,
    ingressRoute: { enabled: config.ingress.enabled, entryPoint: config.ingress.entryPoint, host: config.ingress.host, path: "/realtime/ws", tlsSecretName: config.ingress.tlsSecretName },
    observability: {
      cluster: config.observability.cluster,
      environment: config.environment.name,
      platformMetrics: {
        metalLbAdvertisementMode: config.networking.advertisementMode,
        metalLbNamespace: config.networking.metalLbNamespace,
        metalLbAddress: config.networking.metalLbAddress,
        traefikNamespace: config.networking.traefikNamespace,
      },
      serviceMonitor: { enabled: config.observability.serviceMonitor },
      prometheusRule: { ingressEnabled: config.ingress.enabled },
      otlp: {
        enabled: Boolean(config.observability.otlpEndpoint),
        endpoint: config.observability.otlpEndpoint,
        egressCidrs: config.observability.otlpEgressCidrs,
        egressNamespaceSelector: Object.keys(config.observability.otlpEgressNamespaceLabels).length > 0 ? { matchLabels: config.observability.otlpEgressNamespaceLabels } : {},
        egressPodSelector: Object.keys(config.observability.otlpEgressPodLabels).length > 0 ? { matchLabels: config.observability.otlpEgressPodLabels } : {},
        egressPorts: config.observability.otlpEgressPorts,
        headersSecret: { name: config.observability.otlpHeadersSecret, key: config.observability.otlpHeadersKey },
      },
    },
    podDisruptionBudget: profile.gateway.podDisruptionBudget,
    replicaCount: profile.gateway.replicas,
    resources: { requests: { cpu: config.resources.gatewayCpu, memory: config.resources.gatewayMemory }, limits: { cpu: config.resources.gatewayCpu, memory: config.resources.gatewayMemory } },
    redis: {
      mode: config.redis.mode,
      tls: config.redis.tls,
      externalEndpoint: config.redis.externalEndpoint,
      port: config.redis.mode === "external" ? Number(config.redis.externalEndpoint.split(":").at(-1)) : 6379,
      managedReleaseName: names.redisRelease,
      credentialsSecret: { name: config.redis.credentialsSecret, passwordKey: config.redis.credentialKey },
      managedAdminPasswordKey: config.redis.adminCredentialKey,
      username: config.redis.username,
      instancePrefix: config.redis.instancePrefix,
    },
    networkPolicy: {
      allowExternalRedisEgress: config.redis.mode === "external",
      externalRedisCidrs: config.redis.externalEgressCidrs,
      ingressNamespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": config.networking.traefikNamespace } },
      ingressPodSelector: { matchLabels: config.networking.traefikPodLabels },
      monitoringNamespaceSelector: { matchLabels: config.observability.monitoringNamespaceLabels },
      monitoringPodSelector: { matchLabels: config.observability.monitoringPodLabels },
    },
    topologySpreadConstraints: { enabled: profile.gateway.topologySpread, zoneWhenUnsatisfiable: profile.gateway.zoneWhenUnsatisfiable },
    topology: config.topology,
  });
}

function renderManagedRedis(config, profile) {
  if (config.redis.mode !== "managed") return null;
  const names = releaseNames(config);
  const topologySpreadConstraints = config.topology === "ha" ? [{
    labelSelector: { matchLabels: { "app.kubernetes.io/component": "node", "app.kubernetes.io/instance": names.redisRelease, "app.kubernetes.io/name": "redis" } },
    maxSkew: 1,
    topologyKey: "topology.kubernetes.io/zone",
    whenUnsatisfiable: "DoNotSchedule",
  }] : [];
  return stable({
    baseValuesPath: "cluster/redis/managed-values.yaml",
    chart: "oci://registry-1.docker.io/bitnamicharts/redis",
    chartVersion: "23.1.1",
    values: {
      architecture: profile.redis.managedArchitecture,
      auth: {
        sentinel: profile.redis.sentinel,
        existingSecret: config.redis.credentialsSecret,
        existingSecretPasswordKey: config.redis.adminCredentialKey,
        acl: {
          enabled: true,
          sentinel: false,
          userSecret: config.redis.credentialsSecret,
          users: [{
            username: config.redis.username,
            enabled: "on",
            commands: "+@read +@write +@connection +@pubsub +@scripting +@stream",
            keys: `~${config.redis.instancePrefix}:*`,
            channels: `&${config.redis.instancePrefix}:*`,
          }],
        },
      },
      global: { storageClass: config.kubernetes.storageClass },
      master: { pdb: { create: profile.redis.sentinel }, persistence: { enabled: true, size: config.resources.redisStorage } },
      replica: {
        replicaCount: profile.redis.replicas,
        pdb: { create: profile.redis.sentinel },
        persistence: { enabled: true, size: config.resources.redisStorage },
        topologySpreadConstraints,
      },
      sentinel: { enabled: profile.redis.sentinel },
    },
  });
}

export function buildPlan(action, config, profile, options = {}) {
  if (!actions.includes(action)) throw new Error(`Unsupported action '${action}'.`);
  const names = releaseNames(config);
  const values = renderValues(config, profile);
  const managedRedis = renderManagedRedis(config, profile);
  const deploymentValues = { gateway: values, managedRedis };
  const changeClass = options.previousTopology && options.previousTopology !== config.topology ? "topology-conversion" : action === "install" ? "installation" : action;
  const mutations = ["install", "update", "rollback", "recover", "teardown"].includes(action);
  return stable({
    contractVersion,
    action,
    changeClass,
    dryRun: Boolean(options.dryRun),
    target: {
      environment: config.environment.name,
      environmentClass: config.environment.class,
      context: config.kubernetes.context,
      namespace: config.kubernetes.namespace,
      application: names.application,
      release: names.release,
      redisRelease: names.redisRelease,
    },
    paths: config.paths,
    networking: config.networking,
    topology: {
      selected: config.topology,
      previous: options.previousTopology ?? null,
      conversion: changeClass === "topology-conversion",
      minimumFailureDomains: profile.minimumFailureDomains,
      configuredFailureDomains: config.kubernetes.failureDomains,
      gatewayReplicas: profile.gateway.replicas,
      redisMode: config.redis.mode,
      managedRedisReplicas: config.redis.mode === "managed" ? profile.redis.replicas : null,
      externalRedisHaConfirmed: config.redis.mode === "external" ? config.redis.externalHaConfirmed : null,
      guarantees: profile.guarantees,
    },
    safety: {
      mutation: mutations,
      requiresBackup: mutations,
      requiresTopologyConfirmation: changeClass === "topology-conversion",
      requiresForce: action === "teardown",
      boundedTimeoutSeconds: options.timeoutSeconds ?? 300,
      secretValuesAccepted: false,
    },
    managedRedis,
    values,
    valuesSha256: deploymentValuesSha256(deploymentValues.gateway, deploymentValues.managedRedis),
  });
}

export function assertPathInside(parent, child, description) {
  const delta = relative(resolve(parent), resolve(child));
  if (delta === "" || (!delta.startsWith("..") && !isAbsolute(delta))) return;
  throw new Error(`Refusing ${description} outside ${resolve(parent)}.`);
}

export async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function fileExists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
