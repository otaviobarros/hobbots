import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { aboutQuery, DEPENDENCIES_URL, GUIDE_URL, LICENSE_URL, REPOSITORY_URL } from "../../api/about.ts";
import { KeyboardShortcuts } from "./keyboard-shortcuts.tsx";
import { messages, versionLabel } from "./messages.ts";

const copy = messages.about;

const linkClass = "text-link underline underline-offset-2 hover:text-text-strong";

/**
 * Settings › Help and about: the version, the hub, where to learn Hobbots and the licenses. The list
 * draws at once; the version and the hub's name hold still blocks until the hub answers.
 */
export function AboutSettings() {
  const about = useQuery(aboutQuery);
  const [shortcuts, setShortcuts] = useState(false);
  if (about.isError) return <p className="m-0 text-ui text-rose">{copy.failed}</p>;
  const data = about.data;
  return (
    <>
      <dl aria-busy={data === undefined} className="m-0 grid grid-cols-[160px_1fr] gap-x-3 gap-y-2 text-ui">
        <dt className="text-label">{copy.version}</dt>
        <dd className="m-0">{data ? versionLabel(data.version) : <Skeleton width="16ch" />}</dd>
        <dt className="text-label">{copy.hub}</dt>
        <dd className="m-0">{data ? (data.name ?? copy.thisComputer) : <Skeleton width="14ch" />}</dd>
        <dt className="text-label">{copy.learn}</dt>
        <dd className="m-0 flex flex-wrap items-baseline gap-x-3">
          <a href={GUIDE_URL} target="_blank" rel="noreferrer" className={linkClass}>
            {copy.guide}
          </a>
          <button
            type="button"
            onClick={() => setShortcuts(true)}
            className={cn("cursor-pointer border-0 bg-transparent p-0 text-ui", linkClass)}
          >
            {copy.shortcuts}
          </button>
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
      <p className="m-0 flex flex-wrap gap-x-1 text-ui leading-[1.45] text-text-secondary">
        <span>{copy.openSource}</span>
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer" className={linkClass}>
          {copy.repository}
        </a>
      </p>
      {shortcuts && <KeyboardShortcuts onClose={() => setShortcuts(false)} />}
    </>
  );
}
