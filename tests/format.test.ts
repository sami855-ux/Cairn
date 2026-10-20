import { describe, expect, it } from 'vitest';
import { formatReport, formatSummary } from '../src/format.js';
import type { RepoReport } from '../src/types.js';

const report = (overrides: Partial<RepoReport> = {}): RepoReport => ({
  path: '/home/sam/app',
  branch: 'main',
  status: 'committed',
  files: 1,
  deferred: 0,
  excluded: [],
  commits: [{ sha: '8e366020', message: 'docs: update README.md' }],
  ...overrides,
});

describe('formatReport', () => {
  it('uses singular wording for one applied commit', () => {
    expect(formatReport(report(), { color: false })).toContain('made 1 commit');
  });

  it('uses plural wording and dry-run verbs', () => {
    expect(
      formatReport(
        report({ status: 'planned', commits: [{ message: 'first' }, { message: 'second' }], push: { status: 'planned', detail: 'would push to origin/main' } }),
        { color: false },
      ),
    ).toContain('would commit 2 commits');
    expect(
      formatReport(report({ status: 'planned', push: { status: 'planned', detail: 'would push to origin/main' } }), { color: false }),
    ).toContain('would push to origin/main');
  });

  it('uses real-run wording and no ANSI codes when color is off', () => {
    const output = formatReport(report({ push: { status: 'pushed', detail: '1 commit(s) to origin/main' } }), { color: false });
    expect(output).toContain('pushed 1 commit to origin/main');
    expect(output).not.toMatch(/\x1B\[/);
  });
});

describe('formatSummary', () => {
  it('pluralizes repository counts and includes elapsed time', () => {
    expect(formatSummary([report(), report()], { color: false, apply: true, elapsedMs: 1200 })).toBe('  2 repos  ·  2 committed   done in 1.2s');
  });
});
