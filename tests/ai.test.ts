import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAi, cleanMessage, suggestMessage, truncateDiff } from '../src/ai.js';
import { defaultConfig } from '../src/config.js';
import { startMockAi } from './helpers.js';

const base = defaultConfig().commit.ai;
const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  delete process.env.GC_TEST_KEY;
});

async function mock(content: string, extra: { status?: number; delayMs?: number } = {}) {
  const server = await startMockAi(() => ({ content, ...extra }));
  servers.push(server);
  return server;
}

describe('cleanMessage', () => {
  it('accepts a clean conventional line', () => {
    expect(cleanMessage('fix: handle expired refresh tokens')).toBe('fix: handle expired refresh tokens');
    expect(cleanMessage('feat(auth): add mfa step')).toBe('feat(auth): add mfa step');
  });

  it('strips quotes, fences, prefixes, thinking blocks and trailing periods', () => {
    expect(cleanMessage('"fix: handle empty input."')).toBe('fix: handle empty input');
    expect(cleanMessage('```text\nfix: handle empty input\n```')).toBe('fix: handle empty input');
    expect(cleanMessage('Commit message: docs: update readme')).toBe('docs: update readme');
    expect(cleanMessage('<think>hmm</think>\nrefactor: split auth module')).toBe('refactor: split auth module');
  });

  it('uses the first line only', () => {
    expect(cleanMessage('fix: one thing\n\nAnd a long explanation')).toBe('fix: one thing');
  });

  it('rejects unusable replies', () => {
    expect(cleanMessage('')).toBeNull();
    expect(cleanMessage('Updated the auth flow')).toBeNull();
    expect(cleanMessage(`fix: ${'x'.repeat(80)}`)).toBeNull();
    expect(cleanMessage('wip: stuff')).toBeNull();
  });
});

describe('truncateDiff', () => {
  it('leaves short diffs alone and marks truncated ones', () => {
    expect(truncateDiff('abc', 10)).toBe('abc');
    expect(truncateDiff('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}\n[diff truncated]`);
  });
});

describe('suggestMessage', () => {
  it('sends the model, files and diff to the chat completions endpoint', async () => {
    const server = await mock('fix: handle empty input');
    const result = await suggestMessage({ ...base, baseUrl: server.baseUrl, model: 'tiny' }, ['src/a.ts'], '+added line');
    expect(result).toEqual({ message: 'fix: handle empty input' });
    const [request] = server.requests;
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.body.model).toBe('tiny');
    expect(request.body.messages[1].content).toContain('- src/a.ts');
    expect(request.body.messages[1].content).toContain('+added line');
    expect(request.headers.authorization).toBeUndefined();
  });

  it('sends a bearer token from the environment or a key file', async () => {
    const server = await mock('fix: x y z');
    process.env.GC_TEST_KEY = 'env-secret';
    await suggestMessage({ ...base, baseUrl: server.baseUrl, apiKeyEnv: 'GC_TEST_KEY' }, ['a'], 'd');
    expect(server.requests[0].headers.authorization).toBe('Bearer env-secret');

    delete process.env.GC_TEST_KEY;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-key-')), 'key');
    fs.writeFileSync(file, 'file-secret\n', { mode: 0o600 });
    await suggestMessage({ ...base, baseUrl: server.baseUrl, apiKeyEnv: 'GC_TEST_KEY', apiKeyFile: file }, ['a'], 'd');
    expect(server.requests[1].headers.authorization).toBe('Bearer file-secret');
  });

  it('reports a missing key without calling the server', async () => {
    const server = await mock('fix: x y z');
    const result = await suggestMessage({ ...base, baseUrl: server.baseUrl, apiKeyEnv: 'GC_TEST_KEY' }, ['a'], 'd');
    expect(result).toEqual({ error: 'API key not found' });
    expect(server.requests).toHaveLength(0);
  });

  it('turns every failure into an error result', async () => {
    const http500 = await mock('', { status: 500 });
    expect(await suggestMessage({ ...base, baseUrl: http500.baseUrl }, ['a'], 'd')).toEqual({ error: 'HTTP 500' });

    const garbage = await mock('I think you should update things');
    expect(await suggestMessage({ ...base, baseUrl: garbage.baseUrl }, ['a'], 'd')).toMatchObject({
      error: expect.stringMatching(/valid commit message/),
    });

    const slow = await mock('fix: too slow', { delayMs: 1500 });
    const timedOut = await suggestMessage({ ...base, baseUrl: slow.baseUrl, timeoutSeconds: 1 }, ['a'], 'd');
    expect('error' in timedOut).toBe(true);

    const down = await mock('fix: gone');
    const closedUrl = down.baseUrl;
    await down.close();
    servers.pop();
    expect('error' in (await suggestMessage({ ...base, baseUrl: closedUrl }, ['a'], 'd'))).toBe(true);
  });
});

describe('checkAi', () => {
  it('reports success and failure', async () => {
    const good = await mock('fix: guard against a missing token');
    expect(await checkAi({ ...base, baseUrl: good.baseUrl })).toEqual({ ok: true, message: 'fix: guard against a missing token' });
    const bad = await mock('', { status: 401 });
    expect(await checkAi({ ...base, baseUrl: bad.baseUrl })).toEqual({ ok: false, error: 'HTTP 401' });
  });
});
