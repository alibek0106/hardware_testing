export class AirQualityPayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AirQualityPayloadError';
  }
}
