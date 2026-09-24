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

function cssIdentifierEnd(value, start) {
  let index = start;
  while (index < value.length) {
    const character = value[index];
    if (character === "\\") {
      if (index + 1 >= value.length || /[\r\n\f]/u.test(value[index + 1])) break;
      index += 1;
      if (/[0-9A-Fa-f]/u.test(value[index])) {
        let digits = 0;
        while (index < value.length && digits < 6 && /[0-9A-Fa-f]/u.test(value[index])) {
          index += 1;
          digits += 1;
        }
        if (index < value.length && /[\t\n\f\r ]/u.test(value[index])) index += 1;
      } else {
        index += 1;
      }
    } else if (/[A-Za-z0-9_-]/u.test(character) || character.codePointAt(0) >= 0x80) {
      index += character.length;
    } else {
      break;
    }
  }
  return index;
}

function decodeCssIdentifier(value) {
  let decoded = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "\\") {
      const character = String.fromCodePoint(value.codePointAt(index));
      decoded += character;
      index += character.length;
      continue;
    }
    index += 1;
    const match = /^[0-9A-Fa-f]{1,6}/u.exec(value.slice(index));
    if (match !== null) {
      const codePoint = Number.parseInt(match[0], 16);
      decoded += codePoint === 0 || codePoint > 0x10FFFF ? "\uFFFD" : String.fromCodePoint(codePoint);
      index += match[0].length;
      if (index < value.length && /[\t\n\f\r ]/u.test(value[index])) index += 1;
    } else if (index < value.length) {
      decoded += value[index];
      index += 1;
    }
  }
  return decoded;
}

function replaceSelector(value, prefix, source, target) {
  let mapped = "";
  let cursor = 0;
  while (cursor < value.length) {
    const selectorStart = value.indexOf(prefix, cursor);
    if (selectorStart < 0) return mapped + value.slice(cursor);
    const identifierStart = selectorStart + prefix.length;
    const identifierEnd = cssIdentifierEnd(value, identifierStart);
    mapped += value.slice(cursor, selectorStart);
    const identifier = value.slice(identifierStart, identifierEnd);
    mapped += decodeCssIdentifier(identifier) === source ? `${prefix}${target}` : `${prefix}${identifier}`;
    cursor = identifierEnd;
  }
  return mapped;
}

function memberName(member) {
  if (member?.type !== "MemberExpression") return undefined;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal") return member.property.value;
  return member.computed && member.property.type === "TemplateLiteral" && member.property.expressions.length === 0
    ? member.property.quasis[0].value.cooked
    : undefined;
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
  const indirectMethod = method === "call" ? memberName(call.callee.object) : undefined;
  const attribute = setAttributeKind(call, argument);
  let mapped = value;
  if (attribute === "href") {
    mapped = mapFragmentValue(mapped, ids);
  } else if (attribute === "id") {
    mapped = Object.hasOwn(ids, mapped) ? ids[mapped] : mapped;
  } else if (attribute === "class") {
    mapped = replaceTokenList(mapped, classes);
  } else if (selectorMethods.has(indirectMethod) && call.arguments[1] === argument) {
    for (const [source, target] of Object.entries(ids)) mapped = replaceSelector(mapped, "#", source, target);
    for (const [source, target] of Object.entries(classes)) mapped = replaceSelector(mapped, ".", source, target);
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
    || (memberName(node) === "location" && (node.object?.type === "Identifier"
      && (node.object.name === "window" || node.object.name === "document") || isDocumentReference(node.object)));
}

function mapFragmentValue(value, ids) {
  return value.replace(/#([A-Za-z0-9%._~-]+)/gu, (match, encoded) => {
    try {
      const decoded = decodeURIComponent(encoded);
      return Object.hasOwn(ids, decoded) ? `#${ids[decoded]}` : match;
    } catch {
      return match;
    }
  });
}

