import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearWeeklyLogs } from '../src/log-cleanup.js';

describe('weekly log cleanup', () => {
  it('clears only logs at seven days and preserves files opened by cron', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-log-test-'));
    const start = new Date('2026-10-01T00:00:00Z');
    const cron = path.join(dir, 'cron.log');
    try {
      await clearWeeklyLogs(dir, start);
      await fs.writeFile(cron, 'old log\n');
      await fs.writeFile(path.join(dir, 'history.jsonl'), 'old history\n');
      await fs.writeFile(path.join(dir, 'state.json'), '{"pending":["abc"]}');
      await clearWeeklyLogs(dir, new Date('2026-10-07T23:59:59Z'));
      expect(await fs.readFile(cron, 'utf8')).toBe('old log\n');
      const handle = await fs.open(cron, 'a');
      try {
        await clearWeeklyLogs(dir, new Date('2026-10-08T00:00:00Z'));
        expect(await fs.readFile(cron, 'utf8')).toBe('');
        expect(await fs.readFile(path.join(dir, 'history.jsonl'), 'utf8')).toBe('');
        await handle.write('new log\n');
      } finally { await handle.close(); }
      await clearWeeklyLogs(dir, new Date('2026-10-08T00:15:00Z'));
      expect(await fs.readFile(cron, 'utf8')).toBe('new log\n');
      expect(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).toBe('{"pending":["abc"]}');
      await clearWeeklyLogs(dir, new Date('2026-11-01T00:00:00Z'));
      expect(await fs.readFile(cron, 'utf8')).toBe('');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('handles missing logs and a damaged cleanup marker', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-log-test-'));
    try {
      await fs.writeFile(path.join(dir, 'log-cleanup.json'), 'null');
      await clearWeeklyLogs(dir, new Date('2026-10-01T00:00:00Z'));
      const marker = JSON.parse(await fs.readFile(path.join(dir, 'log-cleanup.json'), 'utf8'));
      expect(marker.lastCleared).toBe('2026-10-01T00:00:00.000Z');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
