// The speaker check (STD-ARCH-021): since a camp has one floor and many speakers (ADR 039), a
// thread's `agentId` names who the camp belongs to, never the hob a turn, a reply or a message is
// for. Code asks the turn's `Speaker`, the run's `speaking`, or a message's author (`authorOf`).
//
// It flags every read of `agentId` from a thread: `thread.agentId`, `thread.value.agentId`,
// `(yield* findThread(id)).agentId`, `Option.getOrThrow(found).agentId`, and `const { agentId } =
// thread`, in a binding or a parameter. Syntax alone does not know a value's type, so a thread is:
// - a name that ends in "thread" (`thread`, `liveThread`), or a call to one (`findThread(id)`,
//   `threadOf(id)`), never `threadId`, `threads` or `threadMember`;
// - a binding of the file set from one, as `const found = yield* repo.findThread(id)`;
// - a binding or parameter whose declared type names `Thread`.
// A read that means the owner says so with `standards-allow STD-ARCH-021: <reason>` on its line or
// the line above. The pure parts live here so scripts/speaker.test.mjs can feed them text;
// scripts/check-speaker.mjs reads the repository.

import { eachNode, parsedWithOptOuts } from "./implicit-state.mjs";

const RULE = "STD-ARCH-021";
/** A name that holds a thread, or a call that returns one: `thread`, `liveThread`, `findThread`, `threadOf`. */
const THREADISH = /thread$|^threadOf$/i;
/** Calls that hand back the value of an Option: `Option.getOrThrow(found)` holds what `found` holds. */
const UNWRAPS = new Set(["getOrThrow", "getOrNull", "getOrUndefined"]);

/** The source files the check reads: the hub's agents and the server, without tests and fakes. */
export const isChecked = (file) =>
  /^(?:packages\/agents\/src|apps\/server\/src)\//.test(file) &&
  /\.ts$/.test(file) &&
  !/\.test\.ts$/.test(file) &&
  !/\/(?:fake|testing)[^/]*\.ts$/.test(file);

/** A node without the wrappers that do not change its value: `(x)`, `x!`, `x as T`, `yield* x`, `await x`. */
const unwrapped = (node) =>
  node?.type === "ParenthesizedExpression" ||
  node?.type === "TSNonNullExpression" ||
  node?.type === "TSAsExpression" ||
  node?.type === "TSSatisfiesExpression" ||
  node?.type === "ChainExpression"
    ? unwrapped(node.expression)
    : node?.type === "YieldExpression" || node?.type === "AwaitExpression"
      ? unwrapped(node.argument)
      : node;

/** The name a node goes by: a binding, a field read, or the function a call calls. */
const nameOf = (node) => {
  const inner = unwrapped(node);
  if (inner?.type === "Identifier") return inner.name;
  if (inner?.type === "MemberExpression" && !inner.computed) return inner.property?.name;
  if (inner?.type === "CallExpression") return nameOf(inner.callee);
  return undefined;
};

/** Whether a declared type names a thread: `Thread`, `Option.Option<Thread>`, `Pick<Thread, "agentId">`. */
const namesThread = (type) => {
  let found = false;
  eachNode(type, (node) => {
    if (node.type === "Identifier" && node.name === "Thread") found = true;
  });
  return found;
};

/**
 * Whether a node holds a thread: named like one, bound from one, an Option of one read through
 * `.value`, or unwrapped with `Option.getOrThrow`. `bound` holds the file's bindings that do.
 */
const isThread = (node, bound) => {
  const inner = unwrapped(node);
  if (inner?.type === "MemberExpression" && !inner.computed && inner.property?.name === "value") {
    return isThread(inner.object, bound);
  }
  if (inner?.type === "CallExpression" && UNWRAPS.has(nameOf(inner.callee))) {
    return isThread(inner.arguments?.[0], bound);
  }
  if (inner?.type === "Identifier" && bound.has(inner.name)) return true;
  const name = nameOf(inner);
  return name !== undefined && THREADISH.test(name);
};

/** The names a file binds to a thread: from a value that holds one, or with a type that names one. */
const threadBindings = (program) => {
  const bound = new Set();
  eachNode(program, (node) => {
    const id = node.type === "VariableDeclarator" ? node.id : node.type === "Identifier" ? node : undefined;
    if (id?.type !== "Identifier") return;
    const typed = id.typeAnnotation !== undefined && id.typeAnnotation !== null && namesThread(id.typeAnnotation);
    if (typed || (node.type === "VariableDeclarator" && isThread(node.init, bound))) bound.add(id.name);
  });
  return bound;
};

/** Whether an object pattern takes `agentId` out of what it destructures. */
const takesAgentId = (pattern) =>
  pattern?.type === "ObjectPattern" &&
  pattern.properties.some((property) => property.type === "Property" && property.key?.name === "agentId");

/**
 * Whether a node reads `agentId` from a thread: `thread.agentId`, `const { agentId } = thread`, or a
 * parameter `({ agentId }: Thread)`.
 */
const readsThreadHob = (node, bound) =>
  (node.type === "MemberExpression" &&
    !node.computed &&
    node.property?.name === "agentId" &&
    isThread(node.object, bound)) ||
  (node.type === "VariableDeclarator" && takesAgentId(node.id) && isThread(node.init, bound)) ||
  (node.type === "ObjectPattern" &&
    takesAgentId(node) &&
    node.typeAnnotation != null &&
    namesThread(node.typeAnnotation));

/** The problems in one file, as `file:line: message (STD-ARCH-021)`. */
export const checkFile = (file, text) => {
  const source = parsedWithOptOuts(file, text, RULE);
  if (source === null) return [];
  const { program, lineOf, optedOut } = source;
  const bound = threadBindings(program);
  const problems = [];
  eachNode(program, (node) => {
    if (!readsThreadHob(node, bound) || optedOut.has(lineOf(node.start))) return;
    problems.push(
      `${file}:${lineOf(node.start)}: reads a thread's \`agentId\`, which names who the camp belongs to, not who speaks: take the turn's Speaker, the run's \`speaking\` or the message's author (\`authorOf\`), or say why the owner is meant with "standards-allow ${RULE}: <reason>" (${RULE})`,
    );
  });
  return problems;
};

/** Every problem in `files`, read with `read`. */
export const check = (files, read) => files.filter(isChecked).flatMap((file) => checkFile(file, read(file)));
