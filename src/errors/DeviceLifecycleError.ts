import type { DeviceStatus } from '../types/device.types';

export type DeviceLifecycleState = DeviceStatus | 'unknown';

export class DeviceLifecycleError extends Error {
  public constructor(
    public readonly deviceId: string,
    public readonly from: DeviceLifecycleState,
    public readonly to: DeviceStatus,
  ) {
    super(`Device ${deviceId} cannot transition from ${from} to ${to}`);
    this.name = 'DeviceLifecycleError';
  }
}
