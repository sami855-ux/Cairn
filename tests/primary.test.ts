import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { cancel, intro, isCancel, outro, select } from '@clack/prompts';
import { ConfigError, loadConfig, parseConfig, saveConfig } from '../src/config.js';
import { runAll } from '../src/runner.js';
import { clearPrimary, interactivePrimary, registerPrimary, setPrimary } from '../src/primary-command.js';
import { makeRepo } from './helpers.js';

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  select: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn((val) => val === '__CANCEL__'),
}));

describe('primary repository', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-primary-test-'));
    configFile = path.join(tmpDir, 'config.json');
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  it('rejects a primary repository that is not in repos', () => {
    expect(() =>
      parseConfig({
        repos: [{ path: '/tmp/repo1' }],
        primary: '/tmp/nonexistent',
      }),
    ).toThrow(ConfigError);

    expect(() =>
      parseConfig({
        repos: [{ path: '/tmp/repo1' }],
        primary: '/tmp/nonexistent',
      }),
    ).toThrow(/primary repository.*is not in repos/);

    const valid = parseConfig({
      repos: [{ path: '/tmp/repo1' }],
      primary: '/tmp/repo1',
    });
    expect(valid.primary).toBe('/tmp/repo1');
  });

  it('runs repos in config order when no primary is set', async () => {
    const one = makeRepo();
    const two = makeRepo();
    const three = makeRepo();
    const stateFile = path.join(tmpDir, 'state.json');

    try {
      const cfg = parseConfig({
        repos: [{ path: one.dir }, { path: two.dir }, { path: three.dir }],
      });
      const reports = await runAll(cfg, { apply: false, stateFile });
      const real = fs.realpathSync;
      expect(reports.map((r) => r.path)).toEqual([real(one.dir), real(two.dir), real(three.dir)]);
    } finally {
      fs.rmSync(one.root, { recursive: true, force: true });
      fs.rmSync(two.root, { recursive: true, force: true });
      fs.rmSync(three.root, { recursive: true, force: true });
    }
  });

  it('runs the primary repo first when primary is set', async () => {
    const one = makeRepo();
    const two = makeRepo();
    const three = makeRepo();
    const stateFile = path.join(tmpDir, 'state.json');

    try {
      const cfg = parseConfig({
        primary: two.dir,
        repos: [{ path: one.dir }, { path: two.dir }, { path: three.dir }],
      });
      const reports = await runAll(cfg, { apply: false, stateFile });
      const real = fs.realpathSync;
      expect(reports.map((r) => r.path)).toEqual([real(two.dir), real(one.dir), real(three.dir)]);
    } finally {
      fs.rmSync(one.root, { recursive: true, force: true });
      fs.rmSync(two.root, { recursive: true, force: true });
      fs.rmSync(three.root, { recursive: true, force: true });
    }
  });

  it('handles set and clear behavior directly and via CLI', async () => {
    const cfg = parseConfig({
      repos: [{ path: '/tmp/repo1' }, { path: '/tmp/repo2' }],
    });
    await saveConfig(cfg, configFile);

    await setPrimary('/tmp/repo2', configFile);
    let updated = await loadConfig(configFile);
    expect(updated.primary).toBe('/tmp/repo2');

    await expect(setPrimary('/tmp/unconfigured', configFile)).rejects.toThrow(
      '/tmp/unconfigured is not a configured repository',
    );

    await clearPrimary(configFile);
    updated = await loadConfig(configFile);
    expect(updated.primary).toBeUndefined();

    const program1 = new Command();
    registerPrimary(program1, () => configFile);
    await program1.parseAsync(['node', 'cairn', 'primary', 'set', '/tmp/repo1']);
    updated = await loadConfig(configFile);
    expect(updated.primary).toBe('/tmp/repo1');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program2 = new Command();
    registerPrimary(program2, () => configFile);
    process.exitCode = 0;
    await program2.parseAsync(['node', 'cairn', 'primary', 'set', '/tmp/missing']);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();

    const program3 = new Command();
    registerPrimary(program3, () => configFile);
    await program3.parseAsync(['node', 'cairn', 'primary', 'clear']);
    updated = await loadConfig(configFile);
    expect(updated.primary).toBeUndefined();
  });

  it('writes selected repository on interactive confirm', async () => {
    const cfg = parseConfig({
      repos: [{ path: '/tmp/repo1' }, { path: '/tmp/repo2' }],
    });
    await saveConfig(cfg, configFile);

    vi.mocked(select).mockResolvedValueOnce('/tmp/repo2');

    await interactivePrimary(configFile);

    const updated = await loadConfig(configFile);
    expect(updated.primary).toBe('/tmp/repo2');
    expect(intro).toHaveBeenCalled();
    expect(outro).toHaveBeenCalledWith(expect.stringContaining('Repo2'));
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: '/tmp/repo1', label: 'Repo1' }),
          expect.objectContaining({ value: '/tmp/repo2', label: 'Repo2' }),
          expect.objectContaining({ label: 'None (no primary)' }),
        ]),
      }),
    );
  });

  it('removes primary when None is selected interactively', async () => {
    const cfg = parseConfig({
      primary: '/tmp/repo1',
      repos: [{ path: '/tmp/repo1' }, { path: '/tmp/repo2' }],
    });
    await saveConfig(cfg, configFile);

    vi.mocked(select).mockResolvedValueOnce('');

    await interactivePrimary(configFile);

    const updated = await loadConfig(configFile);
    expect(updated.primary).toBeUndefined();
    expect(outro).toHaveBeenCalled();
  });

  it('leaves config untouched when interactive selection is cancelled', async () => {
    const cfg = parseConfig({
      primary: '/tmp/repo1',
      repos: [{ path: '/tmp/repo1' }, { path: '/tmp/repo2' }],
    });
    await saveConfig(cfg, configFile);

    vi.mocked(select).mockResolvedValueOnce('__CANCEL__');

    await interactivePrimary(configFile);

    const updated = await loadConfig(configFile);
    expect(updated.primary).toBe('/tmp/repo1');
    expect(cancel).toHaveBeenCalled();
    expect(outro).not.toHaveBeenCalled();
  });

  it('exits without prompting when no repositories are configured', async () => {
    const cfg = parseConfig({ repos: [] });
    await saveConfig(cfg, configFile);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await interactivePrimary(configFile);

    expect(select).not.toHaveBeenCalled();
    expect(intro).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/no repositories configured/i));
    logSpy.mockRestore();
  });
});
