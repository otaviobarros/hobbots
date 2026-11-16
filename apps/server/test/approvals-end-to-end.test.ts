import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PermissionSummary,
  SecretRedaction,
} from "@hobbots/agents";
import {
  type Agent,
  type ApprovalRequest,
  type Channel,
  type Grant,
  isInProgress,
  type Message,
  type ReplyStep,
  roleFields,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Clock, type Duration, Effect, Layer, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { ToolLogsLive } from "../src/tool-logs.ts";
import { HobToolsLive } from "../src/tools.ts";
import { movableClock } from "./movable-clock.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Slice 8's done-when checks (ADR 015), at hub level and over the HTTP API, with the hub's own
// composition: the setup's preset and folders read at every turn, one policy engine, grants, and
// the fake runtime making the scripted tool calls. CI runs them on SQLite and on PostgreSQL. The
// browser side is in apps/web/e2e/approvals.e2e.ts.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-approvals-e2e-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
const dataDir = join(temp, "hub", "data");
mkdirSync(project, { recursive: true });
mkdirSync(dataDir, { recursive: true });

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let advanceClock: (duration: Duration.Input) => void;

beforeEach(() => {
  const time = movableClock();
  advanceClock = time.advance;
  const App = HobLifecycle.layer
    .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer)))
    .pipe(Layer.provideMerge(ChatService.layer))
    .pipe(Layer.provideMerge(ApprovalService.layer))
    .pipe(Layer.provideMerge(GrantService.layer))
    .pipe(Layer.provideMerge(HobToolsLive))
    .pipe(Layer.provideMerge(CanonicalSharedFolders))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mergeAll(
            HobbotsRepositoryLive,
            ApprovalRepositoryLive,
            GrantRepositoryLive,
            TaskRepositoryLive,
            EventJournal.layer,
            BackpackLive,
            SetupRepository.layer,
            SearchIndex.layer,
          ).pipe(Layer.provideMerge(TestDatabase)),
          EventBus.layer,
          HobAdmission.layer,
          NodeFolderChecks,
          FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)),
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
          SecretRedaction.layer([]),
          ToolLogsLive(join(dataDir, "tool-logs")),
        ),
      ),
    );
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide(TestDevices),
      Layer.provide(App),
      Layer.provide(NodeHttpServer.layerHttpServices),
      Layer.provide(Layer.succeed(Clock.Clock, time.clock)),
    ),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});
afterEach(() => dispose());

