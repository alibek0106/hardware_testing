import { expect, mergeTests } from '@playwright/test';
import { test as airQualityTest } from './air-quality.fixture';
import { test as apiTest } from './api.fixture';
import { test as opcUaTest } from './opcua.fixture';

export const test = mergeTests(airQualityTest, apiTest, opcUaTest);

export { expect };
