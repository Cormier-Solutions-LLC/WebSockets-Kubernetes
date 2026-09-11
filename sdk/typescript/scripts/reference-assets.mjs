import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { transform as transformJavaScript } from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";
import JavaScriptObfuscator from "javascript-obfuscator";
import { transform as transformCss } from "lightningcss";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function assertInside(parent, child, label) {
  const prefix = `${resolve(parent)}${sep}`;
  if (!resolve(child).startsWith(prefix)) {
    throw new Error(`${label} must remain beneath ${parent}.`);
  }
}

function digest(content, algorithm, encoding) {
  return createHash(algorithm).update(content).digest(encoding);
}

function integrity(content) {
  return `sha384-${digest(content, "sha384", "base64")}`;
}

function replaceTokenList(value, mappings) {
  return value.split(/\s+/u).map((token) => mappings[token] ?? token).join(" ");
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceSelector(value, prefix, source, target) {
  const selector = new RegExp(`${escapeRegularExpression(prefix)}${escapeRegularExpression(source)}(?![A-Za-z0-9_-])`, "gu");
  return value.replace(selector, `${prefix}${target}`);
}

export function applySelectorMappings({ css, html, javascript }, selectorMangling) {
  if (!selectorMangling.enabled) {
    if (Object.keys(selectorMangling.ids).length > 0 || Object.keys(selectorMangling.classes).length > 0) {
      throw new Error("Selector mappings require selectorMangling.enabled=true.");
    }
    return { css, html, javascript };
  }

  const safelist = new Set(selectorMangling.safelist);
  for (const [kind, mappings] of [["id", selectorMangling.ids], ["class", selectorMangling.classes]]) {
    const sources = new Set(Object.keys(mappings));
    const targets = new Set();
    for (const [source, target] of Object.entries(mappings)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(source) || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(target)) {
        throw new Error(`${kind} selector mappings must use literal CSS identifiers.`);
      }
      if (safelist.has(source) || safelist.has(target)) {
        throw new Error(`${kind} selector mapping ${source} -> ${target} intersects the safelist.`);
      }
      if (source === target || targets.has(target) || sources.has(target)) {
        throw new Error(`${kind} selector mapping ${source} -> ${target} is ambiguous.`);
      }
      targets.add(target);
    }
  }

  let mappedCss = css;
  let mappedHtml = html;
  let mappedJavaScript = javascript;
  for (const [source, target] of Object.entries(selectorMangling.ids)) {
    mappedCss = replaceSelector(mappedCss, "#", source, target);
    mappedHtml = mappedHtml
      .replace(new RegExp(`(\\bid=["'])${source}(["'])`, "gu"), `$1${target}$2`)
      .replace(new RegExp(`#${escapeRegularExpression(source)}(?![A-Za-z0-9_-])`, "gu"), `#${target}`);
    mappedJavaScript = replaceSelector(mappedJavaScript, "#", source, target);
  }
  for (const [source, target] of Object.entries(selectorMangling.classes)) {
    mappedCss = replaceSelector(mappedCss, ".", source, target);
    mappedHtml = mappedHtml.replace(/\bclass=(['"])([^'"]*)\1/gu, (match, quote, tokens) =>
      `class=${quote}${replaceTokenList(tokens, { [source]: target })}${quote}`);
    mappedJavaScript = replaceSelector(mappedJavaScript, ".", source, target);
  }
  return { css: mappedCss, html: mappedHtml, javascript: mappedJavaScript };
}

function injectReferences(html, { cssIntegrity, javascriptIntegrity, sdkIntegrity, sdkName }) {
  return html
    .replace('href="/app.css"', `href="/app.css" integrity="${cssIntegrity}" crossorigin="anonymous"`)
    .replace(
      'src="/_content/Cormier.Realtime.Browser/cormier-realtime.iife.js"',
      `src="/_content/Cormier.Realtime.Browser/${sdkName}" integrity="${sdkIntegrity}" crossorigin="anonymous"`,
    )
    .replace('src="/app.js"', `src="/app.js" integrity="${javascriptIntegrity}" crossorigin="anonymous"`);
}

function write(directory, name, content) {
  const path = resolve(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function inventoryFile(outputRoot, profile, name, content) {
  const bytes = Buffer.byteLength(content);
  return {
    path: `${profile}/${name}`,
    bytes,
    gzipBytes: gzipSync(content, { level: 9, mtime: 0 }).length,
    sha256: digest(content, "sha256", "hex"),
    integrity: integrity(content),
  };
}

async function buildProfile({ config, outputRoot, profile, source, sdkDist, obfuscate }) {
  const profileRoot = resolve(outputRoot, profile);
  let javascript;
  let javascriptMap;
  let css;
  let cssMap;

  if (profile === "readable") {
    javascript = `${source.javascript.trimEnd()}\n`;
    css = `${source.css.trimEnd()}\n`;
  } else {
    const javascriptResult = await transformJavaScript(source.javascript, {
      charset: "utf8",
      legalComments: "inline",
      minify: true,
      sourcefile: "app.js",
      sourcemap: "external",
      sourcesContent: config.sourceMaps.includeSourcesContent,
      target: "es2022",
    });
    javascript = javascriptResult.code;
    javascriptMap = javascriptResult.map;

    if (obfuscate) {
      const obfuscated = JavaScriptObfuscator.obfuscate(javascript, {
        compact: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        identifierNamesGenerator: "hexadecimal",
        renameGlobals: false,
        reservedNames: config.obfuscation.reservedNames,
        seed: config.obfuscation.seed,
        selfDefending: false,
        sourceMap: true,
        sourceMapMode: "separate",
        sourceMapSourcesMode: "sources-content",
        splitStrings: false,
        stringArray: false,
        transformObjectKeys: false,
        unicodeEscapeSequence: false,
      });
      javascript = `${obfuscated.getObfuscatedCode()}\n`;
      javascriptMap = obfuscated.getSourceMap();
    }

    const cssResult = transformCss({
      code: textEncoder.encode(source.css),
      filename: "app.css",
      minify: true,
      sourceMap: config.sourceMaps.emit,
    });
    css = textDecoder.decode(cssResult.code);
    cssMap = cssResult.map === undefined ? undefined : textDecoder.decode(cssResult.map);
  }

  const sdkName = profile === "readable" ? "cormier-realtime.iife.js" : "cormier-realtime.iife.min.js";
  const sdkContent = readFileSync(resolve(sdkDist, sdkName));
  const cssSri = integrity(css);
  const javascriptSri = integrity(javascript);
  const sdkSri = integrity(sdkContent);
  const referencedHtml = injectReferences(source.html, {
    cssIntegrity: cssSri,
    javascriptIntegrity: javascriptSri,
    sdkIntegrity: sdkSri,
    sdkName,
  });
  const html = profile === "readable" ? `${referencedHtml.trimEnd()}\n` : `${await minifyHtml(referencedHtml, {
    collapseWhitespace: true,
    conservativeCollapse: true,
    ignoreCustomComments: [/^!/u],
    keepClosingSlash: true,
    minifyCSS: false,
    minifyJS: false,
    removeComments: true,
    removeEmptyAttributes: false,
    removeOptionalTags: false,
    removeRedundantAttributes: true,
    sortAttributes: false,
    sortClassName: false,
    useShortDoctype: true,
  })}\n`;

  write(profileRoot, "app.js", javascript);
  write(profileRoot, "app.css", css);
  write(profileRoot, "index.html", html);
  if (profile !== "readable" && config.sourceMaps.emit) {
    write(profileRoot, "app.js.map", javascriptMap);
    write(profileRoot, "app.css.map", cssMap);
  }

  const files = [
    inventoryFile(outputRoot, profile, "app.css", css),
    inventoryFile(outputRoot, profile, "app.js", javascript),
    inventoryFile(outputRoot, profile, "index.html", html),
  ];
  if (profile !== "readable" && config.sourceMaps.emit) {
    files.push(inventoryFile(outputRoot, profile, "app.css.map", cssMap));
    files.push(inventoryFile(outputRoot, profile, "app.js.map", javascriptMap));
  }
  return { files, sdk: { path: sdkName, sha256: digest(sdkContent, "sha256", "hex"), integrity: sdkSri } };
}

export async function buildReferenceAssets({ sdkRoot, obfuscate = false }) {
  const repositoryRoot = resolve(sdkRoot, "..", "..");
  const configPath = resolve(sdkRoot, "asset-pipeline.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const sourceRoot = resolve(sdkRoot, config.sourceDirectory);
  const outputRoot = resolve(sdkRoot, config.outputDirectory);
  const expectedOutputRoot = resolve(repositoryRoot, "examples", "shared-web", "dist");
  if (outputRoot !== expectedOutputRoot) {
    throw new Error(`Configured outputDirectory must resolve to ${expectedOutputRoot}.`);
  }
  assertInside(repositoryRoot, outputRoot, "Asset output directory");
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  const original = {
    css: readFileSync(resolve(sourceRoot, "app.css"), "utf8"),
    html: readFileSync(resolve(sourceRoot, "index.html"), "utf8"),
    javascript: readFileSync(resolve(sourceRoot, "app.js"), "utf8"),
  };
  const source = applySelectorMappings(original, config.selectorMangling);
  const profiles = ["readable", "optimized"];
  if (obfuscate) profiles.push("obfuscated");

  const profileResults = {};
  for (const profile of profiles) {
    profileResults[profile] = await buildProfile({
      config,
      obfuscate: profile === "obfuscated",
      outputRoot,
      profile,
      sdkDist: resolve(sdkRoot, "dist"),
      source,
    });
  }

  const packageMetadata = JSON.parse(readFileSync(resolve(sdkRoot, "package.json"), "utf8"));
  const manifest = {
    schemaVersion: config.schemaVersion,
    pipelineVersion: config.pipelineVersion,
    package: packageMetadata.name,
    version: packageMetadata.version,
    defaults: config.profiles,
    obfuscationEnabled: obfuscate,
    selectorMappings: {
      ids: config.selectorMangling.ids,
      classes: config.selectorMangling.classes,
    },
    sourceMapPolicy: config.sourceMaps,
    csp: "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'",
    profiles: Object.fromEntries(profiles.map((profile) => [profile, profileResults[profile]])),
    tools: {
      esbuild: packageMetadata.devDependencies.esbuild,
      htmlMinifierTerser: packageMetadata.devDependencies["html-minifier-terser"],
      javascriptObfuscator: packageMetadata.devDependencies["javascript-obfuscator"],
      lightningcss: packageMetadata.devDependencies.lightningcss,
    },
  };
  write(outputRoot, "asset-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const sizeReport = Object.fromEntries(profiles.map((profile) => [profile, {
    bytes: profileResults[profile].files
      .filter((file) => !file.path.endsWith(".map"))
      .reduce((total, file) => total + file.bytes, 0),
    gzipBytes: profileResults[profile].files
      .filter((file) => !file.path.endsWith(".map"))
      .reduce((total, file) => total + file.gzipBytes, 0),
  }]));
  write(outputRoot, "size-report.json", `${JSON.stringify({
    schemaVersion: 1,
    budget: config.budgets,
    profiles: sizeReport,
  }, null, 2)}\n`);
}

export function isUnsafeSourcePath(source) {
  return isAbsolute(source) || /^[A-Za-z]:[\\/]/u.test(source) || source.includes("\\Users\\");
}

export function repositoryRelative(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}
