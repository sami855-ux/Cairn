import fs from 'node:fs/promises';
import path from 'node:path';
import { intro, log, outro } from '@clack/prompts';
import { createColors } from 'picocolors';
import { stateDir } from './paths.js';

export interface PushRecord {
  at: string;
  repo: string;
  remote: string;
  branch: string;
  status: string;
  commits: number;
  detail: string;
}

export interface ReadHistoryOptions {
  limit?: number;
  repo?: string;
}

const MAX_HISTORY_LINES = 2000;

export function historyPath(): string {
  return path.join(stateDir(), 'history.jsonl');
}

export async function recordPush(record: PushRecord, file = historyPath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');

  // Only read the full file when it's large enough to potentially exceed the
  // line limit — avoids an unnecessary full read on every single push.
  // 100 bytes is a conservative lower-bound for a single JSONL record.
  const stat = await fs.stat(file);
  if (stat.size > MAX_HISTORY_LINES * 100) {
    const content = await fs.readFile(file, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length > MAX_HISTORY_LINES) {
      const trimmed = lines.slice(-MAX_HISTORY_LINES);
      await fs.writeFile(file, `${trimmed.join('\n')}\n`, 'utf8');
    }
  }
}

export async function readHistory(
  options: ReadHistoryOptions = {},
  file = historyPath(),
): Promise<PushRecord[]> {
  const { limit = 20, repo } = options;
  let content = '';
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const records: PushRecord[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as PushRecord;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.at === 'string' &&
        typeof parsed.repo === 'string' &&
        typeof parsed.remote === 'string' &&
        typeof parsed.branch === 'string' &&
        typeof parsed.status === 'string' &&
        typeof parsed.commits === 'number' &&
        typeof parsed.detail === 'string'
      ) {
        if (!repo || path.basename(parsed.repo) === repo) {
          records.push(parsed);
          if (records.length >= limit) break;
        }
      }
    } catch {
      continue;
    }
  }

  return records;
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const colorEnabled = (): boolean => {
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  if (process.env.NO_COLOR !== undefined) return false;
  return Boolean(process.stdout.isTTY);
};

export function printHistory(records: PushRecord[]): void {
  intro('cairn history');

  if (records.length === 0) {
    outro('No push history yet.');
    return;
  }

  const colors = createColors(colorEnabled());

  for (const record of records) {
    const when = formatLocalTime(record.at);
    const repo = path.basename(record.repo);
    const target = `${record.remote}/${record.branch}`;

    let statusBadge: string;
    let icon: string;
    switch (record.status) {
      case 'pushed':
        statusBadge = colors.green('pushed');
        icon = colors.green('✓');
        break;
      case 'deferred':
        statusBadge = colors.yellow('deferred');
        icon = colors.yellow('↻');
        break;
      case 'failed':
        statusBadge = colors.red('failed');
        icon = colors.red('✗');
        break;
      default:
        statusBadge = colors.dim(record.status);
        icon = colors.dim('·');
    }

    const commitsText =
      record.commits > 0
        ? colors.cyan(`${record.commits} commit${record.commits === 1 ? '' : 's'}`)
        : colors.dim('0 commits');

    const lines = [
      `${icon}  ${colors.bold(repo)}  ${colors.dim(target)}  ${statusBadge}  ${commitsText}`,
      `   ${colors.dim(when)}  ${colors.dim(record.detail)}`,
    ];

    log.step(lines.join('\n'));
  }

  const pushed = records.filter((r) => r.status === 'pushed').length;
  const deferred = records.filter((r) => r.status === 'deferred').length;
  const failed = records.filter((r) => r.status === 'failed').length;

  const parts: string[] = [];
  if (pushed > 0) parts.push(`${pushed} pushed`);
  if (deferred > 0) parts.push(`${deferred} deferred`);
  if (failed > 0) parts.push(`${failed} failed`);

  outro(`${records.length} record${records.length === 1 ? '' : 's'}${parts.length ? '  ·  ' + parts.join('  ·  ') : ''}`);
}

/** @deprecated use printHistory for terminal output */
export function formatHistory(records: PushRecord[]): string {
  if (records.length === 0) return 'No push history yet.';

  const headers = ['WHEN', 'REPO', 'TARGET', 'STATUS', 'COMMITS', 'DETAIL'];
  const rows = records.map((record) => [
    formatLocalTime(record.at),
    path.basename(record.repo),
    `${record.remote}/${record.branch}`,
    record.status,
    String(record.commits),
    record.detail,
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length)),
  );

  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ').trimEnd();
  const separatorLine = widths.map((w) => '-'.repeat(w)).join('  ').trimEnd();
  const rowLines = rows.map((row) =>
    row.map((val, i) => val.padEnd(widths[i])).join('  ').trimEnd(),
  );

  return [headerLine, separatorLine, ...rowLines].join('\n');
}
