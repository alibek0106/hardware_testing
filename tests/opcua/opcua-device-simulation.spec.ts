import type { TestInfo } from '@playwright/test';
import { opcUaTestConfig } from '../../src/config/opcua-test.config';
import { OpcUaClientStateError, OpcUaConnectionError } from '../../src/errors/OpcUaClientError';
import { OpcUaClient } from '../../src/opcua/OpcUaClient';
import type { OpcUaBrowseNode } from '../../src/types/opcua.types';
import { expect, test } from '../fixtures/opcua.fixture';

const requireNode = (
  nodes: readonly OpcUaBrowseNode[],
  predicate: (node: OpcUaBrowseNode) => boolean,
  message: string,
): OpcUaBrowseNode => {
  const node = nodes.find(predicate);

  expect(node, message).toBeDefined();

  if (node === undefined) {
    throw new Error(message);
  }

  return node;
};

const requireNumber = (value: unknown, message: string): number => {
  expect(typeof value, message).toBe('number');

  if (typeof value !== 'number') {
    throw new Error(message);
  }

  return value;
};

const discoverFastNode = async (
  client: OpcUaClient,
  testInfo?: TestInfo,
): Promise<OpcUaBrowseNode> => {
  const objectNodes = await client.browse('ObjectsFolder');

  const simulationRoot = requireNode(
    objectNodes,
    (node) =>
      node.browseName === opcUaTestConfig.simulationRootBrowseName ||
      node.displayName === opcUaTestConfig.simulationRootBrowseName,
    'The OpcPlc simulation root was not found',
  );

  const discoveredNodes = await client.browseRecursively(
    simulationRoot.nodeId,
    opcUaTestConfig.browseMaxDepth,
  );

  const relevantNodes = discoveredNodes.filter((node) =>
    opcUaTestConfig.relevantNodeNamePattern.test(node.browseName),
  );

  if (testInfo !== undefined) {
    await testInfo.attach('opc-ua-discovered-nodes', {
      body: Buffer.from(JSON.stringify(relevantNodes, null, 2)),
      contentType: 'application/json',
    });
  }

  return requireNode(
    relevantNodes,
    (node) =>
      node.nodeClass === 'Variable' && opcUaTestConfig.fastNodeNamePattern.test(node.browseName),
    'A changing Fast OPC UA variable was not found',
  );
};

const discoverWritableNode = async (
  client: OpcUaClient,
  testInfo?: TestInfo,
): Promise<OpcUaBrowseNode> => {
  const discoveredNodes = await client.browseRecursively(
    'RootFolder',
    opcUaTestConfig.browseMaxDepth,
  );

  const writableNode = requireNode(
    discoveredNodes,
    (node) =>
      node.nodeClass === 'Variable' && node.browseName === opcUaTestConfig.writableNodeBrowseName,
    'The HardwareCommandValue writable node was not found',
  );

  if (testInfo !== undefined) {
    await testInfo.attach('opc-ua-writable-node', {
      body: Buffer.from(JSON.stringify(writableNode, null, 2)),
      contentType: 'application/json',
    });
  }

  return writableNode;
};

test.describe('OPC UA device simulation', () => {
  test('browses and reads a live changing numeric value', async ({ opcUaClient }, testInfo) => {
    await opcUaClient.connect();

    expect(opcUaClient.connectionState).toBe('connected');

    const fastNode = await discoverFastNode(opcUaClient, testInfo);
    const firstRead = await opcUaClient.readNode(fastNode.nodeId);

    expect(firstRead.isGood).toBe(true);
    expect(firstRead.dataType).toBe('UInt32');
    expect(typeof firstRead.value).toBe('number');

    let secondRead = firstRead;

    await expect
      .poll(
        async () => {
          secondRead = await opcUaClient.readNode(fastNode.nodeId);
          return secondRead.value;
        },
        {
          timeout: opcUaTestConfig.valueChangeTimeoutMs,
          intervals: [500, 1_000],
          message: `Value for ${fastNode.nodeId} did not change`,
        },
      )
      .not.toEqual(firstRead.value);

    expect(secondRead.isGood).toBe(true);
    expect(secondRead.dataType).toBe('UInt32');
    expect(typeof secondRead.value).toBe('number');
  });

  test('receives a data-change notification and disconnects cleanly', async ({ opcUaClient }) => {
    await opcUaClient.connect();

    const fastNode = await discoverFastNode(opcUaClient);
    const notification = await opcUaClient.subscribeToNode(
      fastNode.nodeId,
      opcUaTestConfig.subscriptionTimeoutMs,
    );

    expect(notification.isGood).toBe(true);
    expect(notification.dataType).toBe('UInt32');
    expect(typeof notification.value).toBe('number');
    expect(opcUaClient.activeSubscriptionCount).toBe(1);

    await opcUaClient.disconnect();

    expect(opcUaClient.connectionState).toBe('disconnected');
    expect(opcUaClient.activeSubscriptionCount).toBe(0);

    await expect(opcUaClient.readNode(fastNode.nodeId)).rejects.toBeInstanceOf(
      OpcUaClientStateError,
    );
  });

  test('fails cleanly when the endpoint is unavailable', async () => {
    const invalidClient = new OpcUaClient({
      endpoint: opcUaTestConfig.invalidEndpoint,
      connectionTimeoutMs: opcUaTestConfig.connectionTimeoutMs,
    });

    await expect(invalidClient.connect()).rejects.toBeInstanceOf(OpcUaConnectionError);

    expect(invalidClient.connectionState).toBe('disconnected');

    await expect(invalidClient.disconnect()).resolves.toBeUndefined();
  });

  test('writes a hardware command and reads the applied value back', async ({
    opcUaClient,
  }, testInfo) => {
    await opcUaClient.connect();

    const writableNode = await discoverWritableNode(opcUaClient, testInfo);
    const initialRead = await opcUaClient.readNode(writableNode.nodeId);

    expect(initialRead.isGood).toBe(true);
    expect(initialRead.dataType).toBe(opcUaTestConfig.writableNodeDataType);

    const initialValue = requireNumber(
      initialRead.value,
      'The writable OPC UA node did not contain a numeric value',
    );

    const writtenValue = (initialValue + 1) % 4_294_967_296;

    try {
      const writeResult = await opcUaClient.writeNode(
        writableNode.nodeId,
        writtenValue,
        opcUaTestConfig.writableNodeDataType,
      );

      expect(writeResult.isGood).toBe(true);
      expect(writeResult.statusCode).toBe('Good (0x00000000)');

      const readBack = await opcUaClient.readNode(writableNode.nodeId);

      expect(readBack.isGood).toBe(true);
      expect(readBack.dataType).toBe(opcUaTestConfig.writableNodeDataType);
      expect(readBack.value).toBe(writtenValue);
    } finally {
      await opcUaClient.writeNode(
        writableNode.nodeId,
        initialValue,
        opcUaTestConfig.writableNodeDataType,
      );
    }
  });
});
