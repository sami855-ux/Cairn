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
import { cancel, intro, isCancel, log, note, outro, select, text } from '@clack/prompts';
import { recordPush, type PushRecord } from './history.js';
import { registerHistory } from './history-command.js';
import { formatRepoName, registerPrimary } from './primary-command.js';
import { runAll } from './runner.js';
import { openGit } from './scanner.js';
import { exists, openFolderDialog } from './util.js';
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
  .command('add [path]')
  .description('add a repository to the config')
  .option('--remote <name>', 'remote to push to', 'origin')
  .option('--branch <name>', 'only commit on this branch')
  .option('--no-push', 'commit locally without pushing')
  .option('-e, --explorer', 'choose repository folder in file explorer')
  .action(
    command(async (target: string | undefined, options: { remote: string; branch?: string; push: boolean; explorer?: boolean }) => {
      let repoTarget = target;
      if (!repoTarget && options.explorer) {
        intro('cairn add');
        const picked = await openFolderDialog();
        if (!picked) {
          cancel('No folder selected.');
          return;
        }
        repoTarget = picked;
      } else if (!repoTarget) {
        intro('cairn add');
        const hasGui = Boolean(
          process.platform === 'darwin' ||
          process.platform === 'win32' ||
          (process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)),
        );

        const method = await select({
          message: 'Select repository folder',
          options: [
            { value: 'current', label: 'Current directory', hint: path.basename(process.cwd()) || process.cwd() },
            ...(hasGui
              ? [{ value: 'explorer', label: 'Choose in file explorer...', hint: 'open dialog' }]
              : []),
            { value: 'manual', label: 'Enter path manually...', hint: 'type folder' },
          ],
        });

        if (isCancel(method)) {
          cancel('Operation cancelled.');
          return;
        }

        if (method === 'current') {
          repoTarget = process.cwd();
        } else if (method === 'explorer') {
          const picked = await openFolderDialog();
          if (!picked) {
            cancel('No folder selected.');
            return;
          }
          repoTarget = picked;
        } else {
          const input = await text({
            message: 'Repository path',
            placeholder: '.',
            defaultValue: '.',
            validate: (value) => {
              if (!value || value.trim().length === 0) return 'Path is required';
            },
          });
          if (isCancel(input)) {
            cancel('Operation cancelled.');
            return;
          }
          repoTarget = input.trim();
        }
      } else {
        intro('cairn add');
      }

      const config = await loadConfig(configFile());
      const dir = resolveRepoPath(repoTarget);
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
      outro(`Added repository ${formatRepoName(root)} (${root})`);
    }),
  );

program
  .command('remove [path]')
  .description('remove a repository from the config')
  .action(
    command(async (target: string | undefined) => {
      const config = await loadConfig(configFile());
      let toRemove = target;

      if (!toRemove) {
        intro('cairn remove');
        if (config.repos.length === 0) {
          outro('No repositories configured');
          return;
        }

        const choice = await select({
          message: 'Select repository to remove',
          options: config.repos.map((r) => {
            const isPrimary = config.primary && (r.path === config.primary || resolveRepoPath(r.path) === resolveRepoPath(config.primary));
            return {
              value: r.path,
              label: formatRepoName(r.path),
              hint: isPrimary ? '★ primary' : r.path,
            };
          }),
        });

        if (isCancel(choice)) {
          cancel('Operation cancelled.');
          return;
        }

        toRemove = choice;
      } else {
        intro('cairn remove');
      }

      const resolved = resolveRepoPath(toRemove);
      const matched = config.repos.find(
        (r) =>
          r.path === toRemove ||
          resolveRepoPath(r.path) === resolved ||
          path.basename(r.path).toLowerCase() === toRemove.toLowerCase(),
      );

      if (!matched) throw new Error(`${toRemove} is not configured`);

      const matchedPath = matched.path;
      config.repos = config.repos.filter((r) => r.path !== matchedPath && resolveRepoPath(r.path) !== resolveRepoPath(matchedPath));

      if (config.primary && (config.primary === matchedPath || resolveRepoPath(config.primary) === resolveRepoPath(matchedPath))) {
        delete config.primary;
      }

      await saveConfig(config, configFile());
      outro(`Removed repository ${formatRepoName(matchedPath)}`);
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
      const colors = createColors(colorEnabled());

      const rows = config.repos.map((repo) => {
        const full = resolveRepoPath(repo.path);
        const isPrimary = config.primary && (repo.path === config.primary || resolveRepoPath(repo.path) === resolveRepoPath(config.primary));

        return {
          name: formatRepoName(repo.path),
          full,
          enabled: repo.enabled,
          remote: repo.remote,
          branch: repo.branch ?? '—',
          push: repo.push,
          isPrimary: Boolean(isPrimary),
          time: repo.time,
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
              primary: row.isPrimary,
            })),
            null,
            2,
          ),
        );
        return;
      }

      intro('cairn list');

      if (rows.length === 0) {
        outro('No repositories configured. Run "cairn add" to add one.');
        return;
      }

      for (const row of rows) {
        const primaryBadge = row.isPrimary ? `  ${colors.yellow('★ primary')}` : '';
        const branchTag = row.branch !== '—' ? `  ${colors.cyan(`[${row.branch}]`)}` : '';
        const statusDot = row.enabled ? colors.green('●') : colors.red('○');
        const pushText = row.push ? colors.dim(`→ ${row.remote}`) : colors.dim('(no push)');
        const timeText = row.time ? colors.dim(`· ${row.time}`) : '';

        log.step(
          `${colors.bold(row.name)}${branchTag}${primaryBadge}\n${statusDot} ${colors.dim(row.full)}  ${pushText} ${timeText}`.trim(),
        );
      }

      const enabled = rows.filter((r) => r.enabled).length;
      const pushing = rows.filter((r) => r.enabled && r.push).length;
      outro(`${rows.length} repositor${rows.length === 1 ? 'y' : 'ies'} · ${enabled} enabled · ${pushing} pushing`);
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
