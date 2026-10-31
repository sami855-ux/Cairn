import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { withLock } from '../src/lock.js';
import { processRepo, runAll } from '../src/runner.js';
import { git, identify, makeRepo, startMockAi, write } from './helpers.js';

function run(dir: string, apply: boolean, overrides: Record<string, unknown> = {}) {
  const config = parseConfig({ repos: [{ path: dir }], ...overrides });
  return processRepo(config.repos[0], config, apply);
}

describe('processRepo', () => {
  it('reports a clean repository', async () => {
    const { dir } = makeRepo();
    const report = await run(dir, true);
    expect(report.status).toBe('clean');
  });

  it('plans without touching anything in dry run', async () => {
    const { dir } = makeRepo();
    const head = git(dir, 'rev-parse', 'HEAD');
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    const report = await run(dir, false);
    expect(report.status).toBe('planned');
    expect(report.commits[0]?.message).toBe('chore: add a.ts');
    expect(report.push?.status).toBe('planned');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('commits and pushes real changes', async () => {
    const { dir, remote } = makeRepo();
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    write(dir, 'README.md', '# test\nmore\n');
    const report = await run(dir, true);
    expect(report.status).toBe('committed');
    expect(report.push?.status).toBe('pushed');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it('commits locally when push is disabled for the repo', async () => {
    const { dir, remote } = makeRepo();
    const remoteHead = git(remote, 'rev-parse', 'main');
    write(dir, 'a.ts', 'export const a = 1;\n');
    const config = parseConfig({ repos: [{ path: dir, push: false }] });
    const report = await processRepo(config.repos[0], config, true);
    expect(report.status).toBe('committed');
    expect(report.push).toBeUndefined();
    expect(git(remote, 'rev-parse', 'main')).toBe(remoteHead);
  });

  it('commits deletions', async () => {
    const { dir } = makeRepo();
    write(dir, 'a.ts', 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'add a');
    git(dir, 'push');
    fs.rmSync(path.join(dir, 'a.ts'));
    const report = await run(dir, true);
    expect(report.commits[0]?.message).toBe('chore: remove a.ts');
    expect(git(dir, 'ls-files')).not.toContain('a.ts');
  });

  it('keeps secrets and blocked files out of the commit', async () => {
    const { dir } = makeRepo();
    write(dir, 'notes.md', 'hello\n');
    write(dir, 'src/app.js', 'const apiKey = "' + 'Zx9Qw8Er7Ty6Ui5Op4As' + '";\n');
    write(dir, '.env', 'PORT=3000\n');
    write(dir, '.env.example', 'PORT=3000\n');
    const report = await run(dir, true);
    expect(report.status).toBe('committed');
    const tracked = git(dir, 'ls-files').split('\n');
    expect(tracked).toContain('notes.md');
    expect(tracked).toContain('.env.example');
    expect(tracked).not.toContain('.env');
    expect(tracked).not.toContain('src/app.js');
    expect(report.excluded.map((e) => e.path).sort()).toEqual(['.env', 'src/app.js']);
    expect(report.excluded.find((e) => e.path === 'src/app.js')?.reason).toMatch(/possible secret/);
    expect(JSON.stringify(report)).not.toContain('Zx9Qw8Er7Ty6Ui5Op4As');
  });

  it('skips when every change is excluded', async () => {
    const { dir } = makeRepo();
    write(dir, '.env', 'PORT=3000\n');
    const report = await run(dir, true);
    expect(report.status).toBe('skipped');
    expect(report.reason).toMatch(/excluded/);
  });

  it('skips oversized changes and big file sets', async () => {
    const { dir } = makeRepo();
    write(dir, 'big.txt', 'x'.repeat(2000));
    const tooBig = await run(dir, true, { commit: { maxFileSizeBytes: 1000 } });
    expect(tooBig.status).toBe('skipped');
    expect(tooBig.excluded[0].reason).toBe('file too large');
    write(dir, 'a.ts', '1\n');
    write(dir, 'b.ts', '2\n');
    const many = await run(dir, true, { commit: { maxFiles: 1 } });
    expect(many.status).toBe('skipped');
    expect(many.reason).toMatch(/too many/);
  });

  it('refuses to commit when an excluded file is already staged', async () => {
    const { dir } = makeRepo();
    write(dir, '.env', 'PORT=3000\n');
    git(dir, 'add', '.env');
    write(dir, 'README.md', '# test\nchanged\n');
    const head = git(dir, 'rev-parse', 'HEAD');
    const report = await run(dir, true);
    expect(report.status).toBe('skipped');
    expect(report.reason).toMatch(/staged/);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('skips disallowed branches, detached HEAD and unfinished operations', async () => {
    const { dir } = makeRepo();
    write(dir, 'a.ts', '1\n');
    git(dir, 'checkout', '-q', '-b', 'feature');
    expect((await run(dir, true)).reason).toMatch(/not allowed/);
    expect((await run(dir, true, { repos: [{ path: dir, branch: 'feature' }] })).status).toBe('committed');
    git(dir, 'checkout', '-q', '--detach');
    write(dir, 'b.ts', '2\n');
    expect((await run(dir, true)).reason).toBe('detached HEAD');
    git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), git(dir, 'rev-parse', 'HEAD'));
    expect((await run(dir, true)).reason).toBe('merge in progress');
  });

  it('skips missing paths and non repositories', async () => {
    const { root } = makeRepo();
    expect((await run(path.join(root, 'nope'), true)).reason).toBe('path does not exist');
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect((await run(plain, true)).reason).toBe('not a git repository');
  });

  it('skips disabled repositories', async () => {
    const { dir } = makeRepo();
    write(dir, 'a.ts', '1\n');
    const config = parseConfig({ repos: [{ path: dir, enabled: false }] });
    const report = await processRepo(config.repos[0], config, true);
    expect(report.reason).toBe('disabled');
    expect(git(dir, 'status', '--porcelain')).toContain('a.ts');
  });

  it('commits but does not push when the remote moved ahead', async () => {
    const { root, dir, remote } = makeRepo();
    const other = path.join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    identify(other);
    write(other, 'theirs.txt', 'x\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'theirs');
    git(other, 'push', '-q');
    const remoteHead = git(remote, 'rev-parse', 'main');
    write(dir, 'mine.ts', '1\n');
    const report = await run(dir, true);
    expect(report.status).toBe('committed');
    expect(report.push?.status).toBe('blocked');
    expect(report.push?.detail).toMatch(/ahead of local branch|commit\(s\) ahead/);
    expect(git(remote, 'rev-parse', 'main')).toBe(remoteHead);
  });

  it('does not publish existing unpushed commits unless asked', async () => {
    const { dir, remote } = makeRepo();
    write(dir, 'old.ts', '1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'local only');
    const remoteHead = git(remote, 'rev-parse', 'main');
    write(dir, 'new.ts', '2\n');
    const guarded = await run(dir, true);
    expect(guarded.push?.status).toBe('skipped');
    expect(guarded.push?.detail).toMatch(/unpushed/);
    expect(git(remote, 'rev-parse', 'main')).toBe(remoteHead);

    write(dir, 'newer.ts', '3\n');
    const allowed = await run(dir, true, { push: { includePending: true } });
    expect(allowed.push?.status).toBe('pushed');
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it('pushes pending commits on a clean repo only when includePending is on', async () => {
    const { dir, remote } = makeRepo();
    write(dir, 'old.ts', '1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'local only');
    const off = await run(dir, true);
    expect(off.status).toBe('clean');
    expect(off.push).toBeUndefined();
    const on = await run(dir, true, { push: { includePending: true } });
    expect(on.push?.status).toBe('pushed');
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it('reports a missing remote without failing the commit', async () => {
    const { dir } = makeRepo();
    git(dir, 'remote', 'remove', 'origin');
    write(dir, 'a.ts', '1\n');
    const report = await run(dir, true);
    expect(report.status).toBe('committed');
    expect(report.push?.status).toBe('skipped');
  });

  it('rolls back staging when the commit fails', async () => {
    const { dir } = makeRepo();
    const hooks = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hooks, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    write(dir, 'a.ts', '1\n');
    const report = await run(dir, true);
    expect(report.status).toBe('failed');
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
  });
});

describe('withLock', () => {
  it('blocks concurrent runs and clears stale locks', async () => {
    const { root } = makeRepo();
    const file = path.join(root, 'run.lock');
    await withLock(file, async () => {
      await expect(withLock(file, async () => 1)).rejects.toThrow(/in progress/);
    });
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, '999999');
    await expect(withLock(file, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('silent hook failures', () => {
  it('does not report a push when a pre-push hook rejects it quietly', async () => {
    const { dir, remote } = makeRepo();
    const remoteHead = git(remote, 'rev-parse', 'main');
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    write(dir, 'a.ts', '1\n');
    const report = await run(dir, true);
    expect(report.status).toBe('committed');
    expect(report.push?.status).toBe('failed');
    expect(git(remote, 'rev-parse', 'main')).toBe(remoteHead);
  });
});

describe('file by file commits', () => {
  const split = { commit: { split: 'file' } };

  it('makes one commit per file and pushes once', async () => {
    const { dir, remote } = makeRepo();
    write(dir, 'src/a.ts', '1\n');
    write(dir, 'src/b.ts', '2\n');
    write(dir, 'README.md', '# test\nmore\n');
    const report = await run(dir, true, split);
    expect(report.status).toBe('committed');
    expect(report.commits.map((c) => c.message)).toEqual([
      'docs: update README.md',
      'chore: add a.ts',
      'chore: add b.ts',
    ]);
    expect(git(dir, 'log', '--format=%s', '-n', '3').split('\n')).toEqual([
      'chore: add b.ts',
      'chore: add a.ts',
      'docs: update README.md',
    ]);
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD~1')).toBe('src/a.ts');
    expect(report.push?.status).toBe('pushed');
    expect(report.push?.detail).toMatch(/^3 commit/);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('previews every commit in a dry run without changing anything', async () => {
    const { dir } = makeRepo();
    const head = git(dir, 'rev-parse', 'HEAD');
    write(dir, 'a.ts', '1\n');
    write(dir, 'b.ts', '2\n');
    const report = await run(dir, false, split);
    expect(report.status).toBe('planned');
    expect(report.commits).toHaveLength(2);
    expect(report.commits.every((c) => c.sha === undefined)).toBe(true);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('commits only maxCommitsPerRun files and leaves the rest untouched', async () => {
    const { dir, remote } = makeRepo();
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    for (const name of names) write(dir, `${name}.ts`, `${name}\n`);
    const capped = { commit: { split: 'file', maxCommitsPerRun: 5 } };
    const first = await run(dir, true, capped);
    expect(first.status).toBe('committed');
    expect(first.commits.map((c) => c.message)).toEqual(['a', 'b', 'c', 'd', 'e'].map((n) => `chore: add ${n}.ts`));
    expect(first.files).toBe(5);
    expect(first.deferred).toBe(5);
    expect(git(dir, 'status', '--porcelain').split('\n').sort()).toEqual(
      ['f', 'g', 'h', 'i', 'j'].map((n) => `?? ${n}.ts`),
    );
    expect(first.push?.detail).toMatch(/^5 commit/);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));

    const second = await run(dir, true, capped);
    expect(second.commits.map((c) => c.message)).toEqual(['f', 'g', 'h', 'i', 'j'].map((n) => `chore: add ${n}.ts`));
    expect(second.deferred).toBe(0);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('reports deferred files in a dry run', async () => {
    const { dir } = makeRepo();
    for (const name of ['a', 'b', 'c']) write(dir, `${name}.ts`, `${name}\n`);
    const report = await run(dir, false, { commit: { split: 'file', maxCommitsPerRun: 2 } });
    expect(report.commits).toHaveLength(2);
    expect(report.deferred).toBe(1);
  });

  it('keeps everything in one commit when you already staged files', async () => {
    const { dir } = makeRepo();
    write(dir, 'a.ts', '1\n');
    write(dir, 'b.ts', '2\n');
    git(dir, 'add', 'a.ts');
    const report = await run(dir, true, split);
    expect(report.commits).toHaveLength(1);
    expect(report.commits[0].message).toBe('chore: add a.ts and b.ts');
  });

  it('commits deletions as their own commits', async () => {
    const { dir } = makeRepo();
    write(dir, 'old.ts', '1\n');
    write(dir, 'keep.ts', '2\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'add files');
    git(dir, 'push', '-q');
    fs.rmSync(path.join(dir, 'old.ts'));
    write(dir, 'keep.ts', '2\nchanged\n');
    const report = await run(dir, true, split);
    expect(report.commits.map((c) => c.message).sort()).toEqual(['chore: remove old.ts', 'chore: update keep.ts']);
  });

  it('stops cleanly and does not push when a later commit is rejected', async () => {
    const { dir, remote } = makeRepo();
    const remoteHead = git(remote, 'rev-parse', 'main');
    const hook = '#!/bin/sh\nf="$(git rev-parse --git-dir)/count"\nn=$(cat "$f" 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > "$f"\n[ $n -lt 2 ]\n';
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), hook, { mode: 0o755 });
    write(dir, 'a.ts', '1\n');
    write(dir, 'b.ts', '2\n');
    write(dir, 'c.ts', '3\n');
    const report = await run(dir, true, split);
    expect(report.status).toBe('failed');
    expect(report.reason).toMatch(/committed 1 of 3/);
    expect(report.commits).toHaveLength(1);
    expect(report.push).toBeUndefined();
    expect(git(remote, 'rev-parse', 'main')).toBe(remoteHead);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(dir, 'status', '--porcelain')).toContain('b.ts');
  });
});

describe('AI commit messages', () => {
  const servers: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function mockAi(reply: Parameters<typeof startMockAi>[0]) {
    const server = await startMockAi(reply);
    servers.push(server);
    return server;
  }

  const withAi = (baseUrl: string, extra: Record<string, unknown> = {}) => ({
    commit: { ai: { enabled: true, baseUrl, ...extra } },
  });

  it('uses the model message for the commit', async () => {
    const { dir } = makeRepo();
    const server = await mockAi(() => ({ content: 'feat: add the first constant' }));
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    const report = await run(dir, true, withAi(server.baseUrl));
    expect(report.status).toBe('committed');
    expect(report.commits[0]).toMatchObject({ message: 'feat: add the first constant', source: 'ai' });
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('feat: add the first constant');
    const prompt = server.requests[0].body.messages[1].content;
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('+export const a = 1;');
  });

  it('does not call the model in a dry run', async () => {
    const { dir } = makeRepo();
    const server = await mockAi(() => ({ content: 'feat: nope' }));
    write(dir, 'a.ts', '1\n');
    const report = await run(dir, false, withAi(server.baseUrl));
    expect(report.commits[0].message).toBe('chore: add a.ts');
    expect(server.requests).toHaveLength(0);
  });

  it('falls back to the rule based message when the reply is unusable', async () => {
    const { dir } = makeRepo();
    const server = await mockAi(() => ({ content: 'sure, here you go' }));
    write(dir, 'a.ts', '1\n');
    const report = await run(dir, true, withAi(server.baseUrl));
    expect(report.status).toBe('committed');
    expect(report.commits[0]).toMatchObject({ message: 'chore: add a.ts', source: 'rules' });
    expect(report.commits[0].aiError).toMatch(/valid commit message/);
  });

  it('commits locally when the server is down and defers pushing', async () => {
    const { dir, remote } = makeRepo();
    const server = await mockAi(() => ({ content: 'fix: gone' }));
    const url = server.baseUrl;
    const published = git(remote, 'rev-parse', 'main');
    await server.close();
    servers.pop();
    write(dir, 'a.ts', '1\n');
    const report = await run(dir, true, withAi(url));
    expect(report.commits[0].message).toBe('chore: add a.ts');
    expect(report.push?.status).toBe('deferred');
    expect(git(remote, 'rev-parse', 'main')).toBe(published);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('persists offline commits and improves their messages before the next push', async () => {
    const { root, dir, remote } = makeRepo();
    let online = false;
    const server = await mockAi((request) => online
      ? { content: request.body.messages[1].content.includes('login.ts') ? 'feat: add login handler' : 'feat: add logout handler' }
      : { status: 503 });
    const cfg = parseConfig({ repos: [{ path: dir, time: '00:00' }], commit: {
      split: 'file', ai: { enabled: true, baseUrl: server.baseUrl },
    } });
    const stateFile = path.join(root, 'state.json');
    const now = new Date(2026, 0, 1, 12);
    write(dir, 'login.ts', 'export const login = 1;\n');
    write(dir, 'logout.ts', 'export const logout = 1;\n');
    const first = await runAll(cfg, { apply: true, due: true, stateFile, now });
    expect(first[0].push?.status).toBe('deferred');
    const oldHead = git(dir, 'rev-parse', 'HEAD');
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
    const identities = git(dir, 'log', '-2', '--format=%an %ae %aI %cn %ce %cI');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))[dir].awaitingMessages).toHaveLength(2);
    online = true;
    const next = await runAll(cfg, { apply: true, due: true, stateFile, now });
    expect(next[0].push?.status).toBe('pushed');
    expect(git(dir, 'rev-parse', 'HEAD')).not.toBe(oldHead);
    expect(git(dir, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
    expect(git(dir, 'log', '-2', '--format=%an %ae %aI %cn %ce %cI')).toBe(identities);
    expect(git(dir, 'log', '-2', '--format=%s')).toBe('feat: add logout handler\nfeat: add login handler');
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))[dir].awaitingMessages).toEqual([]);
    expect(await runAll(cfg, { apply: true, due: true, stateFile, now })).toEqual([]);
  });

  it('does not rewrite manual descendants even when includePending is enabled', async () => {
    const { root, dir } = makeRepo();
    let online = false;
    const server = await mockAi(() => online ? { content: 'feat: improve behavior' } : { status: 503 });
    const cfg = parseConfig({ repos: [{ path: dir }], push: { includePending: true }, ...withAi(server.baseUrl) });
    const stateFile = path.join(root, 'state.json');
    write(dir, 'a.ts', '1\n');
    await runAll(cfg, { apply: true, stateFile });
    write(dir, 'manual.ts', '2\n');
    git(dir, 'add', 'manual.ts');
    git(dir, 'commit', '-m', 'manual work');
    const head = git(dir, 'rev-parse', 'HEAD');
    online = true;
    const next = await runAll(cfg, { apply: true, stateFile });
    expect(next[0].push?.status).toBe('deferred');
    expect(next[0].push?.detail).toContain('manual commits');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('stops asking after the first failure in a run', async () => {
    const { dir } = makeRepo();
    const server = await mockAi(() => ({ status: 500 }));
    for (const name of ['a', 'b', 'c']) write(dir, `${name}.ts`, `${name}\n`);
    const report = await run(dir, true, { commit: { split: 'file', ai: { enabled: true, baseUrl: server.baseUrl } } });
    expect(report.commits).toHaveLength(3);
    expect(report.commits.every((c) => c.source === 'rules')).toBe(true);
    expect(server.requests).toHaveLength(1);
  });

  it('writes one message per commit in file by file mode', async () => {
    const { dir } = makeRepo();
    const server = await mockAi((request) => {
      const prompt = request.body.messages[1].content;
      return { content: prompt.includes('login.ts') ? 'feat: add login handler' : 'feat: add logout handler' };
    });
    write(dir, 'login.ts', 'export const login = 1;\n');
    write(dir, 'logout.ts', 'export const logout = 1;\n');
    const report = await run(dir, true, {
      commit: { split: 'file', ai: { enabled: true, baseUrl: server.baseUrl } },
    });
    expect(report.commits.map((c) => c.message)).toEqual(['feat: add login handler', 'feat: add logout handler']);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0].body.messages[1].content).not.toContain('logout.ts');
  });

  it('keeps lock files and source maps out of the prompt', async () => {
    const { dir } = makeRepo();
    const server = await mockAi(() => ({ content: 'chore: update dependencies' }));
    write(dir, 'package-lock.json', '{"lockfileVersion": "LOCKTOKEN123"}\n');
    write(dir, 'bundle.js.map', 'MAPTOKEN456\n');
    write(dir, 'a.ts', 'export const a = 1;\n');
    await run(dir, true, withAi(server.baseUrl));
    const prompt = server.requests[0].body.messages[1].content;
    expect(prompt).toContain('+export const a = 1;');
    expect(prompt).not.toContain('LOCKTOKEN123');
    expect(prompt).not.toContain('MAPTOKEN456');
  });

  it('never sends excluded files to the model', async () => {
    const { dir } = makeRepo();
    const server = await mockAi(() => ({ content: 'chore: update notes' }));
    write(dir, '.env', 'DB_PASSWORD_VALUE=ENVTOKEN789\n');
    write(dir, 'notes.md', 'hello\n');
    await run(dir, true, withAi(server.baseUrl));
    expect(JSON.stringify(server.requests[0].body)).not.toContain('ENVTOKEN789');
  });
});

describe('offline pushes and pending commits', () => {
  const config = (dir: string, extra: Record<string, unknown> = {}) => parseConfig({ repos: [{ path: dir }], ...extra });

  async function goOffline(dir: string, root: string, run: { pending: string[] }) {
    git(dir, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
    write(dir, 'a.ts', '1\n');
    const cfg = config(dir);
    return processRepo(cfg.repos[0], cfg, true, run);
  }

  it('commits while offline and publishes it once the network is back', async () => {
    const { root, dir, remote } = makeRepo();
    const run = { pending: [] as string[] };
    const first = await goOffline(dir, root, run);
    expect(first.status).toBe('committed');
    expect(first.push?.status).toBe('failed');
    expect(run.pending).toEqual([git(dir, 'rev-parse', 'HEAD')]);

    const cfg = config(dir);
    git(dir, 'remote', 'set-url', 'origin', remote);
    const second = await processRepo(cfg.repos[0], cfg, true, run);
    expect(second.status).toBe('clean');
    expect(second.push?.status).toBe('pushed');
    expect(run.pending).toEqual([]);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it('pushes earlier offline commits together with a new one', async () => {
    const { root, dir, remote } = makeRepo();
    const run = { pending: [] as string[] };
    await goOffline(dir, root, run);
    git(dir, 'remote', 'set-url', 'origin', remote);
    write(dir, 'b.ts', '2\n');
    const cfg = config(dir);
    const report = await processRepo(cfg.repos[0], cfg, true, run);
    expect(report.status).toBe('committed');
    expect(report.push?.detail).toMatch(/^2 commit/);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it('never publishes commits cairn did not make during a retry', async () => {
    const { root, dir, remote } = makeRepo();
    const run = { pending: [] as string[] };
    await goOffline(dir, root, run);
    git(dir, 'remote', 'set-url', 'origin', remote);
    write(dir, 'mine.ts', 'mine\n');
    git(dir, 'add', 'mine.ts');
    git(dir, 'commit', '-m', 'my own work');
    const remoteHead = git(remote, 'rev-parse', 'main');
    const cfg = config(dir);
    const report = await processRepo(cfg.repos[0], cfg, true, run);
    expect(report.status).toBe('clean');
    expect(report.push?.status).toBe('skipped');
    expect(report.push?.detail).toMatch(/not made by cairn/);
    expect(git(remote, 'rev-parse', 'main')).toBe(remoteHead);
  });

  it('keeps pending commits when the remote moved ahead', async () => {
    const { root, dir, remote } = makeRepo();
    const run = { pending: [] as string[] };
    await goOffline(dir, root, run);
    const other = path.join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    identify(other);
    write(other, 'theirs.txt', 'x\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'theirs');
    git(other, 'push', '-q');
    git(dir, 'remote', 'set-url', 'origin', remote);
    const cfg = config(dir);
    const report = await processRepo(cfg.repos[0], cfg, true, run);
    expect(report.push?.status).toBe('blocked');
    expect(report.push?.detail).toMatch(/ahead of local branch|commit\(s\) ahead/);
    expect(run.pending).toHaveLength(1);
  });
});

describe('runAll due scheduling', () => {
  const at = (hour: number, minute = 0, day = 1) => new Date(2026, 0, day, hour, minute);
  const stateFileFor = (root: string) => path.join(root, 'state.json');

  it('runs each repo once a day at or after its own time', async () => {
    const one = makeRepo();
    const two = makeRepo();
    const stateFile = stateFileFor(one.root);
    const cfg = parseConfig({
      schedule: { time: '12:00' },
      repos: [{ path: one.dir }, { path: two.dir, time: '18:00' }],
    });
    write(one.dir, 'x.ts', '1\n');
    write(two.dir, 'y.ts', '1\n');
    const real = fs.realpathSync;
    const tick = (now: Date) => runAll(cfg, { apply: true, due: true, now, stateFile });

    expect(await tick(at(11, 59))).toEqual([]);
    const noon = await tick(at(12));
    expect(noon.map((r) => r.path)).toEqual([real(one.dir)]);
    expect(noon[0].status).toBe('committed');
    expect(await tick(at(12, 30))).toEqual([]);

    const evening = await tick(at(19));
    expect(evening.map((r) => r.path)).toEqual([real(two.dir)]);
    expect(evening[0].status).toBe('committed');
    expect(await tick(at(19, 15))).toEqual([]);

    const nextDay = await tick(at(12, 5, 2));
    expect(nextDay.map((r) => r.path)).toEqual([real(one.dir)]);
    expect(nextDay[0].status).toBe('clean');
  });

  it('catches up after the computer was off at the scheduled time', async () => {
    const { root, dir } = makeRepo();
    const cfg = parseConfig({ repos: [{ path: dir, time: '09:00' }] });
    write(dir, 'a.ts', '1\n');
    const late = await runAll(cfg, { apply: true, due: true, now: at(16, 40), stateFile: stateFileFor(root) });
    expect(late).toHaveLength(1);
    expect(late[0].status).toBe('committed');
  });

  it('retries a failed push on the next check and stops once it succeeds', async () => {
    const { root, dir, remote } = makeRepo();
    const stateFile = stateFileFor(root);
    const cfg = parseConfig({ repos: [{ path: dir, time: '00:00' }] });
    git(dir, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
    write(dir, 'a.ts', '1\n');
    const tick = (now: Date) => runAll(cfg, { apply: true, due: true, now, stateFile });

    const first = await tick(at(9));
    expect(first[0].push?.status).toBe('failed');
    const second = await tick(at(9, 15));
    expect(second).toHaveLength(1);
    expect(second[0].status).toBe('clean');
    expect(second[0].push?.status).toBe('failed');

    git(dir, 'remote', 'set-url', 'origin', remote);
    const third = await tick(at(9, 30));
    expect(third[0].push?.status).toBe('pushed');
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(await tick(at(9, 45))).toEqual([]);
  });

  it('skips scheduled checks after a manual push until the next day', async () => {
    const { root, dir } = makeRepo();
    const stateFile = stateFileFor(root);
    const cfg = parseConfig({ repos: [{ path: dir, time: '00:00' }] });
    write(dir, 'a.ts', '1\n');
    const manual = await runAll(cfg, { apply: true, now: at(10), stateFile });
    expect(manual[0].push?.status).toBe('pushed');
    write(dir, 'b.ts', '2\n');
    const scheduled = await runAll(cfg, { apply: true, due: true, now: at(10, 30), stateFile });
    expect(scheduled).toEqual([]);
    expect(git(dir, 'status', '--porcelain')).toContain('b.ts');
    const tomorrow = await runAll(cfg, { apply: true, due: true, now: at(10, 0, 2), stateFile });
    expect(tomorrow[0].push?.status).toBe('pushed');
  });

  it('keeps dry run previews from using up the real run', async () => {
    const { root, dir } = makeRepo();
    const stateFile = stateFileFor(root);
    const cfg = parseConfig({ repos: [{ path: dir, time: '00:00' }] });
    write(dir, 'a.ts', '1\n');
    expect(await runAll(cfg, { apply: false, due: true, now: at(10), stateFile })).toHaveLength(1);
    expect(await runAll(cfg, { apply: false, due: true, now: at(10, 15), stateFile })).toEqual([]);
    const real = await runAll(cfg, { apply: true, due: true, now: at(10, 30), stateFile });
    expect(real[0].status).toBe('committed');
  });

  it('skips repos that are not enabled', async () => {
    const { root, dir } = makeRepo();
    const cfg = parseConfig({ repos: [{ path: dir, time: '00:00', enabled: false }] });
    expect(await runAll(cfg, { apply: true, due: true, now: at(10), stateFile: stateFileFor(root) })).toEqual([]);
  });
});
