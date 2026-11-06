import { createServer, type Server } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { claimPort } from './listen.ts';

const open: Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function freePort(): Promise<number> {
  const s = createTcp();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('claimPort (EADDRINUSE on 7420, 2026-10-29)', () => {
  it('listens when the port is free', async () => {
    const port = await freePort();
    const server = createServer();
    open.push(server);
    expect(await claimPort(server, port)).toEqual({ ok: true });
  });

  it('says a hub is already running instead of throwing', async () => {
    const port = await freePort();
    const hub = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, version: '0.1.0', apiVersion: 2 })));
    open.push(hub);
    await new Promise<void>((r) => hub.listen(port, '127.0.0.1', r));
    const second = createServer();
    const claim = await claimPort(second, port);
    expect(claim).toEqual({ ok: false, running: true, message: expect.stringContaining(`Hyde Code hub is already running at http://127.0.0.1:${port} (version 0.1.0)`) });
  });

  it('counts a hub that is still starting (503) as running', async () => {
    const port = await freePort();
    const starting = createServer((_req, res) => res.writeHead(503).end('starting'));
    open.push(starting);
    await new Promise<void>((r) => starting.listen(port, '127.0.0.1', r));
    expect(await claimPort(createServer(), port)).toMatchObject({ ok: false, running: true });
  });

  it('names another program on the port', async () => {
    const port = await freePort();
    const other = createServer((_req, res) => res.writeHead(404).end());
    open.push(other);
    await new Promise<void>((r) => other.listen(port, '127.0.0.1', r));
    expect(await claimPort(createServer(), port)).toMatchObject({ ok: false, running: false, message: expect.stringContaining('in use by another program') });
  });
});
