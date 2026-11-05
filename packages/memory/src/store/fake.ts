import { guardMemoryStore, MemoryStore, type MemoryStoreShape } from "@hobbots/agents";
import {
  foldWord,
  type MemoryAuthor,
  MemoryConflict,
  type MemoryExpected,
  type MemoryHit,
  type MemoryPage,
  type MemoryPageSummary,
  type MemoryPath,
  type MemoryScope,
  MemoryUnavailable,
  MemoryVersion,
  memoryAuthorOf,
  searchTerms,
  snippetOf,
} from "@hobbots/domain";
import { DateTime, Effect, Layer } from "effect";

/**
 * An in-memory `MemoryStore` for tests (ADR 028), so the memory tools, the brief and the Memory page
 * run on the fake runtime without the ai-memory binary. It keeps every version and can be taken down
 * to test an outage.
 */

interface StoredVersion {
  readonly version: MemoryVersion;
  readonly markdown: string;
  readonly tags: ReadonlyArray<string>;
  readonly pinned: boolean;
  readonly author: MemoryAuthor | null;
  readonly writtenAt: string;
  /** A forget leaves a tombstone, so the page is gone and restore can still find its versions. */
  readonly forgotten: boolean;
}

export interface MemoryStoreFakeControls {
  /** While down, every call fails with `MemoryUnavailable`. */
  readonly setDown: (down: boolean) => void;
}

const WORD = /[\p{L}\p{N}]+/gu;

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

const titleOf = (path: MemoryPath, markdown: string) =>
  /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? path.replace(/^.*\//, "").replace(/\.md$/, "");

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
  let down = false;
  let versions = 0;

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

  const summaries = (scope: MemoryScope): Array<MemoryPageSummary> =>
    [...pagesOf(scope).entries()].flatMap(([path, history]) => {
      const latest = history.at(-1);
      if (latest === undefined || latest.forgotten) return [];
      return [
        { scope, path, title: titleOf(path, latest.markdown), pinned: latest.pinned, updatedAt: latest.writtenAt },
      ];
    });

  const pageOf = (scope: MemoryScope, path: MemoryPath): MemoryPage | null => {
    const current = currentOf(scope, path);
    if (current === undefined) return null;
    const { version, markdown, tags, pinned, author, writtenAt } = current;
    return { scope, path, markdown, tags, pinned, version, author, updatedAt: writtenAt };
  };

  const store: MemoryStoreShape = {
    search: (_actor, inScopes, query, limit) =>
      Effect.map(up, () => {
        const terms = searchTerms(query);
        if (terms.length === 0) return [];
        const hits: Array<MemoryHit & { readonly updatedAt: string }> = [];
        for (const scope of inScopes) {
          for (const summary of summaries(scope)) {
            const page = pageOf(scope, summary.path) as MemoryPage;
            const text = `${summary.title}\n${page.markdown}\n${page.tags.join(" ")}`;
            const words = (text.match(WORD) ?? []).map(foldWord);
            if (!terms.every((term) => words.some((word) => word.startsWith(term)))) continue;
            const snippet = snippetOf(text, terms)
              .map((part) => part.text)
              .join("");
            hits.push({ scope, path: summary.path, title: summary.title, snippet, updatedAt: summary.updatedAt });
          }
        }
        return hits
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, limit)
          .map(({ updatedAt: _, ...hit }) => hit);
      }),
    page: (_actor, scope, path) => Effect.map(up, () => pageOf(scope, path)),
    pageAt: (_actor, scope, path, version) =>
      Effect.map(up, () => {
        if (currentOf(scope, path) === undefined) return null;
        const found = pagesOf(scope)
          .get(path)
          ?.find((entry) => entry.version === version && !entry.forgotten);
        if (found === undefined) return null;
        const { markdown, tags, pinned, author, writtenAt } = found;
        return { scope, path, markdown, tags, pinned, version, author, updatedAt: writtenAt };
      }),
    scopes: () =>
      Effect.map(up, () =>
        [...scopes.values()].filter((entry) => summaries(entry.scope).length > 0).map((entry) => entry.scope),
      ),
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
        const history = (pagesOf(scope).get(path) ?? []).filter((entry) => !entry.forgotten);
        return history
          .map((entry) => ({
            version: entry.version,
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
              markdown: draft.markdown,
              tags: draft.tags,
              pinned: draft.pinned,
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
    restore: (actor, scope, path, version) =>
      Effect.flatMap(up, () => {
        const old = pagesOf(scope)
          .get(path)
          ?.find((entry) => entry.version === version && !entry.forgotten);
        return old === undefined
          ? Effect.fail(conflict(scope, path))
          : append(scope, path, { ...old, author: memoryAuthorOf(actor), forgotten: false });
      }),
    health: up,
  };

  return {
    store: guardMemoryStore(store),
    controls: {
      setDown: (value) => {
        down = value;
      },
    },
  };
};

/** `MemoryStore` kept in memory, fresh for each layer build. */
export const MemoryStoreFake = Layer.sync(MemoryStore, () => MemoryStore.of(makeMemoryStoreFake().store));
