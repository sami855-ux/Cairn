import path from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { FileChange } from './types.js';

const DOC = /\.(md|mdx|txt|rst)$/i;
const TEST = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/i;
const MAX_SUBJECT = 72;

export function inferType(changes: FileChange[]): string {
  if (changes.every((c) => DOC.test(c.path) || c.path.startsWith('docs/'))) return 'docs';
  if (changes.every((c) => TEST.test(c.path))) return 'test';
  return 'chore';
}

export function summarize(changes: FileChange[]): string {
  const verb = changes.every((c) => c.kind === 'added')
    ? 'add'
    : changes.every((c) => c.kind === 'deleted')
      ? 'remove'
      : 'update';
  const names = changes.slice(0, 3).map((c) => path.posix.basename(c.path));
  const rest = changes.length - names.length;
  let list: string;
  if (rest > 0) list = `${names.join(', ')} and ${rest} more`;
  else if (names.length > 1) list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  else list = names[0];
  return `${verb} ${list}`;
}

export function buildCommitMessage(changes: FileChange[], template: string): string {
  const message = template
    .replace(/\{type\}/g, () => inferType(changes))
    .replace(/\{summary\}/g, () => summarize(changes))
    .replace(/\{count\}/g, () => String(changes.length))
    .trim();
  return message.length > MAX_SUBJECT ? `${message.slice(0, MAX_SUBJECT - 3)}...` : message;
}

export function splitChanges(
  changes: FileChange[],
  mode: 'none' | 'file',
  maxCommits: number,
): FileChange[][] {
  if (mode === 'none' || changes.length < 2 || changes.some((c) => c.staged)) return [changes];
  return changes.slice(0, maxCommits).map((c) => [c]);
}

export async function commitChanges(git: SimpleGit, changes: FileChange[], message: string): Promise<string> {
  const toAdd = changes.filter((c) => c.needsAdd).map((c) => c.path);
  const allowed = new Set(
    changes.flatMap((c) => [c.path, c.from].filter((p): p is string => Boolean(p))),
  );
  const before = await git.revparse(['HEAD']).then((out) => out.trim(), () => null);
  try {
    if (toAdd.length > 0) await git.raw(['add', '-A', '--', ...toAdd]);
    const cached = (await git.raw(['diff', '--cached', '--name-only', '--no-renames', '-z']))
      .split('\0')
      .filter(Boolean);
    const stray = cached.filter((p) => !allowed.has(p));
    if (stray.length > 0) throw new Error(`unexpected staged files: ${stray.join(', ')}`);
    if (cached.length === 0) throw new Error('nothing was staged');
    await git.raw(['commit', '-m', message]);
    const after = await git.revparse(['HEAD']).then((out) => out.trim(), () => null);
    if (!after || after === before) {
      throw new Error('commit did not complete, a git hook may have rejected it');
    }
  } catch (error) {
    if (toAdd.length > 0) await git.raw(['reset', '-q', '--', ...toAdd]).catch(() => undefined);
    throw error;
  }
  return (await git.revparse(['HEAD'])).trim();
}
