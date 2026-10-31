import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './paths.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Called while holding the run lock, including on otherwise idle daily runs.
export async function clearWeeklyLogs(dir = stateDir(), now = new Date()): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const marker = path.join(dir, 'log-cleanup.json');
  let lastCleared = NaN;
  try {
    const saved = JSON.parse(await fs.readFile(marker, 'utf8'));
    lastCleared = Date.parse(saved?.lastCleared);
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const files = ['cron.log', 'history.jsonl'].map((name) => path.join(dir, name));
  if (!Number.isFinite(lastCleared)) {
    // Existing installations start counting from the oldest log's creation.
    const created = await Promise.all(files.map(async (file) => {
      try { return (await fs.stat(file)).birthtimeMs; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return now.getTime();
        throw error;
      }
    }));
    lastCleared = Math.min(now.getTime(), ...created);
  }
  if (now.getTime() - lastCleared >= WEEK_MS) {
    for (const file of files) {
      // Keep the inode: cron may already have opened it for append redirection.
      try { await fs.truncate(file, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    lastCleared = now.getTime();
  }
  const temp = `${marker}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ lastCleared: new Date(lastCleared).toISOString() })}\n`);
  await fs.rename(temp, marker);
}
