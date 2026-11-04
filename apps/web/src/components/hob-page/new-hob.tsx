import type { Agent } from "@hobbots/domain";
import { Link } from "@tanstack/react-router";
import { writeDraft } from "../../api/drafts.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { helloOf, startersOf } from "./hob-page-model.ts";
import { messages } from "./messages.ts";

const copy = messages.newHob;

/**
 * The Chats tab of a hob with no chats yet: it says hello in its own words and offers three first
 * asks. A starter opens a new chat with its words already in the box, ready to send or change.
 */
export function NewHob({ hob }: { hob: Agent }) {
  return (
    <section aria-label={copy.label} className="cut flex flex-col gap-3.5 bg-card p-5">
      <h3 className="lbl m-0 text-meta leading-4 text-label">{copy.label}</h3>
      <p className="m-0 flex items-start gap-3">
        <span className="flex size-10 flex-none items-center justify-center rounded-tile bg-deep">
          <HobSprite hob={hob} size={30} />
        </span>
        <span className="min-w-0 pt-1 text-[15px] leading-[23px] text-text">{helloOf(hob)}</span>
      </p>
      <h3 className="lbl m-0 pt-1 text-meta leading-4 text-label">{copy.tryOne}</h3>
      <ul className="m-0 grid list-none grid-cols-3 gap-2 p-0 max-[720px]:grid-cols-1">
        {startersOf(hob).map((prompt) => (
          <li key={prompt} className="flex">
            <Link
              to="/hobs/$hobId/new"
              params={{ hobId: hob.id }}
              aria-label={copy.start({ prompt })}
              onClick={() => writeDraft(`new-${hob.id}`, prompt)}
              className="flex min-h-[76px] w-full flex-col justify-between gap-1.5 rounded-control bg-deep px-3 py-2.5 text-ui leading-5 text-text-strong no-underline transition-colors duration-(--dur-fade) ease-(--ease-ui) hover:bg-hover hover:text-text-strong"
            >
              {prompt}
              <span aria-hidden className="text-label">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
