import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { applySelectorMappings } from "../scripts/reference-assets.mjs";

const root = resolve(import.meta.dirname, "..");
const assetConfig = JSON.parse(await readFile(resolve(root, "asset-pipeline.config.json"), "utf8"));

test("the coordinated asset manifest retains readable and optimized profiles", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "../../examples/shared-web/dist/asset-manifest.json"), "utf8"));
  assert.equal(manifest.pipelineVersion, "1.1.0");
  assert.deepEqual(Object.keys(manifest.profiles), ["readable", "optimized"]);
  assert.equal(manifest.defaults.development, "readable");
  assert.equal(manifest.defaults.production, "optimized");
  assert.equal(manifest.obfuscationEnabled, false);
  assert.match(manifest.profiles.optimized.sdk.path, /\.min\.js$/u);
  assert(manifest.profiles.optimized.files.some((file) => file.path === "source-maps/optimized/app.js.map"));
  assert(!manifest.profiles.optimized.files.some((file) => file.path === "optimized/app.js.map"));
});

test("relocated source maps resolve their canonical sources", async () => {
  const mapRoot = resolve(root, "../../examples/shared-web/dist/source-maps/optimized");
  for (const name of ["app.css.map", "app.js.map"]) {
    const sourceMap = JSON.parse(await readFile(resolve(mapRoot, name), "utf8"));
    if (assetConfig.selectorMangling.enabled) {
      assert.equal(sourceMap.sourceRoot, undefined);
      assert.deepEqual(sourceMap.sources, [name.startsWith("app.css") ? "app.mangled.css" : "app.mangled.js"]);
    } else {
      assert.equal(sourceMap.sourceRoot, "../../../wwwroot/");
      assert.deepEqual(sourceMap.sources, [name.replace(/\.map$/u, "")]);
    }
    await access(resolve(mapRoot, sourceMap.sourceRoot ?? "", sourceMap.sources[0]));
  }
});

test("selector mappings rewrite CSS, HTML, and JavaScript together", () => {
  const result = applySelectorMappings({
    css: ".internal #private { color: red }",
    html: '<div class="public internal" id="private"></div>',
    javascript: 'document.querySelector("#private .internal")',
  }, {
    enabled: true,
    ids: { private: "a" },
    classes: { internal: "b" },
    safelist: ["public"],
  });
  assert.equal(result.css, ".b #a { color: red }");
  assert.equal(result.html, '<div class="public b" id="a"></div>');
  assert.equal(result.javascript, 'document.querySelector("#a .b")');
});

test("selector mappings reject safelisted automation and accessibility hooks", () => {
  assert.throws(() => applySelectorMappings({ css: "#events{}", html: '<pre id="events">', javascript: '"#events"' }, {
    enabled: true,
    ids: { events: "a" },
    classes: {},
    safelist: ["events"],
  }), /safelist/u);
});

test("selector mappings reject collisions and mapping chains", () => {
  const source = { css: "", html: "", javascript: "" };
  assert.throws(() => applySelectorMappings(source, {
    enabled: true,
    ids: { first: "a", second: "a" },
    classes: {},
    safelist: [],
  }), /ambiguous/u);
  assert.throws(() => applySelectorMappings(source, {
    enabled: true,
    ids: { first: "second", second: "a" },
    classes: {},
    safelist: [],
  }), /ambiguous/u);
});

test("selector mappings preserve identifiers that only share a prefix", () => {
  const result = applySelectorMappings({
    css: ".internal .internal-panel #private #private-value {}",
    html: '<div class="internal internal-panel" id="private-value"><a href="#private">link</a></div>',
    javascript: 'document.querySelector("#private .internal"); document.querySelector("#private-value .internal-panel")',
  }, {
    enabled: true,
    ids: { private: "a" },
    classes: { internal: "b" },
    safelist: [],
  });
  assert.equal(result.css, ".b .internal-panel #a #private-value {}");
  assert.equal(result.html, '<div class="b internal-panel" id="private-value"><a href="#a">link</a></div>');
  assert.equal(result.javascript, 'document.querySelector("#a .b"); document.querySelector("#private-value .internal-panel")');
});

