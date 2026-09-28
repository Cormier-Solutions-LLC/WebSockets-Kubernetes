#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfiguration } from "./lib/bootstrap-contract.mjs";

const dnsLabel = /^(?=.{1,63}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const dnsSubdomain = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
const secretKey = /^[A-Za-z0-9._-]+$/;

export function normalizePasswordBytes(input, label = "password") {
  const bytes = Buffer.from(input);
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 10 || bytes[end - 1] === 13)) end--;
  const normalized = bytes.subarray(0, end);
  if (normalized.length < 16) throw new Error(`${label} must contain at least 16 bytes after trailing CR/LF removal.`);
  if (normalized.toString("utf8").trim().length === 0) throw new Error(`${label} must not contain only whitespace.`);
  if (normalized.includes(0)) throw new Error(`${label} must not contain NUL bytes because Kubernetes environment variables cannot represent them.`);
  if (normalized.includes(10) || normalized.includes(13)) throw new Error(`${label} must not contain embedded CR or LF bytes.`);
  return Buffer.from(normalized);
}

function parse(arguments_) {
  const result = { kubectl: "kubectl" };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--create-namespace") { result.createNamespace = true; continue; }
    if (argument === "--dry-run") { result.dryRun = true; continue; }
    if (!["--config", "--context", "--namespace", "--secret-name", "--admin-password-file", "--realtime-password-file", "--admin-key", "--realtime-key", "--kubectl"].includes(argument)) throw new Error(`Unknown argument '${argument}'.`);
    const value = arguments_[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    result[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  for (const key of ["adminPasswordFile", "realtimePasswordFile"]) if (!result[key]) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required.`);
  if (result.config && ["context", "namespace", "secretName", "adminKey", "realtimeKey"].some(key => result[key] !== undefined)) throw new Error("--config cannot be combined with explicit context, namespace, Secret name, or key options.");
  if (!result.config) {
    for (const key of ["context", "namespace", "secretName"]) if (!result[key]) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required when --config is not used.`);
    result.adminKey ??= "redis-password";
    result.realtimeKey ??= "realtime";
  }
  return result;
}

export async function resolveRedisSecretOptions(options) {
  if (!options.config) return options;
  const configPath = resolve(options.config);
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { throw new Error(`Cannot read JSON configuration '${configPath}': ${error.message}`); }
  const errors = validateConfiguration(config);
  if (errors.length > 0) throw new Error(`Configuration is invalid:\n${errors.map(item => `- ${item.path}: ${item.message}`).join("\n")}`);
  if (config.redis.mode !== "managed") throw new Error("--config must select managed Redis before a managed Redis Secret can be applied.");
  return {
    ...options,
    context: config.kubernetes.context,
    namespace: config.kubernetes.namespace,
    secretName: config.redis.credentialsSecret,
    adminKey: config.redis.adminCredentialKey,
    realtimeKey: config.redis.credentialKey,
  };
}

function validateOptions(options) {
  if (!dnsLabel.test(options.namespace)) throw new Error("--namespace must be a Kubernetes DNS label.");
  if (!dnsSubdomain.test(options.secretName)) throw new Error("--secret-name must be a Kubernetes DNS subdomain.");
  if (!secretKey.test(options.adminKey) || !secretKey.test(options.realtimeKey)) throw new Error("Secret keys must use Kubernetes Secret key syntax.");
  if (options.adminKey === options.realtimeKey) throw new Error("Administrator and realtime Secret keys must be distinct.");
  return options;
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
  realtime-redis-secret.mjs --config FILE --admin-password-file FILE \\
    --realtime-password-file FILE [--create-namespace] [--dry-run]

  or, with an explicit target:
  realtime-redis-secret.mjs --context CONTEXT --namespace NAMESPACE \\
    --secret-name NAME --admin-password-file FILE \\
    --realtime-password-file FILE [--admin-key KEY] [--realtime-key KEY] \\
    [--create-namespace] [--dry-run] [--kubectl PATH]

Configuration mode derives the context, namespace, Secret name, administrator
key, and restricted ACL key from the validated bootstrap configuration. Password
files are read as bytes. Trailing CR/LF bytes are removed and whitespace-only,
embedded-line-ending, NUL, duplicate-key, and identical-password inputs are
rejected before the Secret is submitted through stdin. Password values never
appear in arguments or output.
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let options = parse(process.argv.slice(2));
    if (options.help) process.stdout.write(help);
    else {
      options = validateOptions(await resolveRedisSecretOptions(options));
      process.stdout.write(`${JSON.stringify(await applyRedisSecret(options))}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
