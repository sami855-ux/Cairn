import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { preparePendingMessages } from '../src/pending-messages.js';
import { openGit } from '../src/scanner.js';
import type { RepoState } from '../src/state.js';
import { git, makeRepo, startMockAi, write } from './helpers.js';

describe('pending message rewrites', () => {
  const servers: Awaited<ReturnType<typeof startMockAi>>[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

  async function setup() {
    const repo = makeRepo();
    const server = await startMockAi(() => ({ content: 'feat: add login handler' }));
    servers.push(server);
    write(repo.dir, 'login.ts', 'export const login = 1;\n');
    git(repo.dir, 'add', 'login.ts');
    git(repo.dir, 'commit', '-m', 'chore: add login.ts');
    const sha = git(repo.dir, 'rev-parse', 'HEAD');
    const state: RepoState = { pending: [sha], awaitingMessages: [sha] };
    const ai = parseConfig({ commit: { ai: { enabled: true, baseUrl: server.baseUrl } } }).commit.ai;
    const rewrite = (checkpoint = async () => {}) => preparePendingMessages(openGit(repo.dir), 'origin', 'main', ai, state, checkpoint);
    return { ...repo, sha, state, rewrite, server };
  }

  it('preserves staged and unstaged edits while changing messages', async () => {
    const { dir, rewrite } = await setup();
    write(dir, 'login.ts', 'export const login = 2;\n');
    git(dir, 'add', 'login.ts');
    write(dir, 'login.ts', 'export const login = 3;\n');
    const staged = git(dir, 'diff', '--cached');
    const unstaged = git(dir, 'diff');
    await rewrite();
    expect(git(dir, 'diff', '--cached')).toBe(staged);
    expect(git(dir, 'diff')).toBe(unstaged);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('feat: add login handler');
  });

  it('leaves HEAD intact if saving the recovery state fails', async () => {
    const { dir, sha, state, rewrite } = await setup();
    await expect(rewrite(async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
    expect(state.awaitingMessages).toEqual([sha]);
    await rewrite();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('feat: add login handler');
  });

  it('records replacement SHAs before moving the branch', async () => {
    const { dir, sha, state, rewrite } = await setup();
    let saved: RepoState | undefined;
    await rewrite(async () => {
      if (!saved) {
        expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
        saved = structuredClone(state);
      }
    });
    expect(saved!.pending).toContain(sha);
    expect(saved!.pending).toContain(git(dir, 'rev-parse', 'HEAD'));
  });

  it('does not rewrite commits already pushed to the destination', async () => {
    const { dir, sha, rewrite, server } = await setup();
    git(dir, 'push');
    expect(await rewrite()).toEqual(new Map());
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
    expect(server.requests).toHaveLength(0);
  });

  it('refuses to rewrite commits referenced by a tag', async () => {
    const { dir, sha, rewrite } = await setup();
    git(dir, 'tag', 'release');
    await expect(rewrite()).rejects.toThrow('remote or tag');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
  });
});
