import type { SimpleGit } from 'simple-git';
import path from 'node:path';
import fs from 'node:fs/promises';
import { errorText } from './util.js';

type CheckResult = { ok: true } | { ok: false; reason: string };

const IN_PROGRESS_MARKERS = [
  ['MERGE_HEAD', 'merge in progress'],
  ['CHERRY_PICK_HEAD', 'cherry-pick in progress'],
  ['REVERT_HEAD', 'revert in progress'],
  ['rebase-merge', 'rebase in progress'],
  ['rebase-apply', 'rebase in progress'],
] as const;

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

async function isWorkTree(git: SimpleGit): Promise<boolean> {
  try {
    const result = await git.raw(['rev-parse', '--is-inside-work-tree']);
    return result.trim() === 'true';
  } catch {
    return false;
  }
}

async function currentBranch(git: SimpleGit): Promise<string | null> {
  try {
    const status = await git.status();
    if (status.detached) return null;
    return status.current ?? null;
  } catch {
    return null;
  }
}

async function gitDir(git: SimpleGit): Promise<string | null> {
  try {
    return (await git.raw(['rev-parse', '--git-dir'])).trim();
  } catch {
    return null;
  }
}

export async function checkRepoReady(
  git: SimpleGit,
  repoPath: string,
  expectedBranch: string,
): Promise<CheckResult> {
  try {
    const inTree = await isWorkTree(git);
    if (!inTree) return { ok: false, reason: `${repoPath} is not inside a git work tree` };

    const branch = await currentBranch(git);
    if (branch === null) return { ok: false, reason: 'HEAD is detached' };
    if (branch !== expectedBranch) {
      return { ok: false, reason: `current branch "${branch}" does not match expected "${expectedBranch}"` };
    }

    const dir = await gitDir(git);
    if (!dir) return { ok: false, reason: 'could not determine git directory' };

    const resolvedDir = path.isAbsolute(dir) ? dir : path.join(repoPath, dir);
    for (const [marker, reason] of IN_PROGRESS_MARKERS) {
      if (await fileExists(path.join(resolvedDir, marker))) {
        return { ok: false, reason };
      }
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}
