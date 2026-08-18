export const airQualityTestConfig = {
  initialCityPath: '/city/beijing/',
  initialCityName: 'Beijing',
  targetCityQuery: 'London',
  targetCitySearchResult: 'London, United Kingdom',
  targetCityPath: '/city/london/',
  targetStationId: 5724,
  aqiRoute: '**/api/feed/@5724/aqi.json*',
  outOfRangeAqi: 999,
  telemetryFailureStatus: 503,
} as const;
