import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Handler = (req: IncomingMessage, res: ServerResponse, count: number) => unknown;

export interface TestServer {
  url: string;
  hits: number;
  close: () => Promise<void>;
}

/** Starts a local HTTP server; always `await server.close()` so no handles leak. */
export async function startServer(handler: Handler): Promise<TestServer> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits++;
    Promise.resolve(handler(req, res, hits)).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get hits() {
      return hits;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves a URL string to a port that nothing listens on. */
export async function closedPortUrl(): Promise<string> {
  const server = await startServer(() => {});
  const url = server.url;
  await server.close();
  return url;
}
