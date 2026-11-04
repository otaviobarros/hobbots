// The frontend checks that read a file's syntax tree: component size and depth, class names and
// locale formatting. scripts/frontend.mjs runs them together with the checks that read plain text.

import { parseSync, visitorKeys } from "oxc-parser";

const WEB = "apps/web/src/";
const COMPONENTS = `${WEB}components/`;
const FORMATTERS = new Set([`${WEB}lib/format.ts`, `${WEB}lib/time.ts`]);
const PRIMITIVES = /^@hobbots\/ui\/components\//;
const MAX_LINES = 250;
const MAX_DEPTH = 6;

/** Whether a `standards-allow <rule>:` comment sits on `line` (1-based) or the line above. */
const allowedAt = (lines, line, rule) => {
  const marker = `standards-allow ${rule}:`;
  return (lines[line - 1] ?? "").includes(marker) || (lines[line - 2] ?? "").includes(marker);
};

const allowedInFile = (text, rule) => text.includes(`standards-allow ${rule}:`);

/** Calls `visit(node, parent)` on every node under `root`, parents first. */
const walk = (root, visit) => {
  const step = (node, parent) => {
    if (node === null || typeof node !== "object" || typeof node.type !== "string") return;
    if (visit(node, parent) === false) return;
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) step(item, node);
      else step(child, node);
    }
  };
  step(root, null);
};

/** How many JSX elements deep the deepest one sits, and where it starts. */
const jsxDepth = (program) => {
  let deepest = { depth: 0, start: 0 };
  const step = (node, depth) => {
    if (node === null || typeof node !== "object" || typeof node.type !== "string") return;
    const isElement = node.type === "JSXElement" || node.type === "JSXFragment";
    const here = isElement ? depth + 1 : depth;
    if (here > deepest.depth) deepest = { depth: here, start: node.start };
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) step(item, here);
      else step(child, here);
    }
  };
  step(program, 0);
  return deepest;
};

/** A `.tsx` file stays at most 250 lines long and 6 JSX elements deep (STD-REACT-006). */
const size = (file, text, program, lineOf) => {
  if (!file.endsWith(".tsx") || allowedInFile(text, "STD-REACT-006")) return [];
  const problems = [];
  const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  if (lines > MAX_LINES)
    problems.push(`${file}: split the file, it has ${lines} lines and the limit is ${MAX_LINES} (STD-REACT-006)`);
  const { depth, start } = jsxDepth(program);
  if (depth > MAX_DEPTH)
    problems.push(
      `${file}:${lineOf(start)}: move this JSX into a component, it nests ${depth} elements deep and the limit is ${MAX_DEPTH} (STD-REACT-006)`,
    );
  return problems;
};

/** No `.tsx` file sits at the root of the web app's components folder (STD-REACT-005). */
const featureFolder = (file) =>
  file.startsWith(COMPONENTS) && file.endsWith(".tsx") && !file.slice(COMPONENTS.length).includes("/")
    ? [`${file}: move the component into a feature folder under components/ (STD-REACT-005)`]
    : [];

const holdsClasses = (node) =>
  (node.type === "Literal" && typeof node.value === "string") ||
  node.type === "TemplateLiteral" ||
  node.type === "ObjectExpression";

/** The class name strings inside an expression: literals, template parts and the branches around them. */
const classStrings = (node) => {
  const strings = [];
  walk(node, (child) => {
    if (child.type === "Literal" && typeof child.value === "string") strings.push({ value: child.value, at: child });
    else if (child.type === "TemplateElement")
      strings.push({ value: child.value.cooked ?? child.value.raw, at: child });
    // A comparison or a lookup key is not a class name.
    else if (child.type === "BinaryExpression" || child.type === "MemberExpression") return false;
    // In `{ "ms-2": isOpen }` the class is the key, not the condition.
    else if (child.type === "Property" && child.key.type === "Literal" && !holdsClasses(child.value)) {
      strings.push({ value: String(child.key.value), at: child.key });
      return false;
    }
  });
  return strings;
};

