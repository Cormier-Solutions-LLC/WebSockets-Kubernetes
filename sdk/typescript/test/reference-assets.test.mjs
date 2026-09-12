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
  assert.equal(manifest.tools.acorn, "8.18.0");
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

test("selector mappings rewrite HTML ID-reference attributes", () => {
  const result = applySelectorMappings({ css: "#private #details {}",
    html: '<label for="private" aria-controls="private details public" data-for="private" x-aria-controls="private">Label</label><input id="private"><div id="details"></div>',
    javascript: 'document.querySelector("#private")' },
  { enabled: true, ids: { private: "a", details: "b" }, classes: {}, safelist: [] });
  assert.equal(result.html,
    '<label for="a" aria-controls="a b public" data-for="private" x-aria-controls="private">Label</label><input id="a"><div id="b"></div>');
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

test("classList toggle ignores its boolean force argument", () => {
  const result = applySelectorMappings({ css: ".visible {}", html: '<div class="visible"></div>',
    javascript: 'node.classList.toggle("visible", shouldShow)' },
  { enabled: true, ids: {}, classes: { visible: "a" }, safelist: [] });
  assert.equal(result.javascript, 'node.classList.toggle("a", shouldShow)');
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

test("selector mappings rewrite cooked escaped template selectors", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'document.querySelector(`#priv\\u0061te`)' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'document.querySelector(`#a`)');
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

test("selector mappings rewrite unreassigned let selector bindings", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'let target = "#private"; document.querySelector(target)' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'let target = "#a"; document.querySelector(target)');
});

test("selector mappings reject reassigned let selector bindings", () => {
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'let target = "#private"; target = "#public"; document.querySelector(target)' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /must not be reassigned/u);
});

test("selector mappings rewrite unreassigned var selector bindings", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'var target = "#private"; document.querySelector(target)' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'var target = "#a"; document.querySelector(target)');
});

test("selector mappings reject reassigned var selector bindings", () => {
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'var target = "#private"; target = "#public"; document.querySelector(target)' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /must not be reassigned/u);
});

test("selector mappings treat repeated var declarations in one scope as one binding", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'var target; var target = "#private"; document.querySelector(target)' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'var target; var target = "#a"; document.querySelector(target)');
});

test("selector mappings reject repeatedly initialized var bindings", () => {
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'var target = "#public"; var target = "#private"; document.querySelector(target)' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /must not be reassigned/u);
});

test("selector mappings reject overridable selector parameter defaults", () => {
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'function find(target = "#private") { return document.querySelector(target); } find("#private")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /Dynamic selector binding/u);
});

test("selector mappings reject destructuring and loop reassignment", () => {
  const options = { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] };
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'let target = "#public"; [target] = ["#private"]; document.querySelector(target)' }, options),
  /must not be reassigned/u);
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'let target = "#public"; for (target of selectors) {} document.querySelector(target)' }, options),
  /must not be reassigned/u);
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

test("selector mappings rewrite conditional and logical selector arguments", () => {
  const result = applySelectorMappings({ css: "#private .internal {}", html: '<div id="private" class="internal"></div>',
    javascript: 'const candidate = "#public"; document.querySelector(usePrivate ? "#private" : ".internal"); document.querySelector(candidate || "#private")' },
  { enabled: true, ids: { private: "a" }, classes: { internal: "b" }, safelist: [] });
  assert.equal(result.javascript,
    'const candidate = "#public"; document.querySelector(usePrivate ? "#a" : ".b"); document.querySelector(candidate || "#a")');
});

test("selector mappings rewrite the final value of sequence selector arguments", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'document.querySelector((sideEffect(), "#private"))' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'document.querySelector((sideEffect(), "#a"))');
});

test("selector mappings reject unsupported top-level selector expressions", () => {
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'document.querySelector(getSelector())' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /CallExpression is unsupported/u);
});

test("selector mappings rewrite concatenations nested in conditional selector arguments", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'document.querySelector(flag ? "#private " + suffix : "#private")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'document.querySelector(flag ? "#a " + suffix : "#a")');
});

test("selector mappings reject split static selector concatenations", () => {
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'document.querySelector("#pri" + "vate")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /Split static selector concatenations/u);
});

test("selector mappings reject concatenated selector constants", () => {
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'const target = "#private [data-key=\'" + key + "\']"; document.querySelector(target)' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /Concatenated selector binding/u);
});

test("selector mappings rewrite CSSOM rule selectors", () => {
  const result = applySelectorMappings({ css: ".internal {}", html: '<div class="internal"></div>',
    javascript: 'sheet.insertRule(".internal { color: red }")' },
  { enabled: true, ids: {}, classes: { internal: "b" }, safelist: [] });
  assert.equal(result.javascript, 'sheet.insertRule(".b { color: red }")');
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

test("selector mappings restrict bare DOM lookups to document receivers", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'document.getElementById("private"); window.document.getElementById("private"); registry.getElementById("private")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript,
    'document.getElementById("a"); window.document.getElementById("a"); registry.getElementById("private")');
});

test("selector mappings fail closed for ambiguous element-scoped class lookups", () => {
  assert.throws(() => applySelectorMappings({ css: ".internal {}", html: '<div class="internal"></div>',
    javascript: 'root.getElementsByClassName("internal")' },
  { enabled: true, ids: {}, classes: { internal: "a" }, safelist: [] }), /Element-scoped/u);
});

