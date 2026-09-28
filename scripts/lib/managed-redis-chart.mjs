import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { parse, relative, resolve } from "node:path";

const serviceNeedle = "spec:\n  type: {{ .Values.sentinel.service.type }}";
const serviceReplacement = "spec:\n  publishNotReadyAddresses: true\n  type: {{ .Values.sentinel.service.type }}";

export function patchSentinelService(source) {
  const normalized = source.replaceAll("\r\n", "\n");
  if (normalized.includes("spec:\n  publishNotReadyAddresses: true\n")) return normalized;
  if (!normalized.includes(serviceNeedle)) {
    throw new Error("The Redis chart sentinel Service template does not match the reviewed patch contract.");
  }
  return normalized.replace(serviceNeedle, serviceReplacement);
}

async function run(file, arguments_, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(file, arguments_, {
      cwd: options.cwd,
      env: process.env,
      shell: process.platform === "win32" && /\.cmd$/i.test(file),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", code => code === 0
      ? accept({ stdout, stderr })
      : reject(new Error(`${file} ${arguments_.join(" ")} failed with exit code ${code}: ${stderr.trim()}`)));
  });
}

export async function prepareManagedRedisChart({
  chart,
  version,
  archiveSha256,
  outputDirectory,
  helm = "helm",
}) {
  if (!/^oci:\/\//.test(chart)) throw new Error("Managed Redis chart source must be an OCI reference.");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Managed Redis chart version is invalid.");
  if (!/^sha256:[a-f0-9]{64}$/.test(archiveSha256)) throw new Error("Managed Redis chart archive SHA-256 is invalid.");

  const destination = resolve(outputDirectory);
  const archive = resolve(destination, `redis-${version}.tgz`);
  const chartDirectory = resolve(destination, "redis");
  if (destination === parse(destination).root || relative(destination, chartDirectory) !== "redis") {
    throw new Error(`Refusing unsafe managed Redis chart output directory '${destination}'.`);
  }
  await mkdir(destination, { recursive: true });
  await rm(archive, { force: true });
  await rm(chartDirectory, { recursive: true, force: true });

  await run(helm, ["pull", chart, "--version", version, "--destination", destination]);
  const archiveBytes = await readFile(archive);
  const actualSha256 = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
  if (actualSha256 !== archiveSha256) {
    await rm(archive, { force: true });
    throw new Error(`Managed Redis chart archive checksum mismatch: expected ${archiveSha256}, received ${actualSha256}.`);
  }

  await run("tar", ["-xzf", archive, "-C", destination]);
  const servicePath = resolve(chartDirectory, "templates", "sentinel", "service.yaml");
  const patched = patchSentinelService(await readFile(servicePath, "utf8"));
  const { atomicWrite } = await import("./bootstrap-contract.mjs");
  await atomicWrite(servicePath, patched);
  await rm(archive, { force: true });
  return { chartDirectory, servicePath, archiveSha256: actualSha256 };
}

export function managedRedisChartOutput(generatedRoot, release, version) {
  return resolve(generatedRoot, release, "charts", `redis-${version}`);
}
