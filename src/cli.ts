#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Command } from 'commander';
import { createColors } from 'picocolors';
import { defaultConfig, loadConfig, saveConfig } from './config.js';
import { buildCronLine, hasCronBlock, mergeCrontab, readCrontab, stripCrontab, writeCrontab } from './cron.js';
import { formatError, formatHeader, formatLabel, formatReport, formatSuccess, formatSummary } from './format.js';
import { isLocked, withLock } from './lock.js';
import { cronLogPath, defaultConfigPath, lockPath, resolveRepoPath, stateDir } from './paths.js';
import { runAll } from './runner.js';
import { openGit } from './scanner.js';
import { exists } from './util.js';

process.env.GIT_TERMINAL_PROMPT = '0';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();
program
  .name('cairn')
  .description('Commit and push real, safe changes from your Git repositories on a daily schedule')
  .version(version)
  .option('-c, --config <file>', 'path to the config file');

const configFile = (): string => path.resolve(program.opts<{ config?: string }>().config ?? defaultConfigPath());

const colorEnabled = (): boolean => {
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  if (process.env.NO_COLOR !== undefined) return false;
  return Boolean(process.stdout.isTTY);
};

const formatOptions = () => ({ color: colorEnabled() });

function startLoader(): () => void {
  const colors = createColors(colorEnabled());
  const frames = ['●··', '·●·', '··●', '·●·'];
  let frame = 0;
  let active = true;
  const render = () => {
    process.stdout.write(`\r\x1B[2K  ${colors.cyan(frames[frame])}  ${colors.dim('applying changes')}`);
    frame = (frame + 1) % frames.length;
  };
  process.stdout.write('\x1B[?25l');
  render();
  const timer = setInterval(render, 140);
  return () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    process.stdout.write('\r\x1B[2K\x1B[?25h');
  };
}

function command<T extends unknown[]>(fn: (...args: T) => Promise<void>) {
  return async (...args: T): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(formatError(error instanceof Error ? error.message : String(error), formatOptions()));
      process.exitCode = 1;
    }
  };
}

interface ExecuteOptions {
  apply: boolean;
  due?: boolean;
  repo?: string;
  json?: boolean;
  showScanHint?: boolean;
}

async function execute(options: ExecuteOptions): Promise<void> {
  const config = await loadConfig(configFile());
  let elapsedMs = 0;
  const stopLoader = options.apply && !options.json && process.stdout.isTTY ? startLoader() : undefined;
  let reports;
  try {
    reports = await withLock(lockPath(), async () => {
      const started = performance.now();
      const result = await runAll(config, { apply: options.apply, only: options.repo, due: options.due });
      elapsedMs = performance.now() - started;
      return result;
    });
  } finally {
    stopLoader?.();
  }
  if (options.json) {
    console.log(JSON.stringify({ apply: options.apply, reports }, null, 2));
  } else {
    const presentation = formatOptions();
    console.log(formatHeader(version, options.apply, presentation));
    if (reports.length > 0) console.log();
    console.log(reports.map((report) => formatReport(report, presentation)).join('\n\n'));
    console.log();
    console.log(formatSummary(reports, { ...presentation, apply: options.apply, elapsedMs }));
    if (options.showScanHint) console.log(`\n${formatLabel('Hint', 'run with --apply to commit', presentation)}`);
  }
  if (reports.some((r) => r.status === 'failed' || r.push?.status === 'failed')) process.exitCode = 1;
}

program
  .command('init')
  .description('create a default config file')
  .option('--force', 'overwrite an existing config')
  .action(
    command(async (options: { force?: boolean }) => {
      const file = configFile();
      if (!options.force && (await exists(file))) {
        throw new Error(`config already exists at ${file} (use --force to overwrite)`);
      }
      await saveConfig(defaultConfig(), file);
      console.log(formatSuccess(`created ${file}`, formatOptions()));
    }),
  );

