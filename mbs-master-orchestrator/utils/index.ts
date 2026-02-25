import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";

export function deterministicHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashFile(filePath: string): string {
  if (!existsSync(filePath)) return deterministicHash("__missing__");
  return deterministicHash(readFileSync(filePath, "utf-8"));
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function writeJSON(filePath: string, data: unknown): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function readJSON<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

export function writeText(filePath: string, content: string): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, content, "utf-8");
}

export function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function currentWeekNumber(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now.getTime() - start.getTime();
  return Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
}

export function findFiles(dir: string, pattern: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (entry === pattern) results.push(full);
      } catch { /* skip unreadable */ }
    }
  };
  walk(dir);
  return results;
}

export function safeReadJSON<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    return readJSON<T>(filePath);
  } catch { return fallback; }
}

export const GENERATOR_VERSION = "1.8.0";
export const SCHEMA_VERSION = "1.0.0" as const;