/** The utility of a Tailwind class with its variants, important mark and minus sign taken off. */
const utility = (token) => {
  let depth = 0;
  let last = 0;
  for (let index = 0; index < token.length; index++) {
    if (token[index] === "[" || token[index] === "(") depth++;
    else if (token[index] === "]" || token[index] === ")") depth--;
    else if (token[index] === ":" && depth === 0) last = index + 1;
  }
  return token.slice(last).replace(/^!|!$/g, "").replace(/^-/, "");
};

const tokens = (value) => value.split(/\s+/).filter(Boolean);

const PHYSICAL =
  /^(?:(?:m|p|scroll-m|scroll-p)[lr]|left|right|border-[lr]|rounded-(?:[lr]|[tb][lr]))(?:-|$)|^text-(?:left|right)$/;

const CLASS_CALLS = new Set(["cn", "cva", "clsx", "twMerge"]);

/** The expressions that hold class names: className values and props, and arguments of cn and cva. */
const classExpressions = (program) => {
  const found = [];
  walk(program, (node) => {
    if (node.type === "JSXAttribute" && node.name.name === "className" && node.value) found.push(node.value);
    else if (node.type === "Property" && !node.computed && (node.key.name ?? node.key.value) === "className")
      found.push(node.value);
    else if (node.type === "CallExpression" && CLASS_CALLS.has(node.callee.name)) found.push(...node.arguments);
  });
  return found;
};

/** Class names use the logical side, so the layout mirrors in right-to-left scripts (STD-I18N-004). */
const logicalClasses = (file, lines, program, lineOf) => {
  const problems = [];
  const seen = new Set();
  for (const expression of classExpressions(program))
    for (const { value, at } of classStrings(expression)) {
      if (seen.has(at)) continue;
      seen.add(at);
      const line = lineOf(at.start);
      if (allowedAt(lines, line, "STD-I18N-004")) continue;
      for (const token of tokens(value))
        if (PHYSICAL.test(utility(token)))
          problems.push(
            `${file}:${line}: use the logical class for "${token}", such as ms-/me-, ps-/pe- or start-/end- (STD-I18N-004)`,
          );
    }
  return problems;
};

const LAYOUT =
  /^(?:m[xytbse]?|w|h|size|min-w|min-h|max-w|max-h|basis|order|self|justify-self|place-self|col|row|inset(?:-[xy])?|top|bottom|start|end|left|right|translate(?:-[xy])?|z)-|^(?:flex-(?:1|auto|initial|none)|grow|grow-0|shrink|shrink-0|static|fixed|absolute|relative|sticky|hidden|contents)$/;

/** The names that the file imports from the design system's components. */
const primitiveNames = (program) => {
  const names = new Set();
  for (const statement of program.body)
    if (statement.type === "ImportDeclaration" && PRIMITIVES.test(statement.source.value))
      for (const specifier of statement.specifiers) names.add(specifier.local.name);
  return names;
};

const elementName = (name) =>
  name.type === "JSXMemberExpression" ? `${elementName(name.object)}.${name.property.name}` : name.name;

const elementRoot = (name) => (name.type === "JSXMemberExpression" ? elementRoot(name.object) : name.name);

/** A className passed to a design system primitive holds only layout classes (STD-UI-010). */
const primitiveClasses = (file, lines, program, lineOf) => {
  const primitives = primitiveNames(program);
  if (primitives.size === 0) return [];
  const problems = [];
  walk(program, (node) => {
    if (node.type !== "JSXOpeningElement" || !primitives.has(elementRoot(node.name))) return;
    for (const attribute of node.attributes) {
      if (attribute.type !== "JSXAttribute" || attribute.name.name !== "className" || !attribute.value) continue;
      for (const { value, at } of classStrings(attribute.value)) {
        const line = lineOf(at.start);
        if (allowedAt(lines, line, "STD-UI-010")) continue;
        const looks = tokens(value).filter((token) => !LAYOUT.test(utility(token)));
        if (looks.length > 0)
          problems.push(
            `${file}:${line}: give ${elementName(node.name)} a variant for "${looks.join(" ")}", a className passed to a primitive holds layout classes only (STD-UI-010)`,
          );
      }
    }
  });
  return problems;
};

