import { describe, expect, it } from 'vitest';
import { buildCronLine, hasCronBlock, mergeCrontab, stripCrontab } from '../src/cron.js';

const options = {
  time: '21:30',
  node: '/usr/bin/node',
  script: '/opt/cairn/dist/cli.js',
  apply: true,
  logFile: '/home/me/.local/state/cairn/cron.log',
};

describe('cron', () => {
  it('builds the schedule line', () => {
    const line = buildCronLine(options);
    expect(line.startsWith('30 21 * * * ')).toBe(true);
    expect(line).toContain("'/usr/bin/node' '/opt/cairn/dist/cli.js' run --apply");
    expect(line).toContain(">> '/home/me/.local/state/cairn/cron.log' 2>&1");
  });

  it('omits --apply for dry run jobs and passes a custom config', () => {
    const line = buildCronLine({ ...options, apply: false, configFile: '/tmp/my config.json' });
    expect(line).not.toContain('--apply');
    expect(line).toContain("--config '/tmp/my config.json' run");
  });

  it('escapes percent signs and single quotes', () => {
    const line = buildCronLine({ ...options, logFile: "/tmp/o'k%/cron.log" });
    expect(line).toContain("'/tmp/o'\\''k\\%/cron.log'");
  });

  it('merges idempotently and keeps other entries', () => {
    const existing = '0 8 * * * echo hi\n';
    const once = mergeCrontab(existing, buildCronLine(options));
    const twice = mergeCrontab(once, buildCronLine({ ...options, time: '07:05' }));
    expect(twice.match(/BEGIN cairn/g)).toHaveLength(1);
    expect(twice).toContain('0 8 * * * echo hi');
    expect(twice).toContain('5 7 * * *');
    expect(hasCronBlock(twice)).toBe(true);
  });

  it('strips only its own block', () => {
    const merged = mergeCrontab('0 8 * * * echo hi\n', buildCronLine(options));
    expect(stripCrontab(merged)).toBe('0 8 * * * echo hi\n');
    expect(stripCrontab(mergeCrontab('', buildCronLine(options)))).toBe('');
  });
});
