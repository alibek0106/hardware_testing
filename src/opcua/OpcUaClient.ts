import {
  AttributeIds,
  DataType,
  type DataValue,
  type ClientSession,
  type ClientSubscription,
  MessageSecurityMode,
  MonitoringMode,
  NodeClass,
  OPCUAClient,
  SecurityPolicy,
  TimestampsToReturn,
} from 'node-opcua';
import {
  OpcUaClientStateError,
  OpcUaConnectionError,
  OpcUaDisconnectError,
  OpcUaOperationError,
  OpcUaSubscriptionTerminatedError,
  OpcUaSubscriptionTimeoutError,
} from '../errors/OpcUaClientError';
import type {
  OpcUaBrowseNode,
  OpcUaClientOptions,
  OpcUaClientState,
  OpcUaDataChange,
  OpcUaReadResult,
  OpcUaWriteDataType,
  OpcUaWriteResult,
  OpcUaWriteValue,
} from '../types/opcua.types';

interface BrowseQueueEntry {
  readonly nodeId: string;
  readonly depth: number;
  readonly path: readonly string[];
}

const writeDataTypes: Record<OpcUaWriteDataType, DataType> = {
  Boolean: DataType.Boolean,
  Int32: DataType.Int32,
  UInt32: DataType.UInt32,
  Float: DataType.Float,
  Double: DataType.Double,
  String: DataType.String,
};

export class OpcUaClient {
  private client: OPCUAClient | undefined;
  private session: ClientSession | undefined;
  private state: OpcUaClientState = 'disconnected';
  private readonly subscriptions = new Set<ClientSubscription>();

  public constructor(private readonly options: OpcUaClientOptions) {}

  public get connectionState(): OpcUaClientState {
    return this.state;
  }

  public get activeSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  public async connect(): Promise<void> {
    if (this.state !== 'disconnected') {
      throw new OpcUaClientStateError('connect', this.state);
    }

    this.state = 'connecting';

    const client = OPCUAClient.create({
      applicationName: 'HardwareTestingOpcUaClient',
      connectionStrategy: {
        initialDelay: 100,
        maxDelay: 100,
        maxRetry: 0,
        randomisationFactor: 0,
      },
      transportTimeout: this.options.connectionTimeoutMs,
      requestedSessionTimeout: 15_000,
      endpointMustExist: false,
      keepSessionAlive: false,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
    });

    this.client = client;

    try {
      await client.connect(this.options.endpoint);
      this.session = await client.createSession();
      this.state = 'connected';
    } catch (cause) {
      await client.disconnect().catch(() => undefined);
      this.client = undefined;
      this.session = undefined;
      this.state = 'disconnected';

      throw new OpcUaConnectionError(this.options.endpoint, cause);
    }
  }

  public async browse(nodeId: string): Promise<OpcUaBrowseNode[]> {
    const session = this.requireSession('browse');
    const result = await session.browse(nodeId);
    const statusCode = result.statusCode.toString();

    if (!result.statusCode.isGood()) {
      throw new OpcUaOperationError('browse', nodeId, statusCode);
    }

    return (result.references ?? []).map((reference) => {
      const browseName = reference.browseName.name ?? reference.browseName.toString();
      const displayName = reference.displayName.text ?? browseName;
      const nodeClass = NodeClass[reference.nodeClass] ?? String(reference.nodeClass);

      return {
        nodeId: reference.nodeId.toString(),
        browseName,
        displayName,
        nodeClass,
        path: [displayName],
      };
    });
  }

  public async browseRecursively(rootNodeId: string, maxDepth: number): Promise<OpcUaBrowseNode[]> {
    const discoveredNodes: OpcUaBrowseNode[] = [];
    const visitedNodeIds = new Set<string>([rootNodeId]);
    const queue: BrowseQueueEntry[] = [
      {
        nodeId: rootNodeId,
        depth: 0,
        path: [],
      },
    ];

    while (queue.length > 0) {
      const current = queue.shift();

      if (current === undefined) {
        break;
      }

      const children = await this.browse(current.nodeId);

      for (const child of children) {
        const path = [...current.path, child.displayName];
        const discoveredNode = {
          ...child,
          path,
        };

        discoveredNodes.push(discoveredNode);

        if (
          current.depth < maxDepth &&
          child.nodeClass !== 'Variable' &&
          !visitedNodeIds.has(child.nodeId)
        ) {
          visitedNodeIds.add(child.nodeId);
          queue.push({
            nodeId: child.nodeId,
            depth: current.depth + 1,
            path,
          });
        }
      }
    }

    return discoveredNodes;
  }

