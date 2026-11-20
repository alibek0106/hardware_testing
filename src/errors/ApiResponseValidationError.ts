export class ApiResponseValidationError extends Error {
  public constructor(
    message: string,
    public readonly responseBody: unknown,
  ) {
    super(message);
    this.name = 'ApiResponseValidationError';
  }
}
