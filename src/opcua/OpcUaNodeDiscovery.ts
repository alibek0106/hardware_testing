import { opcUaTestConfig } from '../config/opcua-test.config';
import { OpcUaOperationError } from '../errors/OpcUaClientError';
import type { OpcUaBrowseNode } from '../types/opcua.types';
import { OpcUaClient } from './OpcUaClient';

export interface FastTelemetryDiscovery {
  readonly node: OpcUaBrowseNode;
  readonly relevantNodes: readonly OpcUaBrowseNode[];
}

export const discoverFastTelemetryNode = async (
  client: OpcUaClient,
): Promise<FastTelemetryDiscovery> => {
  const discoveredNodes = await client.browseRecursively(
    'RootFolder',
    opcUaTestConfig.browseMaxDepth,
  );

  const relevantNodes = discoveredNodes.filter((node) =>
    opcUaTestConfig.relevantNodeNamePattern.test(node.browseName),
  );

  const node = relevantNodes.find(
    (candidate) =>
      candidate.nodeClass === 'Variable' &&
      opcUaTestConfig.fastNodeNamePattern.test(candidate.browseName),
  );

  if (node === undefined) {
    throw new OpcUaOperationError(
      'discover',
      opcUaTestConfig.fastNodeNamePattern.source,
      'NodeNotFound',
    );
  }

  return {
    node,
    relevantNodes,
  };
};
