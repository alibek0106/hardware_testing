import type { TestInfo } from '@playwright/test';
import { tankTestConfig } from '../../src/config/tank-test.config';
import { expect, test, type TankDeviceRig } from '../fixtures/tank.fixture';

const attachDeviceState = async (testInfo: TestInfo, rig: TankDeviceRig): Promise<void> => {
  const { client, nodes } = rig;

  await testInfo.attach('device-state-read-back', {
    body: Buffer.from(
      JSON.stringify(
        {
          level: (await client.readDataValue(nodes.level)).value,
          temperature: (await client.readDataValue(nodes.temperature)).value,
          setpoint: (await client.readDataValue(nodes.temperatureSetpoint)).value,
          pumpRunning: (await client.readDataValue(nodes.pumpRunning)).value,
          interlockTripped: (await client.readDataValue(nodes.interlockTripped)).value,
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
};

const requireNumber = (value: unknown, message: string): number => {
  expect(typeof value, message).toBe('number');

  if (typeof value !== 'number') {
    throw new Error(message);
  }

  return value;
};

const setTankLevel = async (rig: TankDeviceRig, level: number): Promise<void> => {
  const result = await rig.client.callMethod(
    rig.nodes.simulationObject,
    rig.nodes.methods.setLevel,
    [{ dataType: 'Double', value: level }],
  );

  expect(result.isGood).toBe(true);
};

const setSensorFault = async (rig: TankDeviceRig, active: boolean): Promise<void> => {
  const result = await rig.client.callMethod(
    rig.nodes.simulationObject,
    rig.nodes.methods.setSensorFault,
    [{ dataType: 'Boolean', value: active }],
  );

  expect(result.isGood).toBe(true);
};

test.describe('operator panel against the live device', () => {
  test('starts and stops the pump from the panel, verified on the device first', async ({
    tankDevice,
    operatorPanel,
  }, testInfo) => {
    const { client, nodes } = tankDevice;

    try {
      await operatorPanel.open();
      await operatorPanel.clickStart();

      // The device is the oracle: the UI state is only checked after OPC UA
      // confirms what actually happened.
      await expect
        .poll(async () => (await client.readNode(nodes.pumpRunning)).value, {
          timeout: tankTestConfig.pumpReadBackTimeoutMs,
          message: 'The device never reported the pump as running after the panel Start click',
        })
        .toBe(true);

      await operatorPanel.expectPumpState('Running');

      await operatorPanel.clickStop();

      await expect
        .poll(async () => (await client.readNode(nodes.pumpRunning)).value, {
          timeout: tankTestConfig.pumpReadBackTimeoutMs,
          message: 'The device never reported the pump as stopped after the panel Stop click',
        })
        .toBe(false);

      await operatorPanel.expectPumpState('Stopped');
    } finally {
      await attachDeviceState(testInfo, tankDevice);
    }
  });

  test('reflects a device-side setpoint change and temperature convergence', async ({
    tankDevice,
    operatorPanel,
  }) => {
    const { client, nodes } = tankDevice;

    await operatorPanel.open();

    const writeResult = await client.writeNode(
      nodes.temperatureSetpoint,
      tankTestConfig.uiSetpoint,
      'Double',
    );

    expect(writeResult.isGood).toBe(true);

    await operatorPanel.expectSetpoint(tankTestConfig.uiSetpoint);
    await operatorPanel.expectTemperatureNear(
      tankTestConfig.uiSetpoint,
      tankTestConfig.temperatureTolerance,
    );
  });

  test('cannot bypass the device from the panel', async ({
    tankDevice,
    operatorPanel,
  }, testInfo) => {
    const { client, nodes } = tankDevice;

    try {
      await setTankLevel(tankDevice, tankTestConfig.lowLevel);
      await operatorPanel.open();

      await operatorPanel.clickStart();
      await operatorPanel.expectRefusalMessage('BadInvalidState');
      expect((await client.readNode(nodes.pumpRunning)).value).toBe(false);

      await operatorPanel.applySetpoint(tankTestConfig.outOfRangeSetpoint);
      await operatorPanel.expectRefusalMessage('BadOutOfRange');

      const setpoint = requireNumber(
        (await client.readNode(nodes.temperatureSetpoint)).value,
        'The setpoint must read as a number',
      );

      expect(setpoint).toBeCloseTo(tankTestConfig.setpointStart, 6);
    } finally {
      await attachDeviceState(testInfo, tankDevice);
    }
  });

  test('shows a fault marker while the level sensor is failed and recovers', async ({
    tankDevice,
    operatorPanel,
  }) => {
    await operatorPanel.open();
    await operatorPanel.expectOperationalTelemetry();

    await setSensorFault(tankDevice, true);
    await operatorPanel.expectSensorFaultState();

    await setSensorFault(tankDevice, false);
    await operatorPanel.expectOperationalTelemetry();
  });

  test('shows a connection-lost banner while gateway telemetry fails and recovers', async ({
    tankDevice,
    operatorPanel,
  }, testInfo) => {
    try {
      await operatorPanel.open();
      await operatorPanel.expectOperationalTelemetry();

      await operatorPanel.mockTankTelemetryFailure(503);
      await operatorPanel.expectConnectionLostState();

      await operatorPanel.clearTankTelemetryMock();
      await operatorPanel.expectOperationalTelemetry();

      await operatorPanel.mockTankTelemetryAborted();
      await operatorPanel.expectConnectionLostState();

      await operatorPanel.clearTankTelemetryMock();
      await operatorPanel.expectOperationalTelemetry();
    } finally {
      await attachDeviceState(testInfo, tankDevice);
    }
  });
});
