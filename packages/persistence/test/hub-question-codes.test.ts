import { HubQuestionRepository } from "@hobbots/agents";
import { DeviceId, HubQuestionId } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventJournal, HubQuestionRepositoryLive, migrations } from "../src/index.ts";
import hubQuestionCodes from "../src/migrations/0078_hub_question_codes.ts";
import { TestDatabaseAt } from "../src/testing.ts";

// Issue #1045: hub questions stored before 0078 held English text and labels. The migration reads
// them back into codes and keys, rows and journaled events alike, so an answer given before it is
// still applied by key, and one still open is answered by key after it.

const NOW = "2026-11-07T00:00:00.000Z";
const NOREPLY = "35647586+otaviobarros@users.noreply.github.com";

/** The migrations that ran before 0078, which keep a hub question's text and labels. */
const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0078")) as typeof migrations;

const GITHUB = {
  label: "My GitHub account, @otaviobarros",
  consequence: `Commits are made as otaviobarros <${NOREPLY}>, which GitHub links to your account.`,
};
const OWN_GIT = {
  label: "I'll set it in Git myself",
  consequence:
    "Run git config --global user.name and user.email on the hub's computer. Hobs use them from their next turn.",
};

interface Old {
  readonly id: string;
  readonly kind: string;
  readonly key: string;
  readonly title: string;
  readonly text: string;
  readonly options?: ReadonlyArray<{ readonly label: string; readonly consequence: string }>;
  readonly recommended?: number;
  readonly state?: "open" | "answered";
  readonly answer?: string;
  readonly picked?: number;
}

/** A hub question and its HubQuestionRaised entry, as the hub stored them before 0078. */
const stored = (old: Old, sequence: number) =>
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms();
    const question = {
      id: old.id,
      subject: { kind: old.kind, key: old.key, title: old.title },
      chat: null,
      text: old.text,
      options: old.options ?? [],
      recommended: old.recommended ?? null,
      state: old.state ?? "open",
      answer: old.answer ?? null,
      picked: old.picked ?? null,
      createdAt: NOW,
      answeredAt: old.state === "answered" ? NOW : null,
      answeredByDeviceId: old.state === "answered" ? "window" : null,
      answeredVia: old.state === "answered" ? "inbox" : null,
      revision: sequence,
    };
    yield* sql`INSERT INTO hub_questions ${sql.insert({
      id: old.id,
      subject_kind: old.kind,
      subject_key: old.key,
      subject_title: old.title,
      text: old.text,
      options: JSON.stringify(question.options),
      recommended: question.recommended,
      state: question.state,
      answer: question.answer,
      picked: question.picked,
      created_at: NOW,
      revision: sequence,
    })}`;
    yield* sql`INSERT INTO event_journal ${sql.insert({
      sequence,
      id: `event-${sequence}`,
      type: "HubQuestionRaised",
      schema_version: 1,
      occurred_at: NOW,
      payload: JSON.stringify({ _tag: "HubQuestionRaised", hubQuestion: question }),
    })}`;
    yield* sql`UPDATE event_journal_head SET sequence = ${sequence}`;
  });

