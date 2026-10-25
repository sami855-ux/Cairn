# Cairn

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x%20%7C%207.x-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-vitest-green.svg)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Safe by Default](https://img.shields.io/badge/default-dry--run%20safe-success.svg)](#safety-model)

> **Cairn** is an automated, safety-first Git repository scanner, committer, and pusher for developers. It monitors your configured repositories, audits changes for security and size constraints, generates clean Conventional Commits (via rule-based heuristics or local/hosted AI), and pushes to remotes on a customizable daily schedule.

Every step is strictly guarded: Cairn **never touches secrets**, **never force-pushes**, **never pulls or rebases**, and **aborts immediately** if a repository is mid-merge, mid-rebase, detached, or conflicted.

Dry run is the default across all commands. Nothing is committed or pushed unless you explicitly supply `--apply` or disable `dryRun` in your configuration.

---

## Table of Contents

- [Core Principles & Highlights](#core-principles--highlights)
- [Architecture & Execution Flow](#architecture--execution-flow)
- [Project Directory Structure](#project-directory-structure)
- [Installation & Prerequisites](#installation--prerequisites)
- [Quick Start](#quick-start)
- [CLI Command Reference](#cli-command-reference)
  - [Global Options](#global-options)
  - [Commands Overview](#commands-overview)
  - [Detailed Command Usage](#detailed-command-usage)
- [Configuration Guide](#configuration-guide)
  - [Configuration File Schema](#configuration-file-schema)
  - [Repository Settings](#repository-settings)
  - [Commit & Split Settings](#commit--split-settings)
  - [Push Behavior & Unpushed Protection](#push-behavior--unpushed-protection)
  - [Scheduling & Daily Timing](#scheduling--daily-timing)
- [AI Commit Messages](#ai-commit-messages)
  - [Local AI via Ollama (Free & Private)](#local-ai-via-ollama-free--private)
  - [Cloud Providers (Groq, Gemini, OpenRouter)](#cloud-providers-groq-gemini-openrouter)
  - [Diff Sanitization & Fallback Mechanics](#diff-sanitization--fallback-mechanics)
- [Safety Model & Secret Scanning](#safety-model--secret-scanning)
  - [Repository-Level Safety Guards](#repository-level-safety-guards)
  - [File-Level Safety & Secret Inspection](#file-level-safety--secret-inspection)
  - [Atomic Index Verification & Rollback](#atomic-index-verification--rollback)
- [Scheduling, Catch-Up & State Management](#scheduling-catch-up--state-management)
  - [Crontab Integration](#crontab-integration)
  - [Catch-Up & Offline Behavior](#catch-up--offline-behavior)
  - [State Persistence & Lock Files](#state-persistence--lock-files)
- [Development & Testing](#development--testing)
- [License](#license)

---

## Core Principles & Highlights

- **Zero Secret Leakage**: Integrated entropy and pattern scanners detect private keys, cloud tokens (AWS, GitHub, Slack, Stripe, Google), JWTs, credentials in URLs, and hardcoded secrets before files are staged.
- **Safe By Default**: Runs non-destructive dry-run previews by default. Cairn will only write changes to disk or Git history when explicitly authorized.
- **No Destructive Operations**: Cairn never runs `git pull`, `git rebase`, or `git push --force`. If upstream commits exist that you do not have locally, Cairn cleanly skips pushing and reports the condition.
- **Flexible Commit Splitting**: Commit all safe changes together in one batch, or enable file-by-file splitting (`commit.split: "file"`) with configurable per-run caps to cleanly space out large changesets over days.
- **Conventional Commit Intelligence**: Automatically formats commits with `{type}: {summary}` syntax, or routes sanitized diffs to local (Ollama) or hosted (Groq, Google Gemini, OpenRouter) models.
- **Reliable Catch-Up Scheduler**: Cron triggers a lightweight check every 15 minutes and at reboot. If your machine was offline or asleep during the scheduled hour, Cairn commits and catches up as soon as it resumes.
- **Rich Terminal & Machine-Readable Output**: Clean color-coded terminal reports, interactive spinners, tabular repository views, and structured `--json` output for headless pipelines.

---

## Architecture & Execution Flow

Cairn executes a multi-stage validation and commit pipeline:

```mermaid
flowchart TD
    A[Start: cairn run / cron] --> B[Acquire Process Lock run.lock]
    B --> C[Load Config and State]
    C --> D{Check Due Time?}
    D -- Not Due --> E[Skip Repository]
    D -- Due or Manual --> F[Scan Repository via simple-git]

    F --> G{In-Progress Op? Detached HEAD? Conflicts?}
    G -- Yes --> H[Skip with Reason]
    G -- Safe --> I[Audit Files for Blocked Paths, Sizes and Secrets]

    I --> J{Any Files Safe?}
    J -- No --> K[Skip Repo / Block Plan]
    J -- Yes --> L[Build Commit Plan: Single or Split]

    L --> M{Is Dry Run?}
    M -- Yes --> N[Output Dry-Run Report and Plan]
    M -- Apply --> O[Stage Files Explicitly by Path]

    O --> P{Index Drift Check}
    P -- Mismatch --> Q[Rollback Index Staging and Fail]
    P -- Valid --> R[Generate Message: AI or Rule Engine]

    R --> S[Commit Changes]
    S --> T{Push Enabled?}
    T -- No --> U[Persist State and Finish]
    T -- Yes --> V[Fetch and Verify Ahead/Behind]

    V --> W{Upstream Behind > 0?}
    W -- Yes --> X[Skip Push: Pull Required]
    W -- Safe --> Y[Push to Remote]

    Y --> U
    U --> Z[Release Lock]
```

---

## Project Directory Structure

The repository is modularly structured, separating CLI presentation, Git interaction, safety auditing, scheduling, and configuration validation:

```text
cairn/
├── .env                          # Local environment overrides (CAIRN_CONFIG, CAIRN_COLOR, etc.)
├── .gitignore                    # Build artifacts and dependency exclusions
├── package.json                  # Node.js project manifest, CLI binary link, dependencies
├── tsconfig.json                 # TypeScript compiler configuration (NodeNext, ES2022)
├── PLAN.md                       # Architectural design notes and milestone tracker
├── README.md                     # Comprehensive project documentation
├── scripts/
│   └── cron-run.sh               # Helper wrapper for cron execution with desktop notifications
├── src/                          # TypeScript source code
│   ├── ai.ts                     # AI commit message generator (OpenAI-compatible APIs)
│   ├── cli.ts                    # Commander CLI definitions, option parsing, table rendering
│   ├── commit.ts                 # Staging validation, commit grouping, and message formatters
│   ├── config.ts                 # Zod schema definitions, defaults, config file loader/saver
│   ├── cron.ts                   # Crontab parsing, block merging, and schedule generation
│   ├── due.ts                    # Due-time calculation and catch-up eligibility checks
│   ├── format.ts                 # Picocolors terminal formatting, status labels, run summaries
│   ├── glob.ts                   # Lightweight glob matcher for path whitelists and blacklists
│   ├── lock.ts                   # PID-based file locker with stale process detection
│   ├── paths.ts                  # XDG directory resolution (~/.config/cairn, ~/.local/state)
│   ├── push.ts                   # Remote push engine, ahead/behind checks, unpushed safeguards
│   ├── runner.ts                 # Central orchestration pipeline coordinating scan, commit & push
│   ├── safety.ts                 # Change validation against file size, path blocks, and secrets
│   ├── scanner.ts                # Git repository inspector (status, branch, dirty tree checks)
│   ├── secrets.ts                # Secret scanning engine (regex patterns for keys, tokens, JWTs)
│   ├── state.ts                  # State persistence (timestamps, pending commit SHAs)
│   ├── types.ts                  # Common TypeScript interfaces and data models
│   └── util.ts                   # Utility functions (error stringification, file existence)
└── tests/                        # Vitest test suite
    ├── ai.test.ts                # Unit tests for AI message sanitization, diff truncating, API client
    ├── commit.test.ts            # Commit message rule generation and commit splitting tests
    ├── config.test.ts            # Configuration parsing, Zod validation, and error reporting tests
    ├── cron.test.ts              # Crontab line generation, merging, and block removal tests
    ├── due.test.ts               # Timing, due-date calculations, and catch-up logic tests
    ├── format.test.ts            # Output report formatting and pluralization tests
    ├── glob.test.ts              # Path globbing logic tests
    ├── helpers.ts                # Vitest testing utilities (ephemeral git repos, mock HTTP server)
    ├── secrets.test.ts           # Secret detector rule coverage and false positive prevention tests
    ├── state.test.ts             # State file serialization and deserialization tests
    └── workflow.test.ts          # End-to-end integration tests on real temporary Git repositories
```

---

## Installation & Prerequisites

### Prerequisites

- **Node.js**: `v18.0.0` or higher
- **Git**: Installed and available in `$PATH`
- **Cron** (optional, for automated daily runs): `cron` / `crontab` (standard on Ubuntu, Debian, macOS, Fedora, etc.)

### Installation from Source

Clone the repository and build the TypeScript binaries:

```bash
git clone https://github.com/samux855/cairn.git
cd cairn
npm install
npm run build
```

To make the `cairn` command available system-wide:

```bash
npm link
```

Verify your installation:

```bash
cairn --version
```

---

## Quick Start

Get up and running with Cairn in under two minutes:

### 1. Initialize configuration

Create the default configuration at `~/.config/cairn/config.json`:

```bash
cairn init
```

### 2. Add your repositories

Register repositories you want Cairn to track:

```bash
cairn add ~/projects/my-web-app
cairn add ~/work/docs-repo --branch main
```

### 3. Preview pending changes (Dry Run)

Run a safe scan across all registered repositories:

```bash
cairn scan
```

Cairn inspects the repositories, filters out any secrets or oversized files, and displays what commit messages would be generated—without touching your Git state.

### 4. Perform a real manual run

To stage, commit, and push your changes for real:

```bash
cairn run --apply
```

### 5. Install the daily background scheduler

Install the automatic scheduler into your user's crontab:

```bash
cairn install --apply --time 21:00
```

---

## CLI Command Reference

### Global Options

All commands accept the following global flags:

- `-c, --config <file>`: Path to a custom configuration file (defaults to `~/.config/cairn/config.json` or `$XDG_CONFIG_HOME/cairn/config.json`).
- `-V, --version`: Output Cairn version.
- `-h, --help`: Display help and command usage.

### Commands Overview

| Command | Description |
| :--- | :--- |
| [`init`](#cairn-init) | Generate the initial configuration file with safe defaults. |
| [`add <path>`](#cairn-add-path) | Register a Git repository with remote, branch, and push options. |
| [`remove <path>`](#cairn-remove-path) | Unregister a Git repository from configuration. |
| [`list` / `ls`](#cairn-list--ls) | Display an interactive table of all configured repositories and status. |
| [`scan`](#cairn-scan) | Inspect repositories and preview planned commits without modifying anything. |
| [`run`](#cairn-run) | Execute the commit and push pipeline (dry run unless `--apply` is specified). |
| [`status`](#cairn-status) | Print the current system state, configuration path, lock status, and cron log. |
| [`ai check`](#cairn-ai-check) | Validate your AI provider connection and commit generation with a sample diff. |
| [`install`](#cairn-install) | Inject a marked daily cron block into your user's crontab. |
| [`uninstall`](#cairn-uninstall) | Remove Cairn's crontab block cleanly without affecting other cron jobs. |

---

### Detailed Command Usage

#### `cairn init`

Creates a default configuration file with strict permissions (`0600`).

```bash
cairn init [--force]
```

- `--force`: Overwrites an existing `config.json` file.

#### `cairn add <path>`

Registers a local Git repository with Cairn. Validates that the path exists and is a valid Git repository root.

```bash
cairn add <path> [--remote <name>] [--branch <name>] [--no-push]
```

- `<path>`: Filepath to the repository (supports `~` expansion).
- `--remote <name>`: Upstream remote name (defaults to `origin`).
- `--branch <name>`: Restrict commits to this branch only.
- `--no-push`: Stage and commit changes locally, but never push to remote.

#### `cairn remove <path>`

Unregisters a repository from Cairn's configuration.

```bash
cairn remove <path>
```

#### `cairn list` (Alias: `ls`)

Displays a formatted terminal table showing configured repositories, status, branches, push remotes, and local paths.

```bash
cairn list [--json]
```

- `--json`: Outputs the list of repositories in machine-readable JSON format.

#### `cairn scan`

Performs an end-to-end dry-run audit of changes across all repositories (or a single repository), displaying planned commits, excluded files, and push intentions.

```bash
cairn scan [--repo <path>] [--json]
```

- `--repo <path>`: Scan only the specified repository.
- `--json`: Format the scan report as JSON.

#### `cairn run`

Executes the scan, commit, and push pipeline. By default, it operates in **dry-run** mode unless `--apply` is provided or `dryRun: false` is configured.

```bash
cairn run [--apply] [--dry-run] [--due] [--repo <path>] [--json]
```

- `--apply`: Perform commits and pushes for real.
- `--dry-run`: Force dry-run preview, overriding `dryRun: false` in config.
- `--due`: Only run repositories whose scheduled daily time has elapsed and have not completed today.
- `--repo <path>`: Restrict the execution to a single repository.
- `--json`: Output execution results in structured JSON.

#### `cairn status`

Displays the health and state of Cairn, including configuration file location, total and enabled repositories, default execution mode, cron installation state, active locks, and log file paths.

```bash
cairn status
```

#### `cairn ai check`

Sends a mock diff to your configured AI provider (`commit.ai`) to verify endpoint reachability, credentials, and Conventional Commit response formatting.

```bash
cairn ai check
```

#### `cairn install`

Installs Cairn's 15-minute polling loop and `@reboot` catch-up task into your crontab under an isolated `# BEGIN cairn` marker block.

```bash
cairn install [--apply] [--time <HH:MM>]
```

- `--apply`: Configure the cron job to commit and push for real (without this, the cron job only runs dry-run reports to the log).
- `--time <HH:MM>`: Set the daily execution time (e.g., `21:30`).

#### `cairn uninstall`

Locates the `# BEGIN cairn ... # END cairn` block in your crontab and strips it, leaving all other personal cron entries untouched.

```bash
cairn uninstall
```

---

## Configuration Guide

Cairn stores its configuration at:
- **Default**: `~/.config/cairn/config.json`
- **XDG compliant**: `$XDG_CONFIG_HOME/cairn/config.json`

The file is written with strict `0600` permissions. The schema is validated using **Zod**; any unknown keys or malformed entries are rejected immediately to prevent silent configuration bugs.

### Configuration File Schema

Here is a fully annotated example configuration:

```json
{
  "$schema": "https://json.schemastore.org/cairn.json",
  "dryRun": true,
  "allowedBranches": ["main", "master"],
  "repos": [
    {
      "path": "/home/sam/projects/web-app",
      "remote": "origin",
      "branch": "main",
      "push": true,
      "enabled": true,
      "time": "18:00"
    },
    {
      "path": "/home/sam/projects/notes",
      "remote": "origin",
      "push": false,
      "enabled": true
    }
  ],
  "commit": {
    "messageTemplate": "{type}: {summary}",
    "maxFiles": 50,
    "maxFileSizeBytes": 1048576,
    "split": "none",
    "maxCommitsPerRun": 20,
    "blockedPaths": [
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "*.p12",
      "*.pfx",
      "*.jks",
      "*.keystore",
      "id_rsa*",
      "id_dsa*",
      "id_ecdsa*",
      "id_ed25519*",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      "credentials.json",
      "service-account*.json",
      "secrets.*",
      "**/.aws/**",
      "**/.ssh/**",
      "**/node_modules/**",
      "*.sqlite",
      "*.sqlite3",
      "*.db",
      "*.log"
    ],
    "allowedPaths": [
      ".env.example",
      ".env.sample",
      ".env.template"
    ],
    "ai": {
      "enabled": false,
      "baseUrl": "https://api.groq.com/openai/v1",
      "model": "openai/gpt-oss-20b",
      "apiKeyFile": "~/.config/cairn/ai.key",
      "apiKeyEnv": "GROQ_API_KEY",
      "maxDiffBytes": 12000,
      "timeoutSeconds": 30
    }
  },
  "push": {
    "includePending": false,
    "timeoutSeconds": 60
  },
  "schedule": {
    "time": "21:00"
  }
}
```

---

### Repository Settings

Each entry in `repos[]` supports:

- `path` *(string, required)*: Absolute or tilde-prefixed path to the repository root.
- `remote` *(string, default: `"origin"`)*: The Git remote to push to.
- `branch` *(string, optional)*: Restricts operations to a specific branch. If omitted, Cairn uses global `allowedBranches`.
- `push` *(boolean, default: `true`)*: If `false`, changes are safely committed locally but never pushed to the remote.
- `enabled` *(boolean, default: `true`)*: Temporarily toggle repository monitoring on or off without deleting the entry.
- `time` *(string `HH:MM`, optional)*: Assigns a custom daily schedule for this specific repository. If omitted, `schedule.time` is used.

---

### Commit & Split Settings

The `commit` object controls how changes are packaged into Git commits:

- `messageTemplate` *(string, default: `"{type}: {summary}"`)*: Template for rule-based messages.
  - `{type}`: Inferred category (`docs` for documentation, `test` for test files, `chore` for code/assets).
  - `{summary}`: Inferred action (`add <files>`, `update <files>`, `remove <files>`).
  - `{count}`: Total number of changed files in this commit.
- `maxFiles` *(number, default: `50`)*: If a repository has more than this number of changed files, the run is aborted to avoid unintentionally committing huge refactors or build artifacts.
- `maxFileSizeBytes` *(number, default: `1048576` / 1MB)*: Individual files larger than this size are skipped and reported.
- `split` *(string: `"none"` | `"file"`, default: `"none"`)*:
  - `"none"`: All safe changes are batched into a single commit per repository.
  - `"file"`: Each modified or added file receives its own distinct Git commit with its own specific commit message.
- `maxCommitsPerRun` *(number, default: `20`)*: When `split: "file"` is enabled, caps the number of commits generated in a single day. Remaining files are deferred for subsequent runs.
- `blockedPaths` *(string[])*: List of glob patterns that are never committed.
- `allowedPaths` *(string[])*: Whitelist glob patterns that override `blockedPaths` (e.g., allowing `.env.example`).

---

### Push Behavior & Unpushed Protection

- `includePending` *(boolean, default: `false`)*: By default, Cairn will **only** push commits created by Cairn itself during the current or previous incomplete runs. If you manually created unpushed commits in the repository, Cairn detects them and skips pushing to avoid publishing work you may still be testing. Set `includePending: true` to allow Cairn to push manual commits alongside automated ones.
- `timeoutSeconds` *(number, default: `60`)*: Timeout for Git network operations (fetch, push).

---

### Scheduling & Daily Timing

- `schedule.time` *(string `HH:MM`, default: `"21:00"`)*: The default 24-hour time of day when repositories become eligible to run.

---

## AI Commit Messages

Cairn can automatically generate high-quality, contextual commit messages in **Conventional Commits** format by inspecting the staged diff of your files.

When enabled, instead of generic messages like `chore: update auth.ts`, Cairn creates precise messages like:
`fix: handle expired JWT refresh tokens gracefully`

### Local AI via Ollama (Free & Private)

To keep all code and diffs completely offline on your local machine, run [Ollama](https://ollama.com/):

```bash
# 1. Install Ollama and pull a coding model
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5-coder:3b

# 2. Configure Cairn to use your local instance
```

In `~/.config/cairn/config.json`:

```json
"commit": {
  "ai": {
    "enabled": true,
    "baseUrl": "http://localhost:11434/v1",
    "model": "qwen2.5-coder:3b"
  }
}
```

Verify with:

```bash
cairn ai check
```

---

### Cloud Providers (Groq, Gemini, OpenRouter)

Cairn is compatible with any OpenAI-compatible API endpoint:

| Provider | `baseUrl` | Recommended Models |
| :--- | :--- | :--- |
| **Groq** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile`, `openai/gpt-oss-20b` |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-1.5-flash`, `gemini-2.0-flash` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct` |

#### Secure API Key Storage

Because cron runs in an isolated environment without your interactive shell environment variables, store your API key in a restricted file:

```bash
echo "gsk_your_groq_api_key_here" > ~/.config/cairn/ai.key
chmod 600 ~/.config/cairn/ai.key
```

Configure `config.json`:

```json
"commit": {
  "ai": {
    "enabled": true,
    "baseUrl": "https://api.groq.com/openai/v1",
    "model": "llama-3.3-70b-versatile",
    "apiKeyFile": "~/.config/cairn/ai.key"
  }
}
```

---

### Diff Sanitization & Fallback Mechanics

1. **Security Filtering First**: Diffs sent to the AI model **only** contain files that have already passed all secret detection and size checks. Lockfiles (`package-lock.json`, `pnpm-lock.yaml`), minified bundles, and source maps are stripped from the diff context.
2. **Byte Truncation**: Diffs are safely truncated at `maxDiffBytes` (default: `12,000` bytes) to prevent model context overflows.
3. **Resilient Fallback**: If the AI endpoint times out, returns an HTTP error, or outputs text not conforming to Conventional Commits, Cairn automatically falls back to rule-based message generation without interrupting the run.
4. **Failure Circuit-Breaker**: If an AI request fails once during a run, remaining commits in that run immediately revert to rule-based generation to prevent slow retries or timeouts.
5. **Dry-Run Privacy**: Dry runs (`cairn scan` or `cairn run`) never send diffs to external models; they display rule-based estimates.

---

## Safety Model & Secret Scanning

Cairn is engineered around defense-in-depth safety principles to ensure unattended background runs never corrupt repositories or leak private data.

### Repository-Level Safety Guards

A repository is skipped immediately without staging or committing if:

- The folder path is missing or is not a valid Git repository root.
- An in-progress operation is active: `.git/MERGE_HEAD`, `.git/rebase-apply`, `.git/rebase-merge`, `.git/CHERRY_PICK_HEAD`, `.git/REVERT_HEAD`, or `.git/BISECT_LOG`.
- HEAD is detached (no active branch).
- The current branch is not in `allowedBranches` (or the repository's specified `branch`).
- Unresolved Git merge conflicts are detected.
- The number of changed files exceeds `commit.maxFiles`.
- Any file already staged in the Git index violates safety or secret checks.

---

### File-Level Safety & Secret Inspection

Individual files are excluded from commits and surfaced in warning reports if:

1. **Path Blocklist**: Matches `commit.blockedPaths` (e.g. `.env`, `.pem`, `id_rsa`, `.npmrc`, `.aws/`, `node_modules/`, `*.sqlite`, `*.log`).
2. **Size Overrun**: Exceeds `commit.maxFileSizeBytes` (default 1MB).
3. **Directory/Submodule**: Path is a directory or nested git submodule.
4. **Secret Scanner Detection**: The file content matches any of the built-in secret patterns:
   - **Private Keys**: RSA, EC, DSA, OPENSSH, PGP, ENCRYPTED PRIVATE KEY blocks.
   - **AWS Keys**: Access Key IDs (`AKIA...`, `ASIA...`).
   - **GitHub Tokens**: Personal access tokens (`ghp_...`, `gho_...`, `github_pat_...`).
   - **Slack Tokens**: Bot and user tokens (`xoxb-...`, `xoxp-...`).
   - **Stripe API Keys**: Live secret keys (`sk_live_...`, `rk_live_...`).
   - **Google API Keys**: Cloud credentials (`AIza...`).
   - **JSON Web Tokens (JWT)**: Complete token structures (`eyJ...`).
   - **URL Credentials**: Embedded basic authentication passwords (`https://user:pass@host`).
   - **Hardcoded Secret Assignments**: Code variables matching `apiKey = "..."`, `password = "..."`, etc.

> [!NOTE]
> When Cairn detects a secret, reports display only the file name, triggering rule name, and line number. **The secret value itself is never logged or exposed.**

---

### Atomic Index Verification & Rollback

- **Explicit Staging**: Cairn never issues blanket `git add .` commands. It stages files explicitly by relative path: `git add -A -- <path1> <path2>`.
- **Pre-Commit Verification**: After staging, Cairn queries the Git index via `diff --cached`. If any file exists in the index that was not explicitly planned, staging is immediately rolled back via `git reset -q` and the run aborts.
- **Hook Protection**: If a pre-commit or pre-push hook exits with a non-zero code, Cairn catches the failure, halts execution, and reports the failure without leaving dangling states.

---

## Scheduling, Catch-Up & State Management

### Crontab Integration

Running `cairn install --apply` inserts a marked block into your crontab:

```cron
# BEGIN cairn
*/15 * * * * PATH='/usr/bin:/bin' '/usr/bin/node' '/path/to/dist/cli.js' run --apply --due >> '/home/user/.local/state/cairn/cron.log' 2>&1
@reboot sleep 90 && PATH='/usr/bin:/bin' '/usr/bin/node' '/path/to/dist/cli.js' run --apply --due >> '/home/user/.local/state/cairn/cron.log' 2>&1
# END cairn
```

- **Cron acts as a trigger, not the decision-maker**: Cron wakes Cairn every 15 minutes. Cairn evaluates each repository's target time against the persistent state in `~/.local/state/cairn/state.json`.
- **Negligible CPU Footprint**: If no repositories are due, Cairn exits within milliseconds without generating log spam.

---

### Catch-Up & Offline Behavior

- **Machine Asleep / Offline Catch-Up**: If your laptop or workstation was turned off at 21:00, Cairn will automatically trigger the run during the first 15-minute check or reboot after waking up.
- **Accurate Timestamps**: Catch-up commits carry the real timestamp of when they were actually created (never backdated).
- **Network Outage Resilience**: If an internet connection is unavailable, Cairn completes the local commit and records the pending commit SHA in state. On subsequent 15-minute wake-ups, Cairn detects the pending commit and retries the push without re-committing.
- **Single Run Per Day Guarantee**: Once a repository successfully finishes its daily run, it will not run again until the following calendar day, even if subsequent file changes occur.

---

### State Persistence & Lock Files

- **State File**: Stored at `~/.local/state/cairn/state.json`. Tracks `lastDone` (YYYY-MM-DD), `lastPreview`, and pending unpushed commit hashes per repository.
- **Process Lock**: Stored at `~/.local/state/cairn/run.lock`. Contains the active PID. Prevents cron triggers from running concurrently with manual CLI invocations. If a previous process crashed, Cairn detects the dead PID and safely reclaims the lock.

---

## Development & Testing

Cairn is built with TypeScript and Vitest. The test suite includes comprehensive unit tests and full end-to-end integration tests executed against real temporary Git repositories.

### Development Commands

```bash
# Run CLI directly from TypeScript source
npm run dev -- scan

# Typecheck codebase without emitting files
npm run typecheck

# Build production bundle to dist/
npm run build

# Run Vitest test suite
npm test
```

### Writing Tests

Integration tests in `tests/workflow.test.ts` spin up isolated Git repositories in `/tmp`, create branches, modify files, simulate secrets, and verify that Git commit and push behaviors adhere to all safety guarantees.

---

## License

This project is licensed under the [MIT License](LICENSE).
