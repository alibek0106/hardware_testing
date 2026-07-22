import { expect, test as base } from '@playwright/test';
import { DeviceApiClient } from '../../src/api/DeviceApiClient';

interface ApiFixtures {
  readonly deviceApiClient: DeviceApiClient;
}

export const test = base.extend<ApiFixtures>({
  deviceApiClient: async ({ request }, use) => {
    const deviceApiClient = new DeviceApiClient(request);

    try {
      await use(deviceApiClient);
    } finally {
      await deviceApiClient.cleanup();
    }
  },
});

export { expect };
