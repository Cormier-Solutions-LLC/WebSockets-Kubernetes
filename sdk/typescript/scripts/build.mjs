import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReferenceAssets } from "./reference-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

execFileSync(process.execPath, [
  resolve(root, "node_modules/typescript/bin/tsc"),
  "--project",
  resolve(root, "tsconfig.json"),
  "--emitDeclarationOnly",
], { cwd: root, stdio: "inherit" });

const shared = {
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  legalComments: "none",
  sourcemap: true,
  sourcesContent: true,
  target: ["es2022"],
  charset: "utf8",
  logLevel: "warning",
};

await Promise.all([
  build({ ...shared, format: "esm", outfile: resolve(dist, "cormier-realtime.js") }),
  build({ ...shared, format: "esm", minify: true, outfile: resolve(dist, "cormier-realtime.min.js") }),
  build({ ...shared, format: "iife", globalName: "CormierRealtime", outfile: resolve(dist, "cormier-realtime.iife.js") }),
  build({ ...shared, format: "iife", globalName: "CormierRealtime", minify: true, outfile: resolve(dist, "cormier-realtime.iife.min.js") }),
]);

const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--obfuscate");
if (unexpectedArguments.length > 0) {
  throw new Error(`Unsupported build arguments: ${unexpectedArguments.join(", ")}`);
}
await buildReferenceAssets({ sdkRoot: root, obfuscate: process.argv.includes("--obfuscate") });

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
writeFileSync(resolve(dist, "version.json"), `${JSON.stringify({
  package: packageJson.name,
  version: packageJson.version,
  protocolVersion: "1.0",
  subprotocol: "cormier.realtime.v1",
}, null, 2)}\n`, "utf8");