function isLocationUrlAssignment(left) {
  const property = memberName(left);
  return (left?.type === "Identifier" && left.name === "location")
    || ((property === "hash" || property === "href") && isLocationReference(left.object))
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
    const original = quasi.value.cooked ?? quasi.value.raw;
    const guarded = `${hasPrecedingExpression ? "-" : ""}${original}${hasFollowingExpression ? "-" : ""}`;
    const mapped = mapper(guarded);
    return {
      original,
      value: mapped.slice(hasPrecedingExpression ? 1 : 0, hasFollowingExpression ? -1 : undefined),
    };
  });
  return mappedQuasis.flatMap(({ original, value }, index) => value === original ? [] : [{
    start: node.quasis[index].start,
    end: node.quasis[index].end,
    value: value.replace(/\\/gu, "\\\\").replace(/`/gu, "\\`").replace(/\$\{/gu, "\\${"),
  }]);
}

function mapCssSelectors(value, ids, classes) {
  let mapped = value;
  for (const [source, target] of Object.entries(ids)) mapped = replaceSelector(mapped, "#", source, target);
  for (const [source, target] of Object.entries(classes)) mapped = replaceSelector(mapped, ".", source, target);
  return mapped;
}

function mapHtmlAttribute(name, value, ids, classes) {
  const singleIdAttributes = new Set(["aria-activedescendant", "aria-details", "aria-errormessage", "commandfor", "for",
    "form", "list", "popovertarget"]);
  const tokenIdAttributes = new Set(["aria-controls", "aria-describedby", "aria-flowto", "aria-labelledby", "aria-owns",
    "headers"]);
  const fragmentAttributes = new Set(["action", "cite", "clip-path", "fill", "filter", "formaction", "href", "mask",
    "marker-end", "marker-mid", "marker-start", "src", "xlink:href"]);
  if (name === "id" || singleIdAttributes.has(name)) return Object.hasOwn(ids, value) ? ids[value] : value;
  if (name === "class") return replaceTokenList(value, classes);
  if (tokenIdAttributes.has(name)) return replaceTokenList(value, ids);
  if (fragmentAttributes.has(name)) return mapFragmentValue(value, ids);
  return name === "style" ? mapCssSelectors(value, ids, classes) : value;
}

function mapHtmlStartTag(tag, ids, classes) {
  const tagName = /^<\s*([A-Za-z][^\s/>]*)/u.exec(tag);
  if (tagName === null) return tag;
  const replacements = [];
  let index = tagName[0].length;
  while (index < tag.length) {
    while (index < tag.length && /\s/u.test(tag[index])) index += 1;
    if (index >= tag.length || tag[index] === ">" || tag[index] === "/") break;
    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/u.test(tag[index])) index += 1;
    const name = tag.slice(nameStart, index).toLowerCase();
    while (index < tag.length && /\s/u.test(tag[index])) index += 1;
    if (tag[index] !== "=") continue;
    index += 1;
    while (index < tag.length && /\s/u.test(tag[index])) index += 1;
    const quote = tag[index] === "\"" || tag[index] === "'" ? tag[index++] : undefined;
    const valueStart = index;
    if (quote === undefined) {
      while (index < tag.length && !/[\s>]/u.test(tag[index])) index += 1;
    } else {
      while (index < tag.length && tag[index] !== quote) index += 1;
    }
    const valueEnd = index;
    const value = tag.slice(valueStart, valueEnd);
    const mapped = mapHtmlAttribute(name, value, ids, classes);
    if (mapped !== value) replacements.push({ start: valueStart, end: valueEnd, value: mapped });
    if (quote !== undefined && tag[index] === quote) index += 1;
  }
  return replacements.sort((left, right) => right.start - left.start)
    .reduce((result, replacement) =>
      result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end), tag);
}

