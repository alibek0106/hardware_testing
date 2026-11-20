import { expect, type Locator, type Page } from '@playwright/test';
import { tankTestConfig } from '../config/tank-test.config';

const TANK_API_ROUTE = '**/api/tank';
const STALE_MARKER = '—';
const FAULT_MARKER = 'FAULT';

const formatPanelNumber = (value: number): string => value.toFixed(1);

export class OperatorPanelPage {
  private readonly page: Page;
  private readonly heading: Locator;
  private readonly levelValue: Locator;
  private readonly temperatureValue: Locator;
  private readonly setpointValue: Locator;
  private readonly pumpState: Locator;
  private readonly interlockState: Locator;
  private readonly startButton: Locator;
  private readonly stopButton: Locator;
  private readonly setpointInput: Locator;
  private readonly applyButton: Locator;
  private readonly messageArea: Locator;
  private readonly faultBanner: Locator;
  private readonly connectionBanner: Locator;

  public constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', {
      name: 'Tank Operator Panel',
      exact: true,
    });
    this.levelValue = page.locator('#level-value');
    this.temperatureValue = page.locator('#temperature-value');
    this.setpointValue = page.locator('#setpoint-value');
    this.pumpState = page.locator('#pump-state');
    this.interlockState = page.locator('#interlock-state');
    this.startButton = page.getByRole('button', { name: 'Start', exact: true });
    this.stopButton = page.getByRole('button', { name: 'Stop', exact: true });
    this.setpointInput = page.locator('#setpoint-input');
    this.applyButton = page.getByRole('button', { name: 'Apply', exact: true });
    this.messageArea = page.locator('#message-area');
    this.faultBanner = page.locator('#fault-banner');
    this.connectionBanner = page.locator('#connection-banner');
  }

  public async open(): Promise<void> {
    await this.page.goto('/');

    await expect(this.heading).toBeVisible();
  }

  public async clickStart(): Promise<void> {
    await this.startButton.click();
  }

  public async clickStop(): Promise<void> {
    await this.stopButton.click();
  }

  public async applySetpoint(value: number | string): Promise<void> {
    await this.setpointInput.fill(String(value));
    await this.applyButton.click();
  }

  public async expectPumpState(state: 'Running' | 'Stopped'): Promise<void> {
    await expect(this.pumpState).toHaveText(state, {
      timeout: tankTestConfig.panelReflectTimeoutMs,
    });
  }

  public async expectSetpoint(value: number): Promise<void> {
    await expect(this.setpointValue).toHaveText(formatPanelNumber(value), {
      timeout: tankTestConfig.panelReflectTimeoutMs,
    });
  }

  public async expectTemperatureNear(value: number, tolerance: number): Promise<void> {
    await expect
      .poll(
        async () => {
          const text = await this.temperatureValue.textContent();

          return Number.parseFloat(text ?? 'NaN');
        },
        {
          timeout: tankTestConfig.temperatureConvergenceTimeoutMs,
          message: `The displayed temperature did not converge on ${value} ± ${tolerance}`,
        },
      )
      .toBeGreaterThanOrEqual(value - tolerance);

    await expect
      .poll(async () => {
        const text = await this.temperatureValue.textContent();

        return Number.parseFloat(text ?? 'NaN');
      })
      .toBeLessThanOrEqual(value + tolerance);
  }

  public async expectRefusalMessage(statusCodeName: string): Promise<void> {
    await expect(this.messageArea).toContainText(statusCodeName);
  }

  public async expectOperationalTelemetry(): Promise<void> {
    await expect(this.faultBanner).toBeHidden({
      timeout: tankTestConfig.panelReflectTimeoutMs,
    });
    await expect(this.connectionBanner).toBeHidden();
    await expect(this.levelValue).not.toHaveText(FAULT_MARKER);
    await expect(this.levelValue).not.toHaveText(STALE_MARKER);
    await expect(this.temperatureValue).not.toHaveText(STALE_MARKER);
  }

  public async expectSensorFaultState(): Promise<void> {
    await expect(this.faultBanner).toBeVisible({
      timeout: tankTestConfig.panelReflectTimeoutMs,
    });
    await expect(this.levelValue).toHaveText(FAULT_MARKER);
    await expect(this.connectionBanner).toBeHidden();
  }

  public async expectConnectionLostState(): Promise<void> {
    await expect(this.connectionBanner).toBeVisible({
      timeout: tankTestConfig.panelReflectTimeoutMs,
    });
    await expect(this.levelValue).toHaveText(STALE_MARKER);
    await expect(this.temperatureValue).toHaveText(STALE_MARKER);
    await expect(this.pumpState).toHaveText(STALE_MARKER);
  }

  public async mockTankTelemetryFailure(status: number): Promise<void> {
    await this.page.route(TANK_API_ROUTE, async (route) => {
      await route.fulfill({
        status,
        contentType: 'application/json',
        json: { status: 'MockedFailure' },
      });
    });
  }

  public async mockTankTelemetryAborted(): Promise<void> {
    await this.page.route(TANK_API_ROUTE, async (route) => {
      await route.abort('connectionrefused');
    });
  }

  public async clearTankTelemetryMock(): Promise<void> {
    await this.page.unroute(TANK_API_ROUTE);
  }
}
