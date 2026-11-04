import type { SafetyPreset } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { cn } from "@hobbots/ui/lib/utils";
import { useId, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { addFolder, folderName, PRESETS, removeFolder } from "../../api/safety.ts";
import { useUpdateSetup } from "../../api/setup.ts";
import { messages } from "../messages.ts";

const copy = messages.safety;

const chooseFolder = globalThis.window?.hobbots?.chooseFolder;

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
    <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-2.5">
        {PRESETS.map((preset) => {
          const on = preset.id === shown;
          return (
            <label
              key={preset.id}
              className={cn(
                "flex cursor-pointer flex-col gap-2 rounded-card bg-card p-4 transition-colors hover:bg-hover",
                on && "shadow-[inset_0_0_0_2px_var(--color-moonlight)]",
                "focus-ring-within",
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
              <FenceArt height={fenceHeight(preset.id)} />
              <span className="flex flex-wrap items-center gap-1.5">
                <strong className="text-[17px]">{preset.label}</strong>
                {preset.recommended && (
                  <span className="rounded-tag bg-line-2 px-2 py-0.5 text-detail font-bold">{copy.recommended}</span>
                )}
              </span>
              <span className="text-ui leading-5">{preset.brief}</span>
              <span className="text-detail leading-[18px] text-label">{preset.who}</span>
            </label>
          );
        })}
      </div>
      <PresetRules preset={shown} />
      {shown === "trusting" && (
        <LockedSwitch
          label="Let new hobs run without the sandbox"
          note="New hobs would start outside the sandbox, so their commands could reach the whole computer."
          checked={false}
          later="Off for now. Running without the sandbox arrives in a later update."
        />
      )}
      <p className="m-0 text-detail text-label">{copy.changeLater}</p>
      {update.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.presetFailed}
        </p>
      )}
    </fieldset>
  );
}

/** How high each preset's fence stands in its card, in pixels: Careful highest. */
const fenceHeight = (preset: SafetyPreset) => ({ careful: 34, balanced: 24, trusting: 12 })[preset];

/** A little night scene with a wooden fence, as high as the preset is careful. */
function FenceArt({ height }: { height: number }) {
  return (
    <span
      aria-hidden
      className="relative block h-[46px] overflow-hidden rounded-control bg-[linear-gradient(180deg,var(--color-deep),var(--color-ground))]"
    >
      <span className="absolute inset-x-0 bottom-0 h-2 border-t-2 border-scene-chimney bg-scene-ground" />
      <span
        className="absolute inset-x-2.5 bottom-2 bg-[repeating-linear-gradient(90deg,var(--color-wood)_0_5px,transparent_5px_11px)] transition-[height] duration-(--dur-sheet)"
        style={{ height }}
      />
    </span>
  );
}

const RULE_GLYPH = {
  Allow: { g: "✓", c: "text-mint" },
  Ask: { g: "?", c: "text-lantern" },
  Never: { g: "✕", c: "text-rose" },
};

/** What a hob does on its own, asks about and never does under the picked preset. */
function PresetRules({ preset }: { preset: SafetyPreset }) {
  const info = PRESETS.find((p) => p.id === preset);
  if (!info) return null;
  return (
    <div className="flex flex-col gap-2 rounded-card bg-card p-4">
      <span className="lbl text-label">{copy.presetRules({ preset: info.label })}</span>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {info.rules.map(([rule, answer]) => (
          <li key={rule} className="flex gap-2.5 text-ui leading-5">
            <span aria-hidden className={cn("w-4 font-bold", RULE_GLYPH[answer].c)}>
              {RULE_GLYPH[answer].g}
            </span>
            <span className="flex-1">{rule}</span>
            <span className="text-detail text-text-secondary">{answer}</span>
          </li>
        ))}
      </ul>
    </div>
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
      <Switch aria-labelledby={labelId} aria-describedby={noteId} checked={checked} disabled />
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span id={labelId} className="font-bold">
            {label}
          </span>
          <span className="bg-lantern px-1.5 text-meta text-ground">{copy.later}</span>
        </span>
        <span id={noteId} className="text-detail text-text-secondary">
          {note} {later}
        </span>
      </div>
    </div>
  );
}

