import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { matchesAny } from './glob.js';
import { findSecrets, isBinary } from './secrets.js';
import type { FileChange, Plan } from './types.js';

async function rejectReason(root: string, change: FileChange, config: Config): Promise<string | null> {
  if (change.kind === 'deleted') return null;
  const { blockedPaths, allowedPaths, maxFileSizeBytes } = config.commit;
  if (!matchesAny(change.path, allowedPaths) && matchesAny(change.path, blockedPaths)) {
    return 'blocked path';
  }
  const full = path.join(root, change.path);
  let stat;
  try {
    stat = await fs.lstat(full);
  } catch {
    return 'file is missing';
  }
  if (stat.isDirectory()) return 'directory or nested repository';
  if (stat.isSymbolicLink()) {
    // Symlinks skip content scanning (can't read through them reliably),
    // but must still pass the path-based blocked list so that a symlink
    // pointing at a secret file (e.g. .env, id_rsa) is correctly excluded.
    if (!matchesAny(change.path, allowedPaths) && matchesAny(change.path, blockedPaths)) {
      return 'blocked path';
    }
    return null;
  }
  if (stat.size > maxFileSizeBytes) return 'file too large';
  const content = await fs.readFile(full);
  if (isBinary(content)) return null;
  const findings = findSecrets(content.toString('utf8'));
  if (findings.length > 0) return `possible secret (${findings[0].rule}, line ${findings[0].line})`;
  return null;
}

export async function buildPlan(root: string, changes: FileChange[], config: Config): Promise<Plan> {
  if (changes.length === 0) return { state: 'clean', safe: [], excluded: [] };

  const safe: FileChange[] = [];
  const excluded: Plan['excluded'] = [];
  for (const change of changes) {
    const reason = await rejectReason(root, change, config);
    if (reason) excluded.push({ path: change.path, reason });
    else safe.push(change);
  }

  const blocked = (reason: string): Plan => ({ state: 'blocked', safe, excluded, reason });
  if (safe.length === 0) return blocked('every changed file was excluded by the safety checks');
  if (safe.length > config.commit.maxFiles) {
    return blocked(`too many changed files (${safe.length}, limit ${config.commit.maxFiles})`);
  }
  const excludedPaths = new Set(excluded.map((item) => item.path));
  if (changes.some((change) => change.staged && excludedPaths.has(change.path))) {
    return blocked('staged files were excluded by the safety checks');
  }
  return { state: 'ready', safe, excluded };
}
