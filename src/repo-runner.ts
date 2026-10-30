/**
 * repo-runner: low-level, git-instance–based runner used for direct integration
 * and testing. Accepts an already-opened SimpleGit instance rather than a full
 * RepoConfig so it can be driven without a config file.
 */
import type { SimpleGit } from 'simple-git';
import { checkRepoReady } from './guards.js';
import { commitChanges, buildCommitMessage, splitChanges } from './commit.js';
import { pushBranch } from './push.js';
import { isRemoteReachable } from './net.js';
import { getRemoteUrl, NOTHING_TO_PUSH } from './push.js';
import type { FileChange, PushOutcome } from './types.js';
import { errorText } from './util.js';

export interface RunRepoOptions {
  repoKey: string;
  remote: string;
  branch: string;
  template: string;
  mode: 'none' | 'file';
  maxCommitsPerRun: number;
  includePending: boolean;
  apply: boolean;
  skipWhenOffline: boolean;
  pending?: string[];
  autoPull?: boolean;
}

export interface RunRepoResult {
  skippedReason?: string;
  committed: Array<{ sha: string; message: string }>;
  planned: number;
  push?: PushOutcome;
  error?: string;
}

export async function runRepo(
  git: SimpleGit,
  changes: FileChange[],
  options: RunRepoOptions,
): Promise<RunRepoResult> {
  const {
    repoKey,
    remote,
    branch,
    template,
    mode,
    maxCommitsPerRun,
    includePending,
    apply,
    skipWhenOffline,
    pending = [],
    autoPull = false,
  } = options;

  // Guard: ensure repo is healthy and on the right branch
  const ready = await checkRepoReady(git, repoKey, branch);
  if (!ready.ok) {
    return { skippedReason: ready.reason, committed: [], planned: 0 };
  }

  if (!apply) {
    // Dry-run: just count what would be committed
    const groups = splitChanges(changes, mode, maxCommitsPerRun);
    return { committed: [], planned: groups.length };
  }

  // Reconcile pending SHAs against what is actually unpushed
  if (pending.length > 0) {
    try {
      const out = await git.raw(['rev-list', `${remote}/${branch}..HEAD`]);
      const unpushed = new Set(out.split('\n').filter(Boolean));
      if (unpushed.size > 0) {
        const kept = pending.filter((sha) => unpushed.has(sha));
        pending.length = 0;
        pending.push(...kept);
      }
      // If unpushed is empty, remote is ahead — leave pending unchanged so
      // the blocked-push path can warn the user.
    } catch {
      // rev-list may fail on a fresh repo with no upstream; leave pending as-is
    }
  }

  const carried = includePending ? 0 : pending.length;
  const budget = Math.max(0, maxCommitsPerRun - carried);
  const groups = splitChanges(changes, mode, budget);
  const committed: RunRepoResult['committed'] = [];

  for (const group of groups) {
    const message = buildCommitMessage(group, template);
    try {
      const done = await commitChanges(git, group, message);
      committed.push(done);
      pending.push(done.sha);
    } catch (error) {
      return {
        committed,
        planned: 0,
        error: errorText(error),
      };
    }
  }

  // Push
  const onlyShas = includePending ? undefined : new Set(pending);
  const remoteUrl = await getRemoteUrl(git, remote);
  if (skipWhenOffline && remoteUrl) {
    const online = await isRemoteReachable(remoteUrl);
    if (!online) {
      const push: PushOutcome = {
        status: 'deferred',
        detail: `${remote} is unreachable, pending commits will be pushed when back online`,
      };
      return { committed, planned: 0, push };
    }
  }

  const push = await pushBranch(git, remote, branch, onlyShas, autoPull);
  if (push.status === 'pushed' || push.detail === NOTHING_TO_PUSH) {
    pending.length = 0;
  }
  if (push.status === 'blocked') {
    console.warn(`[cairn] push to ${remote}/${branch} is blocked: ${push.detail}`);
  }

  return { committed, planned: 0, push };
}
