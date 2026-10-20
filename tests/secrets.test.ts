import { describe, expect, it } from 'vitest';
import { findSecrets, isBinary } from '../src/secrets.js';

describe('findSecrets', () => {
  it('detects well known token shapes', () => {
    expect(findSecrets(`id = ${'AKIA' + 'ABCDEFGHIJKLMNOP'}`)[0]?.rule).toBe('AWS access key id');
    expect(findSecrets(`t = ${'ghp_' + 'a'.repeat(36)}`)[0]?.rule).toBe('GitHub token');
    expect(findSecrets('-----BEGIN ' + 'RSA PRIVATE KEY-----')[0]?.rule).toBe('private key');
    expect(findSecrets(`k = ${'sk_live_' + 'a1B2c3D4e5F6g7H8'}`)[0]?.rule).toBe('Stripe live key');
  });

  it('detects hardcoded secrets and URL credentials', () => {
    const assigned = 'const apiKey = "' + 'Zx9Qw8Er7Ty6Ui5Op4As' + '";';
    expect(findSecrets(assigned)[0]?.rule).toBe('hardcoded secret');
    const url = 'DATABASE_URL=postgres://app:' + 'k3Jd9sLq2Zp@db.internal:5432/app';
    expect(findSecrets(url)[0]?.rule).toBe('credentials in URL');
  });

  it('reports the line number', () => {
    const text = ['a', 'b', 'const token = "' + 'Zx9Qw8Er7Ty6Ui5Op4As' + '"'].join('\n');
    expect(findSecrets(text)[0]?.line).toBe(3);
  });

  it('ignores placeholders, env lookups and i18n keys', () => {
    expect(findSecrets('password: "your-password-here-1234"')).toEqual([]);
    expect(findSecrets('const key = process.env.API_KEY')).toEqual([]);
    expect(findSecrets("password: 'auth.errors.password'")).toEqual([]);
    expect(findSecrets('DATABASE_URL=postgresql://user:password@localhost:5432/db')).toEqual([]);
    expect(findSecrets('export function add(a: number, b: number) { return a + b }')).toEqual([]);
  });
});

describe('isBinary', () => {
  it('flags buffers containing NUL bytes', () => {
    expect(isBinary(Buffer.from([1, 2, 0, 3]))).toBe(true);
    expect(isBinary(Buffer.from('plain text'))).toBe(false);
  });
});
