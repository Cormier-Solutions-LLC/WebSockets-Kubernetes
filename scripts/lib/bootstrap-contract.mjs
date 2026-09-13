import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const contractVersion = 1;
export const actions = Object.freeze([
  "prerequisites", "plan", "bootstrap", "backup", "install", "update", "validate", "rollback", "recover", "teardown",
]);

const dnsLabel = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const registryRepository = /^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/;
const secretKey = /^[A-Za-z0-9._-]+$/;
const redisPrefix = /^[A-Za-z0-9:_-]+$/;
const resourceQuantity = /^[1-9][0-9]*(?:m|Mi|Gi|Ti)$/;
const secretValueKey = /(?:password|token|secret|credential|privatekey|authorization|cookie)$/i;

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

function requireKeys(value, path, expected, errors) {
  for (const key of expected) {
    if (!(key in value)) errors.push(problem(`${path}.${key}`, "is required"));
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) errors.push(problem(`${path}.${key}`, "is not a supported field"));
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
  requireString(paths.generatedDirectory, "$.paths.generatedDirectory", errors, /^\.bootstrap(?:\/[A-Za-z0-9._-]+)*$/);
  requireString(paths.backupDirectory, "$.paths.backupDirectory", errors, /^\.backups(?:\/[A-Za-z0-9._-]+)*$/);
  requireString(paths.logDirectory, "$.paths.logDirectory", errors, /^\.logs(?:\/[A-Za-z0-9._-]+)*$/);

  const image = requireRecord(config.image, "$.image", errors);
  requireKeys(image, "$.image", ["repository", "tag", "pullPolicy"], errors);
  requireString(image.repository, "$.image.repository", errors, registryRepository);
  requireString(image.tag, "$.image.tag", errors);
  if (!["Always", "IfNotPresent", "Never"].includes(image.pullPolicy)) errors.push(problem("$.image.pullPolicy", "must be Always, IfNotPresent, or Never"));

  const kubernetes = requireRecord(config.kubernetes, "$.kubernetes", errors);
  requireKeys(kubernetes, "$.kubernetes", ["context", "namespace", "storageClass", "failureDomains"], errors);
  requireString(kubernetes.context, "$.kubernetes.context", errors);
  requireString(kubernetes.namespace, "$.kubernetes.namespace", errors, dnsLabel);
  requireString(kubernetes.storageClass, "$.kubernetes.storageClass", errors);
  if (!Number.isInteger(kubernetes.failureDomains) || kubernetes.failureDomains < 1) errors.push(problem("$.kubernetes.failureDomains", "must be an integer greater than zero"));

  const redis = requireRecord(config.redis, "$.redis", errors);
  requireKeys(redis, "$.redis", ["mode", "externalEndpoint", "externalHaConfirmed", "credentialsSecret", "passwordKey", "adminPasswordKey", "username", "instancePrefix"], errors);
  if (!["external", "managed"].includes(redis.mode)) errors.push(problem("$.redis.mode", "must be external or managed"));
  requireString(redis.externalEndpoint, "$.redis.externalEndpoint", errors, undefined, redis.mode !== "external");
  if (typeof redis.externalHaConfirmed !== "boolean") errors.push(problem("$.redis.externalHaConfirmed", "must be boolean"));
  if (redis.mode === "external" && !/^[A-Za-z0-9.-]+:[1-9][0-9]{0,4}$/.test(redis.externalEndpoint)) errors.push(problem("$.redis.externalEndpoint", "must be a host and port supplied by configuration"));
  requireString(redis.credentialsSecret, "$.redis.credentialsSecret", errors, dnsLabel);
  requireString(redis.passwordKey, "$.redis.passwordKey", errors, secretKey);
  requireString(redis.adminPasswordKey, "$.redis.adminPasswordKey", errors, secretKey);
  requireString(redis.username, "$.redis.username", errors, /^[A-Za-z0-9_-]+$/);
  requireString(redis.instancePrefix, "$.redis.instancePrefix", errors, redisPrefix);
  if (redis.mode === "managed" && redis.passwordKey !== redis.username) errors.push(problem("$.redis.passwordKey", "must match redis.username for the managed Redis ACL mapping"));

  const ingress = requireRecord(config.ingress, "$.ingress", errors);
  requireKeys(ingress, "$.ingress", ["enabled", "host", "entryPoint", "tlsSecretName"], errors);
  if (typeof ingress.enabled !== "boolean") errors.push(problem("$.ingress.enabled", "must be boolean"));
  requireString(ingress.host, "$.ingress.host", errors, /^(?:[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/, !ingress.enabled);
  requireString(ingress.entryPoint, "$.ingress.entryPoint", errors, /^[A-Za-z0-9._-]+$/);
  requireString(ingress.tlsSecretName, "$.ingress.tlsSecretName", errors, dnsLabel, !ingress.enabled);

  const observability = requireRecord(config.observability, "$.observability", errors);
  requireKeys(observability, "$.observability", ["serviceMonitor", "otlpEndpoint"], errors);
  if (typeof observability.serviceMonitor !== "boolean") errors.push(problem("$.observability.serviceMonitor", "must be boolean"));
  requireString(observability.otlpEndpoint, "$.observability.otlpEndpoint", errors, /^https?:\/\//, true);

  const resources = requireRecord(config.resources, "$.resources", errors);
  requireKeys(resources, "$.resources", ["gatewayCpu", "gatewayMemory", "redisStorage"], errors);
  requireString(resources.gatewayCpu, "$.resources.gatewayCpu", errors, /^[1-9][0-9]*m$/);
  requireString(resources.gatewayMemory, "$.resources.gatewayMemory", errors, resourceQuantity);
  requireString(resources.redisStorage, "$.resources.redisStorage", errors, resourceQuantity);

  if (!["ha", "non-ha"].includes(config.topology)) errors.push(problem("$.topology", "must explicitly be ha or non-ha"));
  if (config.topology === "ha" && kubernetes.failureDomains < 3) errors.push(problem("$.kubernetes.failureDomains", "HA requires at least three failure domains"));
  if (config.topology === "ha" && redis.mode === "external" && !redis.externalEndpoint) errors.push(problem("$.redis.externalEndpoint", "HA external Redis requires a configured managed-service endpoint"));
  if (config.topology === "ha" && redis.mode === "external" && redis.externalHaConfirmed !== true) errors.push(problem("$.redis.externalHaConfirmed", "must confirm that the external service supplies persistence, quorum, failover, and recovery"));

  const networking = requireRecord(config.networking, "$.networking", errors);
  requireKeys(networking, "$.networking", ["traefikNamespace", "traefikService", "metalLbNamespace", "metalLbAddress", "advertisementMode"], errors);
  requireString(networking.traefikNamespace, "$.networking.traefikNamespace", errors, dnsLabel);
  requireString(networking.traefikService, "$.networking.traefikService", errors, dnsLabel);
  requireString(networking.metalLbNamespace, "$.networking.metalLbNamespace", errors, dnsLabel);
  requireString(networking.metalLbAddress, "$.networking.metalLbAddress", errors, /^[A-Fa-f0-9:.]+$/);
  if (!["l2", "bgp"].includes(networking.advertisementMode)) errors.push(problem("$.networking.advertisementMode", "must be l2 or bgp"));

  function rejectInlineSecrets(value, path = "$") {
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (secretValueKey.test(key) && !/(?:Secret|Key)$/.test(key)) errors.push(problem(childPath, "inline secret values are forbidden; configure a Secret name and key"));
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

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, secretValueKey.test(key) && !/(?:Secret|Key)$/.test(key) ? "[REDACTED]" : redact(child)]));
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

function releaseNames(config) {
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
    gateway: { shutdownDrainSeconds: 25 },
    image: config.image,
    ingressRoute: { enabled: config.ingress.enabled, entryPoint: config.ingress.entryPoint, host: config.ingress.host, path: "/realtime/ws", tlsSecretName: config.ingress.tlsSecretName },
    observability: {
      environment: config.environment.name,
      platformMetrics: {
        metalLbAdvertisementMode: config.networking.advertisementMode,
        metalLbNamespace: config.networking.metalLbNamespace,
        metalLbAddress: config.networking.metalLbAddress,
        traefikNamespace: config.networking.traefikNamespace,
      },
      serviceMonitor: { enabled: config.observability.serviceMonitor },
      otlp: { enabled: Boolean(config.observability.otlpEndpoint), endpoint: config.observability.otlpEndpoint },
    },
    podDisruptionBudget: profile.gateway.podDisruptionBudget,
    replicaCount: profile.gateway.replicas,
    resources: { requests: { cpu: config.resources.gatewayCpu, memory: config.resources.gatewayMemory }, limits: { cpu: config.resources.gatewayCpu, memory: config.resources.gatewayMemory } },
    redis: {
      mode: config.redis.mode,
      externalEndpoint: config.redis.externalEndpoint,
      managedReleaseName: names.redisRelease,
      credentialsSecret: { name: config.redis.credentialsSecret, passwordKey: config.redis.passwordKey },
      managedAdminPasswordKey: config.redis.adminPasswordKey,
      username: config.redis.username,
      instancePrefix: config.redis.instancePrefix,
    },
    topologySpreadConstraints: { enabled: profile.gateway.topologySpread },
    topology: config.topology,
  });
}

export function buildPlan(action, config, profile, options = {}) {
  if (!actions.includes(action)) throw new Error(`Unsupported action '${action}'.`);
  const names = releaseNames(config);
  const values = renderValues(config, profile);
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
    values,
    valuesSha256: createHash("sha256").update(stableJson(values)).digest("hex"),
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
