import {
  AttributeIds,
  DataChangeFilter,
  DataChangeTrigger,
  DataType,
  type DataValue,
  DeadbandType,
  type ClientMonitoredItemBase,
  type ClientSession,
  type ClientSubscription,
  MessageSecurityMode,
  MonitoringMode,
  NodeClass,
  OPCUACertificateManager,
  OPCUAClient,
  SecurityPolicy,
  TimestampsToReturn,
} from 'node-opcua';
import {
  OpcUaCertificateTrustError,
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
  OpcUaMethodArgument,
  OpcUaMethodCallResult,
  OpcUaMonitorCollector,
  OpcUaMonitorOptions,
  OpcUaReadResult,
  OpcUaSecurityMode,
  OpcUaSecurityOptions,
  OpcUaSecurityPolicy,
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

const securityModes: Record<OpcUaSecurityMode, MessageSecurityMode> = {
  None: MessageSecurityMode.None,
  Sign: MessageSecurityMode.Sign,
  SignAndEncrypt: MessageSecurityMode.SignAndEncrypt,
};

const securityPolicies: Record<OpcUaSecurityPolicy, SecurityPolicy> = {
  None: SecurityPolicy.None,
  Basic256Sha256: SecurityPolicy.Basic256Sha256,
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

// Server_NamespaceArray — fixed by the OPC UA specification in namespace 0,
// identical on every server, and therefore safe to reference by node id.
const namespaceArrayNodeId = 'ns=0;i=2255';

const isCertificateTrustFailure = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);

  return /Certificate verification failed|BadCertificate|BadSecurityChecksFailed/i.test(message);
};

const awaitWithTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  void promise.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export class OpcUaClient {
  private client: OPCUAClient | undefined;
  private session: ClientSession | undefined;
  private certificateManager: OPCUACertificateManager | undefined;
  private state: OpcUaClientState = 'disconnected';
  private readonly subscriptions = new Set<ClientSubscription>();

  public constructor(private readonly options: OpcUaClientOptions) {}

  public get connectionState(): OpcUaClientState {
    return this.state;
  }

  public get activeSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  public get certificateFile(): string | undefined {
    return this.client?.certificateFile;
  }

  public async connect(): Promise<void> {
    if (this.state !== 'disconnected') {
      throw new OpcUaClientStateError('connect', this.state);
    }

    this.state = 'connecting';

    const security = this.options.security;

    try {
      const certificateManager =
        security === undefined ? undefined : this.requireCertificateManager(security);

      const client = OPCUAClient.create({
        applicationName: 'HardwareTestingOpcUaClient',
        connectionStrategy: {
          initialDelay: 100,
          maxDelay: 100,
          maxRetry: 0,
          randomisationFactor: 0,
        },
        // transportTimeout is the SOCKET INACTIVITY timeout, not a connect
        // bound (connect is raced against connectionTimeoutMs below) — it must
        // comfortably exceed any stretch where a test leaves the session idle,
        // e.g. while watching the UI converge.
        transportTimeout: 120_000,
        requestedSessionTimeout: 15_000,
        endpointMustExist: false,
        // Keep-alive pings keep both the session and the transport alive
        // through idle stretches; without them the server reaps the session
        // after requestedSessionTimeout of inactivity.
        keepSessionAlive: true,
        securityMode: securityModes[security?.mode ?? 'None'],
        securityPolicy: securityPolicies[security?.policy ?? 'None'],
        ...(certificateManager === undefined
          ? {}
          : { clientCertificateManager: certificateManager }),
      });

      this.client = client;

      if (certificateManager !== undefined) {
        await certificateManager.initialize();
        await client.createDefaultCertificate();
      }

      await awaitWithTimeout(
        client.connect(this.options.endpoint),
        this.options.connectionTimeoutMs,
        `connect to ${this.options.endpoint}`,
      );
      this.session = await client.createSession();
      this.state = 'connected';
    } catch (cause) {
      await this.client?.disconnect().catch(() => undefined);
      this.client = undefined;
      this.session = undefined;
      this.state = 'disconnected';

      if (security !== undefined && isCertificateTrustFailure(cause)) {
        throw new OpcUaCertificateTrustError(this.options.endpoint, cause);
      }

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
        parentNodeId: nodeId,
        path: [displayName],
      };
    });
  }

  /**
   * Finds the first node with the given browse name below a starting node using
   * breadth-first browsing, so no namespace index has to be hard-coded.
   * Throws {@link OpcUaOperationError} with status `NodeNotFound` when nothing matches.
   */
  public async findNodeByBrowseName(
    startNodeId: string,
    browseName: string,
    maxDepth: number,
  ): Promise<OpcUaBrowseNode> {
    const visitedNodeIds = new Set<string>([startNodeId]);
    const queue: BrowseQueueEntry[] = [
      {
        nodeId: startNodeId,
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

        if (child.browseName === browseName) {
          return {
            ...child,
            path,
          };
        }

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

    throw new OpcUaOperationError('find', `${browseName} below ${startNodeId}`, 'NodeNotFound');
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

  /**
   * Reads a node's full data value — value, status code and both timestamps —
   * WITHOUT raising on a non-Good status. Use this for signal-quality analysis
   * where Bad and Uncertain values are themselves the subject of the test;
   * {@link requireGood} converts the result back into fail-fast semantics.
   */
  public async readDataValue(nodeId: string): Promise<OpcUaReadResult> {
    const session = this.requireSession('read');
    const dataValue = await session.read({
      nodeId,
      attributeId: AttributeIds.Value,
    });

    const change = this.createDataChange(nodeId, dataValue);

    return {
      nodeId: change.nodeId,
      value: change.value,
      dataType: change.dataType,
      statusCode: change.statusCode,
      isGood: change.isGood,
      sourceTimestamp: change.sourceTimestamp,
      serverTimestamp: change.serverTimestamp,
    };
  }

  /**
   * Resolves a namespace URI to its index by reading the server's
   * NamespaceArray at call time, so node ids never need a hard-coded
   * namespace index that could change between server versions.
   */
  public async resolveNamespaceIndex(namespaceUri: string): Promise<number> {
    const namespaceArray = await this.readNode(namespaceArrayNodeId);
    const namespaces = namespaceArray.value;

    if (
      !Array.isArray(namespaces) ||
      !namespaces.every((uri): uri is string => typeof uri === 'string')
    ) {
      throw new OpcUaOperationError('resolveNamespace', namespaceArrayNodeId, 'BadTypeMismatch');
    }

    const index = namespaces.indexOf(namespaceUri);

    if (index < 0) {
      throw new OpcUaOperationError('resolveNamespace', namespaceUri, 'NamespaceNotFound');
    }

    return index;
  }

  /**
   * Returns the value carried by a data value whose status is Good and throws
   * {@link OpcUaOperationError} with the status code name for Bad or Uncertain
   * data, so a failed or degraded sensor can never be read as a plain number.
   */
  public requireGood(dataValue: OpcUaReadResult): unknown {
    if (!dataValue.isGood) {
      throw new OpcUaOperationError('requireGood', dataValue.nodeId, dataValue.statusCode);
    }

    return dataValue.value;
  }

  /**
   * Reports whether a data value is stale: its source timestamp (the
   * device-side stamp of the last real update, falling back to the server
   * timestamp when absent) is older than `maxAgeMs`. A frozen sensor keeps
   * returning the same value with a frozen source timestamp, which is exactly
   * what this detects.
   */
  public isStale(dataValue: OpcUaReadResult, maxAgeMs: number): boolean {
    const timestamp = dataValue.sourceTimestamp ?? dataValue.serverTimestamp;

    if (timestamp === null) {
      return true;
    }

    return Date.now() - timestamp.getTime() > maxAgeMs;
  }

  /**
   * Starts monitoring a node and returns a collector whose `take(count,
   * timeoutMs)` awaits that many consecutive data-change notifications and
   * whose `collectDuring(windowMs)` gathers everything inside a bounded
   * window that starts at the call — notifications buffered earlier are
   * discarded. The monitored item's initial-value notification is discarded.
   * `creationStatusCode` carries the server's status for creating the
   * monitored item (relevant when a filter such as a deadband is requested).
   * Call `stop()` to terminate the underlying subscription.
   */
  public async monitor(
    nodeId: string,
    options?: OpcUaMonitorOptions,
  ): Promise<OpcUaMonitorCollector> {
    const { subscription, monitoredItem } = await this.startMonitoring(nodeId, options);
    const buffer: OpcUaDataChange[] = [];
    const waiters = new Set<() => void>();
    let initialNotificationSeen = false;
    let failure: Error | undefined;

    const notifyWaiters = (): void => {
      for (const waiter of [...waiters]) {
        waiter();
      }
    };

    monitoredItem.on('changed', (dataValue: DataValue) => {
      if (!initialNotificationSeen) {
        initialNotificationSeen = true;
        return;
      }

      buffer.push(this.createDataChange(nodeId, dataValue));
      notifyWaiters();
    });

    monitoredItem.once('err', (error: unknown) => {
      failure ??= toError(error);
      notifyWaiters();
    });

    subscription.once('terminated', () => {
      failure ??= new OpcUaSubscriptionTerminatedError(nodeId);
      notifyWaiters();
    });

    return {
      nodeId,
      creationStatusCode: monitoredItem.statusCode.toString(),
      take: (count: number, timeoutMs: number): Promise<OpcUaDataChange[]> =>
        new Promise<OpcUaDataChange[]>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(check);
            reject(new OpcUaSubscriptionTimeoutError(nodeId, timeoutMs));
          }, timeoutMs);

          const check = (): void => {
            if (failure !== undefined) {
              clearTimeout(timer);
              waiters.delete(check);
              reject(failure);
              return;
            }

            if (buffer.length >= count) {
              clearTimeout(timer);
              waiters.delete(check);
              resolve(buffer.splice(0, count));
            }
          };

          waiters.add(check);
          check();
        }),
      collectDuring: (windowMs: number): Promise<OpcUaDataChange[]> =>
        new Promise<OpcUaDataChange[]>((resolve, reject) => {
          // The window starts NOW: notifications buffered before this call
          // belong to no window and must not skew the collection.
          buffer.length = 0;

          const timer = setTimeout(() => {
            waiters.delete(failFast);
            resolve(buffer.splice(0, buffer.length));
          }, windowMs);

          const failFast = (): void => {
            if (failure !== undefined) {
              clearTimeout(timer);
              waiters.delete(failFast);
              reject(failure);
            }
          };

          waiters.add(failFast);
          failFast();
        }),
      stop: async (): Promise<void> => {
        await subscription.terminate().catch(() => undefined);
      },
    };
  }

  /**
   * Calls an OPC UA method on its parent object and returns the call outcome.
   * A non-Good call status is raised as {@link OpcUaOperationError} carrying the
   * status code name, never returned silently.
   */
  public async callMethod(
    objectNodeId: string,
    methodNodeId: string,
    inputArguments: readonly OpcUaMethodArgument[] = [],
  ): Promise<OpcUaMethodCallResult> {
    const session = this.requireSession('call');

    const result = await session.call({
      objectId: objectNodeId,
      methodId: methodNodeId,
      inputArguments: inputArguments.map((argument) => ({
        dataType: writeDataTypes[argument.dataType],
        value: argument.value,
      })),
    });

    const statusCode = result.statusCode.toString();

    if (!result.statusCode.isGood()) {
      throw new OpcUaOperationError('call', `${methodNodeId} on ${objectNodeId}`, statusCode);
    }

    return {
      objectNodeId,
      methodNodeId,
      statusCode,
      isGood: true,
      outputArguments: (result.outputArguments ?? []).map((output) => output.value as unknown),
    };
  }

  /**
   * Collects every data-change notification for a node inside a bounded
   * observation window. The monitored item's initial-value notification is
   * discarded, so a node that does not change yields an empty array — this is
   * the helper for proving that something does NOT happen.
   */
  public async collectChanges(
    nodeId: string,
    windowMs: number,
    options?: OpcUaMonitorOptions,
  ): Promise<OpcUaDataChange[]> {
    const { subscription, monitoredItem } = await this.startMonitoring(nodeId, options);
    const changes: OpcUaDataChange[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        let initialNotificationSeen = false;

        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, windowMs);

        const handleChanged = (dataValue: DataValue): void => {
          if (!initialNotificationSeen) {
            initialNotificationSeen = true;
            return;
          }

          changes.push(this.createDataChange(nodeId, dataValue));
        };

        const handleError = (error: unknown): void => {
          cleanup();
          reject(toError(error));
        };

        const handleTerminated = (): void => {
          cleanup();
          reject(new OpcUaSubscriptionTerminatedError(nodeId));
        };

        const cleanup = (): void => {
          clearTimeout(timer);
          monitoredItem.removeListener('changed', handleChanged);
          monitoredItem.removeListener('err', handleError);
          subscription.removeListener('terminated', handleTerminated);
        };

        monitoredItem.on('changed', handleChanged);
        monitoredItem.once('err', handleError);
        subscription.once('terminated', handleTerminated);
      });
    } finally {
      await subscription.terminate().catch(() => undefined);
    }

    return changes;
  }

  /**
   * Collects a fixed number of consecutive data-change notifications for a node.
   * The monitored item's initial-value notification is discarded. Throws
   * {@link OpcUaSubscriptionTimeoutError} when the count is not reached in time.
   */
  public async collectNotifications(
    nodeId: string,
    count: number,
    timeoutMs: number,
    options?: OpcUaMonitorOptions,
  ): Promise<OpcUaDataChange[]> {
    const { subscription, monitoredItem } = await this.startMonitoring(nodeId, options);
    const notifications: OpcUaDataChange[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        let initialNotificationSeen = false;

        const timer = setTimeout(() => {
          cleanup();
          reject(new OpcUaSubscriptionTimeoutError(nodeId, timeoutMs));
        }, timeoutMs);

        const handleChanged = (dataValue: DataValue): void => {
          if (!initialNotificationSeen) {
            initialNotificationSeen = true;
            return;
          }

          notifications.push(this.createDataChange(nodeId, dataValue));

          if (notifications.length >= count) {
            cleanup();
            resolve();
          }
        };

        const handleError = (error: unknown): void => {
          cleanup();
          reject(toError(error));
        };

        const handleTerminated = (): void => {
          cleanup();
          reject(new OpcUaSubscriptionTerminatedError(nodeId));
        };

        const cleanup = (): void => {
          clearTimeout(timer);
          monitoredItem.removeListener('changed', handleChanged);
          monitoredItem.removeListener('err', handleError);
          subscription.removeListener('terminated', handleTerminated);
        };

        monitoredItem.on('changed', handleChanged);
        monitoredItem.once('err', handleError);
        subscription.once('terminated', handleTerminated);
      });
    } finally {
      await subscription.terminate().catch(() => undefined);
    }

    return notifications;
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

  private async startMonitoring(
    nodeId: string,
    options?: OpcUaMonitorOptions,
  ): Promise<{
    subscription: ClientSubscription;
    monitoredItem: ClientMonitoredItemBase;
  }> {
    const session = this.requireSession('monitor');

    const subscription = await session.createSubscription2({
      requestedPublishingInterval: options?.publishingIntervalMs ?? 100,
      requestedLifetimeCount: 600,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100,
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
        samplingInterval: options?.samplingIntervalMs ?? 50,
        discardOldest: true,
        queueSize: options?.queueSize ?? 100,
        ...(options?.deadbandAbsolute === undefined
          ? {}
          : {
              filter: new DataChangeFilter({
                trigger: DataChangeTrigger.StatusValue,
                deadbandType: DeadbandType.Absolute,
                deadbandValue: options.deadbandAbsolute,
              }),
            }),
      },
      TimestampsToReturn.Both,
      MonitoringMode.Reporting,
    );

    // node-opcua resolves monitor() even when the per-item creation result is
    // Bad (the item just emits 'err'/'terminated' before the promise settles),
    // so the status must be checked here or a failed item would silently
    // deliver nothing for the whole collection window.
    if (!monitoredItem.statusCode.isGood()) {
      const creationStatusCode = monitoredItem.statusCode.toString();

      await subscription.terminate().catch(() => undefined);

      throw new OpcUaOperationError('monitor', nodeId, creationStatusCode);
    }

    return {
      subscription,
      monitoredItem,
    };
  }

  private createDataChange(nodeId: string, dataValue: DataValue): OpcUaDataChange {
    const statusCode = dataValue.statusCode.toString();
    // A server may omit the variant entirely on a Bad-quality value, so the
    // mapping must never dereference it unconditionally.
    const variant = dataValue.value as DataValue['value'] | null | undefined;
    const dataType =
      variant === null || variant === undefined
        ? 'Null'
        : (DataType[variant.dataType] ?? String(variant.dataType));

    return {
      nodeId,
      value: variant?.value as unknown,
      dataType,
      statusCode,
      isGood: dataValue.statusCode.isGood(),
      sourceTimestamp: dataValue.sourceTimestamp,
      serverTimestamp: dataValue.serverTimestamp,
      receivedAt: new Date(),
    };
  }

  private requireCertificateManager(security: OpcUaSecurityOptions): OPCUACertificateManager {
    this.certificateManager ??= new OPCUACertificateManager({
      rootFolder: security.pkiRootFolder,
      automaticallyAcceptUnknownCertificate: security.trustUnknownServerCertificate,
      // File watchers are unnecessary for short-lived test clients and would leak
      // five OS watch handles per OPCUACertificateManager instance.
      disableFileWatchers: true,
    });

    return this.certificateManager;
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
