import fs from 'node:fs/promises';
import type { AiConfig } from './config.js';
import { expandHome } from './paths.js';
import { errorText } from './util.js';

const SYSTEM_PROMPT = [
  'You write git commit messages.',
  'Reply with exactly one line in Conventional Commits format: type: summary.',
  'Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore.',
  'Use the imperative mood, lowercase, no trailing period, under 72 characters.',
  'Describe what the change does, not which files changed.',
  'Reply with the message only, no quotes and no explanation.',
].join(' ');

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?: \S.*$/;
const MAX_SUBJECT = 72;

export type AiResult = { message: string } | { error: string };

export function cleanMessage(raw: string): string | null {
  const line = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('```'));
  if (!line) return null;
  const message = line
    .replace(/^commit message:\s*/i, '')
    .replace(/^[`"']+|[`"']+$/g, '')
    .replace(/\.$/, '')
    .trim();
  if (message.length > MAX_SUBJECT || !CONVENTIONAL.test(message)) return null;
  return message;
}

export function truncateDiff(diff: string, maxBytes: number): string {
  const bytes = Buffer.from(diff, 'utf8');
  if (bytes.length <= maxBytes) return diff;
  return `${bytes.subarray(0, maxBytes).toString('utf8')}\n[diff truncated]`;
}

async function resolveKey(ai: AiConfig): Promise<string | null> {
  const fromEnv = ai.apiKeyEnv ? process.env[ai.apiKeyEnv] : undefined;
  if (fromEnv) return fromEnv.trim();
  if (ai.apiKeyFile) {
    const text = await fs.readFile(expandHome(ai.apiKeyFile), 'utf8').catch(() => '');
    return text.trim() || null;
  }
  return null;
}

export async function suggestMessage(ai: AiConfig, files: string[], diff: string): Promise<AiResult> {
  try {
    const key = await resolveKey(ai);
    if ((ai.apiKeyEnv || ai.apiKeyFile) && !key) return { error: 'API key not found' };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(`${ai.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(ai.timeoutSeconds * 1000),
      body: JSON.stringify({
        model: ai.model,
        temperature: 0.2,
        max_tokens: 200,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Changed files:\n${files.map((f) => `- ${f}`).join('\n')}\n\nDiff:\n${diff}` },
        ],
      }),
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const message = cleanMessage(data.choices?.[0]?.message?.content ?? '');
    return message ? { message } : { error: 'the model did not return a valid commit message' };
  } catch (error) {
    return { error: errorText(error) };
  }
}

const SAMPLE_DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,3 +10,6 @@ export function refresh(token: string) {',
  '-  return verify(token);',
  '+  if (!token) throw new Error("missing token");',
  '+  return verify(token);',
].join('\n');

export async function checkAi(ai: AiConfig): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const result = await suggestMessage(ai, ['src/auth.ts'], SAMPLE_DIFF);
  return 'message' in result ? { ok: true, message: result.message } : { ok: false, error: result.error };
}
