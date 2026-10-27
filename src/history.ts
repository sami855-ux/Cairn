import fs from 'node:fs/promises';
import path from 'node:path';
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

  const content = await fs.readFile(file, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length > MAX_HISTORY_LINES) {
    const trimmed = lines.slice(-MAX_HISTORY_LINES);
    await fs.writeFile(file, `${trimmed.join('\n')}\n`, 'utf8');
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
