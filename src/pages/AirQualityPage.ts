import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { airQualityTestConfig } from '../config/air-quality-test.config';
import { AirQualityPayloadError } from '../errors/AirQualityPayloadError';
import { parseAirQualityFeedResponse } from '../types/air-quality.types';

type RouteHandler = (route: Route) => Promise<void>;

export class AirQualityPage {
  private readonly searchTrigger: Locator;
  private readonly searchInput: Locator;
  private readonly searchResults: Locator;
  private readonly londonSearchResult: Locator;
  private readonly currentAqiValue: Locator;
  private readonly currentAqiTitle: Locator;
  private readonly currentAqiUpdatedTime: Locator;
  private readonly mainCityWidget: Locator;

  private interceptedTelemetryRequests = 0;
  private capturedBaselineAqi: number | undefined;

  public constructor(private readonly page: Page) {
    this.searchTrigger = page.locator('#city7');
    this.searchInput = page.locator('#citysearch-input');
    this.searchResults = page.locator('#citysearch-results');
    this.londonSearchResult = this.searchResults
      .locator('a')
      .filter({
        hasText: airQualityTestConfig.targetCitySearchResult,
      })
      .first();
    this.mainCityWidget = page.locator('#citydivmain');
    this.currentAqiValue = this.mainCityWidget.locator('#aqiwgtvalue');
    this.currentAqiTitle = this.mainCityWidget.locator('#aqiwgttitle1');
    this.currentAqiUpdatedTime = this.mainCityWidget.locator('#aqiwgtutime');
  }

  public async captureBaselineAqi(): Promise<void> {
    await this.resetTelemetryRoute();

    await this.routeCurrentAqi(async (route) => {
      const response = await route.fetch();

      if (!response.ok()) {
        throw new AirQualityPayloadError(`The AQI request returned status ${response.status()}`);
      }

      const payload: unknown = await response.json();
      const feedResponse = parseAirQualityFeedResponse(payload);
      const message = feedResponse.rxs.obs[0].msg;

      if (message.idx !== airQualityTestConfig.targetStationId) {
        throw new AirQualityPayloadError(
          `Expected station ${airQualityTestConfig.targetStationId} but received ${message.idx}`,
        );
      }

      this.capturedBaselineAqi = message.aqi;
      message.xsync.gen = Math.floor(Date.now() / 1000) + 300;

      await route.fulfill({
        response,
        json: feedResponse,
      });
    });
  }

  public async mockAqi(aqi: number): Promise<void> {
    await this.resetTelemetryRoute();

    await this.routeCurrentAqi(async (route) => {
      const response = await route.fetch();

      if (!response.ok()) {
        throw new AirQualityPayloadError(`The AQI request returned status ${response.status()}`);
      }

      const payload: unknown = await response.json();
      const feedResponse = parseAirQualityFeedResponse(payload);
      const message = feedResponse.rxs.obs[0].msg;

      if (message.idx !== airQualityTestConfig.targetStationId) {
        throw new AirQualityPayloadError(
          `Expected station ${airQualityTestConfig.targetStationId} but received ${message.idx}`,
        );
      }

      message.aqi = aqi;
      message.xsync.gen = Math.floor(Date.now() / 1000) + 300;

      await route.fulfill({
        response,
        json: feedResponse,
      });
    });
  }

  public async mockOutOfRangeAqi(aqi: number): Promise<void> {
    await this.mockAqi(aqi);
  }

  public async mockFailedTelemetry(status: number): Promise<void> {
    await this.resetTelemetryRoute();

    await this.routeCurrentAqi(async (route) => {
      await route.fulfill({
        status,
        contentType: 'application/json',
        json: {
          status: 'error',
        },
      });
    });
  }

  public async openInitialCityPage(): Promise<void> {
    await this.page.goto(airQualityTestConfig.initialCityPath);

    await expect(this.page).toHaveURL(new RegExp(`${airQualityTestConfig.initialCityPath}$`));

    await expect(this.currentAqiTitle).toContainText(
      new RegExp(`${airQualityTestConfig.initialCityName}.*AQI`, 'i'),
    );

    await expect(this.searchTrigger).toBeVisible();
  }

  public async searchForLondon(): Promise<void> {
    await this.revealSearch();

    await this.searchInput.fill('');
    await this.searchInput.pressSequentially(airQualityTestConfig.targetCityQuery);

    await expect(this.londonSearchResult).toBeVisible();

    await this.londonSearchResult.click();

    await expect(this.page).toHaveURL(new RegExp(`${airQualityTestConfig.targetCityPath}$`));

    await expect(this.currentAqiTitle).toContainText('London AQI');

    await expect
      .poll(() => this.interceptedTelemetryRequests, {
        message: 'The London AQI request was not intercepted',
      })
      .toBeGreaterThan(0);
  }

  public async getCapturedBaselineAqi(): Promise<number> {
    await expect
      .poll(() => this.capturedBaselineAqi, {
        message: 'The baseline London AQI was not captured',
      })
      .toBeDefined();

    if (this.capturedBaselineAqi === undefined) {
      throw new AirQualityPayloadError('The baseline London AQI was not captured');
    }

    return this.capturedBaselineAqi;
  }

  public async expectAqi(aqi: number): Promise<void> {
    await expect(this.currentAqiTitle).toContainText('London AQI');
    await expect(this.currentAqiValue).toHaveText(String(aqi));
  }

  public async expectAirQualityPageOperational(): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`${airQualityTestConfig.targetCityPath}$`));

    await expect(this.currentAqiTitle).toContainText('London AQI');
    await expect(this.currentAqiValue).toBeVisible();
    await expect(this.currentAqiUpdatedTime).toBeVisible();
    await expect(this.searchTrigger).toBeVisible();
  }

  public async expectLastKnownTelemetryState(): Promise<void> {
    await expect(this.currentAqiTitle).toContainText('London AQI');
    await expect(this.currentAqiValue).toBeVisible();
    await expect(this.currentAqiUpdatedTime).toBeVisible();
    await expect(this.currentAqiUpdatedTime).toContainText(/Updated|Last Update/i);
    await expect(this.searchTrigger).toBeVisible();
  }

  private async revealSearch(): Promise<void> {
    await this.searchTrigger.hover();

    await expect(this.searchInput).toBeVisible();
    await expect(this.searchInput).toBeEditable();
  }

  private async resetTelemetryRoute(): Promise<void> {
    await this.page.unroute(airQualityTestConfig.aqiRoute);

    this.interceptedTelemetryRequests = 0;
    this.capturedBaselineAqi = undefined;
  }

  private async routeCurrentAqi(handler: RouteHandler): Promise<void> {
    await this.page.route(airQualityTestConfig.aqiRoute, async (route) => {
      this.interceptedTelemetryRequests += 1;
      await handler(route);
    });
  }
}
