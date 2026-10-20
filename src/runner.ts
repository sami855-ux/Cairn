import type { Config, RepoConfig } from './config.js';
import { buildCommitMessage, commitChanges, splitChanges } from './commit.js';
import { resolveRepoPath } from './paths.js';
import { pushBranch } from './push.js';
import { buildPlan } from './safety.js';
import { openGit, scanRepo } from './scanner.js';
import type { RepoReport, RepoScan } from './types.js';
import { errorText } from './util.js';

function pushGuard(scan: RepoScan, config: Config): string | null {
  if (scan.ahead > 0 && !config.push.includePending) {
    return `branch already has ${scan.ahead} unpushed commit(s), enable push.includePending to publish them`;
  }
  if (scan.behind > 0) return `branch is ${scan.behind} commit(s) behind its upstream`;
  return null;
}

function blankReport(path: string, branch: string | null, status: RepoReport['status'], reason?: string): RepoReport {
  return { path, branch, status, reason, files: 0, deferred: 0, excluded: [], commits: [] };
}

async function inspect(repo: RepoConfig, config: Config, apply: boolean): Promise<RepoReport> {
  const scan = await scanRepo(repo, config);
  const report = blankReport(scan.root, scan.branch, 'skipped');
  if (scan.skipReason) return { ...report, reason: scan.skipReason };

  const branch = scan.branch as string;
  const git = openGit(scan.root, config.push.timeoutSeconds);
  const plan = await buildPlan(scan.root, scan.changes, config);
  report.excluded = plan.excluded;

  if (plan.state === 'blocked') return { ...report, reason: plan.reason };

  if (plan.state === 'clean') {
    report.status = 'clean';
    if (apply && repo.push && config.push.includePending && scan.ahead > 0 && scan.behind === 0) {
      report.push = await pushBranch(git, repo.remote, branch);
    }
    return report;
  }

  const groups = splitChanges(plan.safe, config.commit.split, config.commit.maxCommitsPerRun);
  report.files = groups.reduce((total, group) => total + group.length, 0);
  report.deferred = plan.safe.length - report.files;
  const messages = groups.map((group) => buildCommitMessage(group, config.commit.messageTemplate));
  const guard = repo.push ? pushGuard(scan, config) : null;

  if (!apply) {
    report.status = 'planned';
    report.commits = messages.map((message) => ({ message }));
    if (repo.push) {
      report.push = guard
        ? { status: 'skipped', detail: guard }
        : { status: 'planned', detail: `would push to ${repo.remote}/${branch}` };
    }
    return report;
  }

  for (const [index, group] of groups.entries()) {
    try {
      const sha = await commitChanges(git, group, messages[index]);
      report.commits.push({ sha, message: messages[index] });
    } catch (error) {
      const detail = errorText(error);
      const reason =
        report.commits.length > 0 ? `committed ${report.commits.length} of ${groups.length}, then: ${detail}` : detail;
      return { ...report, status: 'failed', reason };
    }
  }

  report.status = 'committed';
  if (repo.push) {
    report.push = guard ? { status: 'skipped', detail: guard } : await pushBranch(git, repo.remote, branch);
  }
  return report;
}

export async function processRepo(repo: RepoConfig, config: Config, apply: boolean): Promise<RepoReport> {
  const repoPath = resolveRepoPath(repo.path);
  if (!repo.enabled) return blankReport(repoPath, null, 'skipped', 'disabled');
  try {
    return await inspect(repo, config, apply);
  } catch (error) {
    return blankReport(repoPath, null, 'failed', errorText(error));
  }
}

export async function runAll(config: Config, options: { apply: boolean; only?: string }): Promise<RepoReport[]> {
  const target = options.only ? resolveRepoPath(options.only) : null;
  const repos = target ? config.repos.filter((r) => resolveRepoPath(r.path) === target) : config.repos;
  const reports: RepoReport[] = [];
  for (const repo of repos) reports.push(await processRepo(repo, config, options.apply));
  return reports;
}
