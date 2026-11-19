import { opcUaTestConfig } from '../config/opcua-test.config';
import { OpcUaOperationError } from '../errors/OpcUaClientError';
import type { OpcUaBrowseNode } from '../types/opcua.types';
import { OpcUaClient } from './OpcUaClient';

export interface FastTelemetryDiscovery {
  readonly node: OpcUaBrowseNode;
  readonly relevantNodes: readonly OpcUaBrowseNode[];
}

export type DeviceCommandMethodKey = keyof typeof opcUaTestConfig.deviceCommandMethodBrowseNames;

export interface DeviceCommandDiscovery {
  readonly opcPlcNode: OpcUaBrowseNode;
  readonly methodsNode: OpcUaBrowseNode;
  readonly stepUpNode: OpcUaBrowseNode;
  readonly fastNode: OpcUaBrowseNode;
  readonly methods: Readonly<Record<DeviceCommandMethodKey, OpcUaBrowseNode>>;
  readonly relevantNodes: readonly OpcUaBrowseNode[];
}

const requireDiscoveredNode = (
  nodes: readonly OpcUaBrowseNode[],
  predicate: (node: OpcUaBrowseNode) => boolean,
  label: string,
): OpcUaBrowseNode => {
  const node = nodes.find(predicate);

  if (node === undefined) {
    throw new OpcUaOperationError('discover', label, 'NodeNotFound');
  }

  return node;
};

/**
 * Locates the StepUp variable, one fast telemetry node and the opc-plc command
 * methods by browsing down from the Objects folder, so no namespace index is
 * ever hard-coded.
 */
export const discoverDeviceCommandNodes = async (
  client: OpcUaClient,
): Promise<DeviceCommandDiscovery> => {
  const opcPlcNode = await client.findNodeByBrowseName(
    opcUaTestConfig.objectsFolderNodeId,
    opcUaTestConfig.opcPlcBrowseName,
    opcUaTestConfig.browseMaxDepth,
  );

  const discoveredNodes = await client.browseRecursively(
    opcPlcNode.nodeId,
    opcUaTestConfig.browseMaxDepth,
  );

  const methodsNode = requireDiscoveredNode(
    discoveredNodes,
    (node) =>
      node.nodeClass === 'Object' && node.browseName === opcUaTestConfig.methodsFolderBrowseName,
    opcUaTestConfig.methodsFolderBrowseName,
  );

  const stepUpNode = requireDiscoveredNode(
    discoveredNodes,
    (node) => node.nodeClass === 'Variable' && node.browseName === opcUaTestConfig.stepUpBrowseName,
    opcUaTestConfig.stepUpBrowseName,
  );

  const fastNode = requireDiscoveredNode(
    discoveredNodes,
    (node) =>
      node.nodeClass === 'Variable' && opcUaTestConfig.fastNodeNamePattern.test(node.browseName),
    opcUaTestConfig.fastNodeNamePattern.source,
  );

  const methodEntries = Object.entries(opcUaTestConfig.deviceCommandMethodBrowseNames).map(
    ([key, browseName]) => [
      key,
      requireDiscoveredNode(
        discoveredNodes,
        (node) =>
          node.nodeClass === 'Method' &&
          node.browseName === browseName &&
          node.parentNodeId === methodsNode.nodeId,
        browseName,
      ),
    ],
  );

  const methods = Object.fromEntries(methodEntries) as Record<
    DeviceCommandMethodKey,
    OpcUaBrowseNode
  >;

  return {
    opcPlcNode,
    methodsNode,
    stepUpNode,
    fastNode,
    methods,
    relevantNodes: [opcPlcNode, methodsNode, stepUpNode, fastNode, ...Object.values(methods)],
  };
};

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
