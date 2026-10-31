import type { SafetyPreset } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { cn } from "@hobbots/ui/lib/utils";
import { useId, useState } from "react";
import { ApiError } from "../api/client.ts";
import { addFolder, folderName, PRESETS, removeFolder, ruleColor } from "../api/safety.ts";
import { useUpdateSetup } from "../api/setup.ts";

const chooseFolder = globalThis.window?.hobbots?.chooseFolder;

/** A focus ring drawn inside the pixel corners, which would clip one drawn outside. */
const focusWithin =
  "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight has-[:focus-visible]:-outline-offset-4";

/**
 * The three safety presets as cards, one radio group. Picking one stores it on the hub at once,
 * so onboarding and Settings share the same control.
 */
export function PresetPicker({
  value,
  onPicked,
  label,
}: {
  value: SafetyPreset;
  /** Called once the hub stored the pick. */
  onPicked?: (preset: SafetyPreset) => void;
  label: string;
}) {
  const update = useUpdateSetup();
  const name = useId();
  const shown = update.isPending && update.variables.safetyPreset ? update.variables.safetyPreset : value;
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3.5">
        {PRESETS.map((preset) => {
          const on = preset.id === shown;
          return (
            <label
              key={preset.id}
              className={cn(
                "cut flex cursor-pointer flex-col gap-2 border-2 p-4 transition-transform duration-100 ease-[steps(2)] hover:-translate-y-[3px]",
                on ? "border-moonlight bg-line" : "border-line-2 bg-card",
                focusWithin,
              )}
            >
              <input
                type="radio"
                name={name}
                checked={on}
                disabled={update.isPending}
                onChange={() => update.mutate({ safetyPreset: preset.id }, { onSuccess: () => onPicked?.(preset.id) })}
                className="sr-only"
              />
              <span className="flex items-center gap-2">
                <span className={cn("font-pixel text-[22px] font-bold", on ? "text-moonlight" : "text-text")}>
                  {preset.label}
                </span>
                {preset.recommended && (
                  <span className="bg-moonlight px-[7px] py-0.5 text-xs font-bold text-ground">Most people</span>
                )}
              </span>
              <span className="min-h-[42px] text-sm leading-[1.45] text-secondary-text">{preset.note}</span>
              <span className="flex flex-col">
                {preset.rules.map(([rule, answer]) => (
                  <span key={rule} className="flex items-center gap-2 py-[3px] text-sm">
                    <span className="flex-1">{rule}</span>
                    <span className={cn("px-2 py-0.5 text-xs font-bold text-ground", ruleColor(answer))}>{answer}</span>
                  </span>
                ))}
              </span>
            </label>
          );
        })}
      </div>
      {shown === "trusting" && (
        <LockedSwitch
          label="Let new hobs run without the sandbox"
          note="New hobs would start outside the sandbox, so their commands could reach the whole computer."
          checked={false}
          later="Off for now. Running without the sandbox arrives in a later update."
        />
      )}
      <p className="m-0 text-[13px] text-label">
        Every hob stays inside its folders. You can make one hob more careful from its profile.
      </p>
      {update.isError && (
        <p role="alert" className="m-0 text-sm text-rose">
          Hobbots could not save the safety preset. Try again in a moment.
        </p>
      )}
    </fieldset>
  );
}

/**
 * A switch the user cannot change yet, with why. Turning the sandbox off is a recorded user grant
 * (ADR 014), which the hub does not store yet, so the switch shows where it will be and stays put.
 */
export function LockedSwitch({
  label,
  note,
  checked,
  later,
}: {
  label: string;
  note: string;
  checked: boolean;
  later: string;
}) {
  const labelId = useId();
  const noteId = useId();
  return (
    <div className="flex items-center gap-4 border-b-2 border-line py-2.5">
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span id={labelId} className="font-bold">
            {label}
          </span>
          <span className="bg-lantern px-1.5 text-xs text-ground">Later</span>
        </span>
        <span id={noteId} className="text-[13px] text-secondary-text">
          {note} {later}
        </span>
      </div>
      <Switch aria-labelledby={labelId} aria-describedby={noteId} checked={checked} disabled />
    </div>
  );
}

