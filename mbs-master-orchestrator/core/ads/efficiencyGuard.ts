/**
 * MBS Master Orchestrator — Efficiency Guard
 * Monitors cost-per-weighted-lead and generates bid modifier recommendations.
 * Never auto-publishes — outputs recommendation files only.
 */

import { resolve, join } from "path";
import type {
  EfficiencyInput, EfficiencyRecommendation, EfficiencyGuardOutput,
  ConversionConfig, GeoPriorityConfig, GeoTierName,
} from "../../types/index.js";
import { writeJSON, writeText, ensureDir, nowISO, safeReadJSON } from "../../utils/index.js";
import { loadConversionConfig } from "../metrics/conversions.js";
import { loadGeoPriorityConfig, getTier } from "../geo/geoPriorityEngine.js";
import { loadModeConfig } from "../mode/conservativeGuard.js";

const ROOT = process.cwd();

// ============================================================
// Constants (mode-aware defaults)
// ============================================================

const DEFAULT_MAX_BID_INCREASE_PCT = 50;
const DEFAULT_BID_STEP_PCT = 10;
const DEFAULT_SUPPRESS_TRAVEL_MILES = 45;
const DEFAULT_IMPRESSION_SHARE_LOST_THRESHOLD = 10; // percent

function getEffectiveTravelLimit(): number {
  const mode = loadModeConfig();
  if (mode.mode === "CONSERVATIVE") return mode.travelDistanceLimitMiles;
  return DEFAULT_SUPPRESS_TRAVEL_MILES;
}

function getEffectiveScaleCPLMultiplier(): number {
  const mode = loadModeConfig();
  if (mode.mode === "CONSERVATIVE") return mode.scaleThresholdMultiplier;
  return 1.0; // balanced/aggressive: scale up to full target
}

// ============================================================
// Core bid adjustment logic
// ============================================================

/**
 * Evaluate a single zip's efficiency and produce a recommendation.
 *
 * Rules (mode-aware):
 * 1. If travelDistance > limit AND CPL above target → suppress zip
 * 2. If costPerWeightedLead > targetCPL → reduce bid by 10%
 * 3. If costPerWeightedLead < targetCPL * scaleMultiplier AND IS lost > 10% → increase bid (max 50%)
 * 4. Otherwise → hold
 *
 * CONSERVATIVE mode: travel limit 35mi (vs 45), scale requires CPL < target×0.8
 */
export function evaluateZipEfficiency(
  input: EfficiencyInput,
  targetCPL: number
): EfficiencyRecommendation {
  const tier = getTier(input.zip);
  const travelLimit = getEffectiveTravelLimit();
  const scaleMultiplier = getEffectiveScaleCPLMultiplier();
  const scaleCPL = targetCPL * scaleMultiplier;

  // Rule 1: Travel distance + CPL check (most restrictive — check first)
  if (input.travelDistanceMiles > travelLimit && input.costPerWeightedLead > targetCPL) {
    return {
      zip: input.zip,
      tier,
      action: "suppress",
      currentBidModifier: input.currentBidModifier,
      recommendedBidModifier: 0,
      reason: `Travel distance ${input.travelDistanceMiles}mi > ${travelLimit}mi AND CPL $${input.costPerWeightedLead.toFixed(2)} > target $${targetCPL}`,
      costPerWeightedLead: input.costPerWeightedLead,
      travelDistanceMiles: input.travelDistanceMiles,
    };
  }

  // Rule 2: CPL above target → reduce bid
  if (input.costPerWeightedLead > targetCPL) {
    const newMod = Math.max(input.currentBidModifier - DEFAULT_BID_STEP_PCT, -100);
    return {
      zip: input.zip,
      tier,
      action: "reduce_bid",
      currentBidModifier: input.currentBidModifier,
      recommendedBidModifier: newMod,
      reason: `CPL $${input.costPerWeightedLead.toFixed(2)} > target $${targetCPL} — reduce bid by ${DEFAULT_BID_STEP_PCT}%`,
      costPerWeightedLead: input.costPerWeightedLead,
      travelDistanceMiles: input.travelDistanceMiles,
    };
  }

  // Rule 3: CPL below scale threshold AND losing impression share → increase bid
  if (input.costPerWeightedLead < scaleCPL && input.impressionShareLostToBudget > DEFAULT_IMPRESSION_SHARE_LOST_THRESHOLD) {
    const newMod = Math.min(input.currentBidModifier + DEFAULT_BID_STEP_PCT, DEFAULT_MAX_BID_INCREASE_PCT);
    return {
      zip: input.zip,
      tier,
      action: "increase_bid",
      currentBidModifier: input.currentBidModifier,
      recommendedBidModifier: newMod,
      reason: `CPL $${input.costPerWeightedLead.toFixed(2)} < scale threshold $${scaleCPL.toFixed(2)} and ${input.impressionShareLostToBudget.toFixed(1)}% IS lost to budget — increase bid by ${DEFAULT_BID_STEP_PCT}% (capped ${DEFAULT_MAX_BID_INCREASE_PCT}%)`,
      costPerWeightedLead: input.costPerWeightedLead,
      travelDistanceMiles: input.travelDistanceMiles,
    };
  }

  // Rule 4: Hold
  return {
    zip: input.zip,
    tier,
    action: "hold",
    currentBidModifier: input.currentBidModifier,
    recommendedBidModifier: input.currentBidModifier,
    reason: `CPL $${input.costPerWeightedLead.toFixed(2)} within target, no impression share pressure — hold`,
    costPerWeightedLead: input.costPerWeightedLead,
    travelDistanceMiles: input.travelDistanceMiles,
  };
}

