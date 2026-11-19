export type OpcUaClientState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

export type OpcUaSecurityMode = 'None' | 'Sign' | 'SignAndEncrypt';

export type OpcUaSecurityPolicy = 'None' | 'Basic256Sha256';

export interface OpcUaSecurityOptions {
  readonly mode: OpcUaSecurityMode;
  readonly policy: OpcUaSecurityPolicy;
  readonly pkiRootFolder: string;
  readonly trustUnknownServerCertificate: boolean;
}

export interface OpcUaClientOptions {
  readonly endpoint: string;
  readonly connectionTimeoutMs: number;
  readonly security?: OpcUaSecurityOptions;
}

export interface OpcUaBrowseNode {
  readonly nodeId: string;
  readonly browseName: string;
  readonly displayName: string;
  readonly nodeClass: string;
  readonly parentNodeId: string;
  readonly path: readonly string[];
}

export interface OpcUaMonitorOptions {
  readonly samplingIntervalMs?: number;
  readonly publishingIntervalMs?: number;
  readonly queueSize?: number;
}

export interface OpcUaReadResult {
  readonly nodeId: string;
  readonly value: unknown;
  readonly dataType: string;
  readonly statusCode: string;
  readonly isGood: boolean;
  readonly sourceTimestamp: Date | null;
  readonly serverTimestamp: Date | null;
}

export interface OpcUaDataChange extends OpcUaReadResult {
  readonly receivedAt: Date;
}

export type OpcUaWriteDataType = 'Boolean' | 'Int32' | 'UInt32' | 'Float' | 'Double' | 'String';

export type OpcUaWriteValue = boolean | number | string;

export interface OpcUaWriteResult {
  readonly nodeId: string;
  readonly statusCode: string;
  readonly isGood: boolean;
}

export interface OpcUaMethodArgument {
  readonly dataType: OpcUaWriteDataType;
  readonly value: OpcUaWriteValue;
}

export interface OpcUaMethodCallResult {
  readonly objectNodeId: string;
  readonly methodNodeId: string;
  readonly statusCode: string;
  readonly isGood: boolean;
  readonly outputArguments: readonly unknown[];
}
