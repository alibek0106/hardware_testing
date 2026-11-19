export interface SignalAnomaly {
  readonly index: number;
  readonly value: number;
}

/**
 * Returns the given quantile (0..1) of the absolute values of the samples.
 * Used to estimate the nominal envelope of a periodic signal: with rare
 * anomalies (at most one per simulation phase) a high quantile of |value|
 * tracks the normal sine amplitude while staying blind to outliers.
 */
export const absoluteQuantile = (samples: readonly number[], quantile: number): number => {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = samples.map((sample) => Math.abs(sample)).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(quantile * (sorted.length - 1)));

  return sorted[index];
};

/**
 * Estimates the nominal amplitude of a signal from the data itself (the 90th
 * percentile of |value|), so detectors never assume a hard-coded amplitude.
 */
export const estimateNominalAmplitude = (samples: readonly number[]): number =>
  absoluteQuantile(samples, 0.9);

/**
 * Returns the median absolute difference between consecutive samples — the
 * typical step of the undisturbed signal, used to derive deadband sizes from
 * the data instead of assuming them.
 */
export const medianAbsoluteStep = (samples: readonly number[]): number => {
  if (samples.length < 2) {
    return 0;
  }

  const steps = samples
    .slice(1)
    .map((sample, index) => Math.abs(sample - samples[index]))
    .sort((a, b) => a - b);

  return steps[Math.floor((steps.length - 1) / 2)];
};

/**
 * Finds positive spike anomalies: samples rising above `threshold` times the
 * nominal amplitude derived from the data. A flat or empty signal (amplitude
 * 0) yields no anomalies by definition.
 */
export const detectSpikes = (
  samples: readonly number[],
  threshold: number,
): readonly SignalAnomaly[] => {
  const nominalAmplitude = estimateNominalAmplitude(samples);

  if (nominalAmplitude === 0) {
    return [];
  }

  return samples
    .map((value, index) => ({ index, value }))
    .filter((sample) => sample.value > threshold * nominalAmplitude);
};

/**
 * Finds negative dip anomalies: samples falling below `-threshold` times the
 * nominal amplitude derived from the data. A flat or empty signal (amplitude
 * 0) yields no anomalies by definition.
 */
export const detectDips = (
  samples: readonly number[],
  threshold: number,
): readonly SignalAnomaly[] => {
  const nominalAmplitude = estimateNominalAmplitude(samples);

  if (nominalAmplitude === 0) {
    return [];
  }

  return samples
    .map((value, index) => ({ index, value }))
    .filter((sample) => sample.value < -threshold * nominalAmplitude);
};
