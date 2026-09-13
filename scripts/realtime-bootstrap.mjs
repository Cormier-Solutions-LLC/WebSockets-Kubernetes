#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  actions, assertPathInside, atomicWrite, buildPlan, fileExists, loadContract, readJson, stableJson,
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
    else if (["--config", "--profile", "--timeout-seconds", "--backup"].includes(argument)) {
      const value = arguments_[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      result[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown argument '${argument}'.`);
  }
  if (!actions.includes(result.action)) throw new Error(`Action must be one of: ${actions.join(", ")}.`);
  result.timeoutSeconds = Number(result.timeoutSeconds);
  if (!Number.isInteger(result.timeoutSeconds) || result.timeoutSeconds < 60 || result.timeoutSeconds > 1800) throw new Error("--timeout-seconds must be an integer from 60 through 1800.");
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
  emit("info", options.action, description, { executable: file, arguments: args });
  let output = "";
  await new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd: repositoryRoot, env: process.env, shell: process.platform === "win32" && /\.cmd$/i.test(file) });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${description} exceeded ${options.timeoutSeconds} seconds.`)); }, options.timeoutSeconds * 1000);
    child.stdout.on("data", data => { output += data; if (!options.capture) process.stdout.write(data); });
    child.stderr.on("data", data => { output += data; if (!options.capture) process.stderr.write(data); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error(`${description} failed with exit code ${code}.`)); });
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
  await command("kubectl", ["get", "storageclass", config.kubernetes.storageClass, "--request-timeout=15s"], "Validate storage class", options);
  await command("kubectl", ["get", "namespace", config.networking.traefikNamespace, "--request-timeout=15s"], "Validate ingress namespace", options);
  await command("kubectl", ["get", "service", config.networking.traefikService, "--namespace", config.networking.traefikNamespace, "--request-timeout=15s"], "Validate ingress service", options);
  await command("kubectl", ["get", "namespace", config.networking.metalLbNamespace, "--request-timeout=15s"], "Validate MetalLB namespace", options);
  if (config.ingress.enabled) await command("kubectl", ["get", "secret", config.ingress.tlsSecretName, "--namespace", plan.target.namespace, "--request-timeout=15s"], "Validate ingress TLS Secret reference", options);
  if (config.observability.serviceMonitor) await command("kubectl", ["get", "customresourcedefinition", "servicemonitors.monitoring.coreos.com", "--request-timeout=15s"], "Validate ServiceMonitor support", options);
  if (config.topology === "ha") {
    const nodeDocument = await command("kubectl", ["get", "nodes", "--output", "json"], "Validate schedulable failure-domain capacity", { ...options, capture: true });
    const nodes = JSON.parse(nodeDocument).items.filter(node => !node.spec?.unschedulable && node.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True"));
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
  for (const key of config.redis.mode === "managed" ? [config.redis.passwordKey, config.redis.adminPasswordKey] : [config.redis.passwordKey]) {
    if (!configuredKeys.has(key)) throw new Error(`Credential Secret '${config.redis.credentialsSecret}' is missing configured key '${key}'.`);
  }
}

async function saveState(plan, options) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const directory = resolve(options.backupRoot, plan.target.release, stamp);
  assertPathInside(options.backupRoot, directory, "backup");
  await mkdir(directory, { recursive: true });
  const releases = await command("helm", ["list", "--namespace", plan.target.namespace, "--output", "json"], "Inventory installed releases", { ...options, capture: true });
  await atomicWrite(resolve(directory, "releases.json"), `${releases}\n`);
  for (const release of [plan.target.release, plan.target.redisRelease]) {
    if (releases.includes(`\"name\":\"${release}\"`) || releases.includes(`\"name\": \"${release}\"`)) {
      const values = await command("helm", ["get", "values", release, "--namespace", plan.target.namespace, "--all", "--output", "json"], `Back up ${release} values`, { ...options, capture: true });
      await atomicWrite(resolve(directory, `${release}.values.json`), `${values}\n`);
    }
  }
  await atomicWrite(resolve(directory, "plan.json"), stableJson(plan));
  emit("pass", options.action, "Pre-change state captured.", { backup: directory });
  return directory;
}

function gatewayUpgradeArguments(plan, options, action = "upgrade") {
  return [action, "--install", plan.target.release, "helm/realtime-gateway", "--namespace", plan.target.namespace, "--create-namespace", "--values", options.valuesPath, "--atomic", "--wait", `--timeout=${plan.safety.boundedTimeoutSeconds}s`];
}

