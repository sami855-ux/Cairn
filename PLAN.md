# cairn plan

All six phases are complete.

| Phase | Scope | Where |
| --- | --- | --- |
| 1. CLI foundation | Commander CLI, JSON config with validation, init, add, remove, list, status, dry run by default | `cli.ts`, `config.ts`, `paths.ts` |
| 2. Repository scanner | Path and repo checks, in progress operations, detached HEAD, branch rules, conflicts, change collection | `scanner.ts` |
| 3. Secure commit workflow | Blocked paths, size limit, secret scanning, explicit staging, index verification, rollback, message builder | `safety.ts`, `secrets.ts`, `commit.ts` |
| 4. Push workflow | Fetch, behind check, never force, unpushed commit guard, result verification | `push.ts`, `runner.ts` |
| 5. Daily automation | Cron install and uninstall with a marked block, lock file, cron log | `cron.ts`, `lock.ts` |
| 6. Testing and docs | 39 tests including integration tests on real temporary repos, README | `tests/`, `README.md` |

## Added since

- File by file commits (`commit.split`) with a per run cap (`commit.maxCommitsPerRun`)

## Ideas for later

- Split by top level folder
- Per repo overrides for `blockedPaths` and `messageTemplate`
- A `doctor` command that checks Git identity, remotes and credentials for each repo
- systemd timer as an alternative to cron
