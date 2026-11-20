import { expect, test as base } from '@playwright/test';
import { tankTestConfig } from '../../src/config/tank-test.config';
import { OpcUaClient } from '../../src/opcua/OpcUaClient';
import { resolveTankNodes, type TankNodes } from '../../src/opcua/TankNodes';
import { OperatorPanelPage } from '../../src/pages/OperatorPanelPage';

export interface TankDeviceRig {
  readonly client: OpcUaClient;
  readonly nodes: TankNodes;
}

interface TankFixtures {
  readonly tankDevice: TankDeviceRig;
  readonly operatorPanel: OperatorPanelPage;
}

export const test = base.extend<TankFixtures>({
  tankDevice: async ({}, use) => {
    const client = new OpcUaClient({
      endpoint: tankTestConfig.endpoint,
      connectionTimeoutMs: tankTestConfig.connectionTimeoutMs,
    });

    await client.connect();

    const nodes = await resolveTankNodes(client);

    // The device is shared, persistent state: reset to the known start values
    // before AND after every test so the specs pass in any order — also when
    // a previous run was killed mid-test.
    await client.callMethod(nodes.simulationObject, nodes.methods.reset);

    try {
      await use({
        client,
        nodes,
      });
    } finally {
      try {
        await client.callMethod(nodes.simulationObject, nodes.methods.reset);
      } finally {
        await client.disconnect();
      }
    }
  },

  operatorPanel: async ({ page }, use) => {
    await use(new OperatorPanelPage(page));
  },
});

export { expect };
