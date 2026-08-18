import type { APIRequestContext, APIResponse } from '@playwright/test';
import { ApiRequestError } from '../errors/ApiRequestError';

export interface RawApiResult {
  readonly status: number;
  readonly body: unknown;
}

type RequestPayload = Record<string, unknown>;

export abstract class BaseApiClient {
  protected constructor(private readonly request: APIRequestContext) {}

  protected async get(path: string, expectedStatuses: readonly number[]): Promise<RawApiResult> {
    const response = await this.request.get(path, {
      failOnStatusCode: false,
    });

    return this.processResponse('GET', path, response, expectedStatuses);
  }

  protected async post(
    path: string,
    data: RequestPayload,
    expectedStatuses: readonly number[],
  ): Promise<RawApiResult> {
    const response = await this.request.post(path, {
      data,
      failOnStatusCode: false,
    });

    return this.processResponse('POST', path, response, expectedStatuses);
  }

  protected async put(
    path: string,
    data: RequestPayload,
    expectedStatuses: readonly number[],
  ): Promise<RawApiResult> {
    const response = await this.request.put(path, {
      data,
      failOnStatusCode: false,
    });

    return this.processResponse('PUT', path, response, expectedStatuses);
  }

  protected async patch(
    path: string,
    data: RequestPayload,
    expectedStatuses: readonly number[],
  ): Promise<RawApiResult> {
    const response = await this.request.patch(path, {
      data,
      failOnStatusCode: false,
    });

    return this.processResponse('PATCH', path, response, expectedStatuses);
  }

  protected async delete(path: string, expectedStatuses: readonly number[]): Promise<RawApiResult> {
    const response = await this.request.delete(path, {
      failOnStatusCode: false,
    });

    return this.processResponse('DELETE', path, response, expectedStatuses);
  }

  private async processResponse(
    method: string,
    path: string,
    response: APIResponse,
    expectedStatuses: readonly number[],
  ): Promise<RawApiResult> {
    const status = response.status();
    const body = await this.readResponseBody(response);

    if (!expectedStatuses.includes(status)) {
      throw new ApiRequestError(method, path, status, expectedStatuses, body);
    }

    return {
      status,
      body,
    };
  }

  private async readResponseBody(response: APIResponse): Promise<unknown> {
    const responseText = await response.text();

    if (responseText.length === 0) {
      return null;
    }

    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      return responseText;
    }
  }
}
