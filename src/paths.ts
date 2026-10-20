import os from 'node:os';
import path from 'node:path';

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'cairn');
}

export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'cairn');
}

export const defaultConfigPath = (): string => path.join(configDir(), 'config.json');
export const lockPath = (): string => path.join(stateDir(), 'run.lock');
export const cronLogPath = (): string => path.join(stateDir(), 'cron.log');

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveRepoPath(p: string): string {
  return path.resolve(expandHome(p));
}
