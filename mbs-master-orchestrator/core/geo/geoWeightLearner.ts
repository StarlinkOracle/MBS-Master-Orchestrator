/**
 * MBS Master Orchestrator — Geo Weight Learner (Conservative Mode)
 * 
 * Performance-based ZIP weight adjustments:
 * - Increase weight if: leads >= min, CPL <= targetCPL * 0.90, profitEfficiency > 0
 * - Decrease weight if: CPL >= targetCPL * 1.15 OR profitEfficiency < 0
 * - No change otherwise (hold)
 * 
 * Outputs approval-gated proposals to config/learned.json.
 * Never auto-applies. Step size 0.05, bounds [0.80, 1.40].
 */

import { resolve } from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import type {
  GeoPriorityConfig, GeoLearningConfig, ConversionConfig,
  ZipPerformance, ZipWeightProposal, GeoLearnerOutput,
} from "../../types/index.js";
import { safeReadJSON, nowISO } from "../../utils/index.js";
import { loadGeoPriorityConfig } from "./geoPriorityEngine.js";

const ROOT = process.cwd();

// ============================================================
// Input data structures
// ============================================================

export interface ZipMetricsInput {
  zip: string;
  calls: number;
  forms: number;
  spend: number;
}

// ============================================================
// Core computation
// ============================================================

/**
 * Compute ZIP performance metrics from raw inputs.
 */
export function computeZipPerformance(
  input: ZipMetricsInput,
  convConfig: ConversionConfig,
  currentWeight: number,
): ZipPerformance {
  const leads = input.calls + input.forms;
  const cpl = leads > 0 ? input.spend / leads : 0;

  const callCloseRate = convConfig.callCloseRate ?? 0.42;
  const formCloseRate = convConfig.formCloseRate ?? 0.18;
  const avgTicketCall = convConfig.avgTicketCall ?? 485;
  const avgTicketForm = convConfig.avgTicketForm ?? 2800;

  const callValue = input.calls * callCloseRate * avgTicketCall;
  const formValue = input.forms * formCloseRate * avgTicketForm;
  const weightedLeadValue = Math.round((callValue + formValue) * 100) / 100;
  const profitEfficiency = Math.round((weightedLeadValue - input.spend) * 100) / 100;

  return {
    zip: input.zip,
    leads,
    calls: input.calls,
    forms: input.forms,
    spend: input.spend,
    cpl: Math.round(cpl * 100) / 100,
    weightedLeadValue,
    profitEfficiency,
    currentWeight,
  };
}

/**
 * Determine weight adjustment for a single ZIP.
 * Returns a proposal or null (hold with sufficient data but no change needed).
 */
export function evaluateZipWeight(
  perf: ZipPerformance,
  learning: GeoLearningConfig,
  targetCPL: number,
): ZipWeightProposal | null {
  const { stepUp, stepDown, maxWeight, minWeight, minLeadsPerZip } = learning;

  // Insufficient data — skip
  if (perf.leads < minLeadsPerZip) return null;

  const lowCPLThreshold = targetCPL * 0.90;
  const highCPLThreshold = targetCPL * 1.15;

  // Check increase conditions: ALL must be true
  if (perf.cpl <= lowCPLThreshold && perf.cpl > 0 && perf.profitEfficiency > 0) {
    const proposed = Math.min(
      Math.round((perf.currentWeight + stepUp) * 100) / 100,
      maxWeight
    );
    if (proposed > perf.currentWeight) {
      return {
        zip: perf.zip,
        currentWeight: perf.currentWeight,
        proposedWeight: proposed,
        delta: Math.round((proposed - perf.currentWeight) * 100) / 100,
        reason: `CPL $${perf.cpl} ≤ $${lowCPLThreshold.toFixed(0)} (90% target) + profit $${perf.profitEfficiency} > 0`,
        leads: perf.leads,
        cpl: perf.cpl,
        profitEfficiency: perf.profitEfficiency,
      };
    }
  }

  // Check decrease conditions: ANY triggers
  if (perf.cpl >= highCPLThreshold || perf.profitEfficiency < 0) {
    const proposed = Math.max(
      Math.round((perf.currentWeight - stepDown) * 100) / 100,
      minWeight
    );
    if (proposed < perf.currentWeight) {
      const reasons: string[] = [];
      if (perf.cpl >= highCPLThreshold) {
        reasons.push(`CPL $${perf.cpl} ≥ $${highCPLThreshold.toFixed(0)} (115% target)`);
      }
      if (perf.profitEfficiency < 0) {
        reasons.push(`Negative profit $${perf.profitEfficiency}`);
      }
      return {
        zip: perf.zip,
        currentWeight: perf.currentWeight,
        proposedWeight: proposed,
        delta: Math.round((proposed - perf.currentWeight) * 100) / 100,
        reason: reasons.join(" + "),
        leads: perf.leads,
        cpl: perf.cpl,
        profitEfficiency: perf.profitEfficiency,
      };
    }
  }

  // Hold — meets data threshold but no change needed
  return null;
}

/**
 * Run the full learning cycle across all ZIPs.
 */
