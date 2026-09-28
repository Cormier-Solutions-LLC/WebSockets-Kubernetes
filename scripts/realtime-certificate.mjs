#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfiguration } from "./lib/bootstrap-contract.mjs";

const dnsSubdomain = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;

export function parseCertificateArguments(arguments_) {
  const options = {
    issuerGroup: "cert-manager.io",
    issuerKind: "ClusterIssuer",
    kubectl: "kubectl",
    timeoutSeconds: 300,
  };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (["--help", "-h"].includes(argument)) return { help: true };
    if (argument === "--create-namespace") { options.createNamespace = true; continue; }
    if (argument === "--dry-run") { options.dryRun = true; continue; }
    if (!["--config", "--issuer-name", "--issuer-kind", "--issuer-group", "--timeout-seconds", "--kubectl"].includes(argument)) throw new Error(`Unknown argument '${argument}'.`);
    const value = arguments_[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  for (const key of ["config", "issuerName"]) if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required.`);
  if (!["ClusterIssuer", "Issuer"].includes(options.issuerKind)) throw new Error("--issuer-kind must be ClusterIssuer or Issuer.");
  if (!dnsSubdomain.test(options.issuerName)) throw new Error("--issuer-name must be a Kubernetes DNS subdomain.");
  if (!dnsSubdomain.test(options.issuerGroup)) throw new Error("--issuer-group must be a Kubernetes DNS subdomain.");
  options.timeoutSeconds = Number(options.timeoutSeconds);
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 60 || options.timeoutSeconds > 1800) throw new Error("--timeout-seconds must be an integer from 60 through 1800.");
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

export function buildCertificateManifest(config, options) {
  if (!config.ingress.enabled) throw new Error("The bootstrap configuration must enable ingress before a Certificate can be applied.");
  if (!config.ingress.certificateName) throw new Error("ingress.certificateName is required when using the certificate helper.");
  return {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: { name: config.ingress.certificateName, namespace: config.kubernetes.namespace },
    spec: {
      dnsNames: [config.ingress.host],
      issuerRef: { group: options.issuerGroup, kind: options.issuerKind, name: options.issuerName },
      secretName: config.ingress.tlsSecretName,
    },
  };
}

export async function applyCertificate(options) {
  const configPath = resolve(options.config);
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { throw new Error(`Cannot read JSON configuration '${configPath}': ${error.message}`); }
  const errors = validateConfiguration(config);
  if (errors.length > 0) throw new Error(`Configuration is invalid:\n${errors.map(item => `- ${item.path}: ${item.message}`).join("\n")}`);
  const manifest = buildCertificateManifest(config, options);
  const resolved = { ...options, context: config.kubernetes.context, namespace: config.kubernetes.namespace };
  if (options.dryRun) return { changed: false, dryRun: true, certificate: manifest.metadata.name, dnsName: config.ingress.host, namespace: manifest.metadata.namespace, tlsSecret: config.ingress.tlsSecretName };
  if (options.createNamespace) {
    const existingNamespace = await kubectl(resolved, ["get", "namespace", resolved.namespace, "--ignore-not-found", "--output", "name", "--request-timeout=15s"]);
    if (!existingNamespace.trim()) await kubectl(resolved, ["create", "namespace", resolved.namespace]);
  }
  const issuerArguments = ["get", options.issuerKind.toLowerCase(), options.issuerName, "--request-timeout=15s"];
  if (options.issuerKind === "Issuer") issuerArguments.push("--namespace", resolved.namespace);
  await kubectl(resolved, issuerArguments);
  await kubectl(resolved, ["apply", "--namespace", resolved.namespace, "--filename", "-"], `${JSON.stringify(manifest)}\n`);
  await kubectl(resolved, ["wait", "--namespace", resolved.namespace, "--for=condition=Ready", `certificate/${manifest.metadata.name}`, `--timeout=${options.timeoutSeconds}s`]);
  return { changed: true, dryRun: false, certificate: manifest.metadata.name, dnsName: config.ingress.host, namespace: manifest.metadata.namespace, tlsSecret: config.ingress.tlsSecretName };
}

const help = `Create or update the cert-manager Certificate referenced by the gateway.

Usage:
  realtime-certificate.mjs --config FILE --issuer-name NAME
    [--issuer-kind ClusterIssuer|Issuer] [--issuer-group cert-manager.io]
    [--create-namespace] [--timeout-seconds 300] [--dry-run] [--kubectl PATH]

The validated bootstrap configuration is the single source for Kubernetes
context, namespace, DNS name, Certificate name, and TLS Secret name. The helper
waits for Ready=True so the gateway bootstrap never races a missing TLS Secret.
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCertificateArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(help);
    else process.stdout.write(`${JSON.stringify(await applyCertificate(options))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
