import { guardMemoryStore, MemoryStore, type MemoryStoreShape } from "@hobbots/agents";
import {
  type MemoryAuthor,
  type MemoryCaptureItem,
  type MemoryChangedLine,
  MemoryConflict,
  type MemoryExpected,
  type MemoryFinding,
  type MemoryForgetDay,
  type MemoryHit,
  type MemoryPage,
  type MemoryPageSummary,
  MemoryPath,
  type MemoryScope,
  type MemorySessionId,
  MemoryUnavailable,
  MemoryVersion,
  memoryAuthorOf,
  memoryForgotten,
  memorySearchTerms,
  memorySnippetOf,
  memoryTermsFound,
  memoryTitleOf,
  memoryWordsOf,
} from "@hobbots/domain";
import { diffLines } from "diff";
import { DateTime, Effect, Layer } from "effect";
import { pageHeading } from "./heading.ts";

/**
 * An in-memory `MemoryStore` for tests (ADR 028), so the memory tools, the brief and the Memory page
 * run on the fake runtime without the ai-memory binary. It keeps every version and can be taken down
 * to test an outage.
 */

/** Every line of `after` against `before`: the ones added, removed and kept. */
const changedLines = (before: string, after: string): Array<MemoryChangedLine> =>
  diffLines(before, after).flatMap((part) => {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const op = part.added ? "add" : part.removed ? "remove" : "same";
    return lines.map((text) => ({ op, text }));
  });

interface StoredVersion {
  readonly version: MemoryVersion;
  /** The title kept beside the page, as a chat's summary has; null when its markdown names it. */
  readonly title: string | null;
  readonly markdown: string;
  readonly tags: ReadonlyArray<string>;
  readonly pinned: boolean;
  readonly forgetOn: MemoryForgetDay | null;
  readonly author: MemoryAuthor | null;
  readonly writtenAt: string;
  /** A forget leaves a tombstone, so the page is gone and restore can still find its versions. */
  readonly forgotten: boolean;
}

export interface MemoryStoreFakeControls {
  /** While down, every call fails with `MemoryUnavailable`. */
  readonly setDown: (down: boolean) => void;
  /** What a session holds in `scope`, in the order it arrived, replays skipped. */
  readonly captured: (scope: MemoryScope, sessionId: MemorySessionId) => ReadonlyArray<MemoryCaptureItem>;
  /** Has Check now find `finding`, while every page it names is still there. */
  readonly flag: (finding: MemoryFinding) => void;
}

/** A session: what arrived, and every key seen, the ends' included. */
interface Session {
  readonly items: Array<MemoryCaptureItem>;
  readonly seen: Set<string>;
}

/**
 * The fake's summary of a session, as a model-free summary writes it: its first message as the title,
 * kept beside the page as the engine keeps it in frontmatter, and a body of each item, with no `# `
 * heading of its own.
 */
const summaryOf = (sessionId: MemorySessionId, items: ReadonlyArray<MemoryCaptureItem>) => ({
  title: items.find((item) => item.kind === "message")?.text.split("\n", 1)[0] ?? `Session ${sessionId}`,
  markdown: [
    "## Summary",
    "",
    ...items.map((item) => `- ${item.kind}: ${item.text.replace(/\s+/g, " ").trim()}`),
    "",
  ].join("\n"),
});

/** A version's title as the engine names it: the title kept beside it, its first `# ` heading, or its file name. */
const titleOf = (path: MemoryPath, version: StoredVersion) =>
  version.title ?? memoryTitleOf(path, pageHeading(version.markdown));

const scopeKey = (scope: MemoryScope) => {
  switch (scope._tag) {
    case "Hob":
      return `hob:${scope.agentId}`;
    case "Project":
      return `project:${scope.identity}`;
    case "Everyone":
      return "everyone";
  }
};

const meets = (latest: StoredVersion | undefined, expected: MemoryExpected) => {
  const current = latest === undefined || latest.forgotten ? null : latest.version;
  switch (expected._tag) {
    case "Any":
      return true;
    case "New":
      return current === null;
    case "Version":
      return current === expected.version;
  }
};

