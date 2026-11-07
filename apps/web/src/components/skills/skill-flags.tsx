import type { SkillDropped, SkillFlag } from "@hobbots/domain";
import { messages } from "./messages.ts";
import { SkillsIcon } from "./skills-parts.tsx";

const copy = messages;

/** One thing worth a careful look, with its file. */
export const flagLine = (flag: SkillFlag) => {
  switch (flag._tag) {
    case "Script":
      return copy.flags.script({ path: flag.path });
    case "Url":
      return copy.flags.url({ path: flag.path, url: flag.url });
    case "HiddenText":
      return copy.flags.hidden({ path: flag.path, codePoint: flag.codePoint });
  }
};

/** What import left out, in one line: hooks, commands, MCP servers and the like. */
export const droppedLine = (dropped: ReadonlyArray<SkillDropped>): string | null =>
  dropped.length === 0 ? null : copy.droppedLine({ kinds: [...new Set(dropped.map((one) => copy.dropped[one.kind]))] });

/** What deserves a careful look in a revision: its scripts, links and hidden text, each with its file. */
export function FlagList({ revision }: { revision: { readonly flags: ReadonlyArray<SkillFlag> } }) {
  if (revision.flags.length === 0) return null;
  return (
    <section
      aria-label={copy.flags.title}
      className="flex items-start gap-2.5 rounded-card bg-[color-mix(in_srgb,var(--color-lantern)_12%,var(--color-card))] px-3.5 py-3 text-ui text-text-strong"
    >
      <span className="mt-0.5 text-lantern">
        <SkillsIcon name="flag" />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <b className="font-semibold">{copy.flags.title}</b>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-detail">
          {revision.flags.map((flag) => (
            <li key={`${flag._tag}:${flag.path}:${flag._tag === "Url" ? flag.url : ""}`} className="break-words">
              {flagLine(flag)}
            </li>
          ))}
        </ul>
      </span>
    </section>
  );
}
