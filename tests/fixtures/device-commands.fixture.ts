import type { OpcUaClient } from '../../src/opcua/OpcUaClient';
import {
  discoverDeviceCommandNodes,
  type DeviceCommandDiscovery,
} from '../../src/opcua/OpcUaNodeDiscovery';
import { expect, test as opcUaTest } from './opcua.fixture';

export interface DeviceCommandRig {
  readonly client: OpcUaClient;
  readonly nodes: DeviceCommandDiscovery;
}

interface DeviceCommandFixtures {
  readonly deviceRig: DeviceCommandRig;
}

export const test = opcUaTest.extend<DeviceCommandFixtures>({
  deviceRig: async ({ opcUaClient }, use) => {
    await opcUaClient.connect();

    const nodes = await discoverDeviceCommandNodes(opcUaClient);

    try {
      await use({
        client: opcUaClient,
        nodes,
      });
    } finally {
      await opcUaClient.callMethod(nodes.methodsNode.nodeId, nodes.methods.startStepUp.nodeId);
      await opcUaClient.callMethod(
        nodes.methodsNode.nodeId,
        nodes.methods.startUpdateFastNodes.nodeId,
      );
    }
  },
});

export { expect };
