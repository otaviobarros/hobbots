// The implicit-state check (STD-ARCH-013): a service keeps no lifecycle state in a Set or Map keyed by
// an id. Such a collection, held for the life of a service, is a state machine nobody declared: its
// legal combinations with the service's other collections are written nowhere (ADR 037).
//
// It flags a `new Set<…Id>` or `new Map<…Id, …>` declared at module level or directly in the body of
// a generator, the `Effect.gen(function* () { … })` that builds a service. A collection built and
// used inside one plain function, such as a fold, is not state and is not flagged. A deliberate case
// says why with `standards-allow STD-ARCH-013: <reason>` on its line or the line above.
//
// It also flags a comparison of a machine's state field outside the module that declares the machine:
// `task.state === "active"`, `["queued", "active"].includes(task.state)`, or a `switch` on `.state`
// with a case naming one of its states, through casts and destructuring too. Code elsewhere asks the machine, through `can` or a helper the
// module exports (STD-ARCH-013). Syntax alone does not know a value's type, so a machine is checked
// only in a file that imports its record or the machine, by name: a machine is named after its record
// (`Task`), so code that never names a Task, such as a socket's `.state === "running"`, is left alone.

import { parseSync, visitorKeys } from "oxc-parser";

const RULE = "STD-ARCH-013";
const KEYED_BY_ID = /Id$/;

const COLLECTIONS = new Set(["Set", "Map", "ReadonlySet", "ReadonlyMap"]);

/** The key type of a `Set<…>` or `Map<…>` type or constructor, when it is a type name ending in Id. */
const idKeyOf = (name, typeArguments) => {
  if (!COLLECTIONS.has(name)) return undefined;
  const first = typeArguments?.params?.[0];
  if (first?.type !== "TSTypeReference" || first.typeName?.type !== "Identifier") return undefined;
  return KEYED_BY_ID.test(first.typeName.name) ? first.typeName.name : undefined;
};

/**
 * The id type a declaration's collection is keyed by: from `new Set<…Id>()`, or from the declared
 * type, as in `const busy: Set<ThreadId> = new Set()`.
 */
const idKey = (declaration) => {
  const init = declaration.init;
  if (init?.type !== "NewExpression" || init.callee?.type !== "Identifier") return undefined;
  if (init.callee.name !== "Set" && init.callee.name !== "Map") return undefined;
  const declared = declaration.id?.typeAnnotation?.typeAnnotation;
  const fromType =
    declared?.type === "TSTypeReference" && declared.typeName?.type === "Identifier"
      ? idKeyOf(declared.typeName.name, declared.typeArguments)
      : undefined;
  return fromType ?? idKeyOf(init.callee.name, init.typeArguments);
};

const OPT_OUT = new RegExp(`^\\s*standards-allow ${RULE}:\\s*\\S`);

const isFunction = (node) =>
  node.type === "FunctionExpression" || node.type === "FunctionDeclaration" || node.type === "ArrowFunctionExpression";

const EQUALITY = new Set(["===", "!==", "==", "!="]);

/** A node without the wrappers that do not change its value: `(x)`, `x!`, `x as T`, `x satisfies T`, `x?.y`. */
const unwrapped = (node) =>
  node?.type === "ParenthesizedExpression" ||
  node?.type === "TSNonNullExpression" ||
  node?.type === "TSAsExpression" ||
  node?.type === "TSSatisfiesExpression" ||
  node?.type === "ChainExpression"
    ? unwrapped(node.expression)
    : node;

/**
 * The field a node reads, as in `task.state`, `task?.state` or `(task.state as string)`, or the name of
 * a binding named like a field, as in `const { state } = task`, or undefined.
 */
const fieldOf = (node) => {
  const inner = unwrapped(node);
  if (inner?.type === "Identifier") return inner.name;
  if (inner?.type !== "MemberExpression" || inner.computed || inner.property?.type !== "Identifier") return undefined;
  return inner.property.name;
};

const stringOf = (node) => {
  const inner = unwrapped(node);
  return inner?.type === "Literal" && typeof inner.value === "string" ? inner.value : undefined;
};

/** `["queued", "active"].includes(task.state)`: the array of a call to `includes` on a literal list. */
const listIncluding = (node) =>
  node.type === "CallExpression" &&
  node.callee?.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.property?.name === "includes" &&
  node.callee.object?.type === "ArrayExpression"
    ? node.callee.object
    : undefined;

