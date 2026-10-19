// Personal settings, kept out of the tool: where reviews are sent and published.
// File: $PR_EXPLAINER_CONFIG, else ~/.config/pr-explainer/config.json
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** "json:<url>" or "form:<url>"; where the page's Send button goes */
  submit?: string;
  /** prefix for feedback ids (default "pr-") */
  formIdPrefix?: string;
  /** longest note the receiver keeps */
  noteLimit?: number;
  /** a JSON-lines file the receiver appends to; `pr-explainer answers` reads it */
  answersFile?: string;
  /** run after render; {name} = feedback id, {dir} = page folder, {file} = page file (all shell-quoted) */
  publishCommand?: string;
}

export function configPath(): string {
  return process.env.PR_EXPLAINER_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pr-explainer", "config.json");
}

export function loadConfig(): Config {
  let raw: string;
  try { raw = readFileSync(configPath(), "utf8"); } catch { return {}; }
  const c = JSON.parse(raw) as Config;
  if (c.submit !== undefined && !/^(json|form):\S+$/.test(c.submit)) throw new Error(`${configPath()}: submit must look like "json:<url>" or "form:<url>"`);
  return c;
}

export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function fillCommand(cmd: string, vars: Record<string, string>): string {
  return cmd.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? shellQuote(vars[k]!) : m));
}
