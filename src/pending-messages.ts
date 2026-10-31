import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SimpleGit } from 'simple-git';
import { suggestMessage, truncateDiff } from './ai.js';
import { DIFF_EXCLUDES } from './commit.js';
import type { AiConfig } from './config.js';
import type { RepoState } from './state.js';

// Build new objects first, then move the branch atomically. The index and
// working tree are never checked out or reset, even when they contain edits.
export async function preparePendingMessages(
  git: SimpleGit, remote: string, branch: string, ai: AiConfig,
  state: RepoState, checkpoint: () => Promise<void>,
): Promise<Map<string, { sha: string; message: string }>> {
  const replacements = new Map<string, { sha: string; message: string }>();
  if (!state.awaitingMessages?.length || !ai.enabled) return replacements;
  await git.raw(['fetch', '--quiet', remote, branch]);
  const head = (await git.revparse(['HEAD'])).trim();
  const ref = `refs/heads/${branch}`;
  if ((await git.raw(['symbolic-ref', 'HEAD'])).trim() !== ref) throw new Error('branch changed before message generation');
  await git.raw(['merge-base', '--is-ancestor', 'FETCH_HEAD', head]);
  const commits = (await git.raw(['rev-list', '--reverse', `FETCH_HEAD..${head}`])).trim().split('\n').filter(Boolean);
  const waiting = new Set(state.awaitingMessages);
  if (!commits.some((sha) => waiting.has(sha))) {
    state.awaitingMessages = state.awaitingMessages.filter((sha) => !state.pending.includes(sha));
    return replacements;
  }
  const owned = new Set(state.pending);
  const objects = new Map<string, string>();
  for (const sha of commits) {
    if (!owned.has(sha)) throw new Error('manual commits are present; refusing to rewrite their history');
    const object = await git.raw(['cat-file', 'commit', sha]);
    const headers = object.slice(0, object.indexOf('\n\n'));
    if ((headers.match(/^parent /gm) ?? []).length !== 1 || /^gpgsig|^mergetag/m.test(headers)) {
      throw new Error('merge or signed commits are present; refusing to rewrite them');
    }
    const published = await git.raw(['for-each-ref', `--contains=${sha}`, '--format=%(refname)', 'refs/remotes', 'refs/tags']);
    if (published.trim()) throw new Error('a pending commit is already referenced by a remote or tag');
    objects.set(sha, object);
  }
  const messages = new Map<string, string>();
  for (const sha of commits.filter((sha) => waiting.has(sha))) {
    const diff = await git.raw(['diff', `${sha}^`, sha, '--no-color', '--unified=2', '--', '.', ...DIFF_EXCLUDES.map((p) => `:(exclude)${p}`)]);
    if (!diff.trim()) continue;
    const files = (await git.raw(['diff', '--name-only', '-z', `${sha}^`, sha])).split('\0').filter(Boolean);
    const result = await suggestMessage(ai, files, truncateDiff(diff, ai.maxDiffBytes));
    if ('error' in result) throw new Error(`AI messages unavailable: ${result.error}`);
    messages.set(sha, result.message);
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-messages-'));
  try {
    for (const sha of commits) {
      const object = objects.get(sha)!;
      const split = object.indexOf('\n\n');
      const headers = object.slice(0, split).replace(/^parent ([0-9a-f]+)$/m, (line, parent: string) =>
        replacements.has(parent) ? `parent ${replacements.get(parent)!.sha}` : line);
      const message = messages.get(sha);
      const rewritten = `${headers}\n\n${message ? `${message}\n` : object.slice(split + 2)}`;
      const file = path.join(temp, 'commit');
      await fs.writeFile(file, rewritten);
      const next = (await git.raw(['hash-object', '-t', 'commit', '-w', file])).trim();
      replacements.set(sha, { sha: next, message: message ?? object.slice(split + 2).trim() });
    }
    // Persist both generations before changing HEAD: interruption on either
    // side of update-ref still leaves the current commits recognized as ours.
    state.pending = [...new Set([...state.pending, ...[...replacements.values()].map((r) => r.sha)])];
    await checkpoint();
    if ((await git.raw(['symbolic-ref', 'HEAD'])).trim() !== ref) throw new Error('branch changed during message generation');
    await git.raw(['update-ref', '-m', 'cairn: improve unpublished commit messages', ref, replacements.get(head)!.sha, head]);
    state.pending = state.pending.filter((sha) => !replacements.has(sha) || replacements.get(sha)!.sha === sha);
    state.awaitingMessages = state.awaitingMessages.filter((sha) => !waiting.has(sha));
    await checkpoint();
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
  return replacements;
}
