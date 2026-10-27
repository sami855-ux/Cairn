import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './paths.js';

export class LockHeldError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(`cairn is already running (pid ${pid}) — another run is in progress`);
    this.name = 'LockHeldError';
    this.pid = pid;
  }
}

interface LockData {
  pid: number;
  startedAt: string;
}

const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockFile(): string {
  return path.join(stateDir(), 'cairn.lock');
}

async function readLockData(file: string): Promise<LockData | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'pid' in parsed &&
      'startedAt' in parsed &&
      typeof (parsed as Record<string, unknown>).pid === 'number' &&
      typeof (parsed as Record<string, unknown>).startedAt === 'string'
    ) {
      return parsed as LockData;
    }
    return null;
  } catch {
    return null;
  }
}

function isStale(data: LockData): boolean {
  const age = Date.now() - new Date(data.startedAt).getTime();
  return !alive(data.pid) || age > LOCK_TTL_MS || Number.isNaN(age);
}

async function tryWrite(file: string): Promise<boolean> {
  try {
    const handle = await fs.open(file, 'wx');
    const data: LockData = { pid: process.pid, startedAt: new Date().toISOString() };
    await handle.writeFile(JSON.stringify(data));
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function acquire(file: string, retry = true): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (await tryWrite(file)) return;

  const data = await readLockData(file);
  if (retry && (!data || isStale(data))) {
    await fs.rm(file, { force: true });
    return acquire(file, false);
  }

  throw new LockHeldError(data?.pid ?? 0);
}

export async function acquireLock(file = lockFile()): Promise<() => Promise<void>> {
  await acquire(file);

  const release = async (): Promise<void> => {
    const data = await readLockData(file);
    if (data?.pid === process.pid) {
      await fs.rm(file, { force: true });
    }
  };

  return release;
}

export async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(file);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function isLocked(file: string): Promise<boolean> {
  const data = await readLockData(file);
  if (!data) {
    const pid = Number(await fs.readFile(file, 'utf8').catch(() => ''));
    return pid > 0 && alive(pid);
  }
  return alive(data.pid);
}
