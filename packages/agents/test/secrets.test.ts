import { describe, expect, it } from "vitest";
import { makeRedactor, redactEvent } from "../src/secrets.ts";

const call = { tool: "Bash", operation: "push", label: "Running git push" } as const;

describe("secret redaction", () => {
  it("redacts what a tool event says about the call and leaves the reply's text alone", () => {
    const redactor = makeRedactor([{ value: "known-hub-value-1234", kind: "HUB_TOKEN" }]);
    const remote = "https://me:known-hub-value-1234@example.com/app.git";
    expect(
      redactEvent(
        {
          _tag: "ToolDenied",
          id: "t1",
          ...call,
          targets: [remote],
          reason: `${remote} is not allowed.`,
          decidedBy: "policy",
        },
        redactor,
      ),
    ).toMatchObject({
      targets: ["https://me:[redacted: HUB_TOKEN]@example.com/app.git"],
      reason: "https://me:[redacted: HUB_TOKEN]@example.com/app.git is not allowed.",
    });
    const text = { _tag: "TextDelta", text: "known-hub-value-1234" } as const;
    expect(redactEvent(text, redactor)).toBe(text);
  });

  it("redacts a value remembered after it was made, such as a turn's sign-in", () => {
    const redactor = makeRedactor();
    expect(redactor.text("token sign-in-value-5678")).toBe("token sign-in-value-5678");
    redactor.remember({ value: "sign-in-value-5678", kind: "Claude sign-in" });
    redactor.remember({ value: "sign-in-value-5678", kind: "Claude sign-in" });
    expect(redactor.text("token sign-in-value-5678")).toBe("token [redacted: Claude sign-in]");
    expect(redactor.value({ env: ["sign-in-value-5678"] })).toEqual({ env: ["[redacted: Claude sign-in]"] });
  });
});
