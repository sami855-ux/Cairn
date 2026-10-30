/**
 * Shared CLI utility helpers used across command modules.
 * Centralises colorEnabled(), formatOptions(), and the command() error wrapper
 * so all commands have consistent behaviour without duplication.
 */
import { formatError } from './format.js';

export const colorEnabled = (): boolean => {
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  if (process.env.NO_COLOR !== undefined) return false;
  return Boolean(process.stdout.isTTY);
};

export const formatOptions = () => ({ color: colorEnabled() });

/** Wraps an async command handler so any thrown error is printed consistently and sets exit code 1. */
export function command<T extends unknown[]>(fn: (...args: T) => Promise<void>) {
  return async (...args: T): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(formatError(error instanceof Error ? error.message : String(error), formatOptions()));
      process.exitCode = 1;
    }
  };
}
