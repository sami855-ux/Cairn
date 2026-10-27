import type { SimpleGit } from 'simple-git';
import type { PushOutcome } from './types.js';
import { errorText } from './util.js';

export const NOTHING_TO_PUSH = 'nothing to push';

export async function getRemoteUrl(git: SimpleGit, remote: string): Promise<string | null> {
  try {
    const remotes = await git.getRemotes(true);
    const found = remotes.find((r) => r.name === remote);
    return found?.refs?.fetch ?? null;
  } catch {
    return null;
  }
}

async function parseAheadBehind(git: SimpleGit): Promise<[number, number]> {
  const counts = (await git.raw(['rev-list', '--left-right', '--count', 'HEAD...FETCH_HEAD']))
    .trim()
    .split(/\s+/)
    .map(Number);
  return [counts[0], counts[1]];
}

async function isClean(git: SimpleGit): Promise<boolean> {
  try {
    const status = await git.status();
    return status.files.length === 0;
  } catch {
    return false;
  }
}

export async function pushBranch(
  git: SimpleGit,
  remote: string,
  branch: string,
  onlyShas?: Set<string>,
  autoPull = false,
): Promise<PushOutcome> {
  try {
    const remotes = await git.getRemotes();
    if (!remotes.some((r) => r.name === remote)) {
      return { status: 'skipped', detail: `remote "${remote}" is not configured` };
    }

    try {
      await git.raw(['fetch', '--quiet', remote, branch]);
    } catch (error) {
      if (/couldn't find remote ref/i.test(errorText(error))) {
        return { status: 'skipped', detail: `${remote}/${branch} does not exist yet` };
      }
      throw error;
    }

    let [ahead, behind] = await parseAheadBehind(git);

    if (behind > 0 && autoPull) {
      const clean = await isClean(git);
      if (clean) {
        try {
          await git.raw(['pull', '--ff-only', remote, branch]);
          [ahead, behind] = await parseAheadBehind(git);
        } catch {
          return {
            status: 'blocked',
            detail: `${remote}/${branch} is ${behind} commit(s) ahead and pull --ff-only failed — manual intervention required`,
          };
        }
      }
    }

    if (behind > 0) {
      return {
        status: 'blocked',
        detail: `${remote}/${branch} is ${behind} commit(s) ahead of local branch — pull before pushing`,
      };
    }

    if (ahead === 0) return { status: 'skipped', detail: NOTHING_TO_PUSH };

    if (onlyShas) {
      const unpushed = (await git.raw(['rev-list', 'FETCH_HEAD..HEAD'])).split('\n').filter(Boolean);
      const foreign = unpushed.filter((sha) => !onlyShas.has(sha));
      if (foreign.length > 0) {
        return {
          status: 'skipped',
          detail: `${foreign.length} unpushed commit(s) were not made by cairn, enable push.includePending to publish them`,
        };
      }
    }

    await git.raw(['push', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    const local = (await git.revparse(['HEAD'])).trim();
    const published = (await git.raw(['ls-remote', remote, `refs/heads/${branch}`])).split(/\s+/)[0];
    if (published !== local) {
      return { status: 'failed', detail: 'push did not update the remote, a git hook may have rejected it' };
    }
    return { status: 'pushed', detail: `${ahead} commit(s) to ${remote}/${branch}` };
  } catch (error) {
    return { status: 'failed', detail: errorText(error) };
  }
}