/** A fake memory and the switch that takes it down. */
export const makeMemoryStoreFake = (): {
  readonly store: MemoryStoreShape;
  readonly controls: MemoryStoreFakeControls;
} => {
  const scopes = new Map<
    string,
    { readonly scope: MemoryScope; readonly pages: Map<MemoryPath, Array<StoredVersion>> }
  >();
  const sessions = new Map<string, Session>();
  const flagged: Array<MemoryFinding> = [];
  let down = false;
  let versions = 0;
  const sessionOf = (scope: MemoryScope, sessionId: MemorySessionId) => {
    const key = `${scopeKey(scope)} ${sessionId}`;
    const existing = sessions.get(key);
    if (existing) return existing;
    const session: Session = { items: [], seen: new Set() };
    sessions.set(key, session);
    return session;
  };

  const up = Effect.suspend(() =>
    down ? Effect.fail(new MemoryUnavailable({ message: "The fake memory is down." })) : Effect.void,
  );
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const pagesOf = (scope: MemoryScope) => {
    const key = scopeKey(scope);
    const existing = scopes.get(key);
    if (existing) return existing.pages;
    const pages = new Map<MemoryPath, Array<StoredVersion>>();
    scopes.set(key, { scope, pages });
    return pages;
  };
  const latestOf = (scope: MemoryScope, path: MemoryPath) => pagesOf(scope).get(path)?.at(-1);
  const currentOf = (scope: MemoryScope, path: MemoryPath) => {
    const latest = latestOf(scope, path);
    return latest === undefined || latest.forgotten ? undefined : latest;
  };
  /**
   * The versions the page's history shows, oldest first: as the engine does, a forget takes the
   * history with it, so a page started again after a forget shows only what came after.
   */
  const shownOf = (scope: MemoryScope, path: MemoryPath) => {
    const stored = pagesOf(scope).get(path) ?? [];
    return stored.slice(stored.findLastIndex((entry) => entry.forgotten) + 1);
  };
  const conflict = (scope: MemoryScope, path: MemoryPath) =>
    new MemoryConflict({ path, current: currentOf(scope, path)?.version ?? null });

  const append = (scope: MemoryScope, path: MemoryPath, entry: Omit<StoredVersion, "version" | "writtenAt">) =>
    Effect.map(now, (writtenAt) => {
      versions += 1;
      const version = MemoryVersion.make(`v${versions}`);
      const pages = pagesOf(scope);
      pages.set(path, [...(pages.get(path) ?? []), { ...entry, version, writtenAt }]);
      return version;
    });

  // As the engine does, a page past its forget day leaves every list and search; a read still finds it.
  const summaries = (scope: MemoryScope): Array<MemoryPageSummary> =>
    [...pagesOf(scope).entries()].flatMap(([path, history]) => {
      const latest = history.at(-1);
      if (latest === undefined || latest.forgotten || memoryForgotten(latest.forgetOn, new Date())) return [];
      return [
        {
          scope,
          path,
          title: titleOf(path, latest),
          pinned: latest.pinned,
          updatedAt: latest.writtenAt,
        },
      ];
    });

  const pageOf = (scope: MemoryScope, path: MemoryPath): MemoryPage | null => {
    const current = currentOf(scope, path);
    if (current === undefined) return null;
    const { version, markdown, tags, pinned, forgetOn, author, writtenAt } = current;
    return {
      scope,
      path,
      title: titleOf(path, current),
      markdown,
      tags,
      pinned,
      forgetOn,
      version,
      author,
      updatedAt: writtenAt,
    };
  };

  const store: MemoryStoreShape = {
    search: (_actor, inScopes, query, limit) =>
      Effect.map(up, () => {
        const terms = memorySearchTerms(query);
        if (terms.length === 0) return [];
        const hits: Array<MemoryHit & { readonly found: number; readonly updatedAt: string }> = [];
        for (const scope of inScopes) {
          for (const summary of summaries(scope)) {
            const page = pageOf(scope, summary.path) as MemoryPage;
            const text = `${summary.title}\n${page.markdown}\n${page.tags.join(" ")}`;
            const found = memoryTermsFound(memoryWordsOf(text), terms);
            if (found === 0) continue;
            const snippet = memorySnippetOf(text, terms)
              .map((part) => part.text)
              .join("");
            hits.push({
              scope,
              path: summary.path,
              title: summary.title,
              snippet,
              found,
              updatedAt: summary.updatedAt,
            });
          }
        }
        // Best first, as near as a fake comes to ai-memory's bm25: the pages that hold more of the words first.
        return hits
          .sort((a, b) => b.found - a.found || b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, limit)
          .map(({ found: _, updatedAt: __, ...hit }) => hit);
      }),
    page: (_actor, scope, path) => Effect.map(up, () => pageOf(scope, path)),
    versionChanges: (_actor, scope, path, version) =>
      Effect.map(up, () => {
        if (currentOf(scope, path) === undefined) return null;
        const versions = (pagesOf(scope).get(path) ?? []).filter((entry) => !entry.forgotten);
        const at = versions.findIndex((entry) => entry.version === version);
        const found = versions[at];
        if (found === undefined) return null;
        const before = at === 0 ? null : (versions[at - 1]?.markdown ?? null);
        return { first: before === null, lines: changedLines(before ?? "", found.markdown), cut: false };
      }),
    versionText: (_actor, scope, path, version, known) =>
      Effect.map(up, () => {
        const versions = currentOf(scope, path) === undefined ? [] : shownOf(scope, path);
        if (!versions.some((entry) => entry.version === known.version)) return null;
        return versions.find((entry) => entry.version === version)?.markdown ?? null;
      }),
    list: (_actor, scope, limit) =>
      Effect.map(up, () =>
        summaries(scope)
          .sort(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) ||
              b.updatedAt.localeCompare(a.updatedAt) ||
              a.path.localeCompare(b.path),
          )
          .slice(0, limit),
      ),
    scopes: () =>
      Effect.map(up, () =>
        [...scopes.values()].filter(({ scope }) => summaries(scope).length > 0).map(({ scope }) => scope),
      ),
    changes: (_actor, scope, since) =>
      Effect.map(up, () =>
        summaries(scope)
          .filter((summary) => summary.updatedAt > since)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.path.localeCompare(b.path)),
      ),
    history: (_actor, scope, path) =>
      Effect.map(up, () => {
        const latest = currentOf(scope, path);
        // A forgotten page has no history to show; its versions stay only for restore.
        if (latest === undefined) return [];
        // Each version names the one it replaced: a page started again after a forget replaces nothing.
        const shown = shownOf(scope, path);
        return shown
          .map((entry, at) => ({
            version: entry.version,
            supersedes: shown[at - 1]?.version ?? null,
            author: entry.author,
            writtenAt: entry.writtenAt,
            latest: entry === latest,
          }))
          .reverse();
      }),
    write: (actor, scope, draft, expected) =>
      Effect.flatMap(up, () =>
        meets(latestOf(scope, draft.path), expected)
          ? append(scope, draft.path, {
              // As the engine does, a page written again without a `# ` heading keeps the title it had.
              title: pageHeading(draft.markdown) !== undefined ? null : (latestOf(scope, draft.path)?.title ?? null),
              markdown: draft.markdown,
              tags: draft.tags,
              pinned: draft.pinned,
              forgetOn: draft.forgetOn ?? null,
              author: memoryAuthorOf(actor),
              forgotten: false,
            })
          : Effect.fail(conflict(scope, draft.path)),
      ),
    forget: (actor, scope, path, expected) =>
      Effect.flatMap(up, () => {
        if (!meets(latestOf(scope, path), expected)) return Effect.fail(conflict(scope, path));
        const current = currentOf(scope, path);
        if (current === undefined) return Effect.succeed(null);
        return Effect.as(
          append(scope, path, { ...current, author: memoryAuthorOf(actor), forgotten: true }),
          current.version,
        );
      }),
    restore: (actor, scope, path, version, expected) =>
      Effect.flatMap(up, () => {
        if (!meets(latestOf(scope, path), expected)) return Effect.fail(conflict(scope, path));
        const old = pagesOf(scope)
          .get(path)
          ?.find((entry) => entry.version === version && !entry.forgotten);
        return old === undefined
          ? Effect.fail(conflict(scope, path))
          : append(scope, path, { ...old, author: memoryAuthorOf(actor), forgotten: false });
      }),
    capture: (_actor, scope, sessionId, items) =>
      Effect.map(up, () => {
        const session = sessionOf(scope, sessionId);
        for (const item of items) {
          if (session.seen.has(item.key)) continue;
          session.seen.add(item.key);
          session.items.push(item);
        }
        return items.length;
      }),
    endSession: (actor, scope, sessionId, key) =>
      Effect.flatMap(up, () => {
        const session = sessionOf(scope, sessionId);
        const path = MemoryPath.make(`sessions/${sessionId.toLowerCase()}.md`);
        // A pinned chat note is never rewritten: the end waits, its key unused, until you unpin it.
        if (currentOf(scope, path)?.pinned === true) return Effect.succeed(false);
        if (session.seen.has(key)) return Effect.succeed(true);
        session.seen.add(key);
        return append(scope, path, {
          ...summaryOf(sessionId, session.items),
          tags: [],
          pinned: false,
          forgetOn: null,
          author: memoryAuthorOf(actor),
          forgotten: false,
        }).pipe(Effect.as(true));
      }),
    check: (_actor, scope) =>
      Effect.map(up, () =>
        flagged.filter(
          (finding) =>
            scopeKey(finding.scope) === scopeKey(scope) &&
            finding.paths.every((path) => currentOf(scope, path) !== undefined),
        ),
      ),
    health: up,
  };

  return {
    store: guardMemoryStore(store),
    controls: {
      setDown: (value) => {
        down = value;
      },
      captured: (scope, sessionId) => [...sessionOf(scope, sessionId).items],
      flag: (finding) => {
        flagged.push(finding);
      },
    },
  };
};

/** `MemoryStore` kept in memory, fresh for each layer build. */
export const MemoryStoreFake = Layer.sync(MemoryStore, () => MemoryStore.of(makeMemoryStoreFake().store));
