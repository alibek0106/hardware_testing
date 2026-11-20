import type { TestInfo } from '@playwright/test';
import { opcUaTestConfig } from '../../src/config/opcua-test.config';
import { OpcUaOperationError } from '../../src/errors/OpcUaClientError';
import {
  detectDips,
  detectSpikes,
  estimateNominalAmplitude,
  medianAbsoluteStep,
  type SignalAnomaly,
} from '../../src/opcua/SignalAnalysis';
import type {
  OpcUaDataChange,
  OpcUaMonitorCollector,
  OpcUaReadResult,
} from '../../src/types/opcua.types';
import { expect, test, type SignalQualityRig } from '../fixtures/signal-quality.fixture';

type StatusClass = 'Good' | 'Uncertain' | 'Bad';

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

const sourceTimestampsMs = (samples: readonly OpcUaDataChange[]): number[] =>
  samples.map((sample, index) => {
    expect(
      sample.sourceTimestamp,
      `Notification ${index} for ${sample.nodeId} must carry a source timestamp`,
    ).not.toBeNull();

    return (sample.sourceTimestamp ?? sample.receivedAt).getTime();
  });

const statusClassOf = (statusCode: string): StatusClass => {
  if (statusCode.startsWith('Uncertain')) {
    return 'Uncertain';
  }

  if (statusCode.startsWith('Bad')) {
    return 'Bad';
  }

  return 'Good';
};

const collectAllStatusClasses = async (
  collector: OpcUaMonitorCollector,
  timeoutMs: number,
): Promise<OpcUaDataChange[]> => {
  const collected: OpcUaDataChange[] = [];
  const seenClasses = new Set<StatusClass>();
  const deadline = Date.now() + timeoutMs;

  while (seenClasses.size < 3) {
    const remainingMs = deadline - Date.now();

    expect(
      remainingMs,
      `Good, Uncertain and Bad notifications must all arrive within ${timeoutMs} ms; seen so far: ${[...seenClasses].join(', ')}`,
    ).toBeGreaterThan(0);

    const [notification] = await collector.take(1, remainingMs);

    collected.push(notification);
    seenClasses.add(statusClassOf(notification.statusCode));
  }

  return collected;
};

const expectRequireGoodContract = (
  rig: SignalQualityRig,
  notifications: readonly OpcUaDataChange[],
): void => {
  for (const notification of notifications) {
    if (statusClassOf(notification.statusCode) === 'Good') {
      expect(rig.client.requireGood(notification)).toStrictEqual(notification.value);
    } else {
      expect(() => rig.client.requireGood(notification)).toThrow(OpcUaOperationError);
    }
  }
};

const timestampSummary = (read: OpcUaReadResult): Record<string, unknown> => ({
  value: read.value,
  statusCode: read.statusCode,
  sourceTimestamp: read.sourceTimestamp?.toISOString() ?? null,
  serverTimestamp: read.serverTimestamp?.toISOString() ?? null,
});

interface AnomalyCase {
  readonly title: string;
  readonly signalKey: 'spikeNode' | 'dipNode';
  readonly expectedDetector: (
    samples: readonly number[],
    threshold: number,
  ) => readonly SignalAnomaly[];
  readonly oppositeDetector: (
    samples: readonly number[],
    threshold: number,
  ) => readonly SignalAnomaly[];
}

const anomalyCases: readonly AnomalyCase[] = [
  {
    title: 'spike anomalies in the spike signal and none in reverse',
    signalKey: 'spikeNode',
    expectedDetector: detectSpikes,
    oppositeDetector: detectDips,
  },
  {
    title: 'dip anomalies in the dip signal and none in reverse',
    signalKey: 'dipNode',
    expectedDetector: detectDips,
    oppositeDetector: detectSpikes,
  },
];

