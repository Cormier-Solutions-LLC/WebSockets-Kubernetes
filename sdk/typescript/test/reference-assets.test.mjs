import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { applySelectorMappings } from "../scripts/reference-assets.mjs";

const root = resolve(import.meta.dirname, "..");

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
  assert.equal(result.javascript, 'document.querySelector("#a .b"); node.classList.add("b")');
});
