import { describe, expect, it } from 'vitest';
import { matchesAny } from '../src/glob.js';

describe('matchesAny', () => {
  it('matches basenames at any depth', () => {
    expect(matchesAny('.env', ['.env'])).toBe(true);
    expect(matchesAny('apps/api/.env', ['.env'])).toBe(true);
    expect(matchesAny('apps/api/.env.local', ['.env.*'])).toBe(true);
    expect(matchesAny('keys/server.pem', ['*.pem'])).toBe(true);
  });

  it('matches directory globs', () => {
    expect(matchesAny('a/b/node_modules/x/y.js', ['**/node_modules/**'])).toBe(true);
    expect(matchesAny('node_modules/x.js', ['**/node_modules/**'])).toBe(true);
    expect(matchesAny('.aws/credentials', ['**/.aws/**'])).toBe(true);
  });

  it('does not over match', () => {
    expect(matchesAny('src/environment.ts', ['.env', '.env.*'])).toBe(false);
    expect(matchesAny('src/keyboard.ts', ['*.key'])).toBe(false);
    expect(matchesAny('docs/node_modules.md', ['**/node_modules/**'])).toBe(false);
  });
});
