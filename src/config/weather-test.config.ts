export const weatherTestConfig = {
  startPath: '/',
  cityQuery: 'London',
  expectedCityName: 'London, GB',
  expectedCityPath: '/city/2643743',
  currentWeatherRoute: /\/api\/widget\/onecall(?:\?|$)/,
  outOfRangeTemperature: 999,
  failedTelemetryStatus: 503,
  failedTelemetryResponse: {
    message: 'Telemetry service unavailable',
  },
} as const;

export const formatTemperatureForUi = (temperature: number): string =>
  `${Math.round(temperature)}°`;
