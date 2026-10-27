import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openGit } from '../src/scanner.js';
import { acquireLock, LockHeldError } from '../src/lock.js';
import { checkRepoReady } from '../src/guards.js';
import { pushBranch } from '../src/push.js';
import { runRepo } from '../src/repo-runner.js';
import { git, identify, makeRepo, write } from './helpers.js';

describe('Lock Safeguards', () => {
  it('rejects acquisition when a live process holds the lock', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-lock-test-'));
    const lockFile = path.join(tmp, 'cairn.lock');
    const release = await acquireLock(lockFile);

    try {
      await expect(acquireLock(lockFile)).rejects.toThrow(LockHeldError);
      try {
        await acquireLock(lockFile);
      } catch (error) {
        expect(error).toBeInstanceOf(LockHeldError);
        expect((error as LockHeldError).pid).toBe(process.pid);
        expect((error as LockHeldError).message).toContain(String(process.pid));
      }
    } finally {
      await release();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('recovers from a stale lock left by a dead process', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-lock-test-'));
    const lockFile = path.join(tmp, 'cairn.lock');
    const deadPid = 99999999;
    const staleData = { pid: deadPid, startedAt: new Date().toISOString() };
    fs.writeFileSync(lockFile, JSON.stringify(staleData));

    const release = await acquireLock(lockFile);
    try {
      const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      expect(content.pid).toBe(process.pid);
    } finally {
      await release();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('recovers from a stale lock older than 6 hours even if PID is alive', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-lock-test-'));
    const lockFile = path.join(tmp, 'cairn.lock');
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const staleData = { pid: process.pid, startedAt: sevenHoursAgo };
    fs.writeFileSync(lockFile, JSON.stringify(staleData));

    const release = await acquireLock(lockFile);
    try {
      const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      expect(content.pid).toBe(process.pid);
      expect(new Date(content.startedAt).getTime()).toBeGreaterThan(Date.now() - 5000);
    } finally {
      await release();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('only releases the lock if it still belongs to this process', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-lock-test-'));
    const lockFile = path.join(tmp, 'cairn.lock');
    const release = await acquireLock(lockFile);

    fs.writeFileSync(lockFile, JSON.stringify({ pid: 1234567, startedAt: new Date().toISOString() }));
    await release();
    expect(fs.existsSync(lockFile)).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('Repository Guards', () => {
  it('reports not ok when directory is not inside a git work tree', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-guard-'));
    try {
      const simpleGit = openGit(tmp);
      const result = await checkRepoReady(simpleGit, tmp, 'main');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('not inside a git work tree');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports not ok when HEAD is detached', async () => {
    const { dir, root } = makeRepo();
    try {
      const head = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'checkout', '--detach', head);
      const simpleGit = openGit(dir);
      const result = await checkRepoReady(simpleGit, dir, 'main');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('HEAD is detached');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports not ok when current branch does not match expected branch', async () => {
    const { dir, root } = makeRepo();
    try {
      git(dir, 'checkout', '-b', 'feature');
      const simpleGit = openGit(dir);
      const result = await checkRepoReady(simpleGit, dir, 'main');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('does not match expected "main"');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports not ok when a merge is in progress', async () => {
    const { dir, root } = makeRepo();
    try {
      const gitDir = git(dir, 'rev-parse', '--git-dir');
      const target = path.isAbsolute(gitDir) ? gitDir : path.join(dir, gitDir);
      fs.writeFileSync(path.join(target, 'MERGE_HEAD'), 'abc\n');
      const simpleGit = openGit(dir);
      const result = await checkRepoReady(simpleGit, dir, 'main');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('merge in progress');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports not ok when a rebase is in progress', async () => {
    const { dir, root } = makeRepo();
    try {
      const gitDir = git(dir, 'rev-parse', '--git-dir');
      const target = path.isAbsolute(gitDir) ? gitDir : path.join(dir, gitDir);

      fs.mkdirSync(path.join(target, 'rebase-merge'));
      const simpleGit = openGit(dir);
      let result = await checkRepoReady(simpleGit, dir, 'main');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('rebase in progress');

      fs.rmdirSync(path.join(target, 'rebase-merge'));
      fs.mkdirSync(path.join(target, 'rebase-apply'));
      result = await checkRepoReady(simpleGit, dir, 'main');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('rebase in progress');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports not ok when a cherry-pick or revert is in progress', async () => {
    const { dir, root } = makeRepo();
    try {
      const gitDir = git(dir, 'rev-parse', '--git-dir');
      const target = path.isAbsolute(gitDir) ? gitDir : path.join(dir, gitDir);

      fs.writeFileSync(path.join(target, 'CHERRY_PICK_HEAD'), 'abc\n');
      const simpleGit = openGit(dir);
      let result = await checkRepoReady(simpleGit, dir, 'main');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('cherry-pick in progress');

      fs.unlinkSync(path.join(target, 'CHERRY_PICK_HEAD'));
      fs.writeFileSync(path.join(target, 'REVERT_HEAD'), 'abc\n');
      result = await checkRepoReady(simpleGit, dir, 'main');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('revert in progress');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports ok when repository is healthy and matches expected branch', async () => {
    const { dir, root } = makeRepo();
    try {
      const simpleGit = openGit(dir);
      const result = await checkRepoReady(simpleGit, dir, 'main');
      expect(result).toEqual({ ok: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Push Blocked and autoPull Safeguards', () => {
  it('returns blocked status with commit count, remote, and branch names when behind', async () => {
    const { dir, root, remote } = makeRepo();
    try {
      const other = path.join(root, 'other');
      git(root, 'clone', '-q', remote, other);
      identify(other);
      write(other, 'file.txt', 'remote change\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-m', 'remote commit');
      git(other, 'push', '-q', 'origin', 'main');

      const simpleGit = openGit(dir);
      const outcome = await pushBranch(simpleGit, 'origin', 'main', undefined, false);
      expect(outcome.status).toBe('blocked');
      expect(outcome.detail).toContain('1 commit(s)');
      expect(outcome.detail).toContain('origin/main');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('autoPull fast-forwards and retries push comparison when working tree is clean', async () => {
    const { dir, root, remote } = makeRepo();
    try {
      const other = path.join(root, 'other');
      git(root, 'clone', '-q', remote, other);
      identify(other);
      write(other, 'file.txt', 'remote change\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-m', 'remote commit');
      git(other, 'push', '-q', 'origin', 'main');

      const simpleGit = openGit(dir);
      const outcome = await pushBranch(simpleGit, 'origin', 'main', undefined, true);
      expect(outcome.status).toBe('skipped');
      expect(outcome.detail).toBe('nothing to push');
      expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('autoPull returns blocked when fast-forward is not possible', async () => {
    const { dir, root, remote } = makeRepo();
    try {
      const other = path.join(root, 'other');
      git(root, 'clone', '-q', remote, other);
      identify(other);
      write(other, 'conflict.txt', 'remote conflicting\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-m', 'remote conflict');
      git(other, 'push', '-q', 'origin', 'main');

      write(dir, 'conflict.txt', 'local conflicting\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'local conflict');

      const simpleGit = openGit(dir);
      const outcome = await pushBranch(simpleGit, 'origin', 'main', undefined, true);
      expect(outcome.status).toBe('blocked');
      expect(outcome.detail).toContain('pull --ff-only failed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runRepo Integration', () => {
  it('returns skippedReason when checkRepoReady fails and makes no changes', async () => {
    const { dir, root } = makeRepo();
    try {
      git(dir, 'checkout', '-b', 'other-branch');
      const simpleGit = openGit(dir);
      const result = await runRepo(
        simpleGit,
        [{ path: 'test.txt', kind: 'added', staged: false, needsAdd: true }],
        {
          repoKey: dir,
          remote: 'origin',
          branch: 'main',
          template: 'chore: update',
          mode: 'file',
          maxCommitsPerRun: 5,
          includePending: false,
          apply: true,
          skipWhenOffline: false,
        },
      );

      expect(result.skippedReason).toBeDefined();
      expect(result.committed).toEqual([]);
      expect(result.planned).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps pending commits and prints warning when push outcome is blocked', async () => {
    const { dir, root, remote } = makeRepo();
    try {
      const other = path.join(root, 'other');
      git(root, 'clone', '-q', remote, other);
      identify(other);
      write(other, 'remote.txt', 'remote change\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-m', 'remote commit');
      git(other, 'push', '-q', 'origin', 'main');

      write(dir, 'a.txt', 'change a\n');
      const simpleGit = openGit(dir);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await runRepo(
        simpleGit,
        [{ path: 'a.txt', kind: 'added', staged: false, needsAdd: true }],
        {
          repoKey: dir,
          remote: 'origin',
          branch: 'main',
          template: 'chore: update {file}',
          mode: 'file',
          maxCommitsPerRun: 5,
          includePending: false,
          apply: true,
          skipWhenOffline: false,
        },
      );

      expect(result.push?.status).toBe('blocked');
      expect(result.committed).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('is blocked'));
      warnSpy.mockRestore();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not write or commit during dry run', async () => {
    const { dir, root } = makeRepo();
    try {
      const headBefore = git(dir, 'rev-parse', 'HEAD');
      write(dir, 'dry.txt', 'hello\n');
      const simpleGit = openGit(dir);

      const result = await runRepo(
        simpleGit,
        [{ path: 'dry.txt', kind: 'added', staged: false, needsAdd: true }],
        {
        repoKey: dir,
        remote: 'origin',
        branch: 'main',
        template: 'chore: update {file}',
        mode: 'file',
        maxCommitsPerRun: 5,
        includePending: false,
        apply: false,
        skipWhenOffline: false,
      });

      expect(result.planned).toBe(1);
      expect(result.committed).toEqual([]);
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(git(dir, 'diff', '--cached')).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
