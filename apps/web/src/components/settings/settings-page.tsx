import { SearchField } from "@hobbots/ui/components/search-field";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { messages } from "./messages.ts";
import { SettingsOverview, useOverview } from "./overview.tsx";
import { SectionContent } from "./section-content.tsx";
import { SectionIcon } from "./section-icons.tsx";
import { findSettings, SETTINGS_SECTIONS, type SettingsSection, sectionName } from "./sections.ts";

const copy = messages;

/**
 * Settings: a list of its sections beside the open one, Overview first. The section lives in the
 * address, so a link, Back or a reload opens the same one.
 */
export function SettingsPage({ section }: { section: SettingsSection | null }) {
  const titleId = useId();

  return (
    <main aria-label={copy.page.title} className="flex min-w-0 flex-1 flex-col md:flex-row">
      <SettingsNav current={section} />
      {/* Keyed by the section, so a new section starts at its top, like a new page. */}
      <div key={section ?? "overview"} className="min-w-0 flex-1 overflow-y-auto px-6 pt-7 pb-10 md:px-10">
        <section aria-labelledby={titleId} className="flex max-w-[720px] flex-col gap-7">
          {section === null ? (
            <SettingsOverview titleId={titleId} />
          ) : (
            <>
              <SectionHeader section={section} titleId={titleId} />
              <SectionContent section={section} />
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function SectionHeader({ section, titleId }: { section: SettingsSection; titleId: string }) {
  return (
    <header className="flex flex-col gap-1.5">
      <span className="flex items-center gap-3">
        <span
          aria-hidden
          className="grid size-[38px] flex-none place-items-center rounded-tile bg-lantern/15 text-lantern"
        >
          <SectionIcon section={section} size={18} />
        </span>
        <h2 id={titleId} className="m-0 font-heading text-[26px] leading-8 font-(--heading-weight) text-text-strong">
          {sectionName(section)}
        </h2>
      </span>
      <p className="m-0 text-text-secondary">{copy.sections[section].intro}</p>
    </header>
  );
}

const rowClass =
  "flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-sm text-text-secondary no-underline transition-colors duration-150 hover:bg-hover hover:text-text-strong";

/** The section list, with Find a setting above it; a section with something broken carries a rose dot. */
function SettingsNav({ current }: { current: SettingsSection | null }) {
  const [query, setQuery] = useState("");
  const { overview } = useOverview();
  const hits = findSettings(query);
  const items: ReadonlyArray<SettingsSection | null> = [null, ...SETTINGS_SECTIONS];

  return (
    <nav
      aria-label={copy.page.sections}
      className="flex flex-none flex-col gap-0.5 border-line bg-panel px-3 py-5 max-md:border-b md:w-[232px] md:border-e"
    >
      <h1 className="mx-2 mt-0 mb-3 font-heading text-heading font-(--heading-weight) text-text-strong">
        {copy.page.title}
      </h1>
      <SearchField
        value={query}
        onValueChange={setQuery}
        clearLabel={copy.find.clear}
        aria-label={copy.find.label}
        placeholder={copy.find.label}
        className="mb-3"
      />
      {query.trim() !== "" && (
        <div className="flex flex-col gap-0.5 pb-2">
          {hits.map((hit) => (
            <Link
              key={hit.label}
              to="/settings/$section"
              params={{ section: hit.section }}
              onClick={() => setQuery("")}
              className={cn(rowClass, "flex-col items-start gap-0 py-1.5 text-text-strong")}
            >
              <span>{hit.label}</span>
              <span className="text-meta text-label">{copy.find.inSection({ section: sectionName(hit.section) })}</span>
            </Link>
          ))}
          {hits.length === 0 && <span className="px-2.5 py-1.5 text-detail text-label">{copy.find.nothing}</span>}
        </div>
      )}
      {items.map((section) => {
        const on = section === current;
        const flagged = section === null ? overview.problems.length > 0 : overview.flagged.has(section);
        const name = section === null ? copy.page.overview : sectionName(section);
        const body = (
          <>
            <span className={on ? "text-lantern" : undefined}>
              <SectionIcon section={section ?? "overview"} />
            </span>
            <span className="flex-1">{name}</span>
            {flagged && <span role="img" aria-label={copy.page.needsFix} className="size-2 rounded-dot bg-rose" />}
          </>
        );
        const className = cn(rowClass, on && "bg-card font-semibold text-text-strong");
        return section === null ? (
          <Link key="overview" to="/settings" activeOptions={{ exact: true }} className={className}>
            {body}
          </Link>
        ) : (
          <Link key={section} to="/settings/$section" params={{ section }} className={className}>
            {body}
          </Link>
        );
      })}
    </nav>
  );
}
