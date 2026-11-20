import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  DataType,
  DataValue,
  OPCUACertificateManager,
  OPCUAServer,
  StatusCodes,
  Variant,
} = require('node-opcua');

const PORT = Number(process.env.TANK_OPC_PORT ?? 4840);
const NAMESPACE_URI = 'urn:practice:tank';
// Keep the server PKI inside the repo (gitignored) instead of the default
// %APPDATA%\node-opcua-default-nodejs, which on locked-down/roaming corporate
// Windows profiles can make first-run certificate generation extremely slow.
const PKI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '.pki', 'server');

const TEMPERATURE_UPDATE_MS = 200;
const TEMPERATURE_RATE_PER_SECOND = 5;
const INTERLOCK_CHECK_MS = 100;
const INTERLOCK_LEVEL = 10;
const SETPOINT_MIN = 20;
const SETPOINT_MAX = 80;

const START_VALUES = {
  level: 50,
  temperature: 20,
  setpoint: 20,
};

const state = {
  level: START_VALUES.level,
  temperature: START_VALUES.temperature,
  setpoint: START_VALUES.setpoint,
  pumpRunning: false,
  interlockTripped: false,
  sensorFault: false,
  levelTimestamp: new Date(),
  temperatureTimestamp: new Date(),
};

/** Restores every start value, stops the pump and clears faults (test hook). */
const resetState = () => {
  state.level = START_VALUES.level;
  state.temperature = START_VALUES.temperature;
  state.setpoint = START_VALUES.setpoint;
  state.pumpRunning = false;
  state.interlockTripped = false;
  state.sensorFault = false;
  state.levelTimestamp = new Date();
  state.temperatureTimestamp = new Date();
};

const doubleDataValue = (value, statusCode, sourceTimestamp) =>
  new DataValue({
    value: new Variant({ dataType: DataType.Double, value }),
    statusCode,
    sourceTimestamp,
  });

const methodResult = (statusCode) => ({
  statusCode,
  outputArguments: [],
});

const serverCertificateManager = new OPCUACertificateManager({
  rootFolder: PKI_ROOT,
  automaticallyAcceptUnknownCertificate: true,
});

const server = new OPCUAServer({
  port: PORT,
  resourcePath: '',
  serverCertificateManager,
  buildInfo: {
    productName: 'TankSimulator',
    buildNumber: '1',
  },
});

const startedAt = Date.now();

await server.initialize();

const addressSpace = server.engine.addressSpace;
const namespace = addressSpace.registerNamespace(NAMESPACE_URI);

const tank = namespace.addObject({
  organizedBy: addressSpace.rootFolder.objects,
  browseName: 'Tank',
  nodeId: 's=Tank',
});

namespace.addVariable({
  componentOf: tank,
  browseName: 'Level',
  nodeId: 's=Level',
  dataType: 'Double',
  accessLevel: 'CurrentRead',
  userAccessLevel: 'CurrentRead',
  minimumSamplingInterval: 100,
  value: {
    timestamped_get: () =>
      doubleDataValue(
        state.level,
        state.sensorFault ? StatusCodes.BadSensorFailure : StatusCodes.Good,
        state.levelTimestamp,
      ),
  },
});

namespace.addVariable({
  componentOf: tank,
  browseName: 'Temperature',
  nodeId: 's=Temperature',
  dataType: 'Double',
  accessLevel: 'CurrentRead',
  userAccessLevel: 'CurrentRead',
  minimumSamplingInterval: 100,
  value: {
    timestamped_get: () =>
      doubleDataValue(state.temperature, StatusCodes.Good, state.temperatureTimestamp),
  },
});

namespace.addVariable({
  componentOf: tank,
  browseName: 'TemperatureSetpoint',
  nodeId: 's=TemperatureSetpoint',
  dataType: 'Double',
  accessLevel: 'CurrentRead | CurrentWrite',
  userAccessLevel: 'CurrentRead | CurrentWrite',
  minimumSamplingInterval: 100,
  value: {
    get: () => new Variant({ dataType: DataType.Double, value: state.setpoint }),
    // The range check lives HERE, in the device itself: the gateway and the
    // panel pass writes through untouched and only report the device's answer.
    set: (variant) => {
      if (variant.dataType !== DataType.Double || typeof variant.value !== 'number') {
        return StatusCodes.BadTypeMismatch;
      }

      if (variant.value < SETPOINT_MIN || variant.value > SETPOINT_MAX) {
        return StatusCodes.BadOutOfRange;
      }

      state.setpoint = variant.value;

      return StatusCodes.Good;
    },
  },
});