// ============================================================
// Batch evaluation
// ============================================================

/**
 * Evaluate all zip inputs and produce the full guard output.
 */
export function runEfficiencyGuard(inputs: EfficiencyInput[]): EfficiencyGuardOutput {
  const convConfig = loadConversionConfig();
  const targetCPL = convConfig.targetCPL || 75;

  const recommendations: EfficiencyRecommendation[] = [];
  const suppressedZips: { zip: string; reason: string }[] = [];
  let bidIncreases = 0;
  let bidDecreases = 0;
  let suppressions = 0;
  let holds = 0;

  for (const input of inputs) {
    const rec = evaluateZipEfficiency(input, targetCPL);
    recommendations.push(rec);

    switch (rec.action) {
      case "increase_bid": bidIncreases++; break;
      case "reduce_bid": bidDecreases++; break;
      case "suppress":
        suppressions++;
        suppressedZips.push({ zip: rec.zip, reason: rec.reason });
        break;
      case "hold": holds++; break;
    }
  }

  return {
    timestamp: nowISO(),
    targetCPL,
    recommendations,
    suppressedZips,
    summary: {
      totalZipsEvaluated: inputs.length,
      bidIncreases,
      bidDecreases,
      suppressions,
      holds,
    },
  };
}

// ============================================================
// File output (no auto-publish)
// ============================================================

/**
 * Write efficiency guard recommendations to ads/ directory.
 * Generates both JSON and human-readable summary.
 */
export function writeEfficiencyRecommendations(
  output: EfficiencyGuardOutput,
  targetDir?: string
): { jsonPath: string; mdPath: string } {
  const dir = targetDir || resolve(ROOT, "ads");
  ensureDir(dir);

  const jsonPath = join(dir, "geo_adjustments_recommendations.json");
  const mdPath = join(dir, "geo_adjustments_summary.md");

  writeJSON(jsonPath, output);

  // Human-readable summary
  const lines: string[] = [
    "# Geo Bid Adjustment Recommendations",
    "",
    `**Generated:** ${output.timestamp}`,
    `**Target CPL:** $${output.targetCPL}`,
    `**ZIPs Evaluated:** ${output.summary.totalZipsEvaluated}`,
    "",
    `| Action | Count |`,
    `|---|---|`,
    `| ⬆️ Bid Increases | ${output.summary.bidIncreases} |`,
    `| ⬇️ Bid Decreases | ${output.summary.bidDecreases} |`,
    `| ⛔ Suppressions | ${output.summary.suppressions} |`,
    `| ➡️ Holds | ${output.summary.holds} |`,
    "",
    "---",
    "",
  ];

  // Group by action
  const groups: Record<string, EfficiencyRecommendation[]> = {
    suppress: [],
    reduce_bid: [],
    increase_bid: [],
    hold: [],
  };
  for (const rec of output.recommendations) {
    groups[rec.action].push(rec);
  }

  if (groups.suppress.length > 0) {
    lines.push("## ⛔ Suppressed ZIPs", "");
    lines.push("| ZIP | Tier | Reason |");
    lines.push("|---|---|---|");
    for (const r of groups.suppress) {
      lines.push(`| ${r.zip} | ${r.tier} | ${r.reason} |`);
    }
    lines.push("");
  }

  if (groups.reduce_bid.length > 0) {
    lines.push("## ⬇️ Bid Reductions", "");
    lines.push("| ZIP | Tier | Current Mod | → Recommended | CPL | Reason |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of groups.reduce_bid) {
      lines.push(`| ${r.zip} | ${r.tier} | ${r.currentBidModifier}% | ${r.recommendedBidModifier}% | $${r.costPerWeightedLead.toFixed(2)} | ${r.reason} |`);
    }
    lines.push("");
  }

  if (groups.increase_bid.length > 0) {
    lines.push("## ⬆️ Bid Increases", "");
    lines.push("| ZIP | Tier | Current Mod | → Recommended | CPL | Reason |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of groups.increase_bid) {
      lines.push(`| ${r.zip} | ${r.tier} | ${r.currentBidModifier}% | ${r.recommendedBidModifier}% | $${r.costPerWeightedLead.toFixed(2)} | ${r.reason} |`);
    }
    lines.push("");
  }

  lines.push("---", "", "**⚠️ No automatic publish.** Review and apply manually in Google Ads / Meta Ads Manager.");

  writeText(mdPath, lines.join("\n"));

  return { jsonPath, mdPath };
}
