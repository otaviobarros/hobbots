// Measures the cyclomatic complexity of every function in a source file (STD-ARCH-012).
// The count follows ESLint's `complexity` rule, classic variant: a function starts at 1 and
// gains 1 for each branch point. Nested functions are measured on their own.

import { parseSync, visitorKeys } from "oxc-parser";

/** The marker that allows one function above the limit. A reason must follow the colon. */
export const IGNORE_MARKER = "complexity-ignore:";

const LOGICAL_ASSIGNMENT = new Set(["&&=", "||=", "??="]);
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const ALWAYS_BRANCH = new Set([
  "CatchClause",
  "ConditionalExpression",
  "LogicalExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "IfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "AssignmentPattern",
]);

/** Whether a node adds one path to the function that contains it. */
const isBranch = (node) => {
  if (ALWAYS_BRANCH.has(node.type)) return true;
  switch (node.type) {
    case "SwitchCase":
      return node.test !== null;
    case "AssignmentExpression":
      return LOGICAL_ASSIGNMENT.has(node.operator);
    case "MemberExpression":
    case "CallExpression":
      return node.optional === true;
    default:
      return false;
  }
};

/** Whether a node starts a new scope for counting, like a function or a class static block. */
const startsScope = (node, parentKey, parent) =>
  FUNCTION_TYPES.has(node.type) ||
  node.type === "StaticBlock" ||
  (parentKey === "value" && parent?.type === "PropertyDefinition");

const nameOf = (node, parent) => {
  if (node.type === "StaticBlock") return "class static block";
  if (node.id?.name) return node.id.name;
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if (parent?.type === "PropertyDefinition") return parent.key.name ?? "class field initializer";
  if ((parent?.type === "MethodDefinition" || parent?.type === "Property") && parent.key.type === "Identifier") {
    return parent.key.name;
  }
  return "anonymous function";
};

const lineStarts = (source) => {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
};

const lineOf = (starts, offset) => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
};

/**
 * Finds the ignore markers that allow a function starting on a given line. A marker allows
 * the function when it sits in the run of comment-only lines just above it.
 */
const markerAbove = (lines, markers, line) => {
  for (let at = line - 1; at >= 1; at--) {
    if (markers.has(at)) return at;
    const text = lines[at - 1].trim();
    const commentOnly = text.startsWith("//") || text.startsWith("/*") || text.startsWith("*");
    if (!commentOnly) return null;
  }
  return null;
};

/**
 * Measures every function in `source`. Each function carries its complexity and the line of
 * the marker that allows it, if any. Also returns every marker by line, and the parse errors.
 */
export const measure = (filename, source) => {
  const { program, comments, errors } = parseSync(filename, source);
  const starts = lineStarts(source);
  const lines = source.split("\n");
  const markers = new Map();
  for (const comment of comments) {
    const text = comment.value.trim();
    if (!text.startsWith(IGNORE_MARKER)) continue;
    markers.set(lineOf(starts, comment.end), text.slice(IGNORE_MARKER.length).trim());
  }

  const functions = [];
  const stack = [];
  const visit = (node, parentKey, parent) => {
    const scoped = startsScope(node, parentKey, parent);
    if (scoped) stack.push({ name: nameOf(node, parent), line: lineOf(starts, node.start), complexity: 1 });
    // A field initializer is both the scope and its first node, so its own branch counts too.
    if (stack.length > 0 && isBranch(node)) stack[stack.length - 1].complexity++;
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item) visit(item, key, node);
      } else if (child && typeof child.type === "string") visit(child, key, node);
    }
    if (scoped) functions.push(stack.pop());
  };
  visit(program, null, null);

  for (const fn of functions) {
    fn.markerLine = markerAbove(lines, markers, fn.line);
    fn.reason = fn.markerLine === null ? null : markers.get(fn.markerLine);
  }
  return { functions: functions.sort((a, b) => a.line - b.line), markers, errors };
};

/**
 * Checks one file against `max`. Returns problems as `{ line, message }`: functions above the
 * limit without a marker, markers without a reason, and markers that allow nothing.
 */
export const check = (filename, source, max) => {
  const { functions, markers, errors } = measure(filename, source);
  const problems = errors.map((error) => ({ line: 0, message: `cannot parse: ${error.message}` }));
  const used = new Set();
  for (const fn of functions) {
    if (fn.complexity <= max) continue;
    if (fn.markerLine === null) {
      problems.push({ line: fn.line, message: `${fn.name} has a complexity of ${fn.complexity} (max ${max})` });
    } else used.add(fn.markerLine);
  }
  for (const [line, reason] of markers) {
    if (!used.has(line)) problems.push({ line, message: "complexity-ignore allows no function above the limit" });
    else if (reason === "") problems.push({ line, message: "complexity-ignore needs a reason after the colon" });
  }
  return problems.sort((a, b) => a.line - b.line);
};
