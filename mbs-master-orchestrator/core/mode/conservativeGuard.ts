/**
 * MBS Master Orchestrator — Conservative Mode Guard
 * Protects profit and minimizes advertising waste.
 *
 * Scale-up only allowed when ALL conditions met:
 *   - CPL < targetCPL * scaleThresholdMultiplier (0.8)
 *   - QualifiedLeadScore >= qualityThreshold
 *   - Close rate drop < 10%
 *   - IS lost to budget > 10%
 *   - travelDistance < travelDistanceLimitMiles (35)
 *   - Capacity available (backlog < max)
 *
 * Pullback triggered if ANY condition met:
 *   - CPL >= targetCPL * pullbackThresholdMultiplier (1.0)
 *   - ProfitEfficiencyScore < 0
 *   - Tier4 AND CPL above target
 *   - wasteSpendRatio > wasteSpendThreshold (0.25)
 */

import { resolve } from "path";
import type {
  ModeConfig, CapacityConfig, ConservativeGuardInput, ConservativeGuardResult,
  ConservativeGuardOutput, TierExpansionCheck, GeoTierName, PlanIntent,
} from "../../types/index.js";
import { safeReadJSON, nowISO } from "../../utils/index.js";
import { loadConversionConfig } from "../metrics/conversions.js";
import { getTier, isTier1Saturated, getZipsInTier } from "../geo/geoPriorityEngine.js";

const ROOT = process.cwd();

// ============================================================
// Config loaders
// ============================================================

let _modeCache: ModeConfig | null = null;
let _capCache: CapacityConfig | null = null;

export function loadModeConfig(): ModeConfig {
  if (_modeCache) return _modeCache;
  _modeCache = safeReadJSON<ModeConfig>(
    resolve(ROOT, "config/mode.json"),
    {
      mode: "CONSERVATIVE",
      scaleThresholdMultiplier: 0.8,
      pullbackThresholdMultiplier: 1.0,
      travelDistanceLimitMiles: 35,
      boulderDistanceLimitMiles: 45,
      tier1ExpansionThreshold: 0.8,
      wasteSpendThreshold: 0.25,
    }
  );
  return _modeCache;
}

export function loadCapacityConfig(): CapacityConfig {
  if (_capCache) return _capCache;
  _capCache = safeReadJSON<CapacityConfig>(
    resolve(ROOT, "config/capacity.json"),
    { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 0 }
  );
  return _capCache;
}

export function resetModeCache(): void {
  _modeCache = null;
  _capCache = null;
}

// ============================================================
// Capacity gate
// ============================================================

/**
 * Check if capacity is available (backlog < max).
 */
export function isCapacityAvailable(capConfig?: CapacityConfig): boolean {
  const cap = capConfig || loadCapacityConfig();
  return cap.currentBacklogHours < cap.maxBacklogHours;
}

// ============================================================
// Conservative scale/pullback evaluation
// ============================================================

const QUALITY_THRESHOLD = 0.60;
const MAX_CLOSE_RATE_DROP = 0.10;

/**
 * Evaluate a single zip under conservative mode rules.
 */
