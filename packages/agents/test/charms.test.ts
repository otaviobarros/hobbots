import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { combineHubTools, type HubTools } from "../src/index.ts";

const set = (owner: string, names: ReadonlyArray<string>): HubTools => ({
  tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object" }, label: name })),
  call: (name) => Effect.succeed({ text: `${owner} ${name}`, refused: false }),
});

describe("combined hub tools", () => {
  it("offers every set's tools once and sends each call to the set that offers it", async () => {
    expect(combineHubTools()).toBeNull();
    expect(combineHubTools(null, null)).toBeNull();
    const tasks = set("tasks", ["plan_steps", "shared"]);
    expect(combineHubTools(null, tasks)).toBe(tasks);
    const both = combineHubTools(tasks, null, set("github", ["github_search", "shared"])) as HubTools;
    expect(both.tools.map((tool) => tool.name)).toEqual(["plan_steps", "shared", "github_search"]);
    const answer = (name: string) => Effect.runPromise(both.call(name, {})).then((a) => a.text);
    expect(await answer("github_search")).toBe("github github_search");
    expect(await answer("shared")).toBe("tasks shared");
    // A tool nobody offers goes to the first set, which refuses it in its own words.
    expect(await answer("nothing")).toBe("tasks nothing");
  });
});
