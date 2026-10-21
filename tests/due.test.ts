import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { effectiveTime, isDue, localDate } from '../src/due.js';

const config = parseConfig({
  schedule: { time: '21:00' },
  repos: [{ path: '/a', time: '12:00' }, { path: '/b' }, { path: '/c', time: '18:00', enabled: false }],
});
const [early, standard, disabled] = config.repos;
const at = (hour: number, minute = 0, day = 1) => new Date(2026, 0, day, hour, minute);

describe('repository times', () => {
  it('validates a repository time', () => {
    expect(() => parseConfig({ repos: [{ path: '/a', time: '25:00' }] })).toThrow(/repos.0.time/);
    expect(parseConfig({ repos: [{ path: '/a' }] }).repos[0].time).toBeUndefined();
  });

  it('falls back to the default time', () => {
    expect(effectiveTime(early, config)).toBe('12:00');
    expect(effectiveTime(standard, config)).toBe('21:00');
  });
});

describe('isDue', () => {
  it('is due from the scheduled minute onwards, until it has run that day', () => {
    expect(isDue(early, config, undefined, at(11, 59), 'lastDone')).toBe(false);
    expect(isDue(early, config, undefined, at(12), 'lastDone')).toBe(true);
    expect(isDue(early, config, undefined, at(23, 59), 'lastDone')).toBe(true);
    expect(isDue(standard, config, undefined, at(20, 59), 'lastDone')).toBe(false);
  });

  it('is not due again after it ran today but is due the next day', () => {
    const entry = { lastDone: localDate(at(12)), pending: [] };
    expect(isDue(early, config, entry, at(15), 'lastDone')).toBe(false);
    expect(isDue(early, config, entry, at(12, 0, 2), 'lastDone')).toBe(true);
  });

  it('tracks dry run previews separately from real runs', () => {
    const entry = { lastPreview: localDate(at(12)), pending: [] };
    expect(isDue(early, config, entry, at(13), 'lastPreview')).toBe(false);
    expect(isDue(early, config, entry, at(13), 'lastDone')).toBe(true);
  });

  it('never runs a disabled repository', () => {
    expect(isDue(disabled, config, undefined, at(23), 'lastDone')).toBe(false);
  });
});

describe('localDate', () => {
  it('formats the local calendar date', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDate(new Date(2026, 10, 21, 0, 0))).toBe('2026-11-21');
  });
});
