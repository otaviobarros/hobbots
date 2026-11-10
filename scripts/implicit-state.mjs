// The implicit-state check (STD-ARCH-013): a service keeps no lifecycle state in a Set or Map keyed by
// an id. Such a collection, held for the life of a service, is a state machine nobody declared: its
// legal combinations with the service's other collections are written nowhere (ADR 037).
//
// It flags a `new Set<…Id>` or `new Map<…Id, …>` declared at module level or directly in the body of
// a generator, the `Effect.gen(function* () { … })` that builds a service. A collection built and
// used inside one plain function, such as a fold, is not state and is not flagged. A deliberate case
// says why with `standards-allow STD-ARCH-013: <reason>` on its line or the line above.

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

/** The problems in one file, as `file:line: message (STD-ARCH-013)`. */
export const checkFile = (file, text) => {
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
  return problems;
};

/** Every problem in `files`, read with `read`. */
export const check = (files, read) => files.flatMap((file) => checkFile(file, read(file)));
