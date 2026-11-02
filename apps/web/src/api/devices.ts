import type { Device, DeviceId } from "@hobbots/domain";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";

const devicesKey = ["devices"] as const;

/** Every device the hub approved, the hub's window first, revoked ones included (ADR 021). */
export const devicesQuery = queryOptions({
  queryKey: devicesKey,
  queryFn: () => call((c) => c.devices.list()),
});

/** The devices that may still reach the hub, as Settings › Devices lists them. */
export const approvedDevices = (devices: ReadonlyArray<Device>): ReadonlyArray<Device> =>
  devices.filter((device) => device.revokedAt === null);

/** A device was allowed or revoked, here or on another device: the list is read again. */
export const devicesChanged = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: devicesKey, exact: true });

/**
 * Revoke: the hub signs the device out at once, and it has to ask again. Revoking the device in use
 * is allowed; its next call is refused, and it shows that it was removed.
 */
export const useRevokeDevice = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: DeviceId) => call((c) => c.devices.revoke({ params: { deviceId } })),
    onSuccess: (revoked: Device) => {
      queryClient.setQueryData<ReadonlyArray<Device>>(devicesKey, (old) =>
        old?.map((device) => (device.id === revoked.id ? revoked : device)),
      );
      return devicesChanged(queryClient);
    },
  });
};