program
  .command('add <path>')
  .description('add a repository to the config')
  .option('--remote <name>', 'remote to push to', 'origin')
  .option('--branch <name>', 'only commit on this branch')
  .option('--no-push', 'commit locally without pushing')
  .action(
    command(async (target: string, options: { remote: string; branch?: string; push: boolean }) => {
      const config = await loadConfig(configFile());
      const dir = resolveRepoPath(target);
      let root: string;
      try {
        root = (await openGit(dir).revparse(['--show-toplevel'])).trim();
      } catch {
        throw new Error(`${dir} is not a git repository`);
      }
      if (config.repos.some((r) => resolveRepoPath(r.path) === root)) {
        throw new Error(`${root} is already configured`);
      }
      config.repos.push({
        path: root,
        remote: options.remote,
        branch: options.branch,
        push: options.push,
        enabled: true,
      });
      await saveConfig(config, configFile());
      console.log(formatSuccess(`added ${root}`, formatOptions()));
    }),
  );

program
  .command('remove <path>')
  .description('remove a repository from the config')
  .action(
    command(async (target: string) => {
      const config = await loadConfig(configFile());
      const resolved = resolveRepoPath(target);
      const before = config.repos.length;
      config.repos = config.repos.filter((r) => resolveRepoPath(r.path) !== resolved);
      if (config.repos.length === before) throw new Error(`${resolved} is not configured`);
      await saveConfig(config, configFile());
      console.log(formatSuccess(`removed ${resolved}`, formatOptions()));
    }),
  );