/** The comparisons one node makes of a field with a string, as `[node, field, string]`. */
const comparedIn = (node) => {
  if (node.type === "BinaryExpression" && EQUALITY.has(node.operator)) {
    const left = fieldOf(node.left);
    if (left !== undefined) return [[node, left, stringOf(node.right)]];
    const right = fieldOf(node.right);
    return right === undefined ? [] : [[node, right, stringOf(node.left)]];
  }
  const list = listIncluding(node);
  if (list !== undefined) {
    const field = fieldOf(node.arguments?.[0]);
    return field === undefined ? [] : list.elements.map((each) => [node, field, stringOf(each)]);
  }
  if (node.type === "SwitchStatement") {
    const field = fieldOf(node.discriminant);
    return field === undefined ? [] : node.cases.map((each) => [each, field, stringOf(each.test)]);
  }
  return [];
};

/**
 * The problems in one file, as `file:line: message (STD-ARCH-013)`. `machines` lists each declared
 * machine as `{ name, exportName, field, states, module }`, for the state-comparison rule.
 */
export const checkFile = (file, text, machines = []) => {
  const { program, errors, comments } = parseSync(file, text);
  if (errors.length > 0) return [];
  const lineOf = (offset) => text.slice(0, offset).split("\n").length;
  // An opt-out is a real comment, with a reason, ending on the declaration's line or the line above.
  const optOutLines = new Set(
    (comments ?? []).filter((comment) => OPT_OUT.test(comment.value)).map((comment) => lineOf(comment.end)),
  );
  const problems = [];

  const walk = (node) => {
    if (node === null || typeof node !== "object" || typeof node.type !== "string") return;
    if (isFunction(node) && node.generator && node.body?.type === "BlockStatement") {
      statements(node.body.body);
      return;
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) walk(item);
      else walk(child);
    }
  };

  // Statements directly in the module or a generator's body: a collection declared here lives as long
  // as the service or the module.
  const statements = (list) => {
    for (const statement of list) {
      const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type !== "VariableDeclaration") {
        walk(statement);
        continue;
      }
      for (const each of declaration.declarations) {
        const key = idKey(each);
        if (key === undefined) {
          walk(each.init);
          continue;
        }
        const line = lineOf(each.start);
        if (optOutLines.has(line) || optOutLines.has(line - 1)) continue;
        problems.push(
          `${file}:${line}: \`${each.id?.name ?? "collection"}\` is a collection keyed by ${key} held for a service's or module's life; make it one explicit machine, or move a fold into a plain function (${RULE})`,
        );
      }
    }
  };

  statements(program.body);

  // Comparisons of a machine's state field outside the machine's own module. Syntax alone cannot tell
  // two machines with the same field and state apart, so a module that declares a machine with that
  // field and state may compare it: its own helpers stay legal, and every other module is checked.
  const imported = new Set(
    program.body
      .filter((statement) => statement.type === "ImportDeclaration")
      .flatMap((statement) => statement.specifiers ?? [])
      .map((specifier) => specifier.imported?.name ?? specifier.local?.name),
  );
  const inScope = machines.filter(
    (m) => m.module === file || imported.has(m.name) || (m.exportName !== undefined && imported.has(m.exportName)),
  );
  const holds = (machine, field, state) => machine.field === field && machine.states.includes(state);
  const machineOf = (field, state) => {
    if (state === undefined) return undefined;
    if (inScope.some((m) => m.module === file && holds(m, field, state))) return undefined;
    return inScope.find((m) => holds(m, field, state));
  };
  const compared = (node, field, state) => {
    const machine = machineOf(field, state);
    if (machine === undefined) return;
    const line = lineOf(node.start);
    if (optOutLines.has(line) || optOutLines.has(line - 1)) return;
    problems.push(
      `${file}:${line}: compares \`.${field}\` with "${state}", a state of the ${machine.name} machine in ${machine.module}; outside that module ask the machine, through \`can\` or a helper it exports, and a field of another lifecycle is declared as its own machine (${RULE})`,
    );
  };
  const comparisons = (node) => {
    if (node === null || typeof node !== "object" || typeof node.type !== "string") return;
    for (const [at, field, state] of comparedIn(node)) compared(at, field, state);
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) comparisons(item);
      else comparisons(child);
    }
  };
  if (inScope.length > 0) comparisons(program);
  return problems;
};

/** Every problem in `files`, read with `read`. */
export const check = (files, read, machines = []) => files.flatMap((file) => checkFile(file, read(file), machines));
