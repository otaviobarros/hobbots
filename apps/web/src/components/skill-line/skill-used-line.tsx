import type { Agent, Message } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { skillsSearchOf } from "../skills/skills-model.ts";
import { messages } from "./messages.ts";
import { usedLine, usedPage } from "./skill-line-model.ts";
import { SkillIcon } from "./skill-picker.tsx";

const copy = messages;

const action = "rounded-control px-2 py-0.5 text-detail text-link no-underline hover:bg-hover";

/**
 * The quiet lines under a reply for the skills it used (ADR 029, The use line, #1096): "Used Release
 * steps (r4)", or "Used Deliver change from agent-engineering (r1)" for a set's skill, one line a skill,
 * like the line for a memory save, with Open to the skill's page. No badge: it is a notice only. An
 * organization's skill has no page here, so its line has no Open.
 */
export function SkillUsedLines({ message, hob }: { message: Message; hob: Agent }) {
  if (message.role !== "assistant" || message.skillsUsed.length === 0) return null;
  return (
    <ul aria-label={copy.label({ name: hob.name })} className="m-0 flex list-none flex-col gap-1.5 p-0 pt-1">
      {message.skillsUsed.map((used) => {
        const line = usedLine(used);
        const page = usedPage(used);
        return (
          <li key={`${used.source}:${used.name}:${used.pin ?? ""}`} className="flex animate-hb-in">
            <span
              role="status"
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-card border border-line-2 py-1.5 ps-3 pe-3 text-detail text-text-secondary",
                page !== null && "pe-1.5",
              )}
            >
              <span className="flex text-star">
                <SkillIcon />
              </span>
              <span className="min-w-0">
                {copy.used} <b className="font-semibold text-text-strong">{line.title}</b>
                {line.detail === "" ? "" : ` ${line.detail}`}
              </span>
              {page !== null && (
                <Link
                  to="/skills"
                  search={skillsSearchOf(page)}
                  aria-label={copy.openLabel({ title: line.title })}
                  className={action}
                >
                  {copy.open}
                </Link>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
