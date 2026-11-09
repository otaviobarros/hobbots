import type { HobPermissions } from "@hobbots/api";
import type { Agent } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { notOffered } from "../../api/enforcement.ts";
import { ANSWER, offeredAnswer } from "../../api/safety.ts";
import { messages } from "./messages.ts";
import { WebIcon } from "./web-icon.tsx";

const RUNTIMES = ["claude-code", "codex"] as const;

/**
 * Built in, on a hob's Charms tab (ADR 036): Web search and Reading pages, which every hob has,
 * each with its answer in Permissions and how each runtime does it, the hob's own runtime named.
 */
export function BuiltInCharms({ hob, permissions }: { hob: Agent; permissions: HobPermissions | undefined }) {
  const copy = messages.builtIn;
  const answerOf = (operation: "search-web" | "use-web") =>
    permissions === undefined
      ? null
      : notOffered(operation, permissions.enforcement)
        ? copy.notOffered
        : ANSWER[offeredAnswer(operation, permissions.decisions[operation])];
  const cards = [
    { key: "search", icon: "search", words: copy.search, answer: answerOf("search-web") },
    { key: "pages", icon: "page", words: copy.pages, answer: answerOf("use-web") },
  ] as const;
  return (
    <section aria-label={copy.heading} className="flex flex-col gap-2">
      <h2 className="lbl m-0 text-label">{copy.heading}</h2>
      <p className="m-0 -mt-1 text-detail text-text-secondary">{copy.intro({ name: hob.name })}</p>
      {cards.map((card) => (
        <article
          key={card.key}
          aria-label={card.words.name}
          className="flex flex-col gap-3 rounded-card bg-card px-4 py-3.5"
        >
          <header className="flex items-start gap-3">
            <span
              aria-hidden
              className="grid size-8 flex-none place-items-center rounded-control bg-line text-text-strong"
            >
              <WebIcon kind={card.icon} size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-ui font-bold text-text-strong">{card.words.name}</h3>
                {card.answer !== null && <Badge variant="muted">{card.answer}</Badge>}
              </span>
              <span className="text-detail text-text-secondary">{card.words.what({ answer: card.answer ?? "…" })}</span>
            </span>
            <Button asChild variant="ghost" size="sm">
              <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }} search={{ tab: "permissions" }}>
                {copy.inPermissions}
              </Link>
            </Button>
          </header>
          <dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 rounded-control bg-deep px-3 py-2.5 text-detail">
            {RUNTIMES.map((runtime) => (
              <Fragment key={runtime}>
                <dt className="flex items-center gap-2 text-text-secondary">
                  {copy.runtime[runtime]}
                  {hob.runtime === runtime && <Badge variant="working">{copy.thisHob({ name: hob.name })}</Badge>}
                </dt>
                <dd className="m-0 text-text">{card.words[runtime === "claude-code" ? "claude" : "codex"]}</dd>
              </Fragment>
            ))}
          </dl>
        </article>
      ))}
    </section>
  );
}
