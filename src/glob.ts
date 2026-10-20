export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(glob.includes('/') ? `^${source}$` : `^(?:.*/)?${source}$`);
}

export function matchesAny(relativePath: string, patterns: string[]): boolean {
  const normalized = relativePath.split('\\').join('/');
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}
