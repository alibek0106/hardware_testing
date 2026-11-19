import type { OpcUaClient } from '../../src/opcua/OpcUaClient';
import {
  discoverSignalQualityNodes,
  type DeviceCommandDiscovery,
  type SignalQualityDiscovery,
} from '../../src/opcua/OpcUaNodeDiscovery';
import { expect, test as deviceCommandsTest } from './device-commands.fixture';

export interface SignalQualityRig {
  readonly client: OpcUaClient;
  readonly commands: DeviceCommandDiscovery;
  readonly signals: SignalQualityDiscovery;
}

interface SignalQualityFixtures {
  readonly signalRig: SignalQualityRig;
}

export const test = deviceCommandsTest.extend<SignalQualityFixtures>({
  signalRig: async ({ deviceRig }, use) => {
    const signals = await discoverSignalQualityNodes(deviceRig.client);

    await use({
      client: deviceRig.client,
      commands: deviceRig.nodes,
      signals,
    });
  },
});

export { expect };
