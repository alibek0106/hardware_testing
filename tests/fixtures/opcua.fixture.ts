import { expect, test as base } from '@playwright/test';
import { opcUaTestConfig } from '../../src/config/opcua-test.config';
import { OpcUaClient } from '../../src/opcua/OpcUaClient';

interface OpcUaTestOptions {
  readonly opcUaEndpoint: string;
}

interface OpcUaFixtures {
  readonly opcUaClient: OpcUaClient;
}

export const test = base.extend<OpcUaTestOptions & OpcUaFixtures>({
  opcUaEndpoint: [opcUaTestConfig.endpoint, { option: true }],

  opcUaClient: async ({ opcUaEndpoint }, use) => {
    const client = new OpcUaClient({
      endpoint: opcUaEndpoint,
      connectionTimeoutMs: opcUaTestConfig.connectionTimeoutMs,
    });

    try {
      await use(client);
    } finally {
      await client.disconnect();
    }
  },
});

export { expect };
