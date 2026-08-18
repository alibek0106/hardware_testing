import { weatherTestConfig } from '../../src/config/weather-test.config';
import { test } from '../fixtures/weather.fixture';

test.describe('Current weather hardware telemetry', () => {
  test('renders the real baseline temperature', async ({ weatherPage }) => {
    await weatherPage.captureBaselineTelemetry();
    await weatherPage.openHomePage();
    await weatherPage.searchForLondon();
    await weatherPage.waitForTelemetryInterception();

    const baselineTemperature = await weatherPage.getCapturedBaselineTemperature();

    await weatherPage.expectWeatherPageOperational();
    await weatherPage.expectTemperature(baselineTemperature);
  });

  test('renders an out-of-range temperature without dropping it', async ({ weatherPage }) => {
    await weatherPage.mockOutOfRangeTemperature(weatherTestConfig.outOfRangeTemperature);
    await weatherPage.openHomePage();
    await weatherPage.searchForLondon();
    await weatherPage.waitForTelemetryInterception();

    await weatherPage.expectWeatherPageOperational();
    await weatherPage.expectTemperature(weatherTestConfig.outOfRangeTemperature);
  });

  test('does not display stale telemetry after the current-weather request fails', async ({
    weatherPage,
  }) => {
    await weatherPage.mockFailedTelemetry(
      weatherTestConfig.failedTelemetryStatus,
      weatherTestConfig.failedTelemetryResponse,
    );
    await weatherPage.openHomePage();
    await weatherPage.searchForLondon();
    await weatherPage.waitForTelemetryInterception();

    await weatherPage.expectTelemetryErrorState();
  });
});
