import type { TestInfo } from '@playwright/test';
import { tankTestConfig } from '../../src/config/tank-test.config';
import { OpcUaOperationError } from '../../src/errors/OpcUaClientError';
import { expect, test, type TankDeviceRig } from '../fixtures/tank.fixture';

const attachJson = async (testInfo: TestInfo, name: string, body: unknown): Promise<void> => {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(body, null, 2)),
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

const readNumber = async (rig: TankDeviceRig, nodeId: string): Promise<number> =>
  requireNumber((await rig.client.readNode(nodeId)).value, `${nodeId} must read as a number`);

const expectBadStatusRejection = async (
  operation: Promise<unknown>,
  pattern: RegExp,
): Promise<string> => {
  const outcome = await operation.then(
    () => undefined,
    (cause: unknown) => cause,
  );

  expect(outcome).toBeInstanceOf(OpcUaOperationError);

  if (!(outcome instanceof OpcUaOperationError)) {
    throw new Error('The device call did not raise OpcUaOperationError');
  }

  expect(outcome.statusCode).toMatch(pattern);

  return outcome.statusCode;
};

const setTankLevel = async (rig: TankDeviceRig, level: number): Promise<void> => {
  const result = await rig.client.callMethod(
    rig.nodes.simulationObject,
    rig.nodes.methods.setLevel,
    [{ dataType: 'Double', value: level }],
  );

  expect(result.isGood).toBe(true);
};

interface BoundaryWriteOutcome {
  readonly setpointAfter: number;
  readonly statusCode: string;
}

const applyBoundarySetpointWrite = async (
  rig: TankDeviceRig,
  boundaryCase: { readonly value: number; readonly accepted: boolean },
  previousSetpoint: number,
): Promise<BoundaryWriteOutcome> => {
  if (boundaryCase.accepted) {
    const result = await rig.client.writeNode(
      rig.nodes.temperatureSetpoint,
      boundaryCase.value,
      'Double',
    );

    expect(result.isGood).toBe(true);
    expect(await readNumber(rig, rig.nodes.temperatureSetpoint)).toBeCloseTo(boundaryCase.value, 6);

    return { setpointAfter: boundaryCase.value, statusCode: result.statusCode };
  }

  const statusCode = await expectBadStatusRejection(
    rig.client.writeNode(rig.nodes.temperatureSetpoint, boundaryCase.value, 'Double'),
    /^BadOutOfRange/,
  );

  expect(await readNumber(rig, rig.nodes.temperatureSetpoint)).toBeCloseTo(previousSetpoint, 6);

  return { setpointAfter: previousSetpoint, statusCode };
};

