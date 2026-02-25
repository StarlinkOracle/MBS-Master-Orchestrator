/**
 * MBS Master Orchestrator — Geo Priority Engine (vNext)
 * 
 * Supports two modes:
 * 1. zipWeights (new): flat map of zip → weight, all starting at 1.0
 * 2. tiers (legacy): hierarchical tier-based weights
 * 
 * zipWeights takes precedence when present. Tiers are informational only.
 */

import { resolve } from "path";
import type {
  GeoPriorityConfig, GeoTierName, GeoTier, PlanIntent,
} from "../../types/index.js";
import { safeReadJSON } from "../../utils/index.js";

const ROOT = process.cwd();

// ============================================================
// Load config
// ============================================================

let _cachedConfig: GeoPriorityConfig | null = null;

export function loadGeoPriorityConfig(): GeoPriorityConfig {
  if (_cachedConfig) return _cachedConfig;
  _cachedConfig = safeReadJSON<GeoPriorityConfig>(
    resolve(ROOT, "config/geo_priority.json"),
    {
      baseZip: "80212",
      maxRadiusMiles: 60,
      zipWeights: {},
      learning: {
        enabled: true,
        mode: "CONSERVATIVE",
        minDataWindowDays: 14,
        minLeadsPerZip: 5,
        maxWeight: 1.4,
        minWeight: 0.8,
        stepUp: 0.05,
        stepDown: 0.05,
      },
    }
  );
  return _cachedConfig;
}

export function resetGeoCache(): void {
  _cachedConfig = null;
}

// ============================================================
// Core functions (zipWeights-first, tier fallback)
// ============================================================

/**
 * Get the zip weight. Checks zipWeights first, falls back to tiers.
 * Unknown zips return 1.0 (neutral).
 */
export function getZipWeight(zip: string): number {
  const config = loadGeoPriorityConfig();
  // zipWeights-first
  if (config.zipWeights && config.zipWeights[zip] != null) {
    return config.zipWeights[zip];
  }
  // Legacy tier fallback
  if (config.tiers) {
    for (const tier of Object.values(config.tiers)) {
      if (tier.zips[zip] != null) return tier.zips[zip];
    }
  }
  return 1.0;
}

/**
 * Get all configured zips with their weights.
 * Returns zipWeights if present, otherwise collects from tiers.
 */
export function getAllZipWeights(): Record<string, number> {
  const config = loadGeoPriorityConfig();
  if (config.zipWeights && Object.keys(config.zipWeights).length > 0) {
    return { ...config.zipWeights };
  }
  // Legacy: collect from tiers
  const result: Record<string, number> = {};
  if (config.tiers) {
    for (const tier of Object.values(config.tiers)) {
      for (const [zip, weight] of Object.entries(tier.zips)) {
        result[zip] = weight;
      }
    }
  }
  return result;
}

/**
 * Get the tier name for a zip. With zipWeights mode, returns "unknown"
 * since tiers are informational only.
 */
export function getTier(zip: string): GeoTierName | "unknown" {
  const config = loadGeoPriorityConfig();
  if (config.tiers) {
    for (const [tierName, tier] of Object.entries(config.tiers)) {
      if (tier.zips[zip] != null) return tierName as GeoTierName;
    }
  }
  return "unknown";
}

/**
 * Compute geo-adjusted score: baseActionScore x zipWeight.
 */
export function getGeoAdjustedScore(baseScore: number, zip: string): number {
  return Math.round(baseScore * getZipWeight(zip) * 100) / 100;
}

/**
 * Check if zip is a known target zip (in zipWeights or any tier).
 */
export function isTargetZip(zip: string): boolean {
  const config = loadGeoPriorityConfig();
  if (config.zipWeights && config.zipWeights[zip] != null) return true;
  if (config.tiers) {
    for (const tier of Object.values(config.tiers)) {
      if (tier.zips[zip] != null) return true;
    }
  }
  return false;
}

/**
 * Returns true only if the zip is in tier1_core (legacy compat).
 */
export function isHighPriority(zip: string): boolean {
  return getTier(zip) === "tier1_core";
}

// ============================================================
// Tier enumeration helpers (legacy compat)
// ============================================================

export function getZipsInTier(tierName: GeoTierName): Record<string, number> {
  const config = loadGeoPriorityConfig();
  return config.tiers?.[tierName]?.zips ?? {};
}

