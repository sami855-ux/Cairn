# cairn

A small Ubuntu CLI that scans the Git repositories you configure, once a day, and commits and pushes the real changes it finds. Every step is guarded so it never touches secrets, never force pushes, and never acts on a repo that is mid merge or mid rebase.

Dry run is the default everywhere. Nothing is committed until you pass `--apply` or turn `dryRun` off in the config.

## Install

```bash
npm install
npm run build
npm link
```

Requires Node 18 or newer and Git. Scheduling uses `cron` (`sudo apt install cron`).

## Quick start

```bash
cairn init
cairn add ~/projects/my-app
cairn scan
cairn run --apply
cairn install --apply
```

`scan` shows what a run would do and changes nothing. `install` adds the daily job. Without `--apply`, the scheduled job only does dry runs and writes the result to the cron log.

## Commands

| Command | What it does |
| --- | --- |
| `init [--force]` | Create the config file |
| `add <path> [--remote x] [--branch x] [--time HH:MM] [--no-push]` | Add a repository, optionally with its own daily time |
| `remove <path>` | Remove a repository |
| `list` | List configured repositories |
| `scan [--repo p] [--json]` | Report only, never changes anything |
| `run [--apply] [--dry-run] [--due] [--repo p] [--json]` | Scan, commit and push. `--due` only runs repos whose time has passed and have not run today |
| `install [--apply] [--time HH:MM]` | Add the scheduler to cron. `--time` sets the default daily time |
| `uninstall` | Remove the cron job |
| `status` | Config, schedule, cron and lock state |

Global option: `-c, --config <file>` to use another config file. The exit code is 1 if any repository failed, so cron can mail you.

## Config

Stored at `~/.config/cairn/config.json` (or under `$XDG_CONFIG_HOME`), with mode 600. Unknown keys are rejected so typos do not pass silently.

```json
{
  "dryRun": true,
  "allowedBranches": ["main", "master"],
  "repos": [
    { "path": "/home/me/projects/my-app", "remote": "origin", "push": true, "enabled": true },
    { "path": "/home/me/projects/other-app", "time": "12:00" }
  ],
  "commit": {
    "messageTemplate": "{type}: {summary}",
    "maxFiles": 50,
    "maxFileSizeBytes": 1048576,
    "blockedPaths": [".env", ".env.*", "*.pem", "*.key"],
    "allowedPaths": [".env.example", ".env.sample", ".env.template"],
    "split": "none",
    "maxCommitsPerRun": 20
  },
  "push": { "includePending": false, "timeoutSeconds": 60 },
  "schedule": { "time": "21:00" }
}
```

The `blockedPaths` shown here is shortened. The default list also covers SSH keys, `.npmrc`, `.netrc`, cloud credentials, `node_modules`, databases and logs. Set `branch` on a repo to restrict it to a single branch instead of `allowedBranches`. Set `time` on a repo to give it its own daily time, otherwise it uses `schedule.time`.

Commit messages use `{type}`, `{summary}` and `{count}`. The type is `docs`, `test` or `chore` based on the files, and the subject is capped at 72 characters.

### Commit grouping

By default a run makes one commit per repo containing every safe change. Set `commit.split` to `"file"` to make one commit per changed file instead, each with its own message (`docs: update README.md`, `chore: add a.ts`, and so on). All commits are pushed together at the end of the run.

- `maxCommitsPerRun` caps the count. With a cap of 5 and 10 changed files, a run commits the first 5 files (in path order) and leaves the other 5 untouched in your working folder. The next run picks up the rest, and the report says how many were left.
- If you already staged any of the files yourself, the run keeps everything in one commit so your staging is respected.
- If a commit is rejected partway (for example by a hook), the run stops, nothing is pushed, and the report shows how many commits were made before it stopped.

### AI commit messages

Off by default. When `commit.ai.enabled` is true, the message for each commit is written by a model that reads the staged diff, for example `fix: handle expired refresh tokens` instead of `chore: update refresh.ts`. It works with any OpenAI compatible endpoint.

Free and private, with Ollama running on your machine:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5-coder:3b
```

```json
"commit": {
  "ai": { "enabled": true }
}
```

The defaults are `baseUrl: "http://localhost:11434/v1"` and `model: "qwen2.5-coder:3b"`. Check the setup with `cairn ai-test`.

Hosted providers with a free tier work too. Set `baseUrl`, `model` and a key:

| Provider | baseUrl |
| --- | --- |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `https://api.groq.com/openai/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

```json
"ai": {
  "enabled": true,
  "baseUrl": "https://api.groq.com/openai/v1",
  "model": "pick a current model from the provider",
  "apiKeyFile": "~/.config/cairn/api-key"
}
```

