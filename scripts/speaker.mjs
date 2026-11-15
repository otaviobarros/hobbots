// The speaker check (STD-ARCH-021): since a camp has one floor and many speakers (ADR 039), a
// channel's `agentId` names who the camp belongs to, never the hob a turn, a reply or a message is
// for. Code asks the turn's `Speaker`, the run's `speaking`, or a message's author (`authorOf`).
//
// It flags every read of `agentId` from a channel: `channel.agentId`, `channel.value.agentId`,
// `(yield* findChannel(id)).agentId`, `Option.getOrThrow(found).agentId`, and `const { agentId } =
// channel`, in a binding or a parameter. Syntax alone does not know a value's type, so a channel is:
// - a name that ends in "channel" (`channel`, `liveChannel`), or a call to one (`findChannel(id)`,
//   `channelOf(id)`), never `channelId`, `channels` or `channelMember`;
// - a binding of the file set from one, as `const found = yield* repo.findChannel(id)`;
// - a binding or parameter whose declared type names `Channel`.
// A read that means the owner says so with `standards-allow STD-ARCH-021: <reason>` on its line or
// the line above. The pure parts live here so scripts/speaker.test.mjs can feed them text;
// scripts/check-speaker.mjs reads the repository.

import { eachNode, parsedWithOptOuts } from "./implicit-state.mjs";

const RULE = "STD-ARCH-021";
/** A name that holds a channel, or a call that returns one: `channel`, `liveChannel`, `findChannel`, `channelOf`. */
const THREADISH = /channel$|^channelOf$/i;
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

/** Whether a declared type names a channel: `Channel`, `Option.Option<Channel>`, `Pick<Channel, "agentId">`. */
const namesChannel = (type) => {
  let found = false;
  eachNode(type, (node) => {
    if (node.type === "Identifier" && node.name === "Channel") found = true;
  });
  return found;
};

/**
 * Whether a node holds a channel: named like one, bound from one, an Option of one read through
 * `.value`, or unwrapped with `Option.getOrThrow`. `bound` holds the file's bindings that do.
 */
const isChannel = (node, bound) => {
  const inner = unwrapped(node);
  if (inner?.type === "MemberExpression" && !inner.computed && inner.property?.name === "value") {
    return isChannel(inner.object, bound);
  }
  if (inner?.type === "CallExpression" && UNWRAPS.has(nameOf(inner.callee))) {
    return isChannel(inner.arguments?.[0], bound);
  }
  if (inner?.type === "Identifier" && bound.has(inner.name)) return true;
  const name = nameOf(inner);
  return name !== undefined && THREADISH.test(name);
};

/** The names a file binds to a channel: from a value that holds one, or with a type that names one. */
const channelBindings = (program) => {
  const bound = new Set();
  eachNode(program, (node) => {
    const id = node.type === "VariableDeclarator" ? node.id : node.type === "Identifier" ? node : undefined;
    if (id?.type !== "Identifier") return;
    const typed = id.typeAnnotation !== undefined && id.typeAnnotation !== null && namesChannel(id.typeAnnotation);
    if (typed || (node.type === "VariableDeclarator" && isChannel(node.init, bound))) bound.add(id.name);
  });
  return bound;
};

/** Whether an object pattern takes `agentId` out of what it destructures. */
const takesAgentId = (pattern) =>
  pattern?.type === "ObjectPattern" &&
  pattern.properties.some((property) => property.type === "Property" && property.key?.name === "agentId");

/**
 * Whether a node reads `agentId` from a channel: `channel.agentId`, `const { agentId } = channel`, or a
 * parameter `({ agentId }: Channel)`.
 */
const readsChannelHob = (node, bound) =>
  (node.type === "MemberExpression" &&
    !node.computed &&
    node.property?.name === "agentId" &&
    isChannel(node.object, bound)) ||
  (node.type === "VariableDeclarator" && takesAgentId(node.id) && isChannel(node.init, bound)) ||
  (node.type === "ObjectPattern" &&
    takesAgentId(node) &&
    node.typeAnnotation != null &&
    namesChannel(node.typeAnnotation));

/** The problems in one file, as `file:line: message (STD-ARCH-021)`. */
export const checkFile = (file, text) => {
  const source = parsedWithOptOuts(file, text, RULE);
  if (source === null) return [];
  const { program, lineOf, optedOut } = source;
  const bound = channelBindings(program);
  const problems = [];
  eachNode(program, (node) => {
    if (!readsChannelHob(node, bound) || optedOut.has(lineOf(node.start))) return;
    problems.push(
      `${file}:${lineOf(node.start)}: reads a channel's \`agentId\`, which names who the camp belongs to, not who speaks: take the turn's Speaker, the run's \`speaking\` or the message's author (\`authorOf\`), or say why the owner is meant with "standards-allow ${RULE}: <reason>" (${RULE})`,
    );
  });
  return problems;
};

/** Every problem in `files`, read with `read`. */
export const check = (files, read) => files.filter(isChecked).flatMap((file) => checkFile(file, read(file)));
