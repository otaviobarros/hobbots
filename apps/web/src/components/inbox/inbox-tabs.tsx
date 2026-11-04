import { Badge } from "@hobbots/ui/components/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { INBOX_TABS, type InboxTab } from "./inbox-items.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * Needs you and History around the whole page, so the header holds the tab list and the page under
 * it is the open tab's panel. The tab is in the address.
 */
export function InboxTabs({ tab, children }: { tab: InboxTab; children: ReactNode }) {
  const open = useOpenTab();
  return (
    <Tabs value={tab} onValueChange={open} className="min-h-0 min-w-0 flex-1">
      {children}
    </Tabs>
  );
}

/** The tabs in the header, with how many things need you on Needs you. */
export function InboxTabList({ tab, waiting }: { tab: InboxTab; waiting: number }) {
  const open = useOpenTab();
  return (
    <TabsList aria-label={copy.tabsLabel} className="border-b-0">
      {INBOX_TABS.map((name) => (
        <TabsTrigger key={name} value={name} onClick={() => name === tab && open(name)}>
          {copy.tabs[name]}
          {name === "needs" && waiting > 0 && <Badge variant="needs-you">{copy.count({ count: waiting })}</Badge>}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

/** The open tab's panel: the page under the header. */
export function InboxPanel({ tab, children }: { tab: InboxTab; children: ReactNode }) {
  return (
    <TabsContent value={tab} className="flex min-h-0 min-w-0 flex-1">
      {children}
    </TabsContent>
  );
}

/** Opens a tab. Clicking the open tab again lands here too, so the request shown leaves the address. */
const useOpenTab = () => {
  const navigate = useNavigate();
  return (next: string) => {
    const name = INBOX_TABS.find((each) => each === next);
    if (name !== undefined) void navigate({ to: "/inbox", search: { tab: name } });
  };
};
