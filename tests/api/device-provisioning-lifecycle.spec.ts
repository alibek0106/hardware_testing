import { randomUUID } from 'node:crypto';
import { DeviceLifecycleError } from '../../src/errors/DeviceLifecycleError';
import { expect, test } from '../fixtures/api.fixture';

test.describe('Device provisioning lifecycle', () => {
  test('provisions, activates, updates, and decommissions a device', async ({
    deviceApiClient,
  }) => {
    const provisionInput = {
      name: `TX-100-${randomUUID()}`,
      model: 'TX-100',
      sensor_type: 'temperature',
      firmware: 'v1.2.0',
    };

    const provisioned = await deviceApiClient.provisionDevice(provisionInput);

    expect(provisioned.status).toBe(200);
    expect(provisioned.device.id).not.toHaveLength(0);
    expect(provisioned.device).toMatchObject({
      name: provisionInput.name,
      data: {
        model: provisionInput.model,
        sensor_type: provisionInput.sensor_type,
        firmware: provisionInput.firmware,
        status: 'provisioned',
      },
    });

    const retrieved = await deviceApiClient.retrieveDevice(provisioned.device.id);

    expect(retrieved.status).toBe(200);
    expect(retrieved.device).toMatchObject({
      id: provisioned.device.id,
      name: provisionInput.name,
      data: {
        model: provisionInput.model,
        sensor_type: provisionInput.sensor_type,
        firmware: provisionInput.firmware,
        status: 'provisioned',
      },
    });

    await expect(deviceApiClient.decommissionDevice(provisioned.device.id)).rejects.toBeInstanceOf(
      DeviceLifecycleError,
    );

    const unchangedDevice = await deviceApiClient.retrieveDevice(provisioned.device.id);

    expect(unchangedDevice.status).toBe(200);
    expect(unchangedDevice.device.data.status).toBe('provisioned');
    expect(unchangedDevice.device.data.firmware).toBe('v1.2.0');

    const updated = await deviceApiClient.updateFirmware(provisioned.device.id, 'v1.3.1');

    expect(updated.status).toBe(200);
    expect(updated.device).toMatchObject({
      id: provisioned.device.id,
      name: provisionInput.name,
      data: {
        model: provisionInput.model,
        sensor_type: provisionInput.sensor_type,
        firmware: 'v1.3.1',
        status: 'active',
      },
    });

    const verifiedUpdate = await deviceApiClient.retrieveDevice(provisioned.device.id);

    expect(verifiedUpdate.status).toBe(200);
    expect(verifiedUpdate.device.data).toEqual({
      model: provisionInput.model,
      sensor_type: provisionInput.sensor_type,
      firmware: 'v1.3.1',
      status: 'active',
    });

    const decommissioned = await deviceApiClient.decommissionDevice(provisioned.device.id);

    expect(decommissioned.status).toBe(200);
    expect(decommissioned.message).toContain(provisioned.device.id);

    const deletedDevice = await deviceApiClient.lookupDevice(provisioned.device.id);

    expect(deletedDevice.status).toBe(404);
  });
});