Cron has a bare environment, so prefer `apiKeyFile` (chmod 600) over `apiKeyEnv`. Free tier limits and models change often, so check the provider's page.

- The diff sent to the model only contains files that passed the blocked path and secret checks. Lock files, minified files and source maps are left out, and the diff is cut at `maxDiffBytes` (12000 by default).
- If the model is unreachable, slow, or replies with something that is not a valid one line Conventional Commit, the rule based message is used and the run carries on. After the first failure in a run, the remaining commits skip the model so a dead server cannot stall the run.
- Dry runs never call the model and show the rule based message.
- With a hosted provider your diffs leave your machine, and free tiers commonly let the provider use prompts. Use Ollama for code you want to keep private.
- `messageTemplate` only applies to rule based messages.

## Safety model

A repository is skipped, with the reason reported, when:

- the path is missing or is not a Git repository
- a merge, rebase, cherry-pick, revert or bisect is in progress
- HEAD is detached, or the branch is not allowed
- there are unresolved conflicts
- more than `maxFiles` files changed
- a file you already staged was excluded by a safety check

Individual files are left out of the commit, and reported, when they match a blocked path, exceed the size limit, are a directory or nested repository, or contain something that looks like a secret (private keys, cloud and GitHub tokens, JWTs, credentials in URLs, hardcoded `password` or `token` assignments). Findings report the rule and line number, never the value.

Files are staged by explicit path, never with a blanket `git add`. Before committing, the index is checked against the selected files, and staging is rolled back if anything unexpected is in it. Commit and push results are verified afterwards, because a hook can exit non zero without Git printing anything.

Pushing happens only after a successful commit, and only when:

- the remote and the remote branch exist
- the remote has no commits you lack (it never pulls, rebases or forces)
- the branch had no unpushed commits before this run, unless `push.includePending` is on

If the push is skipped or fails, the commit stays local and the reason is in the report.

A lock file prevents overlapping runs, and stale locks from dead processes are cleared. Git never prompts for credentials (`GIT_TERMINAL_PROMPT=0`), so an unattended run cannot hang.

## Scheduling

`install` writes a marked block to your crontab and leaves the rest alone:

```
# BEGIN cairn
*/15 * * * * PATH='...' '/usr/bin/node' '/path/to/dist/cli.js' run --apply --due >> '~/.local/state/cairn/cron.log' 2>&1
@reboot sleep 90 && PATH='...' '/usr/bin/node' '/path/to/dist/cli.js' run --apply --due >> '~/.local/state/cairn/cron.log' 2>&1
# END cairn
```

Cron does not pick the time. It wakes cairn every 15 minutes and at boot, and cairn decides what is due: a repo is due once its daily time (`time` on the repo, or `schedule.time`) has passed and it has not completed a run today. A check with nothing due exits at once and prints nothing, so it costs almost no CPU.

What this gives you:

- **Catch up.** If the computer was off or asleep at 12:00, the repo runs at the first check after it is back, for example at 16:40 or shortly after boot.
- **Offline commits.** Without internet the commit is still made locally and the push fails. The repo counts as unfinished, so every following check retries the push until it goes through.
- **Only its own commits.** Retries push only commits cairn made itself. If you committed something else in between, the push is skipped and reported, unless `push.includePending` is on.
- **One run per repo per day.** Once a repo finishes, it waits until tomorrow, even if you keep editing. A manual `run --apply` does not use up the scheduled run.
- **No backdating.** Catch up commits carry the time they are made.

State lives in `~/.local/state/cairn/state.json` (last completed day per repo and the commits still waiting to be pushed). If a dry run schedule is installed, previews are tracked separately so they never use up a real run.

Run `install` from the built CLI (`node dist/cli.js install` or the linked `cairn`), not through `tsx`. Re-running it replaces the block, so it also upgrades an older single time entry. Check results with `tail ~/.local/state/cairn/cron.log`.

A computer that is off cannot commit anything, so for a true 24/7 schedule keep the repos on an always on machine (a server or home box you work on over SSH) and run cairn there. A cloud scheduler such as GitHub Actions cannot see the uncommitted files on your laptop.

## Development

```bash
npm run dev -- scan   # run from source
npm run typecheck
npm test              # unit tests plus integration tests against real temporary Git repos
```

Layout: `config` (schema and storage), `scanner` (repo state), `safety` and `secrets` (what may be committed), `commit` and `push` (Git operations), `runner` (orchestration), `cron`, `lock`, `format` and `cli`.
