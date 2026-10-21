import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, defaultConfig, loadConfig, parseConfig, saveConfig } from '../src/config.js';

describe('config', () => {
  it('defaults to dry run with sane limits', () => {
    const config = defaultConfig();
    expect(config.dryRun).toBe(true);
    expect(config.allowedBranches).toEqual(['main', 'master']);
    expect(config.schedule.time).toBe('21:00');
    expect(config.commit.blockedPaths).toContain('.env');
    expect(config.push.includePending).toBe(false);
    expect(config.commit.split).toBe('none');
    expect(config.commit.maxCommitsPerRun).toBe(20);
    expect(config.commit.ai).toMatchObject({ enabled: false, baseUrl: 'http://localhost:11434/v1' });
  });

  it('fills repo defaults', () => {
    const config = parseConfig({ repos: [{ path: '/tmp/x' }] });
    expect(config.repos[0]).toMatchObject({ remote: 'origin', push: true, enabled: true });
  });

  it('rejects unknown keys and bad values with readable messages', () => {
    expect(() => parseConfig({ dryrun: false })).toThrow(ConfigError);
    expect(() => parseConfig({ schedule: { time: '25:00' } })).toThrow(/schedule.time/);
    expect(() => parseConfig({ repos: [{ remote: 'origin' }] })).toThrow(/repos.0.path/);
    expect(() => parseConfig({ commit: { split: 'folder' } })).toThrow(/commit.split/);
    expect(() => parseConfig({ commit: { ai: { baseUrl: 'localhost' } } })).toThrow(/commit.ai.baseUrl/);
  });

  it('round trips through disk and reports missing or broken files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-config-'));
    const file = path.join(dir, 'nested', 'config.json');
    await expect(loadConfig(file)).rejects.toThrow(/git-contribute init/);
    const config = parseConfig({ repos: [{ path: '/tmp/x', push: false }] });
    await saveConfig(config, file);
    expect(await loadConfig(file)).toEqual(config);
    fs.writeFileSync(file, '{ nope');
    await expect(loadConfig(file)).rejects.toThrow(/not valid JSON/);
  });
});