program
  .command('list')
  .alias('ls')
  .description('list configured repositories')
  .option('--json', 'print JSON')
  .action(
    command(async (options: { json?: boolean }) => {
      const config = await loadConfig(configFile());
      const p = formatOptions();

      const prettyName = (raw: string): string =>
        raw
          .split(/[-_]+/)
          .filter(Boolean)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');

      const rows = config.repos.map((repo) => {
        const full = resolveRepoPath(repo.path);

        return {
          name: prettyName(path.basename(full)),
          full,
          enabled: repo.enabled,
          remote: repo.remote,
          branch: repo.branch ?? '—',
          push: repo.push,
        };
      });

      if (options.json) {
        console.log(
          JSON.stringify(
            rows.map((row) => ({
              name: row.name,
              path: row.full,
              enabled: row.enabled,
              remote: row.remote,
              branch: row.branch === '—' ? null : row.branch,
              push: row.push,
            })),
            null,
            2,
          ),
        );
        return;
      }

      if (rows.length === 0) {
        console.log();
        console.log(formatLabel('Repos', 'none configured', p));
        console.log(
          formatLabel('Hint', 'run `cairn add <path>` to add one', p),
        );
        console.log();
        return;
      }

      const colors = createColors(colorEnabled());

      const bold = (value: string) =>
        colorEnabled() ? colors.bold(value) : value;

      const dim = (value: string) =>
        colorEnabled() ? colors.dim(value) : value;

      const cyan = (value: string) =>
        colorEnabled() ? colors.cyan(value) : value;

      const green = (value: string) =>
        colorEnabled() ? colors.green(value) : value;

      const red = (value: string) =>
        colorEnabled() ? colors.red(value) : value;

      type Row = (typeof rows)[number];

      type Column = {
        header: string;
        minWidth: number;
        maxWidth: number;
        value: (row: Row) => string;
        color?: (value: string, row: Row) => string;
      };

      const columns: Column[] = [
        {
          header: 'REPOSITORY',
          minWidth: 16,
          maxWidth: 30,
          value: (row) => row.name,
          color: (value) => bold(cyan(value)),
        },
        {
          header: 'STATUS',
          minWidth: 10,
          maxWidth: 10,
          value: (row) => (row.enabled ? 'enabled' : 'disabled'),
          color: (value, row) => (row.enabled ? green(value) : red(value)),
        },
        {
          header: 'PUSH',
          minWidth: 12,
          maxWidth: 20,
          value: (row) => (row.push ? row.remote : 'off'),
          color: (value, row) => (row.push ? value : dim(value)),
        },
        {
          header: 'BRANCH',
          minWidth: 10,
          maxWidth: 22,
          value: (row) => row.branch,
          color: (value, row) =>
            row.branch === '—' ? dim(value) : value,
        },
        {
          header: 'PATH',
          minWidth: 20,
          maxWidth: 42,
          value: (row) => row.full,
          color: (value) => dim(value),
        },
      ];

      const gap = '  ';
      const terminalWidth = process.stdout.columns || 100;
      const availableWidth = Math.max(40, terminalWidth - 4);

      // Measure visible text without counting ANSI color codes.
      const visibleLength = (value: string): number =>
        value.replace(/\x1B\[[0-9;]*m/g, '').length;

      // Allocate column widths based on actual content.
      const widths = columns.map((column) => {
        const longest = Math.max(
          visibleLength(column.header),
          ...rows.map((row) => visibleLength(column.value(row))),
        );

        return Math.min(
          column.maxWidth,
          Math.max(column.minWidth, longest),
        );
      });

      // Shrink flexible columns if the table is wider than the terminal.
      const minimumTotal =
        columns.reduce((total, column) => total + column.minWidth, 0) +
        gap.length * (columns.length - 1);

      let totalWidth =
        widths.reduce((total, width) => total + width, 0) +
        gap.length * (columns.length - 1);

      const shrinkOrder = [4, 0, 2, 3];

      for (const index of shrinkOrder) {
        while (totalWidth > availableWidth && widths[index] > columns[index].minWidth) {
          widths[index]--;
          totalWidth--;
        }
      }

      const fit = (value: string, width: number): string => {
        if (visibleLength(value) <= width) {
          return value + ' '.repeat(width - visibleLength(value));
        }

        // Clip plain text before applying color, so escape sequences
        // are never cut in the middle.
        const clippedWidth = Math.max(0, width - 1);
        const clipped = value.slice(0, clippedWidth) + '…';

        return clipped;
      };

      const renderPlainCell = (value: string, width: number): string => {
        const clipped =
          value.length > width
            ? `${value.slice(0, Math.max(0, width - 1))}…`
            : value;

        return clipped + ' '.repeat(Math.max(0, width - clipped.length));
      };

      const renderRow = (
        values: string[],
        style?: (value: string, index: number) => string,
      ): string =>
        '  ' +
        values
          .map((value, index) => {
            const fitted = renderPlainCell(value, widths[index]);
            const styled = style ? style(fitted.trimEnd(), index) : fitted.trimEnd();

            // Pad using the original visible cell width.
            return styled + ' '.repeat(
              Math.max(0, widths[index] - visibleLength(fitted.trimEnd())),
            );
          })
          .join(gap)
          .trimEnd();

      const lineWidth = Math.min(
        availableWidth,
        widths.reduce((total, width) => total + width, 0) +
          gap.length * (columns.length - 1),
      );

      console.log();
      console.log(
        `  ${bold('Repositories')} ${dim(`(${rows.length})`)}`,
      );
      console.log();

      console.log(
        renderRow(
          columns.map((column) => column.header),
          (value) => bold(value),
        ),
      );

      console.log(
        `  ${widths.map((width) => '─'.repeat(width)).join(gap)}`,
      );

      for (const row of rows) {
        console.log(
          renderRow(
            columns.map((column) => column.value(row)),
            (value, index) => {
              const column = columns[index];
              const rowValue = column.value(row);
              const clipped = renderPlainCell(rowValue, widths[index]).trimEnd();

              return column.color
                ? column.color(clipped, row)
                : value;
            },
          ),
        );
      }

      const enabled = rows.filter((row) => row.enabled).length;
      const disabled = rows.length - enabled;
      const pushing = rows.filter((row) => row.enabled && row.push).length;

      console.log();
      console.log(`  ${dim('─'.repeat(lineWidth))}`);
      console.log(
        `  ${dim('Summary')}  ` +
          `${green(`${enabled} enabled`)}  ` +
          `${dim(`${disabled} disabled`)}  ` +
          `${cyan(`${pushing} pushing`)}`,
      );
      console.log();
    }),
  );

program
  .command('scan')
  .description('show what a run would commit, without changing anything')
  .option('--repo <path>', 'only this repository')
  .option('--json', 'print JSON')
  .action(command(async (options: { repo?: string; json?: boolean }) => execute({ ...options, apply: false, showScanHint: !options.json })));

program
  .command('run')
  .description('scan, commit and push (dry run unless --apply is given or dryRun is false in the config)')
  .option('--apply', 'commit and push for real')
  .option('--due', 'only run repos whose scheduled time has passed and have not run today')
  .option('--dry-run', 'report only')
  .option('--repo <path>', 'only this repository')
  .option('--json', 'print JSON')
  .action(
    command(async (options: { apply?: boolean; due?: boolean; dryRun?: boolean; repo?: string; json?: boolean }) => {
      if (options.apply && options.dryRun) throw new Error('--apply and --dry-run cannot be combined');
      const config = await loadConfig(configFile());
      const apply = options.apply ? true : options.dryRun ? false : !config.dryRun;
      await execute({ apply, due: options.due, repo: options.repo, json: options.json });
    }),
  );

program
  .command('install')
  .description('add the daily cron job')
  .option('--apply', 'let the scheduled job commit and push for real')
  .option('--time <HH:MM>', 'time of day, overrides the config')
  .action(
    command(async (options: { apply?: boolean; time?: string }) => {
      const config = await loadConfig(configFile());
      const time = options.time ?? config.schedule.time;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('time must look like 21:30');
      const script = await fs.realpath(process.argv[1]);
      if (!script.endsWith('.js')) {
        throw new Error('install from the built CLI: npm run build, then node dist/cli.js install');
      }
      await fs.mkdir(stateDir(), { recursive: true });
      const line = buildCronLine({
        time,
        node: process.execPath,
        script,
        apply: Boolean(options.apply),
        logFile: cronLogPath(),
        configFile: program.opts<{ config?: string }>().config ? configFile() : undefined,
      });
      await writeCrontab(mergeCrontab(await readCrontab(), line));
      console.log(formatSuccess(`scheduled daily at ${time}, ${options.apply ? 'committing and pushing' : 'dry run only'}`, formatOptions()));
      console.log(formatLabel('Cron', line, formatOptions()));
    }),
  );

program
  .command('uninstall')
  .description('remove the cron job')
  .action(
    command(async () => {
      const existing = await readCrontab();
      if (!hasCronBlock(existing)) {
        console.log(formatLabel('Cron', 'no cairn cron job found', formatOptions()));
        return;
      }
      await writeCrontab(stripCrontab(existing));
      console.log(formatSuccess('removed the cron job', formatOptions()));
    }),
  );

program
  .command('status')
  .description('show config, schedule and run state')
  .action(
    command(async () => {
      const file = configFile();
      const present = await exists(file);
      const presentation = formatOptions();
      console.log(formatLabel('Config', `${file}${present ? '' : ' (missing)'}`, presentation));
      if (present) {
        const config = await loadConfig(file);
        console.log(formatLabel('Repos', `${config.repos.length} (${config.repos.filter((r) => r.enabled).length} enabled)`, presentation));
        console.log(formatLabel('Default mode', config.dryRun ? 'dry run' : 'apply', presentation));
        console.log(formatLabel('Schedule', config.schedule.time, presentation));
      }
      const cron = await readCrontab().catch(() => '');
      console.log(formatLabel('Cron', hasCronBlock(cron) ? 'installed' : 'not installed', presentation));
      console.log(formatLabel('Running now', (await isLocked(lockPath())) ? 'yes' : 'no', presentation));
      console.log(formatLabel('Cron log', cronLogPath(), presentation));
    }),
  );

await program.parseAsync(process.argv);
