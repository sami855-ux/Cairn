export interface Finding {
  rule: string;
  line: number;
}

interface Rule {
  name: string;
  pattern: RegExp;
  validate?: (match: RegExpMatchArray) => boolean;
}

const PLACEHOLDER = /example|your|placeholder|changeme|change_me|dummy|sample|xxxx|\*{3,}|<[^>]+>|\$\{|process\.env|os\.environ|getenv/i;
const COMMON_PASSWORDS = /^(password|pass|secret|postgres|root|admin|test|mypassword|user)$/i;

const RULES: Rule[] = [
  {
    name: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Stripe live key', pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: 'credentials in URL',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:([^\s@/'"]{3,})@[^\s/'"]+/i,
    validate: (match) => !PLACEHOLDER.test(match[1]) && !COMMON_PASSWORDS.test(match[1]),
  },
  {
    name: 'hardcoded secret',
    pattern:
      /(?:api[_-]?key|secret|passwd|password|token|auth[_-]?token|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']([A-Za-z0-9/+=_.-]{16,})["']/i,
    validate: (match) =>
      /\d/.test(match[1]) && /[A-Za-z]/.test(match[1]) && !PLACEHOLDER.test(match[1]),
  },
];

const MAX_LINE_LENGTH = 20_000;

export function findSecrets(text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.length > MAX_LINE_LENGTH) return;
    for (const rule of RULES) {
      const match = line.match(rule.pattern);
      if (match && (!rule.validate || rule.validate(match))) {
        findings.push({ rule: rule.name, line: index + 1 });
        break;
      }
    }
  });
  return findings;
}

export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}
