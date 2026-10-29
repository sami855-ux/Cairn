#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Command } from 'commander';
import { createColors } from 'picocolors';
import { type Config, defaultConfig, loadConfig, saveConfig } from './config.js';
import { buildCronLine, hasCronBlock, mergeCrontab, readCrontab, stripCrontab, writeCrontab } from './cron.js';
import { formatError, formatHeader, formatLabel, formatReport, formatSuccess, formatSummary } from './format.js';
import { acquireLock, isLocked, LockHeldError, withLock } from './lock.js';
import { cronLogPath, defaultConfigPath, lockPath, resolveRepoPath, stateDir } from './paths.js';
import { NOTHING_TO_PUSH } from './push.js';
import { intro, log, note, outro } from '@clack/prompts';
import { recordPush, type PushRecord } from './history.js';
import { registerHistory } from './history-command.js';
import { formatRepoName, registerPrimary } from './primary-command.js';
import { runAll } from './runner.js';
import { openGit } from './scanner.js';
import { exists } from './util.js';
import { checkAi } from './ai.js';
import { createProgress } from './progress.js';
import { notify } from './notify.js';
import type { RepoReport } from './types.js';

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
  notify?: boolean;
  showScanHint?: boolean;
}

const announce = (reports: RepoReport[]): void => {
  const commits = reports.reduce((total, r) => total + r.commits.length, 0);
  const pushed = reports.filter((r) => r.push?.status === 'pushed').length;
  const deferred = reports.filter((r) => r.push?.status === 'deferred').length;
  const failed = reports.filter((r) => r.status === 'failed' || r.push?.status === 'failed');

  if (failed.length > 0) {
    const first = failed[0];
    const repoName = path.basename(first.path);
    const reason = first.reason ?? first.push?.detail ?? 'unknown error';
    const extra = failed.length > 1 ? ` (+${failed.length - 1} more)` : '';
    notify(
      `⚠ cairn — ${repoName} failed${extra}`,
      reason,
      'critical',
      'dialog-error',
    );
    return;
  }

  if (commits === 0 && pushed === 0 && deferred === 0) return;

  if (commits > 0 && pushed > 0) {
    const repoWord = pushed === 1 ? 'repo' : 'repos';
    notify(
      `✓ cairn — ${commits} commit${commits === 1 ? '' : 's'} saved & pushed`,
      `${pushed} ${repoWord} synced to remote`,
      'normal',
      'vcs-commit',
    );
  } else if (commits > 0 && deferred > 0) {
    const repoWord = deferred === 1 ? 'repo' : 'repos';
    notify(
      `✓ cairn — ${commits} commit${commits === 1 ? '' : 's'} saved (offline)`,
      `Push deferred for ${deferred} ${repoWord} — will sync automatically when back online`,
      'normal',
      'network-offline',
    );
  } else if (commits > 0) {
    const repoCount = reports.filter((r) => r.commits.length > 0).length;
    const repoWord = repoCount === 1 ? 'repo' : 'repos';
    notify(
      `✓ cairn — ${commits} commit${commits === 1 ? '' : 's'} saved`,
      `Changes committed across ${repoCount} ${repoWord} (not yet pushed)`,
      'normal',
      'vcs-locally-modified',
    );
  } else if (deferred > 0) {
    const repoWord = deferred === 1 ? 'repo' : 'repos';
    notify(
      `↻ cairn — push deferred (offline)`,
      `${deferred} ${repoWord} will sync to remote when back online`,
      'normal',
      'network-offline',
    );
  } else {
    const repoWord = pushed === 1 ? 'repo' : 'repos';
    notify(
      `✓ cairn — ${pushed} ${repoWord} pushed`,
      `Pending commits synced to remote`,
      'normal',
      'vcs-push',
    );
  }
};

async function logPushes(config: Config, reports: RepoReport[]): Promise<void> {
  for (const report of reports) {
    if (!report.push) continue;
    const { status, detail } = report.push;
    if (status !== 'pushed' && status !== 'failed' && status !== 'deferred') continue;
    if (detail === NOTHING_TO_PUSH) continue;

    const resolved = resolveRepoPath(report.path);
    const matched = config.repos.find((r) => resolveRepoPath(r.path) === resolved);
    const remote = matched?.remote ?? 'origin';
    const branch = matched?.branch ?? '-';

    let commits = 0;
    if (status === 'pushed') {
      const match = /^(\d+)/.exec(detail);
      commits = match ? parseInt(match[1], 10) : report.commits.length;
    }

    const record: PushRecord = {
      at: new Date().toISOString(),
      repo: resolved,
      remote,
      branch,
      status,
      commits,
      detail,
    };

    try {
      await recordPush(record);
    } catch {}
  }
}