const request = async <A>(method: string, path: string, body?: unknown): Promise<{ status: number; body: A }> => {
  const response = await handler(
    new Request(`http://localhost:4364${path}`, {
      method,
      // As the hub's window, so approvals and grants answer the user (PE-006).
      headers: { "content-type": "application/json", host: "localhost:4364", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const eventually = <A>(read: () => Promise<A | undefined>) =>
  Effect.runPromise(
    Effect.tryPromise(read).pipe(
      Effect.flatMap((value) => (value === undefined ? Effect.fail("waiting" as const) : Effect.succeed(value))),
      Effect.retry(Schedule.spaced("5 millis")),
    ),
  );

const forChannel = async (channel: Channel) =>
  (await request<ReadonlyArray<ApprovalRequest>>("GET", `/api/channels/${channel.id}/approvals`)).body;

/** The Inbox's list: every pending request and the most recently closed ones. */
const inbox = async () => (await request<ReadonlyArray<ApprovalRequest>>("GET", "/api/approvals")).body;

/** Every rule as History lists it, live and removed. */
const history = async () => (await request<ReadonlyArray<Grant>>("GET", "/api/grants?include=all")).body;

const decide = (approval: ApprovalRequest, decision: Record<string, unknown>) =>
  request<ApprovalRequest & { readonly _tag?: string }>("POST", `/api/approvals/${approval.id}/decision`, {
    actionDigest: approval.actionDigest,
    ...decision,
  });

const toolSteps = (reply: Message): ReadonlyArray<ReplyStep> => reply.steps.filter((step) => step.kind === "tool");

/** An installation on Balanced sharing the project folder, with one hob. */
const hobInProject = async () => {
  await request("PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [project] });
  const hob = await request<Agent>("POST", "/api/agents", {
    name: "Pip",
    ...roleFields("writer"),
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  return hob.body;
};

/** Sends the command in a new channel of the hob: the request it waits on, or its finished reply. */
const runCommand = async (hob: Agent, line: string) => {
  const channel = (await request<Channel>("POST", `/api/agents/${hob.id}/channels`)).body;
  const sent = await request("POST", `/api/channels/${channel.id}/messages`, { content: `Go\nfake:tool Bash ${line}` });
  expect(sent.status).toBe(200);
  return eventually(async () => {
    const pending = (await forChannel(channel)).find((approval) => approval.state === "pending");
    if (pending) return { channel, pending, reply: undefined };
    const reply = (await request<ReadonlyArray<Message>>("GET", `/api/channels/${channel.id}/messages`)).body.at(-1);
    return reply?.role === "assistant" && !isInProgress(reply.status)
      ? { channel, pending: undefined, reply }
      : undefined;
  });
};

/** Waits until the channel's reply has ended. */
const settled = (channel: Channel) =>
  eventually(async () => {
    const reply = (await request<ReadonlyArray<Message>>("GET", `/api/channels/${channel.id}/messages`)).body.at(-1);
    return reply?.role === "assistant" && !isInProgress(reply.status) ? reply : undefined;
  });

describe("approvals, end to end", () => {
  it("an Always rule shows in History, runs the next matching action without asking, and once removed the next one asks", async () => {
    const hob = await hobInProject();
    const first = await runCommand(hob, "rm build");
    const asked = first.pending as ApprovalRequest;
    expect(asked).toMatchObject({ operation: "delete-files", grantable: true });

    const approved = await decide(asked, { decision: "approve", lifetime: "always" });
    expect(approved.body).toMatchObject({ state: "approved", lifetime: "always" });
    expect(toolSteps(await settled(first.channel))).toMatchObject([{ state: "done" }]);

    // History lists the rule, live, with the request that saved it.
    const [saved] = await history();
    expect(await history()).toHaveLength(1);
    expect(saved).toMatchObject({
      agentId: hob.id,
      approvalId: asked.id,
      lifetime: "always",
      grantedBy: "user",
      revokedAt: null,
      rule: { _tag: "Paths", operation: "delete-files", paths: [join(project, "build")] },
    });

    // The rule answers the same delete: it runs and nobody is asked.
    const again = await runCommand(hob, "rm build");
    expect(again.pending).toBeUndefined();
    expect(toolSteps(again.reply as Message)).toMatchObject([{ state: "done" }]);

    // Removed from History, it stays listed as removed, and the same delete asks again.
    const removed = await request<Grant>("POST", `/api/grants/${saved?.id}/revoke`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ revokedBy: "user", revokeReason: "removed" });
    expect(await history()).toMatchObject([{ id: saved?.id, revokeReason: "removed" }]);
    expect((await request<ReadonlyArray<Grant>>("GET", "/api/grants")).body).toEqual([]);
    const afterRemoval = await runCommand(hob, "rm build");
    expect(afterRemoval.pending).toMatchObject({ state: "pending", operation: "delete-files" });
  });

  it("double-clicking Approve runs the action once and saves one rule", async () => {
    const hob = await hobInProject();
    // Allow once, sent twice at the same moment as a double click does.
    const once = await runCommand(hob, "git push origin feature");
    const onceRequest = once.pending as ApprovalRequest;
    const twice = await Promise.all([
      decide(onceRequest, { decision: "approve" }),
      decide(onceRequest, { decision: "approve" }),
    ]);
    expect(twice.map(({ status, body }) => [status, body.state])).toEqual([
      [200, "approved"],
      [200, "approved"],
    ]);
    expect(twice[1]?.body.revision).toBe(twice[0]?.body.revision);
    const onceReply = await settled(once.channel);
    expect(toolSteps(onceReply)).toMatchObject([{ state: "done", call: { operation: "push" } }]);
    expect(await forChannel(once.channel)).toHaveLength(1);

    // Always, doubled: one rule.
    const always = await runCommand(hob, "rm build");
    const alwaysRequest = always.pending as ApprovalRequest;
    const doubled = await Promise.all([
      decide(alwaysRequest, { decision: "approve", lifetime: "always" }),
      decide(alwaysRequest, { decision: "approve", lifetime: "always" }),
    ]);
    expect(doubled.map(({ status }) => status)).toEqual([200, 200]);
    expect(toolSteps(await settled(always.channel))).toMatchObject([{ state: "done" }]);
    expect(await history()).toHaveLength(1);
  });

  it("a request nobody decides for 24 hours expires, its action never runs, and approving it is refused", async () => {
    const hob = await hobInProject();
    const asked = await runCommand(hob, "git push origin feature");
    const pending = asked.pending as ApprovalRequest;
    expect(Date.parse(pending.expiresAt ?? "") - Date.parse(pending.createdAt)).toBe(24 * 60 * 60 * 1000);

    // A day less a minute later it still waits.
    advanceClock("1439 minutes");
    await Effect.runPromise(Effect.sleep("50 millis"));
    expect(await forChannel(asked.channel)).toMatchObject([{ id: pending.id, state: "pending" }]);

    // Past the day, the turn goes on without running it and the request is expired, in chat and in the Inbox.
    advanceClock("2 minutes");
    const reply = await settled(asked.channel);
    expect(reply.status).toBe("complete");
    expect(toolSteps(reply)).toMatchObject([{ state: "denied" }]);
    const expired = await eventually(async () => {
      const [stored] = await forChannel(asked.channel);
      return stored?.state === "expired" ? stored : undefined;
    });
    expect(await inbox()).toMatchObject([{ id: pending.id, state: "expired" }]);

    const late = await decide(expired, { decision: "approve" });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.body).toMatchObject({ _tag: "ApprovalClosed", state: "expired" });
    const lateAlways = await decide(expired, { decision: "approve", lifetime: "always" });
    expect(lateAlways.body).toMatchObject({ _tag: "ApprovalClosed" });
    expect(await history()).toEqual([]);
    expect((await request<ApprovalRequest>("GET", `/api/approvals/${pending.id}`)).body.state).toBe("expired");
  });

  it("the Inbox and the chat show the same request, and a decision through either reads the same in both", async () => {
    const hob = await hobInProject();
    const fromChat = await runCommand(hob, "rm build");
    const fromInbox = await runCommand(hob, "rm dist");

    // The Inbox lists exactly what each channel shows.
    const listed = await inbox();
    expect(listed).toEqual([...(await forChannel(fromChat.channel)), ...(await forChannel(fromInbox.channel))]);

    // The same decision, one made on the chat's copy and one on the Inbox's.
    const chatCopy = (await forChannel(fromChat.channel))[0] as ApprovalRequest;
    const inboxCopy = listed.find((approval) => approval.channelId === fromInbox.channel.id) as ApprovalRequest;
    const decision = { decision: "deny", reason: "Keep it for now" };
    const decidedInChat = await decide(chatCopy, decision);
    const decidedInInbox = await decide(inboxCopy, decision);

    const outcome = ({ state, lifetime, denyReason }: ApprovalRequest) => ({ state, lifetime, denyReason });
    expect(outcome(decidedInChat.body)).toEqual({ state: "denied", lifetime: null, denyReason: "Keep it for now" });
    expect(outcome(decidedInInbox.body)).toEqual(outcome(decidedInChat.body));

    // Each reply ends the same way, with the reason going back to the hob.
    const replies = [await settled(fromChat.channel), await settled(fromInbox.channel)];
    for (const reply of replies) {
      expect(reply.status).toBe("complete");
      expect(toolSteps(reply)).toMatchObject([
        { state: "denied", decidedBy: "user", reason: expect.stringContaining("Keep it for now") },
      ]);
    }

    // Both lists read the stored decisions the same.
    const after = await inbox();
    for (const channel of [fromChat.channel, fromInbox.channel]) {
      const [inChannel] = await forChannel(channel);
      expect(after.find((approval) => approval.id === inChannel?.id)).toEqual(inChannel);
    }
  });
});
