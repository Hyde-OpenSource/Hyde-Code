import type { Server } from 'node:net';

// One hub per port. The hub claims its port before it opens the event store, installs hooks or
// starts chat polling, so a second `hyde hub start` (two clients racing, or a stale terminal)
// exits with a clear message instead of an EADDRINUSE stack trace after doing half its startup.

export type PortClaim = { ok: true } | { ok: false; running: boolean; message: string };

/** Asks whatever listens on the port whether it is a Hyde hub. */
export async function probeHub(url: string, timeoutMs = 1500): Promise<{ version?: string; apiVersion?: number } | null> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return res.status === 503 ? {} : null; // 503: another hub that is still starting
    const body = (await res.json()) as { ok?: boolean; version?: string; apiVersion?: number };
    return body.ok ? { ...(body.version && { version: body.version }), ...(body.apiVersion !== undefined && { apiVersion: body.apiVersion }) } : null;
  } catch {
    return null;
  }
}

/** Starts listening, or explains who already holds the port. */
export async function claimPort(server: Server, port: number, hostname = '127.0.0.1'): Promise<PortClaim> {
  const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      resolve(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, hostname);
  });
  if (!error) return { ok: true };
  const url = `http://${hostname}:${port}`;
  if (error.code !== 'EADDRINUSE') return { ok: false, running: false, message: `Hyde Code hub could not listen on ${url}: ${error.message}` };
  const hub = await probeHub(url);
  if (hub) {
    return {
      ok: false,
      running: true,
      message: `Hyde Code hub is already running at ${url}${hub.version ? ` (version ${hub.version})` : ''}. Nothing to start. Use \`hyde hub status\`, \`hyde hub restart\` or \`hyde web\`.`,
    };
  }
  return {
    ok: false,
    running: false,
    message: `Port ${port} on ${hostname} is in use by another program, not a Hyde hub. Stop that program, or set "port" in the Hyde config and start again.`,
  };
}
