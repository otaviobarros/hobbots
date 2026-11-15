import type { ChannelId, ClaimClash } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { applyClaimEvent, clashesQuery } from "./clashes.ts";

const clash = (key: string) => ({ key }) as unknown as ClaimClash;

// A camp opens, and its first read of the clashes answers only after a Task claimed a file.
it("drops a first read of the clashes taken before a claim, so the new Heads-up shows (#1390)", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const reads: Array<(clashes: ReadonlyArray<ClaimClash>) => void> = [];
  const observer = new QueryObserver(client, {
    ...clashesQuery("channel-1" as ChannelId),
    queryFn: () => new Promise<ReadonlyArray<ClaimClash>>((resolve) => reads.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  const changed = applyClaimEvent(client);
  await tick();
  expect(reads).toHaveLength(2);
  reads[1]?.([clash("checkout/payments.ts")]);
  reads[0]?.([]);
  await changed;
  await tick();
  expect(observer.getCurrentResult().data).toEqual([clash("checkout/payments.ts")]);
  unsubscribe();
});
