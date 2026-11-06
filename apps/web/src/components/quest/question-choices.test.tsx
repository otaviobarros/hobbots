import { AgentId, HubQuestion, HubQuestionId, Question, QuestionId, TaskId } from "@hobbots/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerForm, HubAnswerForm } from "./answer-form.tsx";
import { AnsweredChoices } from "./question-choices.tsx";
import { yourAnswer } from "./your-answer.ts";

// Issue #740: a question can offer choices, one recommended, and still take an answer in words.
const asked = (fields: Partial<ConstructorParameters<typeof Question>[0]> = {}) =>
  new Question({
    id: QuestionId.make("q1"),
    taskId: TaskId.make("t1"),
    askerId: AgentId.make("ada"),
    recipientId: null,
    chain: [],
    text: "Which theme should the spring page use?",
    state: "open",
    answer: null,
    answeredBy: null,
    createdAt: "2026-11-05T10:00:00.000Z",
    answeredAt: null,
    options: [
      { label: "Light", consequence: "Matches the brand guide." },
      { label: "Dark", consequence: "Stands out more." },
      { label: "Both, with a switch", consequence: "" },
    ],
    recommended: 0,
    revision: 1,
    ...fields,
  });

const form = (question: Question, look?: "rows" | "chips") =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AnswerForm question={question} askerName="Ada" via="chat" {...(look === undefined ? {} : { look })} />
    </QueryClientProvider>,
  );

/** The text a page shows for `html`, with its tags taken out. */
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("a question's choices", () => {
  it("[TC-UX-906] shows each choice as a button with its number and what it does, marks the recommended one, and keeps the box", () => {
    const html = form(asked());
    expect(html.match(/<button[^>]*type="button"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Ada&#x27;s choices"');
    expect(html.match(/data-recommended="true"/g)).toHaveLength(1);
    expect(textOf(html)).toContain("1 Light ★ Recommended Matches the brand guide.");
    expect(textOf(html)).toContain("2 Dark Stands out more.");
    expect(html).toContain('aria-keyshortcuts="3"');
    expect(textOf(html)).toContain("or answer in your own words");
    expect(html).toContain('aria-label="Your answer to Ada"');
    expect(html).toContain('placeholder="Something else…"');
    // With choices, Send answer steps back to an outline.
    expect(html).toMatch(/data-variant="outline"[^>]*type="submit"|type="submit"[^>]*data-variant="outline"/);
  });

  it("[TC-UX-906] shows the choices as chips in a lane, saying what each does to a screen reader", () => {
    const html = form(asked(), "chips");
    expect(html.match(/data-variant="chip"/g)).toHaveLength(3);
    expect(html).toContain('title="Matches the brand guide."');
    // Named by the label each shows, then the rest, so speech input can say what it sees (WCAG 2.5.3).
    expect(html).not.toMatch(/<button[^>]*aria-label=/);
    // Said inline after the label, so the name reads "Light, recommended." with no space before the comma.
    expect(html).toMatch(
      /<span>Light<span[^>]*>, recommended\. Matches the brand guide\.<\/span><\/span><span[^>]*>★<\/span>/,
    );
    expect(html).toMatch(/<span>Both, with a switch<\/span><\/button>/);
  });

  it("[TC-UX-906] keeps today's box and primary Send answer for a question without choices", () => {
    const html = form(asked({ options: [], recommended: null }));
    expect(html).not.toContain('type="button"');
    expect(html).not.toContain("or answer in your own words");
    expect(html).toContain('placeholder="Answer Ada"');
    expect(html).toMatch(/data-variant="default"[^>]*type="submit"|type="submit"[^>]*data-variant="default"/);
  });

  it("[TC-UX-907] says which choice you picked and what else was offered, or that you answered in your own words", () => {
    const picked = asked({
      state: "answered",
      answer: "Dark",
      picked: 1,
      answeredBy: { _tag: "User" },
      answeredVia: "chat",
    });
    expect(yourAnswer(picked, "chat")).toBe("You picked here: Dark");
    expect(yourAnswer(picked, "inbox")).toBe("You picked in the chat: Dark");
    expect(textOf(renderToStaticMarkup(<AnsweredChoices question={picked} />))).toContain(
      "Stands out more. Also offered: Light and Both, with a switch",
    );
    const typed = asked({
      state: "answered",
      answer: "Light, dark hero",
      answeredBy: { _tag: "User" },
      answeredVia: "chat",
    });
    expect(yourAnswer(typed, "chat")).toBe("You answered here: Light, dark hero");
    expect(textOf(renderToStaticMarkup(<AnsweredChoices question={typed} />))).toContain(
      "In your own words, not one of the choices. Offered: Light, Dark, and Both, with a switch",
    );
    expect(renderToStaticMarkup(<AnsweredChoices question={asked({ options: [], recommended: null })} />)).toBe("");
  });
});

describe("a question the hub itself asks (#976)", () => {
  it("[TC-UX-910] offers its choices on the same card, the recommended one marked, and keeps the box", () => {
    const question = new HubQuestion({
      id: HubQuestionId.make("h1"),
      subject: { kind: "commit-identity", key: "default", title: "Commit identity" },
      chat: null,
      text: "Who should hobs commit as?",
      options: [
        { label: "My GitHub account", consequence: "Commits show as you on GitHub." },
        { label: "A name and email I type", consequence: "" },
      ],
      recommended: 0,
      state: "open",
      answer: null,
      picked: null,
      createdAt: "2026-11-05T10:00:00.000Z",
      answeredAt: null,
      answeredByDeviceId: null,
      answeredVia: null,
      revision: 1,
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HubAnswerForm
          question={question}
          askerName="your hub"
          via="inbox"
          hint="Goes to your hub, which applies it."
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('aria-label="your hub&#x27;s choices"');
    expect(html.match(/data-recommended="true"/g)).toHaveLength(1);
    expect(textOf(html)).toContain("1 My GitHub account ★ Recommended Commits show as you on GitHub.");
    expect(textOf(html)).toContain("or answer in your own words");
    expect(html).toContain('aria-label="Your answer to your hub"');
    expect(textOf(html)).toContain("Goes to your hub, which applies it.");
  });
});
