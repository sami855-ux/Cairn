import type { Config, RepoConfig } from './config.js';
import type { RepoState } from './state.js';

export type DoneKey = 'lastDone' | 'lastPreview';

export function effectiveTime(repo: RepoConfig, config: Config): string {
  return repo.time ?? config.schedule.time;
}

export function localDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function isDue(
  repo: RepoConfig,
  config: Config,
  entry: RepoState | undefined,
  now: Date,
  key: DoneKey,
): boolean {
  if (!repo.enabled) return false;
  const [hour, minute] = effectiveTime(repo, config).split(':').map(Number);
  const reached = now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute;
  return reached && entry?.[key] !== localDate(now);
}
