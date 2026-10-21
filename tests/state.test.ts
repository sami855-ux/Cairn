import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadState, saveState } from '../src/state.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-state-')), 'nested', 'state.json');

describe('state', () => {
  it('starts empty when the file is missing', async () => {
    expect(await loadState(file())).toEqual({});
  });

  it('round trips and creates folders', async () => {
    const target = file();
    const state = { '/repo': { lastDone: '2026-01-01', pending: ['abc', 'def'] } };
    await saveState(state, target);
    expect(await loadState(target)).toEqual({ '/repo': { lastDone: '2026-01-01', lastPreview: undefined, pending: ['abc', 'def'] } });
  });

  it('recovers from corrupt or odd content', async () => {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{ nope');
    expect(await loadState(target)).toEqual({});
    fs.writeFileSync(target, JSON.stringify({ '/a': 'text', '/b': { pending: [1, 'ok'], lastDone: 5 } }));
    expect(await loadState(target)).toEqual({ '/b': { lastDone: undefined, lastPreview: undefined, pending: ['ok'] } });
  });
});
