import { test as base } from '@playwright/test';
import { WeatherPage } from '../../src/pages/WeatherPage';

interface WeatherFixtures {
  weatherPage: WeatherPage;
}

export const test = base.extend<WeatherFixtures>({
  weatherPage: async ({ page }, use) => {
    await use(new WeatherPage(page));
  },
});
