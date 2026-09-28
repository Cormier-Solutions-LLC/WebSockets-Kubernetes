#!/usr/bin/env node
import { prepareManagedRedisChart } from "./lib/managed-redis-chart.mjs";

function parse(arguments_) {
  const result = { helm: "helm" };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (!["--chart", "--version", "--archive-sha256", "--output", "--helm"].includes(argument)) throw new Error(`Unknown argument '${argument}'.`);
    const value = arguments_[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    result[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  for (const key of ["chart", "version", "archiveSha256", "output"]) if (!result[key]) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required.`);
  return result;
}
const help = `Prepare the reviewed managed-Redis Helm chart locally.

Usage:
  prepare-managed-redis-chart.mjs --chart OCI --version VERSION \\
    --archive-sha256 sha256:HEX --output DIRECTORY [--helm PATH]

The command verifies the downloaded chart archive, unpacks it, and patches the
Sentinel Service to publish not-ready endpoints during ordered bootstrap.
`;

try {
  const options = parse(process.argv.slice(2));
  if (options.help) process.stdout.write(help);
  else {
    const result = await prepareManagedRedisChart({ ...options, outputDirectory: options.output });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
