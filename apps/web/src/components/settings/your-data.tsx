import type { Agent } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { aboutQuery } from "../../api/about.ts";
import { archivedAgentsQuery, threadsQuery } from "../../api/queries.ts";
import { formatDay } from "../../lib/time.ts";
import { useCopy } from "../../lib/use-copy.ts";
import { messages as archiveMessages } from "../archive-page/messages.ts";
import { BackupSettings } from "../backup/backup-settings.tsx";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "./messages.ts";
import { SettingsGroup } from "./settings-group.tsx";

const copy = messages.yourData;
const retiredCopy = archiveMessages.hobs;

/**
 * Settings › Your data: Backups (with Restore and Export as files), the hobs you retired, and the
 * folder on the hub where everything lives.
 */
export function YourData() {
  return (
    <>
      <BackupSettings />
      <RetiredHobs />
      <DataFolder />
    </>
  );
}

/** Each retired hob with its role, when it retired and how many chats it kept, and Read chats. */
function RetiredHobs() {
  const hobs = useQuery(archivedAgentsQuery);
  return (
    <SettingsGroup label={copy.retiredHobs}>
      {hobs.isError && <p className="m-0 text-sm text-rose">{retiredCopy.loadFailed}</p>}
      {hobs.data?.length === 0 && <p className="m-0 text-text-secondary">{retiredCopy.none}</p>}
      {hobs.data !== undefined && hobs.data.length > 0 && (
        <ul aria-label={copy.retiredHobs} className="m-0 flex list-none flex-col gap-1 p-0">
          {hobs.data.map((hob) => (
            <RetiredRow key={hob.id} hob={hob} />
          ))}
        </ul>
      )}
      <p className="m-0 text-detail text-text-secondary">{copy.retiredHobsBody}</p>
      <Link to="/archive" search={{ tab: "hobs" }} className="self-start text-sm text-link underline">
        {copy.openArchive}
      </Link>
    </SettingsGroup>
  );
}

function RetiredRow({ hob }: { hob: Agent }) {
  const threads = useQuery(threadsQuery(hob.id));
  const meta = [
    hob.roleTitle,
    hob.retiredAt ? retiredCopy.retired({ day: formatDay(hob.retiredAt) }) : retiredCopy.retiredUnknown,
    ...(threads.data ? [retiredCopy.kept({ count: threads.data.length })] : []),
  ].join(" · ");
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-control px-3 py-2.5 hover:bg-hover">
      <span aria-hidden className="grid size-8 flex-none place-items-center rounded-tile bg-line">
        <HobSprite hob={hob} size={24} state="asleep" className="opacity-70 grayscale-60" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-text-strong">{hob.name}</span>
        <span className="truncate text-meta text-label">{meta}</span>
      </span>
      <Button variant="ghost" size="xs" asChild>
        <Link
          to="/archive/hobs/$hobId"
          params={{ hobId: hob.id }}
          aria-label={retiredCopy.read({ name: hob.name })}
        >
          {copy.readChats}
        </Link>
      </Button>
    </li>
  );
}

/** The hub's data folder, with Copy; off the hub's own computer the path is not shown. */
function DataFolder() {
  const about = useQuery(aboutQuery);
  const [copied, copyPath] = useCopy();
  if (!about.data) return null;
  const { dataDir } = about.data;
  return (
    <SettingsGroup label={copy.dataFolder}>
      <p className="m-0 text-text-secondary">{copy.dataFolderIntro}</p>
      {dataDir === null ? (
        <p className="m-0 text-sm text-text-secondary">{copy.dataFolderElsewhere}</p>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center gap-2 rounded-control bg-card px-3.5 py-2.5">
          <code className="min-w-0 flex-1 font-mono text-detail break-all text-text">{dataDir}</code>
          <Button variant="outline" size="sm" onClick={() => copyPath(dataDir)}>
            {copy.copy[copied]}
          </Button>
        </span>
      )}
    </SettingsGroup>
  );
}