  public async readNode(nodeId: string): Promise<OpcUaReadResult> {
    const session = this.requireSession('read');
    const dataValue = await session.read({
      nodeId,
      attributeId: AttributeIds.Value,
    });

    return this.createReadResult(nodeId, dataValue, 'read');
  }

  public async writeNode(
    nodeId: string,
    value: OpcUaWriteValue,
    dataType: OpcUaWriteDataType,
  ): Promise<OpcUaWriteResult> {
    const session = this.requireSession('write');

    const result = await session.write({
      nodeId,
      attributeId: AttributeIds.Value,
      value: {
        value: {
          dataType: writeDataTypes[dataType],
          value,
        },
      },
    });

    const statusCode = result.toString();

    if (!result.isGood()) {
      throw new OpcUaOperationError('write', nodeId, statusCode);
    }

    return {
      nodeId,
      statusCode,
      isGood: true,
    };
  }

  public async subscribeToNode(nodeId: string, timeoutMs: number): Promise<OpcUaDataChange> {
    const session = this.requireSession('subscribe');

    const subscription = await session.createSubscription2({
      requestedPublishingInterval: 500,
      requestedLifetimeCount: 120,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 10,
      publishingEnabled: true,
      priority: 1,
    });

    this.subscriptions.add(subscription);

    subscription.once('terminated', () => {
      this.subscriptions.delete(subscription);
    });

    const monitoredItem = await subscription.monitor(
      {
        nodeId,
        attributeId: AttributeIds.Value,
      },
      {
        samplingInterval: 250,
        discardOldest: true,
        queueSize: 10,
      },
      TimestampsToReturn.Both,
      MonitoringMode.Reporting,
    );

    return new Promise<OpcUaDataChange>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new OpcUaSubscriptionTimeoutError(nodeId, timeoutMs));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeout);
        monitoredItem.removeListener('changed', handleChanged);
        monitoredItem.removeListener('err', handleError);
        subscription.removeListener('terminated', handleTerminated);
      };

      const handleChanged = (dataValue: DataValue): void => {
        try {
          const readResult = this.createReadResult(nodeId, dataValue, 'subscription');

          cleanup();
          resolve({
            ...readResult,
            receivedAt: new Date(),
          });
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      const handleError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const handleTerminated = (): void => {
        cleanup();
        reject(new OpcUaSubscriptionTerminatedError(nodeId));
      };

      monitoredItem.once('changed', handleChanged);
      monitoredItem.once('err', handleError);
      subscription.once('terminated', handleTerminated);
    });
  }

  public async disconnect(): Promise<void> {
    if (this.state === 'disconnected') {
      return;
    }

    this.state = 'disconnecting';

    let disconnectError: unknown;

    try {
      if (this.client !== undefined) {
        await this.client.disconnect();
      }
    } catch (error) {
      disconnectError = error;
    } finally {
      this.subscriptions.clear();
      this.session = undefined;
      this.client = undefined;
      this.state = 'disconnected';
    }

    if (disconnectError !== undefined) {
      throw new OpcUaDisconnectError(disconnectError);
    }
  }

  private requireSession(operation: string): ClientSession {
    if (this.state !== 'connected' || this.session === undefined) {
      throw new OpcUaClientStateError(operation, this.state);
    }

    return this.session;
  }

  private createReadResult(
    nodeId: string,
    dataValue: DataValue,
    operation: string,
  ): OpcUaReadResult {
    const statusCode = dataValue.statusCode.toString();

    if (!dataValue.statusCode.isGood()) {
      throw new OpcUaOperationError(operation, nodeId, statusCode);
    }

    const dataType = DataType[dataValue.value.dataType] ?? String(dataValue.value.dataType);

    return {
      nodeId,
      value: dataValue.value.value as unknown,
      dataType,
      statusCode,
      isGood: dataValue.statusCode.isGood(),
      sourceTimestamp: dataValue.sourceTimestamp,
      serverTimestamp: dataValue.serverTimestamp,
    };
  }
}
