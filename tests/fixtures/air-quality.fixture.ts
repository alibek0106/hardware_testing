import { test as base } from '@playwright/test';
import { AirQualityPage } from '../../src/pages/AirQualityPage';

interface AirQualityFixtures {
  readonly airQualityPage: AirQualityPage;
}

export const test = base.extend<AirQualityFixtures>({
  airQualityPage: async ({ page }, use) => {
    await use(new AirQualityPage(page));
  },
});

export { expect } from '@playwright/test';
