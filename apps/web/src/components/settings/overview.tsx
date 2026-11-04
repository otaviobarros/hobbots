import type { RuntimeKind } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { backupQuery } from "../../api/backup.ts";
import { connectionBridge } from "../../api/connected-desktop.ts";
import { approvedDevices, devicesQuery } from "../../api/devices.ts";
import { githubStatusQuery } from "../../api/github.ts";
import { runtimesQuery } from "../../api/queries.ts";
import { remoteAccessQuery } from "../../api/remote-access.ts";
import { setupQuery } from "../../api/setup.ts";
import { useTheme } from "../../lib/theme.ts";
import { ProviderFixActions, providerFix } from "../providers/provider-fix.tsx";
import { messages } from "./messages.ts";
import {
  type AreaTone,
  type Overview,
  type OverviewCard,
  type OverviewProblem,
  overviewOf,
  overviewTitle,
} from "./overview-model.ts";
import { sectionName } from "./sections.ts";

const copy = messages.overview;

/** Everything the overview reads, from the hub's records; the section list shares it for its marks. */
export const useOverview = (): { readonly overview: Overview; readonly loading: boolean } => {
  const runtimes = useQuery(runtimesQuery);
  const setup = useQuery(setupQuery);
  const github = useQuery(githubStatusQuery);
  // A connected desktop's hub sets remote access, so this Mac does not ask for it.
  const remote = useQuery({ ...remoteAccessQuery, enabled: connectionBridge === undefined });
  const devices = useQuery(devicesQuery);
  const backup = useQuery(backupQuery);
  const theme = useTheme();
  const overview = overviewOf({
    runtimes: runtimes.data,
    connected: setup.data?.connectedProviders,
    preset: setup.data?.safetyPreset,
    github: github.data,
    remote: connectionBridge === undefined ? remote.data : null,
    otherDevices: devices.data && approvedDevices(devices.data).filter((device) => device.kind !== "window").length,
    backup: backup.data?.state,
    theme,
  });
  return { overview, loading: setup.isPending };
};

/** Each tone's mark and color: a check when it works, a ring when off, a clock when busy. */
const TONES: Readonly<Record<AreaTone, { readonly glyph: string; readonly color: string; readonly tile: string }>> = {
  ok: { glyph: "✓", color: "text-mint", tile: "bg-mint/18" },
  off: { glyph: "○", color: "text-text-secondary", tile: "bg-text-secondary/18" },
  busy: { glyph: "◷", color: "text-lantern", tile: "bg-lantern/18" },
  broken: { glyph: "!", color: "text-rose", tile: "bg-rose/18" },
  plain: { glyph: "◇", color: "text-text-strong", tile: "bg-text-strong/18" },
};

/** Areas with no state of their own keep a mark of their own. */
const PLAIN_GLYPHS: Partial<Record<OverviewCard["id"], string>> = { appearance: "Aa", backups: "◷" };

/** Settings › Overview: is everything OK? Anything broken first, with its fix, then one card per area. */
export function SettingsOverview({ titleId }: { titleId: string }) {
  const { overview, loading } = useOverview();
  const heading = overviewTitle(overview.problems.length);
  return (
    <>
      <header className="flex flex-col gap-1.5">
        <h2 id={titleId} className="m-0 font-heading text-[26px] leading-8 font-(--heading-weight) text-text-strong">
          {loading ? copy.loading : heading.title}
        </h2>
        {!loading && <p className="m-0 text-text-secondary">{heading.line}</p>}
      </header>
      {overview.problems.map((problem) => (
        <ProblemCard key={problemKey(problem)} problem={problem} />
      ))}
      <ul aria-label={copy.cards} className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2">
        {overview.cards.map((card) => (
          <li key={card.id} className="flex">
            <AreaCard card={card} />
          </li>
        ))}
      </ul>
    </>
  );
}

const problemKey = (problem: OverviewProblem) => (problem.kind === "provider" ? problem.runtime : problem.kind);

function AreaCard({ card }: { card: OverviewCard }) {
  const tone = TONES[card.tone];
  const glyph = card.tone === "plain" ? (PLAIN_GLYPHS[card.id] ?? tone.glyph) : tone.glyph;
  return (
    <Link
      to="/settings/$section"
      params={{ section: card.section }}
      search={card.tab ? { tab: card.tab } : {}}
      className={cn(
        "group flex min-h-28 w-full flex-col items-start gap-1.5 rounded-card bg-card p-4 text-text-strong no-underline transition duration-150 hover:-translate-y-px hover:bg-hover hover:text-text-strong motion-reduce:hover:translate-y-0",
        card.tone === "broken" && "ring-2 ring-rose ring-inset",
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "grid size-7 flex-none place-items-center rounded-tile text-detail font-bold",
            tone.tile,
            tone.color,
          )}
        >
          {glyph}
        </span>
        <span className="flex-1 font-semibold">{card.title}</span>
        <span className="text-meta text-label group-hover:text-text-strong">
          {sectionName(card.section)} <span aria-hidden>›</span>
        </span>
      </span>
      <span className={cn("text-sm font-semibold", tone.color)}>{card.state}</span>
      <span className="text-detail text-text-secondary">{card.hint}</span>
    </Link>
  );
}

/** Something broken, above the cards, with its fix as the first action. */
function ProblemCard({ problem }: { problem: OverviewProblem }) {
  const section = problem.kind === "provider" ? "connections" : problem.kind === "devices" ? "devices" : "data";
  return (
    <section
      aria-label={problem.title}
      className="flex flex-col gap-2.5 rounded-card bg-[color-mix(in_srgb,var(--color-rose)_9%,var(--color-card))] px-[18px] py-4 ring-[1.5px] ring-rose/70 ring-inset"
    >
      <span className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="grid size-[30px] flex-none place-items-center rounded-dot bg-rose/22 font-bold text-rose"
        >
          !
        </span>
        <strong className="flex-1 text-text-strong">{problem.title}</strong>
        <Badge variant="failed">{messages.page.needsFix}</Badge>
      </span>
      {problem.kind === "provider" ? (
        <ProviderProblem runtime={problem.runtime} />
      ) : (
        <p className="m-0 text-text">{problem.body}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/settings/$section" params={{ section }}>
            {problem.kind === "provider" ? copy.seeDetails : copy.open({ section: sectionName(section) })}
          </Link>
        </Button>
      </div>
    </section>
  );
}

/** A provider's own fix: the command to run, then Check again, which needs no restart. */
function ProviderProblem({ runtime }: { runtime: RuntimeKind }) {
  const runtimes = useQuery(runtimesQuery);
  const health = runtimes.data?.find((entry) => entry.runtime === runtime);
  return (
    <>
      <p className="m-0 text-text">{copy.ai.fixBody}</p>
      <p className="m-0 text-sm text-text">{providerFix(runtime, health)}</p>
      <ProviderFixActions runtime={runtime} notFound={health?.version === null} className="mt-0" />
    </>
  );
}
