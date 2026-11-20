import { randomUUID } from 'node:crypto';
import { discoverFastTelemetryNode } from '../../src/opcua/OpcUaNodeDiscovery';
import { expect, test } from '../fixtures/integration.fixture';

const requireNumber = (value: unknown, message: string): number => {
  expect(typeof value, message).toBe('number');

  if (typeof value !== 'number') {
    throw new Error(message);
  }

  return value;
};

test.describe('Device telemetry integration', () => {
  test('flows one live OPC UA reading through the API and into the UI', async ({
    airQualityPage,
    deviceApiClient,
    opcUaClient,
  }) => {
    await opcUaClient.connect();

    const discovery = await discoverFastTelemetryNode(opcUaClient);
    const opcUaReading = await opcUaClient.readNode(discovery.node.nodeId);

    expect(opcUaReading.isGood).toBe(true);
    expect(opcUaReading.dataType).toBe('UInt32');

    const liveReading = requireNumber(
      opcUaReading.value,
      'The OPC UA telemetry value must be numeric',
    );

    const provisioned = await deviceApiClient.provisionDevice({
      name: `TX-100-integration-${randomUUID()}`,
      model: 'TX-100',
      sensor_type: 'air-quality',
      firmware: 'v1.2.0',
    });

    expect(provisioned.status).toBe(200);

    const ingested = await deviceApiClient.recordTelemetry(provisioned.device.id, liveReading);

    expect(ingested.status).toBe(200);
    expect(ingested.device.data.lastReading).toBe(liveReading);

    const persisted = await deviceApiClient.retrieveDevice(provisioned.device.id);

    expect(persisted.status).toBe(200);
    expect(persisted.device.data.lastReading).toBe(liveReading);

    await airQualityPage.mockAqi(liveReading);

    await airQualityPage.openInitialCityPage();
    await airQualityPage.searchForLondon();

    await airQualityPage.expectAqi(liveReading);
    await airQualityPage.expectAirQualityPageOperational();
  });
});
