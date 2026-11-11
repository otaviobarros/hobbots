import { ApprovalRepository, GrantRepository, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ApprovalId,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  Message,
  MessageId,
  QuestId,
  TaskId,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  ApprovalRepositoryLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  migrations,
  TaskRepositoryLive,
} from "../src/index.ts";
import charmOperations from "../src/migrations/0071_charm_operations.ts";
import { TestDatabaseAt } from "../src/testing.ts";

// The GitHub Charm's operations and rules as they were stored before ADR 031, and as they read after it.

const now = "2026-11-07T00:00:00.000Z";
const agentId = AgentId.make("nettle");
const memberId = AgentId.make("quill");
const threadId = ThreadId.make("t1");
const messageId = MessageId.make("m1");
const project = "/work/project";
const repository = "otaviobarros/hobbots";

// Keeps 0076, 0079, 0080, 0082, 0083, 0084 and 0095 too: the repository that seeds the hobs writes their Charms, whether
// other hobs see them, their good at and who made and summoned them, and their Summoning scope, and seeds each thread
// with the draft it tries and its kind and state.
const before = Object.fromEntries(
  Object.entries(migrations).filter(
    ([key]) =>
      key < "0071" ||
      [
        "0076_charm_grants",
        "0079_hob_visibility",
        "0080_hob_good_at",
        "0082_hob_actors",
        "0083_summoning",
        "0084_thread_skill_trial",
        "0095_thread_kinds",
      ].includes(key),
  ),
) as typeof migrations;

const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: agentId,
      name: "Nettle",
      roleTitle: "Writer",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: now,
    }),
  );
  yield* repo.upsertThread(new Thread({ id: threadId, agentId, title: "t", createdAt: now, updatedAt: now }));
  yield* repo.upsertMessage(
    new Message({
      id: messageId,
      threadId,
      role: "assistant",
      content: "",
      status: "streaming",
      error: null,
      configVersion: 1,
      createdAt: now,
    }),
  );
});

/** Nettle leads a Quest and delegates a Task to Quill, so a Delegation row holds its authority. */
const delegated = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: memberId,
      name: "Quill",
      roleTitle: "Writer",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 2,
      lookColor: "moss",
      configVersion: 1,
      createdAt: now,
    }),
  );
  const tasks = yield* TaskRepository;
  const task = (id: string, ownerId: AgentId, parentId: string | null, at: string) => ({
    id: TaskId.make(id),
    ownerId,
    parentId: parentId === null ? null : TaskId.make(parentId),
    threadId,
    brief: `Brief for ${id}`,
    dependsOn: [],
    createdAt: at,
  });
  yield* tasks.createTask({ task: task("lead", agentId, null, now), delegation: null, milestones: [] });
  yield* tasks.startQuest({
    id: QuestId.make("q1"),
    taskId: TaskId.make("lead"),
    goal: "Ship it",
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    createdAt: now,
  });
  yield* tasks.createTask({
    task: task("member", memberId, "lead", "2026-11-07T00:00:01.000Z"),
    delegation: {
      id: DelegationId.make("d1"),
      brief: "Comment on the issue",
      expectedOutput: null,
      authority: { overrides: {}, folders: null },
      timeoutMs: null,
    },
    milestones: [],
  });
});

