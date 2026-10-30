import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MessageSecurityMode, OPCUAClient, SecurityPolicy } = require('node-opcua');

const endpoints = [
  process.env.OPC_UA_ENDPOINT ?? 'opc.tcp://localhost:50000',
  process.env.OPC_UA_SECURE_ENDPOINT ?? 'opc.tcp://localhost:50001',
];
const deadline = Date.now() + 90_000;

const delay = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

// A raw TCP probe is not enough: Docker's userland proxy accepts connections on the
// published port before the OPC UA stack inside the container is actually serving.
// GetEndpoints over an unsecured discovery channel proves the server is ready, and
// works against the security-enabled simulator too (discovery is always plain).
const canConnect = async (endpointUrl) => {
  const client = OPCUAClient.create({
    applicationName: 'OpcUaReadinessProbe',
    connectionStrategy: {
      initialDelay: 100,
      maxDelay: 100,
      maxRetry: 0,
      randomisationFactor: 0,
    },
    transportTimeout: 2_000,
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
  });

  try {
    await client.connect(endpointUrl);
    await client.getEndpoints();
    return true;
  } catch {
    return false;
  } finally {
    await client.disconnect().catch(() => undefined);
  }
};

for (const endpointUrl of endpoints) {
  let ready = await canConnect(endpointUrl);

  while (!ready && Date.now() < deadline) {
    await delay(500);
    ready = await canConnect(endpointUrl);
  }

  if (!ready) {
    process.stderr.write(`OPC UA simulator did not become available at ${endpointUrl}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`OPC UA simulator is ready at ${endpointUrl}\n`);
  }
}