test("selector mappings reject late-initialized and stored selector values", () => {
  const options = { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] };
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'let target; target = "#private"; document.querySelector(target)' }, options),
  /Dynamic selector binding/u);
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'const selectors = { main: "#private" }; document.querySelector(selectors.main)' }, options),
  /Stored selector properties/u);
});

test("selector mappings reject reversed shadowed static bindings", () => {
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'const target = "#public"; { const target = "#private"; document.querySelector(target) }' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /must not be shadowed/u);
});

test("selector mappings distinguish bindings in disjoint lexical scopes", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'function first() { const target = "#private"; return document.querySelector(target); } function second() { const target = "business"; return target; }' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript,
    'function first() { const target = "#a"; return document.querySelector(target); } function second() { const target = "business"; return target; }');
});

test("selector binding use counts exclude class keys and labels", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'const target = "#private"; class Widget { target() {} } targetLabel: for (;;) { break targetLabel; } document.querySelector(target)' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript,
    'const target = "#a"; class Widget { target() {} } targetLabel: for (;;) { break targetLabel; } document.querySelector(target)');
});

test("selector mappings rewrite JavaScript fragment navigation", () => {
  const result = applySelectorMappings({
    css: "#private {}",
    html: '<div id="private"></div>',
    javascript: 'const fragment = "#private"; location.hash = fragment; anchor.setAttribute("href", "#private"); window.location = "#private"; document.location = "#private"; location = "#private"; location.href = "/page#private"; location.assign(`/page#private?key=${key}`)',
  }, {
    enabled: true,
    ids: { private: "a" },
    classes: {},
    safelist: [],
  });
  assert.equal(result.javascript, 'const fragment = "#a"; location.hash = fragment; anchor.setAttribute("href", "#a"); window.location = "#a"; document.location = "#a"; location = "#a"; location.href = "/page#a"; location.assign(`/page#a?key=${key}`)');
});

test("selector mappings fail closed for ambiguous URL and identity property assignments", () => {
  const options = { enabled: true, ids: { private: "a" }, classes: { internal: "b" }, safelist: [] };
  for (const javascript of ['settings.href = "#private"', 'record.hash = "#private"', 'node.id = "private"',
    'node.className = "internal"']) {
    assert.throws(() => applySelectorMappings({ css: "#private .internal {}",
      html: '<div id="private" class="internal"></div>', javascript }, options), /ambiguous/u);
  }
});

test("selector mappings respect shadowed browser location bindings", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'function store(location) { location = "#private"; location.href = "#private"; location.assign("#private"); }' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript,
    'function store(location) { location = "#private"; location.href = "#private"; location.assign("#private"); }');
});

test("selector mappings rewrite conditional fragment assignments", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'const fallback = "#public"; location.href = flag ? "#private" : "#public"; location = fallback || "#private"' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript,
    'const fallback = "#public"; location.href = flag ? "#a" : "#public"; location = fallback || "#a"');
});

test("selector mappings rewrite concatenated fragment assignments", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'location.href = "/page#private?key=" + key' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'location.href = "/page#a?key=" + key');
});

test("selector mappings rewrite final sequence operands in fragment assignments", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'location.href = (sideEffect(), "#private")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'location.href = (sideEffect(), "#a")');
});

test("selector mappings reject dynamic conditional selector branches", () => {
  assert.throws(() => applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'document.querySelector(flag ? getSelector() : "#private")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] }), /CallExpression is unsupported/u);
});

test("selector mappings rewrite History API URL fragments", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'history.pushState({ value: "#private" }, "#private", "#private"); window.history.replaceState(null, "", "/page#private")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript,
    'history.pushState({ value: "#private" }, "#private", "#a"); window.history.replaceState(null, "", "/page#a")');
});

test("selector mappings rewrite unshadowed global open fragments", () => {
  const result = applySelectorMappings({ css: "#private {}", html: '<div id="private"></div>',
    javascript: 'open("#private")' },
  { enabled: true, ids: { private: "a" }, classes: {}, safelist: [] });
  assert.equal(result.javascript, 'open("#a")');
});

test("selector mappings rewrite id and class setAttribute values", () => {
  const result = applySelectorMappings({ css: "#private .internal {}",
    html: '<div id="private" class="internal"></div>',
    javascript: 'node.setAttribute("id", "private"); node.setAttribute("class", "internal public")' },
  { enabled: true, ids: { private: "a" }, classes: { internal: "b" }, safelist: [] });
  assert.equal(result.javascript, 'node.setAttribute("id", "a"); node.setAttribute("class", "b public")');
});

test("selector mappings reject non-string DOM token arguments", () => {
  const options = { enabled: true, ids: { true: "a" }, classes: { true: "b" }, safelist: [] };
  for (const javascript of ["document.getElementById(true)", "node.classList.add(true)",
    'node.setAttribute("id", true)']) {
    assert.throws(() => applySelectorMappings({ css: "#true .true {}",
      html: '<div id="true" class="true"></div>', javascript }, options), /Non-string DOM selector arguments/u);
  }
});