namespace.addVariable({
  componentOf: tank,
  browseName: 'PumpRunning',
  nodeId: 's=PumpRunning',
  dataType: 'Boolean',
  accessLevel: 'CurrentRead',
  userAccessLevel: 'CurrentRead',
  minimumSamplingInterval: 100,
  value: {
    get: () => new Variant({ dataType: DataType.Boolean, value: state.pumpRunning }),
  },
});

namespace.addVariable({
  componentOf: tank,
  browseName: 'InterlockTripped',
  nodeId: 's=InterlockTripped',
  dataType: 'Boolean',
  accessLevel: 'CurrentRead',
  userAccessLevel: 'CurrentRead',
  minimumSamplingInterval: 100,
  value: {
    get: () => new Variant({ dataType: DataType.Boolean, value: state.interlockTripped }),
  },
});

const startPump = namespace.addMethod(tank, {
  browseName: 'StartPump',
  nodeId: 's=StartPump',
  inputArguments: [],
  outputArguments: [],
});

startPump.bindMethod((inputArguments, context, callback) => {
  // Safety belongs to the device: starting is refused below the interlock
  // level no matter which path (OPC UA, gateway, panel) issued the command.
  if (state.level < INTERLOCK_LEVEL) {
    callback(null, methodResult(StatusCodes.BadInvalidState));
    return;
  }

  state.pumpRunning = true;
  state.interlockTripped = false;
  callback(null, methodResult(StatusCodes.Good));
});

const stopPump = namespace.addMethod(tank, {
  browseName: 'StopPump',
  nodeId: 's=StopPump',
  inputArguments: [],
  outputArguments: [],
});

stopPump.bindMethod((inputArguments, context, callback) => {
  state.pumpRunning = false;
  callback(null, methodResult(StatusCodes.Good));
});

const simulation = namespace.addObject({
  componentOf: tank,
  browseName: 'Simulation',
  nodeId: 's=Simulation',
});

const setLevel = namespace.addMethod(simulation, {
  browseName: 'SetLevel',
  nodeId: 's=SetLevel',
  inputArguments: [
    {
      name: 'value',
      description: 'New tank level in percent',
      dataType: DataType.Double,
    },
  ],
  outputArguments: [],
});

setLevel.bindMethod((inputArguments, context, callback) => {
  const value = inputArguments[0]?.value;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    callback(null, methodResult(StatusCodes.BadTypeMismatch));
    return;
  }

  state.level = value;
  state.levelTimestamp = new Date();
  callback(null, methodResult(StatusCodes.Good));
});

const setSensorFault = namespace.addMethod(simulation, {
  browseName: 'SetSensorFault',
  nodeId: 's=SetSensorFault',
  inputArguments: [
    {
      name: 'active',
      description: 'While true the level reports BadSensorFailure',
      dataType: DataType.Boolean,
    },
  ],
  outputArguments: [],
});

setSensorFault.bindMethod((inputArguments, context, callback) => {
  state.sensorFault = inputArguments[0]?.value === true;
  callback(null, methodResult(StatusCodes.Good));
});

const reset = namespace.addMethod(simulation, {
  browseName: 'Reset',
  nodeId: 's=Reset',
  inputArguments: [],
  outputArguments: [],
});

reset.bindMethod((inputArguments, context, callback) => {
  resetState();
  callback(null, methodResult(StatusCodes.Good));
});

// Temperature moves towards the setpoint at 5 degC per second in 200 ms steps.
setInterval(() => {
  const maxStep = TEMPERATURE_RATE_PER_SECOND * (TEMPERATURE_UPDATE_MS / 1000);
  const delta = state.setpoint - state.temperature;
  const step = Math.sign(delta) * Math.min(Math.abs(delta), maxStep);

  state.temperature += step;
  state.temperatureTimestamp = new Date();
}, TEMPERATURE_UPDATE_MS);

// Device-level interlock: while the pump runs, a level below 10 stops it
// within 500 ms (checked every 100 ms) and latches InterlockTripped.
setInterval(() => {
  if (state.pumpRunning && state.level < INTERLOCK_LEVEL) {
    state.pumpRunning = false;
    state.interlockTripped = true;
  }
}, INTERLOCK_CHECK_MS);

await server.start();

process.stdout.write(
  `Tank simulator listening at opc.tcp://localhost:${PORT} (${NAMESPACE_URI}) ` +
    `after ${Date.now() - startedAt} ms\n`,
);

const shutdown = async () => {
  await server.shutdown().catch(() => undefined);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
