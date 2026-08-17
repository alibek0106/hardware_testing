import { airQualityTestConfig } from '../../src/config/air-quality-test.config';
import { test } from '../fixtures/air-quality.fixture';

test.describe('Air quality hardware telemetry', () => {
  test('renders the baseline AQI from the real telemetry response', async ({ airQualityPage }) => {
    await airQualityPage.captureBaselineAqi();

    await airQualityPage.openInitialCityPage();
    await airQualityPage.searchForLondon();

    const baselineAqi = await airQualityPage.getCapturedBaselineAqi();

    await airQualityPage.expectAqi(baselineAqi);
    await airQualityPage.expectAirQualityPageOperational();
  });

  test('renders an out-of-range AQI without clamping or dropping it', async ({
    airQualityPage,
  }) => {
    await airQualityPage.mockOutOfRangeAqi(airQualityTestConfig.outOfRangeAqi);

    await airQualityPage.openInitialCityPage();
    await airQualityPage.searchForLondon();

    await airQualityPage.expectAqi(airQualityTestConfig.outOfRangeAqi);
    await airQualityPage.expectAirQualityPageOperational();
  });

  test('preserves an explicitly timestamped last-known reading when live telemetry fails', async ({
    airQualityPage,
  }) => {
    await airQualityPage.mockFailedTelemetry(airQualityTestConfig.telemetryFailureStatus);

    await airQualityPage.openInitialCityPage();
    await airQualityPage.searchForLondon();

    await airQualityPage.expectLastKnownTelemetryState();
  });
});
