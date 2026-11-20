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
  webServer: [
    {
      command: 'node rig/tank-simulator.mjs',
      port: Number(process.env.TANK_OPC_PORT ?? 4840),
      reuseExistingServer: !isCi,
      // Generous: node-opcua generates the server certificate on first run,
      // which can take well over a minute on a cold corporate Windows profile.
      // Warm runs reuse the cached PKI and bind in a few seconds.
      timeout: 180_000,
      stdout: 'pipe',
    },
    {
      command: 'node rig/tank-gateway.mjs',
      url: `${process.env.TANK_GATEWAY_URL ?? 'http://localhost:3000'}/healthz`,
      reuseExistingServer: !isCi,
      timeout: 180_000,
      stdout: 'pipe',
    },
  ],
  projects: [
    {
      name: 'ui-chromium',
      testDir: './tests/ui',
      testMatch: '**/weather-hardware-state.spec.ts',
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
      name: 'ui-aqicn',
      testDir: './tests/ui',
      testMatch: '**/air-quality-hardware-state.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.AQI_BASE_URL ?? 'https://aqicn.org',
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
    {
      name: 'tank',
      testDir: './tests/tank',
      testMatch: '**/*.spec.ts',
      timeout: 60_000,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.TANK_GATEWAY_URL ?? 'http://localhost:3000',
        serviceWorkers: 'block',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        actionTimeout: 10_000,
        navigationTimeout: 30_000,
      },
    },
    {
      name: 'integration',
      testDir: './tests/integration',
      testMatch: '**/*.spec.ts',
      timeout: 60_000,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.AQI_BASE_URL ?? 'https://aqicn.org',
        serviceWorkers: 'block',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        actionTimeout: 10_000,
        navigationTimeout: 30_000,
      },
    },
  ],
});
