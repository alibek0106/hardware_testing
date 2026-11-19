import { expect, test } from '@playwright/test';
import {
  detectDips,
  detectSpikes,
  estimateNominalAmplitude,
  medianAbsoluteStep,
} from '../../src/opcua/SignalAnalysis';

const SINE_CYCLE_COUNT = 200;
const SINE_AMPLITUDE = 100;
const ANOMALY_VALUE = 1_000;
const DETECTION_THRESHOLD = 1.5;

const sineWave = (): number[] =>
  Array.from(
    { length: SINE_CYCLE_COUNT },
    (_, index) => SINE_AMPLITUDE * Math.sin((2 * Math.PI * index) / 50),
  );

const withValueAt = (samples: readonly number[], index: number, value: number): number[] => {
  const copy = [...samples];

  copy[index] = value;

  return copy;
};

test.describe('signal analysis unit tests (no device connected)', () => {
  test('detects a synthetic spike and no dip in a spiked sine wave', () => {
    const spiked = withValueAt(sineWave(), 73, ANOMALY_VALUE);

    const spikes = detectSpikes(spiked, DETECTION_THRESHOLD);
    const dips = detectDips(spiked, DETECTION_THRESHOLD);

    expect(spikes).toHaveLength(1);
    expect(spikes[0]).toStrictEqual({ index: 73, value: ANOMALY_VALUE });
    expect(dips).toHaveLength(0);
  });

  test('detects a synthetic dip and no spike in a dipped sine wave', () => {
    const dipped = withValueAt(sineWave(), 137, -ANOMALY_VALUE);

    const dips = detectDips(dipped, DETECTION_THRESHOLD);
    const spikes = detectSpikes(dipped, DETECTION_THRESHOLD);

    expect(dips).toHaveLength(1);
    expect(dips[0]).toStrictEqual({ index: 137, value: -ANOMALY_VALUE });
    expect(spikes).toHaveLength(0);
  });

  test('reports no anomalies in a clean sine wave', () => {
    const clean = sineWave();

    expect(detectSpikes(clean, DETECTION_THRESHOLD)).toHaveLength(0);
    expect(detectDips(clean, DETECTION_THRESHOLD)).toHaveLength(0);
  });

  test('reports no anomalies for flat and empty signals', () => {
    const flat = Array.from({ length: 50 }, () => 0);

    expect(detectSpikes(flat, DETECTION_THRESHOLD)).toHaveLength(0);
    expect(detectDips(flat, DETECTION_THRESHOLD)).toHaveLength(0);
    expect(detectSpikes([], DETECTION_THRESHOLD)).toHaveLength(0);
    expect(detectDips([], DETECTION_THRESHOLD)).toHaveLength(0);
  });

  test('derives the nominal amplitude from the data instead of assuming it', () => {
    const spiked = withValueAt(sineWave(), 11, ANOMALY_VALUE);
    const amplitude = estimateNominalAmplitude(spiked);

    expect(amplitude).toBeGreaterThan(0.7 * SINE_AMPLITUDE);
    expect(amplitude).toBeLessThanOrEqual(SINE_AMPLITUDE);
  });

  test('measures the typical step between consecutive samples', () => {
    const clean = sineWave();
    const typicalStep = medianAbsoluteStep(clean);

    expect(typicalStep).toBeGreaterThan(0);
    expect(typicalStep).toBeLessThan(SINE_AMPLITUDE);
    expect(medianAbsoluteStep([])).toBe(0);
    expect(medianAbsoluteStep([42])).toBe(0);
  });
});
