import type { SimpleGit } from 'simple-git';
import type { PushOutcome } from './types.js';
import { errorText } from './util.js';

export async function pushBranch(git: SimpleGit, remote: string, branch: string): Promise<PushOutcome> {
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

    const counts = (await git.raw(['rev-list', '--left-right', '--count', 'HEAD...FETCH_HEAD']))
      .trim()
      .split(/\s+/)
      .map(Number);
    const [ahead, behind] = counts;
    if (behind > 0) {
      return { status: 'skipped', detail: `${remote}/${branch} has ${behind} new commit(s), pull before the next run` };
    }
    if (ahead === 0) return { status: 'skipped', detail: 'nothing to push' };

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
