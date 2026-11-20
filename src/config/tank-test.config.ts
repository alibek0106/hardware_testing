export const tankTestConfig = {
  endpoint: process.env.TANK_OPC_UA_ENDPOINT ?? 'opc.tcp://localhost:4840',
  gatewayUrl: process.env.TANK_GATEWAY_URL ?? 'http://localhost:3000',
  namespaceUri: 'urn:practice:tank',
  connectionTimeoutMs: 5_000,
  setpointStart: 20,
  levelStart: 50,
  interlockLevel: 10,
  lowLevel: 5,
  temperatureTolerance: 0.5,
  controlSetpoint: 60,
  uiSetpoint: 45,
  outOfRangeSetpoint: 95,
  // Nominal control response for 20 -> 60 degC at 5 degC/s is 8 s; the margin
  // absorbs the 200 ms update quantisation plus scheduling latency.
  controlResponseTimeoutMs: 12_000,
  controlHoldWindowMs: 2_000,
  // The device interlock acts within 500 ms; the margin covers the 100 ms
  // check grid plus client read latency.
  interlockPollTimeoutMs: 1_500,
  pumpReadBackTimeoutMs: 5_000,
  // The panel polls the gateway once per second, so UI reflections need a
  // couple of poll cycles.
  panelReflectTimeoutMs: 10_000,
  temperatureConvergenceTimeoutMs: 12_000,
  boundarySetpointWrites: [
    { value: 19.9, accepted: false },
    { value: 20, accepted: true },
    { value: 80, accepted: true },
    { value: 80.1, accepted: false },
  ],
} as const;
