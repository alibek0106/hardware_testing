export class ApiRequestError extends Error {
  public constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly expectedStatuses: readonly number[],
    public readonly responseBody: unknown,
  ) {
    super(`${method} ${path} returned status ${status}; expected ${expectedStatuses.join(', ')}`);
    this.name = 'ApiRequestError';
  }
}
