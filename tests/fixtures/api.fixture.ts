import { expect, request as playwrightRequest, test as base } from '@playwright/test';
import { DeviceApiClient } from '../../src/api/DeviceApiClient';

interface ApiFixtures {
  readonly deviceApiClient: DeviceApiClient;
}

const deviceApiBaseUrl = process.env.DEVICE_API_BASE_URL ?? 'https://api.restful-api.dev';

export const test = base.extend<ApiFixtures>({
  deviceApiClient: async ({}, use) => {
    const apiRequest = await playwrightRequest.newContext({
      baseURL: deviceApiBaseUrl,
    });

    const deviceApiClient = new DeviceApiClient(apiRequest);

    try {
      await use(deviceApiClient);
    } finally {
      try {
        await deviceApiClient.cleanup();
      } finally {
        await apiRequest.dispose();
      }
    }
  },
});

export { expect };
