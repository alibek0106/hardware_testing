import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  AttributeIds,
  DataType,
  MessageSecurityMode,
  OPCUAClient,
  SecurityPolicy,
  Variant,
} = require('node-opcua');

const GATEWAY_PORT = Number(process.env.TANK_GATEWAY_PORT ?? 3000);
const OPC_ENDPOINT = process.env.TANK_OPC_UA_ENDPOINT ?? 'opc.tcp://localhost:4840';
const NAMESPACE_URI = 'urn:practice:tank';
const NAMESPACE_ARRAY_NODE_ID = 'ns=0;i=2255';
const CONNECT_RETRY_MS = 500;
const CONNECT_DEADLINE_MS = 30_000;

const panelPath = join(dirname(fileURLToPath(import.meta.url)), 'operator-panel.html');

let session;
let tankNamespaceIndex;

const nodeId = (name) => `ns=${tankNamespaceIndex};s=${name}`;

const connectToSimulator = async () => {
  const deadline = Date.now() + CONNECT_DEADLINE_MS;

  for (;;) {
    const client = OPCUAClient.create({
      applicationName: 'TankGateway',
      endpointMustExist: false,
      connectionStrategy: { initialDelay: 100, maxDelay: 1_000, maxRetry: 10 },
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
    });

    try {
      await client.connect(OPC_ENDPOINT);
      session = await client.createSession();

      const namespaceArray = await session.read({
        nodeId: NAMESPACE_ARRAY_NODE_ID,
        attributeId: AttributeIds.Value,
      });

      tankNamespaceIndex = namespaceArray.value.value.indexOf(NAMESPACE_URI);

      if (tankNamespaceIndex < 0) {
        throw new Error(`Namespace ${NAMESPACE_URI} not found on ${OPC_ENDPOINT}`);
      }

      return;
    } catch (error) {
      await client.disconnect().catch(() => undefined);

      if (Date.now() > deadline) {
        throw error;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, CONNECT_RETRY_MS);
      });
    }
  }
};

const readTank = async () => {
  const [level, temperature, setpoint, pumpRunning, interlockTripped] = await session.read(
    ['Level', 'Temperature', 'TemperatureSetpoint', 'PumpRunning', 'InterlockTripped'].map(
      (name) => ({
        nodeId: nodeId(name),
        attributeId: AttributeIds.Value,
      }),
    ),
  );

  // The gateway reports what the device answered — including the level's
  // quality — and never interprets or filters it.
  return {
    level: level.value?.value ?? null,
    levelQuality: level.statusCode.name,
    temperature: temperature.value?.value ?? null,
    setpoint: setpoint.value?.value ?? null,
    pumpRunning: pumpRunning.value?.value === true,
    interlockTripped: interlockTripped.value?.value === true,
  };
};

const callTankMethod = async (objectName, methodName, inputArguments = []) => {
  const result = await session.call({
    objectId: nodeId(objectName),
    methodId: nodeId(methodName),
    inputArguments,
  });

  return result.statusCode.name;
};

const writeSetpoint = async (value) => {
  // Pass-through on purpose: a non-numeric value is forwarded as-is so the
  // DEVICE is the one that rejects it, not the gateway.
  const variant =
    typeof value === 'number'
      ? new Variant({ dataType: DataType.Double, value })
      : new Variant({ dataType: DataType.String, value: String(value) });

  const statusCode = await session.write({
    nodeId: nodeId('TemperatureSetpoint'),
    attributeId: AttributeIds.Value,
    value: { value: variant },
  });

  return statusCode.name;
};

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

const sendJson = (response, statusCode, body) => {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

const httpServer = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/healthz') {
      sendJson(response, session === undefined ? 503 : 200, { ready: session !== undefined });
      return;
    }

    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(await readFile(panelPath, 'utf8'));
      return;
    }

    if (request.method === 'GET' && request.url === '/api/tank') {
      sendJson(response, 200, await readTank());
      return;
    }

    if (request.method === 'POST' && request.url === '/api/pump') {
      const body = JSON.parse(await readBody(request));

      if (body.action !== 'start' && body.action !== 'stop') {
        sendJson(response, 400, { status: 'UnknownAction' });
        return;
      }

      const status = await callTankMethod(
        'Tank',
        body.action === 'start' ? 'StartPump' : 'StopPump',
      );

      sendJson(response, status === 'Good' ? 200 : 409, { status });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/setpoint') {
      const body = JSON.parse(await readBody(request));
      const status = await writeSetpoint(body.value);

      sendJson(response, status === 'Good' ? 200 : 409, { status });
      return;
    }

    sendJson(response, 404, { status: 'NotFound' });
  } catch (error) {
    sendJson(response, 503, { status: 'GatewayError', message: String(error) });
  }
});

await connectToSimulator();

httpServer.listen(GATEWAY_PORT, () => {
  process.stdout.write(
    `Tank gateway listening at http://localhost:${GATEWAY_PORT} (device ${OPC_ENDPOINT})\n`,
  );
});
