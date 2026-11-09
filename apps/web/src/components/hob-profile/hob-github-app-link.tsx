import type { HobGitHubAppMissingPermission } from "@hobbots/api";
import type { Agent } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Input } from "@hobbots/ui/components/input";
import { Textarea } from "@hobbots/ui/components/textarea";
import { type ReactNode, useId, useState } from "react";
import { ApiError } from "../../api/client.ts";
import type { useLinkHobGitHubApp } from "../../api/hob-github-app.ts";
import { messages } from "../messages.ts";
import {
  EMPTY_LINK,
  KEY_FILE_MAX,
  type LinkDraft,
  type LinkErrors,
  linkErrors,
  linkOf,
  missingText,
  refusalField,
  refusalText,
} from "./hob-github-app-link-model.ts";

const copy = messages.charms.github.app;

/** Where the user's own GitHub Apps are listed, with each one's ID and private keys. */
const GITHUB_APPS = "https://github.com/settings/apps";

const CARD = "flex flex-col gap-3 rounded-control bg-deep px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--color-line-2)]";

type Link = ReturnType<typeof useLinkHobGitHubApp>;

/** The hub's refusal of the last try, by the field it belongs to, or for the whole form. */
const refusalOf = (
  link: Link,
  name: string,
): { readonly field: keyof LinkErrors | null; readonly text: string } | null => {
  if (!link.isError) return null;
  const reason = link.error instanceof ApiError ? link.error.fields.reason : undefined;
  if (typeof reason !== "string" || !(reason in copy.linkRefused)) return { field: null, text: copy.linkFailed };
  const known = reason as keyof typeof copy.linkRefused;
  return { field: refusalField(known), text: refusalText(known, name) };
};

/**
 * Links a GitHub App the user already has (#1321): its ID, and its private key pasted or read from
 * the `.pem` file in the browser. The key goes to the hub once, redacted, and the form forgets it as
 * soon as the hub has it. What the user typed stays when the hub refuses it (STD-REACT-016).
 */
export function LinkExistingApp({ hob, link, onClose }: { hob: Agent; link: Link; onClose: () => void }) {
  const ids = { appId: useId(), key: useId(), file: useId() };
  const [draft, setDraft] = useState<LinkDraft>(EMPTY_LINK);
  const [shown, setShown] = useState<{ appId: boolean; privateKey: boolean }>({ appId: false, privateKey: false });
  const errors = linkErrors(draft);
  const refused = refusalOf(link, hob.name);
  const errorOf = (field: keyof LinkErrors) =>
    (shown[field] ? errors[field] : undefined) ?? (refused?.field === field ? refused.text : undefined);
  const edit = (change: Partial<LinkDraft>) => {
    if (link.isError) link.reset();
    setDraft((before) => ({ ...before, ...change }));
  };
  const submit = () => {
    setShown({ appId: true, privateKey: true });
    if (Object.keys(errors).length > 0 || link.isPending) return;
    // The key is not kept here once the hub has it.
    link.mutate(linkOf(draft), {
      onSuccess: () => {
        setDraft(EMPTY_LINK);
        onClose();
      },
    });
  };
  return (
    <form
      aria-label={copy.linkTitle}
      className={CARD}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <span className="flex flex-col">
        <strong className="text-ui text-text-strong">{copy.linkTitle}</strong>
        <span className="text-detail text-text-secondary">
          {copy.linkNote({ name: hob.name })}{" "}
          <a href={GITHUB_APPS} target="_blank" rel="noreferrer" className="text-link underline">
            {copy.openApps}
          </a>
        </span>
      </span>
      <Field id={ids.appId} label={copy.appIdLabel} hint={copy.appIdHint} error={errorOf("appId")}>
        <Input
          id={ids.appId}
          value={draft.appId}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errorOf("appId") !== undefined}
          aria-describedby={`${ids.appId}-note`}
          onBlur={() => setShown((before) => ({ ...before, appId: true }))}
          onChange={(event) => edit({ appId: event.target.value })}
          className="max-w-[260px]"
        />
      </Field>
      <Field
        id={ids.key}
        label={copy.keyLabel}
        hint={copy.keyHint}
        error={errorOf("privateKey")}
        after={
          <KeyFile
            id={ids.file}
            onRead={(privateKey) => {
              setShown((before) => ({ ...before, privateKey: true }));
              edit({ privateKey });
            }}
          />
        }
      >
        <Textarea
          id={ids.key}
          value={draft.privateKey}
          text="mono"
          rows={4}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errorOf("privateKey") !== undefined}
          aria-describedby={`${ids.key}-note`}
          onBlur={() => setShown((before) => ({ ...before, privateKey: true }))}
          onChange={(event) => edit({ privateKey: event.target.value })}
          className="max-h-40"
        />
      </Field>
      {refused !== null && refused.field === null && (
        <span role="alert" className="text-detail text-rose">
          {refused.text}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={link.isPending}>
          {link.isPending ? copy.linking : copy.linkApp}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          {copy.cancel}
        </Button>
      </span>
    </form>
  );
}

/** A labelled field with its hint, and its error in place of the hint once there is one. */
function Field({
  id,
  label,
  hint,
  error,
  after,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error: string | undefined;
  /** What follows the hint, such as another way to fill the field. */
  after?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-detail font-bold text-text">
        {label}
      </label>
      {children}
      {error === undefined ? (
        <span id={`${id}-note`} className="text-meta text-text-secondary">
          {hint}
        </span>
      ) : (
        <span id={`${id}-note`} role="alert" className="text-meta text-rose">
          {error}
        </span>
      )}
      {after}
    </span>
  );
}

/** Reads the `.pem` file GitHub downloaded, in the browser; it never goes anywhere but the form. */
function KeyFile({ id, onRead }: { id: string; onRead: (text: string) => void }) {
  return (
    <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-detail text-label">
      {copy.chooseKey}
      <input
        id={id}
        type="file"
        accept=".pem,application/x-pem-file,text/plain"
        className="text-detail text-text-secondary file:me-3 file:cursor-pointer file:rounded-control file:border-(length:--edge) file:border-solid file:border-control file:bg-transparent file:px-3 file:py-1.5 file:text-text-strong"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file === undefined) return;
          // A file far past a key's size is read only as far as the form's own check needs.
          void file
            .slice(0, KEY_FILE_MAX + 1)
            .text()
            .then(onRead);
        }}
      />
    </label>
  );
}

/** Which permissions the app the user just linked lacks, so they can add them on GitHub. */
export function MissingPermissions({
  hob,
  missing,
}: {
  hob: Agent;
  missing: ReadonlyArray<HobGitHubAppMissingPermission>;
}) {
  if (missing.length === 0) return null;
  return (
    <span role="status" className="rounded-control bg-notice px-3 py-2 text-detail text-text">
      {missingText(hob.name, missing)}
    </span>
  );
}
