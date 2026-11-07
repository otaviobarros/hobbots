import type { SkillSourcePayload } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { Input } from "@hobbots/ui/components/input";
import { useId, useState } from "react";
import { messages } from "./messages.ts";

const copy = messages;

/** The most an archive may be: the hub reads at most 50 MB. */
const ARCHIVE_MAX = 50 * 1024 * 1024;

const chooseFolder = globalThis.window?.hobbots?.chooseFolder;

/** A file's bytes as base64, in chunks so a large archive never overflows the call stack. */
const base64Of = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

/** From Git: a repository and the branch, tag or commit to read, which the hub pins to a commit. */
export function GitSource({ looking, onLook }: { looking: boolean; onLook: (source: SkillSourcePayload) => void }) {
  const ids = { url: useId(), ref: useId() };
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)_180px_auto] items-end gap-2.5 max-[900px]:grid-cols-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (url.trim() === "" || looking) return;
        onLook({ _tag: "Git", url: url.trim(), ref: ref.trim() === "" ? null : ref.trim() });
      }}
    >
      <label htmlFor={ids.url} className="flex flex-col gap-1.5 text-detail text-label">
        {copy.import.repository}
        <Input id={ids.url} value={url} onChange={(event) => setUrl(event.target.value)} />
      </label>
      <label htmlFor={ids.ref} className="flex flex-col gap-1.5 text-detail text-label">
        {copy.import.ref}
        <Input
          id={ids.ref}
          value={ref}
          placeholder={copy.import.refHint}
          onChange={(event) => setRef(event.target.value)}
        />
      </label>
      <Button type="submit" variant="outline" disabled={url.trim() === "" || looking}>
        {looking ? copy.import.looking : copy.import.look}
      </Button>
    </form>
  );
}

/** A folder on the hub's computer, chosen in the desktop app or typed, or a .zip from this computer. */
export function FileSource({ looking, onLook }: { looking: boolean; onLook: (source: SkillSourcePayload) => void }) {
  const ids = { path: useId(), zip: useId() };
  const [path, setPath] = useState("");
  const [tooLarge, setTooLarge] = useState(false);
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border-(length:--edge) border-dashed border-line-2 px-6 py-8 text-center">
      <b className="text-body text-text-strong">{copy.import.drop}</b>
      <span className="text-detail text-text-secondary">{copy.import.limits}</span>
      {chooseFolder !== undefined ? (
        <Button
          variant="outline"
          disabled={looking}
          onClick={() =>
            void chooseFolder().then((folder) => {
              if (folder !== null) onLook({ _tag: "Folder", path: folder });
            })
          }
        >
          {copy.import.chooseFolder}
        </Button>
      ) : (
        <form
          className="flex w-full max-w-[520px] items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim() === "" || looking) return;
            onLook({ _tag: "Folder", path: path.trim() });
          }}
        >
          <label htmlFor={ids.path} className="flex flex-1 flex-col gap-1.5 text-start text-detail text-label">
            {copy.import.folder}
            <Input id={ids.path} value={path} onChange={(event) => setPath(event.target.value)} />
          </label>
          <Button type="submit" variant="outline" disabled={path.trim() === "" || looking}>
            {looking ? copy.import.looking : copy.import.look}
          </Button>
        </form>
      )}
      <span className="text-meta text-label">{copy.import.or}</span>
      <label htmlFor={ids.zip} className="flex flex-col items-center gap-1.5 text-detail text-label">
        {copy.import.zipLabel}
        <input
          id={ids.zip}
          type="file"
          accept=".zip,.skill"
          disabled={looking}
          className="text-detail text-text-secondary file:me-3 file:cursor-pointer file:rounded-control file:border-(length:--edge) file:border-solid file:border-control file:bg-transparent file:px-3 file:py-1.5 file:text-text-strong"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file === undefined) return;
            setTooLarge(file.size > ARCHIVE_MAX);
            if (file.size > ARCHIVE_MAX) return;
            void base64Of(file).then((base64) => onLook({ _tag: "Archive", fileName: file.name, base64 }));
          }}
        />
      </label>
      {tooLarge && (
        <p role="alert" className="m-0 text-detail text-rose">
          {copy.import.tooLarge}
        </p>
      )}
    </div>
  );
}
