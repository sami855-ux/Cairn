import net from 'node:net';

const PROBE_TIMEOUT_MS = 3000;

/**
 * Parse a git remote URL and return { host, port } for a TCP reachability probe.
 * Supports:
 *   https://github.com/user/repo.git
 *   ssh://git@github.com/user/repo.git
 *   git@github.com:user/repo.git  (SCP-like)
 *   git://github.com/user/repo.git
 */
export function parseRemoteHost(url: string): { host: string; port: number } | null {
  // SCP-like: git@github.com:user/repo.git
  const scpMatch = /^(?:[^@]+@)?([^:/]+):/.exec(url);

  // Try standard URL parse first (handles https://, ssh://, git://)
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (!host) throw new Error('no hostname');
    let port = parsed.port ? Number(parsed.port) : 0;
    if (!port) {
      if (parsed.protocol === 'https:') port = 443;
      else if (parsed.protocol === 'http:') port = 80;
      else port = 22; // ssh:// or git://
    }
    return { host, port };
  } catch {
    // Fall back to SCP-like
    if (scpMatch) return { host: scpMatch[1], port: 22 };
    return null;
  }
}

/** Returns true if a TCP connection to host:port succeeds within the probe timeout. */
export function isReachable(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** Probe a git remote URL. Returns true when the host is reachable, false when offline or URL can't be parsed. */
export async function isRemoteReachable(remoteUrl: string): Promise<boolean> {
  const parsed = parseRemoteHost(remoteUrl);
  if (!parsed) return true;
  return isReachable(parsed.host, parsed.port);
}
