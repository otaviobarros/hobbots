import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { Redacted } from "effect";
import { expect, it } from "vitest";
import { type LinkOnce, linkOnce, sendLinkOnce } from "./hob-github-app.ts";

const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";

// The user links an app, then the form closes: TanStack Query keeps the mutation's variables.
// covers PE-002, #1321
it("[TC-PE-522] sends a linked app's key once and keeps no copy in the mutation, whether it succeeds or fails", async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const sent: Array<string> = [];
  for (const answer of ["linked", "refused"] as const) {
    const observer = new MutationObserver(client, {
      mutationFn: sendLinkOnce((link) => {
        sent.push(Redacted.value(link.privateKey));
        return answer === "linked" ? Promise.resolve(answer) : Promise.reject(new Error(answer));
      }),
    });
    await observer.mutate(linkOnce({ appId: "Iv23li", privateKey: Redacted.make(KEY) })).catch(() => undefined);
    const kept = observer.getCurrentResult().variables as LinkOnce | undefined;
    expect(kept).toBeDefined();
    expect(kept?.take()).toBeNull();
    for (const mutation of client.getMutationCache().getAll()) {
      expect((mutation.state.variables as LinkOnce).take()).toBeNull();
    }
  }
  expect(sent).toEqual([KEY, KEY]);
  // One already sent is never sent again.
  const once = linkOnce({ appId: "123", privateKey: Redacted.make(KEY) });
  const send = sendLinkOnce(() => Promise.resolve("linked"));
  await send(once);
  await expect(send(once)).rejects.toThrow();
});
