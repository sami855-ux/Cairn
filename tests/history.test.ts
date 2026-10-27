import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  formatHistory,
  readHistory,
  recordPush,
  type PushRecord,
} from '../src/history.js';

function makeTempFile(): { tmpDir: string; file: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-history-test-'));
  const file = path.join(tmpDir, 'history.jsonl');
  return {
    tmpDir,
    file,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe('history storage and reading', () => {
  it('returns empty array when file does not exist', async () => {
    const { file, cleanup } = makeTempFile();
    try {
      const records = await readHistory({}, file);
      expect(records).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('appends and reads records', async () => {
    const { file, cleanup } = makeTempFile();
    try {
      const record: PushRecord = {
        at: '2026-10-27T10:00:00.000Z',
        repo: '/home/sam/repos/my-project',
        remote: 'origin',
        branch: 'main',
        status: 'pushed',
        commits: 3,
        detail: '3 commit(s) to origin/main',
      };

      await recordPush(record, file);
      const records = await readHistory({}, file);
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual(record);
    } finally {
      cleanup();
    }
  });

  it('orders records newest first', async () => {
    const { file, cleanup } = makeTempFile();
    try {
      const r1: PushRecord = {
        at: '2026-10-27T08:00:00.000Z',
        repo: '/home/sam/repos/proj1',
        remote: 'origin',
        branch: 'main',
        status: 'pushed',
        commits: 1,
        detail: '1 commit',
      };
      const r2: PushRecord = {
        at: '2026-10-27T09:00:00.000Z',
        repo: '/home/sam/repos/proj2',
        remote: 'origin',
        branch: 'main',
        status: 'failed',
        commits: 0,
        detail: 'network error',
      };
      const r3: PushRecord = {
        at: '2026-10-27T10:00:00.000Z',
        repo: '/home/sam/repos/proj3',
        remote: 'origin',
        branch: 'main',
        status: 'deferred',
        commits: 0,
        detail: 'offline',
      };

      await recordPush(r1, file);
      await recordPush(r2, file);
      await recordPush(r3, file);

      const records = await readHistory({}, file);
      expect(records).toHaveLength(3);
      expect(records[0].repo).toBe('/home/sam/repos/proj3');
      expect(records[1].repo).toBe('/home/sam/repos/proj2');
      expect(records[2].repo).toBe('/home/sam/repos/proj1');
    } finally {
      cleanup();
    }
  });

  it('respects the limit option with default of 20', async () => {
    const { file, cleanup } = makeTempFile();
    try {
      for (let i = 1; i <= 25; i++) {
        await recordPush(
          {
            at: `2026-10-27T10:${String(i).padStart(2, '0')}:00.000Z`,
            repo: `/home/sam/repos/repo-${i}`,
            remote: 'origin',
            branch: 'main',
            status: 'pushed',
            commits: 1,
            detail: `commit ${i}`,
          },
          file,
        );
      }

      const defaultLimit = await readHistory({}, file);
      expect(defaultLimit).toHaveLength(20);
      expect(defaultLimit[0].repo).toBe('/home/sam/repos/repo-25');

      const customLimit = await readHistory({ limit: 5 }, file);
      expect(customLimit).toHaveLength(5);
      expect(customLimit[0].repo).toBe('/home/sam/repos/repo-25');
      expect(customLimit[4].repo).toBe('/home/sam/repos/repo-21');
    } finally {
      cleanup();
    }
  });

  it('filters by folder name using repo option', async () => {
    const { file, cleanup } = makeTempFile();
    try {
      await recordPush(
        {
          at: '2026-10-27T08:00:00.000Z',
          repo: '/home/sam/work/alpha',
          remote: 'origin',
          branch: 'main',
          status: 'pushed',
          commits: 1,
          detail: '1 commit',
        },
        file,
      );
      await recordPush(
        {
          at: '2026-10-27T09:00:00.000Z',
          repo: '/home/sam/work/beta',
          remote: 'origin',
          branch: 'main',
          status: 'failed',
          commits: 0,
          detail: 'failed',
        },
        file,
      );
      await recordPush(
        {
          at: '2026-10-27T10:00:00.000Z',
          repo: '/var/repos/alpha',
          remote: 'origin',
          branch: 'main',
          status: 'pushed',
          commits: 2,
          detail: '2 commits',
        },
        file,
      );

      const alphaRecords = await readHistory({ repo: 'alpha' }, file);
      expect(alphaRecords).toHaveLength(2);
      expect(alphaRecords[0].repo).toBe('/var/repos/alpha');
      expect(alphaRecords[1].repo).toBe('/home/sam/work/alpha');

      const betaRecords = await readHistory({ repo: 'beta' }, file);
      expect(betaRecords).toHaveLength(1);
      expect(betaRecords[0].repo).toBe('/home/sam/work/beta');

      const gammaRecords = await readHistory({ repo: 'gamma' }, file);
      expect(gammaRecords).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('skips malformed lines without throwing', async () => {
    const { file, cleanup } = makeTempFile();
    try {
      const valid1: PushRecord = {
        at: '2026-10-27T08:00:00.000Z',
        repo: '/home/sam/repos/proj1',
        remote: 'origin',
        branch: 'main',
        status: 'pushed',
        commits: 1,
        detail: 'ok',
      };
      const valid2: PushRecord = {
        at: '2026-10-27T10:00:00.000Z',
        repo: '/home/sam/repos/proj2',
        remote: 'origin',
        branch: 'main',
        status: 'pushed',
        commits: 2,
        detail: 'ok 2',
      };

      fs.writeFileSync(file, `${JSON.stringify(valid1)}\nnot valid json\n{"incomplete":true}\n${JSON.stringify(valid2)}\n`);

      const records = await readHistory({}, file);
      expect(records).toHaveLength(2);
      expect(records[0].repo).toBe('/home/sam/repos/proj2');
      expect(records[1].repo).toBe('/home/sam/repos/proj1');
    } finally {
      cleanup();
    }
  });

  it('trims file to most recent 2000 lines', async () => {
    const { file, cleanup } = makeTempFile();
    try {
      const existingLines: string[] = [];
      for (let i = 1; i <= 2005; i++) {
        existingLines.push(
          JSON.stringify({
            at: '2026-10-27T10:00:00.000Z',
            repo: `/home/sam/repos/r-${i}`,
            remote: 'origin',
            branch: 'main',
            status: 'pushed',
            commits: 1,
            detail: `detail ${i}`,
          }),
        );
      }
      fs.writeFileSync(file, `${existingLines.join('\n')}\n`);

      const newRecord: PushRecord = {
        at: '2026-10-27T11:00:00.000Z',
        repo: '/home/sam/repos/r-final',
        remote: 'origin',
        branch: 'main',
        status: 'pushed',
        commits: 1,
        detail: 'final',
      };

      await recordPush(newRecord, file);

      const lines = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(2000);

      const lastLine = JSON.parse(lines[lines.length - 1]);
      expect(lastLine.repo).toBe('/home/sam/repos/r-final');

      const firstLine = JSON.parse(lines[0]);
      expect(firstLine.repo).toBe('/home/sam/repos/r-7');
    } finally {
      cleanup();
    }
  });
});

describe('formatHistory', () => {
  it('returns exact message when records array is empty', () => {
    expect(formatHistory([])).toBe('No push history yet.');
  });

  it('formats records into a aligned table with dashed separator and no trailing whitespace', () => {
    const records: PushRecord[] = [
      {
        at: '2026-10-27T10:15:00.000Z',
        repo: '/home/sam/code/cairn',
        remote: 'origin',
        branch: 'main',
        status: 'pushed',
        commits: 4,
        detail: '4 commit(s) to origin/main',
      },
      {
        at: '2026-10-27T09:30:00.000Z',
        repo: '/home/sam/code/website',
        remote: 'upstream',
        branch: 'dev',
        status: 'failed',
        commits: 0,
        detail: 'connection timed out',
      },
    ];

    const output = formatHistory(records);
    const lines = output.split('\n');
    expect(lines).toHaveLength(4);

    expect(lines[0]).toMatch(/^WHEN\s+REPO\s+TARGET\s+STATUS\s+COMMITS\s+DETAIL$/);
    expect(lines[1]).toMatch(/^-+\s+-+\s+-+\s+-+\s+-+\s+-+$/);

    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }

    expect(lines[2]).toContain('cairn');
    expect(lines[2]).toContain('origin/main');
    expect(lines[2]).toContain('pushed');
    expect(lines[2]).toContain('4');
    expect(lines[2]).toContain('4 commit(s) to origin/main');

    expect(lines[3]).toContain('website');
    expect(lines[3]).toContain('upstream/dev');
    expect(lines[3]).toContain('failed');
    expect(lines[3]).toContain('0');
    expect(lines[3]).toContain('connection timed out');
  });
});

describe('history CLI command', () => {
  it('validates that limit is a positive integer', async () => {
    const { Command } = await import('commander');
    const { registerHistory } = await import('../src/history-command.js');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const p1 = new Command();
      registerHistory(p1);
      process.exitCode = 0;
      await p1.parseAsync(['node', 'cairn', 'history', '--limit', 'abc']);
      expect(errSpy).toHaveBeenCalledWith('error: --limit must be a positive integer');
      expect(process.exitCode).toBe(1);

      process.exitCode = 0;
      const p2 = new Command();
      registerHistory(p2);
      await p2.parseAsync(['node', 'cairn', 'history', '--limit', '-5']);
      expect(process.exitCode).toBe(1);

      process.exitCode = 0;
      const p3 = new Command();
      registerHistory(p3);
      await p3.parseAsync(['node', 'cairn', 'history', '--limit', '0']);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