export function runGeoWeightLearning(
  zipMetrics: ZipMetricsInput[],
  convConfig: ConversionConfig,
  geoConfig?: GeoPriorityConfig,
): GeoLearnerOutput {
  const geo = geoConfig || loadGeoPriorityConfig();
  const learning = geo.learning || {
    enabled: true,
    mode: "CONSERVATIVE" as const,
    minDataWindowDays: 14,
    minLeadsPerZip: 5,
    maxWeight: 1.4,
    minWeight: 0.8,
    stepUp: 0.05,
    stepDown: 0.05,
  };

  const allWeights = geo.zipWeights || {};
  const targetCPL = convConfig.targetCPL || 75;

  const performances: ZipPerformance[] = [];
  const proposals: ZipWeightProposal[] = [];
  const insufficientData: string[] = [];

  // Evaluate each configured ZIP
  const configuredZips = new Set(Object.keys(allWeights));
  const metricsMap = new Map(zipMetrics.map((m) => [m.zip, m]));

  for (const zip of configuredZips) {
    const metrics = metricsMap.get(zip) || { zip, calls: 0, forms: 0, spend: 0 };
    const currentWeight = allWeights[zip] ?? 1.0;
    const perf = computeZipPerformance(metrics, convConfig, currentWeight);
    performances.push(perf);

    if (perf.leads < learning.minLeadsPerZip) {
      insufficientData.push(zip);
      continue;
    }

    const proposal = evaluateZipWeight(perf, learning, targetCPL);
    if (proposal) {
      proposals.push(proposal);
    }
  }

  // Sort top performers by profit efficiency descending
  const topPerformers = [...performances]
    .filter((p) => p.leads >= learning.minLeadsPerZip)
    .sort((a, b) => b.profitEfficiency - a.profitEfficiency)
    .slice(0, 10);

  const increases = proposals.filter((p) => p.delta > 0).length;
  const decreases = proposals.filter((p) => p.delta < 0).length;
  const holds = configuredZips.size - insufficientData.length - proposals.length;

  return {
    timestamp: nowISO(),
    mode: learning.mode,
    zipsEvaluated: configuredZips.size,
    proposals,
    insufficientData,
    topPerformers,
    summary: {
      increases,
      decreases,
      holds,
      insufficientData: insufficientData.length,
    },
  };
}

/**
 * Write learner outputs to bundle directory and config/learned.json.
 * Proposals are approval-gated (status: "pending_approval").
 */
export function writeLearnerOutputs(
  output: GeoLearnerOutput,
  bundleDir: string,
): void {
  // Ensure geo subdirectory exists
  const geoDir = resolve(bundleDir, "geo");
  if (!existsSync(geoDir)) mkdirSync(geoDir, { recursive: true });

  // Write JSON
  writeFileSync(
    resolve(geoDir, "zip_weight_updates.json"),
    JSON.stringify(output, null, 2),
    "utf-8"
  );

  // Write markdown summary
  const lines: string[] = [
    "# ZIP Weight Learning Results",
    "",
    `**Mode:** ${output.mode}`,
    `**Evaluated:** ${output.zipsEvaluated} ZIPs`,
    `**Proposals:** ${output.proposals.length} (${output.summary.increases} ⬆️ ${output.summary.decreases} ⬇️)`,
    `**Holds:** ${output.summary.holds}`,
    `**Insufficient Data:** ${output.summary.insufficientData}`,
    "",
  ];

  if (output.topPerformers.length > 0) {
    lines.push("## Top Performers (by Profit Efficiency)", "");
    lines.push("| ZIP | Leads | CPL | Profit | Weight |");
    lines.push("|-----|-------|-----|--------|--------|");
    for (const p of output.topPerformers) {
      lines.push(
        `| ${p.zip} | ${p.leads} | $${p.cpl} | $${p.profitEfficiency} | ${p.currentWeight} |`
      );
    }
    lines.push("");
  }

  if (output.proposals.length > 0) {
    lines.push("## Weight Change Proposals", "");
    lines.push("| ZIP | Current | Proposed | Delta | Reason |");
    lines.push("|-----|---------|----------|-------|--------|");
    for (const p of output.proposals) {
      const arrow = p.delta > 0 ? "⬆️" : "⬇️";
      lines.push(
        `| ${p.zip} | ${p.currentWeight} | ${p.proposedWeight} | ${arrow} ${p.delta > 0 ? "+" : ""}${p.delta} | ${p.reason} |`
      );
    }
    lines.push("");
  }

  if (output.insufficientData.length > 0) {
    lines.push(
      `## Insufficient Data (< ${5} leads)`,
      "",
      output.insufficientData.join(", "),
      "",
    );
  }

  writeFileSync(
    resolve(geoDir, "zip_weight_updates.md"),
    lines.join("\n"),
    "utf-8"
  );

  // Write to config/learned.json (approval-gated)
  const learnedPath = resolve(ROOT, "config/learned.json");
  const learned = safeReadJSON<Record<string, unknown>>(learnedPath, {});

  const proposedWeights: Record<string, number> = {};
  for (const p of output.proposals) {
    proposedWeights[p.zip] = p.proposedWeight;
  }

  (learned as Record<string, unknown>).geo = {
    zipWeightsProposed: proposedWeights,
    status: "pending_approval",
    generatedAt: output.timestamp,
    summary: output.summary,
  };

  writeFileSync(learnedPath, JSON.stringify(learned, null, 2), "utf-8");
}