test("class mappings change selector APIs without rewriting JavaScript properties", () => {
  const result = applySelectorMappings({
    css: ".log {}",
    html: '<div class="log"></div>',
    javascript: 'console.log("message"); node.classList.add("log"); document.querySelector(".log")',
  }, {
    enabled: true,
    ids: {},
    classes: { log: "a" },
    safelist: [],
  });
  assert.equal(result.javascript, 'console.log("message"); node.classList.add("a"); document.querySelector(".a")');
});

test("selector mappings rewrite static template-literal selector arguments", () => {
  const result = applySelectorMappings({
    css: ".internal #private {}",
    html: '<div class="internal" id="private"></div>',
    javascript: "document.querySelector(`#private .internal`); node.classList.add(`internal`)",
  }, {
    enabled: true,
    ids: { private: "a" },
    classes: { internal: "b" },
    safelist: [],
  });
  assert.equal(result.javascript, 'document.querySelector(`#a .b`); node.classList.add(`b`)');
});

test("selector mappings rewrite interpolated selector templates", () => {
  const result = applySelectorMappings({
    css: "#private {}",
    html: '<div id="private"></div>',
    javascript: 'document.querySelector(`#private[data-key="${key}"]`)',
  }, {
    enabled: true,
    ids: { private: "a" },
    classes: {},
    safelist: [],
  });
  assert.equal(result.javascript, 'document.querySelector(`#a[data-key="${key}"]`)');
});

test("selector mappings do not mangle across interpolation boundaries", () => {
  const result = applySelectorMappings({
    css: ".internal .internal-panel {}", html: '<div class="internal internal-panel"></div>',
    javascript: "document.querySelector(`.internal${suffix}`)",
  }, { enabled: true, ids: {}, classes: { internal: "b" }, safelist: [] });
  assert.equal(result.javascript, "document.querySelector(`.internal${suffix}`)");
});

test("selector interpolation boundary guards cannot collide with mappings", () => {
  const result = applySelectorMappings({
    css: ".A {}", html: '<div class="A"></div>', javascript: "document.querySelector(`.${name}`)",
  }, { enabled: true, ids: {}, classes: { A: "wide" }, safelist: [] });
  assert.equal(result.javascript, "document.querySelector(`.${name}`)");
});

