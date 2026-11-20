import { tankTestConfig } from '../config/tank-test.config';
import type { OpcUaClient } from './OpcUaClient';

export interface TankNodes {
  readonly namespaceIndex: number;
  readonly tankObject: string;
  readonly simulationObject: string;
  readonly level: string;
  readonly temperature: string;
  readonly temperatureSetpoint: string;
  readonly pumpRunning: string;
  readonly interlockTripped: string;
  readonly methods: {
    readonly startPump: string;
    readonly stopPump: string;
    readonly setLevel: string;
    readonly setSensorFault: string;
    readonly reset: string;
  };
}

/**
 * Builds the tank simulator's node ids by resolving the `urn:practice:tank`
 * namespace index from the server's namespace array at connect time — the
 * index is never hard-coded, so it may change between simulator versions
 * without breaking the tests.
 */
export const resolveTankNodes = async (client: OpcUaClient): Promise<TankNodes> => {
  const namespaceIndex = await client.resolveNamespaceIndex(tankTestConfig.namespaceUri);
  const id = (identifier: string): string => `ns=${namespaceIndex};s=${identifier}`;

  return {
    namespaceIndex,
    tankObject: id('Tank'),
    simulationObject: id('Simulation'),
    level: id('Level'),
    temperature: id('Temperature'),
    temperatureSetpoint: id('TemperatureSetpoint'),
    pumpRunning: id('PumpRunning'),
    interlockTripped: id('InterlockTripped'),
    methods: {
      startPump: id('StartPump'),
      stopPump: id('StopPump'),
      setLevel: id('SetLevel'),
      setSensorFault: id('SetSensorFault'),
      reset: id('Reset'),
    },
  };
};
