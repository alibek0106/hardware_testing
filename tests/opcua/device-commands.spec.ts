import type { TestInfo } from '@playwright/test';
import { opcUaTestConfig } from '../../src/config/opcua-test.config';
import { OpcUaOperationError } from '../../src/errors/OpcUaClientError';
import type { OpcUaClient } from '../../src/opcua/OpcUaClient';
import type { OpcUaDataChange, OpcUaMethodCallResult } from '../../src/types/opcua.types';
import { expect, test, type DeviceCommandRig } from '../fixtures/device-commands.fixture';

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

const numericValues = (samples: readonly OpcUaDataChange[]): number[] =>
  samples.map((sample) =>
    requireNumber(sample.value, `Notification for ${sample.nodeId} must carry a numeric value`),
  );

const expectStrictlyIncreasing = (values: readonly number[]): void => {
  for (const [index, value] of values.slice(1).entries()) {
    expect(value, `Sample ${index + 1} must be greater than its predecessor`).toBeGreaterThan(
      values[index],
    );
  }
};

const measureUpdateIntervalMs = (samples: readonly OpcUaDataChange[]): number => {
  const timestamps = samples.map((sample) =>
    (sample.sourceTimestamp ?? sample.receivedAt).getTime(),
  );
  const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
  const total = intervals.reduce((sum, interval) => sum + interval, 0);

  return total / intervals.length;
};

const deriveObservationWindowMs = (updateIntervalMs: number): number =>
  Math.max(
    opcUaTestConfig.minObservationWindowMs,
    Math.round(opcUaTestConfig.observationWindowIntervals * updateIntervalMs),
  );

const waitForSettledValue = async (client: OpcUaClient, nodeId: string): Promise<number> => {
  let previous = await client.readNode(nodeId);

  await expect
    .poll(
      async () => {
        const next = await client.readNode(nodeId);
        const settled = next.value === previous.value;

        previous = next;

        return settled;
      },
      {
        timeout: opcUaTestConfig.commandSettleTimeoutMs,
        message: `The value of ${nodeId} did not settle after the stop command`,
      },
    )
    .toBe(true);

  return requireNumber(previous.value, `The settled value of ${nodeId} must be numeric`);
};

const describeCallOutcome = async (call: () => Promise<OpcUaMethodCallResult>): Promise<string> => {
  try {
    const result = await call();

    return result.statusCode;
  } catch (error) {
    if (error instanceof OpcUaOperationError) {
      return error.statusCode;
    }

    throw error;
  }
};

const captureBadStatusRejection = async (operation: Promise<unknown>): Promise<string> => {
  const outcome = await operation.then(
    () => undefined,
    (cause: unknown) => cause,
  );

  expect(outcome).toBeInstanceOf(OpcUaOperationError);

  if (!(outcome instanceof OpcUaOperationError)) {
    throw new Error('The invalid method call did not raise OpcUaOperationError');
  }

  expect(outcome.statusCode).toMatch(/^Bad/);

  return outcome.statusCode;
};

interface ActuatorCase {
  readonly title: string;
  readonly targetKey: 'stepUpNode' | 'fastNode';
  readonly stopKey: 'stopStepUp' | 'stopUpdateFastNodes';
  readonly startKey: 'startStepUp' | 'startUpdateFastNodes';
}

const actuatorCases: readonly ActuatorCase[] = [
  {
    title: 'StepUp counter',
    targetKey: 'stepUpNode',
    stopKey: 'stopStepUp',
    startKey: 'startStepUp',
  },
  {
    title: 'fast telemetry node',
    targetKey: 'fastNode',
    stopKey: 'stopUpdateFastNodes',
    startKey: 'startUpdateFastNodes',
  },
];

const collectBaseline = async (
  rig: DeviceCommandRig,
  nodeId: string,
): Promise<readonly OpcUaDataChange[]> =>
  rig.client.collectNotifications(
    nodeId,
    opcUaTestConfig.baselineNotificationCount,
    opcUaTestConfig.baselineCollectTimeoutMs,
    opcUaTestConfig.monitorOptions,
  );

