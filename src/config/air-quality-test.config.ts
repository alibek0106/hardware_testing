export const airQualityTestConfig = {
  initialCityPath: '/city/beijing/',
  initialCityName: 'Beijing',
  targetCityQuery: 'London',
  targetCitySearchResult: 'london westminster, united kingdom',
  targetCityPath: '/city/united-kingdom/london-westminster/',
  targetCityTitle: /London Westminster(?:, United Kingdom)? AQI/,
  targetStationId: 10874,
  aqiRoute: '**/api/feed/@10874/aqi.json*',
  outOfRangeAqi: 999,
  telemetryFailureStatus: 503,
} as const;
