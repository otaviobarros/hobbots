import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { aboutQuery, DEPENDENCIES_URL, LICENSE_URL, REPOSITORY_URL } from "../../api/about.ts";
import { useCopy } from "../../lib/use-copy.ts";
import { messages, versionLabel } from "./messages.ts";

const copy = messages.about;

function DataFolder({ path }: { path: string }) {
  const [copied, copyPath] = useCopy();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="min-w-0 break-all">{path}</code>
      <Button variant="outline" size="sm" onClick={() => copyPath(path)}>
        {copy.copy[copied]}
      </Button>
    </span>
  );
}

const linkClass = "text-lantern no-underline hover:underline";

/** Settings › Help and about: the version, the hub, its data folder and the licenses. */
export function AboutSettings() {
  const about = useQuery(aboutQuery);
  if (about.isError) return <p className="m-0 text-sm text-rose">{copy.failed}</p>;
  if (!about.data) return null;
  const { version, name, dataDir } = about.data;
  return (
    <>
      <dl className="m-0 grid grid-cols-[160px_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-label">{copy.version}</dt>
        <dd className="m-0">{versionLabel(version)}</dd>
        <dt className="text-label">{copy.hub}</dt>
        <dd className="m-0">{name ?? copy.thisComputer}</dd>
        <dt className="text-label">{copy.dataFolder}</dt>
        <dd className="m-0 min-w-0">
          {dataDir === null ? (
            <span className="text-secondary-text">{copy.dataFolderElsewhere}</span>
          ) : (
            <DataFolder path={dataDir} />
          )}
        </dd>
        <dt className="text-label">{copy.licenses}</dt>
        <dd className="m-0 flex flex-wrap gap-x-3">
          <a href={LICENSE_URL} target="_blank" rel="noreferrer" className={linkClass}>
            {copy.license}
          </a>
          <a href={DEPENDENCIES_URL} target="_blank" rel="noreferrer" className={linkClass}>
            {copy.libraries}
          </a>
        </dd>
      </dl>
      <p className="m-0 flex flex-wrap gap-x-1 text-sm leading-[1.45] text-secondary-text">
        <span>{copy.openSource}</span>
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer" className={linkClass}>
          {copy.repository}
        </a>
      </p>
    </>
  );
}
