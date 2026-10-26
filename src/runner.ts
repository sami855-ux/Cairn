import path from 'node:path';
import { suggestMessage, truncateDiff } from './ai.js';
import type { Config, RepoConfig } from './config.js';
import { buildCommitMessage, commitChanges, splitChanges } from './commit.js';
import { isDue, localDate } from './due.js';
import { isRemoteReachable } from './net.js';
import { resolveRepoPath } from './paths.js';
import type { ProgressEvent } from './progress.js';
import { getRemoteUrl, NOTHING_TO_PUSH, pushBranch } from './push.js';
import { buildPlan } from './safety.js';
import { openGit, scanRepo } from './scanner.js';
import { loadState, saveState } from './state.js';
import type { PushOutcome, RepoReport } from './types.js';
import { errorText } from './util.js';

export interface RepoRun {
  pending: string[];
}

type Emit = (event: ProgressEvent) => void;

function blankReport(path: string, branch: string | null, status: RepoReport['status'], reason?: string): RepoReport {
  return { path, branch, status, reason, files: 0, deferred: 0, excluded: [], commits: [] };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function suggestWithRetry(ai: Config['commit']['ai'], files: string[], diff: string) {
  let result = await suggestMessage(ai, files, diff);
  for (let attempt = 1; attempt <= 2 && !('message' in result); attempt++) {
    await sleep(3000 * attempt);
    result = await suggestMessage(ai, files, diff);
  }
  return result;
}

async function inspect(
  repo: RepoConfig,
  config: Config,
  apply: boolean,
  run: RepoRun,
  emit?: Emit,
): Promise<RepoReport> {
  const scan = await scanRepo(repo, config);
  const report = blankReport(scan.root, scan.branch, 'skipped');
  if (scan.skipReason) return { ...report, reason: scan.skipReason };

  const name = path.basename(scan.root);
  const branch = scan.branch as string;
  const git = openGit(scan.root, config.push.timeoutSeconds, (stage, percent) =>
    emit?.({ type: 'push', repo: name, stage, percent }),
  );
  const plan = await buildPlan(scan.root, scan.changes, config);
  report.excluded = plan.excluded;

  const publish = async (): Promise<PushOutcome> => {
    const only = config.push.includePending ? undefined : new Set(run.pending);

    // Probe the remote host before attempting to push.
    const remoteUrl = await getRemoteUrl(git, repo.remote);
    const online = remoteUrl ? await isRemoteReachable(remoteUrl) : true;
    if (!online) {
      emit?.({ type: 'failed', repo: name, message: 'offline — push deferred to next run' });
      return { status: 'deferred', detail: `${repo.remote} is unreachable — pending commits will be pushed when back online` };
    }

    const outcome = await pushBranch(git, repo.remote, branch, only);
    if (outcome.status === 'pushed' || outcome.detail === NOTHING_TO_PUSH) run.pending.length = 0;
    if (outcome.status === 'pushed') emit?.({ type: 'pushed', repo: name, remote: repo.remote });
    if (outcome.status === 'failed') emit?.({ type: 'failed', repo: name, message: outcome.detail ?? 'push failed' });
    return outcome;
  };

  if (plan.state === 'blocked') return { ...report, reason: plan.reason };

  if (plan.state === 'clean') {
    report.status = 'clean';
    const hasPending = config.push.includePending ? scan.ahead > 0 : run.pending.length > 0;
    if (apply && repo.push && scan.behind === 0 && hasPending) {
      emit?.({ type: 'repo-start', repo: name, files: 0 });
      report.push = await publish();
    }
    return report;
  }

  const groups = splitChanges(plan.safe, config.commit.split, config.commit.maxCommitsPerRun);
  report.files = groups.reduce((total, group) => total + group.length, 0);
  report.deferred = plan.safe.length - report.files;
  const messages = groups.map((group) => buildCommitMessage(group, config.commit.messageTemplate));

  if (!apply) {
    report.status = 'planned';
    report.commits = messages.map((message) => ({ message }));
    if (repo.push) {
      const foreign = config.push.includePending ? 0 : Math.max(0, scan.ahead - run.pending.length);
      if (foreign > 0) {
        report.push = {
          status: 'skipped',
          detail: `${foreign} unpushed commit(s) were not made by cairn, enable push.includePending to publish them`,
        };
      } else if (scan.behind > 0) {
        report.push = { status: 'skipped', detail: `branch is ${scan.behind} commit(s) behind its upstream` };
      } else {
        report.push = { status: 'planned', detail: `would push to ${repo.remote}/${branch}` };
      }
    }
    return report;
  }

  const ai = config.commit.ai;
  let aiFailures = 0;
  
  emit?.({ type: 'repo-start', repo: name, files: groups.length });
  for (const [index, group] of groups.entries()) {
    const state: { used: boolean; error?: string } = { used: false };
    const compose =
      ai.enabled && aiFailures < 3
        ? async (diff: string): Promise<string | null> => {
            const result = await suggestWithRetry(
              ai,
              group.map((c) => c.path),
              truncateDiff(diff, ai.maxDiffBytes),
            );
            if ('message' in result) {
              state.used = true;
              aiFailures = 0;
              return result.message;
            }
            state.error = result.error;
            aiFailures++;
            return null;
          }
        : undefined;
    try {
      const done = await commitChanges(git, group, messages[index], compose);
      run.pending.push(done.sha);
      report.commits.push({
        sha: done.sha,
        message: done.message,
        source: state.used ? 'ai' : 'rules',
        ...(state.error ? { aiError: state.error } : {}),
      });
      emit?.({
        type: 'commit',
        repo: name,
        file: group.length === 1 ? group[0].path : `${group.length} files`,
        done: index + 1,
        files: groups.length,
      });
    } catch (error) {
      const detail = errorText(error);
      const reason =
        report.commits.length > 0 ? `committed ${report.commits.length} of ${groups.length}, then: ${detail}` : detail;
      emit?.({ type: 'failed', repo: name, message: reason });
      return { ...report, status: 'failed', reason };
    }
  }

  report.status = 'committed';
  if (repo.push) {
    report.push =
      scan.behind > 0
        ? { status: 'skipped', detail: `branch is ${scan.behind} commit(s) behind its upstream` }
        : await publish();
  }
  return report;
}

export async function processRepo(
  repo: RepoConfig,
  config: Config,
  apply: boolean,
  run: RepoRun = { pending: [] },
  emit?: Emit,
): Promise<RepoReport> {
  const repoPath = resolveRepoPath(repo.path);
  if (!repo.enabled) return blankReport(repoPath, null, 'skipped', 'disabled');
  try {
    return await inspect(repo, config, apply, run, emit);
  } catch (error) {
    emit?.({ type: 'failed', repo: path.basename(repoPath), message: errorText(error) });
    return blankReport(repoPath, null, 'failed', errorText(error));
  }
}

const finished = (report: RepoReport): boolean => report.status !== 'failed' && report.push?.status !== 'failed';

export interface RunOptions {
  apply: boolean;
  only?: string;
  due?: boolean;
  now?: Date;
  stateFile?: string;
  onProgress?: Emit;
}

export async function runAll(config: Config, options: RunOptions): Promise<RepoReport[]> {
  const target = options.only ? resolveRepoPath(options.only) : null;
  const repos = target ? config.repos.filter((r) => resolveRepoPath(r.path) === target) : config.repos;
  const now = options.now ?? new Date();
  const key = options.apply ? 'lastDone' : 'lastPreview';
  const state = await loadState(options.stateFile);
  const reports: RepoReport[] = [];

  for (const repo of repos) {
    const id = resolveRepoPath(repo.path);
    if (options.due && !isDue(repo, config, state[id], now, key)) continue;
    const entry = state[id] ?? { pending: [] };
    const report = await processRepo(repo, config, options.apply, entry, options.onProgress);
    if (options.due && finished(report)) entry[key] = localDate(now);
    state[id] = entry;
    if (options.apply || options.due) await saveState(state, options.stateFile);
    reports.push(report);
  }
  return reports;
}