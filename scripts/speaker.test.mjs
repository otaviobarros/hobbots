import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFile, isChecked } from "./speaker.mjs";

/** `body` inside a generator, where `yield*` parses. */
const gen = (body) => `function* run() {\n  ${body}\n}`;

// covers #1549 (STD-ARCH-021)
test("a thread's agentId read as the hob of a turn fails (#1549)", () => {
  const problems = checkFile("a.ts", "const hob = thread.agentId;");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^a\.ts:1: reads a thread's `agentId`.*\(STD-ARCH-021\)$/);
});

test("an Option of a thread, a found thread and a destructured agentId fail too", () => {
  assert.equal(checkFile("a.ts", "const hob = thread.value.agentId;").length, 1);
  assert.equal(checkFile("a.ts", "const hob = liveThread.agentId;").length, 1);
  assert.equal(checkFile("a.ts", gen("const hob = (yield* findThread(id)).agentId;")).length, 1);
  assert.equal(checkFile("a.ts", gen("const { agentId } = yield* findThread(id);")).length, 1);
  assert.equal(checkFile("a.ts", "const { agentId, title } = thread;").length, 1);
});

test("a binding set from a thread, a typed parameter and an unwrapped Option fail too", () => {
  assert.equal(
    checkFile("a.ts", gen("const found = yield* repo.findThread(id);\n  use(found.value.agentId);")).length,
    1,
  );
  assert.equal(checkFile("a.ts", "const owner = (t: Thread) => t.agentId;").length, 1);
  assert.equal(checkFile("a.ts", "const owner = (t: Option.Option<Thread>) => t.value.agentId;").length, 1);
  assert.equal(checkFile("a.ts", "const owner = Option.getOrThrow(liveThread).agentId;").length, 1);
  assert.equal(checkFile("a.ts", "const owner = ({ agentId }: Thread) => agentId;").length, 1);
});

test("an agentId of something that is not a thread passes", () => {
  assert.deepEqual(checkFile("a.ts", "const hob = threadMember.agentId;"), []);
  assert.deepEqual(checkFile("a.ts", "const hob = threadTask.agentId;"), []);
  assert.deepEqual(checkFile("a.ts", "const found = attempts[0];\nconst hob = found.agentId;"), []);
  assert.deepEqual(checkFile("a.ts", "const hob = turn.agentId;"), []);
  assert.deepEqual(checkFile("a.ts", "const hob = scope.agentId;"), []);
  assert.deepEqual(checkFile("a.ts", "const ids = threads.map((each) => each.agentId);"), []);
  assert.deepEqual(checkFile("a.ts", "const { agentId } = request;"), []);
});

test("an owner read that says why passes, on its line or the line above", () => {
  const above = "// standards-allow STD-ARCH-021: the camp's lock is its owner's\nlock(thread.agentId);";
  assert.deepEqual(checkFile("a.ts", above), []);
  assert.deepEqual(checkFile("a.ts", "lock(thread.agentId); // standards-allow STD-ARCH-021: owner, not speaker"), []);
});

test("an opt-out with no reason, or of another rule, still fails", () => {
  assert.equal(checkFile("a.ts", "// standards-allow STD-ARCH-021:\nlock(thread.agentId);").length, 1);
  assert.equal(checkFile("a.ts", "// standards-allow STD-ARCH-013: a reason\nlock(thread.agentId);").length, 1);
});

test("only the agents' and the server's sources are read, without tests and fakes", () => {
  assert.equal(isChecked("packages/agents/src/chat.ts"), true);
  assert.equal(isChecked("apps/server/src/http.ts"), true);
  assert.equal(isChecked("packages/agents/test/chat.test.ts"), false);
  assert.equal(isChecked("apps/server/src/fake-quest.ts"), false);
  assert.equal(isChecked("packages/domain/src/message.ts"), false);
  assert.equal(isChecked("apps/web/src/lib/reply-author.ts"), false);
});
