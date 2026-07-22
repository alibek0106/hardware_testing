import type { APIRequestContext } from '@playwright/test';
import { ApiResponseValidationError } from '../errors/ApiResponseValidationError';
import { DeviceLifecycleError } from '../errors/DeviceLifecycleError';
import type {
  DeviceData,
  DeviceDecommissionResult,
  DeviceLookupResult,
  DeviceOperationResult,
  DeviceResource,
  DeviceStatus,
  ProvisionDeviceInput,
} from '../types/device.types';
import { BaseApiClient } from './BaseApiClient';

type JsonRecord = Record<string, unknown>;

const objectsPath = '/objects';

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDeviceStatus = (value: unknown): value is DeviceStatus =>
  value === 'provisioned' || value === 'active' || value === 'decommissioned';

const parseDeviceResource = (body: unknown): DeviceResource => {
  if (!isJsonRecord(body)) {
    throw new ApiResponseValidationError('The device response is not an object', body);
  }

  const data = body.data;

  if (
    typeof body.id !== 'string' ||
    typeof body.name !== 'string' ||
    !isJsonRecord(data) ||
    typeof data.model !== 'string' ||
    typeof data.sensor_type !== 'string' ||
    typeof data.firmware !== 'string' ||
    !isDeviceStatus(data.status)
  ) {
    throw new ApiResponseValidationError('The device response has an unexpected structure', body);
  }

  return {
    id: body.id,
    name: body.name,
    data: {
      model: data.model,
      sensor_type: data.sensor_type,
      firmware: data.firmware,
      status: data.status,
    },
    ...(typeof body.createdAt === 'string' ? { createdAt: body.createdAt } : {}),
    ...(typeof body.updatedAt === 'string' ? { updatedAt: body.updatedAt } : {}),
  };
};

const parseDeleteMessage = (body: unknown): string => {
  if (!isJsonRecord(body) || typeof body.message !== 'string') {
    throw new ApiResponseValidationError(
      'The decommission response has an unexpected structure',
      body,
    );
  }

  return body.message;
};

export class DeviceApiClient extends BaseApiClient {
  private readonly trackedDevices = new Map<string, DeviceResource>();
  private readonly createdDeviceIds = new Set<string>();

  public constructor(request: APIRequestContext) {
    super(request);
  }

  public async provisionDevice(input: ProvisionDeviceInput): Promise<DeviceOperationResult> {
    const data: DeviceData = {
      model: input.model,
      sensor_type: input.sensor_type,
      firmware: input.firmware,
      status: 'provisioned',
    };

    const result = await this.post(
      objectsPath,
      {
        name: input.name,
        data,
      },
      [200],
    );

    const device = parseDeviceResource(result.body);

    this.trackedDevices.set(device.id, device);
    this.createdDeviceIds.add(device.id);

    return {
      status: 200,
      device,
    };
  }

  public async retrieveDevice(deviceId: string): Promise<DeviceOperationResult> {
    const result = await this.get(this.getDevicePath(deviceId), [200]);
    const device = parseDeviceResource(result.body);

    this.trackedDevices.set(device.id, device);

    return {
      status: 200,
      device,
    };
  }

  public async lookupDevice(deviceId: string): Promise<DeviceLookupResult> {
    const result = await this.get(this.getDevicePath(deviceId), [200, 404]);

    if (result.status === 404) {
      return {
        status: 404,
        body: result.body,
      };
    }

    const device = parseDeviceResource(result.body);

    this.trackedDevices.set(device.id, device);

    return {
      status: 200,
      device,
    };
  }

  public async updateFirmware(deviceId: string, firmware: string): Promise<DeviceOperationResult> {
    const currentDevice = this.requireTrackedDevice(deviceId, 'active');

    if (currentDevice.data.status !== 'provisioned') {
      throw new DeviceLifecycleError(deviceId, currentDevice.data.status, 'active');
    }

    const updatedData: DeviceData = {
      ...currentDevice.data,
      firmware,
      status: 'active',
    };

    const result = await this.patch(
      this.getDevicePath(deviceId),
      {
        data: updatedData,
      },
      [200],
    );

    const updatedDevice = parseDeviceResource(result.body);

    this.trackedDevices.set(deviceId, updatedDevice);

    return {
      status: 200,
      device: updatedDevice,
    };
  }

  public async decommissionDevice(deviceId: string): Promise<DeviceDecommissionResult> {
    const currentDevice = this.requireTrackedDevice(deviceId, 'decommissioned');

    if (currentDevice.data.status !== 'active') {
      throw new DeviceLifecycleError(deviceId, currentDevice.data.status, 'decommissioned');
    }

    const result = await this.delete(this.getDevicePath(deviceId), [200]);
    const message = parseDeleteMessage(result.body);

    this.trackedDevices.set(deviceId, {
      ...currentDevice,
      data: {
        ...currentDevice.data,
        status: 'decommissioned',
      },
    });
    this.createdDeviceIds.delete(deviceId);

    return {
      status: 200,
      message,
    };
  }

  public async cleanup(): Promise<void> {
    for (const deviceId of this.createdDeviceIds) {
      await this.delete(this.getDevicePath(deviceId), [200, 404]);
    }

    this.createdDeviceIds.clear();
  }

  private requireTrackedDevice(deviceId: string, targetStatus: DeviceStatus): DeviceResource {
    const device = this.trackedDevices.get(deviceId);

    if (device === undefined) {
      throw new DeviceLifecycleError(deviceId, 'unknown', targetStatus);
    }

    return device;
  }

  private getDevicePath(deviceId: string): string {
    return `${objectsPath}/${encodeURIComponent(deviceId)}`;
  }
}