const isComponentName = (name) => typeof name === "string" && /^[A-Z]/.test(name);

const hasClassName = (members) =>
  members.some(
    (member) =>
      (member.type === "TSPropertySignature" && (member.key.name ?? member.key.value) === "className") ||
      (member.type === "Property" && (member.key.name ?? member.key.value) === "className"),
  );

/** The name a function component is known by, from its declaration or the variable it is assigned to. */
const functionName = (node, parent) => node.id?.name ?? (parent?.type === "VariableDeclarator" ? parent.id.name : null);

const FUNCTIONS = new Set(["FunctionDeclaration", "ArrowFunctionExpression", "FunctionExpression"]);

/** The members of a `…Props` interface or object type, with its name. */
const typeProps = (node) => {
  if (!node.id?.name?.endsWith("Props")) return null;
  if (node.type === "TSInterfaceDeclaration") return { name: node.id.name, members: node.body.body };
  if (node.type === "TSTypeAliasDeclaration" && node.typeAnnotation.type === "TSTypeLiteral")
    return { name: node.id.name, members: node.typeAnnotation.members };
  return null;
};

/** The members that a component's first parameter destructures or types inline, with its name. */
const componentProps = (node, parent) => {
  const name = functionName(node, parent);
  if (!FUNCTIONS.has(node.type) || !isComponentName(name)) return null;
  const param = node.params[0];
  const literal = param?.typeAnnotation?.typeAnnotation;
  const typed = literal?.type === "TSTypeLiteral" ? literal.members : [];
  const destructured = param?.type === "ObjectPattern" ? param.properties : [];
  return { name, members: [...destructured, ...typed] };
};

const propsOf = (node, parent) => typeProps(node) ?? componentProps(node, parent);

/** Feature components take no className prop, so a screen cannot restyle them (STD-UI-010). */
const featureClassName = (file, lines, program, lineOf) => {
  const problems = [];
  const report = (start, name) => {
    const line = lineOf(start);
    if (!allowedAt(lines, line, "STD-UI-010"))
      problems.push(
        `${file}:${line}: take the className prop off ${name}, feature components set their own look (STD-UI-010)`,
      );
  };
  walk(program, (node, parent) => {
    const props = propsOf(node, parent);
    if (props !== null && hasClassName(props.members)) report(node.start, props.name);
  });
  return problems;
};

const FORMAT_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);

/** Dates and numbers are formatted only by the shared locale formatters (STD-I18N-003). */
const localeFormatting = (file, lines, program, lineOf) => {
  if (FORMATTERS.has(file)) return [];
  const problems = [];
  walk(program, (node) => {
    const formats =
      (node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        FORMAT_METHODS.has(node.callee.property.name)) ||
      (node.type === "NewExpression" && node.callee.type === "MemberExpression" && node.callee.object.name === "Intl");
    const line = formats ? lineOf(node.start) : 0;
    if (formats && !allowedAt(lines, line, "STD-I18N-003"))
      problems.push(`${file}:${line}: format through apps/web/src/lib/format.ts or time.ts (STD-I18N-003)`);
  });
  return problems;
};

const lineStarts = (text) => {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
  return starts;
};

/** Returns one message per problem in a web, UI or desktop source file. */
export const checkSource = (file, text) => {
  const { program, errors } = parseSync(file, text);
  if (errors.length > 0) return [`${file}: could not parse the file: ${errors[0].message}`];
  const starts = lineStarts(text);
  const lineOf = (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const lines = text.split("\n");
  const problems = [...localeFormatting(file, lines, program, lineOf)];
  if (file.startsWith("apps/desktop/")) return problems;
  problems.push(...size(file, text, program, lineOf), ...logicalClasses(file, lines, program, lineOf));
  if (file.startsWith(WEB))
    problems.push(
      ...featureFolder(file),
      ...featureClassName(file, lines, program, lineOf),
      ...primitiveClasses(file, lines, program, lineOf),
    );
  return problems;
};
