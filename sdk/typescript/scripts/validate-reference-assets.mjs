import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(sdkRoot, "..", "..");
const outputRoot = resolve(repositoryRoot, "examples", "shared-web", "dist");
const config = JSON.parse(readFileSync(resolve(sdkRoot, "asset-pipeline.config.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(outputRoot, "asset-manifest.json"), "utf8"));
const sizeReport = JSON.parse(readFileSync(resolve(outputRoot, "size-report.json"), "utf8"));

function digest(content, algorithm, encoding) {
  return createHash(algorithm).update(content).digest(encoding);
}

function expectedIntegrity(content) {
  return `sha384-${digest(content, "sha384", "base64")}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const requiredProfile of ["readable", "optimized"]) {
  assert(manifest.profiles[requiredProfile] !== undefined, `Missing ${requiredProfile} asset profile.`);
}
assert(manifest.defaults.development === "readable" && manifest.defaults.support === "readable",
  "Development and support must default to readable assets.");
assert(manifest.defaults.production === "optimized", "Production must default to optimized assets.");
assert(manifest.obfuscationEnabled === (manifest.profiles.obfuscated !== undefined),
  "Obfuscation metadata and emitted profiles disagree.");

for (const [profile, result] of Object.entries(manifest.profiles)) {
  for (const file of result.files) {
    const path = resolve(outputRoot, file.path);
    const outputRelativePath = relative(outputRoot, path);
    assert(outputRelativePath !== "" && !outputRelativePath.startsWith("..") && !isAbsolute(outputRelativePath),
      `${file.path} escapes the output root.`);
    assert(statSync(path).size > 0, `${file.path} is empty.`);
    const content = readFileSync(path);
    assert(file.bytes === content.length, `${file.path} byte count does not match the manifest.`);
    assert(file.gzipBytes === gzipSync(content, { level: 9, mtime: 0 }).length,
      `${file.path} gzip size does not match the manifest.`);
    assert(file.sha256 === digest(content, "sha256", "hex"), `${file.path} SHA-256 does not match the manifest.`);
    assert(file.integrity === expectedIntegrity(content), `${file.path} SRI does not match the manifest.`);
  }

  const html = readFileSync(resolve(outputRoot, profile, "index.html"), "utf8");
  const css = readFileSync(resolve(outputRoot, profile, "app.css"), "utf8");
  const javascript = readFileSync(resolve(outputRoot, profile, "app.js"), "utf8");
  for (const content of [html, css, javascript]) {
    assert(content.includes(config.legalNotice), `${profile} output lost the required legal notice.`);
  }
  for (const id of config.selectorMangling.safelist) {
    assert(html.includes(`id="${id}"`), `${profile} HTML lost safelisted id ${id}.`);
    assert(javascript.includes(`#${id}`), `${profile} JavaScript lost safelisted selector #${id}.`);
  }
  for (const requiredText of ["Cormier.Realtime full circle", "Events and diagnostics", "Log in", "Log out"]) {
    assert(html.includes(requiredText), `${profile} HTML lost accessible text: ${requiredText}.`);
  }
  assert(html.includes('aria-live="polite"'), `${profile} HTML lost its live-region semantics.`);

  const cssFile = result.files.find((file) => file.path.endsWith("/app.css"));
  const javascriptFile = result.files.find((file) => file.path.endsWith("/app.js"));
  assert(html.includes(`href="/app.css" integrity="${cssFile.integrity}"`), `${profile} CSS SRI reference is invalid.`);
  assert(html.includes(`src="/app.js" integrity="${javascriptFile.integrity}"`), `${profile} JavaScript SRI reference is invalid.`);
  assert(html.includes(`integrity="${result.sdk.integrity}"`), `${profile} SDK SRI reference is invalid.`);
}

const readableSize = sizeReport.profiles.readable;
const optimizedSize = sizeReport.profiles.optimized;
assert(optimizedSize.bytes < readableSize.bytes, "Optimized assets must be smaller than readable assets.");
assert(optimizedSize.gzipBytes < readableSize.gzipBytes, "Optimized gzip assets must be smaller than readable assets.");
assert(optimizedSize.bytes <= config.budgets.optimizedBytes, "Optimized assets exceed the byte budget.");
assert(optimizedSize.gzipBytes <= config.budgets.optimizedGzipBytes, "Optimized assets exceed the gzip budget.");

for (const profile of Object.keys(manifest.profiles).filter((name) => name !== "readable")) {
  for (const name of ["app.css.map", "app.js.map"]) {
    assert(!existsSync(resolve(outputRoot, profile, name)), `${profile}/${name} must not be placed in a served profile.`);
    const sourceMap = JSON.parse(readFileSync(resolve(outputRoot, "source-maps", profile, name), "utf8"));
    for (const [index, source] of (sourceMap.sources ?? []).entries()) {
      assert(!isAbsolute(source) && !/^[A-Za-z]:[\\/]/u.test(source) && !source.includes("\\Users\\"),
        `${profile}/${name} contains a source-machine path.`);
      const embedded = typeof sourceMap.sourcesContent?.[index] === "string";
      const resolvedSource = resolve(outputRoot, "source-maps", profile, sourceMap.sourceRoot ?? "", source);
      assert(embedded || existsSync(resolvedSource), `${profile}/${name} source ${source} is neither embedded nor resolvable.`);
    }
  }
}

const generatedText = Object.keys(manifest.profiles).flatMap((profile) => ["index.html", "app.css", "app.js"]
  .map((name) => readFileSync(resolve(outputRoot, profile, name), "utf8"))).join("\n");
for (const forbidden of ["Authorization:", "BEGIN PRIVATE KEY", "cormier_session=", repositoryRoot]) {
  assert(!generatedText.includes(forbidden), `Generated reference assets contain forbidden material: ${forbidden}`);
}
