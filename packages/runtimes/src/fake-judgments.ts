import { JUDGMENT_INSTRUCTIONS, type PromptRequest } from "@hobbots/agents";

/**
 * A prompt line `fake:judgment <word> <JSON>` keeps the JSON as the fake's reply to the next
 * judgment the hub asks it whose prompt holds `<word>`, in any session (ADR 037). A judgment the
 * fake has no answer for is echoed, which the hub cannot decode, so its rule stands. The word keeps
 * the answer for the judgment a test means, such as Ask's question, when the hub's projectors ask
 * their own judgments meanwhile.
 */
const FAKE_JUDGMENT_DIRECTIVE = "fake:judgment";

const isJudgment = (request: PromptRequest) => request.instructions === JUDGMENT_INSTRUCTIONS;

/** The judgment answers one fake keeps from the turns it ran. */
export const makeFakeJudgments = () => {
  const kept: Array<{ readonly word: string; readonly answer: string }> = [];
  return {
    /** Keeps each answer a turn scripts; a judgment's own prompt, which may quote a chat, scripts none. */
    keep: (request: PromptRequest, prompt: string) => {
      if (isJudgment(request)) return;
      for (const line of prompt.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith(`${FAKE_JUDGMENT_DIRECTIVE} `)) continue;
        const rest = trimmed.slice(FAKE_JUDGMENT_DIRECTIVE.length + 1).trim();
        const space = rest.indexOf(" ");
        if (space > 0) kept.push({ word: rest.slice(0, space), answer: rest.slice(space + 1).trim() });
      }
    },
    /** The kept answer for a judgment whose prompt holds its word, used once; undefined for anything else. */
    answer: (request: PromptRequest): string | undefined => {
      if (!isJudgment(request)) return undefined;
      const at = kept.findIndex((judgment) => request.prompt.includes(judgment.word));
      return at === -1 ? undefined : kept.splice(at, 1)[0]?.answer;
    },
  };
};
