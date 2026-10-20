import fs from 'node:fs/promises';
import path from 'node:path';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readPid(file: string): Promise<number> {
  return Number(await fs.readFile(file, 'utf8').catch(() => ''));
}

async function acquire(file: string, retry = true): Promise<void> {
  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = await readPid(file);
    if (retry && (!pid || !alive(pid))) {
      await fs.rm(file, { force: true });
      return acquire(file, false);
    }
    throw new Error(`another run is in progress (pid ${pid})`);
  }
}

export async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await acquire(file);
  try {
    return await fn();
  } finally {
    await fs.rm(file, { force: true });
  }
}

export async function isLocked(file: string): Promise<boolean> {
  const pid = await readPid(file);
  return pid > 0 && alive(pid);
}
