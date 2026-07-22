import { defineConfig, devices } from '@playwright/test';

const isCi = Boolean(process.env.CI);

export default defineConfig({
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: isCi,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: 'test-results',
  reporter: [
    [isCi ? 'github' : 'list'],
    [
      'html',
      {
        outputFolder: 'playwright-report',
        open: 'never',
      },
    ],
  ],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'ui-chromium',
      testDir: './tests/ui',
      testMatch: '**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.WEATHER_BASE_URL ?? 'https://openweathermap.org',
        serviceWorkers: 'block',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        actionTimeout: 10_000,
        navigationTimeout: 30_000,
      },
    },
    {
      name: 'api',
      testDir: './tests/api',
      testMatch: '**/*.spec.ts',
      use: {
        baseURL: process.env.DEVICE_API_BASE_URL ?? 'https://api.restful-api.dev',
        trace: 'off',
      },
    },
    {
      name: 'opcua',
      testDir: './tests/opcua',
      testMatch: '**/*.spec.ts',
      timeout: 60_000,
      use: {
        trace: 'off',
      },
    },
  ],
});