describe("0078_hub_question_codes", () => {
  // covers OR-004, DP-003
  it("[TC-DP-291] turns stored hub questions and their events into codes and keys, and an old answer still applies by key", async () => {
    const result = await Effect.gen(function* () {
      yield* stored(
        {
          id: "picked",
          kind: "commit-identity",
          key: "user",
          title: "Who hobs commit as",
          text: "Your Git config sets no name and email, so hobs that commit as you can't commit, and they may not set one themselves. Who should hobs commit as? Pick one, or type a name and email, such as Ada Lovelace <ada@example.com>.",
          options: [GITHUB, OWN_GIT],
          recommended: 0,
          state: "answered",
          answer: GITHUB.label,
          picked: 0,
        },
        1,
      );
      yield* stored(
        {
          id: "unread",
          kind: "commit-identity",
          key: "user",
          title: "Who hobs commit as",
          text: `Hobbots couldn't find a name and email in "whatever you think". Who should hobs commit as? Type a name and email, such as Ada Lovelace <ada@example.com>. Or set user.name and user.email with git config --global on the hub's computer, then answer "done".`,
        },
        2,
      );
      yield* stored(
        {
          id: "backups",
          kind: "fake-check",
          key: "backups",
          title: "Nightly backups",
          text: "How often should the hub back up your data?",
          options: [
            { label: "Every night", consequence: "A backup each night, kept for a week." },
            { label: "Every week", consequence: "A backup each Sunday, kept for a month." },
          ],
          recommended: 0,
        },
        3,
      );
      yield* stored(
        {
          id: "applied",
          kind: "fake-check",
          key: "applied",
          title: "What the hub applied",
          text: "The hub applied: Kitchen Mac",
        },
        4,
      );
      // Words typed before that name a property every object has are still words, not a choice.
      yield* stored(
        {
          id: "prototype",
          kind: "fake-check",
          key: "applied",
          title: "What the hub applied",
          text: "The hub applied: constructor",
        },
        5,
      );
      yield* hubQuestionCodes;

      const questions = yield* HubQuestionRepository;
      const unapplied = yield* questions.listUnapplied("commit-identity");
      const open = yield* questions.listOpen;
      // A question still open from before is answered by its choice's key.
      const answered = yield* questions.answer(HubQuestionId.make("backups"), { picked: "weekly" }, NOW, {
        deviceId: DeviceId.make("window"),
        via: "inbox",
      });
      const journal = yield* EventJournal;
      const events = yield* journal.readAfter(0);
      const sql = yield* SqlClient.SqlClient;
      const columns = Object.keys((yield* sql`SELECT * FROM hub_questions`)[0] ?? {});
      return { unapplied, open, answered: answered.value, events, columns };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(HubQuestionRepositoryLive, EventJournal.layer).pipe(Layer.provideMerge(TestDatabaseAt(earlier))),
      ),
      Effect.runPromise,
    );

    // The answer given before it is still waiting, now picked by key, with the identity its choice named.
    expect(result.unapplied).toHaveLength(1);
    expect(result.unapplied[0]).toMatchObject({
      id: "picked",
      key: "user",
      ask: {
        kind: "commit-identity",
        reason: "no-git-identity",
        github: { login: "otaviobarros", identity: { name: "otaviobarros", email: NOREPLY } },
        unread: null,
      },
      options: ["github", "own-git"],
      recommended: "github",
      picked: "github",
      answer: null,
    });
    const open = new Map<string, (typeof result.open)[number]>(result.open.map((question) => [question.id, question]));
    expect([...open.keys()].sort()).toEqual(["applied", "backups", "prototype", "unread"]);
    expect(open.get("prototype")?.ask).toEqual({
      kind: "fake-check",
      check: "applied",
      applied: { picked: null, answer: "constructor" },
    });
    expect(open.get("unread")?.ask).toEqual({
      kind: "commit-identity",
      reason: "unreadable-answer",
      github: null,
      unread: "whatever you think",
    });
    expect(open.get("applied")?.ask).toEqual({
      kind: "fake-check",
      check: "applied",
      applied: { picked: null, answer: "Kitchen Mac" },
    });
    expect(open.get("backups")).toMatchObject({ options: ["nightly", "weekly"], recommended: "nightly" });
    expect(result.answered).toMatchObject({ state: "answered", picked: "weekly", answer: null });
    expect(result.columns).not.toContain("text");
    expect(result.columns).not.toContain("subjectTitle");

    // Every journaled entry reads back in the new shape, at version 2.
    const raised = result.events.filter((event) => event.type === "HubQuestionRaised");
    expect(raised.map((event) => event.schemaVersion)).toEqual([2, 2, 2, 2, 2]);
    expect(raised[4]?.payload).toMatchObject({
      hubQuestion: { id: "prototype", ask: { applied: { picked: null, answer: "constructor" } } },
    });
    expect(raised[0]?.payload).toMatchObject({
      hubQuestion: { id: "picked", picked: "github", options: ["github", "own-git"] },
    });
  });
});