export function evaluateConservative(
  input: ConservativeGuardInput,
  targetCPL: number,
  modeConfig?: ModeConfig,
  capConfig?: CapacityConfig,
): ConservativeGuardResult {
  const mode = modeConfig || loadModeConfig();
  const cap = capConfig || loadCapacityConfig();
  const tier = getTier(input.zip);
  const triggers: string[] = [];

  const base: Omit<ConservativeGuardResult, "action" | "recommendedBidModifier" | "reason"> = {
    zip: input.zip,
    tier,
    currentBidModifier: input.currentBidModifier,
    triggers,
  };

  // ---- PULLBACK checks (ANY triggers pullback) ----

  // Tier4 + CPL above target → suppress entirely
  if (tier === "tier4_boulder_reduced" && input.costPerWeightedLead >= targetCPL) {
    triggers.push("tier4_cpl_above_target");
    return {
      ...base,
      action: "suppress",
      recommendedBidModifier: 0,
      reason: `PULLBACK: Tier4 boulder ZIP ${input.zip} with CPL $${input.costPerWeightedLead.toFixed(2)} >= target $${targetCPL}`,
      triggers,
    };
  }

  // Travel distance above conservative limit + CPL above target
  if (input.travelDistanceMiles > mode.travelDistanceLimitMiles && input.costPerWeightedLead >= targetCPL) {
    triggers.push("travel_distance_exceeded");
    return {
      ...base,
      action: "suppress",
      recommendedBidModifier: 0,
      reason: `PULLBACK: Travel ${input.travelDistanceMiles}mi > limit ${mode.travelDistanceLimitMiles}mi AND CPL above target`,
      triggers,
    };
  }

  // CPL >= targetCPL * pullbackThresholdMultiplier
  const pullbackCPL = targetCPL * mode.pullbackThresholdMultiplier;
  if (input.costPerWeightedLead >= pullbackCPL) {
    triggers.push("cpl_above_pullback_threshold");
  }

  // ProfitEfficiencyScore < 0
  if (input.profitEfficiencyScore != null && input.profitEfficiencyScore < 0) {
    triggers.push("negative_profit");
  }

  // wasteSpendRatio > threshold
  if (input.wasteSpendRatio != null && input.wasteSpendRatio > mode.wasteSpendThreshold) {
    triggers.push("waste_spend_exceeded");
  }

  // If any pullback triggers hit → reduce bid
  if (triggers.length > 0) {
    const newMod = Math.max(input.currentBidModifier - 10, -100);
    return {
      ...base,
      action: "pullback",
      recommendedBidModifier: newMod,
      reason: `PULLBACK: ${triggers.join(", ")} — reduce bid 10%`,
      triggers,
    };
  }

  // ---- SCALE checks (ALL must pass) ----

  const scaleCPL = targetCPL * mode.scaleThresholdMultiplier;
  const scaleBlocks: string[] = [];

  // CPL must be below conservative threshold
  if (input.costPerWeightedLead >= scaleCPL) {
    scaleBlocks.push(`CPL $${input.costPerWeightedLead.toFixed(2)} >= conservative threshold $${scaleCPL.toFixed(2)}`);
  }

  // Qualified lead score must meet threshold
  if (input.qualifiedLeadScore != null && input.qualifiedLeadScore < QUALITY_THRESHOLD) {
    scaleBlocks.push(`quality score ${input.qualifiedLeadScore.toFixed(2)} < threshold ${QUALITY_THRESHOLD}`);
  }

  // Close rate drop must be < 10%
  if (input.closeRateDrop != null && input.closeRateDrop >= MAX_CLOSE_RATE_DROP) {
    scaleBlocks.push(`close rate drop ${(input.closeRateDrop * 100).toFixed(1)}% >= 10%`);
  }

  // IS lost to budget must be > 10%
  if (input.impressionShareLostToBudget <= 10) {
    scaleBlocks.push(`IS lost ${input.impressionShareLostToBudget.toFixed(1)}% <= 10%`);
  }

  // Travel distance must be within conservative limit
  if (input.travelDistanceMiles >= mode.travelDistanceLimitMiles) {
    scaleBlocks.push(`travel ${input.travelDistanceMiles}mi >= limit ${mode.travelDistanceLimitMiles}mi`);
  }

  // Capacity must be available
  if (!isCapacityAvailable(cap)) {
    scaleBlocks.push(`capacity blocked: backlog ${cap.currentBacklogHours}h >= max ${cap.maxBacklogHours}h`);
    // Special return for capacity block
    if (scaleBlocks.length === 1) {
      return {
        ...base,
        action: "block_capacity",
        recommendedBidModifier: input.currentBidModifier,
        reason: `BLOCKED: ${scaleBlocks[0]}`,
        triggers: ["capacity_exceeded"],
      };
    }
  }

  // If all scale checks pass → scale allowed
  if (scaleBlocks.length === 0) {
    const newMod = Math.min(input.currentBidModifier + 10, 50);
    return {
      ...base,
      action: "scale",
      recommendedBidModifier: newMod,
      reason: `SCALE: CPL $${input.costPerWeightedLead.toFixed(2)} < ${scaleCPL.toFixed(2)}, IS lost ${input.impressionShareLostToBudget.toFixed(1)}%, quality OK, capacity OK`,
      triggers: ["all_scale_checks_passed"],
    };
  }

  // Some scale checks failed → hold (with blocked reasons)
  return {
    ...base,
    action: "hold",
    recommendedBidModifier: input.currentBidModifier,
    reason: `HOLD (scale blocked): ${scaleBlocks.join("; ")}`,
    triggers: scaleBlocks.map(() => "scale_blocked"),
  };
}

// ============================================================
// Tier expansion logic
// ============================================================

/**
 * Check whether tier2 and tier4 expansion are allowed under conservative mode.
 */
