import { describe, expect, it } from 'vitest';
import { buildCommitMessage, inferType, splitChanges, summarize } from '../src/commit.js';
import type { FileChange } from '../src/types.js';

const change = (path: string, kind: FileChange['kind'] = 'modified'): FileChange => ({
  path,
  kind,
  staged: false,
  needsAdd: true,
});

describe('commit messages', () => {
  it('infers the type from file paths', () => {
    expect(inferType([change('README.md'), change('docs/guide.txt')])).toBe('docs');
    expect(inferType([change('src/a.test.ts'), change('tests/b.ts')])).toBe('test');
    expect(inferType([change('src/a.ts'), change('README.md')])).toBe('chore');
  });

  it('summarizes by count and kind', () => {
    expect(summarize([change('src/a.ts')])).toBe('update a.ts');
    expect(summarize([change('a.ts'), change('b.ts')])).toBe('update a.ts and b.ts');
    expect(summarize([change('a.ts'), change('b.ts'), change('c.ts')])).toBe('update a.ts, b.ts and c.ts');
    expect(summarize(['a', 'b', 'c', 'd', 'e'].map((n) => change(`${n}.ts`)))).toBe('update a.ts, b.ts, c.ts and 2 more');
    expect(summarize([change('a.ts', 'added')])).toBe('add a.ts');
    expect(summarize([change('a.ts', 'deleted')])).toBe('remove a.ts');
  });

  it('applies the template and caps the subject length', () => {
    expect(buildCommitMessage([change('a.ts')], '{type}: {summary}')).toBe('chore: update a.ts');
    expect(buildCommitMessage([change('a.ts'), change('b.ts')], 'sync {count} files')).toBe('sync 2 files');
    expect(buildCommitMessage([change('a.ts')], 'x'.repeat(200)).length).toBe(72);
  });
});

describe('splitChanges', () => {
  const files = ['a', 'b', 'c', 'd'].map((n) => change(`${n}.ts`));

  it('keeps one group when splitting is off or there is one file', () => {
    expect(splitChanges(files, 'none', 20)).toEqual([files]);
    expect(splitChanges([files[0]], 'file', 20)).toEqual([[files[0]]]);
  });

  it('makes one group per file', () => {
    expect(splitChanges(files, 'file', 20)).toEqual(files.map((f) => [f]));
  });

  it('stops at the cap and leaves the remaining files out', () => {
    expect(splitChanges(files, 'file', 2)).toEqual([[files[0]], [files[1]]]);
    expect(splitChanges(files, 'file', 1)).toEqual([[files[0]]]);
  });

  it('falls back to a single group when something is already staged', () => {
    const staged = [{ ...files[0], staged: true }, files[1]];
    expect(splitChanges(staged, 'file', 20)).toEqual([staged]);
  });
});
