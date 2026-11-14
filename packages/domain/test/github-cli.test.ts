import { describe, expect, it } from "vitest";
import { GITHUB_CHARM_TOOLS, ghCommandOf, steerGh } from "../src/index.ts";

const words = (command: string) => command.split(" ");

describe("where a gh command is pointed (#1349)", () => {
  it("reads the command and subcommand past gh's options", () => {
    expect(ghCommandOf(words("pr create --fill"))).toBe("pr create");
    expect(ghCommandOf(words("-R octo/workshop pr view 3"))).toBe("pr view");
    expect(ghCommandOf(words("--repo octo/workshop issue list"))).toBe("issue list");
    expect(ghCommandOf(words("api user"))).toBe("api user");
    expect(ghCommandOf(["--version"])).toBe("");
    expect(ghCommandOf([])).toBe("");
  });

  it("names the Charm tool for what each command tried, when the turn offers it", () => {
    const steer = (command: string) => steerGh(words(command), GITHUB_CHARM_TOOLS);
    expect(steer("pr create --fill")).toContain("Use the github_open_pull_request tool instead of gh pr create:");
    expect(steer("pr new")).toContain("Use the github_open_pull_request tool instead of gh pr new:");
    expect(steer("pr comment 3 --body hi")).toContain("Use the github_comment tool instead of gh pr comment:");
    expect(steer("issue create -t x")).toContain("Use the github_open_issue tool instead of gh issue create:");
    expect(steer("issue new")).toContain("Use the github_open_issue tool instead of gh issue new:");
    expect(steer("issue comment 3 --body hi")).toContain("Use the github_comment tool instead of gh issue comment:");
    expect(steer("pr view 3")).toContain("Use the github_item tool instead of gh pr view:");
    expect(steer("issue view 3")).toContain("Use the github_item tool instead of gh issue view:");
    expect(steer("issue list")).toContain("Use the github_search tool instead of gh issue list:");
    expect(steer("search prs parser")).toContain("Use the github_search tool instead of gh search prs:");
    expect(steer("repo view")).toContain("Use the github_repository tool instead of gh repo view:");
    for (const command of ["pr create", "repo view", "api user"]) {
      expect(steer(command), command).toContain("gh cannot sign in from your sandbox, since no credential enters it.");
    }
  });

  it("names every Charm tool for other commands, and asks the user without them", () => {
    // Opening issues is the GitHub Charm's own tool (#1350); where Never keeps it out, it is named, not pointed to.
    expect(steerGh(words("issue create -t x"), ["github_item"])).toBe(
      "gh cannot sign in from your sandbox, since no credential enters it. The github_open_issue tool does what gh issue create would, and you are not offered it now. Tell the user what you need from GitHub instead.",
    );
    expect(steerGh(words("api user"), ["github_item", "github_search"])).toBe(
      "Reach GitHub with your GitHub Charm tools instead of gh api user: github_item, github_search. gh cannot sign in from your sandbox, since no credential enters it.",
    );
    // A write the turn is not offered, such as one whose answer is Never, is named but not pointed to.
    expect(steerGh(words("pr comment 3"), ["github_item"])).toBe(
      "gh cannot sign in from your sandbox, since no credential enters it. The github_comment tool does what gh pr comment would, and you are not offered it now. Tell the user what you need from GitHub instead.",
    );
    expect(steerGh(words("pr create"), [])).toBe(
      "gh cannot sign in from your sandbox, since no credential enters it. GitHub goes through the GitHub Charm, whose tools you are not offered now. Tell the user what you need from GitHub instead.",
    );
  });
});