function replaceHtmlSelectorReferences(html, ids, classes) {
  let mapped = "";
  let cursor = 0;
  const lowerHtml = html.toLowerCase();
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) return mapped + html.slice(cursor);
    mapped += html.slice(cursor, tagStart);
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) return mapped + html.slice(tagStart);
      mapped += html.slice(tagStart, commentEnd + 3);
      cursor = commentEnd + 3;
      continue;
    }
    if (/[!/?]/u.test(html[tagStart + 1] ?? "")) {
      const markupEnd = html.indexOf(">", tagStart + 2);
      if (markupEnd < 0) return mapped + html.slice(tagStart);
      mapped += html.slice(tagStart, markupEnd + 1);
      cursor = markupEnd + 1;
      continue;
    }
    if (!/[A-Za-z]/u.test(html[tagStart + 1] ?? "")) {
      mapped += "<";
      cursor = tagStart + 1;
      continue;
    }
    let quote;
    let tagEnd = tagStart + 1;
    for (; tagEnd < html.length; tagEnd += 1) {
      const character = html[tagEnd];
      if (quote === undefined && (character === "\"" || character === "'")) quote = character;
      else if (character === quote) quote = undefined;
      else if (quote === undefined && character === ">") break;
    }
    if (tagEnd >= html.length) return mapped + html.slice(tagStart);
    const tag = html.slice(tagStart, tagEnd + 1);
    mapped += mapHtmlStartTag(tag, ids, classes);
    cursor = tagEnd + 1;
    const rawTag = /^<\s*(script|style|textarea|title)(?:\s|>)/iu.exec(tag)?.[1]?.toLowerCase();
    if (rawTag !== undefined) {
      const closingStart = lowerHtml.indexOf(`</${rawTag}`, cursor);
      if (closingStart < 0) return mapped + html.slice(cursor);
      mapped += html.slice(cursor, closingStart);
      cursor = closingStart;
    }
  }
  return mapped;
}

