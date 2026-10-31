import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editConfig, registerConfig } from '../src/config-command.js';
import { loadConfig, parseConfig, saveConfig } from '../src/config.js';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

describe('config editing', () => {
  const config = () => parseConfig({ repos: [{ path: '/repos/demo' }] });

  it('updates several typed settings while preserving unrelated configuration', () => {
    const original = config();
    const result = editConfig(original, ['time=18:30', 'ai=true', 'commit.maxCommitsPerRun=5', 'push.autoPull=true', 'allowedBranches=["main","develop"]']);
    expect(result.schedule.time).toBe('18:30');
    expect(result.commit.ai.enabled).toBe(true);
    expect(result.commit.maxCommitsPerRun).toBe(5);
    expect(result.push.autoPull).toBe(true);
    expect(result.allowedBranches).toEqual(['main', 'develop']);
    expect(result.repos).toEqual(original.repos);
    expect(original.schedule.time).toBe('21:00');
  });

  it('edits repository overrides and can return to the default schedule', () => {
    const edited = editConfig(config(), ['time=09:00', 'push=false', 'branch=develop'], 'demo');
    expect(edited.repos[0]).toMatchObject({ time: '09:00', push: false, branch: 'develop' });
    expect(editConfig(edited, ['time=null'], '/repos/demo').repos[0].time).toBeUndefined();
    expect(edited.schedule.time).toBe('21:00');
  });

  it.each(['time=25:00', 'ai=maybe', 'commit.maxFiles=0', 'commit.maxFiles=', 'allowedBranches=main', 'typo=true', '__proto__.polluted=true'])('rejects invalid input: %s', (assignment) => {
    expect(() => editConfig(config(), [assignment])).toThrow();
  });

  it('rejects missing and ambiguous repositories', () => {
    expect(() => editConfig(config(), ['push=false'], 'missing')).toThrow('not configured');
    const duplicate = parseConfig({ repos: [{ path: '/one/demo' }, { path: '/two/demo' }] });
    expect(() => editConfig(duplicate, ['push=false'], 'demo')).toThrow('ambiguous');
  });

  it('keeps equals signs in string values', () => {
    expect(editConfig(config(), ['remote=origin=backup'], 'demo').repos[0].remote).toBe('origin=backup');
  });

  it('writes through the command and leaves the file intact on invalid batches', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairn-config-'));
    const file = path.join(dir, 'custom.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = async (args: string[]) => {
      const program = new Command();
      registerConfig(program, () => file);
      await program.parseAsync(['config', ...args], { from: 'user' });
    };
    try {
      await saveConfig(config(), file);
      await run(['time=19:30', 'ai=true']);
      expect((await loadConfig(file)).schedule.time).toBe('19:30');
      const before = await fs.readFile(file, 'utf8');
      await run(['time=20:00', 'commit.maxFiles=-1']);
      expect(process.exitCode).toBe(1);
      expect(await fs.readFile(file, 'utf8')).toBe(before);
      await run(['--show', '--repo', 'demo']);
      expect(console.log).toHaveBeenLastCalledWith(JSON.stringify((await loadConfig(file)).repos[0], null, 2));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