/** Rows as the hub wrote them before 0071: old operation names, and the PullRequest and GitHubComment rules. */
const oldRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const overrides = JSON.stringify({ push: "ask", "read-github": "deny", "comment-github": "ask" });
  yield* sql`UPDATE agents SET policy_overrides = ${overrides} WHERE id = ${agentId}`;
  yield* sql`UPDATE agent_config_versions SET policy_overrides = ${overrides} WHERE agent_id = ${agentId}`;
  const authority = JSON.stringify({
    overrides: { "open-pull-request": "deny", "comment-github": "ask", "edit-files": "ask" },
    folders: [project],
  });
  yield* sql`UPDATE delegations SET authority = ${authority} WHERE id = ${"d1"}`;
  const pullRequestRule = { _tag: "PullRequest", cwd: project, repository, base: "main" };
  const commentRule = { _tag: "GitHubComment", cwd: project, repository };
  for (const [id, operation, rules] of [
    ["a1", "open-pull-request", [pullRequestRule]],
    ["a2", "comment-github", [commentRule]],
    ["a3", "delete-files", []],
  ] as const) {
    yield* sql`INSERT INTO approval_requests ${sql.insert({
      id,
      agent_id: agentId,
      thread_id: threadId,
      message_id: messageId,
      step_id: `tool-${id}`,
      tool: "github_comment",
      operation,
      targets: JSON.stringify([`github.com/${repository} #324`]),
      arguments: JSON.stringify({ number: 324 }),
      label: "Commenting",
      reason: "The safety preset asks before commenting on GitHub.",
      action_digest: "d".repeat(64),
      policy_version: "r3-0123456789abcdef",
      state: "approved",
      lifetime: "always",
      grantable: 1,
      rules: JSON.stringify(rules),
      created_at: now,
      decided_at: now,
    })}`;
  }
  for (const [id, operation, rule] of [
    ["g1", "open-pull-request", pullRequestRule],
    ["g2", "comment-github", commentRule],
    ["g3", "push", { _tag: "Push", cwd: project, remote: "origin", branch: "feature" }],
  ] as const) {
    yield* sql`INSERT INTO grants ${sql.insert({
      id,
      agent_id: agentId,
      operation,
      rule: JSON.stringify(rule),
      lifetime: "always",
      granted_by: "user",
      created_at: now,
      revision: 1,
    })}`;
  }
});

const pullRequestSite = {
  _tag: "CharmSite",
  charm: "github",
  operation: "github.open-pull-request",
  cwd: project,
  site: { repository, base: "main" },
};
const commentSite = {
  _tag: "CharmSite",
  charm: "github",
  operation: "github.comment",
  cwd: project,
  site: { repository },
};

describe("0071_charm_operations", () => {
  // covers DP-003, PE-007
  it("[TC-DP-285] renames stored overrides, approvals and grants to the Charm's operations and rules, once", async () => {
    const result = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* delegated;
      yield* oldRows;
      yield* charmOperations;
      const once = {
        agents: yield* sql`SELECT policy_overrides FROM agents WHERE id = ${agentId}`,
        versions: yield* sql`SELECT policy_overrides FROM agent_config_versions WHERE agent_id = ${agentId}`,
        delegations: yield* sql`SELECT authority FROM delegations`,
        approvals: yield* sql`SELECT id, operation, rules FROM approval_requests ORDER BY id`,
        grants: yield* sql`SELECT id, operation, rule FROM grants ORDER BY id`,
      };
      // Run again, it changes nothing.
      yield* charmOperations;
      const twice = {
        agents: yield* sql`SELECT policy_overrides FROM agents WHERE id = ${agentId}`,
        versions: yield* sql`SELECT policy_overrides FROM agent_config_versions WHERE agent_id = ${agentId}`,
        delegations: yield* sql`SELECT authority FROM delegations`,
        approvals: yield* sql`SELECT id, operation, rules FROM approval_requests ORDER BY id`,
        grants: yield* sql`SELECT id, operation, rule FROM grants ORDER BY id`,
      };
      return {
        once,
        twice,
        agent: Option.getOrThrow(yield* (yield* HobbotsRepository).findAgent(agentId)),
        approval: Option.getOrThrow(yield* (yield* ApprovalRepository).find(ApprovalId.make("a1"))),
        grants: yield* (yield* GrantRepository).list(agentId),
        tree: Option.getOrThrow(yield* (yield* TaskRepository).readTree(TaskId.make("lead"))),
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(HobbotsRepositoryLive, ApprovalRepositoryLive, GrantRepositoryLive, TaskRepositoryLive).pipe(
          Layer.provideMerge(TestDatabaseAt(before)),
        ),
      ),
      Effect.runPromise,
    );

    const overrides = { push: "ask", "github.read": "deny", "github.comment": "ask" };
    expect(result.once.agents.map((row) => JSON.parse(String(row.policyOverrides)))).toEqual([overrides]);
    expect(result.once.versions.map((row) => JSON.parse(String(row.policyOverrides)))).toEqual([overrides]);
    expect(
      result.once.approvals.map((row) => ({
        id: row.id,
        operation: row.operation,
        rules: JSON.parse(String(row.rules)),
      })),
    ).toEqual([
      { id: "a1", operation: "github.open-pull-request", rules: [pullRequestSite] },
      { id: "a2", operation: "github.comment", rules: [commentSite] },
      { id: "a3", operation: "delete-files", rules: [] },
    ]);
    expect(
      result.once.grants.map((row) => ({
        id: row.id,
        operation: row.operation,
        rule: JSON.parse(String(row.rule)),
      })),
    ).toEqual([
      { id: "g1", operation: "github.open-pull-request", rule: pullRequestSite },
      { id: "g2", operation: "github.comment", rule: commentSite },
      { id: "g3", operation: "push", rule: { _tag: "Push", cwd: project, remote: "origin", branch: "feature" } },
    ]);
    expect(result.once.delegations.map((row) => JSON.parse(String(row.authority)))).toEqual([
      {
        overrides: { "github.open-pull-request": "deny", "github.comment": "ask", "edit-files": "ask" },
        folders: [project],
      },
    ]);
    expect(result.twice).toEqual(result.once);
    // The hob reads its Charm overrides apart from its built-in ones, with the same answers.
    expect(result.agent.policy).toMatchObject({
      overrides: { push: "ask" },
      charms: { overrides: { "github.read": "deny", "github.comment": "ask" } },
    });
    expect(result.agent.policy.overrides).not.toHaveProperty("read-github");
    // The Delegation reads its authority under the new names, as a restriction on the member.
    expect(result.tree.delegations.map((delegation) => delegation.authority)).toEqual([
      {
        overrides: { "github.open-pull-request": "deny", "github.comment": "ask", "edit-files": "ask" },
        folders: [project],
      },
    ]);
    expect(result.approval).toMatchObject({ operation: "github.open-pull-request", rules: [pullRequestSite] });
    expect(result.grants.map((grant) => grant.rule)).toEqual([
      pullRequestSite,
      commentSite,
      { _tag: "Push", cwd: project, remote: "origin", branch: "feature" },
    ]);
  });

  // covers DP-003, DP-051
  it("[TC-DP-286] still reads hob, approval and grant events journaled before it, under the new names", async () => {
    const agent = {
      id: "nettle",
      name: "Nettle",
      role: "writer",
      roleTitle: "Writer",
      sigil: "writer",
      hat: null,
      tool: null,
      voice: "default",
      length: "balanced",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      status: "active",
      retiredAt: null,
      configVersion: 1,
      createdAt: now,
      revision: 1,
      policy: {
        ownFolders: [],
        hiddenSharedFolders: [],
        overrides: { "edit-files": "ask", "open-pull-request": "deny" },
      },
    };
    const grant = {
      id: "g1",
      agentId: "nettle",
      operation: "open-pull-request",
      rule: { _tag: "PullRequest", cwd: project, repository, base: "main" },
      lifetime: "always",
      taskId: null,
      approvalId: "a1",
      grantedBy: "user",
      createdAt: now,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      revision: 1,
    };
    const approval = {
      id: "a2",
      agentId: "nettle",
      threadId: "t1",
      messageId: "m1",
      stepId: "tool-a2",
      tool: "github_comment",
      operation: "comment-github",
      targets: [`github.com/${repository} #324`],
      arguments: { number: 324 },
      label: "Commenting",
      reason: "The safety preset asks before commenting on GitHub.",
      actionDigest: "d".repeat(64),
      policyVersion: "r3-0123456789abcdef",
      state: "pending",
      denyReason: null,
      createdAt: now,
      decidedAt: null,
      revision: 1,
      grantable: true,
      rules: [{ _tag: "GitHubComment", cwd: project, repository }],
    };
    const events = [
      ["AgentUpserted", { _tag: "AgentUpserted", agent }],
      ["GrantCreated", { _tag: "GrantCreated", grant }],
      [
        "GrantRevoked",
        {
          _tag: "GrantRevoked",
          grant: { ...grant, revokedAt: now, revokedBy: "hub", revokeReason: "github-identity", revision: 2 },
        },
      ],
      ["ApprovalRequested", { _tag: "ApprovalRequested", approval }],
      ["ApprovalResolved", { _tag: "ApprovalResolved", approval: { ...approval, state: "denied", decidedAt: now } }],
    ] as const;
    const entries = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE event_journal_head SET sequence = ${events.length} WHERE id = 1`;
      for (const [index, [type, payload]] of events.entries()) {
        yield* sql`INSERT INTO event_journal ${sql.insert({
          sequence: index + 1,
          id: `6e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5${index}`,
          type,
          schemaVersion: 1,
          occurredAt: now,
          agentId: "nettle",
          payload: JSON.stringify(payload),
        })}`;
      }
      yield* charmOperations;
      return yield* (yield* EventJournal).readAfter(0);
    }).pipe(
      Effect.provide(EventJournal.layer.pipe(Layer.provideMerge(TestDatabaseAt(before)))),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(entries.map((entry) => entry.payload)).toMatchObject([
      {
        _tag: "AgentUpserted",
        agent: {
          policy: { overrides: { "edit-files": "ask" }, charms: { overrides: { "github.open-pull-request": "deny" } } },
        },
      },
      { _tag: "GrantCreated", grant: { operation: "github.open-pull-request", rule: pullRequestSite } },
      { _tag: "GrantRevoked", grant: { operation: "github.open-pull-request", rule: pullRequestSite } },
      { _tag: "ApprovalRequested", approval: { operation: "github.comment", rules: [commentSite] } },
      { _tag: "ApprovalResolved", approval: { operation: "github.comment", rules: [commentSite], state: "denied" } },
    ]);
  });

  // covers DP-003, DP-051
  it("[TC-DP-288] still reads a Delegation journaled before it, its authority under the new names", async () => {
    const created = await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* delegated;
      // The member's TaskCreated entry, as the hub journaled it before 0071: the old operation names.
      const [row] = yield* sql<{ readonly sequence: number; readonly payload: string }>`
        SELECT sequence, payload FROM event_journal WHERE type = ${"TaskCreated"} ORDER BY sequence DESC`;
      if (row === undefined) return yield* Effect.die("no TaskCreated entry");
      const payload = JSON.parse(row.payload);
      payload.delegation.authority = {
        overrides: { "open-pull-request": "deny", "comment-github": "ask", "edit-files": "ask" },
        folders: [project],
      };
      yield* sql`UPDATE event_journal SET payload = ${JSON.stringify(payload)} WHERE sequence = ${row.sequence}`;
      yield* charmOperations;
      const entries = yield* (yield* EventJournal).readAfter(0);
      return entries.map((entry) => entry.payload).filter((event) => event._tag === "TaskCreated");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(HobbotsRepositoryLive, TaskRepositoryLive, EventJournal.layer).pipe(
          Layer.provideMerge(TestDatabaseAt(before)),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(created.at(-1)).toMatchObject({
      _tag: "TaskCreated",
      delegation: {
        authority: {
          overrides: { "github.open-pull-request": "deny", "github.comment": "ask", "edit-files": "ask" },
          folders: [project],
        },
      },
    });
  });
});
