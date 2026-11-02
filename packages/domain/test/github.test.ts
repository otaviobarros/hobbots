import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  commentMarker,
  GITHUB_TOOLS,
  GITHUB_UNTRUSTED,
  GitHubToolInputs,
  githubCommentSummary,
  githubItemText,
  githubPullRequestSummary,
  githubRepositoryOf,
  githubSearchQuery,
  githubSearchText,
  githubToolJsonSchema,
  hasCommentMarker,
  isGitHubToolName,
  PULL_REQUEST_BODY_SHOWN,
  stripCommentMarkers,
} from "../src/index.ts";

describe("GitHub remotes", () => {
  it("names the github.com repository of the usual remote shapes", () => {
    for (const remote of [
      "https://github.com/otaviobarros/hobbots.git",
      "https://github.com/otaviobarros/hobbots",
      "https://github.com/otaviobarros/hobbots/",
      "git@github.com:otaviobarros/hobbots.git",
      "ssh://git@github.com/otaviobarros/hobbots.git",
      " https://GitHub.com/otaviobarros/hobbots.git\n",
    ]) {
      expect(githubRepositoryOf(remote)).toEqual({ owner: "otaviobarros", name: "hobbots" });
    }
  });

  it("names no repository on another host, with credentials, a port or an odd path", () => {
    for (const remote of [
      "",
      "https://gitlab.com/otaviobarros/hobbots.git",
      "https://github.com.evil.example/otaviobarros/hobbots",
      "https://user:token@github.com/otaviobarros/hobbots.git",
      "https://token@github.com/otaviobarros/hobbots.git",
      "https://github.com:8443/otaviobarros/hobbots.git",
      "https://github.com/otaviobarros/hobbots?x=1",
      "https://github.com/otaviobarros",
      "https://github.com/otaviobarros/hobbots/issues",
      "https://github.com/-bad/hobbots",
      "https://github.com/otaviobarros/..",
      "http://github.com/otaviobarros/hobbots.git",
      "/srv/git/hobbots.git",
      "file:///srv/git/hobbots.git",
    ]) {
      expect(githubRepositoryOf(remote)).toBeNull();
    }
  });

  it("reads a long run of slashes in linear time", () => {
    const started = performance.now();
    expect(githubRepositoryOf(`https://github.com/${"/".repeat(100_000)}x`)).toBeNull();
    expect(githubRepositoryOf(`https://github.com/otaviobarros/hobbots${"/".repeat(100_000)}`)).toEqual({
      owner: "otaviobarros",
      name: "hobbots",
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("GitHub tools", () => {
  const repository = { owner: "otaviobarros", name: "hobbots" };
  const decode = Schema.decodeUnknownSync(GitHubToolInputs.github_search);

  it("advertises each tool with a JSON Schema", () => {
    for (const tool of GITHUB_TOOLS) {
      expect(isGitHubToolName(tool.name)).toBe(true);
      expect(githubToolJsonSchema(tool.name)).toMatchObject({ type: "object" });
    }
    expect(isGitHubToolName("plan_steps")).toBe(false);
  });

  it("scopes every search to the hub's repository, whatever the hob asks", () => {
    expect(githubSearchQuery(repository, decode({ kind: "issue" }))).toBe("repo:otaviobarros/hobbots is:issue is:open");
    expect(githubSearchQuery(repository, decode({ kind: "pull_request", state: "merged", label: "area: web" }))).toBe(
      'repo:otaviobarros/hobbots is:pr is:merged label:"area: web"',
    );
    expect(githubSearchQuery(repository, decode({ kind: "pull_request", state: "all", assignee: "octocat" }))).toBe(
      "repo:otaviobarros/hobbots is:pr assignee:octocat",
    );
  });

  it("keeps a label's words inside its quotes", () => {
    expect(githubSearchQuery(repository, decode({ kind: "issue", label: "repo:other/secret" }))).toBe(
      'repo:otaviobarros/hobbots is:issue is:open label:"repo:other/secret"',
    );
  });

  it("refuses words that could add a qualifier, such as another repository", () => {
    for (const input of [
      { kind: "issue", label: 'x" repo:other/secret' },
      { kind: "issue", label: "a\nb" },
      { kind: "issue", assignee: "octocat repo:other/secret" },
      { kind: "issue", limit: 31 },
      { kind: "commit" },
    ]) {
      expect(() => decode(input)).toThrow();
    }
  });

  it("writes answers a hob can read", () => {
    const items = [
      { number: 315, title: "Stop refetching", state: "merged", author: "otaviobarros", updatedAt: "2026-11-01" },
    ];
    expect(githubSearchText({ query: "repo:o/r is:pr", total: 12, items })).toBe(
      `${GITHUB_UNTRUSTED}\n12 matches for \`repo:o/r is:pr\`.\n#315 [merged] Stop refetching by @otaviobarros, updated 2026-11-01\nShowing the 1 most recently updated.`,
    );
    expect(githubSearchText({ query: "q", total: 1, items: [] })).toBe(`${GITHUB_UNTRUSTED}\n1 match for \`q\`.`);
    const text = githubItemText({
      ...(items[0] as (typeof items)[number]),
      pullRequest: true,
      url: "https://github.com/o/r/pull/315",
      body: "",
      labels: ["area: web"],
      commentCount: 3,
      comments: [{ author: null, createdAt: "2026-11-01", body: "Looks good." }],
    });
    expect(text.startsWith(GITHUB_UNTRUSTED)).toBe(true);
    expect(text).toContain("Pull request #315 [merged]");
    expect(text).toContain("No description.");
    expect(text).toContain("3 comments, the first 1 below.");
    expect(text).toContain("Comment on 2026-11-01:\nLooks good.");
  });
});

describe("the comment marker", () => {
  it("strips every HTML comment that starts with the marker's word, closed or not, in any case", () => {
    expect(stripCommentMarkers("a<!-- hobbots-call: x -->b")).toBe("ab");
    expect(stripCommentMarkers("a<!--\n\tHOBBOTS-CALL x-->b<!-- note -->c")).toBe("ab<!-- note -->c");
    expect(stripCommentMarkers("keep <!-- hobbots-call: runs to the end")).toBe("keep ");
    expect(stripCommentMarkers("<!-- other --> <!--")).toBe("<!-- other --> <!--");
  });

  it("finds a marker that stripping joined from the text around it", () => {
    const joined = stripCommentMarkers("<!<!-- hobbots-call: x -->-- hobbots-call: y -->");
    expect(joined).toBe("<!-- hobbots-call: y -->");
    expect(hasCommentMarker(joined)).toBe(true);
    expect(hasCommentMarker("<!-- hobbots -->")).toBe(false);
    expect(hasCommentMarker(commentMarker("n"))).toBe(true);
  });

  it("runs in linear time on long runs of the characters it looks for", () => {
    const started = performance.now();
    for (const text of ["<!--".repeat(50_000), `<!--${" ".repeat(200_000)}`, "<!-- hobbots-call".repeat(20_000)]) {
      hasCommentMarker(stripCommentMarkers(text));
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("the GitHub write cards", () => {
  const pr = {
    repository: "octo/app",
    folder: "/work/app",
    head: "feat/x",
    base: "main",
    title: "feat: x",
    body: "",
    draft: false,
    actingAs: null,
  };

  it("say what is opened or posted, where, and as whom", () => {
    expect(githubPullRequestSummary(pr)).toBe(
      "Open a pull request in octo/app from feat/x into main\nTitle: feat: x\nNo description.\nAs you.",
    );
    expect(githubPullRequestSummary({ ...pr, body: "x".repeat(PULL_REQUEST_BODY_SHOWN + 5) })).toContain(
      "[5 more characters]",
    );
    expect(
      githubCommentSummary({
        repository: "octo/app",
        folder: "/work/app",
        number: 7,
        pullRequest: false,
        itemTitle: "Bug",
        body: "Fixed.",
        actingAs: "me",
      }),
    ).toBe("Comment on issue #7 in octo/app: Bug\n\nFixed.\n\nAs you (@me).");
  });
});
