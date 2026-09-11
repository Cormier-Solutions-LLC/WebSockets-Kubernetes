import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const expected = [
  "cormier-realtime.js",
  "cormier-realtime.js.map",
  "cormier-realtime.min.js",
  "cormier-realtime.min.js.map",
  "cormier-realtime.iife.js",
  "cormier-realtime.iife.js.map",
  "cormier-realtime.iife.min.js",
  "cormier-realtime.iife.min.js.map",
  "types/index.d.ts",
  "types/index.d.ts.map",
  "version.json",
];

for (const name of expected) {
  const path = resolve(dist, name);
  if (statSync(path).size === 0) {
    throw new Error(`${name} is empty.`);
  }
}

const packageMetadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const versionMetadata = JSON.parse(readFileSync(resolve(dist, "version.json"), "utf8"));
const library = await import(`${pathToFileURL(resolve(dist, "cormier-realtime.js")).href}?validation=${Date.now()}`);
if (versionMetadata.package !== packageMetadata.name
  || versionMetadata.version !== packageMetadata.version
  || versionMetadata.version !== library.SDK_VERSION
  || versionMetadata.protocolVersion !== library.PROTOCOL_VERSION
  || versionMetadata.subprotocol !== library.WEBSOCKET_SUBPROTOCOL) {
  throw new Error("Package, SDK, protocol, subprotocol, and generated version metadata must remain aligned.");
}

for (const name of ["cormier-realtime.min.js", "cormier-realtime.iife.min.js"]) {
  const content = readFileSync(resolve(dist, name));
  if (content.length > 32 * 1024) {
    throw new Error(`${name} exceeds the 32 KiB minified size budget.`);
  }
  if (gzipSync(content, { level: 9, mtime: 0 }).length > 12 * 1024) {
    throw new Error(`${name} exceeds the 12 KiB gzip size budget.`);
  }
}

for (const name of expected.filter((entry) => entry.endsWith(".map"))) {
  const map = JSON.parse(readFileSync(resolve(dist, name), "utf8"));
  for (const source of map.sources ?? []) {
    if (isAbsolute(source) || /^[A-Za-z]:[\\/]/u.test(source) || source.includes("\\Users\\")) {
      throw new Error(`${name} contains an absolute source-machine path.`);
    }
  }
}

const generatedText = expected
  .filter((name) => !name.endsWith(".map"))
  .map((name) => readFileSync(resolve(dist, name), "utf8"))
  .join("\n");
for (const forbidden of ["REDIS_TEST_ENDPOINT", "cormier_session=", "Authorization:", "BEGIN PRIVATE KEY"]) {
  if (generatedText.includes(forbidden)) {
    throw new Error(`Generated artifacts contain forbidden material: ${forbidden}`);
  }
}

execFileSync(process.execPath, [resolve(root, "scripts/validate-reference-assets.mjs")], { cwd: root, stdio: "inherit" });
