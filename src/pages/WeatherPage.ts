import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { formatTemperatureForUi, weatherTestConfig } from '../config/weather-test.config';
import { WeatherPayloadError } from '../errors/WeatherPayloadError';

type JsonRecord = Record<string, unknown>;

interface OneCallWeatherResponse extends JsonRecord {
  current: JsonRecord & {
    temp: number;
  };
  daily: unknown[];
}

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneCallWeatherResponse = (value: unknown): value is OneCallWeatherResponse => {
  if (!isJsonRecord(value)) {
    return false;
  }

  const current = value.current;
  const daily = value.daily;

  return (
    isJsonRecord(current) &&
    typeof current.temp === 'number' &&
    Number.isFinite(current.temp) &&
    Array.isArray(daily)
  );
};

const parseOneCallWeatherResponse = (value: unknown): OneCallWeatherResponse => {
  if (!isOneCallWeatherResponse(value)) {
    throw new WeatherPayloadError('The current-weather response has an unexpected structure');
  }

  return value;
};

export class WeatherPage {
  private readonly page: Page;
  private readonly searchInput: Locator;
  private readonly londonSearchResult: Locator;
  private readonly weatherHeading: Locator;
  private readonly cityName: Locator;
  private readonly currentWeatherCard: Locator;
  private readonly currentTemperatureValues: Locator;
  private readonly telemetryErrorHeading: Locator;
  private readonly telemetryErrorMessage: Locator;
  private readonly retryButton: Locator;

  private capturedBaselineTemperature: number | undefined;
  private interceptedTelemetryRequests = 0;

  public constructor(page: Page) {
    this.page = page;
    this.searchInput = page.getByPlaceholder('Search City');
    this.londonSearchResult = page
      .getByRole('button')
      .filter({
        hasText: /^London/,
      })
      .first();
    this.weatherHeading = page.getByRole('heading', {
      name: 'Weather forecast',
      exact: true,
    });
    this.cityName = page.getByText(weatherTestConfig.expectedCityName, {
      exact: true,
    });
    this.currentWeatherCard = page.locator('.weather-current-weather');
    this.currentTemperatureValues = this.currentWeatherCard.getByText(/^-?\d+°$/);
    this.telemetryErrorHeading = page.getByRole('heading', {
      name: 'Something went wrong',
      exact: true,
    });

    this.telemetryErrorMessage = page.getByText('Unable to load weather', {
      exact: true,
    });

    this.retryButton = page.getByRole('button', {
      name: 'Please try again',
      exact: true,
    });
  }

  public async captureBaselineTelemetry(): Promise<void> {
    this.resetInterceptionState();

    await this.routeCurrentWeather(async (route) => {
      const response = await route.fetch();

      if (!response.ok()) {
        throw new WeatherPayloadError(
          `The current-weather request returned status ${response.status()}`,
        );
      }

      const responseBody: unknown = await response.json();
      const weatherResponse = parseOneCallWeatherResponse(responseBody);

      this.capturedBaselineTemperature = weatherResponse.current.temp;

      await route.fulfill({
        response,
        json: weatherResponse,
      });
    });
  }

  public async mockOutOfRangeTemperature(temperature: number): Promise<void> {
    this.resetInterceptionState();

    await this.routeCurrentWeather(async (route) => {
      const response = await route.fetch();

      if (!response.ok()) {
        throw new WeatherPayloadError(
          `The current-weather request returned status ${response.status()}`,
        );
      }

      const responseBody: unknown = await response.json();
      const weatherResponse = parseOneCallWeatherResponse(responseBody);

      weatherResponse.current.temp = temperature;

      await route.fulfill({
        response,
        json: weatherResponse,
      });
    });
  }

  public async mockFailedTelemetry(status: number, responseBody: JsonRecord): Promise<void> {
    this.resetInterceptionState();

    await this.routeCurrentWeather(async (route) => {
      await route.fulfill({
        status,
        contentType: 'application/json',
        json: responseBody,
      });
    });
  }

  public async openHomePage(): Promise<void> {
    await this.page.goto(weatherTestConfig.startPath);

    await expect(this.weatherHeading).toBeVisible();
    await expect(this.searchInput).toBeVisible();
    await expect(this.searchInput).toBeEditable();
  }

  public async searchForLondon(): Promise<void> {
    await this.searchInput.fill(weatherTestConfig.cityQuery);
    await expect(this.londonSearchResult).toBeVisible();

    await this.londonSearchResult.click();

    await expect(this.page).toHaveURL(
      new RegExp(`${weatherTestConfig.expectedCityPath.replace(/\//g, '\\/')}(?:\\?.*)?$`),
    );
  }

  public async waitForTelemetryInterception(): Promise<void> {
    await expect
      .poll(() => this.interceptedTelemetryRequests, {
        message: 'The current-weather request was not intercepted',
      })
      .toBeGreaterThan(0);
  }

  public async getCapturedBaselineTemperature(): Promise<number> {
    await expect
      .poll(() => this.capturedBaselineTemperature, {
        message: 'The baseline temperature was not captured',
      })
      .toBeDefined();

    if (this.capturedBaselineTemperature === undefined) {
      throw new WeatherPayloadError('The baseline temperature was not captured');
    }

    return this.capturedBaselineTemperature;
  }

  public async expectTemperature(temperature: number): Promise<void> {
    const formattedTemperature = formatTemperatureForUi(temperature);

    await expect(
      this.currentWeatherCard.getByText(formattedTemperature, {
        exact: true,
      }),
    ).toBeVisible();
  }

  public async expectWeatherPageOperational(): Promise<void> {
    await expect(this.weatherHeading).toBeVisible();
    await expect(this.cityName).toBeVisible();
    await expect(this.searchInput).toBeVisible();
    await expect(this.searchInput).toBeEditable();
  }

  public async expectTelemetryErrorState(): Promise<void> {
    await expect(this.telemetryErrorHeading).toBeVisible();
    await expect(this.telemetryErrorMessage).toBeVisible();
    await expect(this.retryButton).toBeVisible();
    await expect(this.currentTemperatureValues).toHaveCount(0);
  }

  public async expectCurrentTemperatureUnavailable(): Promise<void> {
    await expect(this.currentWeatherCard).toBeVisible();
    await expect(this.currentTemperatureValues).toHaveCount(0);
  }

  private async routeCurrentWeather(handler: (route: Route) => Promise<void>): Promise<void> {
    await this.page.route(weatherTestConfig.currentWeatherRoute, async (route) => {
      if (!this.isCityTelemetryRequest(route)) {
        await route.continue();
        return;
      }

      this.interceptedTelemetryRequests += 1;
      await handler(route);
    });
  }

  private isCityTelemetryRequest(route: Route): boolean {
    const referer = route.request().headers().referer;

    if (referer === undefined) {
      return false;
    }

    try {
      return new URL(referer).pathname === weatherTestConfig.expectedCityPath;
    } catch {
      return false;
    }
  }

  private resetInterceptionState(): void {
    this.capturedBaselineTemperature = undefined;
    this.interceptedTelemetryRequests = 0;
  }
}
