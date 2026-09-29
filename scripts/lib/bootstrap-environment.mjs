import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { assertPathInside, atomicWrite, fileExists, stableJson } from "./bootstrap-contract.mjs";

export const canonicalEnvironments = Object.freeze(["dev", "test", "prod"]);

const dotEnvironmentArtifact = /^(?:bootstrap|config|install|plan|update|validate)\.(dev|test|prod)(?:\.|$)/;
const hyphenEnvironmentArtifact = /^(?:gateway|redis)-(dev|test|prod)(?:\.|$)/;

export function expandEnvironmentPath(pathTemplate, environment) {
  if (typeof pathTemplate !== "string") throw new Error("Environment path template must be a string.");
  if (!/^[a-z0-9]{1,10}$/.test(environment)) throw new Error(`Environment '${environment}' is not a valid bootstrap environment name.`);
  const unknownTokens = [...pathTemplate.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).filter(token => token !== "environment");
  if (unknownTokens.length > 0) throw new Error(`Unsupported bootstrap path token(s): ${[...new Set(unknownTokens)].join(", ")}.`);
  return pathTemplate.replaceAll("{environment}", environment);
}

export function classifyLegacyBootstrapArtifact(name) {
  const match = dotEnvironmentArtifact.exec(name) ?? hyphenEnvironmentArtifact.exec(name);
  return match?.[1];
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function portableRelative(from, to) {
  return relative(from, to).replaceAll("\\", "/");
}

async function inventory(bootstrapRoot, environmentRoot) {
  const moves = [];
  const retained = [];
  const collisions = [];
  if (!await fileExists(bootstrapRoot)) return { moves, retained, collisions };
  for (const entry of await readdir(bootstrapRoot, { withFileTypes: true })) {
    if (!entry.isFile()) {
      retained.push({ name: entry.name, reason: "shared-or-directory" });
      continue;
    }
    const environment = classifyLegacyBootstrapArtifact(entry.name);
    if (!environment) {
      retained.push({ name: entry.name, reason: "unrecognized" });
      continue;
    }
    const source = resolve(bootstrapRoot, entry.name);
    const destination = resolve(environmentRoot, environment, entry.name);
    assertPathInside(bootstrapRoot, source, "legacy bootstrap artifact");
    assertPathInside(environmentRoot, destination, "environment bootstrap artifact");
    if (await fileExists(destination)) {
      const sourceStat = await stat(source);
      const destinationStat = await stat(destination);
      const identical = sourceStat.isFile() && destinationStat.isFile()
        && sourceStat.size === destinationStat.size
        && await sha256(source) === await sha256(destination);
      collisions.push({ source: portableRelative(bootstrapRoot, source), destination: portableRelative(bootstrapRoot, destination), identical });
    } else {
      moves.push({ environment, source: portableRelative(bootstrapRoot, source), destination: portableRelative(bootstrapRoot, destination) });
    }
  }
  return { moves, retained, collisions };
}

export async function organizeBootstrapEnvironment({ repositoryRoot, dryRun = false }) {
  const bootstrapRoot = resolve(repositoryRoot, ".bootstrap");
  const environmentRoot = resolve(bootstrapRoot, "env");
  const result = await inventory(bootstrapRoot, environmentRoot);
  if (result.collisions.length > 0 && !dryRun) {
    throw new Error(`Bootstrap environment organization found ${result.collisions.length} destination collision(s); review a dry run and resolve them before applying.`);
  }
  const timestamp = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    operation: "organize-bootstrap-environments",
    timestamp,
    dryRun,
    status: dryRun ? "preview" : "applying",
    completedMoves: [],
    environmentRoot: portableRelative(repositoryRoot, environmentRoot),
    environments: canonicalEnvironments,
    ...result,
  };
  if (dryRun) return { manifest, manifestPath: null };

  for (const environment of canonicalEnvironments) await mkdir(resolve(environmentRoot, environment), { recursive: true });
  const manifestPath = resolve(bootstrapRoot, "organization", `${timestamp.replaceAll(":", "-")}.json`);
  await atomicWrite(manifestPath, stableJson(manifest));
  try {
    for (const move of result.moves) {
      const source = resolve(bootstrapRoot, move.source);
      const destination = resolve(bootstrapRoot, move.destination);
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination);
      manifest.completedMoves.push(move);
      await atomicWrite(manifestPath, stableJson(manifest));
    }
    manifest.status = "applied";
    await atomicWrite(manifestPath, stableJson(manifest));
  } catch (error) {
    manifest.status = "incomplete";
    manifest.error = error.message;
    await atomicWrite(manifestPath, stableJson(manifest));
    throw new Error(`Bootstrap environment organization stopped after ${manifest.completedMoves.length} move(s); restore with manifest '${manifestPath}' before retrying: ${error.message}`);
  }
  return { manifest, manifestPath };
}

export async function restoreBootstrapEnvironment({ repositoryRoot, manifestPath }) {
  const bootstrapRoot = resolve(repositoryRoot, ".bootstrap");
  const absoluteManifest = resolve(repositoryRoot, manifestPath);
  assertPathInside(resolve(bootstrapRoot, "organization"), absoluteManifest, "bootstrap organization manifest");
  const manifest = JSON.parse(await readFile(absoluteManifest, "utf8"));
  if (manifest?.schemaVersion !== 1 || manifest?.operation !== "organize-bootstrap-environments" || !Array.isArray(manifest.moves)) {
    throw new Error("Bootstrap organization manifest is invalid or unsupported.");
  }
  const moves = Array.isArray(manifest.completedMoves) ? manifest.completedMoves : manifest.moves;
  for (const move of [...moves].reverse()) {
    const source = resolve(bootstrapRoot, move.destination);
    const destination = resolve(bootstrapRoot, move.source);
    assertPathInside(bootstrapRoot, source, "organized bootstrap artifact");
    assertPathInside(bootstrapRoot, destination, "restored bootstrap artifact");
    if (!await fileExists(source)) throw new Error(`Cannot restore missing organized artifact '${move.destination}'.`);
    if (await fileExists(destination)) throw new Error(`Cannot restore '${move.source}' because the destination already exists.`);
  }
  for (const move of [...moves].reverse()) {
    await rename(resolve(bootstrapRoot, move.destination), resolve(bootstrapRoot, move.source));
  }
  manifest.status = "restored";
  manifest.restoredAt = new Date().toISOString();
  await atomicWrite(absoluteManifest, stableJson(manifest));
  return { restored: moves.length, manifestPath: absoluteManifest };
}
