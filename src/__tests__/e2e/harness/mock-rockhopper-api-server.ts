import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { handleMockRockhopperRequest } from '../fixtures/rockhopper-api-fixtures.js';

export async function startMockRockhopperApiServer(): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer((req, res) => {
    handleMockRockhopperRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

export async function stopMockRockhopperApiServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
