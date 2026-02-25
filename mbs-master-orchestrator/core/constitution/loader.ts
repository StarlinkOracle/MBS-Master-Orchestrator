/**
 * MBS Master Orchestrator — Constitution Loader
 * 
 * Loads and validates the Constitution document.
 * FAIL CLOSED: If the constitution is missing, malformed, or lacks
 * required fields, the loader throws (process must exit non-zero).
 */

import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import type { Constitution, ConstitutionBoot } from "../../types/index.js";

const ROOT = process.cwd();

const REQUIRED_TOP_KEYS = [
  "constitution_version",
  "season_matrix",
  "budget_enforcement",
  "geo_controls",
  "capacity_protection",
  "invariants",
];

const REQUIRED_MONTHS = ["1","2","3","4","5","6","7","8","9","10","11","12"];

let _cache: ConstitutionBoot | null = null;

/**
 * Resolve the constitution file path.
 * Priority: MBS_CONSTITUTION_PATH env → config/constitution.json
 */
function resolveConstitutionPath(): string {
  const envPath = process.env.MBS_CONSTITUTION_PATH;
  if (envPath) return resolve(envPath);
  return resolve(ROOT, "config/constitution.json");
}

/**
 * Compute SHA-256 hash of the raw constitution file.
 */
function computeHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Validate that the constitution has all required structure.
 * Returns an array of validation errors (empty = valid).
 */
function validateStructure(data: any): string[] {
  const errors: string[] = [];

  if (!data || typeof data !== "object") {
    errors.push("Constitution is not a valid JSON object");
    return errors;
  }

  for (const key of REQUIRED_TOP_KEYS) {
    if (!(key in data)) {
      errors.push(`Missing required key: "${key}"`);
    }
  }

  if (errors.length > 0) return errors;

  // Validate constitution_version
  if (typeof data.constitution_version !== "string" || data.constitution_version.length === 0) {
    errors.push("constitution_version must be a non-empty string");
  }

  // Validate season_matrix has all 12 months
  if (typeof data.season_matrix === "object") {
    for (const m of REQUIRED_MONTHS) {
      if (!(m in data.season_matrix)) {
        errors.push(`season_matrix missing month ${m}`);
      } else {
        const entry = data.season_matrix[m];
        if (!entry.season) errors.push(`season_matrix[${m}] missing season`);
        if (!Array.isArray(entry.primary_services)) errors.push(`season_matrix[${m}] missing primary_services`);
        if (!Array.isArray(entry.blocked_services)) errors.push(`season_matrix[${m}] missing blocked_services`);
        if (typeof entry.upgrade_bias !== "boolean") errors.push(`season_matrix[${m}] missing upgrade_bias`);
      }
    }
  }

  // Validate budget_enforcement
  if (typeof data.budget_enforcement === "object") {
    if (typeof data.budget_enforcement.max_weekly_change_pct !== "number") {
      errors.push("budget_enforcement.max_weekly_change_pct must be a number");
    }
  }

  // Validate geo_controls
  if (typeof data.geo_controls === "object") {
    if (typeof data.geo_controls.core_zip_min_weight !== "number") {
      errors.push("geo_controls.core_zip_min_weight must be a number");
    }
    if (typeof data.geo_controls.new_zip_activation_cap_per_week !== "number") {
      errors.push("geo_controls.new_zip_activation_cap_per_week must be a number");
    }
  }

  // Validate capacity_protection
  if (typeof data.capacity_protection === "object") {
    if (typeof data.capacity_protection.weekly_lead_cap_default !== "number") {
      errors.push("capacity_protection.weekly_lead_cap_default must be a number");
    }
  }

  // Validate invariants
  if (!Array.isArray(data.invariants) || data.invariants.length === 0) {
    errors.push("invariants must be a non-empty array");
  }

  return errors;
}

/**
 * Boot the constitution. 
 * Returns ConstitutionBoot on success.
 * Throws on failure (caller must handle as process exit).
 */
export function bootConstitution(): ConstitutionBoot {
  if (_cache) return _cache;

  const path = resolveConstitutionPath();

  // --- Existence check ---
  if (!existsSync(path)) {
    throw new Error(
      `CONSTITUTION FAIL-CLOSED: Constitution file not found at "${path}". ` +
      `Set MBS_CONSTITUTION_PATH or place config/constitution.json.`
    );
  }

  // --- Read raw content ---
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `CONSTITUTION FAIL-CLOSED: Unable to read constitution at "${path}": ${err}`
    );
  }

  // --- Parse JSON ---
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `CONSTITUTION FAIL-CLOSED: Constitution is not valid JSON: ${err}`
    );
  }

  // --- Structural validation ---
  const errors = validateStructure(data);
  if (errors.length > 0) {
    throw new Error(
      `CONSTITUTION FAIL-CLOSED: Validation errors:\n  - ${errors.join("\n  - ")}`
    );
  }

  // --- Compute hash ---
  const hash = computeHash(raw);

  const boot: ConstitutionBoot = {
    constitution: data as Constitution,
    constitution_version: data.constitution_version,
    constitution_hash: hash,
  };

  _cache = boot;
  return boot;
}

/**
 * Reset the cached constitution (for testing).
 */
export function resetConstitutionCache(): void {
  _cache = null;
}

/**
 * Get the cached boot or throw.
 */
export function getConstitutionBoot(): ConstitutionBoot {
  if (_cache) return _cache;
  return bootConstitution();
}
