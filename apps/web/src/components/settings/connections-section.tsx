import { Badge } from "@hobbots/ui/components/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { githubStatusQuery } from "../../api/github.ts";
import { runtimesQuery } from "../../api/queries.ts";
import { setupQuery } from "../../api/setup.ts";
import { PROVIDERS } from "../../lib/providers.ts";
import { GitHubSettings } from "../github-settings.tsx";
import { messages as sharedMessages } from "../messages.ts";
import { messages } from "./messages.ts";
import { providerState } from "./overview-model.ts";
import { ProviderCard } from "./provider-card.tsx";
import { type ConnectionsTab, isConnectionsTab } from "./sections.ts";
import { SettingsGroup } from "./settings-group.tsx";

const copy = messages.connections;

// Providers from the Hobbots design that are not wired yet.
const LATER_PROVIDERS = [
  { name: "Gemini", maker: "Google", mark: "G", tile: "bg-provider-gemini" },
  { name: "Grok", maker: "xAI", mark: "X", tile: "bg-provider-grok" },
  { name: "Local models", maker: "Ollama, on the hub", mark: "L", tile: "bg-provider-local" },
  { name: "Your own key", maker: "Any OpenAI-compatible service", mark: "+", tile: "bg-provider-other" },
];

/**
 * Settings › Connections: the AI hobs think with, and the Charms they use. The tab lives in the
 * address (`?tab=charms`), so the overview's GitHub card opens Charms.
 */
export function ConnectionsSection({ tab }: { tab: ConnectionsTab }) {
  const navigate = useNavigate();
  const counts = useTabCounts();
  const pick = (next: string) => {
    if (!isConnectionsTab(next)) return;
    void navigate({
      to: "/settings/$section",
      params: { section: "connections" },
      search: next === "ai" ? {} : { tab: next },
      replace: true,
    });
  };
  return (
    <Tabs value={tab} onValueChange={pick} className="gap-5">
      <TabsList aria-label={messages.sections.connections.name}>
        <TabsTrigger value="ai">
          {copy.ai}
          <span className={cn("text-meta font-normal", counts.aiBroken ? "text-rose" : "text-label")}>{counts.ai}</span>
        </TabsTrigger>
        <TabsTrigger value="charms">
          {copy.charms}
          <span className="text-meta font-normal text-label">{counts.charms}</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="ai" className="flex flex-col gap-5">
        <ProviderCard runtime="claude-code" />
        <ProviderCard runtime="codex" />
        <SettingsGroup label={copy.later}>
          <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
            {LATER_PROVIDERS.map((provider) => (
              <li key={provider.name} className="flex items-center gap-3 rounded-control bg-card px-3 py-2.5">
                <span
                  aria-hidden
                  className={cn(
                    "grid size-7 flex-none place-items-center rounded-tile text-detail font-bold text-ground",
                    provider.tile,
                  )}
                >
                  {provider.mark}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-text-strong">{provider.name}</span>
                  <span className="truncate text-detail text-text-secondary">{provider.maker}</span>
                </span>
                <Badge variant="later">{copy.laterTag}</Badge>
              </li>
            ))}
          </ul>
          <p className="m-0 text-detail text-text-secondary">{copy.laterNote}</p>
        </SettingsGroup>
      </TabsContent>
      <TabsContent value="charms" className="flex flex-col gap-4">
        <p className="m-0 text-text-secondary">{sharedMessages.github.intro}</p>
        <section aria-label={sharedMessages.github.heading} className="flex flex-col gap-3 rounded-card bg-card p-4">
          <GitHubSettings />
        </section>
      </TabsContent>
    </Tabs>
  );
}

/** What each tab's count says: how many AIs are connected or need a fix, and how many Charms are on. */
const useTabCounts = () => {
  const runtimes = useQuery(runtimesQuery);
  const setup = useQuery(setupQuery);
  const github = useQuery(githubStatusQuery);
  const connected = PROVIDERS.filter((runtime) => setup.data?.connectedProviders.includes(runtime));
  const broken = connected.filter(
    (runtime) => providerState(runtimes.data?.find((entry) => entry.runtime === runtime)) !== null,
  ).length;
  const charms = github.data?._tag === "Connected" || github.data?._tag === "Environment" ? 1 : 0;
  return {
    ai: broken > 0 ? copy.needFix({ count: broken }) : copy.connected({ count: connected.length }),
    aiBroken: broken > 0,
    charms: charms > 0 ? copy.connected({ count: charms }) : copy.noneYet,
  };
};
