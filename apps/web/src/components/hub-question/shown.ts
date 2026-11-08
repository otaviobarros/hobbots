import type { CommitIdentityAsk, FakeCheckAsk, HubQuestion, HubQuestionChoice, QuestionOption } from "@hobbots/domain";
import { messages } from "./messages.ts";

/**
 * A hub question as you read it: the hub sends codes, data and choice keys (#1045), and this words
 * them. `options` are in the order of the question's keys, so `recommended` and `picked` index both.
 */
export interface ShownHubQuestion {
  /** What it is about, as a card names it. */
  readonly title: string;
  readonly text: string;
  readonly options: ReadonlyArray<QuestionOption>;
  readonly recommended: number | null;
  readonly picked: number | null;
}

interface Words {
  readonly title: string;
  readonly text: string;
  readonly choice: (key: string) => QuestionOption;
}

const commitIdentity = (ask: CommitIdentityAsk): Words => {
  const copy = messages.commitIdentity;
  const lead =
    ask.unread === null ? copy.reason["no-git-identity"] : copy.reason["unreadable-answer"]({ unread: ask.unread });
  const question =
    ask.github === null ? copy.typeOrSet({ example: copy.example }) : copy.pickOrType({ example: copy.example });
  const choices: Record<HubQuestionChoice<"commit-identity">, QuestionOption> = {
    github: {
      label: copy.github.label({ login: ask.github?.login ?? "" }),
      consequence: ask.github === null ? "" : copy.github.consequence(ask.github.identity),
    },
    "own-git": copy.ownGit,
  };
  return {
    title: copy.title,
    text: `${lead} ${question}`,
    choice: (key) => choices[key as HubQuestionChoice<"commit-identity">],
  };
};

const fakeCheck = (ask: FakeCheckAsk): Words => {
  const copy = messages.fakeCheck;
  const choices: Record<HubQuestionChoice<"fake-check">, QuestionOption> = {
    nightly: copy.nightly,
    weekly: copy.weekly,
  };
  const choice = (key: string) => choices[key as HubQuestionChoice<"fake-check">];
  switch (ask.check) {
    case "backups":
      return { ...copy.backups, choice };
    case "hub-name":
      return { ...copy.hubName, choice };
    case "applied": {
      const picked = ask.applied?.picked ?? null;
      const applied = picked === null ? (ask.applied?.answer ?? "") : choices[picked].label;
      return { title: copy.applied.title, text: copy.applied.text({ applied }), choice };
    }
  }
};

const wordsOf = (question: HubQuestion): Words => {
  switch (question.ask.kind) {
    case "commit-identity":
      return commitIdentity(question.ask);
    case "fake-check":
      return fakeCheck(question.ask);
  }
};

/** The words of a hub question, its choices and which is recommended and picked, from its codes. */
export const shownHubQuestion = (question: HubQuestion): ShownHubQuestion => {
  const words = wordsOf(question);
  const indexOf = (key: string | null) => (key === null ? null : question.options.indexOf(key));
  return {
    title: words.title,
    text: words.text,
    options: question.options.map(words.choice),
    recommended: indexOf(question.recommended),
    picked: indexOf(question.picked),
  };
};
