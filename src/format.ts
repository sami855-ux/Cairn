import path from 'node:path';
import { createColors } from 'picocolors';
import type { RepoReport } from './types.js';

export interface FormatOptions {
  color: boolean;
}

export interface SummaryOptions extends FormatOptions {
  apply: boolean;
  elapsedMs: number;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const withCommitPlural = (value: string): string => value.replace(/(\d+) commit\(s\)/g, (_, count: string) => plural(Number(count), 'commit'));

function commitLines(report: RepoReport, planned: boolean, options: FormatOptions): string[] {
  const colors = createColors(options.color);
  if (report.commits.length === 0) return [];
  const action = planned ? colors.cyan('➜') : colors.green('✓');
  const verb = planned ? 'would commit' : 'made';
  return [
    `  ${action}  ${verb} ${plural(report.commits.length, 'commit')}`,
    ...report.commits.map((commit) => `  ${colors.dim(commit.sha?.slice(0, 7) ?? '')}  ${commit.message}`),
  ];
}

export function formatHeader(version: string, apply: boolean, options: FormatOptions): string {
  const colors = createColors(options.color);
  return `  ${colors.bold(colors.cyan('GIT-CONTRIBUTE'))}  ${colors.dim(`v${version}`)}  ${apply ? colors.green('apply') : colors.dim('dry run')}`;
}

export function formatReport(report: RepoReport, options: FormatOptions): string {
  const colors = createColors(options.color);
  const name = path.basename(report.path);
  const lines = [
    `  ${colors.cyan('➜')}  ${colors.bold(name)}  ${colors.dim(report.path)}${report.branch ? `  ${colors.dim(report.branch)}` : ''}`,
  ];
  switch (report.status) {
    case 'clean':
      lines.push(`  ${colors.dim('nothing to commit')}`);
      break;
    case 'skipped':
      lines.push(`  ${colors.dim(`↷  skipped: ${report.reason ?? 'no reason provided'}`)}`);
      break;
    case 'failed':
      lines.push(`  ${colors.red(`✗  failed: ${report.reason ?? 'no reason provided'}`)}`);
      lines.push(...commitLines(report, false, options));
      break;
    case 'planned':
      lines.push(...commitLines(report, true, options));
      break;
    case 'committed':
      lines.push(...commitLines(report, false, options));
      break;
  }
  if (report.push) {
    const detail = withCommitPlural(report.push.detail);
    if (report.push.status === 'pushed') lines.push(`  ${colors.green(`✓  pushed ${detail}`)}`);
    if (report.push.status === 'planned') lines.push(`  ${colors.cyan(`➜  ${detail}`)}`);
    if (report.push.status === 'skipped') lines.push(`  ${colors.yellow(`⚠  push skipped: ${detail}`)}`);
    if (report.push.status === 'failed') lines.push(`  ${colors.red(`✗  push failed: ${detail}`)}`);
  }
  for (const item of report.excluded) {
    lines.push(`  ${colors.yellow('⚠')}  excluded  ${colors.bold(item.path)}  ${colors.dim(item.reason)}`);
  }
  if (report.deferred > 0) lines.push(`  ${colors.dim(`left ${plural(report.deferred, 'file')} for the next run`)}`);
  return lines.join('\n');
}

export function formatSummary(reports: RepoReport[], options: SummaryOptions): string {
  const colors = createColors(options.color);
  const order: RepoReport['status'][] = ['committed', 'planned', 'clean', 'skipped', 'failed'];
  const counts = new Map<RepoReport['status'], number>();
  for (const report of reports) counts.set(report.status, (counts.get(report.status) ?? 0) + 1);
  const parts = order
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status) ?? 0} ${status}`);
  const elapsed = `${(options.elapsedMs / 1000).toFixed(1)}s`;
  return `  ${colors.green(plural(reports.length, 'repo'))}${parts.length ? `  ${colors.dim('·')}  ${parts.join(`  ${colors.dim('·')}  `)}` : ''}   ${colors.dim(`done in ${elapsed}`)}`;
}

export function formatSuccess(message: string, options: FormatOptions): string {
  return `  ${createColors(options.color).green('✓')}  ${message}`;
}

export function formatError(message: string, options: FormatOptions): string {
  return `${createColors(options.color).red('✗ error:')} ${message}`;
}

export function formatLabel(label: string, value: string, options: FormatOptions): string {
  const colors = createColors(options.color);
  return `  ${colors.dim(`${label}:`.padEnd(14))} ${value}`;
}