function replaceJavaScriptSelectorReferences(javascript, ids, classes) {
  const syntaxTree = parseJavaScript(javascript, { ecmaVersion: "latest", sourceType: "script" });
  const replacements = [];
  const selectorMethods = new Set(["closest", "insertRule", "matches", "querySelector", "querySelectorAll", "replaceSync"]);
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
        ? bindingDeclarations.get(name).find((candidate) => ["var", "parameter", "function"].includes(candidate.kind)
          && candidate.scope === scope)
        : kind === "parameter"
          ? bindingDeclarations.get(name).find((candidate) => candidate.kind === "parameter" && candidate.scope === scope)
          : kind === "function"
            ? bindingDeclarations.get(name).find((candidate) => ["var", "parameter", "function"].includes(candidate.kind)
              && candidate.scope === scope)
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
    const createsLexicalScope = ["Program", "BlockStatement", "StaticBlock", "SwitchStatement", "ForStatement",
      "ForInStatement", "ForOfStatement", "CatchClause"].includes(node.type);
    const currentLexicalScope = createsLexicalScope ? node : lexicalScope;
    if (node.type === "VariableDeclarator") {
      const kind = parent?.kind;
      const scope = kind === "var" ? functionScope : currentLexicalScope;
      const records = recordBindingPattern(node.id, scope, kind);
      if (node.init !== null && records.length > 0) {
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
      if (node.id.type === "Identifier" && node.init?.type === "CallExpression"
        && memberName(node.init.callee) === "createElement" && staticStringValue(node.init.arguments[0]) === "style") {
        records[0].styleElementInitializer = node.init;
      }
    } else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      if (node.id !== null && node.id !== undefined) {
        const declarationScope = node.type === "FunctionExpression"
          ? node
          : functionScope?.body === parent ? functionScope : lexicalScope;
        recordBindingPattern(node.id, declarationScope, "function");
        if (node.type === "FunctionDeclaration" && declarationScope !== functionScope) {
          recordBindingPattern(node.id, functionScope, "var");
        }
      }
      for (const parameter of node.params) {
        recordBindingPattern(parameter, node, "parameter");
      }
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.id !== null) recordBindingPattern(node.id, node.type === "ClassExpression" ? node : lexicalScope, "class");
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
      const classKey = (parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition")
        && parent.key === node && !parent.computed;
      const label = (parent?.type === "LabeledStatement" && parent.label === node)
        || ((parent?.type === "BreakStatement" || parent?.type === "ContinueStatement") && parent.label === node);
      if (binding?.static !== undefined && !declaration && !propertyName && !objectKey && !classKey && !label) {
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
      && candidate.scope.start <= identifier.start && identifier.start < candidate.scope.end
      && ((candidate.scope.start <= record.scope.start && record.scope.end <= candidate.scope.end)
        || (record.scope.start <= candidate.scope.start && candidate.scope.end <= record.scope.end)));
    if (nestedShadow) {
      throw new Error(`Static selector binding ${identifier.name} must not be shadowed when selector mangling is enabled.`);
    }
    if (record.mutable && assignedBindings.has(record)) {
      throw new Error(`Mutable selector binding ${identifier.name} must not be reassigned when selector mangling is enabled.`);
    }
    assertNoMappedStaticTemplateExpressions(record.static.node, mapper);
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
      || (valueParent?.type === "SequenceExpression" && valueParent.expressions.at(-1) === value)
      || (valueParent?.type === "BinaryExpression" && valueParent.operator === "+")) {
      value = valueParent;
      valueParent = parents.get(value);
    }
    if (valueParent?.type !== "AssignmentExpression" || valueParent.right !== value
      || !isLocationUrlAssignment(valueParent.left)) return undefined;
    const property = memberName(valueParent.left);
    const locationReference = property === "hash" || property === "href"
      ? valueParent.left.object
      : valueParent.left;
    const root = browserRootIdentifier(locationReference);
    return resolveBinding(root.name, root.start) !== undefined
      ? undefined
      : valueParent;
  }

  function htmlAssignment(node) {
    let value = node;
    let valueParent = parents.get(value);
    while ((valueParent?.type === "ConditionalExpression"
        && (valueParent.consequent === value || valueParent.alternate === value))
      || (valueParent?.type === "LogicalExpression"
        && (valueParent.left === value || valueParent.right === value))
      || (valueParent?.type === "SequenceExpression" && valueParent.expressions.at(-1) === value)) {
      value = valueParent;
      valueParent = parents.get(value);
    }
    return valueParent?.type === "AssignmentExpression" && valueParent.right === value
      && valueParent.left.type === "MemberExpression"
      && (memberName(valueParent.left) === "innerHTML" || memberName(valueParent.left) === "outerHTML")
      ? { assignment: valueParent, proven: isProvenDomElement(valueParent.left.object) }
      : undefined;
  }

  function htmlInsertionCall(node) {
    let value = node;
    let valueParent = parents.get(value);
    while ((valueParent?.type === "ConditionalExpression"
        && (valueParent.consequent === value || valueParent.alternate === value))
      || (valueParent?.type === "LogicalExpression"
        && (valueParent.left === value || valueParent.right === value))
      || (valueParent?.type === "SequenceExpression" && valueParent.expressions.at(-1) === value)) {
      value = valueParent;
      valueParent = parents.get(value);
    }
    return valueParent?.type === "CallExpression" && memberName(valueParent.callee) === "insertAdjacentHTML"
      && valueParent.arguments[1] === value
      ? { call: valueParent, proven: isProvenDomElement(valueParent.callee.object) }
      : undefined;
  }

  function styleAssignment(node) {
    let value = node;
    let valueParent = parents.get(value);
    while ((valueParent?.type === "ConditionalExpression"
        && (valueParent.consequent === value || valueParent.alternate === value))
      || (valueParent?.type === "LogicalExpression"
        && (valueParent.left === value || valueParent.right === value))
      || (valueParent?.type === "SequenceExpression" && valueParent.expressions.at(-1) === value)) {
      value = valueParent;
      valueParent = parents.get(value);
    }
    if (valueParent?.type !== "AssignmentExpression" || valueParent.right !== value
      || valueParent.left.type !== "MemberExpression" || memberName(valueParent.left) !== "textContent") return undefined;
    return { assignment: valueParent, proven: isProvenStyleElement(valueParent.left.object) };
  }

  function isUnshadowedLocationReference(node) {
    if (!isLocationReference(node)) return false;
    const root = browserRootIdentifier(node);
    return resolveBinding(root.name, root.start) === undefined;
  }

  function browserRootIdentifier(node) {
    let root = node;
    while (root?.type === "MemberExpression") root = root.object;
    return root;
  }

  function isUnshadowedHistoryReference(node) {
    if (node?.type === "Identifier" && node.name === "history") {
      return resolveBinding(node.name, node.start) === undefined;
    }
    return memberName(node) === "history" && node.object?.type === "Identifier" && node.object.name === "window"
      && resolveBinding(node.object.name, node.object.start) === undefined;
  }

  function unshadowedDocument(node) {
    return isDocumentReference(node)
      && !((node.type === "Identifier" && resolveBinding(node.name, node.start) !== undefined)
        || (memberName(node) === "document" && node.object?.type === "Identifier"
          && resolveBinding(node.object.name, node.object.start) !== undefined));
  }

  function isProvenDomElement(node) {
    if (node?.type !== "CallExpression") return false;
    const method = memberName(node.callee);
    return (method === "getElementById" && isDomLookupCall(node, method) && unshadowedDocument(node.callee.object))
      || (method === "querySelector" && unshadowedDocument(node.callee.object));
  }

  function isProvenStyleElement(node) {
    const record = node?.type === "Identifier" ? resolveBinding(node.name, node.start) : undefined;
    if (record !== undefined && assignedBindings.has(record)) return false;
    const initializer = record?.styleElementInitializer ?? node;
    return initializer?.type === "CallExpression" && memberName(initializer.callee) === "createElement"
      && staticStringValue(initializer.arguments[0]) === "style" && unshadowedDocument(initializer.callee.object);
  }

  function mapCssValue(value) {
    return mapCssSelectors(value, ids, classes);
  }

  function staticConcatenationValue(node) {
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
    if (node.type !== "BinaryExpression" || node.operator !== "+") return undefined;
    const left = staticConcatenationValue(node.left);
    const right = staticConcatenationValue(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }

  function assertNoMappedStaticTemplateExpressions(node, mapper) {
    if (node.type !== "TemplateLiteral") return;
    for (const expression of node.expressions) {
      const value = staticConcatenationValue(expression);
      if (value !== undefined && mapper(value) !== value) {
        throw new Error("Static template interpolation is unsupported when selector mangling is enabled.");
      }
    }
  }

  function comparisonMapping(node) {
    const comparison = parents.get(node);
    if (comparison?.type !== "BinaryExpression" || !["==", "===", "!=", "!=="].includes(comparison.operator)) {
      return undefined;
    }
    const other = comparison.left === node ? comparison.right : comparison.right === node ? comparison.left : undefined;
    if (other?.type !== "MemberExpression") return undefined;
    const property = memberName(other);
    if ((property === "hash" || property === "href") && isUnshadowedLocationReference(other.object)) {
      return { comparison, mapper: (source) => mapFragmentValue(source, ids) };
    }
    if (property !== "id" && property !== "className") return undefined;
    const mapper = property === "id"
      ? (source) => Object.hasOwn(ids, source) ? ids[source] : source
      : (source) => replaceTokenList(source, classes);
    if (isProvenDomElement(other.object)) return { comparison, mapper };
    const value = staticStringValue(node);
    if ((value !== undefined && mapper(value) !== value) || node.type === "Identifier") {
      throw new Error(`Comparison against ambiguous ${property} receiver is unsupported when selector mangling is enabled.`);
    }
    return undefined;
  }

  function isMappedCallArgument(call, argument) {
    const method = memberName(call.callee);
    const indirectMethod = method === "call" ? memberName(call.callee.object) : undefined;
    return (selectorMethods.has(indirectMethod) && call.arguments[1] === argument)
      || ((selectorMethods.has(method) || (call.callee.type === "Identifier" && call.callee.name === "$"
          && resolveBinding("$", call.callee.start) === undefined))
        && call.arguments[0] === argument)
      || (isDomLookupCall(call, method) && unshadowedDocument(call.callee.object) && call.arguments[0] === argument)
      || (classListMethods.has(method) && isClassListTokenArgument(call, method, argument))
      || ((method === "assign" || method === "replace") && isUnshadowedLocationReference(call.callee.object)
        && call.arguments[0] === argument)
      || (method === "open" && call.callee.object?.type === "Identifier" && call.callee.object.name === "window"
        && call.arguments[0] === argument && resolveBinding("window", call.callee.object.start) === undefined)
      || (call.callee.type === "Identifier" && call.callee.name === "open" && call.arguments[0] === argument
        && resolveBinding("open", call.start) === undefined)
      || (setAttributeKind(call, argument) !== undefined && isProvenDomElement(call.callee.object))
      || (isHistoryUrlCall(call, argument) && isUnshadowedHistoryReference(call.callee.object));
  }

  function isProvenStringExpression(node) {
    if (typeof staticStringValue(node) === "string") return true;
    if (node?.type !== "Identifier") return false;
    const record = resolveBinding(node.name, node.start);
    return record?.static !== undefined && !assignedBindings.has(record);
  }

  function visit(node, parent) {
    if (node === null || typeof node !== "object") return;
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
      const property = memberName(node.left);
      const staticValue = staticStringValue(node.right);
      const ambiguousFragment = (property === "href" || property === "hash") && !isLocationReference(node.left.object)
        && Object.keys(ids).length > 0
        && (staticValue === undefined || mapFragmentValue(staticValue, ids) !== staticValue);
      const ambiguousIdentity = property === "id" && Object.keys(ids).length > 0
          && (staticValue === undefined || Object.hasOwn(ids, staticValue))
        || property === "className" && Object.keys(classes).length > 0
          && (staticValue === undefined || replaceTokenList(staticValue, classes) !== staticValue);
      if (ambiguousFragment || ambiguousIdentity) {
        throw new Error(`Assignment to ambiguous ${property} receiver is unsupported when selector mangling is enabled.`);
      }
    }
    if (node.type === "CallExpression" && memberName(node.callee) === "getElementsByClassName"
      && !isDomLookupCall(node, "getElementsByClassName") && Object.keys(classes).length > 0) {
      throw new Error("Element-scoped getElementsByClassName is unsupported when selector mangling is enabled.");
    }
    if (node.type === "CallExpression" && node.arguments.length > 1) {
      const attribute = setAttributeKind(node, node.arguments[1]);
      const mappedAttribute = attribute === "id" && Object.keys(ids).length > 0
        || attribute === "class" && Object.keys(classes).length > 0
        || attribute === "href" && Object.keys(ids).length > 0;
      if (mappedAttribute && !isProvenDomElement(node.callee.object)) {
        throw new Error("Ambiguous setAttribute receiver is unsupported when selector mangling is enabled.");
      }
    }
    if (node.type === "CallExpression" && memberName(node.callee) === "replace"
      && !isLocationReference(node.callee.object) && !isProvenStringExpression(node.callee.object)) {
      const source = staticStringValue(node.arguments[0]);
      const boundRule = node.arguments[0]?.type === "Identifier";
      if (boundRule || typeof source === "string" && (() => {
        const mapped = mapJavaScriptValue(source, { ...node, callee: { ...node.callee, property: { type: "Identifier",
          name: "replaceSync" } } }, node.arguments[0], ids, classes, selectorMethods, classListMethods);
        return mapped !== source;
      })()) throw new Error("Ambiguous stylesheet replace() receiver is unsupported when selector mangling is enabled.");
    }
    const selectorContext = selectorArgumentCall(node);
    const fragmentContext = fragmentAssignment(node);
    const comparisonContext = comparisonMapping(node);
    const htmlContext = htmlAssignment(node) ?? htmlInsertionCall(node);
    const styleContext = styleAssignment(node);
    if (node.type === "BinaryExpression" && staticConcatenationValue(node) !== undefined
      && ((selectorContext !== undefined && isMappedCallArgument(selectorContext.call, selectorContext.argument))
        || fragmentContext !== undefined)) {
      throw new Error("Split static selector concatenations are unsupported when selector mangling is enabled.");
    }
    if (node.type === "Literal" && typeof node.value !== "string" && selectorContext !== undefined
      && isMappedCallArgument(selectorContext.call, selectorContext.argument)) {
      throw new Error("Non-string DOM selector arguments are unsupported when selector mangling is enabled.");
    }
    if (node.type === "TemplateLiteral" && node.expressions.length > 0 && styleContext?.proven === true) {
      throw new Error("Interpolated runtime style assignments are unsupported when selector mangling is enabled.");
    } else if ((node.type === "Literal" || node.type === "TemplateLiteral") && styleContext !== undefined) {
      const source = staticStringValue(node);
      if (!styleContext.proven && source !== undefined && mapCssValue(source) !== source) {
        throw new Error("Assignment to ambiguous textContent receiver is unsupported when selector mangling is enabled.");
      }
      if (styleContext.proven) {
        assertNoMappedStaticTemplateExpressions(node, mapCssValue);
        replacements.push(...stringExpressionReplacements(node, mapCssValue));
      }
    } else if (node.type === "Identifier" && styleContext?.proven === true) {
      recordStaticBindingReplacement(node, mapCssValue);
    } else if (styleContext?.proven === true
      && !["ConditionalExpression", "LogicalExpression", "SequenceExpression"].includes(node.type)) {
      throw new Error(`Runtime style assignment expression ${node.type} is unsupported when selector mangling is enabled.`);
    } else if (node.type === "TemplateLiteral" && node.expressions.length > 0 && htmlContext !== undefined) {
      throw new Error("Interpolated runtime HTML assignments are unsupported when selector mangling is enabled.");
    } else if ((node.type === "Literal" || node.type === "TemplateLiteral") && htmlContext !== undefined) {
      const mapper = (source) => replaceHtmlSelectorReferences(source, ids, classes);
      const edits = stringExpressionReplacements(node, mapper);
      if (!htmlContext.proven && edits.length > 0) {
        throw new Error("Assignment to ambiguous runtime HTML receiver is unsupported when selector mangling is enabled.");
      }
      if (htmlContext.proven) replacements.push(...edits);
    } else if ((node.type === "Literal" || node.type === "TemplateLiteral") && comparisonContext !== undefined) {
      assertNoMappedStaticTemplateExpressions(node, comparisonContext.mapper);
      replacements.push(...stringExpressionReplacements(node, comparisonContext.mapper));
    } else if ((node.type === "Literal" || node.type === "TemplateLiteral") && selectorContext !== undefined
      && isMappedCallArgument(selectorContext.call, selectorContext.argument)) {
      const mapper = (source) => mapJavaScriptValue(source,
        selectorContext.call, selectorContext.argument, ids, classes, selectorMethods, classListMethods);
      assertNoMappedStaticTemplateExpressions(node, mapper);
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
      assertNoMappedStaticTemplateExpressions(node, (source) => mapFragmentValue(source, ids));
      const edits = stringExpressionReplacements(node, (source) => mapFragmentValue(source, ids));
      replacements.push(...edits);
    } else if (node.type === "Identifier" && htmlContext?.proven === true) {
      recordStaticBindingReplacement(node, (source) => replaceHtmlSelectorReferences(source, ids, classes));
    } else if (htmlContext !== undefined
      && !["ConditionalExpression", "LogicalExpression", "SequenceExpression"].includes(node.type)) {
      throw new Error(`Runtime HTML assignment expression ${node.type} is unsupported when selector mangling is enabled.`);
    } else if (node.type === "Identifier" && comparisonContext !== undefined) {
      recordStaticBindingReplacement(node, comparisonContext.mapper);
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
    } else if (fragmentContext !== undefined
      && !(node.type === "Identifier" && parent?.type === "BinaryExpression")
      && !["BinaryExpression", "ConditionalExpression", "LogicalExpression", "SequenceExpression"].includes(node.type)) {
      throw new Error(`Fragment expression ${node.type} is unsupported when selector mangling is enabled.`);
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
      const probe = "__cormier_selector_target_probe__";
      const targetExists = kind === "id"
        ? replaceSelector(css, "#", target, probe) !== css
          || replaceHtmlSelectorReferences(html, { [target]: probe }, {}) !== html
        : replaceSelector(css, ".", target, probe) !== css
          || replaceHtmlSelectorReferences(html, {}, { [target]: probe }) !== html;
      if (targetExists) {
        throw new Error(`${kind} selector mapping ${source} -> ${target} collides with an existing asset identity.`);
      }
      targets.add(target);
    }
  }

  let mappedCss = css;
  let mappedHtml = html;
  let mappedJavaScript = javascript;
  for (const [source, target] of Object.entries(selectorMangling.ids)) {
    mappedCss = replaceSelector(mappedCss, "#", source, target);
  }
  for (const [source, target] of Object.entries(selectorMangling.classes)) {
    mappedCss = replaceSelector(mappedCss, ".", source, target);
  }
  mappedHtml = replaceHtmlSelectorReferences(mappedHtml, selectorMangling.ids, selectorMangling.classes);
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
  const html = profile === "readable" ? `${referencedHtml.trimEnd()}\n` : `${(await minifyHtml(referencedHtml, {
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
  })).trimEnd()}\n`;

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