/**
 * Get top zips sorted by weight descending.
 * Uses zipWeights if available, otherwise tier1.
 */
export function getTier1ZipsSorted(): { zip: string; weight: number }[] {
  const config = loadGeoPriorityConfig();
  if (config.zipWeights && Object.keys(config.zipWeights).length > 0) {
    return Object.entries(config.zipWeights)
      .map(([zip, weight]) => ({ zip, weight }))
      .sort((a, b) => b.weight - a.weight);
  }
  const zips = getZipsInTier("tier1_core");
  return Object.entries(zips)
    .map(([zip, weight]) => ({ zip, weight }))
    .sort((a, b) => b.weight - a.weight);
}

export function getTier2ZipsSorted(): { zip: string; weight: number }[] {
  const zips = getZipsInTier("tier2_upgrade");
  return Object.entries(zips)
    .map(([zip, weight]) => ({ zip, weight }))
    .sort((a, b) => b.weight - a.weight);
}

// ============================================================
// Tier saturation + intent biasing
// ============================================================

const BOULDER_EFFICIENCY_THRESHOLD = 0.75;

/**
 * Check tier1 saturation. With zipWeights mode, check coverage of target zips.
 */
export function isTier1Saturated(intents: PlanIntent[]): boolean {
  const config = loadGeoPriorityConfig();
  let targetZips: Set<string>;
  
  if (config.zipWeights && Object.keys(config.zipWeights).length > 0) {
    targetZips = new Set(Object.keys(config.zipWeights));
  } else {
    targetZips = new Set(Object.keys(getZipsInTier("tier1_core")));
  }
  if (targetZips.size === 0) return true;

  const coveredZips = new Set<string>();
  for (const intent of intents) {
    if (intent.zip && targetZips.has(intent.zip)) {
      coveredZips.add(intent.zip);
    }
  }
  return coveredZips.size / targetZips.size >= 0.7;
}

export function shouldSuppressBoulder(zip: string, baseScore: number): boolean {
  const tier = getTier(zip);
  if (tier !== "tier4_boulder_reduced") return false;
  const adjusted = getGeoAdjustedScore(baseScore, zip);
  return adjusted < baseScore * BOULDER_EFFICIENCY_THRESHOLD;
}

/**
 * Apply geo-priority biasing to plan intents.
 * With zipWeights mode: score by weight, sort by geoAdjustedScore.
 * With tier mode: sort by tier priority.
 */
export function applyGeoPriorityBias(intents: PlanIntent[]): PlanIntent[] {
  const config = loadGeoPriorityConfig();
  const usingZipWeights = config.zipWeights && Object.keys(config.zipWeights).length > 0;

  for (const intent of intents) {
    if (intent.zip) {
      intent.geoTier = usingZipWeights ? "unknown" : getTier(intent.zip);
      intent.geoAdjustedScore = getGeoAdjustedScore(
        intent.expectedConversionValue || 0,
        intent.zip
      );
    } else {
      intent.geoTier = "unknown";
      intent.geoAdjustedScore = intent.expectedConversionValue || 0;
    }
  }

  const kept: PlanIntent[] = [];
  for (const intent of intents) {
    // Only suppress boulder in legacy tier mode
    if (
      !usingZipWeights &&
      intent.zip &&
      intent.geoTier === "tier4_boulder_reduced" &&
      shouldSuppressBoulder(intent.zip, intent.expectedConversionValue || 0)
    ) {
      continue;
    }
    kept.push(intent);
  }

  // Sort by priority, then geoAdjustedScore
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  kept.sort((a, b) => {
    const priDiff = (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
    if (priDiff !== 0) return priDiff;
    return (b.geoAdjustedScore || 0) - (a.geoAdjustedScore || 0);
  });

  return kept;
}

/**
 * Count intents per tier for reporting.
 */
export function countIntentsByTier(intents: PlanIntent[]): Record<GeoTierName | "unknown", number> {
  const counts: Record<string, number> = {
    tier1_core: 0,
    tier2_upgrade: 0,
    tier3_selective: 0,
    tier4_boulder_reduced: 0,
    unknown: 0,
  };
  for (const intent of intents) {
    const tier = intent.geoTier || (intent.zip ? getTier(intent.zip) : "unknown");
    counts[tier] = (counts[tier] || 0) + 1;
  }
  return counts as Record<GeoTierName | "unknown", number>;
}
