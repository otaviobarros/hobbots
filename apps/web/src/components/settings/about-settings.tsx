import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { aboutQuery, DEPENDENCIES_URL, LICENSE_URL, REPOSITORY_URL } from "../../api/about.ts";
import { useCopy } from "../../lib/use-copy.ts";

const copyLabel = { idle: "Copy", copied: "Copied", failed: "Could not copy" } as const;

function DataFolder({ path }: { path: string }) {
  const [copied, copy] = useCopy();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="min-w-0 break-all">{path}</code>
      <Button variant="outline" size="sm" onClick={() => copy(path)}>
        {copyLabel[copied]}
      </Button>
    </span>
  );
}

const linkClass = "text-lantern no-underline hover:underline";

/** Settings › Help and about: the version, the hub, its data folder and the licenses. */
export function AboutSettings() {
  const about = useQuery(aboutQuery);
  if (about.isError) {
    return <p className="m-0 text-sm text-rose">Hobbots could not read the hub's details. Try again in a moment.</p>;
  }
  if (!about.data) return null;
  const { version, name, dataDir } = about.data;
  return (
    <>
      <dl className="m-0 grid grid-cols-[160px_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-label">Version</dt>
        <dd className="m-0">{version}</dd>
        <dt className="text-label">Hub</dt>
        <dd className="m-0">{name ?? "This computer"}</dd>
        <dt className="text-label">Data folder</dt>
        <dd className="m-0 min-w-0">
          {dataDir === null ? (
            <span className="text-secondary-text">Shown only on the hub's own computer.</span>
          ) : (
            <DataFolder path={dataDir} />
          )}
        </dd>
        <dt className="text-label">Licenses</dt>
        <dd className="m-0">
          <a href={LICENSE_URL} target="_blank" rel="noreferrer" className={linkClass}>
            Apache License 2.0
          </a>
          {" · "}
          <a href={DEPENDENCIES_URL} target="_blank" rel="noreferrer" className={linkClass}>
            Open-source libraries
          </a>
        </dd>
      </dl>
      <p className="m-0 text-sm leading-[1.45] text-secondary-text">
        Hobbots is free and open source. Read the code, report a bug or suggest a hob at{" "}
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer" className={linkClass}>
          github.com/otaviobarros/hobbots
        </a>
        .
      </p>
    </>
  );
}