export function checkTierExpansion(
  intents: PlanIntent[],
  tier1AvgCPL: number,
  targetCPL: number,
  tier1AvgProfit: number,
  tier2AvgProfit: number,
  modeConfig?: ModeConfig,
  capConfig?: CapacityConfig,
): TierExpansionCheck {
  const mode = modeConfig || loadModeConfig();
  const cap = capConfig || loadCapacityConfig();

  const coveredZips = new Set<string>();
  // Count intents covering tier1
  for (const intent of intents) {
    if (intent.geoTier === "tier1_core" && intent.zip) {
      coveredZips.add(intent.zip);
    }
  }
  const allTier1 = Object.keys(getZipsInTier("tier1_core"));
  const saturation = allTier1.length > 0 ? coveredZips.size / allTier1.length : 0;

  const tier1CPLBelowTarget = tier1AvgCPL < targetCPL;
  const capacityAvailable = isCapacityAvailable(cap);
  const tier1PlusTier2Profitable = (tier1AvgProfit + tier2AvgProfit) > 0;
  const avgProfit = (tier1AvgProfit + tier2AvgProfit) / 2;
  const profitMarginAboveThreshold = tier1AvgProfit > 0 && tier1AvgProfit >= avgProfit * 1.25;

  // Tier2 expansion: all conditions must pass
  const tier2Allowed = saturation >= mode.tier1ExpansionThreshold
    && tier1CPLBelowTarget
    && capacityAvailable;

  // Tier4 (Boulder): stricter conditions
  const tier4Allowed = tier2Allowed
    && tier1PlusTier2Profitable
    && profitMarginAboveThreshold;

  let blockedReason: string | undefined;
  if (!tier2Allowed) {
    const reasons: string[] = [];
    if (saturation < mode.tier1ExpansionThreshold) {
      reasons.push(`tier1 saturation ${(saturation * 100).toFixed(0)}% < ${(mode.tier1ExpansionThreshold * 100).toFixed(0)}% threshold`);
    }
    if (!tier1CPLBelowTarget) reasons.push(`tier1 CPL $${tier1AvgCPL.toFixed(2)} >= target $${targetCPL}`);
    if (!capacityAvailable) reasons.push(`capacity unavailable (backlog ${cap.currentBacklogHours}h)`);
    blockedReason = reasons.join("; ");
  } else if (!tier4Allowed) {
    const reasons: string[] = [];
    if (!tier1PlusTier2Profitable) reasons.push("tier1+tier2 not profitable");
    if (!profitMarginAboveThreshold) reasons.push("profit margin below 1.25x average");
    blockedReason = `tier4 blocked: ${reasons.join("; ")}`;
  }

  return {
    tier2Allowed,
    tier4Allowed,
    blockedReason,
    tier1Saturation: Math.round(saturation * 100) / 100,
    tier1CPLBelowTarget,
    capacityAvailable,
    tier1PlusTier2Profitable,
    profitMarginAboveThreshold,
  };
}

// ============================================================
// Batch evaluation
// ============================================================

/**
 * Run conservative guard on all zip inputs.
 */
export function runConservativeGuard(
  inputs: ConservativeGuardInput[],
  modeConfig?: ModeConfig,
  capConfig?: CapacityConfig,
): ConservativeGuardOutput {
  const mode = modeConfig || loadModeConfig();
  const cap = capConfig || loadCapacityConfig();
  const convConfig = loadConversionConfig();
  const targetCPL = convConfig.targetCPL || 75;

  const results: ConservativeGuardResult[] = [];
  const blockedScaleEvents: ConservativeGuardResult[] = [];
  const pullbackTriggers: ConservativeGuardResult[] = [];
  const travelInefficiencies: ConservativeGuardResult[] = [];

  let scaleAllowed = 0, scaleBlocked = 0, pullbacks = 0;
  let suppressions = 0, holds = 0, capacityBlocks = 0;

  for (const input of inputs) {
    const result = evaluateConservative(input, targetCPL, mode, cap);
    results.push(result);

    switch (result.action) {
      case "scale":
        scaleAllowed++;
        break;
      case "hold":
        holds++;
        if (result.reason.includes("scale blocked")) {
          scaleBlocked++;
          blockedScaleEvents.push(result);
        }
        break;
      case "pullback":
        pullbacks++;
        pullbackTriggers.push(result);
        break;
      case "suppress":
        suppressions++;
        pullbackTriggers.push(result);
        break;
      case "block_capacity":
        capacityBlocks++;
        blockedScaleEvents.push(result);
        break;
    }

    if (input.travelDistanceMiles > mode.travelDistanceLimitMiles) {
      travelInefficiencies.push(result);
    }
  }

  return {
    timestamp: nowISO(),
    mode: mode.mode,
    targetCPL,
    capacityStatus: {
      backlogHours: cap.currentBacklogHours,
      maxHours: cap.maxBacklogHours,
      available: isCapacityAvailable(cap),
    },
    results,
    blockedScaleEvents,
    pullbackTriggers,
    travelInefficiencies,
    summary: {
      totalEvaluated: inputs.length,
      scaleAllowed,
      scaleBlocked,
      pullbacks,
      suppressions,
      holds,
      capacityBlocks,
    },
  };
}