/**
 * The folders hobs may work in. In the Hobbots app a folder comes from the system folder picker;
 * in a browser the user types its path on the hub. Every change is checked and stored by the hub.
 */
export function FolderPicker({ folders }: { folders: ReadonlyArray<string> }) {
  const update = useUpdateSetup();
  return (
    <FolderList
      label="Folders hobs may open"
      folders={folders}
      saving={update.isPending ? update.variables.approvedFolders : undefined}
      pending={update.isPending}
      error={update.error}
      onSave={(next, onSaved) => update.mutate({ approvedFolders: next }, { onSuccess: () => onSaved?.() })}
    />
  );
}

/**
 * A list of folders with Remove on each and a way to add one: the system folder picker in the
 * Hobbots app, a typed path on the hub in a browser. The caller stores each change.
 */
export function FolderList({
  label,
  folders,
  saving,
  pending,
  error,
  onSave,
}: {
  label: string;
  folders: ReadonlyArray<string>;
  /** The list on its way to the hub, shown until it answers. */
  saving: ReadonlyArray<string> | undefined;
  pending: boolean;
  error: Error | null;
  onSave: (next: ReadonlyArray<string>, onSaved?: () => void) => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const [typed, setTyped] = useState("");
  const [picking, setPicking] = useState(false);
  const shown = saving ?? folders;
  const refused = error instanceof ApiError && error.tag === "InvalidFolder" ? error : undefined;

  const pick = async () => {
    if (!chooseFolder || picking) return;
    setPicking(true);
    try {
      const folder = await chooseFolder();
      if (folder) onSave(addFolder(folders, folder));
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      {shown.length > 0 && (
        <ul aria-label={label} className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 lg:grid-cols-2">
          {shown.map((folder) => (
            <li
              key={folder}
              className="cut flex min-w-0 animate-hb-in items-center gap-3 border-2 border-mint bg-card px-3.5 py-3"
            >
              <span
                aria-hidden
                className="grid size-[22px] flex-none animate-hb-pop place-items-center border-2 border-control bg-mint font-bold text-ground"
              >
                ✓
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate font-bold">{folderName(folder)}</span>
                <span className="truncate text-[13px] text-secondary-text" title={folder}>
                  {folder}
                </span>
              </span>
              <Button
                variant="outline"
                size="xs"
                disabled={pending}
                onClick={() => onSave(removeFolder(folders, folder))}
                aria-label={`Remove ${folder}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {chooseFolder ? (
        <div>
          <Button variant="outline" onClick={() => void pick()} disabled={picking || pending}>
            + Choose a folder…
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const folder = typed.trim();
            if (folder === "" || pending) return;
            onSave(addFolder(folders, folder), () => setTyped(""));
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Folder path on the hub
          </label>
          <input
            id={inputId}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="~/Documents or /Users/you/code"
            aria-invalid={refused !== undefined}
            aria-describedby={refused ? errorId : undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="min-w-[260px] flex-1 border-2 border-control bg-deep px-[11px] py-[7px] font-mono text-sm text-text placeholder:text-label"
          />
          <Button type="submit" variant="outline" disabled={typed.trim() === "" || pending}>
            Add folder
          </Button>
          <span className="w-full text-[13px] text-label">
            Type the path of a folder on the computer that runs your hub.
          </span>
        </form>
      )}

      {refused ? (
        <p id={errorId} role="alert" className="m-0 text-sm text-rose">
          {refused.message}
        </p>
      ) : (
        error && (
          <p role="alert" className="m-0 text-sm text-rose">
            Hobbots could not save the folders. Try again in a moment.
          </p>
        )
      )}
    </div>
  );
}
