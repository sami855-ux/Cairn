import fs from 'node:fs/promises';

export async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export async function openFolderDialog(): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  try {
    if (process.platform === 'linux') {
      try {
        const { stdout } = await exec('zenity', [
          '--file-selection',
          '--directory',
          '--title=Select Git Repository',
          `--filename=${process.cwd()}/`,
        ]);
        return stdout.trim() || null;
      } catch {
        const { stdout } = await exec('kdialog', ['--getexistingdirectory', process.cwd()]);
        return stdout.trim() || null;
      }
    }
    if (process.platform === 'darwin') {
      const script = 'POSIX path of (choose folder with prompt "Select Git Repository")';
      const { stdout } = await exec('osascript', ['-e', script]);
      return stdout.trim() || null;
    }
    if (process.platform === 'win32') {
      const psCommand = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select Git Repository'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }`;
      const { stdout } = await exec('powershell', ['-NoProfile', '-Command', psCommand]);
      return stdout.trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}
