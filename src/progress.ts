import { createColors } from 'picocolors';

export type ProgressEvent =
  | { type: 'repo-start'; repo: string; files: number }
  | { type: 'commit'; repo: string; file: string; done: number; files: number }
  | { type: 'push'; repo: string; stage: string; percent: number }
  | { type: 'pushed'; repo: string; remote: string }
  | { type: 'failed'; repo: string; message: string };

const BAR_WIDTH = 24;
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function createProgress(options: { color: boolean; live: boolean }) {
  const colors = createColors(options.color);
  let frame = 0;
  let text = 'starting';
  let ratio = 0;
  let files = 1;
  let timer: ReturnType<typeof setInterval> | undefined;

  const bar = () => {
    const filled = Math.round(Math.min(1, Math.max(0, ratio)) * BAR_WIDTH);
    return colors.cyan('█'.repeat(filled)) + colors.dim('░'.repeat(BAR_WIDTH - filled));
  };

  const render = () => {
    const spin = colors.cyan(FRAMES[frame]);
    frame = (frame + 1) % FRAMES.length;
    const percent = String(Math.round(ratio * 100)).padStart(3);
    process.stdout.write(`\r\x1B[2K  ${spin} ${bar()} ${percent}%  ${colors.dim(text)}`);
  };

  const line = (message: string) => {
    if (options.live) {
      process.stdout.write('\r\x1B[2K');
      console.log(`  ${message}`);
      render();
    } else {
      console.log(`[${new Date().toTimeString().slice(0, 8)}] ${message}`);
    }
  };

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    process.stdout.write('\r\x1B[2K\x1B[?25h');
  };

  if (options.live) {
    process.stdout.write('\x1B[?25l');
    timer = setInterval(render, 80);
    process.once('exit', stop);
    render();
  }

  const handle = (event: ProgressEvent) => {
    switch (event.type) {
      case 'repo-start':
        files = Math.max(1, event.files);
        ratio = 0;
        text = event.repo;
        line(
          `${colors.bold(event.repo)} ${colors.dim(event.files > 0 ? `${event.files} commits to make` : 'pushing pending commits')}`,
        );
        break;
      case 'commit':
        ratio = (event.done / files) * 0.8;
        text = `committing ${event.done}/${event.files}`;
        line(`${colors.green('✔')} committed ${event.file}`);
        break;
      case 'push':
        ratio = 0.8 + (event.percent / 100) * 0.2;
        text = `pushing ${event.stage} ${event.percent}%`;
        break;
      case 'pushed':
        ratio = 1;
        line(`${colors.green('✔')} pushed to ${event.remote}`);
        break;
      case 'failed':
        line(`${colors.red('✖')} ${event.repo}: ${event.message}`);
        break;
    }
  };

  return { handle, stop };
}