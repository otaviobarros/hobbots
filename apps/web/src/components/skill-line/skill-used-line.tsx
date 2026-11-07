import type { Agent, Message } from "@hobbots/domain";
import { messages } from "./messages.ts";
import { usedLine } from "./skill-line-model.ts";
import { SkillIcon } from "./skill-picker.tsx";

const copy = messages;

/**
 * The quiet lines under a reply for the skills it used (ADR 029, The use line, #1096): "Used Release
 * steps (r4)", one line a skill, like the line for a memory save. No badge: it is a notice only.
 */
export function SkillUsedLines({ message, hob }: { message: Message; hob: Agent }) {
  if (message.role !== "assistant" || message.skillsUsed.length === 0) return null;
  return (
    <ul aria-label={copy.label({ name: hob.name })} className="m-0 flex list-none flex-col gap-1.5 p-0 pt-1">
      {message.skillsUsed.map((used) => {
        const line = usedLine(used);
        return (
          <li key={`${used.source}:${used.name}:${used.pin ?? ""}`} className="flex animate-hb-in">
            <span
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-card border border-line-2 px-3 py-1.5 text-detail text-text-secondary"
            >
              <span className="flex text-star">
                <SkillIcon />
              </span>
              <span className="min-w-0">
                {copy.used} <b className="font-semibold text-text-strong">{line.title}</b>
                {line.detail === "" ? "" : ` ${line.detail}`}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
