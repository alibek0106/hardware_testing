import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { opcUaTestConfig } from '../../src/config/opcua-test.config';
import { OpcUaCertificateTrustError } from '../../src/errors/OpcUaClientError';
import { OpcUaClient } from '../../src/opcua/OpcUaClient';
import { expect, test } from '../fixtures/opcua.fixture';

test.describe('OPC UA security and certificates', () => {
  test('connects without security as a baseline (securityMode None)', async ({ opcUaClient }) => {
    await opcUaClient.connect();

    expect(opcUaClient.connectionState).toBe('connected');

    const serverTime = await opcUaClient.readNode(opcUaTestConfig.serverTimeNodeId);

    expect(serverTime.isGood).toBe(true);
    expect(serverTime.dataType).toBe('DateTime');

    await opcUaClient.disconnect();

    expect(opcUaClient.connectionState).toBe('disconnected');
  });

  test('connects with SignAndEncrypt once the server certificate is trusted', async ({}, testInfo) => {
    const secureClient = new OpcUaClient({
      endpoint: opcUaTestConfig.secureEndpoint,
      connectionTimeoutMs: opcUaTestConfig.secureConnectionTimeoutMs,
      security: {
        mode: 'SignAndEncrypt',
        policy: 'Basic256Sha256',
        pkiRootFolder: testInfo.outputPath('pki-trusting-client'),
        trustUnknownServerCertificate: true,
      },
    });

    try {
      await secureClient.connect();

      expect(secureClient.connectionState).toBe('connected');
      expect(secureClient.certificateFile).toBeDefined();

      await testInfo.attach('opc-ua-client-certificate-path', {
        body: Buffer.from(String(secureClient.certificateFile)),
        contentType: 'text/plain',
      });

      const serverTime = await secureClient.readNode(opcUaTestConfig.serverTimeNodeId);

      expect(serverTime.isGood).toBe(true);
      expect(serverTime.dataType).toBe('DateTime');
    } finally {
      await secureClient.disconnect();
    }

    expect(secureClient.connectionState).toBe('disconnected');
  });

  test('rejects SignAndEncrypt with a typed error when the server certificate is untrusted', async ({}, testInfo) => {
    const pkiRootFolder = testInfo.outputPath('pki-strict-client');
    const strictClient = new OpcUaClient({
      endpoint: opcUaTestConfig.secureEndpoint,
      connectionTimeoutMs: opcUaTestConfig.secureConnectionTimeoutMs,
      security: {
        mode: 'SignAndEncrypt',
        policy: 'Basic256Sha256',
        pkiRootFolder,
        trustUnknownServerCertificate: false,
      },
    });

    await expect(strictClient.connect()).rejects.toBeInstanceOf(OpcUaCertificateTrustError);

    expect(strictClient.connectionState).toBe('disconnected');

    const rejectedCertificates = await readdir(join(pkiRootFolder, 'rejected'));

    expect(rejectedCertificates.filter((fileName) => fileName.endsWith('.pem'))).toHaveLength(1);

    await expect(strictClient.disconnect()).resolves.toBeUndefined();
  });
});
