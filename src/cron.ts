import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

const BEGIN = '# BEGIN cairn';
const END = '# END cairn';
const BLOCK = /# BEGIN cairn\n[\s\S]*?# END cairn\n?/g;

export interface CronOptions {
  time?: string;
  node: string;
  script: string;
  apply: boolean;
  logFile: string;
  configFile?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCronLine(options: CronOptions): string {
  const args = [shellQuote(options.node), shellQuote(options.script)];
  if (options.configFile) args.push('--config', shellQuote(options.configFile));
  args.push('run');
  if (options.apply) args.push('--apply');
  args.push('--due');
  const searchPath = [path.dirname(options.node), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  const command = `PATH=${shellQuote(searchPath)} ${args.join(' ')} >> ${shellQuote(options.logFile)} 2>&1`.replace(
    /%/g,
    '\\%',
  );
  return [`*/15 * * * * ${command}`, `@reboot sleep 90 && ${command}`].join('\n');
}

export function stripCrontab(existing: string): string {
  const stripped = existing.replace(BLOCK, '');
  return stripped.trim() === '' ? '' : `${stripped.replace(/\n*$/, '')}\n`;
}

export function mergeCrontab(existing: string, lines: string | string[]): string {
  const body = (Array.isArray(lines) ? lines : [lines]).join('\n');
  return `${stripCrontab(existing)}${BEGIN}\n${body}\n${END}\n`;
}

export function hasCronBlock(existing: string): boolean {
  return existing.includes(BEGIN);
}

export function readCrontab(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('crontab', ['-l'], (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new Error('crontab is not installed (sudo apt install cron)'));
      }
      if (/no crontab/i.test(stderr)) return resolve('');
      reject(new Error(stderr.trim() || error.message));
    });
  });
}

export function writeCrontab(content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('crontab', ['-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('crontab is not installed (sudo apt install cron)'));
      } else {
        reject(error);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `crontab exited with code ${code}`));
    });
    child.stdin.end(content);
  });
}