/**
 * The folders hobs may work in. In the Hobbots app a folder comes from the system folder picker;
 * in a browser the user types its path on the hub. Every change is checked and stored by the hub.
 */
export function FolderPicker({ folders, look = "setup" }: { folders: ReadonlyArray<string>; look?: FolderLook }) {
  const update = useUpdateSetup();
  return (
    <FolderList
      look={look}
      label="Folders hobs may open"
      folders={folders}
      saving={update.isPending ? update.variables.approvedFolders : undefined}
      pending={update.isPending}
      error={update.error}
      onSave={(next, onSaved) => update.mutate({ approvedFolders: next }, { onSuccess: () => onSaved?.() })}
    />
  );
}

/** How a folder list looks: setup's mint-ringed cards, or Settings' quiet rows. */
type FolderLook = "setup" | "settings";

const FOLDER_ROW: Readonly<Record<FolderLook, { readonly list: string; readonly row: string }>> = {
  setup: {
    list: "lg:grid-cols-2",
    row: "cut animate-hb-in gap-3 border-2 border-mint bg-card px-3.5 py-3",
  },
  settings: { list: "", row: "gap-3 rounded-control bg-card px-3 py-2.5" },
};

/**
 * A list of folders with Remove on each and a way to add one: the system folder picker in the
 * Hobbots app, a typed path on the hub in a browser. The caller stores each change.
 */
export function FolderList({
  look = "setup",
  label,
  folders,
  saving,
  pending,
  error,
  onSave,
}: {
  look?: FolderLook;
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
        <ul aria-label={label} className={cn("m-0 grid list-none grid-cols-1 gap-2.5 p-0", FOLDER_ROW[look].list)}>
          {shown.map((folder) => (
            <li key={folder} className={cn("flex min-w-0 items-center", FOLDER_ROW[look].row)}>
              {look === "setup" ? (
                <span
                  aria-hidden
                  className="grid size-[22px] flex-none animate-hb-pop place-items-center border-2 border-control bg-mint font-bold text-ground"
                >
                  ✓
                </span>
              ) : (
                <span aria-hidden className="text-text-secondary">
                  ▭
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className={cn("truncate", look === "setup" && "font-bold")}>{folderName(folder)}</span>
                <span
                  className={cn(
                    "truncate text-text-secondary",
                    look === "setup" ? "text-detail" : "font-mono text-meta text-label",
                  )}
                  title={folder}
                >
                  {folder}
                </span>
              </span>
              <Button
                variant={look === "setup" ? "outline" : "ghost"}
                size="xs"
                disabled={pending}
                onClick={() => onSave(removeFolder(folders, folder))}
                aria-label={copy.removeFolder({ folder })}
              >
                {copy.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {chooseFolder ? (
        <div>
          <Button variant="outline" onClick={() => void pick()} disabled={picking || pending}>
            {copy.chooseFolder}
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
            {copy.pathLabel}
          </label>
          <input
            id={inputId}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={copy.pathPlaceholder}
            aria-invalid={refused !== undefined}
            aria-describedby={refused ? errorId : undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="min-w-[260px] flex-1 border-2 border-control bg-deep px-[11px] py-[7px] font-mono text-ui text-text-strong placeholder:text-label"
          />
          <Button type="submit" variant="outline" disabled={typed.trim() === "" || pending}>
            {copy.addFolder}
          </Button>
          <span className="w-full text-detail text-label">{copy.pathNote}</span>
        </form>
      )}

      {refused ? (
        <p id={errorId} role="alert" className="m-0 text-ui text-rose">
          {refused.message}
        </p>
      ) : (
        error && (
          <p role="alert" className="m-0 text-ui text-rose">
            {copy.foldersFailed}
          </p>
        )
      )}
    </div>
  );
}
