export type OpcUaClientState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

export interface OpcUaClientOptions {
  readonly endpoint: string;
  readonly connectionTimeoutMs: number;
}

export interface OpcUaBrowseNode {
  readonly nodeId: string;
  readonly browseName: string;
  readonly displayName: string;
  readonly nodeClass: string;
  readonly path: readonly string[];
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
