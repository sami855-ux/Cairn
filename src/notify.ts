import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export function notify(title: string, body: string, urgency: 'normal' | 'critical' = 'normal'): void {
  const uid = process.getuid?.() ?? 1000;
  const bus = `/run/user/${uid}/bus`;
  const env = { ...process.env };
  if (!env.DBUS_SESSION_BUS_ADDRESS && existsSync(bus)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  if (!env.DISPLAY) env.DISPLAY = ':0';
  const child = spawn('notify-send', ['--app-name=cairn', `--urgency=${urgency}`, title, body], {
    env,
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => {});
  child.unref();
}