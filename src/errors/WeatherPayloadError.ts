export class WeatherPayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WeatherPayloadError';
  }
}
