import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A hub question carries codes and data, not English text (#1045, STD-I18N-005): what it asks is an
// `ask` of one kind, JSON text, its choices are stable keys, and the client turns both into words.
// `text` and `subject_title` go, and `recommended` and `picked` hold a choice's key, not its index.
// A picked choice no longer copies its label into `answer`, which keeps only words you typed.
//
// SQLite cannot change a column's type, so the table is rebuilt, as 0045 does. Each stored question,
// open, answered or applied, is read back into its ask and keys from the sentences the hub wrote
// for it, and so is each of its journaled events, whose payload version becomes 2. Only the two kinds
// below were ever raised. The words are written out here as the hub wrote them then.

type Stored = Record<string, unknown>;
interface OldOption {
  readonly label: string;
  readonly consequence: string;
}

const UNREAD = `Hobbots couldn't find a name and email in "`;
const UNREAD_END = `". Who should hobs commit as?`;
const GITHUB_LABEL = "My GitHub account, @";
const GITHUB_PREFIX = "Commits are made as ";
const GITHUB_SUFFIX = ", which GitHub links to your account.";
const OWN_GIT_LABEL = "I'll set it in Git myself";
const APPLIED = "The hub applied: ";
const BACKUPS: Record<string, "nightly" | "weekly"> = { "Every night": "nightly", "Every week": "weekly" };

/** The GitHub account and identity a commit identity question's GitHub choice named, if it offered one. */
const githubIn = (options: ReadonlyArray<OldOption>) => {
  const option = options.find((each) => each.label.startsWith(GITHUB_LABEL));
  const said = option?.consequence ?? "";
  if (option === undefined || !said.startsWith(GITHUB_PREFIX) || !said.endsWith(GITHUB_SUFFIX)) return null;
  const identity = said.slice(GITHUB_PREFIX.length, -GITHUB_SUFFIX.length);
  const open = identity.lastIndexOf(" <");
  if (open === -1 || !identity.endsWith(">")) return null;
  return {
    login: option.label.slice(GITHUB_LABEL.length),
    identity: { name: identity.slice(0, open), email: identity.slice(open + 2, -1) },
  };
};

const commitIdentityAsk = (text: string, options: ReadonlyArray<OldOption>) => {
  const end = text.lastIndexOf(UNREAD_END);
  const unread = text.startsWith(UNREAD) && end >= UNREAD.length ? text.slice(UNREAD.length, end) : null;
  return {
    kind: "commit-identity",
    reason: unread === null ? "no-git-identity" : "unreadable-answer",
    github: githubIn(options),
    unread,
  };
};

const fakeCheckAsk = (key: string, text: string) => {
  if (key !== "applied") return { kind: "fake-check", check: key, applied: null };
  const said = text.startsWith(APPLIED) ? text.slice(APPLIED.length) : text;
  const picked = BACKUPS[said] ?? null;
  return { kind: "fake-check", check: "applied", applied: { picked, answer: picked === null ? said : null } };
};

/** A choice's key, from the label the hub gave it. */
const keyOf = (label: string) =>
  label.startsWith(GITHUB_LABEL) ? "github" : label === OWN_GIT_LABEL ? "own-git" : (BACKUPS[label] ?? null);

/** A hub question as the hub keeps it now, from one as it kept it before, in the shape of `HubQuestion`. */
const questionWithCodes = (old: Stored): Stored => {
  const { subject, text, options, recommended, picked, answer, ...rest } = old as {
    readonly subject: { readonly kind: string; readonly key: string };
    readonly text: string;
    readonly options: ReadonlyArray<OldOption>;
    readonly recommended: number | null;
    readonly picked: number | null;
    readonly answer: string | null;
  } & Stored;
  const keys = options.map((option) => keyOf(option.label));
  const keyAt = (index: number | null) => (index === null ? null : (keys[index] ?? null));
  return {
    ...rest,
    key: subject.key,
    ask: subject.kind === "commit-identity" ? commitIdentityAsk(text, options) : fakeCheckAsk(subject.key, text),
    options: keys.every((key) => key !== null) ? keys : [],
    recommended: keyAt(recommended),
    answer: picked === null ? answer : null,
    picked: keyAt(picked),
  };
};

const fromRow = (row: Stored): Stored => ({
  subject: { kind: row.subject_kind, key: row.subject_key },
  text: row.text,
  options: JSON.parse(String(row.options)),
  recommended: row.recommended === null ? null : Number(row.recommended),
  picked: row.picked === null ? null : Number(row.picked),
  answer: row.answer,
});

export default Effect.gen(function* () {
  // Rows are read and written by their column names, as they are stored.
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();

  yield* sql`DROP INDEX hub_questions_subject`;
  yield* sql`
    CREATE TABLE hub_questions_next (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(id),
      thread_id TEXT REFERENCES threads(id),
      ask TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '[]',
      recommended TEXT,
      state TEXT NOT NULL CONSTRAINT hub_questions_codes_state_known CHECK (state IN ('open', 'answered', 'withdrawn')),
      answer TEXT,
      picked TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      answered_by_device_id TEXT,
      answered_via TEXT,
      applied_at TEXT,
      revision BIGINT NOT NULL DEFAULT 0
    )
  `;
  // The columns it keeps as they are, and those it reads the codes and keys from.
  const kept = `id, subject_kind, subject_key, agent_id, thread_id, state, created_at, answered_at,
    answered_by_device_id, answered_via, applied_at, revision`;
  const rows = yield* sql.unsafe<Stored>(
    `SELECT ${kept}, text, options, recommended, answer, picked FROM hub_questions`,
  );
  for (const row of rows) {
    const now = questionWithCodes(fromRow(row));
    const {
      text: _text,
      options: _options,
      recommended: _recommended,
      answer: _answer,
      picked: _picked,
      ...same
    } = row;
    yield* sql`INSERT INTO hub_questions_next ${sql.insert({
      ...same,
      ask: JSON.stringify(now.ask),
      options: JSON.stringify(now.options),
      recommended: now.recommended,
      answer: now.answer,
      picked: now.picked,
    } as Stored)}`;
  }
  yield* sql`DROP TABLE hub_questions`;
  yield* sql`ALTER TABLE hub_questions_next RENAME TO hub_questions`;
  yield* sql`CREATE INDEX hub_questions_subject ON hub_questions (subject_kind, subject_key, state)`;

  const events = yield* sql<{ sequence: unknown; payload: string }>`SELECT sequence, payload FROM event_journal
    WHERE type IN ('HubQuestionRaised', 'HubQuestionAnswered', 'HubQuestionWithdrawn') AND schema_version = 1`;
  for (const event of events) {
    const payload = JSON.parse(event.payload) as { readonly hubQuestion: Stored } & Stored;
    const now = { ...payload, hubQuestion: questionWithCodes(payload.hubQuestion) };
    yield* sql`UPDATE event_journal SET payload = ${JSON.stringify(now)}, schema_version = 2
      WHERE sequence = ${event.sequence}`;
  }
});
