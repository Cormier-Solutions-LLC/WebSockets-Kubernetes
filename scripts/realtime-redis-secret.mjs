#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dnsLabel = /^(?=.{1,63}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const dnsSubdomain = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
const secretKey = /^[A-Za-z0-9._-]+$/;

export function normalizePasswordBytes(input, label = "password") {
  const bytes = Buffer.from(input);
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 10 || bytes[end - 1] === 13)) end--;
  const normalized = bytes.subarray(0, end);
  if (normalized.length < 16) throw new Error(`${label} must contain at least 16 bytes after trailing CR/LF removal.`);
  if (normalized.includes(10) || normalized.includes(13)) throw new Error(`${label} must not contain embedded CR or LF bytes.`);
  return Buffer.from(normalized);
}

function parse(arguments_) {
  const result = { kubectl: "kubectl", adminKey: "redis-password", realtimeKey: "realtime" };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--create-namespace") { result.createNamespace = true; continue; }
    if (argument === "--dry-run") { result.dryRun = true; continue; }
    if (!["--context", "--namespace", "--secret-name", "--admin-password-file", "--realtime-password-file", "--admin-key", "--realtime-key", "--kubectl"].includes(argument)) throw new Error(`Unknown argument '${argument}'.`);
    const value = arguments_[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    result[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  for (const key of ["context", "namespace", "secretName", "adminPasswordFile", "realtimePasswordFile"]) if (!result[key]) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required.`);
  if (!dnsLabel.test(result.namespace)) throw new Error("--namespace must be a Kubernetes DNS label.");
  if (!dnsSubdomain.test(result.secretName)) throw new Error("--secret-name must be a Kubernetes DNS subdomain.");
  if (!secretKey.test(result.adminKey) || !secretKey.test(result.realtimeKey)) throw new Error("Secret keys must use Kubernetes Secret key syntax.");
  if (result.adminKey === result.realtimeKey) throw new Error("Administrator and realtime Secret keys must be distinct.");
  return result;
}

async function kubectl(options, arguments_, stdin) {
  const args = [...arguments_, "--context", options.context];
  return new Promise((accept, reject) => {
    const child = spawn(options.kubectl, args, {
      env: process.env,
      shell: process.platform === "win32" && /\.cmd$/i.test(options.kubectl),
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? accept(stdout) : reject(new Error(`kubectl ${arguments_[0]} failed with exit code ${code}: ${stderr.trim()}`)));
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

export async function applyRedisSecret(options) {
  const admin = normalizePasswordBytes(await readFile(options.adminPasswordFile), "Redis administrator password");
  const realtime = normalizePasswordBytes(await readFile(options.realtimePasswordFile), "Realtime ACL password");
  if (admin.equals(realtime)) throw new Error("Redis administrator and realtime ACL passwords must be different.");
  if (options.dryRun) return { changed: false, dryRun: true, namespace: options.namespace, secretName: options.secretName };

  if (options.createNamespace) {
    const existingNamespace = await kubectl(options, ["get", "namespace", options.namespace, "--ignore-not-found", "--output", "name", "--request-timeout=15s"]);
    if (!existingNamespace.trim()) await kubectl(options, ["create", "namespace", options.namespace]);
  }

  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: options.secretName, namespace: options.namespace },
    type: "Opaque",
    data: {
      [options.adminKey]: admin.toString("base64"),
      [options.realtimeKey]: realtime.toString("base64"),
    },
  };
  await kubectl(options, ["apply", "--namespace", options.namespace, "--filename", "-"], `${JSON.stringify(secret)}\n`);
  return { changed: true, dryRun: false, namespace: options.namespace, secretName: options.secretName };
}

const help = `Create or update the existing Secret used by managed Redis and the gateway.

Usage:
  realtime-redis-secret.mjs --context CONTEXT --namespace NAMESPACE \\
    --secret-name NAME --admin-password-file FILE \\
    --realtime-password-file FILE [--admin-key KEY] [--realtime-key KEY] \\
    [--create-namespace] [--dry-run] [--kubectl PATH]

Password files are read as bytes. Trailing CR/LF bytes are removed before the
Secret is submitted through stdin; password values never appear in arguments or output.
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.help) process.stdout.write(help);
    else process.stdout.write(`${JSON.stringify(await applyRedisSecret(options))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
