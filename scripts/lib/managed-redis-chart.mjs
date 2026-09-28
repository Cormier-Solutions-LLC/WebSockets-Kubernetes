import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { parse, relative, resolve } from "node:path";

const serviceNeedle = "spec:\n  type: {{ .Values.sentinel.service.type }}";
const serviceReplacement = "spec:\n  publishNotReadyAddresses: true\n  type: {{ .Values.sentinel.service.type }}";

export function patchSentinelService(source) {
  const normalized = source.replaceAll("\r\n", "\n");
  if (normalized.includes("spec:\n  publishNotReadyAddresses: true\n")) return normalized;
  if (!normalized.includes(serviceNeedle)) throw new Error("The Redis chart sentinel Service template does not match the reviewed patch contract.");
  return normalized.replace(serviceNeedle, serviceReplacement);
}

function lifecycleDeadline(timeoutSeconds) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("Managed Redis chart timeout must be greater than zero.");
  return Date.now() + (timeoutSeconds * 1000);
}

async function run(file, arguments_, { cwd, deadline }) {
  const remainingMilliseconds = deadline - Date.now();
  if (remainingMilliseconds <= 0) throw new Error(`Managed Redis chart preparation exceeded its lifecycle deadline before ${file} could start.`);
  return new Promise((accept, reject) => {
    const child = spawn(file, arguments_, {
      cwd,
      env: process.env,
      shell: process.platform === "win32" && /\.cmd$/i.test(file),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let spawnError;
    let timedOut = false;
    let escalation;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, remainingMilliseconds);
    child.stdout?.on("data", data => { stdout += data; });
    child.stderr?.on("data", data => { stderr += data; });
    child.on("error", error => { spawnError = error; });
    child.on("close", code => {
      clearTimeout(timer);
      clearTimeout(escalation);
      if (timedOut) reject(new Error(`Managed Redis chart command '${file} ${arguments_.join(" ")}' exceeded the lifecycle deadline and was terminated.`));
      else if (spawnError) reject(spawnError);
      else if (code === 0) accept({ stdout, stderr });
      else reject(new Error(`${file} ${arguments_.join(" ")} failed with exit code ${code}: ${stderr.trim()}`));
    });
  });
}

function validateChartIdentity(chart, version) {
  if (!/^oci:\/\//.test(chart)) throw new Error("Managed Redis chart source must be an OCI reference.");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Managed Redis chart version is invalid.");
}

async function pullManagedRedisChart({ chart, version, outputDirectory, helm, deadline }) {
  validateChartIdentity(chart, version);
  const destination = resolve(outputDirectory);
  const archivePath = resolve(destination, `redis-${version}.tgz`);
  if (destination === parse(destination).root || relative(destination, archivePath) !== `redis-${version}.tgz`) throw new Error(`Refusing unsafe managed Redis chart output directory '${destination}'.`);
  await mkdir(destination, { recursive: true });
  await rm(archivePath, { force: true });
  await run(helm, ["pull", chart, "--version", version, "--destination", destination], { deadline });
  const archiveBytes = await readFile(archivePath);
  return { archivePath, archiveSha256: `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}` };
}

export async function captureManagedRedisChart({ chart, version, outputDirectory, helm = "helm", timeoutSeconds = 300 }) {
  return pullManagedRedisChart({ chart, version, outputDirectory, helm, deadline: lifecycleDeadline(timeoutSeconds) });
}

export async function prepareManagedRedisChart({
  chart,
  version,
  archiveSha256,
  archivePath,
  outputDirectory,
  helm = "helm",
  timeoutSeconds = 300,
}) {
  validateChartIdentity(chart, version);
  if (!/^sha256:[a-f0-9]{64}$/.test(archiveSha256)) throw new Error("Managed Redis chart archive SHA-256 is invalid.");
  const deadline = lifecycleDeadline(timeoutSeconds);
  const destination = resolve(outputDirectory);
  const chartDirectory = resolve(destination, "redis");
  if (destination === parse(destination).root || relative(destination, chartDirectory) !== "redis") throw new Error(`Refusing unsafe managed Redis chart output directory '${destination}'.`);
  await mkdir(destination, { recursive: true });
  await rm(chartDirectory, { recursive: true, force: true });

  const pulled = archivePath
    ? { archivePath: resolve(archivePath), archiveSha256: `sha256:${createHash("sha256").update(await readFile(resolve(archivePath))).digest("hex")}` }
    : await pullManagedRedisChart({ chart, version, outputDirectory: destination, helm, deadline });
  if (pulled.archiveSha256 !== archiveSha256) {
    if (!archivePath) await rm(pulled.archivePath, { force: true });
    throw new Error(`Managed Redis chart archive checksum mismatch: expected ${archiveSha256}, received ${pulled.archiveSha256}.`);
  }

  await run("tar", ["-xzf", pulled.archivePath, "-C", destination], { deadline });
  const servicePath = resolve(chartDirectory, "templates", "sentinel", "service.yaml");
  const patched = patchSentinelService(await readFile(servicePath, "utf8"));
  const { atomicWrite } = await import("./bootstrap-contract.mjs");
  await atomicWrite(servicePath, patched);
  if (!archivePath) await rm(pulled.archivePath, { force: true });
  return { chartDirectory, servicePath, archiveSha256: pulled.archiveSha256 };
}

export function managedRedisChartOutput(generatedRoot, release, version) {
  return resolve(generatedRoot, release, "charts", `redis-${version}`);
}
