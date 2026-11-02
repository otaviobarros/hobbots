import type { Device } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { devicesChanged, devicesQuery } from "./devices.ts";

const named = (...ids: ReadonlyArray<string>) => ids.map((id) => ({ id }) as unknown as Device);

// Settings › Devices opens, and its first read answers only after a device was allowed elsewhere.
// covers DP-004
it("[TC-DP-128] drops a first read taken before a device was allowed, so the new device shows", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const reads: Array<(devices: ReadonlyArray<Device>) => void> = [];
  const observer = new QueryObserver(client, {
    ...devicesQuery,
    queryFn: () => new Promise<ReadonlyArray<Device>>((resolve) => reads.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => {});
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  const changed = devicesChanged(client);
  await tick();
  expect(reads).toHaveLength(2);
  reads[1]?.(named("window", "phone"));
  reads[0]?.(named("window"));
  await changed;
  await tick();
  expect(observer.getCurrentResult().data?.map((device) => device.id)).toEqual(["window", "phone"]);
  unsubscribe();
});