test.describe('tank safety limits over OPC UA', () => {
  test('rejects a write to the read-only level and a mistyped setpoint write', async ({
    tankDevice,
  }, testInfo) => {
    const levelStatus = await expectBadStatusRejection(
      tankDevice.client.writeNode(tankDevice.nodes.level, 42, 'Double'),
      /^Bad(NotWritable|UserAccessDenied)/,
    );

    const typeStatus = await expectBadStatusRejection(
      tankDevice.client.writeNode(
        tankDevice.nodes.temperatureSetpoint,
        'not-a-temperature',
        'String',
      ),
      /^BadTypeMismatch/,
    );

    await attachJson(testInfo, 'invalid-write-statuses', { levelStatus, typeStatus });

    expect(await readNumber(tankDevice, tankDevice.nodes.level)).toBeCloseTo(
      tankTestConfig.levelStart,
      6,
    );
    expect(await readNumber(tankDevice, tankDevice.nodes.temperatureSetpoint)).toBeCloseTo(
      tankTestConfig.setpointStart,
      6,
    );
  });

  test('accepts boundary setpoints and rejects out-of-range writes', async ({
    tankDevice,
  }, testInfo) => {
    let currentSetpoint: number = tankTestConfig.setpointStart;
    const outcomes: Record<string, unknown>[] = [];

    for (const boundaryCase of tankTestConfig.boundarySetpointWrites) {
      const outcome = await applyBoundarySetpointWrite(tankDevice, boundaryCase, currentSetpoint);

      currentSetpoint = outcome.setpointAfter;
      outcomes.push({ ...boundaryCase, statusCode: outcome.statusCode });
    }

    await attachJson(testInfo, 'boundary-write-outcomes', outcomes);

    expect(outcomes).toHaveLength(tankTestConfig.boundarySetpointWrites.length);
  });

  test('drives the temperature to a new setpoint and holds it within tolerance', async ({
    tankDevice,
  }, testInfo) => {
    const { client, nodes } = tankDevice;
    const approachSamples: number[] = [];
    let holdChanges: readonly { readonly value: unknown }[] = [];
    let holdRead: number | null = null;

    try {
      const writeResult = await client.writeNode(
        nodes.temperatureSetpoint,
        tankTestConfig.controlSetpoint,
        'Double',
      );

      expect(writeResult.isGood).toBe(true);

      await expect
        .poll(
          async () => {
            const temperature = await readNumber(tankDevice, nodes.temperature);

            approachSamples.push(temperature);

            return Math.abs(temperature - tankTestConfig.controlSetpoint);
          },
          {
            timeout: tankTestConfig.controlResponseTimeoutMs,
            message: `The temperature did not reach ${tankTestConfig.controlSetpoint} ± ${tankTestConfig.temperatureTolerance} °C in time`,
          },
        )
        .toBeLessThanOrEqual(tankTestConfig.temperatureTolerance);

      holdChanges = await client.collectChanges(
        nodes.temperature,
        tankTestConfig.controlHoldWindowMs,
        { samplingIntervalMs: 100, publishingIntervalMs: 200, queueSize: 50 },
      );
      holdRead = await readNumber(tankDevice, nodes.temperature);

      const ceiling = tankTestConfig.controlSetpoint + tankTestConfig.temperatureTolerance;
      const floor = tankTestConfig.controlSetpoint - tankTestConfig.temperatureTolerance;

      for (const sample of approachSamples) {
        expect(
          sample,
          'The temperature must never overshoot the setpoint band',
        ).toBeLessThanOrEqual(ceiling);
      }

      for (const change of holdChanges) {
        const value = requireNumber(change.value, 'Hold-window samples must be numeric');

        expect(value).toBeGreaterThanOrEqual(floor);
        expect(value).toBeLessThanOrEqual(ceiling);
      }

      expect(holdRead).toBeGreaterThanOrEqual(floor);
      expect(holdRead).toBeLessThanOrEqual(ceiling);
    } finally {
      await attachJson(testInfo, 'temperature-approach-samples', approachSamples);
      await attachJson(testInfo, 'temperature-hold-window', { holdChanges, holdRead });
    }
  });

  test('enforces the pump interlock at device level', async ({ tankDevice }, testInfo) => {
    const { client, nodes } = tankDevice;
    const commandLog: Record<string, unknown>[] = [];

    try {
      await setTankLevel(tankDevice, tankTestConfig.lowLevel);

      const refusedStatus = await expectBadStatusRejection(
        client.callMethod(nodes.tankObject, nodes.methods.startPump),
        /^BadInvalidState/,
      );

      commandLog.push({ step: 'StartPump at low level', status: refusedStatus });
      expect((await client.readNode(nodes.pumpRunning)).value).toBe(false);

      await setTankLevel(tankDevice, tankTestConfig.levelStart);

      const startResult = await client.callMethod(nodes.tankObject, nodes.methods.startPump);

      commandLog.push({ step: 'StartPump at normal level', status: startResult.statusCode });
      expect(startResult.isGood).toBe(true);
      expect((await client.readNode(nodes.pumpRunning)).value).toBe(true);

      await setTankLevel(tankDevice, tankTestConfig.lowLevel);
      commandLog.push({ step: 'SetLevel below interlock while running', status: 'Good' });

      await expect
        .poll(async () => (await client.readNode(nodes.pumpRunning)).value, {
          timeout: tankTestConfig.interlockPollTimeoutMs,
          message: 'The interlock did not stop the pump within 500 ms plus the stated margin',
        })
        .toBe(false);

      expect((await client.readNode(nodes.interlockTripped)).value).toBe(true);
    } finally {
      await attachJson(testInfo, 'interlock-command-log', commandLog);
    }
  });
});
