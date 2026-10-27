import type { Command } from 'commander';
import { formatHistory, readHistory } from './history.js';

interface HistoryOptions {
  limit: string;
  repo?: string;
  json?: boolean;
}

export function registerHistory(program: Command): void {
  program
    .command('history')
    .description('show push history')
    .option('-n, --limit <count>', 'number of records to show', '20')
    .option('-r, --repo <name>', 'filter by repository name')
    .option('--json', 'print JSON')
    .action(async (options: HistoryOptions) => {
      const parsed = Number(options.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        console.error('error: --limit must be a positive integer');
        process.exitCode = 1;
        return;
      }

      const records = await readHistory({ limit: parsed, repo: options.repo });
      if (options.json) {
        console.log(JSON.stringify(records, null, 2));
      } else {
        console.log(formatHistory(records));
      }
    });
}
