import { createConnection } from 'node:net';

const endpoint = new URL(process.env.OPC_UA_ENDPOINT ?? 'opc.tcp://localhost:50000');
const host = endpoint.hostname;
const port = Number(endpoint.port);
const deadline = Date.now() + 30_000;

const delay = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const canConnect = () =>
  new Promise((resolve) => {
    const socket = createConnection({
      host,
      port,
    });

    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });

let ready = false;

while (Date.now() < deadline && !ready) {
  ready = await canConnect();

  if (!ready) {
    await delay(500);
  }
}

if (!ready) {
  process.stderr.write(`OPC UA simulator did not become available at ${host}:${port}\n`);
  process.exitCode = 1;
}
