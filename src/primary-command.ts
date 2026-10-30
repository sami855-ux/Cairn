import path from 'node:path';
import { cancel, intro, isCancel, outro, select } from '@clack/prompts';
import type { Command } from 'commander';
import { loadConfig, saveConfig } from './config.js';
import { defaultConfigPath, resolveRepoPath } from './paths.js';
import { colorEnabled, formatOptions, command } from './command-utils.js';


export function formatRepoName(repoPath: string): string {
  const base = path.basename(repoPath);
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export async function setPrimary(target: string, file: string = defaultConfigPath()): Promise<string> {
  const config = await loadConfig(file);
  const resolved = resolveRepoPath(target);
  const matched = config.repos.find(
    (r) =>
      r.path === target ||
      resolveRepoPath(r.path) === resolved ||
      path.basename(r.path).toLowerCase() === target.toLowerCase(),
  );
  if (!matched) {
    throw new Error(`${target} is not a configured repository`);
  }
  config.primary = matched.path;
  await saveConfig(config, file);
  return matched.path;
}

export async function clearPrimary(file: string = defaultConfigPath()): Promise<void> {
  const config = await loadConfig(file);
  delete config.primary;
  await saveConfig(config, file);
}

export async function interactivePrimary(file: string = defaultConfigPath()): Promise<void> {
  const config = await loadConfig(file);
  if (config.repos.length === 0) {
    console.log('No repositories configured.');
    return;
  }

  intro('cairn primary');

  const current = config.repos.find(
    (r) => config.primary && (r.path === config.primary || resolveRepoPath(r.path) === resolveRepoPath(config.primary)),
  );

  const options = [
    ...config.repos.map((r) => {
      const isCurrent = current ? (r.path === current.path || resolveRepoPath(r.path) === resolveRepoPath(current.path)) : false;
      return {
        value: r.path,
        label: formatRepoName(r.path),
        hint: isCurrent ? 'current' : undefined,
      };
    }),
    {
      value: '',
      label: 'None (no primary)',
      hint: !current ? 'current' : undefined,
    },
  ];

  const choice = await select({
    message: 'Select a primary repository',
    options,
    initialValue: current ? current.path : '',
  });

  if (isCancel(choice)) {
    cancel('Operation cancelled.');
    return;
  }

  if (!choice || choice === 'none') {
    delete config.primary;
    await saveConfig(config, file);
    outro('Primary repository set to none');
  } else {
    const matched = config.repos.find(
      (r) =>
        r.path === choice ||
        resolveRepoPath(r.path) === resolveRepoPath(choice) ||
        path.basename(r.path).toLowerCase() === choice.toLowerCase(),
    );
    config.primary = matched ? matched.path : choice;
    await saveConfig(config, file);
    const name = formatRepoName(config.primary);
    outro(`Primary repository set to ${name}`);
  }
}

export function registerPrimary(
  program: Command,
  getConfigFile: () => string = () =>
    program.opts<{ config?: string }>().config
      ? path.resolve(program.opts<{ config?: string }>().config!)
      : defaultConfigPath(),
): void {
  const primaryCommand = program
    .command('primary')
    .description('manage the primary repository');

  primaryCommand
    .command('set <path>')
    .description('set the primary repository')
    .action(
      command(async (target: string) => {
        intro('cairn primary');
        const primary = await setPrimary(target, getConfigFile());
        const name = formatRepoName(primary);
        outro(`Primary repository set to ${name}`);
      }),
    );

  primaryCommand
    .command('clear')
    .description('clear the primary repository')
    .action(
      command(async () => {
        intro('cairn primary');
        await clearPrimary(getConfigFile());
        outro('Primary repository cleared');
      }),
    );

  primaryCommand.action(
    command(async () => {
      await interactivePrimary(getConfigFile());
    }),
  );
}
