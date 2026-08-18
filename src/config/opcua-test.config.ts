export const opcUaTestConfig = {
  endpoint: process.env.OPC_UA_ENDPOINT ?? 'opc.tcp://localhost:50000',
  invalidEndpoint: process.env.OPC_UA_INVALID_ENDPOINT ?? 'opc.tcp://127.0.0.1:1',
  connectionTimeoutMs: 3_000,
  valueChangeTimeoutMs: 8_000,
  subscriptionTimeoutMs: 8_000,
  browseMaxDepth: 6,
  simulationRootBrowseName: 'OpcPlc',
  fastNodeNamePattern: /^FastUInt\d+$/i,
  relevantNodeNamePattern: /^(?:Bad)?(?:Fast|Slow)UInt\d+$/i,
  writableNodeFolderBrowseName: 'HardwareTesting',
  writableNodeBrowseName: 'HardwareCommandValue',
  writableNodeDataType: 'UInt32',
} as const;
