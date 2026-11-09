import type { HobGitHubAppLink, HobGitHubAppMissingPermission, HobGitHubAppRefused } from "@hobbots/api";
import { Redacted, Schema } from "effect";
import { formatList } from "../../lib/format.ts";
import { messages } from "../messages.ts";

const copy = messages.charms.github.app;

/** What the user typed to link an app they already have (#1321). */
export interface LinkDraft {
  readonly appId: string;
  readonly privateKey: string;
}

export const EMPTY_LINK: LinkDraft = { appId: "", privateKey: "" };

/** What is wrong with the link form, by field. */
export interface LinkErrors {
  readonly appId?: string;
  readonly privateKey?: string;
}

/** GitHub's private keys are under 4 KB; a file much longer is not one. */
export const KEY_FILE_MAX = 16_384;

// An App ID, or a Client ID such as `Iv1.0123abcd` or `Iv23li…`, as the hub accepts them.
const AppIdField = Schema.String.check(Schema.isPattern(/^(?:[0-9]{1,12}|Iv[0-9A-Za-z.]{1,40})$/));
// A PEM block: a private key, whole, from its first line to its last.
const KeyField = Schema.String.check(
  Schema.isMaxLength(KEY_FILE_MAX),
  Schema.isPattern(/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----$/),
);

/** The link form's rules (STD-REACT-017): an ID GitHub could name, and a whole private key. */
export const linkErrors = (draft: LinkDraft): LinkErrors => {
  const errors: { appId?: string; privateKey?: string } = {};
  if (Schema.decodeUnknownOption(AppIdField)(draft.appId.trim())._tag === "None") errors.appId = copy.appIdMissing;
  const key = draft.privateKey.trim();
  if (key.length > KEY_FILE_MAX) errors.privateKey = copy.keyTooLarge;
  else if (Schema.decodeUnknownOption(KeyField)(key)._tag === "None") errors.privateKey = copy.keyMissing;
  return errors;
};

/** What the hub is sent: the key redacted, so nothing on the way logs or shows it. */
export const linkOf = (draft: LinkDraft): HobGitHubAppLink => ({
  appId: draft.appId.trim(),
  privateKey: Redacted.make(draft.privateKey.trim()),
});

type Reason = HobGitHubAppRefused["reason"];

/** The field a refusal of the hub's belongs to, so it shows there (STD-REACT-017); null for the form as a whole. */
export const refusalField = (reason: Reason): keyof LinkErrors | null => {
  if (reason === "bad-id") return "appId";
  if (reason === "not-a-key" || reason === "key-refused") return "privateKey";
  return null;
};

/** The hub's refusal in the user's words (STD-I18N-005). */
export const refusalText = (reason: Reason, name: string): string => copy.linkRefused[reason]({ name });

/** The permissions a linked app lacks, as one sentence. */
export const missingText = (name: string, missing: ReadonlyArray<HobGitHubAppMissingPermission>): string =>
  copy.missingPermissions({
    name,
    list: formatList(
      missing.map((each) => copy.permissionAccess({ name: copy.permissionNames[each.name], access: each.access })),
    ),
  });