test.describe('OPC UA signal quality', () => {
  test('verifies the sampling rate of a fast node from source timestamps', async ({
    signalRig,
  }, testInfo) => {
    const { client, signals } = signalRig;
    const collector = await client.monitor(signals.fastNode.nodeId, opcUaTestConfig.monitorOptions);

    const samples = await collector.take(
      opcUaTestConfig.samplingRateSampleCount,
      opcUaTestConfig.samplingTakeTimeoutMs,
    );

    await collector.stop();
    await attachJson(testInfo, 'sampling-rate-samples', samples);

    expectStrictlyIncreasing(numericValues(samples));

    const timestamps = sourceTimestampsMs(samples);
    const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
    const lowerBoundMs =
      opcUaTestConfig.fastNodeNominalPeriodMs * (1 - opcUaTestConfig.samplingToleranceRatio);
    const upperBoundMs =
      opcUaTestConfig.fastNodeNominalPeriodMs * (1 + opcUaTestConfig.samplingToleranceRatio);
    const lostSampleBoundMs =
      opcUaTestConfig.fastNodeNominalPeriodMs * opcUaTestConfig.lostSampleFactor;

    await attachJson(testInfo, 'sampling-rate-intervals', {
      intervals,
      lowerBoundMs,
      upperBoundMs,
      lostSampleBoundMs,
    });

    for (const [index, interval] of intervals.entries()) {
      expect(
        interval,
        `Source timestamps must never go backwards (interval ${index})`,
      ).toBeGreaterThan(0);
      expect(
        interval,
        `Interval ${index} must be within ±${opcUaTestConfig.samplingToleranceRatio * 100}% of the nominal period`,
      ).toBeGreaterThanOrEqual(lowerBoundMs);
      expect(
        interval,
        `Interval ${index} must stay within the stated tolerance`,
      ).toBeLessThanOrEqual(upperBoundMs);
      expect(
        interval,
        `Interval ${index} must not exceed two periods — that would mean a lost sample`,
      ).toBeLessThan(lostSampleBoundMs);
    }
  });

  test('classifies Good, Uncertain and Bad notifications with requireGood', async ({
    signalRig,
  }, testInfo) => {
    const { client, signals } = signalRig;
    const collector = await client.monitor(
      signals.statusCycleNode.nodeId,
      opcUaTestConfig.monitorOptions,
    );

    const notifications = await collectAllStatusClasses(
      collector,
      opcUaTestConfig.qualityClassTimeoutMs,
    );

    await collector.stop();
    await attachJson(testInfo, 'status-class-notifications', notifications);

    const seenClasses = new Set(
      notifications.map((notification) => statusClassOf(notification.statusCode)),
    );

    expect([...seenClasses].sort()).toStrictEqual(['Bad', 'Good', 'Uncertain']);

    expectRequireGoodContract(signalRig, notifications);
  });

  test('detects a frozen fast signal through stale timestamps', async ({ signalRig }, testInfo) => {
    const { client, commands, signals } = signalRig;
    const evidence: Record<string, unknown> = {
      staleMaxAgeMs: opcUaTestConfig.staleMaxAgeMs,
    };

    try {
      let runningRead = await client.readDataValue(signals.fastNode.nodeId);

      await expect
        .poll(
          async () => {
            runningRead = await client.readDataValue(signals.fastNode.nodeId);
            evidence.runningRead = timestampSummary(runningRead);

            return client.isStale(runningRead, opcUaTestConfig.staleMaxAgeMs);
          },
          {
            timeout: opcUaTestConfig.restartPollTimeoutMs,
            message:
              'The fast node never delivered a fresh (non-stale) value while updates were running',
          },
        )
        .toBe(false);

      const stopResult = await client.callMethod(
        commands.methodsNode.nodeId,
        commands.methods.stopUpdateFastNodes.nodeId,
      );

      evidence.stopStatusCode = stopResult.statusCode;
      expect(stopResult.isGood).toBe(true);

      let latestRead = runningRead;

      await expect
        .poll(
          async () => {
            latestRead = await client.readDataValue(signals.fastNode.nodeId);
            evidence.staleRead = timestampSummary(latestRead);

            return client.isStale(latestRead, opcUaTestConfig.staleMaxAgeMs);
          },
          {
            timeout: opcUaTestConfig.stalePollTimeoutMs,
            message: `isStale() never became true after StopUpdateFastNodes although the stall exceeded ${opcUaTestConfig.staleMaxAgeMs} ms`,
          },
        )
        .toBe(true);

      const frozenReadA = await client.readDataValue(signals.fastNode.nodeId);
      const frozenReadB = await client.readDataValue(signals.fastNode.nodeId);
      const sourceTimestampFrozen =
        frozenReadA.sourceTimestamp?.getTime() === frozenReadB.sourceTimestamp?.getTime();
      const serverTimestampFrozen =
        frozenReadA.serverTimestamp?.getTime() === frozenReadB.serverTimestamp?.getTime();

      evidence.frozenReadA = timestampSummary(frozenReadA);
      evidence.frozenReadB = timestampSummary(frozenReadB);
      evidence.frozenStatusCode = frozenReadA.statusCode;
      evidence.sourceTimestampFrozen = sourceTimestampFrozen;
      evidence.serverTimestampFrozen = serverTimestampFrozen;

      expect(frozenReadA.value).toStrictEqual(frozenReadB.value);
      expect(sourceTimestampFrozen).toBe(true);
    } finally {
      await attachJson(testInfo, 'frozen-signal-evidence', evidence);
    }
  });

  for (const anomaly of anomalyCases) {
    test(`finds ${anomaly.title}`, async ({ signalRig }, testInfo) => {
      const { client, signals } = signalRig;
      const signalNode = signals[anomaly.signalKey];

      const samples = await client.collectChanges(
        signalNode.nodeId,
        opcUaTestConfig.anomalyCollectionWindowMs,
        opcUaTestConfig.monitorOptions,
      );

      const values = numericValues(samples);
      const expectedAnomalies = anomaly.expectedDetector(
        values,
        opcUaTestConfig.anomalyThresholdRatio,
      );
      const oppositeAnomalies = anomaly.oppositeDetector(
        values,
        opcUaTestConfig.anomalyThresholdRatio,
      );

      await attachJson(testInfo, 'anomaly-samples', samples);
      await attachJson(testInfo, 'anomaly-detections', {
        nominalAmplitude: estimateNominalAmplitude(values),
        thresholdRatio: opcUaTestConfig.anomalyThresholdRatio,
        expectedAnomalies,
        oppositeAnomalies,
      });

      expect(
        samples.length,
        'The collection window must span multiple simulation phases of samples',
      ).toBeGreaterThanOrEqual(50);
      expect(expectedAnomalies.length).toBeGreaterThanOrEqual(1);
      expect(oppositeAnomalies).toHaveLength(0);
    });
  }

  test('reduces notifications with an absolute deadband while anomalies still pass', async ({
    signalRig,
  }, testInfo) => {
    const { client, signals } = signalRig;

    const calibrationSamples = await client.collectChanges(
      signals.spikeNode.nodeId,
      opcUaTestConfig.simulationPhaseMs,
      opcUaTestConfig.monitorOptions,
    );

    const calibrationValues = numericValues(calibrationSamples);
    const typicalStep = medianAbsoluteStep(calibrationValues);
    const nominalAmplitude = estimateNominalAmplitude(calibrationValues);
    const deadbandValue = opcUaTestConfig.deadbandStepFactor * typicalStep;
    const anomalyFloor = opcUaTestConfig.anomalyThresholdRatio * nominalAmplitude;

    await attachJson(testInfo, 'deadband-calibration', {
      typicalStep,
      nominalAmplitude,
      deadbandValue,
      anomalyFloor,
    });

    expect(
      deadbandValue,
      'The deadband must exceed the typical step between samples',
    ).toBeGreaterThan(typicalStep);
    expect(deadbandValue, 'The deadband must stay below the anomaly magnitude').toBeLessThan(
      anomalyFloor,
    );

    const unfilteredCollector = await client.monitor(
      signals.spikeNode.nodeId,
      opcUaTestConfig.monitorOptions,
    );
    const filteredCollector = await client.monitor(signals.spikeNode.nodeId, {
      ...opcUaTestConfig.monitorOptions,
      deadbandAbsolute: deadbandValue,
    });

    expect(filteredCollector.creationStatusCode).toContain('Good');

    const [unfilteredSamples, filteredSamples] = await Promise.all([
      unfilteredCollector.collectDuring(opcUaTestConfig.deadbandWindowMs),
      filteredCollector.collectDuring(opcUaTestConfig.deadbandWindowMs),
    ]);

    await unfilteredCollector.stop();
    await filteredCollector.stop();

    await attachJson(testInfo, 'deadband-window', {
      deadbandValue,
      unfilteredCount: unfilteredSamples.length,
      filteredCount: filteredSamples.length,
      filteredValues: numericValues(filteredSamples),
    });

    expect(filteredSamples.length).toBeGreaterThan(0);
    expect(unfilteredSamples.length).toBeGreaterThan(filteredSamples.length);

    const filteredValues = numericValues(filteredSamples);

    for (const [index, value] of filteredValues.slice(1).entries()) {
      expect(
        Math.abs(value - filteredValues[index]),
        `Consecutive filtered values ${index} and ${index + 1} must differ by more than the deadband`,
      ).toBeGreaterThan(deadbandValue);
    }

    const largestMagnitude = Math.max(...filteredValues.map((value) => Math.abs(value)));

    expect(largestMagnitude, 'The anomaly must still get through the deadband').toBeGreaterThan(
      anomalyFloor,
    );
  });
});
