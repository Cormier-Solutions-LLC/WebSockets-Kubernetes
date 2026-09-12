import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { parse as parseJavaScript } from "acorn";
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

function readNormalizedText(path) {
  return readFileSync(path, "utf8").replace(/\r\n?/gu, "\n");
}

function integrity(content) {
  return `sha384-${digest(content, "sha384", "base64")}`;
}

function replaceTokenList(value, mappings) {
  return value.split(/\s+/u).map((token) => Object.hasOwn(mappings, token) ? mappings[token] : token).join(" ");
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceSelector(value, prefix, source, target) {
  const selector = new RegExp(`${escapeRegularExpression(prefix)}${escapeRegularExpression(source)}(?![A-Za-z0-9_-])`, "gu");
  return value.replace(selector, `${prefix}${target}`);
}

function memberName(member) {
  if (member?.type !== "MemberExpression") return undefined;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  return member.computed && member.property.type === "Literal" ? member.property.value : undefined;
}

function staticStringValue(node) {
  if (node === null) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

function isDocumentReference(node) {
  return (node?.type === "Identifier" && node.name === "document")
    || (memberName(node) === "document" && node.object?.type === "Identifier" && node.object.name === "window");
}

function isDomLookupCall(call, method) {
  return (method === "getElementById" || method === "getElementsByClassName")
    && isDocumentReference(call.callee.object);
}

function mapJavaScriptValue(value, call, argument, ids, classes, selectorMethods, classListMethods) {
  const method = memberName(call.callee);
  const attribute = setAttributeKind(call, argument);
  let mapped = value;
  if (attribute === "href") {
    mapped = mapFragmentValue(mapped, ids);
  } else if (attribute === "id") {
    mapped = Object.hasOwn(ids, mapped) ? ids[mapped] : mapped;
  } else if (attribute === "class") {
    mapped = replaceTokenList(mapped, classes);
  } else if ((selectorMethods.has(method) || (call.callee.type === "Identifier" && call.callee.name === "$"))
    && call.arguments[0] === argument) {
    for (const [source, target] of Object.entries(ids)) mapped = replaceSelector(mapped, "#", source, target);
    for (const [source, target] of Object.entries(classes)) mapped = replaceSelector(mapped, ".", source, target);
  } else if (method === "getElementById" && isDomLookupCall(call, method) && call.arguments[0] === argument) {
    mapped = Object.hasOwn(ids, mapped) ? ids[mapped] : mapped;
  } else if (method === "getElementsByClassName" && isDomLookupCall(call, method) && call.arguments[0] === argument) {
    mapped = replaceTokenList(mapped, classes);
  } else if (classListMethods.has(method) && isClassListTokenArgument(call, method, argument)) {
    mapped = Object.hasOwn(classes, mapped) ? classes[mapped] : mapped;
  } else if ((method === "assign" || method === "replace") && isLocationReference(call.callee.object)
    && call.arguments[0] === argument) {
    for (const [source, target] of Object.entries(ids)) mapped = replaceSelector(mapped, "#", source, target);
  } else if ((method === "open" && call.callee.object?.type === "Identifier" && call.callee.object.name === "window"
      || call.callee.type === "Identifier" && call.callee.name === "open")
    && call.arguments[0] === argument) {
    for (const [source, target] of Object.entries(ids)) mapped = replaceSelector(mapped, "#", source, target);
  } else if ((method === "pushState" || method === "replaceState") && call.arguments[2] === argument
    && (call.callee.object?.type === "Identifier" && call.callee.object.name === "history"
      || memberName(call.callee.object) === "history" && call.callee.object.object?.name === "window")) {
    for (const [source, target] of Object.entries(ids)) mapped = replaceSelector(mapped, "#", source, target);
  }
  return mapped;
}

function isLocationReference(node) {
  return (node?.type === "Identifier" && node.name === "location")
    || (memberName(node) === "location" && node.object?.type === "Identifier"
      && (node.object.name === "window" || node.object.name === "document"));
}

function mapFragmentValue(value, ids) {
  let mapped = value;
  for (const [source, target] of Object.entries(ids)) mapped = replaceSelector(mapped, "#", source, target);
  return mapped;
}

function isLocationUrlAssignment(left) {
  const property = memberName(left);
  return (left?.type === "Identifier" && left.name === "location")
    || property === "hash"
    || property === "href"
    || (property === "location" && left.object?.type === "Identifier"
      && (left.object.name === "window" || left.object.name === "document"));
}

function setAttributeKind(call, argument) {
  if (memberName(call?.callee) !== "setAttribute" || call.arguments[1] !== argument) return undefined;
  const attribute = staticStringValue(call.arguments[0])?.toLowerCase();
  return attribute === "href" || attribute === "id" || attribute === "class" ? attribute : undefined;
}

function isClassListTokenArgument(call, method, argument) {
  if (memberName(call.callee.object) !== "classList") return false;
  const index = call.arguments.indexOf(argument);
  if (method === "add" || method === "remove") return index >= 0;
  if (method === "replace") return index === 0 || index === 1;
  return (method === "contains" || method === "toggle") && index === 0;
}

function isHistoryUrlCall(call, argument) {
  const method = memberName(call?.callee);
  return (method === "pushState" || method === "replaceState")
    && call.arguments[2] === argument
    && ((call.callee.object?.type === "Identifier" && call.callee.object.name === "history")
      || (memberName(call.callee.object) === "history" && call.callee.object.object?.name === "window"));
}

function stringExpressionReplacements(node, mapper) {
  if (node.type === "Literal" && typeof node.value === "string") {
    const mapped = mapper(node.value);
    return mapped === node.value ? [] : [{ start: node.start, end: node.end, value: JSON.stringify(mapped) }];
  }
  if (node.type !== "TemplateLiteral") return [];
  const mappedQuasis = node.quasis.map((quasi, index) => {
    const hasPrecedingExpression = index > 0;
    const hasFollowingExpression = index < node.expressions.length;
    const guarded = `${hasPrecedingExpression ? "-" : ""}${quasi.value.raw}${hasFollowingExpression ? "-" : ""}`;
    const mapped = mapper(guarded);
    return mapped.slice(hasPrecedingExpression ? 1 : 0, hasFollowingExpression ? -1 : undefined);
  });
  return mappedQuasis.flatMap((value, index) => value === node.quasis[index].value.raw ? [] : [{
    start: node.quasis[index].start,
    end: node.quasis[index].end,
    value,
  }]);
}

function replaceJavaScriptSelectorReferences(javascript, ids, classes) {
  const syntaxTree = parseJavaScript(javascript, { ecmaVersion: "latest", sourceType: "script" });
  const replacements = [];
  const selectorMethods = new Set(["closest", "insertRule", "matches", "querySelector", "querySelectorAll"]);
  const classListMethods = new Set(["add", "contains", "remove", "replace", "toggle"]);
  const bindingDeclarations = new Map();
  const assignmentTargets = [];
  const assignedBindings = new Set();

  function visitBindingIdentifiers(pattern, callback) {
    if (pattern === null) return;
    if (pattern.type === "Identifier") {
      callback(pattern.name, pattern);
    } else if (pattern.type === "RestElement") {
      visitBindingIdentifiers(pattern.argument, callback);
    } else if (pattern.type === "AssignmentPattern") {
      visitBindingIdentifiers(pattern.left, callback);
    } else if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements) visitBindingIdentifiers(element, callback);
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        visitBindingIdentifiers(property.type === "RestElement" ? property.argument : property.value, callback);
      }
    }
  }

  function recordBindingPattern(pattern, scope, kind) {
    const records = [];
    visitBindingIdentifiers(pattern, (name) => {
      if (!bindingDeclarations.has(name)) bindingDeclarations.set(name, []);
      let record = kind === "var"
        ? bindingDeclarations.get(name).find((candidate) => candidate.kind === "var" && candidate.scope === scope)
        : undefined;
      if (record === undefined) {
        record = { kind, mutable: kind !== "const", name, scope };
        bindingDeclarations.get(name).push(record);
      }
      records.push(record);
    });
    return records;
  }

  function recordAssignedPattern(pattern) {
    visitBindingIdentifiers(pattern, (_name, identifier) => assignmentTargets.push(identifier));
  }

  function collectBindings(node, parent, functionScope, lexicalScope) {
    if (node === null || typeof node !== "object") return;
    const createsLexicalScope = ["Program", "BlockStatement", "SwitchStatement", "ForStatement", "ForInStatement",
      "ForOfStatement", "CatchClause"].includes(node.type);
    const currentLexicalScope = createsLexicalScope ? node : lexicalScope;
    if (node.type === "VariableDeclarator") {
      const kind = parent?.kind;
      const scope = kind === "var" ? functionScope : currentLexicalScope;
      const records = recordBindingPattern(node.id, scope, kind);
      if (node.init !== null) {
        records[0].initializerCount = (records[0].initializerCount ?? 0) + 1;
        if (records[0].initializerCount > 1) assignedBindings.add(records[0]);
      }
      if (node.id.type === "Identifier" && parent?.type === "VariableDeclaration" && ["const", "let", "var"].includes(parent.kind)
        && (node.init?.type === "TemplateLiteral" || typeof staticStringValue(node.init) === "string")) {
        const record = records[0];
        if (record.static !== undefined) assignedBindings.add(record);
        else record.static = { node: node.init };
      } else if (node.id.type === "Identifier" && parent?.type === "VariableDeclaration" && ["const", "let", "var"].includes(parent.kind)
        && node.init?.type === "BinaryExpression" && node.init.operator === "+") {
        records[0].concatenated = true;
      } else if (node.id.type === "Identifier" && node.init !== null && records[0].static !== undefined) {
        assignedBindings.add(records[0]);
      }
    } else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      if (node.id !== null && node.id !== undefined) recordBindingPattern(node.id, lexicalScope, "function");
      for (const parameter of node.params) {
        recordBindingPattern(parameter, node, "parameter");
      }
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.id !== null) recordBindingPattern(node.id, lexicalScope, "class");
    } else if (node.type === "CatchClause") {
      recordBindingPattern(node.param, node, "catch");
    } else if (node.type === "ImportSpecifier" || node.type === "ImportDefaultSpecifier" || node.type === "ImportNamespaceSpecifier") {
      recordBindingPattern(node.local, syntaxTree, "import");
    } else if (node.type === "AssignmentExpression") {
      recordAssignedPattern(node.left);
    } else if (node.type === "UpdateExpression" && node.argument.type === "Identifier") {
      assignmentTargets.push(node.argument);
    } else if ((node.type === "ForInStatement" || node.type === "ForOfStatement")
      && node.left.type !== "VariableDeclaration") {
      recordAssignedPattern(node.left);
    }
    const childFunctionScope = node.type === "FunctionDeclaration" || node.type === "FunctionExpression"
      || node.type === "ArrowFunctionExpression" ? node : functionScope;
    const childLexicalScope = node.type === "FunctionDeclaration" || node.type === "FunctionExpression"
      || node.type === "ArrowFunctionExpression" ? node : currentLexicalScope;
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) collectBindings(item, node, childFunctionScope, childLexicalScope);
      } else if (child !== parent) {
        collectBindings(child, node, childFunctionScope, childLexicalScope);
      }
    }
  }

  collectBindings(syntaxTree, undefined, syntaxTree, syntaxTree);

  function resolveBinding(name, position) {
    const candidates = (bindingDeclarations.get(name) ?? [])
      .filter((record) => record.scope.start <= position && position < record.scope.end)
      .sort((left, right) => (left.scope.end - left.scope.start) - (right.scope.end - right.scope.start));
    if (candidates.length > 1 && candidates[0].scope === candidates[1].scope) return undefined;
    return candidates[0];
  }

  for (const target of assignmentTargets) {
    const binding = resolveBinding(target.name, target.start);
    if (binding !== undefined) assignedBindings.add(binding);
  }

  const referenceCounts = new Map();
  const parents = new WeakMap();
  function collectReferences(node, parent) {
    if (node === null || typeof node !== "object") return;
    if (node.type === "Identifier") {
      const binding = resolveBinding(node.name, node.start);
      const declaration = (parent?.type === "VariableDeclarator" && parent.id === node)
        || (parent?.type === "AssignmentPattern" && parent.left === node);
      const propertyName = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
      const objectKey = parent?.type === "Property" && parent.key === node && !parent.computed && parent.value !== node;
      if (binding?.static !== undefined && !declaration && !propertyName && !objectKey) {
        referenceCounts.set(binding, (referenceCounts.get(binding) ?? 0) + 1);
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) for (const item of child) {
        if (item !== null && typeof item === "object") parents.set(item, node);
        collectReferences(item, node);
      }
      else if (child !== parent) {
        if (child !== null && typeof child === "object") parents.set(child, node);
        collectReferences(child, node);
      }
    }
  }
  collectReferences(syntaxTree, undefined);
  const bindingReplacements = new Map();
  const supportedBindingUses = new Map();

  function recordStaticBindingReplacement(identifier, mapper) {
    const record = resolveBinding(identifier.name, identifier.start);
    if (record?.static === undefined) {
      if (record?.concatenated === true) {
        throw new Error(`Concatenated selector binding ${identifier.name} is unsupported; inline it or use a template literal.`);
      }
      throw new Error(`Dynamic selector binding ${identifier.name} is unsupported when selector mangling is enabled.`);
    }
    const nestedShadow = (bindingDeclarations.get(identifier.name) ?? []).some((candidate) => candidate !== record
      && ((candidate.scope.start <= record.scope.start && record.scope.end <= candidate.scope.end)
        || (record.scope.start <= candidate.scope.start && candidate.scope.end <= record.scope.end)));
    if (nestedShadow) {
      throw new Error(`Static selector binding ${identifier.name} must not be shadowed when selector mangling is enabled.`);
    }
    if (record.mutable && assignedBindings.has(record)) {
      throw new Error(`Mutable selector binding ${identifier.name} must not be reassigned when selector mangling is enabled.`);
    }
    const edits = stringExpressionReplacements(record.static.node, mapper);
    if (edits.length === 0) return;
    supportedBindingUses.set(record, (supportedBindingUses.get(record) ?? 0) + 1);
    const previous = bindingReplacements.get(record.static.node.start);
    const signature = JSON.stringify(edits);
    if (previous !== undefined && previous.signature !== signature) {
      throw new Error(`Static selector binding ${identifier.name} is used by incompatible selector APIs.`);
    }
    bindingReplacements.set(record.static.node.start, {
      start: record.static.node.start,
      end: record.static.node.end,
      name: identifier.name,
      record,
      edits,
      signature,
    });
  }

  function concatenationCall(node) {
    const root = concatenationRoot(node);
    const context = selectorArgumentCall(root);
    return context === undefined ? undefined : { argument: context.argument, call: context.call, root };
  }

  function concatenationRoot(node) {
    let root = node;
    while (parents.get(root)?.type === "BinaryExpression" && parents.get(root).operator === "+") root = parents.get(root);
    return root;
  }

  function selectorArgumentCall(node) {
    let argument = node;
    let argumentParent = parents.get(argument);
    while ((argumentParent?.type === "ConditionalExpression"
        && (argumentParent.consequent === argument || argumentParent.alternate === argument))
      || (argumentParent?.type === "LogicalExpression"
        && (argumentParent.left === argument || argumentParent.right === argument))
      || (argumentParent?.type === "SequenceExpression"
        && argumentParent.expressions.at(-1) === argument)) {
      argument = argumentParent;
      argumentParent = parents.get(argument);
    }
    return argumentParent?.type === "CallExpression" && argumentParent.arguments.includes(argument)
      ? { argument, call: argumentParent }
      : undefined;
  }

  function fragmentAssignment(node) {
    let value = node;
    let valueParent = parents.get(value);
    while ((valueParent?.type === "ConditionalExpression"
        && (valueParent.consequent === value || valueParent.alternate === value))
      || (valueParent?.type === "LogicalExpression"
        && (valueParent.left === value || valueParent.right === value))
      || (valueParent?.type === "BinaryExpression" && valueParent.operator === "+")) {
      value = valueParent;
      valueParent = parents.get(value);
    }
    return valueParent?.type === "AssignmentExpression" && valueParent.right === value
      && isLocationUrlAssignment(valueParent.left) ? valueParent : undefined;
  }

  function isMappedCallArgument(call, argument) {
    const method = memberName(call.callee);
    return ((selectorMethods.has(method) || (call.callee.type === "Identifier" && call.callee.name === "$"))
        && call.arguments[0] === argument)
      || (isDomLookupCall(call, method) && call.arguments[0] === argument)
      || (classListMethods.has(method) && isClassListTokenArgument(call, method, argument))
      || ((method === "assign" || method === "replace") && isLocationReference(call.callee.object)
        && call.arguments[0] === argument)
      || (method === "open" && call.callee.object?.type === "Identifier" && call.callee.object.name === "window"
        && call.arguments[0] === argument)
      || (call.callee.type === "Identifier" && call.callee.name === "open" && call.arguments[0] === argument
        && resolveBinding("open", call.start) === undefined)
      || setAttributeKind(call, argument) !== undefined
      || isHistoryUrlCall(call, argument);
  }

  function visit(node, parent) {
    if (node === null || typeof node !== "object") return;
    const selectorContext = selectorArgumentCall(node);
    const fragmentContext = fragmentAssignment(node);
    if ((node.type === "Literal" || node.type === "TemplateLiteral") && selectorContext !== undefined
      && isMappedCallArgument(selectorContext.call, selectorContext.argument)) {
      const edits = stringExpressionReplacements(node, (source) => mapJavaScriptValue(source,
        selectorContext.call, selectorContext.argument, ids, classes, selectorMethods, classListMethods));
      replacements.push(...edits);
    } else if (node.type === "Literal" && typeof node.value === "string" && parent?.type === "BinaryExpression") {
      const context = concatenationCall(node);
      if (context !== undefined) {
        const hasFollowingOperand = node.end < context.root.end;
        const hasPrecedingOperand = node.start > context.root.start;
        const edits = stringExpressionReplacements(node, (source) => {
          const guarded = `${hasPrecedingOperand ? "-" : ""}${source}${hasFollowingOperand ? "-" : ""}`;
          const mapped = isHistoryUrlCall(context.call, context.argument)
            ? mapFragmentValue(guarded, ids)
            : mapJavaScriptValue(guarded, context.call, context.argument,
              ids, classes, selectorMethods, classListMethods);
          return mapped.slice(hasPrecedingOperand ? 1 : 0, hasFollowingOperand ? -1 : undefined);
        });
        replacements.push(...edits);
      } else if (fragmentContext !== undefined) {
        const root = concatenationRoot(node);
        const hasFollowingOperand = node.end < root.end;
        const hasPrecedingOperand = node.start > root.start;
        const edits = stringExpressionReplacements(node, (source) => {
          const guarded = `${hasPrecedingOperand ? "-" : ""}${source}${hasFollowingOperand ? "-" : ""}`;
          const mapped = mapFragmentValue(guarded, ids);
          return mapped.slice(hasPrecedingOperand ? 1 : 0, hasFollowingOperand ? -1 : undefined);
        });
        replacements.push(...edits);
      }
    } else if ((node.type === "Literal" || node.type === "TemplateLiteral") && fragmentContext !== undefined) {
      const edits = stringExpressionReplacements(node, (source) => mapFragmentValue(source, ids));
      replacements.push(...edits);
    } else if (node.type === "Identifier" && selectorContext !== undefined) {
      if (isMappedCallArgument(selectorContext.call, selectorContext.argument)) {
        recordStaticBindingReplacement(node, (source) => mapJavaScriptValue(source,
          selectorContext.call, selectorContext.argument, ids, classes, selectorMethods, classListMethods));
      }
    } else if (node.type === "MemberExpression" && selectorContext !== undefined
      && isMappedCallArgument(selectorContext.call, selectorContext.argument)) {
      throw new Error("Stored selector properties are unsupported when selector mangling is enabled.");
    } else if (selectorContext !== undefined
      && isMappedCallArgument(selectorContext.call, selectorContext.argument)
      && !["BinaryExpression", "ConditionalExpression", "LogicalExpression", "SequenceExpression"].includes(node.type)) {
      throw new Error(`Selector expression ${node.type} is unsupported when selector mangling is enabled.`);
    } else if (node.type === "Identifier" && fragmentContext !== undefined && parent?.type !== "BinaryExpression") {
      recordStaticBindingReplacement(node, (source) => mapFragmentValue(source, ids));
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item, node);
      } else if (child !== parent) {
        visit(child, node);
      }
    }
  }

  visit(syntaxTree, undefined);
  for (const replacement of bindingReplacements.values()) {
    if (supportedBindingUses.get(replacement.record) !== referenceCounts.get(replacement.record)) {
      throw new Error(`Static selector binding ${replacement.name} has unsupported or conflicting uses.`);
    }
    replacements.push(...replacement.edits);
  }
  return replacements.sort((left, right) => right.start - left.start)
    .reduce((result, replacement) =>
      result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end), javascript);
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
  }
  for (const [source, target] of Object.entries(selectorMangling.classes)) {
    mappedCss = replaceSelector(mappedCss, ".", source, target);
    mappedHtml = mappedHtml.replace(/\bclass=(['"])([^'"]*)\1/gu, (match, quote, tokens) =>
      `class=${quote}${replaceTokenList(tokens, { [source]: target })}${quote}`);
  }
  mappedJavaScript = replaceJavaScriptSelectorReferences(mappedJavaScript, selectorMangling.ids, selectorMangling.classes);
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
  const sourceMapRoot = resolve(outputRoot, "source-maps", profile);
  let javascript;
  let javascriptMap;
  let minifiedJavascript;
  let css;
  let cssMap;
  const sourceArtifacts = [];

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
    minifiedJavascript = javascript;

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

    for (const [kind, map] of [["app.js", javascriptMap], ["app.css", cssMap]]) {
      if (map === undefined) continue;
      const metadata = JSON.parse(map);
      if (obfuscate && kind === "app.js") {
        delete metadata.sourceRoot;
        metadata.sources = ["app.minified.js"];
        if (!config.sourceMaps.includeSourcesContent) {
          delete metadata.sourcesContent;
          sourceArtifacts.push({ name: "app.minified.js", content: minifiedJavascript });
        }
      } else if (config.selectorMangling.enabled) {
        delete metadata.sourceRoot;
        const name = `${kind.replace(/\.[^.]+$/u, "")}.mangled.${kind.split(".").at(-1)}`;
        const content = kind === "app.js" ? source.javascript : source.css;
        metadata.sources = [name];
        sourceArtifacts.push({ name, content });
        if (config.sourceMaps.includeSourcesContent) metadata.sourcesContent = [content];
        else {
          delete metadata.sourcesContent;
        }
      } else {
        metadata.sourceRoot = "../../../wwwroot/";
        metadata.sources = metadata.sources.map(() => kind);
      }
      const normalized = `${JSON.stringify(metadata)}\n`;
      if (kind === "app.js") javascriptMap = normalized;
      else cssMap = normalized;
    }
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
    write(sourceMapRoot, "app.js.map", javascriptMap);
    write(sourceMapRoot, "app.css.map", cssMap);
    for (const artifact of sourceArtifacts) write(sourceMapRoot, artifact.name, artifact.content);
  }

  const files = [
    inventoryFile(outputRoot, profile, "app.css", css),
    inventoryFile(outputRoot, profile, "app.js", javascript),
    inventoryFile(outputRoot, profile, "index.html", html),
  ];
  if (profile !== "readable" && config.sourceMaps.emit) {
    files.push(inventoryFile(outputRoot, `source-maps/${profile}`, "app.css.map", cssMap));
    files.push(inventoryFile(outputRoot, `source-maps/${profile}`, "app.js.map", javascriptMap));
    for (const artifact of sourceArtifacts) {
      files.push(inventoryFile(outputRoot, `source-maps/${profile}`, artifact.name, artifact.content));
    }
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
    css: readNormalizedText(resolve(sourceRoot, "app.css")),
    html: readNormalizedText(resolve(sourceRoot, "index.html")),
    javascript: readNormalizedText(resolve(sourceRoot, "app.js")),
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
      acorn: packageMetadata.devDependencies.acorn,
      esbuild: packageMetadata.devDependencies.esbuild,
      htmlMinifierTerser: packageMetadata.devDependencies["html-minifier-terser"],
      javascriptObfuscator: packageMetadata.devDependencies["javascript-obfuscator"],
      lightningcss: packageMetadata.devDependencies.lightningcss,
    },
  };
  write(outputRoot, "asset-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const sizeReport = Object.fromEntries(profiles.map((profile) => [profile, {
    bytes: profileResults[profile].files
      .filter((file) => file.path.startsWith(`${profile}/`))
      .reduce((total, file) => total + file.bytes, 0),
    gzipBytes: profileResults[profile].files
      .filter((file) => file.path.startsWith(`${profile}/`))
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