test("selector mappings guard quasis after interpolations", () => {
  const result = applySelectorMappings({
    css: "#private {}", html: '<div id="private"></div>', javascript: "document.getElementById(`${prefix}private`)",
  }, { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, "document.getElementById(`${prefix}private`)");
});

test("selector mappings preserve nested rewrites inside template expressions", () => {
  const result = applySelectorMappings({
    css: ".internal #private {}", html: '<div class="internal" id="private"></div>',
    javascript: 'document.querySelector(`#private ${document.querySelector(".internal").id}`)',
  }, { enabled: true, ids: { private: "a" }, classes: { internal: "b" }, safelist: [] });
  assert.equal(result.javascript, 'document.querySelector(`#a ${document.querySelector(".b").id}`)');
});

test("selector mappings rewrite interpolated selectors stored in constants", () => {
  const result = applySelectorMappings({
    css: "#private {}", html: '<div id="private"></div>',
    javascript: 'const target = `#private[data-key="${key}"]`; document.querySelector(target)',
  }, { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'const target = `#a[data-key="${key}"]`; document.querySelector(target)');
});

test("selector mappings rewrite statically bound selector arguments", () => {
  const result = applySelectorMappings({
    css: ".internal #private {}",
    html: '<div class="internal" id="private"></div>',
    javascript: 'const target = "#private .internal"; document.querySelector(target)',
  }, {
    enabled: true,
    ids: { private: "a" },
    classes: { internal: "b" },
    safelist: [],
  });
  assert.equal(result.javascript, 'const target = "#a .b"; document.querySelector(target)');
});

test("selector mappings reject ambiguous static selector bindings", () => {
  assert.throws(() => applySelectorMappings({
    css: "#private {}",
    html: '<div id="private"></div>',
    javascript: 'const target = "#private"; { const target = "#public"; document.querySelector(target) }',
  }, {
    enabled: true,
    ids: { private: "a" },
    classes: {},
    safelist: [],
  }), /must not be shadowed/u);
});

test("selector mappings reject static bindings shared by incompatible APIs", () => {
  assert.throws(() => applySelectorMappings({
    css: ".private #private {}",
    html: '<div class="private" id="private"></div>',
    javascript: 'const target = "private"; document.getElementById(target); node.classList.add(target)',
  }, {
    enabled: true,
    ids: { private: "a" },
    classes: { private: "b" },
    safelist: [],
  }), /incompatible selector APIs/u);
});

test("selector mappings reject static bindings with non-selector uses", () => {
  assert.throws(() => applySelectorMappings({
    css: "#private {}", html: '<div id="private"></div>',
    javascript: 'const name = "private"; document.getElementById(name); fetch("/api/" + name)',
  }, { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /unsupported or conflicting uses/u);
});

test("selector mappings permit repeated compatible static binding uses", () => {
  const result = applySelectorMappings({
    css: "#private {}", html: '<div id="private"></div>',
    javascript: 'const target = "#private"; document.querySelector(target); document.querySelectorAll(target)',
  }, { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'const target = "#a"; document.querySelector(target); document.querySelectorAll(target)');
});

test("selector mappings permit repeated unaffected static binding uses", () => {
  const result = applySelectorMappings({
    css: "#private {}", html: '<div id="private"></div>',
    javascript: 'const target = "#public"; document.querySelector(target); document.querySelectorAll(target)',
  }, { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'const target = "#public"; document.querySelector(target); document.querySelectorAll(target)');
});

test("selector mappings rewrite bounded concatenation pieces", () => {
  const result = applySelectorMappings({
    css: "#private {}", html: '<div id="private"></div>',
    javascript: 'document.querySelector("#private [data-key=\'" + key + "\']")',
  }, { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'document.querySelector("#a [data-key=\'" + key + "\']")');
});

test("selector mappings ignore inherited mapping properties", () => {
  const result = applySelectorMappings({ css: "", html: "", javascript: 'document.getElementsByClassName("constructor")' },
    { enabled: true, ids: {}, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'document.getElementsByClassName("constructor")');
});

test("selector mappings parse classic scripts", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'var await = 1; document.querySelector("#private")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'var await = 1; document.querySelector("#a")');
});

test("selector mappings accept loop declarations without initializers", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'for (const item of items) document.querySelector("#private")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'for (const item of items) document.querySelector("#a")');
});

test("selector mappings guard concatenation literals after dynamic operands", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'document.getElementById(prefix + "private")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'document.getElementById(prefix + "private")');
});

test("selector mappings reject reversed shadowed static bindings", () => {
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'const target = "#public"; { const target = "#private"; document.querySelector(target) }' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /must not be shadowed/u);
});

test("selector mappings rewrite JavaScript fragment navigation", () => {
  const result = applySelectorMappings({
    css: "#private {}",
    html: '<div id="private"></div>',
    javascript: 'const fragment = "#private"; location.hash = fragment; anchor.href = "#private"; location.href = "/page#private"; location.assign(`/page#private?key=${key}`)',
  }, {
    enabled: true,
    ids: { private: "a" },
    classes: {},
    safelist: [],
  });
  assert.equal(result.javascript, 'const fragment = "#a"; location.hash = fragment; anchor.href = "#a"; location.href = "/page#a"; location.assign(`/page#a?key=${key}`)');
});
