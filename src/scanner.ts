import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit, type FileStatusResult, type SimpleGit } from 'simple-git';
import type { Config, RepoConfig } from './config.js';
import { resolveRepoPath } from './paths.js';
import type { FileChange, RepoScan } from './types.js';
import { exists } from './util.js';

const IN_PROGRESS: ReadonlyArray<readonly [string, string]> = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['BISECT_LOG', 'bisect'],
];

export function openGit(dir: string, timeoutSeconds = 60): SimpleGit {
  return simpleGit({
    baseDir: dir,
    timeout: { block: timeoutSeconds * 1000 },
    maxConcurrentProcesses: 1,
  });
}

function toChange(file: FileStatusResult): FileChange {
  const codes = `${file.index}${file.working_dir}`;
  let kind: FileChange['kind'] = 'modified';
  if (codes.includes('D')) kind = 'deleted';
  else if (file.index === '?' || codes.includes('A')) kind = 'added';
  else if (codes.includes('R')) kind = 'renamed';
  return {
    path: file.path,
    from: file.from,
    kind,
    staged: file.index !== ' ' && file.index !== '?',
    needsAdd: file.working_dir !== ' ',
  };
}

export async function scanRepo(repo: RepoConfig, config: Config): Promise<RepoScan> {
  const input = resolveRepoPath(repo.path);
  const base: RepoScan = { path: input, root: input, branch: null, changes: [], ahead: 0, behind: 0 };
  const skip = (reason: string, extra: Partial<RepoScan> = {}): RepoScan => ({
    ...base,
    ...extra,
    skipReason: reason,
  });

  const stat = await fs.stat(input).catch(() => null);
  if (!stat?.isDirectory()) return skip('path does not exist');

  let root: string;
  let gitDir: string;
  try {
    const probe = openGit(input, config.push.timeoutSeconds);
    root = (await probe.revparse(['--show-toplevel'])).trim();
    gitDir = (await probe.revparse(['--absolute-git-dir'])).trim();
  } catch {
    return skip('not a git repository');
  }

  for (const [name, label] of IN_PROGRESS) {
    if (await exists(path.join(gitDir, name))) return skip(`${label} in progress`, { root });
  }

  const git = openGit(root, config.push.timeoutSeconds);
  const status = await git.status();
  if (status.detached || !status.current) return skip('detached HEAD', { root });

  const branch = status.current;
  const allowed = repo.branch ? [repo.branch] : config.allowedBranches;
  if (!allowed.includes(branch)) return skip(`branch "${branch}" is not allowed`, { root, branch });
  if (status.conflicted.length > 0) return skip('unresolved conflicts', { root, branch });

  return {
    path: input,
    root,
    branch,
    changes: status.files.map(toChange),
    ahead: status.ahead,
    behind: status.behind,
  };
}
