import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function snapshot(directory) {
  const entries = [];
  function walk(current) {
    for (const name of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(current, name.name);
      if (name.isDirectory()) {
        walk(path);
      } else {
        entries.push(`${relative(directory, path).replaceAll("\\", "/")}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
  }
  walk(directory);
  return entries.join("\n");
}

function artifactSnapshot() {
  return [
    `sdk\n${snapshot(resolve(root, "dist"))}`,
    `reference\n${snapshot(resolve(root, "..", "..", "examples", "shared-web", "dist"))}`,
  ].join("\n");
}

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error("npm_execpath is required; invoke this verifier through npm run build:check.");
}
execFileSync(process.execPath, [npmCli, "run", "build", "--silent"], { cwd: root, stdio: "inherit" });
const first = artifactSnapshot();
execFileSync(process.execPath, [npmCli, "run", "build", "--silent"], { cwd: root, stdio: "inherit" });
const second = artifactSnapshot();
if (first !== second) {
  throw new Error("Browser artifacts are not reproducible.");
}
execFileSync(process.execPath, [npmCli, "run", "build:obfuscated", "--silent"], { cwd: root, stdio: "inherit" });
const firstObfuscated = artifactSnapshot();
execFileSync(process.execPath, [npmCli, "run", "build:obfuscated", "--silent"], { cwd: root, stdio: "inherit" });
const secondObfuscated = artifactSnapshot();
if (firstObfuscated !== secondObfuscated) {
  throw new Error("Obfuscated browser artifacts are not reproducible.");
}
execFileSync(process.execPath, [npmCli, "run", "build", "--silent"], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, [resolve(root, "scripts/validate-artifacts.mjs")], { cwd: root, stdio: "inherit" });
