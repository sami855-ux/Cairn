import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './paths.js';

export interface RepoState {
  lastDone?: string;
  lastPreview?: string;
  pending: string[];
  awaitingMessages?: string[];
}

export type State = Record<string, RepoState>;

export const statePath = (): string => path.join(stateDir(), 'state.json');

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export async function loadState(file: string = statePath()): Promise<State> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const state: State = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    state[key] = {
      lastDone: text(entry.lastDone),
      lastPreview: text(entry.lastPreview),
      pending: Array.isArray(entry.pending) ? entry.pending.filter((s): s is string => typeof s === 'string') : [],
      ...(Array.isArray(entry.awaitingMessages) ? {
        awaitingMessages: entry.awaitingMessages.filter((s): s is string => typeof s === 'string'),
      } : {}),
    };
  }
  return state;
}

export async function saveState(state: State, file: string = statePath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(temp, file);
}
