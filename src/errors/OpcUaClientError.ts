import type { OpcUaClientState } from '../types/opcua.types';

const getErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class OpcUaConnectionError extends Error {
  public constructor(
    public readonly endpoint: string,
    public readonly cause: unknown,
  ) {
    super(`Unable to connect to ${endpoint}: ${getErrorMessage(cause)}`);
    this.name = 'OpcUaConnectionError';
  }
}

export class OpcUaClientStateError extends Error {
  public constructor(
    public readonly operation: string,
    public readonly state: OpcUaClientState,
  ) {
    super(`Cannot perform ${operation} while the OPC UA client is ${state}`);
    this.name = 'OpcUaClientStateError';
  }
}

export class OpcUaOperationError extends Error {
  public constructor(
    public readonly operation: string,
    public readonly target: string,
    public readonly statusCode: string,
  ) {
    super(`${operation} failed for ${target} with status ${statusCode}`);
    this.name = 'OpcUaOperationError';
  }
}

export class OpcUaSubscriptionTimeoutError extends Error {
  public constructor(
    public readonly nodeId: string,
    public readonly timeoutMs: number,
  ) {
    super(`No data-change notification was received for ${nodeId} within ${timeoutMs} ms`);
    this.name = 'OpcUaSubscriptionTimeoutError';
  }
}

export class OpcUaSubscriptionTerminatedError extends Error {
  public constructor(public readonly nodeId: string) {
    super(`The subscription for ${nodeId} terminated before a data change`);
    this.name = 'OpcUaSubscriptionTerminatedError';
  }
}

export class OpcUaDisconnectError extends Error {
  public constructor(public readonly cause: unknown) {
    super(`OPC UA disconnect failed: ${getErrorMessage(cause)}`);
    this.name = 'OpcUaDisconnectError';
  }
}