function renderReports(
  config: Config,
  reports: RepoReport[],
  apply: boolean,
  elapsedMs: number,
  showScanHint: boolean,
): void {
  const colors = createColors(colorEnabled());
  const title = apply ? 'cairn run' : 'cairn scan';
  intro(title);

  if (reports.length === 0) {
    outro('No repositories configured');
    return;
  }

  for (const report of reports) {
    const base = path.basename(report.path);
    const repoName = base.charAt(0).toUpperCase() + base.slice(1);
    const branchTag = report.branch ? colors.cyan(`[${report.branch}]`) : '';
    const isPrimary = config.primary && (report.path === config.primary || resolveRepoPath(report.path) === resolveRepoPath(config.primary));
    const primaryTag = isPrimary ? colors.yellow('★ primary') : '';
    const header = [repoName, branchTag, primaryTag].filter(Boolean).join(' ');

    if (report.status === 'clean') {
      log.message(`${colors.dim(repoName)}  ${branchTag}  ${primaryTag ? `${primaryTag}  ` : ''}${colors.green('● clean')}`.trim());
      continue;
    }

    if (report.status === 'skipped') {
      log.warn(`${header} · skipped: ${report.reason ?? 'no reason provided'}`);
      continue;
    }

    if (report.status === 'failed') {
      log.error(`${header} · failed: ${report.reason ?? 'unknown error'}`);
      continue;
    }

    const lines: string[] = [];
    const action = apply
      ? colors.green(`✓ made ${report.commits.length} commit${report.commits.length === 1 ? '' : 's'}`)
      : colors.cyan(`➜ would commit ${report.commits.length} commit${report.commits.length === 1 ? '' : 's'}`);
    const pushInfo = report.push ? colors.dim(`(${report.push.detail})`) : '';
    lines.push(`${action}  ${pushInfo}`.trim());

    for (const commit of report.commits) {
      const sha = commit.sha ? `${colors.dim(commit.sha.slice(0, 7))}  ` : '';
      lines.push(`  ${colors.dim('•')} ${sha}${commit.message}`);
    }

    if (report.push && report.push.status !== 'planned' && report.push.status !== 'pushed') {
      lines.push(colors.yellow(`  ⚠ push: ${report.push.detail}`));
    }

    for (const item of report.excluded) {
      lines.push(colors.yellow(`  ⚠ excluded ${item.path} (${item.reason})`));
    }

    if (report.deferred > 0) {
      lines.push(colors.dim(`  ↻ left ${report.deferred} file${report.deferred === 1 ? '' : 's'} for next run`));
    }

    note(lines.join('\n'), header);
  }

  const counts = new Map<RepoReport['status'], number>();
  for (const r of reports) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const parts = (['committed', 'planned', 'clean', 'skipped', 'failed'] as const)
    .filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`);

  const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`;
  const summary = `${reports.length} repo${reports.length === 1 ? '' : 's'} · ${parts.join(' · ')} (${elapsed})`;
  const hint = showScanHint ? `  ${colors.cyan('run with --apply to commit')}` : '';
  outro(`${summary}${hint}`);
}

async function execute(options: ExecuteOptions): Promise<void> {
  const config = await loadConfig(configFile());
  let elapsedMs = 0;
  const reporting = options.apply && !options.json;
  const progress = reporting
    ? createProgress({ color: colorEnabled(), live: Boolean(process.stdout.isTTY) })
    : undefined;
  let reports;
  try {
    const started = performance.now();
    reports = await runAll(config, {
      apply: options.apply,
      only: options.repo,
      due: options.due,
      onProgress: progress?.handle,
    });
    elapsedMs = performance.now() - started;
  } finally {
    progress?.stop();
  }
  if (options.apply) {
    await logPushes(config, reports);
  }
  if (options.apply && options.notify !== false && !options.json) announce(reports);
  if (options.json) {
    console.log(JSON.stringify({ apply: options.apply, reports }, null, 2));
  } else {
    renderReports(config, reports, options.apply, elapsedMs, Boolean(options.showScanHint));
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
      intro('cairn init');
      outro(`Created configuration file at ${file}`);
    }),
  );

