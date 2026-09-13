#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  actions, assertPathInside, atomicWrite, buildPlan, fileExists, inlineSecretPaths, loadContract, readJson, releaseNames, stableJson, useCapturedDeploymentValues,
} from "./lib/bootstrap-contract.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const events = [];
let activeLogPath = resolve(repositoryRoot, ".logs", `Realtime-Bootstrap-${new Date().toISOString().replaceAll(":", "-")}.jsonl`);

function parse(arguments_) {
  const result = { action: arguments_[0], config: process.env.CORMIER_BOOTSTRAP_CONFIG ?? "bootstrap/config.example.json", timeoutSeconds: 300 };
  for (let index = 1; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--confirm-topology-change") result.confirmTopologyChange = true;
    else if (argument === "--force") result.force = true;
    else if (["--config", "--profile", "--timeout-seconds", "--backup", "--name-suffix"].includes(argument)) {
      const value = arguments_[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      result[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown argument '${argument}'.`);
  }
  if (!actions.includes(result.action)) throw new Error(`Action must be one of: ${actions.join(", ")}.`);
  result.timeoutSeconds = Number(result.timeoutSeconds);
  if (!Number.isInteger(result.timeoutSeconds) || result.timeoutSeconds < 60 || result.timeoutSeconds > 1800) throw new Error("--timeout-seconds must be an integer from 60 through 1800.");
  if (result.nameSuffix !== undefined && !/^(?=.{1,27}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.nameSuffix)) throw new Error("--name-suffix must be a DNS-label suffix from 1 through 27 characters.");
  return result;
}

function emit(level, phase, message, fields = {}) {
  const event = { timestamp: new Date().toISOString(), level, phase, message, ...fields };
  events.push(event);
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function flushLog() {
  await atomicWrite(activeLogPath, events.map(event => JSON.stringify(event)).join("\n") + "\n");
}

async function archiveOldLogs(logRoot) {
  if (!await fileExists(logRoot)) return;
  const archiveRoot = resolve(logRoot, "Archive");
  assertPathInside(logRoot, archiveRoot, "log archive");
  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  for (const entry of await readdir(logRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^Realtime-Bootstrap-.*\.jsonl$/.test(entry.name)) continue;
    const source = resolve(logRoot, entry.name);
    if ((await stat(source)).mtimeMs >= cutoff) continue;
    await mkdir(archiveRoot, { recursive: true });
    await rename(source, resolve(archiveRoot, entry.name));
  }
}

async function command(file, args, description, options) {
  const arguments_ = [...args];
  if (options.kubeContext && /(?:^|[\\/])kubectl(?:\.exe)?$/i.test(file) && !(args[0] === "config" && args[1] === "current-context")) arguments_.push("--context", options.kubeContext);
  if (options.kubeContext && /(?:^|[\\/])helm(?:\.exe)?$/i.test(file) && ["list", "get", "upgrade", "uninstall", "rollback"].includes(args[0])) arguments_.push("--kube-context", options.kubeContext);
  emit("info", options.action, description, { executable: file, arguments: arguments_ });
  let output = "";
  await new Promise((accept, reject) => {
    const child = spawn(file, arguments_, { cwd: repositoryRoot, env: process.env, shell: process.platform === "win32" && /\.cmd$/i.test(file) });
    let timedOut = false;
    let escalation;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, options.timeoutSeconds * 1000);
    child.stdout.on("data", data => { output += data; if (!options.capture) process.stdout.write(data); });
    child.stderr.on("data", data => { if (!options.capture) process.stderr.write(data); });
    child.on("error", error => { clearTimeout(timer); clearTimeout(escalation); reject(error); });
    child.on("exit", code => {
      clearTimeout(timer);
      clearTimeout(escalation);
      if (timedOut) reject(new Error(`${description} exceeded ${options.timeoutSeconds} seconds and the child process was terminated.`));
      else code === 0 ? accept() : reject(new Error(`${description} failed with exit code ${code}.`));
    });
  });
  return output.trim();
}

async function currentContext(options) {
  return command("kubectl", ["config", "current-context"], "Read current Kubernetes context", { ...options, capture: true });
}

async function assertTarget(plan, config, options, mutation) {
  const context = await currentContext(options);
  if (context !== plan.target.context) throw new Error(`Target mismatch: expected Kubernetes context '${plan.target.context}', found '${context}'.`);
  await command("kubectl", ["cluster-info", "--request-timeout=15s"], "Reach Kubernetes API", options);
  await command("helm", ["lint", "helm/realtime-gateway", "--strict", "--values", options.valuesPath], "Lint rendered gateway configuration", options);
  if (config.redis.mode === "managed") await command("kubectl", ["get", "storageclass", config.kubernetes.storageClass, "--request-timeout=15s"], "Validate storage class", options);
  if (config.ingress.enabled) {
    await command("kubectl", ["get", "namespace", config.networking.traefikNamespace, "--request-timeout=15s"], "Validate ingress namespace", options);
    await command("kubectl", ["get", "service", config.networking.traefikService, "--namespace", config.networking.traefikNamespace, "--request-timeout=15s"], "Validate ingress service", options);
  }
  await command("kubectl", ["get", "namespace", config.networking.metalLbNamespace, "--request-timeout=15s"], "Validate MetalLB namespace", options);
  if (config.ingress.enabled) await command("kubectl", ["get", "secret", config.ingress.tlsSecretName, "--namespace", plan.target.namespace, "--request-timeout=15s"], "Validate ingress TLS Secret reference", options);
  if (config.observability.serviceMonitor) await command("kubectl", ["get", "customresourcedefinition", "servicemonitors.monitoring.coreos.com", "--request-timeout=15s"], "Validate ServiceMonitor support", options);
  if (config.observability.otlpHeadersSecret) {
    const otlpSecret = await command("kubectl", ["get", "secret", config.observability.otlpHeadersSecret, "--namespace", plan.target.namespace, "--ignore-not-found", "-o", "name"], "Validate OTLP headers Secret reference", { ...options, capture: true });
    if (!otlpSecret) throw new Error(`OTLP headers Secret '${config.observability.otlpHeadersSecret}' does not exist in '${plan.target.namespace}'.`);
    const otlpKeys = await command("kubectl", ["get", "secret", config.observability.otlpHeadersSecret, "--namespace", plan.target.namespace, "--output", "go-template={{range $key, $_ := .data}}{{$key}}{{\"\\n\"}}{{end}}"], "Validate OTLP headers Secret key", { ...options, capture: true });
    if (!new Set(otlpKeys.split(/\r?\n/).filter(Boolean)).has(config.observability.otlpHeadersKey)) throw new Error(`OTLP headers Secret '${config.observability.otlpHeadersSecret}' is missing configured key '${config.observability.otlpHeadersKey}'.`);
  }
  if (config.topology === "ha") {
    const nodeDocument = await command("kubectl", ["get", "nodes", "--output", "json"], "Validate schedulable failure-domain capacity", { ...options, capture: true });
    const nodes = JSON.parse(nodeDocument).items.filter(node => !node.spec?.unschedulable
      && !node.spec?.taints?.some(taint => ["NoSchedule", "NoExecute"].includes(taint.effect))
      && node.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True"));
    if (nodes.length < plan.topology.minimumFailureDomains) throw new Error(`HA requires at least ${plan.topology.minimumFailureDomains} ready schedulable nodes.`);
    const zones = new Set(nodes.map(node => node.metadata?.labels?.["topology.kubernetes.io/zone"]).filter(Boolean));
    if (zones.size < plan.topology.minimumFailureDomains) throw new Error(`HA requires ready nodes in at least ${plan.topology.minimumFailureDomains} labeled topology zones.`);
  }
  if (mutation) {
    const allowed = await command("kubectl", ["auth", "can-i", "create", "deployments.apps", "--namespace", plan.target.namespace], "Validate mutation permission", { ...options, capture: true });
    if (allowed !== "yes") throw new Error(`Missing deployment mutation permission in '${plan.target.namespace}'.`);
  }
  const secret = await command("kubectl", ["get", "secret", config.redis.credentialsSecret, "--namespace", plan.target.namespace, "--ignore-not-found", "-o", "name"], "Validate credential Secret reference", { ...options, capture: true });
  if (!secret) throw new Error(`Credential Secret '${config.redis.credentialsSecret}' does not exist in '${plan.target.namespace}'.`);
  const keyListing = await command("kubectl", ["get", "secret", config.redis.credentialsSecret, "--namespace", plan.target.namespace, "--output", "go-template={{range $key, $_ := .data}}{{$key}}{{\"\\n\"}}{{end}}"], "Validate credential Secret keys", { ...options, capture: true });
  const configuredKeys = new Set(keyListing.split(/\r?\n/).filter(Boolean));
  for (const key of config.redis.mode === "managed" ? [config.redis.credentialKey, config.redis.adminCredentialKey] : [config.redis.credentialKey]) {
    if (!configuredKeys.has(key)) throw new Error(`Credential Secret '${config.redis.credentialsSecret}' is missing configured key '${key}'.`);
  }
}

async function assertTeardownTarget(plan, options) {
  const context = await currentContext(options);
  if (context !== plan.target.context) throw new Error(`Target mismatch: expected Kubernetes context '${plan.target.context}', found '${context}'.`);
  await command("kubectl", ["cluster-info", "--request-timeout=15s"], "Reach Kubernetes API", options);
  const allowed = await command("kubectl", ["auth", "can-i", "delete", "deployments.apps", "--namespace", plan.target.namespace], "Validate teardown permission", { ...options, capture: true });
  if (allowed !== "yes") throw new Error(`Missing deployment deletion permission in '${plan.target.namespace}'.`);
  const releasesDocument = await command("helm", ["list", "--namespace", plan.target.namespace, "--output", "json"], "Inventory teardown releases", { ...options, capture: true });
  if (!Array.isArray(JSON.parse(releasesDocument))) throw new Error("Helm release inventory was not a JSON array.");
}

async function assertBackupTarget(plan, options) {
  const context = await currentContext(options);
  if (context !== plan.target.context) throw new Error(`Target mismatch: expected Kubernetes context '${plan.target.context}', found '${context}'.`);
  await command("kubectl", ["cluster-info", "--request-timeout=15s"], "Reach Kubernetes API", options);
  const releasesDocument = await command("helm", ["list", "--namespace", plan.target.namespace, "--output", "json"], "Inventory backup releases", { ...options, capture: true });
  if (!Array.isArray(JSON.parse(releasesDocument))) throw new Error("Helm release inventory was not a JSON array.");
}

async function saveState(plan, options) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const directory = resolve(options.backupRoot, plan.target.release, stamp);
  assertPathInside(options.backupRoot, directory, "backup");
  await mkdir(directory, { recursive: true });
  try {
    const releasesDocument = await command("helm", ["list", "--namespace", plan.target.namespace, "--output", "json"], "Inventory installed releases", { ...options, capture: true });
    const releases = JSON.parse(releasesDocument);
    if (!Array.isArray(releases)) throw new Error("Helm release inventory was not a JSON array.");
    await atomicWrite(resolve(directory, "releases.json"), `${stableJson(releases)}`);
    const installed = new Set(releases.map(release => release?.name).filter(Boolean));
    for (const release of [plan.target.release, plan.target.redisRelease]) {
      if (installed.has(release)) {
        const valuesDocument = await command("helm", ["get", "values", release, "--namespace", plan.target.namespace, "--all", "--output", "json"], `Back up ${release} values`, { ...options, capture: true });
        const values = JSON.parse(valuesDocument);
        const secretPaths = inlineSecretPaths(values);
        if (secretPaths.length > 0) throw new Error(`Refusing to persist inline credential values returned by Helm at: ${secretPaths.join(", ")}. Replace them with Secret references before retrying.`);
        await atomicWrite(resolve(directory, `${release}.values.json`), stableJson(values));
      }
    }
    await atomicWrite(resolve(directory, "plan.json"), stableJson(plan));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  emit("pass", options.action, "Pre-change state captured.", { backup: directory });
  return directory;
}

function topologyFromValues(values, release) {
  if (["ha", "non-ha"].includes(values.topology)) return values.topology;
  if (Number.isInteger(values.replicaCount)) return values.replicaCount > 1 ? "ha" : "non-ha";
  throw new Error(`Release '${release}' does not expose a supported topology value.`);
}

async function installedReleaseState(planTarget, options) {
  const context = await currentContext(options);
  if (context !== planTarget.context) throw new Error(`Target mismatch: expected Kubernetes context '${planTarget.context}', found '${context}'.`);
  const releasesDocument = await command("helm", ["list", "--namespace", planTarget.namespace, "--output", "json"], "Inspect installed releases for topology", { ...options, capture: true });
  const releases = JSON.parse(releasesDocument);
  if (!Array.isArray(releases)) throw new Error("Helm release inventory was not a JSON array.");
  if (!releases.some(release => release?.name === planTarget.release)) return releases.some(release => release?.name === planTarget.redisRelease) ? { topology: undefined, redisMode: "managed" } : undefined;
  const valuesDocument = await command("helm", ["get", "values", planTarget.release, "--namespace", planTarget.namespace, "--all", "--output", "json"], "Read installed gateway topology", { ...options, capture: true });
  const values = JSON.parse(valuesDocument);
  return { topology: topologyFromValues(values, planTarget.release), redisMode: values.redis?.mode ?? (releases.some(release => release?.name === planTarget.redisRelease) ? "managed" : "external") };
}

async function readRollbackSnapshot(planTarget, options) {
  const backup = options.backup ? resolve(options.backup) : undefined;
  if (!backup) throw new Error("rollback requires --backup pointing to a captured backup directory.");
  assertPathInside(options.backupRoot, backup, "rollback source");
  const savedPlan = await readJson(resolve(backup, "plan.json"));
  if (savedPlan.target.context !== planTarget.context || savedPlan.target.namespace !== planTarget.namespace || savedPlan.target.release !== planTarget.release) throw new Error("Backup target does not match the requested context, namespace, and release.");
  const releases = await readJson(resolve(backup, "releases.json"));
  if (!Array.isArray(releases)) throw new Error("Backup release inventory is invalid.");
  const installed = new Set(releases.map(release => release?.name).filter(Boolean));
  if (!installed.has(planTarget.release)) return { gatewayPresent: false, releases };
  const valuesPath = resolve(backup, `${planTarget.release}.values.json`);
  if (!await fileExists(valuesPath)) throw new Error(`Backup inventory includes '${planTarget.release}' but its values snapshot is missing.`);
  const values = await readJson(valuesPath);
  const redisPresent = installed.has(planTarget.redisRelease);
  const redisValuesPath = resolve(backup, `${planTarget.redisRelease}.values.json`);
  if (redisPresent && !await fileExists(redisValuesPath)) throw new Error(`Backup inventory includes '${planTarget.redisRelease}' but its values snapshot is missing.`);
  return {
    gatewayPresent: true,
    releases,
    topology: topologyFromValues(values, planTarget.release),
    redisMode: values.redis?.mode ?? (redisPresent ? "managed" : "external"),
    gatewayValues: values,
    managedRedisValues: redisPresent ? await readJson(redisValuesPath) : undefined,
    managedRedisChart: redisPresent ? savedPlan.managedRedis?.chart : undefined,
    managedRedisChartVersion: redisPresent ? capturedRedisChartVersion(releases, planTarget.redisRelease) : undefined,
  };
}

async function writeNamingManifest(config) {
  const names = releaseNames(config);
  const [containerRegistry, ...repositoryParts] = config.image.repository.split("/");
  await atomicWrite(resolve(repositoryRoot, ".bootstrap", "naming.json"), stableJson({
    brand: "Cormier",
    application: names.application,
    serviceName: `cormier-${names.application}-gateway`,
    containerRegistry,
    containerRepository: repositoryParts.join("/"),
    imageRepository: config.image.repository,
    redisInstancePrefix: config.redis.instancePrefix,
    kubernetesApplication: names.application,
  }));
}

function gatewayUpgradeArguments(plan, options, action = "upgrade") {
  return [action, "--install", plan.target.release, "helm/realtime-gateway", "--namespace", plan.target.namespace, "--create-namespace", "--values", options.valuesPath, "--atomic", "--wait", `--timeout=${plan.safety.boundedTimeoutSeconds}s`];
}

async function apply(plan, config, options) {
  if (config.redis.mode === "managed") {
    const redisArgs = ["upgrade", "--install", plan.target.redisRelease, plan.managedRedis.chart, "--version", plan.managedRedis.chartVersion, "--namespace", plan.target.namespace, "--create-namespace", "--values", plan.managedRedis.baseValuesPath, "--values", options.redisValuesPath, "--atomic", "--wait", `--timeout=${options.timeoutSeconds}s`];
    await command("helm", redisArgs, "Install or update managed Redis", options);
  }
  await command("helm", gatewayUpgradeArguments(plan, options), "Install or update realtime gateway", options);
  if (["update", "recover"].includes(options.action)) await command("kubectl", ["rollout", "restart", `deployment/${plan.target.release}`, "--namespace", plan.target.namespace], "Restart gateway after referenced Secret rotation", options);
  await command("kubectl", ["rollout", "status", `deployment/${plan.target.release}`, "--namespace", plan.target.namespace, `--timeout=${options.timeoutSeconds}s`], "Verify gateway rollout", options);
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function acquireLock(lockPath) {
  const ownerPath = resolve(lockPath, "owner.json");
  const owner = { createdAt: new Date().toISOString(), hostname: hostname(), pid: process.pid, token: randomUUID() };
  try {
    await mkdir(lockPath);
    await atomicWrite(ownerPath, stableJson(owner));
    return owner.token;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  let stale = false;
  if (await fileExists(ownerPath)) {
    try {
      const existing = await readJson(ownerPath);
      const age = Date.now() - Date.parse(existing.createdAt);
      stale = existing.hostname === hostname() ? !processExists(existing.pid) : Number.isFinite(age) && age > 2 * 60 * 60 * 1000;
    } catch { stale = Date.now() - (await stat(lockPath)).mtimeMs > 2 * 60 * 60 * 1000; }
  } else {
    stale = Date.now() - (await stat(lockPath)).mtimeMs > 2 * 60 * 60 * 1000;
  }
  if (!stale) throw new Error(`Another lifecycle operation holds the target lock '${lockPath}'.`);
  const stalePath = `${lockPath}.stale-${owner.token}`;
  try { await rename(lockPath, stalePath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await mkdir(lockPath);
    await atomicWrite(ownerPath, stableJson(owner));
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another lifecycle operation holds the target lock '${lockPath}'.`);
    throw error;
  } finally {
    await rm(stalePath, { recursive: true, force: true });
  }
  return owner.token;
}

async function releaseLock(lockPath, token) {
  try {
    const owner = await readJson(resolve(lockPath, "owner.json"));
    if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if (!/Cannot read JSON/.test(error.message)) throw error;
  }
}

function capturedRedisChartVersion(releaseInventory, release) {
  const chart = releaseInventory.find(item => item?.name === release)?.chart;
  const match = typeof chart === "string" ? /^redis-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(chart) : undefined;
  if (!match) throw new Error(`Backup inventory for '${release}' does not contain a supported Redis chart version.`);
  return match[1];
}

function capturedReleaseRevision(releaseInventory, release) {
  const revision = Number(releaseInventory.find(item => item?.name === release)?.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error(`Backup inventory for '${release}' does not contain a valid Helm revision.`);
  return revision;
}

async function rollback(plan, options) {
  const backup = options.backup ? resolve(options.backup) : undefined;
  if (!backup) throw new Error("rollback requires --backup pointing to a captured backup directory.");
  assertPathInside(options.backupRoot, backup, "rollback source");
  const savedPlan = await readJson(resolve(backup, "plan.json"));
  if (savedPlan.target.context !== plan.target.context || savedPlan.target.namespace !== plan.target.namespace || savedPlan.target.release !== plan.target.release) throw new Error("Backup target does not match the requested context, namespace, and release.");
  const releaseInventory = await readJson(resolve(backup, "releases.json"));
  if (!Array.isArray(releaseInventory)) throw new Error("Backup release inventory is invalid.");
  const installedAtBackup = new Set(releaseInventory.map(release => release?.name).filter(Boolean));
  for (const release of [plan.target.redisRelease, plan.target.release]) {
    const valuesPath = resolve(backup, `${release}.values.json`);
    if (!installedAtBackup.has(release)) {
      await command("helm", ["uninstall", release, "--namespace", plan.target.namespace, "--ignore-not-found", "--keep-history", "--wait", `--timeout=${options.timeoutSeconds}s`], `Remove ${release} absent from backup`, options);
    } else if (await fileExists(valuesPath)) {
      if (release === plan.target.release) {
        await command("helm", ["rollback", release, String(capturedReleaseRevision(releaseInventory, release)), "--namespace", plan.target.namespace, "--wait", `--timeout=${options.timeoutSeconds}s`], `Restore ${release} revision`, options);
        continue;
      }
      const chart = savedPlan.managedRedis?.chart;
      if (typeof chart !== "string" || !chart) throw new Error("Backup plan does not contain the managed Redis chart repository.");
      const arguments_ = ["upgrade", "--install", release, chart];
      if (release !== plan.target.release) arguments_.push("--version", capturedRedisChartVersion(releaseInventory, release));
      arguments_.push("--namespace", plan.target.namespace, "--values", valuesPath, "--atomic", "--wait", `--timeout=${options.timeoutSeconds}s`);
      await command("helm", arguments_, `Restore ${release}`, options);
    } else throw new Error(`Backup inventory includes '${release}' but its values snapshot is missing.`);
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  options.action = options.action;
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error(`Configuration is invalid: Node.js 22 or later is required; detected ${process.version}.`);
  let { config, profile } = await loadContract(repositoryRoot, options.config, options.profile);
  options.kubeContext = config.kubernetes.context;
  if (options.nameSuffix !== undefined) {
    config = structuredClone(config);
    config.naming.suffix = options.nameSuffix;
    config.redis.instancePrefix = `${config.redis.instancePrefix}:${options.nameSuffix}`;
  }
  await writeNamingManifest(config);
  options.generatedRoot = resolve(repositoryRoot, config.paths.generatedDirectory);
  options.backupRoot = resolve(repositoryRoot, config.paths.backupDirectory);
  const logRoot = resolve(repositoryRoot, config.paths.logDirectory);
  assertPathInside(repositoryRoot, options.generatedRoot, "generated output");
  assertPathInside(repositoryRoot, options.backupRoot, "backup output");
  assertPathInside(repositoryRoot, logRoot, "log output");
  await archiveOldLogs(logRoot);
  activeLogPath = resolve(logRoot, `Realtime-Bootstrap-${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
  const names = config.naming.suffix ? `realtime-${config.naming.suffix}` : "realtime";
  const targetRoot = resolve(options.generatedRoot, `${config.environment.name}-${names}`);
  assertPathInside(options.generatedRoot, targetRoot, "generated output");
  await mkdir(targetRoot, { recursive: true });
  const mutation = ["install", "update", "rollback", "recover", "teardown"].includes(options.action);
  const lockRequired = true;
  const lockPath = resolve(repositoryRoot, ".bootstrap", "locks", `${config.environment.name}-${names}`);
  assertPathInside(resolve(repositoryRoot, ".bootstrap", "locks"), lockPath, "target lock");
  await mkdir(dirname(lockPath), { recursive: true });
  const lockToken = lockRequired ? await acquireLock(lockPath) : undefined;
  try {
    const statePath = resolve(targetRoot, "state.json");
    const priorState = await fileExists(statePath) ? await readJson(statePath) : undefined;
    const provisionalPlan = buildPlan(options.action, config, profile, { dryRun: options.dryRun, timeoutSeconds: options.timeoutSeconds, previousTopology: priorState?.topology });
    const rollbackSnapshot = options.action === "rollback" ? await readRollbackSnapshot(provisionalPlan.target, options) : undefined;
    if (rollbackSnapshot?.gatewayPresent) {
      config = structuredClone(config);
      config.topology = rollbackSnapshot.topology;
      config.redis.mode = rollbackSnapshot.redisMode;
      profile = await readJson(resolve(repositoryRoot, "bootstrap", "profiles", `${config.topology}.json`));
      if (config.topology === "ha" && config.kubernetes.failureDomains < profile.minimumFailureDomains) throw new Error(`Configuration is invalid: rollback to HA requires at least ${profile.minimumFailureDomains} configured failure domains.`);
    }
    const clusterAware = ["install", "update", "rollback", "recover", "teardown"].includes(options.action);
    const installedState = clusterAware ? await installedReleaseState(provisionalPlan.target, options) : undefined;
    if (["install", "update", "recover"].includes(options.action) && installedState?.redisMode && installedState.redisMode !== config.redis.mode) throw new Error(`Redis mode conversion from '${installedState.redisMode}' to '${config.redis.mode}' requires an explicit migration outside this bootstrap action.`);
    if (options.action === "rollback" && rollbackSnapshot?.gatewayPresent && installedState?.redisMode && installedState.redisMode !== rollbackSnapshot.redisMode) throw new Error(`Redis mode rollback conversion from '${installedState.redisMode}' to '${rollbackSnapshot.redisMode}' requires an explicit migration outside this bootstrap action.`);
    const previousTopology = installedState?.topology ?? (clusterAware ? undefined : priorState?.topology);
    let plan = buildPlan(options.action, config, profile, { dryRun: options.dryRun, timeoutSeconds: options.timeoutSeconds, previousTopology });
    if (options.action === "rollback" && rollbackSnapshot?.gatewayPresent) plan = useCapturedDeploymentValues(plan, rollbackSnapshot.gatewayValues, rollbackSnapshot.managedRedisValues, rollbackSnapshot.managedRedisChart, rollbackSnapshot.managedRedisChartVersion);
    options.valuesPath = resolve(targetRoot, "values.json");
    await atomicWrite(resolve(targetRoot, "plan.json"), stableJson(plan));
    await atomicWrite(options.valuesPath, stableJson(plan.values));
    if (plan.managedRedis) {
      options.redisValuesPath = resolve(targetRoot, "redis-values.json");
      await atomicWrite(options.redisValuesPath, stableJson(plan.managedRedis.values));
    }
    emit("info", "plan", "Normalized execution plan.", plan);
    if (plan.topology.conversion && !options.confirmTopologyChange && !options.dryRun) throw new Error("Topology conversion requires --confirm-topology-change after reviewing the plan and impact warning.");
    if (options.action === "teardown" && !options.force && !options.dryRun) throw new Error("teardown requires --force after reviewing the target and data-loss warning.");
    if (options.action === "teardown" && config.environment.class === "production") throw new Error("Automated teardown is forbidden for production configurations.");
    if (options.action === "plan" || options.dryRun) {
      emit("pass", options.action, options.dryRun ? "Dry run completed without external operations." : "Plan completed without mutation.", { summary: { executed: 0, skipped: 1 } });
      await flushLog();
      return;
    }

    if (options.action === "prerequisites") {
      await command("node", ["--version"], "Validate Node.js", options);
      await command("git", ["--version"], "Validate Git", options);
      const dotnetVersion = await command(process.platform === "win32" ? "dotnet.exe" : "dotnet", ["--version"], "Validate .NET SDK", { ...options, capture: true });
      if (!/^10\./.test(dotnetVersion)) throw new Error(`.NET SDK 10.x is required; detected '${dotnetVersion}'.`);
      const helmVersion = await command("helm", ["version", "--short"], "Validate Helm", { ...options, capture: true });
      if (!/^v4\.2\./.test(helmVersion)) throw new Error(`Helm 4.2.x is required; detected '${helmVersion}'.`);
      await command("kubectl", ["version", "--client"], "Validate kubectl", options);
      emit("pass", options.action, "Prerequisite validation completed.", { summary: { executed: 5, skipped: 0 } });
      await flushLog();
      return;
    }
    if (options.action === "bootstrap") {
      await command("git", ["--version"], "Validate Git", options);
      await command(process.platform === "win32" ? "dotnet.exe" : "dotnet", ["restore", "Cormier.Realtime.sln", "--locked-mode"], "Restore locked .NET dependencies", options);
      await command(process.platform === "win32" ? "dotnet.exe" : "dotnet", ["build", "Cormier.Realtime.sln", "--configuration", "Release", "--no-restore"], "Build the Release solution", options);
      emit("pass", options.action, "Workspace bootstrap completed.", { summary: { executed: 3, skipped: 0 } });
      await flushLog();
      return;
    }
    let backup;
    if (options.action === "teardown") await assertTeardownTarget(plan, options);
    else if (options.action === "backup") await assertBackupTarget(plan, options);
    else await assertTarget(plan, config, options, mutation);
    if (plan.safety.requiresBackup || options.action === "backup") backup = await saveState(plan, options);
    if (["install", "update", "recover"].includes(options.action)) await apply(plan, config, options);
    else if (options.action === "validate") await command("helm", ["template", plan.target.release, "helm/realtime-gateway", "--namespace", plan.target.namespace, "--values", options.valuesPath], "Render gateway manifests", options);
    else if (options.action === "rollback") await rollback(plan, options);
    else if (options.action === "teardown") {
      await command("helm", ["uninstall", plan.target.release, "--namespace", plan.target.namespace, "--ignore-not-found", "--keep-history", "--wait", `--timeout=${options.timeoutSeconds}s`], "Remove realtime gateway", options);
      if (config.redis.mode === "managed" || installedState?.redisMode === "managed") await command("helm", ["uninstall", plan.target.redisRelease, "--namespace", plan.target.namespace, "--ignore-not-found", "--keep-history", "--wait", `--timeout=${options.timeoutSeconds}s`], "Remove managed Redis", options);
    }
    if (options.action === "teardown" || (options.action === "rollback" && rollbackSnapshot?.gatewayPresent === false)) await rm(statePath, { force: true });
    else if (["install", "update", "recover", "rollback"].includes(options.action)) await atomicWrite(statePath, stableJson({ contractVersion: 1, topology: config.topology, valuesSha256: plan.valuesSha256, backup: backup ?? options.backup ?? null }));
    emit("pass", options.action, "Lifecycle action completed.", {
      backup: backup ?? null,
      profile: config.topology,
      summary: { backups: backup ? 1 : 0, executed: 1, skipped: 0 },
    });
    await flushLog();
  } finally {
    if (lockRequired) await releaseLock(lockPath, lockToken);
  }
}

main().catch(async error => {
  emit("error", "failure", error.message);
  try { await flushLog(); } catch (logError) { process.stderr.write(`Unable to write lifecycle log: ${logError.message}\n`); }
  if (/^(?:Action must|Unknown argument|--.+ requires|--timeout-seconds)|Configuration is invalid|Requested profile|Cannot read JSON|Derived Helm release/.test(error.message)) process.exitCode = 2;
  else if (/requires --|requires an explicit migration|forbidden for production|Target mismatch|target lock/.test(error.message)) process.exitCode = 3;
  else process.exitCode = 1;
});
