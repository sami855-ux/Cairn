import path from 'node:path';
import { cancel, intro, isCancel, outro, select, text } from '@clack/prompts';
import type { Command } from 'commander';
import { type Config, loadConfig, parseConfig, saveConfig } from './config.js';
import { command } from './command-utils.js';
import { resolveRepoPath } from './paths.js';

type Setting = { key: string; type: 'string' | 'number' | 'boolean' | 'array' };

const globalSettings: Setting[] = [
  { key: 'schedule.time', type: 'string' },
  { key: 'commit.ai.enabled', type: 'boolean' },
  { key: 'allowedBranches', type: 'array' },
  { key: 'commit.maxFiles', type: 'number' },
  { key: 'commit.split', type: 'string' },
  { key: 'commit.maxCommitsPerRun', type: 'number' },
  { key: 'push.includePending', type: 'boolean' },
  { key: 'push.timeoutSeconds', type: 'number' },
  { key: 'push.autoPull', type: 'boolean' },
];
const repoSettings: Setting[] = [
  { key: 'time', type: 'string' }, { key: 'enabled', type: 'boolean' },
  { key: 'push', type: 'boolean' }, { key: 'remote', type: 'string' },
  { key: 'branch', type: 'string' },
];
const aliases: Record<string, string> = { time: 'schedule.time', ai: 'commit.ai.enabled' };

function target(config: Config, repo?: string): Record<string, unknown> {
  if (!repo) return config as unknown as Record<string, unknown>;
  const exact = config.repos.filter((r) => resolveRepoPath(r.path) === resolveRepoPath(repo));
  const matches = exact.length ? exact : config.repos.filter((r) => path.basename(r.path).toLowerCase() === repo.toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? 'Repository name is ambiguous; use its full path' : `Repository not configured: ${repo}`);
  return matches[0] as unknown as Record<string, unknown>;
}

function read(object: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], object);
}

export function editConfig(config: Config, assignments: string[], repo?: string): Config {
  const draft = structuredClone(config);
  const object = target(draft, repo);
  const settings = repo ? repoSettings : globalSettings;
  for (const assignment of assignments) {
    const equals = assignment.indexOf('=');
    if (equals < 1) throw new Error(`Expected key=value, received: ${assignment}`);
    const inputKey = assignment.slice(0, equals);
    const key = repo ? inputKey : aliases[inputKey] ?? inputKey;
    const setting = settings.find((s) => s.key === key);
    if (!setting) throw new Error(`Unknown setting: ${inputKey}. Use "cairn config" to see supported settings.`);
    const raw = assignment.slice(equals + 1);
    let value: unknown = raw;
    if (raw === 'null') value = undefined;
    else if (setting.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') throw new Error(`${key} must be true or false`);
      value = raw === 'true';
    } else if (setting.type === 'number') {
      if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error(`${key} must be a number`);
      value = Number(raw);
    } else if (setting.type === 'array') {
      try { value = JSON.parse(raw); } catch { throw new Error(`${key} must be a JSON array`); }
      if (!Array.isArray(value)) throw new Error(`${key} must be a JSON array`);
    }
    const parts = key.split('.');
    let parent = object;
    for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
    const leaf = parts[parts.length - 1];
    if (value === undefined) delete parent[leaf];
    else parent[leaf] = value;
  }
  return parseConfig(draft);
}

async function interactive(file: string, config: Config, repo?: string): Promise<void> {
  let draft = config;
  target(draft, repo);
  intro(repo ? `cairn config — ${repo}` : 'cairn config');
  const settings = repo ? repoSettings : globalSettings;
  while (true) {
    const object = target(draft, repo);
    const key = await select({ message: 'Choose a setting', options: [
      ...settings.map((s) => ({ value: s.key, label: s.key, hint: String(JSON.stringify(read(object, s.key)) ?? 'unset').slice(0, 90) })),
      { value: '$save', label: 'Save and exit' },
      { value: '$cancel', label: 'Discard and exit' },
    ] });
    if (isCancel(key) || key === '$cancel') { cancel('Changes discarded.'); return; }
    if (key === '$save') { await saveConfig(draft, file); outro(`Saved ${file}`); return; }
    const setting = settings.find((s) => s.key === key)!;
    const current = read(object, key);
    const value = setting.type === 'boolean'
      ? await select({ message: key, initialValue: String(current), options: [
        { value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' },
      ] })
      : await text({
        message: `${key}${setting.type === 'array' ? ' (JSON array)' : ''} — enter null to reset`,
        initialValue: current === undefined ? 'null' : typeof current === 'string' ? current : JSON.stringify(current),
        validate: (value) => {
          try { editConfig(draft, [`${key}=${value ?? ''}`], repo); }
          catch (error) { return (error as Error).message; }
        },
      });
    if (isCancel(value)) { cancel('Changes discarded.'); return; }
    draft = editConfig(draft, [`${key}=${value}`], repo);
  }
}

export function registerConfig(program: Command, getConfigFile: () => string): void {
  program.command('config [settings...]')
    .description('edit settings interactively or provide key=value changes (time and ai are shortcuts)')
    .option('--repo <path-or-name>', 'edit one configured repository')
    .option('--show', 'print current settings as JSON')
    .addHelpText('after', '\nExamples:\n  cairn config\n  cairn config time=21:30 ai=true commit.maxCommitsPerRun=10\n  cairn config --repo my-project time=18:00 push=false\n  cairn config \'allowedBranches=["main","develop"]\'\n  cairn config --repo my-project time=null\n\nUse null to reset a setting to its default or remove an optional override.')
    .action(command(async (settings: string[], options: { repo?: string; show?: boolean }) => {
      const file = getConfigFile();
      const config = await loadConfig(file);
      if (options.show) {
        if (settings.length) throw new Error('--show cannot be combined with changes');
        console.log(JSON.stringify(target(config, options.repo), null, 2));
      } else if (settings.length) {
        await saveConfig(editConfig(config, settings, options.repo), file);
        console.log(`Saved ${file}`);
      } else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use key=value changes or --show outside an interactive terminal');
        await interactive(file, config, options.repo);
      }
    }));
}