const aiCommand = program.command('ai').description('AI commit message tools');

aiCommand
  .command('check')
  .description('test the AI provider with a sample diff')
  .action(
    command(async () => {
      intro('cairn ai check');
      const config = await loadConfig(configFile());
      const aiConfig = config.commit.ai;
      note(`Model:   ${aiConfig.model}\nBase:    ${aiConfig.baseUrl}`, 'AI Configuration');
      if (!aiConfig.enabled) throw new Error('AI is disabled, set commit.ai.enabled to true in your config');
      const result = await checkAi(aiConfig);
      if (!result.ok) throw new Error(`AI check failed: ${result.error}`);
      outro(`AI check passed: ${result.message}`);
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
      intro('cairn add');
      outro(`Added repository ${formatRepoName(root)} (${root})`);
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
      if (config.primary && resolveRepoPath(config.primary) === resolved) {
        delete config.primary;
      }
      await saveConfig(config, configFile());
      intro('cairn remove');
      outro(`Removed repository ${formatRepoName(resolved)}`);
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
  .option('--no-notify', 'skip the desktop notification')
  .action(
    command(
      async (options: {
        apply?: boolean;
        due?: boolean;
        dryRun?: boolean;
        repo?: string;
        json?: boolean;
        notify: boolean;
      }) => {
        if (options.apply && options.dryRun) throw new Error('--apply and --dry-run cannot be combined');
        const config = await loadConfig(configFile());
        const apply = options.apply ? true : options.dryRun ? false : !config.dryRun;

        let release: (() => Promise<void>) | undefined;
        let cleaningUp = false;
        const onSignal = async () => {
          if (cleaningUp) return;
          cleaningUp = true;
          try {
            if (release) await release();
          } finally {
            process.exit(130);
          }
        };

        try {
          try {
            release = await acquireLock();
          } catch (error) {
            if (error instanceof LockHeldError) {
              console.log(error.message);
              return;
            }
            throw error;
          }

          process.on('SIGINT', onSignal);
          process.on('SIGTERM', onSignal);

          await execute({ apply, due: options.due, repo: options.repo, json: options.json, notify: options.notify });
        } finally {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          if (release) {
            await release();
          }
        }
      },
    ),
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
      intro('cairn install');
      note(`Schedule: daily at ${time}\nMode:     ${options.apply ? 'commit and push' : 'dry run only'}\nCron:     ${line}`, 'Cron Setup');
      outro('Successfully installed cron job');
    }),
  );

program
  .command('uninstall')
  .description('remove the cron job')
  .action(
    command(async () => {
      intro('cairn uninstall');
      const existing = await readCrontab();
      if (!hasCronBlock(existing)) {
        outro('No cairn cron job found');
        return;
      }
      await writeCrontab(stripCrontab(existing));
      outro('Successfully removed the cron job');
    }),
  );

program
  .command('status')
  .description('show config, schedule and run state')
  .action(
    command(async () => {
      intro('cairn status');
      const file = configFile();
      const present = await exists(file);
      const lines: string[] = [`Config:       ${file}${present ? '' : ' (missing)'}`];
      if (present) {
        const config = await loadConfig(file);
        const primary = config.primary ? formatRepoName(config.primary) : 'none';
        lines.push(
          `Repos:        ${config.repos.length} (${config.repos.filter((r) => r.enabled).length} enabled)`,
          `Primary:      ${primary}`,
          `Default mode: ${config.dryRun ? 'dry run' : 'apply'}`,
          `Schedule:     ${config.schedule.time}`,
        );
      }
      const cron = await readCrontab().catch(() => '');
      lines.push(
        `Cron:         ${hasCronBlock(cron) ? 'installed' : 'not installed'}`,
        `Running now:  ${(await isLocked(lockPath())) ? 'yes' : 'no'}`,
        `Cron log:     ${cronLogPath()}`,
      );
      note(lines.join('\n'), 'System Status');
      outro('Status check complete');
    }),
  );

registerPrimary(program, configFile);
registerHistory(program);

await program.parseAsync(process.argv);
