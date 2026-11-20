export type DeviceStatus = 'provisioned' | 'active' | 'decommissioned';

export interface ProvisionDeviceInput {
  readonly name: string;
  readonly model: string;
  readonly sensor_type: string;
  readonly firmware: string;
}

export interface DeviceData {
  readonly model: string;
  readonly sensor_type: string;
  readonly firmware: string;
  readonly status: DeviceStatus;
  readonly lastReading?: number;
}

export interface DeviceResource {
  readonly id: string;
  readonly name: string;
  readonly data: DeviceData;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface DeviceOperationResult {
  readonly status: 200;
  readonly device: DeviceResource;
}

export interface DeviceDecommissionResult {
  readonly status: 200;
  readonly message: string;
}

export type DeviceLookupResult =
  | {
      readonly status: 200;
      readonly device: DeviceResource;
    }
  | {
      readonly status: 404;
      readonly body: unknown;
    };
