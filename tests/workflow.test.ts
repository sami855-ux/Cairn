import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { withLock } from '../src/lock.js';
import { processRepo } from '../src/runner.js';
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
    expect(report.push?.status).toBe('skipped');
    expect(report.push?.detail).toMatch(/new commit/);
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

  it('falls back when the server is down and still pushes', async () => {
    const { dir, remote } = makeRepo();
    const server = await mockAi(() => ({ content: 'fix: gone' }));
    const url = server.baseUrl;
    await server.close();
    servers.pop();
    write(dir, 'a.ts', '1\n');
    const report = await run(dir, true, withAi(url));
    expect(report.commits[0].message).toBe('chore: add a.ts');
    expect(report.push?.status).toBe('pushed');
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
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
