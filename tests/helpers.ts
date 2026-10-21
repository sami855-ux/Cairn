import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

export function identify(dir: string): void {
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

export function makeRepo(): { root: string; dir: string; remote: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
  const remote = path.join(root, 'remote.git');
  const dir = path.join(root, 'work');
  fs.mkdirSync(dir);
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(dir, 'init', '-b', 'main');
  identify(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-u', 'origin', 'main');
  return { root, dir, remote };
}

export function write(dir: string, file: string, content: string): void {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export interface MockRequest {
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: { model: string; messages: { role: string; content: string }[] };
}

export interface MockReply {
  status?: number;
  content?: string;
  delayMs?: number;
}

export async function startMockAi(reply: (request: MockRequest) => MockReply) {
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      const request: MockRequest = { url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') };
      requests.push(request);
      const answer = reply(request);
      if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
      res.statusCode = answer.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: answer.content ?? '' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