test.describe('OPC UA device commands', () => {
  test('discovers the command surface by browsing and cross-checks the publisher configuration', async ({
    deviceRig,
    request,
  }, testInfo) => {
    const { nodes } = deviceRig;

    await attachJson(testInfo, 'discovered-command-nodes', nodes.relevantNodes);

    expect(nodes.stepUpNode.browseName).toBe(opcUaTestConfig.stepUpBrowseName);
    expect(nodes.fastNode.browseName).toMatch(opcUaTestConfig.fastNodeNamePattern);

    for (const methodNode of Object.values(nodes.methods)) {
      expect(methodNode.nodeClass).toBe('Method');
      expect(methodNode.parentNodeId).toBe(nodes.methodsNode.nodeId);
      expect(methodNode.nodeId).not.toHaveLength(0);
    }

    const response = await request.get(opcUaTestConfig.publisherConfigUrl);

    expect(response.ok()).toBeTruthy();

    const publisherConfigText = await response.text();

    expect(publisherConfigText).toContain(`;s=${nodes.stepUpNode.browseName}`);
    expect(publisherConfigText).toContain(`;s=${nodes.fastNode.browseName}`);
  });

  for (const actuator of actuatorCases) {
    test(`observes, stops and restarts the ${actuator.title} with verified read-backs`, async ({
      deviceRig,
    }, testInfo) => {
      const { client, nodes } = deviceRig;
      const target = nodes[actuator.targetKey];
      const commandLog: OpcUaMethodCallResult[] = [];

      const baseline = await collectBaseline(deviceRig, target.nodeId);

      await attachJson(testInfo, 'baseline-samples', baseline);

      for (const sample of baseline) {
        expect(sample.isGood).toBe(true);
      }

      expectStrictlyIncreasing(numericValues(baseline));

      const updateIntervalMs = measureUpdateIntervalMs(baseline);
      const observationWindowMs = deriveObservationWindowMs(updateIntervalMs);

      await attachJson(testInfo, 'measured-update-interval', {
        updateIntervalMs,
        observationWindowMs,
        derivation: `max(${opcUaTestConfig.minObservationWindowMs}, ${opcUaTestConfig.observationWindowIntervals} x measured interval)`,
      });

      const stopResult = await client.callMethod(
        nodes.methodsNode.nodeId,
        nodes.methods[actuator.stopKey].nodeId,
      );

      commandLog.push(stopResult);
      expect(stopResult.isGood).toBe(true);

      const settledValue = await waitForSettledValue(client, target.nodeId);
      const stoppedWindowChanges = await client.collectChanges(
        target.nodeId,
        observationWindowMs,
        opcUaTestConfig.monitorOptions,
      );

      await attachJson(testInfo, 'stopped-window-changes', stoppedWindowChanges);

      expect(stoppedWindowChanges).toHaveLength(0);

      const firstRead = await client.readNode(target.nodeId);
      const secondRead = await client.readNode(target.nodeId);

      expect(firstRead.value).toStrictEqual(secondRead.value);
      expect(requireNumber(firstRead.value, 'The stopped value must be numeric')).toBe(
        settledValue,
      );

      const startResult = await client.callMethod(
        nodes.methodsNode.nodeId,
        nodes.methods[actuator.startKey].nodeId,
      );

      commandLog.push(startResult);
      expect(startResult.isGood).toBe(true);

      await expect
        .poll(
          async () =>
            requireNumber(
              (await client.readNode(target.nodeId)).value,
              'The restarted value must be numeric',
            ),
          {
            timeout: opcUaTestConfig.restartPollTimeoutMs,
            message: `The value of ${target.nodeId} did not rise after the start command`,
          },
        )
        .toBeGreaterThan(settledValue);

      const resumedSamples = await client.collectNotifications(
        target.nodeId,
        3,
        opcUaTestConfig.baselineCollectTimeoutMs,
        opcUaTestConfig.monitorOptions,
      );

      await attachJson(testInfo, 'resumed-samples', resumedSamples);
      await attachJson(testInfo, 'command-log', commandLog);

      expectStrictlyIncreasing(numericValues(resumedSamples));
    });
  }

  test('resets the stopped StepUp counter to zero and restarts it from zero', async ({
    deviceRig,
  }, testInfo) => {
    const { client, nodes } = deviceRig;
    const commandLog: OpcUaMethodCallResult[] = [];

    const stopResult = await client.callMethod(
      nodes.methodsNode.nodeId,
      nodes.methods.stopStepUp.nodeId,
    );

    commandLog.push(stopResult);
    expect(stopResult.isGood).toBe(true);

    await waitForSettledValue(client, nodes.stepUpNode.nodeId);

    const resetResult = await client.callMethod(
      nodes.methodsNode.nodeId,
      nodes.methods.resetStepUp.nodeId,
    );

    commandLog.push(resetResult);
    expect(resetResult.isGood).toBe(true);

    await expect
      .poll(
        async () =>
          requireNumber(
            (await client.readNode(nodes.stepUpNode.nodeId)).value,
            'The reset value must be numeric',
          ),
        {
          timeout: opcUaTestConfig.commandSettleTimeoutMs,
          message: 'The StepUp counter did not read back 0 after ResetStepUp',
        },
      )
      .toBe(0);

    const startResult = await client.callMethod(
      nodes.methodsNode.nodeId,
      nodes.methods.startStepUp.nodeId,
    );

    commandLog.push(startResult);
    expect(startResult.isGood).toBe(true);

    await expect
      .poll(
        async () =>
          requireNumber(
            (await client.readNode(nodes.stepUpNode.nodeId)).value,
            'The restarted value must be numeric',
          ),
        {
          timeout: opcUaTestConfig.restartPollTimeoutMs,
          message: 'The StepUp counter did not rise above 0 after StartStepUp',
        },
      )
      .toBeGreaterThan(0);

    await attachJson(testInfo, 'command-log', commandLog);
  });

  test('keeps the StepUp counter stopped after a repeated stop command', async ({
    deviceRig,
  }, testInfo) => {
    const { client, nodes } = deviceRig;

    const baseline = await collectBaseline(deviceRig, nodes.stepUpNode.nodeId);
    const observationWindowMs = deriveObservationWindowMs(measureUpdateIntervalMs(baseline));

    const firstStopResult = await client.callMethod(
      nodes.methodsNode.nodeId,
      nodes.methods.stopStepUp.nodeId,
    );

    expect(firstStopResult.isGood).toBe(true);

    const settledValue = await waitForSettledValue(client, nodes.stepUpNode.nodeId);

    const repeatedStopStatus = await describeCallOutcome(() =>
      client.callMethod(nodes.methodsNode.nodeId, nodes.methods.stopStepUp.nodeId),
    );

    await attachJson(testInfo, 'command-log', {
      firstStop: firstStopResult.statusCode,
      repeatedStop: repeatedStopStatus,
    });

    expect(repeatedStopStatus).toMatch(/^(Good|Uncertain|Bad)/);

    const stoppedWindowChanges = await client.collectChanges(
      nodes.stepUpNode.nodeId,
      observationWindowMs,
      opcUaTestConfig.monitorOptions,
    );

    await attachJson(testInfo, 'stopped-window-changes', stoppedWindowChanges);

    expect(stoppedWindowChanges).toHaveLength(0);
    expect(
      requireNumber(
        (await client.readNode(nodes.stepUpNode.nodeId)).value,
        'The stopped value must be numeric',
      ),
    ).toBe(settledValue);
  });

  test('surfaces Bad status codes for invalid method calls and leaves the device running', async ({
    deviceRig,
  }, testInfo) => {
    const { client, nodes } = deviceRig;

    const missingMethodNodeId = `${nodes.methods.stopStepUp.nodeId}DoesNotExist`;
    const missingMethodStatus = await captureBadStatusRejection(
      client.callMethod(nodes.methodsNode.nodeId, missingMethodNodeId),
    );

    const wrongParentStatus = await captureBadStatusRejection(
      client.callMethod(nodes.opcPlcNode.nodeId, nodes.methods.stopStepUp.nodeId),
    );

    await attachJson(testInfo, 'invalid-command-log', {
      missingMethodNodeId,
      missingMethodStatus,
      wrongParentObjectNodeId: nodes.opcPlcNode.nodeId,
      wrongParentStatus,
    });

    const valueBefore = requireNumber(
      (await client.readNode(nodes.stepUpNode.nodeId)).value,
      'The running value must be numeric',
    );

    await expect
      .poll(
        async () =>
          requireNumber(
            (await client.readNode(nodes.stepUpNode.nodeId)).value,
            'The running value must be numeric',
          ),
        {
          timeout: opcUaTestConfig.restartPollTimeoutMs,
          message: 'The StepUp counter stopped although only invalid commands were issued',
        },
      )
      .toBeGreaterThan(valueBefore);
  });
});
