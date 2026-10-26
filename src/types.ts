export interface FileChange {
  path: string;
  from?: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed';
  staged: boolean;
  needsAdd: boolean;
}

export interface RepoScan {
  path: string;
  root: string;
  branch: string | null;
  changes: FileChange[];
  ahead: number;
  behind: number;
  skipReason?: string;
}

export interface Exclusion {
  path: string;
  reason: string;
}

export interface Plan {
  state: 'ready' | 'clean' | 'blocked';
  safe: FileChange[];
  excluded: Exclusion[];
  reason?: string;
}

export interface PushOutcome {
  status: 'pushed' | 'skipped' | 'failed' | 'planned' | 'deferred';
  detail: string;
}

export interface CommitInfo {
  sha?: string;
  message: string;
  source?: 'ai' | 'rules';
  aiError?: string;
}

export interface RepoReport {
  path: string;
  branch: string | null;
  status: 'clean' | 'skipped' | 'planned' | 'committed' | 'failed';
  reason?: string;
  files: number;
  deferred: number;
  excluded: Exclusion[];
  commits: CommitInfo[];
  push?: PushOutcome;
}