async function apply(plan, config, profile, options) {
  if (config.redis.mode === "managed") {
    const redisArgs = ["upgrade", "--install", plan.target.redisRelease, "oci://registry-1.docker.io/bitnamicharts/redis", "--version", "23.1.1", "--namespace", plan.target.namespace, "--create-namespace", "--set", `architecture=${profile.redis.managedArchitecture}`, "--set", `replica.replicaCount=${profile.redis.replicas}`, "--set", `sentinel.enabled=${profile.redis.sentinel}`, "--set", `global.storageClass=${config.kubernetes.storageClass}`, "--set", "master.persistence.enabled=true", "--set", `master.persistence.size=${config.resources.redisStorage}`, "--set", "replica.persistence.enabled=true", "--set", `replica.persistence.size=${config.resources.redisStorage}`, "--set", `auth.existingSecret=${config.redis.credentialsSecret}`, "--atomic", "--wait", `--timeout=${options.timeoutSeconds}s`];
    await command("helm", redisArgs, "Install or update managed Redis", options);
  }
  await command("helm", gatewayUpgradeArguments(plan, options), "Install or update realtime gateway", options);
  await command("kubectl", ["rollout", "status", `deployment/${plan.target.release}`, "--namespace", plan.target.namespace, `--timeout=${options.timeoutSeconds}s`], "Verify gateway rollout", options);
}

async function rollback(plan, options) {
  const backup = options.backup ? resolve(options.backup) : undefined;
  if (!backup) throw new Error("rollback requires --backup pointing to a captured backup directory.");
  assertPathInside(options.backupRoot, backup, "rollback source");
  const savedPlan = await readJson(resolve(backup, "plan.json"));
  if (savedPlan.target.context !== plan.target.context || savedPlan.target.namespace !== plan.target.namespace || savedPlan.target.release !== plan.target.release) throw new Error("Backup target does not match the requested context, namespace, and release.");
  for (const release of [plan.target.redisRelease, plan.target.release]) {
    const valuesPath = resolve(backup, `${release}.values.json`);
    if (await fileExists(valuesPath)) {
      const chart = release === plan.target.release ? "helm/realtime-gateway" : "oci://registry-1.docker.io/bitnamicharts/redis";
      const arguments_ = ["upgrade", "--install", release, chart];
      if (release !== plan.target.release) arguments_.push("--version", "23.1.1");
      arguments_.push("--namespace", plan.target.namespace, "--values", valuesPath, "--atomic", "--wait", `--timeout=${options.timeoutSeconds}s`);
      await command("helm", arguments_, `Restore ${release}`, options);
    }
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  options.action = options.action;
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error(`Configuration is invalid: Node.js 22 or later is required; detected ${process.version}.`);
  const { config, profile } = await loadContract(repositoryRoot, options.config, options.profile);
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
  const lockRequired = mutation || options.action === "backup";
  const lockPath = resolve(targetRoot, "operation.lock");
  if (lockRequired) {
    try { await mkdir(lockPath); }
    catch (error) { if (error.code === "EEXIST") throw new Error(`Another lifecycle operation holds the target lock '${lockPath}'.`); throw error; }
  }
  try {
    const statePath = resolve(targetRoot, "state.json");
    const priorState = await fileExists(statePath) ? await readJson(statePath) : undefined;
    const plan = buildPlan(options.action, config, profile, { dryRun: options.dryRun, timeoutSeconds: options.timeoutSeconds, previousTopology: priorState?.topology });
    options.valuesPath = resolve(targetRoot, "values.json");
    await atomicWrite(resolve(targetRoot, "plan.json"), stableJson(plan));
    await atomicWrite(options.valuesPath, stableJson(plan.values));
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
    await assertTarget(plan, config, options, mutation);
    if (plan.safety.requiresBackup || options.action === "backup") backup = await saveState(plan, options);
    if (["install", "update", "recover"].includes(options.action)) await apply(plan, config, profile, options);
    else if (options.action === "validate") await command("helm", ["template", plan.target.release, "helm/realtime-gateway", "--namespace", plan.target.namespace, "--values", options.valuesPath], "Render gateway manifests", options);
    else if (options.action === "rollback") await rollback(plan, options);
    else if (options.action === "teardown") {
      await command("helm", ["uninstall", plan.target.release, "--namespace", plan.target.namespace, "--wait", `--timeout=${options.timeoutSeconds}s`], "Remove realtime gateway", options);
      if (config.redis.mode === "managed") await command("helm", ["uninstall", plan.target.redisRelease, "--namespace", plan.target.namespace, "--wait", `--timeout=${options.timeoutSeconds}s`], "Remove managed Redis", options);
    }
    if (["install", "update", "recover", "rollback"].includes(options.action)) await atomicWrite(statePath, stableJson({ contractVersion: 1, topology: config.topology, valuesSha256: plan.valuesSha256, backup: backup ?? options.backup ?? null }));
    emit("pass", options.action, "Lifecycle action completed.", {
      backup: backup ?? null,
      profile: config.topology,
      summary: { backups: backup ? 1 : 0, executed: 1, skipped: 0 },
    });
    await flushLog();
  } finally {
    if (lockRequired) await rm(lockPath, { recursive: true, force: true });
  }
}

main().catch(async error => {
  emit("error", "failure", error.message);
  try { await flushLog(); } catch (logError) { process.stderr.write(`Unable to write lifecycle log: ${logError.message}\n`); }
  if (/^(?:Action must|Unknown argument|--.+ requires|--timeout-seconds)|Configuration is invalid|Requested profile|Cannot read JSON|Derived Helm release/.test(error.message)) process.exitCode = 2;
  else if (/requires --|forbidden for production|Target mismatch|target lock/.test(error.message)) process.exitCode = 3;
  else process.exitCode = 1;
});
