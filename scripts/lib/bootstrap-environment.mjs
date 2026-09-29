import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

import { assertPathInside, atomicWrite, fileExists, isValidEnvironmentName, stableJson } from "./bootstrap-contract.mjs";

export const canonicalEnvironments = Object.freeze(["dev", "test", "prod"]);

const dotEnvironmentArtifact = /^(?:bootstrap|config|install|plan|update|validate)\.([a-z0-9]{1,10})(?:\.|$)/;
const hyphenEnvironmentArtifact = /^(?:gateway|redis)-([a-z0-9]{1,10})(?:\.|$)/;

export function expandEnvironmentPath(pathTemplate, environment) {
  if (typeof pathTemplate !== "string") throw new Error("Environment path template must be a string.");
  if (!isValidEnvironmentName(environment)) throw new Error(`Environment '${environment}' is not a valid bootstrap environment name.`);
  const unknownTokens = [...pathTemplate.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).filter(token => token !== "environment");
  if (unknownTokens.length > 0) throw new Error(`Unsupported bootstrap path token(s): ${[...new Set(unknownTokens)].join(", ")}.`);
  return pathTemplate.replaceAll("{environment}", environment);
}

export function classifyLegacyBootstrapArtifact(name) {
  const match = dotEnvironmentArtifact.exec(name) ?? hyphenEnvironmentArtifact.exec(name);
  return isValidEnvironmentName(match?.[1]) ? match[1] : undefined;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function acquireOrganizationLock(bootstrapRoot) {
  const locksRoot = resolve(bootstrapRoot, "locks");
  const lockPath = resolve(locksRoot, "environment-organization");
  const ownerPath = resolve(lockPath, "owner.json");
  const owner = { createdAt: new Date().toISOString(), hostname: hostname(), pid: process.pid, token: randomUUID() };
  await assertNoSymlinkSegments(bootstrapRoot, locksRoot, true, "Bootstrap locks root");
  await mkdir(locksRoot, { recursive: true });
  try {
    await mkdir(lockPath);
    await atomicWrite(ownerPath, stableJson(owner));
    return { lockPath, token: owner.token };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let stale = false;
  try {
    const existing = JSON.parse(await readFile(ownerPath, "utf8"));
    const age = Date.now() - Date.parse(existing.createdAt);
    stale = existing.hostname === hostname() ? !processExists(existing.pid) : Number.isFinite(age) && age > 2 * 60 * 60 * 1000;
  } catch {
    stale = Date.now() - (await stat(lockPath)).mtimeMs > 2 * 60 * 60 * 1000;
  }
  if (!stale) throw new Error(`Another bootstrap environment operation holds the organization lock '${lockPath}'.`);
  const stalePath = `${lockPath}.stale-${owner.token}`;
  try { await rename(lockPath, stalePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  try {
    await mkdir(lockPath);
    await atomicWrite(ownerPath, stableJson(owner));
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another bootstrap environment operation holds the organization lock '${lockPath}'.`);
    throw error;
  } finally {
    await rm(stalePath, { recursive: true, force: true });
  }
  return { lockPath, token: owner.token };
}

async function releaseOrganizationLock(lockPath, token) {
  try {
    const owner = JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8"));
    if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function assertNoSymlinkSegments(root, target, includeTarget, label) {
  const segments = relative(root, target).split(sep).filter(Boolean);
  const count = includeTarget ? segments.length : Math.max(0, segments.length - 1);
  let current = root;
  for (const segment of segments.slice(0, count)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`${label} cannot traverse symbolic link '${current}'.`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
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
    await assertNoSymlinkSegments(bootstrapRoot, destination, false, "Environment bootstrap artifact");
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

async function organizeBootstrapEnvironmentLocked({ repositoryRoot, dryRun, bootstrapRoot }) {
  const environmentRoot = resolve(bootstrapRoot, "env");
  await assertNoSymlinkSegments(bootstrapRoot, environmentRoot, true, "Bootstrap environment root");
  const result = await inventory(bootstrapRoot, environmentRoot);
  if (result.collisions.length > 0 && !dryRun) {
    throw new Error(`Bootstrap environment organization found ${result.collisions.length} destination collision(s); review a dry run and resolve them before applying.`);
  }
  const timestamp = new Date().toISOString();
  const discoveredEnvironments = [...new Set(result.moves.map(move => move.environment))]
    .filter(environment => !canonicalEnvironments.includes(environment))
    .sort();
  const manifest = {
    schemaVersion: 1,
    operation: "organize-bootstrap-environments",
    timestamp,
    dryRun,
    status: dryRun ? "preview" : "applying",
    completedMoves: [],
    environmentRoot: portableRelative(repositoryRoot, environmentRoot),
    environments: [...canonicalEnvironments, ...discoveredEnvironments],
    ...result,
  };
  if (dryRun) return { manifest, manifestPath: null };

  for (const environment of manifest.environments) await mkdir(resolve(environmentRoot, environment), { recursive: true });
  const manifestPath = resolve(bootstrapRoot, "organization", `${timestamp.replaceAll(":", "-")}.json`);
  await atomicWrite(manifestPath, stableJson(manifest));
  try {
    for (const move of result.moves) {
      const source = resolve(bootstrapRoot, move.source);
      const destination = resolve(bootstrapRoot, move.destination);
      await assertNoSymlinkSegments(bootstrapRoot, destination, false, "Environment bootstrap artifact");
      await mkdir(dirname(destination), { recursive: true });
      await assertNoSymlinkSegments(bootstrapRoot, destination, false, "Environment bootstrap artifact");
      manifest.currentMove = move;
      await atomicWrite(manifestPath, stableJson(manifest));
      await rename(source, destination);
      manifest.completedMoves.push(move);
      delete manifest.currentMove;
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

export async function organizeBootstrapEnvironment({ repositoryRoot, dryRun = false }) {
  const bootstrapRoot = resolve(repositoryRoot, ".bootstrap");
  await assertNoSymlinkSegments(repositoryRoot, bootstrapRoot, true, "Bootstrap root");
  const lock = dryRun ? undefined : await acquireOrganizationLock(bootstrapRoot);
  try {
    return await organizeBootstrapEnvironmentLocked({ repositoryRoot, dryRun, bootstrapRoot });
  } finally {
    if (lock) await releaseOrganizationLock(lock.lockPath, lock.token);
  }
}

async function restoreBootstrapEnvironmentLocked({ repositoryRoot, manifestPath, dryRun, bootstrapRoot }) {
  const absoluteManifest = resolve(repositoryRoot, manifestPath);
  assertPathInside(resolve(bootstrapRoot, "organization"), absoluteManifest, "bootstrap organization manifest");
  const manifest = JSON.parse(await readFile(absoluteManifest, "utf8"));
  if (manifest?.schemaVersion !== 1 || manifest?.operation !== "organize-bootstrap-environments" || !Array.isArray(manifest.moves)) {
    throw new Error("Bootstrap organization manifest is invalid or unsupported.");
  }
  if (manifest.status === "restored") throw new Error("Bootstrap organization manifest has already been restored.");
  const moves = Array.isArray(manifest.completedMoves) ? [...manifest.completedMoves] : [...manifest.moves];
  if (manifest.currentMove && !moves.some(move => move.source === manifest.currentMove.source && move.destination === manifest.currentMove.destination)) {
    moves.push(manifest.currentMove);
  }
  const movesToRestore = [];
  for (const move of [...moves].reverse()) {
    const source = resolve(bootstrapRoot, move.destination);
    const destination = resolve(bootstrapRoot, move.source);
    assertPathInside(bootstrapRoot, source, "organized bootstrap artifact");
    assertPathInside(bootstrapRoot, destination, "restored bootstrap artifact");
    await assertNoSymlinkSegments(bootstrapRoot, source, false, "Organized bootstrap artifact");
    await assertNoSymlinkSegments(bootstrapRoot, destination, false, "Restored bootstrap artifact");
    const sourceExists = await fileExists(source);
    const destinationExists = await fileExists(destination);
    if (sourceExists && destinationExists) throw new Error(`Cannot restore '${move.source}' because the destination already exists.`);
    if (!sourceExists && !destinationExists) throw new Error(`Cannot restore missing organized artifact '${move.destination}'.`);
    if (sourceExists) movesToRestore.push(move);
  }
  if (dryRun) return { restored: 0, planned: movesToRestore.length, manifestPath: absoluteManifest, dryRun: true };
  for (const move of movesToRestore) {
    await rename(resolve(bootstrapRoot, move.destination), resolve(bootstrapRoot, move.source));
  }
  delete manifest.currentMove;
  manifest.status = "restored";
  manifest.restoredAt = new Date().toISOString();
  await atomicWrite(absoluteManifest, stableJson(manifest));
  return { restored: movesToRestore.length, planned: movesToRestore.length, manifestPath: absoluteManifest, dryRun: false };
}

export async function restoreBootstrapEnvironment({ repositoryRoot, manifestPath, dryRun = false }) {
  const bootstrapRoot = resolve(repositoryRoot, ".bootstrap");
  await assertNoSymlinkSegments(repositoryRoot, bootstrapRoot, true, "Bootstrap root");
  const lock = dryRun ? undefined : await acquireOrganizationLock(bootstrapRoot);
  try {
    return await restoreBootstrapEnvironmentLocked({ repositoryRoot, manifestPath, dryRun, bootstrapRoot });
  } finally {
    if (lock) await releaseOrganizationLock(lock.lockPath, lock.token);
  }
}
