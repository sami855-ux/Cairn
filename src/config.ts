import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defaultConfigPath, resolveRepoPath } from './paths.js';

export const DEFAULT_BLOCKED_PATHS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'credentials.json',
  'service-account*.json',
  'secrets.*',
  '**/.aws/**',
  '**/.ssh/**',
  '**/node_modules/**',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.log',
];

export const DEFAULT_ALLOWED_PATHS = ['.env.example', '.env.sample', '.env.template'];

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const repoSchema = z
  .object({
    path: z.string().min(1),
    remote: z.string().min(1).default('origin'),
    branch: z.string().min(1).optional(),
    push: z.boolean().default(true),
    enabled: z.boolean().default(true),
    time: z.string().regex(TIME_PATTERN, 'must look like 21:30').optional(),
  })
  .strict();

const aiSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().default('https://api.groq.com/openai/v1'),
    model: z.string().min(1).default('openai/gpt-oss-20b'),
    apiKeyEnv: z.string().min(1).optional(),
    apiKeyFile: z.string().min(1).default('~/.config/cairn/ai.key'),
    maxDiffBytes: z.number().int().positive().default(12000),
    timeoutSeconds: z.number().int().positive().default(30),
  })
  .strict();

const configSchema = z
  .object({
    primary: z.string().min(1).optional(),
    dryRun: z.boolean().default(true),
    allowedBranches: z.array(z.string().min(1)).min(1).default(['main', 'master']),
    repos: z.array(repoSchema).default([]),
    commit: z
      .object({
        messageTemplate: z.string().min(1).default('{type}: {summary}'),
        maxFiles: z.number().int().positive().default(50),
        maxFileSizeBytes: z.number().int().positive().default(1_048_576),
        blockedPaths: z.array(z.string()).default(DEFAULT_BLOCKED_PATHS),
        allowedPaths: z.array(z.string()).default(DEFAULT_ALLOWED_PATHS),
        split: z.enum(['none', 'file']).default('none'),
        maxCommitsPerRun: z.number().int().positive().default(20),
        ai: aiSchema.default({}),
      })
      .strict()
      .default({}),
    push: z
      .object({
        includePending: z.boolean().default(false),
        timeoutSeconds: z.number().int().positive().default(60),
        autoPull: z.boolean().default(false),
      })
      .strict()
      .default({}),
    schedule: z
      .object({
        time: z
          .string()
          .regex(TIME_PATTERN, 'must look like 21:30')
          .default('21:00'),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.primary !== undefined) {
      const primary = data.primary;
      const match = data.repos.some(
        (r) => r.path === primary || resolveRepoPath(r.path) === resolveRepoPath(primary),
      );
      if (!match) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['primary'],
          message: `primary repository "${primary}" is not in repos`,
        });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;
export type RepoConfig = z.infer<typeof repoSchema>;
export type AiConfig = z.infer<typeof aiSchema>;

export class ConfigError extends Error {}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`invalid config\n${issues}`);
  }
  return result.data;
}

export function defaultConfig(): Config {
  return configSchema.parse({});
}

export async function loadConfig(file: string = defaultConfigPath()): Promise<Config> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`no config at ${file}, run "cairn init" first`);
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`config at ${file} is not valid JSON`);
  }
  return parseConfig(raw);
}

export async function saveConfig(config: Config, file: string = defaultConfigPath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}