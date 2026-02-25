/**
 * MBS Master Orchestrator — Lead Flow Governor v1.1
 * "Soft Caps + Quality Discount + Ladder Throttling"
 *
 * Modes (based on effectiveLeads vs thresholds):
 *   NORMAL:   effectiveLeads <= hardCap
 *   WAITLIST: hardCap < effectiveLeads <= softCap
 *   THROTTLE: softCap < effectiveLeads <= overflow
 *   SUPPRESS: effectiveLeads > overflow
 *
 * Quality discount:
 *   effectiveLeads = leadsToday * (1 - junkLeadRateEstimate)
 *
 * Install cap ladder:
 *   Step 1: restrict install intents to tier1 only
 *   Step 2: reduce install bids 15%
 *   Step 3: pause install intents
 *
 * Low-ticket repair share:
 *   If > maxLowTicketRepairShare -> demote repair, promote upgrade + install
 */

import { resolve } from "path";
import type {
  FlowControlConfig, FlowState, FlowAction, FlowGovernorDecision,
  FlowGovernorResult, FlowMode, PlanIntent,
} from "../../types/index.js";
import { safeReadJSON, nowISO } from "../../utils/index.js";

const ROOT = process.cwd();

// ============================================================
// Config
// ============================================================

let _flowCache: FlowControlConfig | null = null;

export function loadFlowControlConfig(): FlowControlConfig {
  if (_flowCache) return _flowCache;
  _flowCache = safeReadJSON<FlowControlConfig>(
    resolve(ROOT, "config/flow_control.json"),
    {
      maxQualifiedLeadsPerDay: 12,
      hardCapQualifiedLeadsPerDay: 12,
      softCapMultiplier: 1.33,
      overflowMultiplier: 1.66,
      maxInstallLeadsPerWeek: 8,
      maxRepairLeadsPerDay: 10,
      minUpgradeRatio: 0.20,
      backlogBufferHours: 48,
      maxLowTicketRepairShare: 0.55,
      qualityDiscountEnabled: true,
    }
  );
  return _flowCache;
}

export function resetFlowCache(): void {
  _flowCache = null;
}

// ============================================================
// Intent classification helpers
// ============================================================

export function isInstallIntent(intent: PlanIntent): boolean {
  const text = [intent.id, intent.reason, ...intent.args].join(" ").toLowerCase();
  return ["install", "installation", "replacement", "new system", "heat pump install", "furnace install", "ac install"]
    .some((k) => text.includes(k));
}

export function isRepairIntent(intent: PlanIntent): boolean {
  const text = [intent.id, intent.reason, ...intent.args].join(" ").toLowerCase();
  return ["repair", "fix", "emergency", "broken", "not working", "service call"]
    .some((k) => text.includes(k));
}

export function isUpgradeIntent(intent: PlanIntent): boolean {
  const text = [intent.id, intent.reason, ...intent.args].join(" ").toLowerCase();
  return ["upgrade", "efficiency", "rebate", "energy saving", "smart thermostat", "duct seal"]
    .some((k) => text.includes(k));
}

export function isAdIntent(intent: PlanIntent): boolean {
  const text = [intent.id, ...intent.args].join(" ").toLowerCase();
  return ["google-ad", "meta", "ads", "-ads-"].some((k) => text.includes(k));
}

// ============================================================
// Effective leads + mode computation
// ============================================================

/**
 * Compute effective leads, applying quality discount when enabled.
 * effectiveLeads = rawLeads * (1 - junkLeadRateEstimate)
 */
export function computeEffectiveLeads(state: FlowState, config: FlowControlConfig): number {
  const raw = state.qualifiedLeadsToday;
  if (config.qualityDiscountEnabled && state.junkLeadRateEstimate != null && state.junkLeadRateEstimate > 0) {
    const clamped = Math.min(Math.max(state.junkLeadRateEstimate, 0), 1);
    return Math.round(raw * (1 - clamped) * 100) / 100;
  }
  return raw;
}

/**
 * Compute the three thresholds.
 */
export function computeFlowThresholds(config: FlowControlConfig): {
  hardCap: number;
  softCap: number;
  overflowCap: number;
} {
  const hardCap = config.hardCapQualifiedLeadsPerDay ?? config.maxQualifiedLeadsPerDay;
  const softMult = config.softCapMultiplier ?? 1.33;
  const overMult = config.overflowMultiplier ?? 1.66;
  return {
    hardCap,
    softCap: Math.round(hardCap * softMult * 100) / 100,
    overflowCap: Math.round(hardCap * overMult * 100) / 100,
  };
}

/**
 * Determine flow mode from effective leads.
 */
export function determineFlowMode(effectiveLeads: number, config: FlowControlConfig): FlowMode {
  const { hardCap, softCap, overflowCap } = computeFlowThresholds(config);
  if (effectiveLeads <= hardCap) return "NORMAL";
  if (effectiveLeads <= softCap) return "WAITLIST";
  if (effectiveLeads <= overflowCap) return "THROTTLE";
  return "SUPPRESS";
}

// ============================================================
// Install cap ladder
// ============================================================

export type InstallLadderStep = 0 | 1 | 2 | 3;

/**
 * Step 0: under cap
 * Step 1: 100-125% of cap -> restrict to tier1
 * Step 2: 125-150% of cap -> reduce bids 15%
 * Step 3: >150% of cap -> pause
 */
export function computeInstallLadderStep(installLeads: number, cap: number): InstallLadderStep {
  if (cap <= 0) return 0;
  const ratio = installLeads / cap;
  if (ratio <= 1.0) return 0;
  if (ratio <= 1.25) return 1;
  if (ratio <= 1.5) return 2;
  return 3;
}

// ============================================================
// Core evaluation (v1.1 with soft caps)
// ============================================================

export function evaluateFlowState(
  state: FlowState,
  config?: FlowControlConfig,
): FlowGovernorDecision[] {
  const cfg = config || loadFlowControlConfig();
  const decisions: FlowGovernorDecision[] = [];

  const effectiveLeads = computeEffectiveLeads(state, cfg);
  const flowMode = determineFlowMode(effectiveLeads, cfg);
  const thresholds = computeFlowThresholds(cfg);

  // ---- Soft cap mode-based decisions ----
  if (flowMode === "WAITLIST") {
    decisions.push({
      action: "suppress_tier2_tier3",
      reason: `WAITLIST: effective leads ${effectiveLeads} > hard cap ${thresholds.hardCap} — suppress tier2+tier3`,
      severity: "warning",
    });
    decisions.push({
      action: "tighten_match_types",
      reason: `WAITLIST: tighten ad match types to reduce low-quality impressions`,
      severity: "warning",
    });
    decisions.push({
      action: "reduce_repair_bids",
      reason: `WAITLIST: reduce repair priority one step`,
      severity: "warning",
    });
    decisions.push({
      action: "boost_upgrade_priority",
      reason: `WAITLIST: boost upgrade priority one step`,
      severity: "info",
    });
  } else if (flowMode === "THROTTLE") {
    decisions.push({
      action: "reduce_bids_10",
      reason: `THROTTLE: effective leads ${effectiveLeads} > soft cap ${thresholds.softCap} — reduce bids 10%`,
      severity: "critical",
    });
    decisions.push({
      action: "suppress_non_tier1",
      reason: `THROTTLE: suppress all non-tier1 intents`,
      severity: "critical",
    });
  } else if (flowMode === "SUPPRESS") {
    decisions.push({
      action: "block_bid_increase",
      reason: `SUPPRESS: effective leads ${effectiveLeads} > overflow ${thresholds.overflowCap} — block all bid increases`,
      severity: "critical",
    });
    decisions.push({
      action: "reduce_bids_15",
      reason: `SUPPRESS: reduce all bids 15%`,
      severity: "critical",
    });
    decisions.push({
      action: "suppress_non_tier1",
      reason: `SUPPRESS: suppress all non-tier1 intents`,
      severity: "critical",
    });
  }

  // ---- Install cap ladder ----
  const installStep = computeInstallLadderStep(state.installLeadsThisWeek, cfg.maxInstallLeadsPerWeek);
  if (installStep === 1) {
    decisions.push({
      action: "restrict_install_tier1",
      reason: `Install ladder step 1: ${state.installLeadsThisWeek}/${cfg.maxInstallLeadsPerWeek} — restrict install to tier1 only`,
      severity: "warning",
    });
  } else if (installStep === 2) {
    decisions.push({
      action: "restrict_install_tier1",
      reason: `Install ladder step 2: restrict to tier1`,
      severity: "warning",
    });
    decisions.push({
      action: "reduce_install_bids_15",
      reason: `Install ladder step 2: ${state.installLeadsThisWeek}/${cfg.maxInstallLeadsPerWeek} — reduce install bids 15%`,
      severity: "critical",
    });
  } else if (installStep === 3) {
    decisions.push({
      action: "pause_install_ads",
      reason: `Install ladder step 3: ${state.installLeadsThisWeek}/${cfg.maxInstallLeadsPerWeek} — pause all install ads`,
      severity: "critical",
    });
  }

  // ---- Repair leads per day (only in NORMAL, WAITLIST already handles) ----
  if (flowMode === "NORMAL" && state.repairLeadsToday > cfg.maxRepairLeadsPerDay) {
    decisions.push({
      action: "reduce_repair_bids",
      reason: `Repair leads today (${state.repairLeadsToday}) > daily cap (${cfg.maxRepairLeadsPerDay})`,
      severity: "warning",
    });
  }

  // ---- Low-ticket repair share rule ----
  const maxRepairShare = cfg.maxLowTicketRepairShare ?? 0.55;
  if (state.lowTicketRepairShareToday != null && state.lowTicketRepairShareToday > maxRepairShare) {
    decisions.push({
      action: "demote_low_ticket_repair",
      reason: `Low-ticket repair share ${(state.lowTicketRepairShareToday * 100).toFixed(0)}% > max ${(maxRepairShare * 100).toFixed(0)}% — demote repair`,
      severity: "warning",
    });
    decisions.push({
      action: "promote_upgrade_install",
      reason: `Rebalance: promote upgrade + install priority within geo limits`,
      severity: "info",
    });
  }

  // ---- Upgrade ratio (only in NORMAL, WAITLIST already boosts) ----
  if (flowMode === "NORMAL") {
    const upgradeRatio = state.totalLeadsThisWeek > 0
      ? state.upgradeLeadsThisWeek / state.totalLeadsThisWeek
      : 0;
    if (upgradeRatio < cfg.minUpgradeRatio && state.totalLeadsThisWeek > 0) {
      decisions.push({
        action: "boost_upgrade_priority",
        reason: `Upgrade ratio ${(upgradeRatio * 100).toFixed(1)}% < min ${(cfg.minUpgradeRatio * 100).toFixed(0)}% — boost upgrade campaigns`,
        severity: "info",
      });
    }
  }

  // ---- Backlog overload (always checked) ----
  if (state.backlogHours > cfg.backlogBufferHours) {
    decisions.push({
      action: "reduce_geo_radius",
      reason: `Backlog ${state.backlogHours}h > buffer ${cfg.backlogBufferHours}h — reduce service radius`,
      severity: "critical",
    });
    if (flowMode === "NORMAL") {
      decisions.push({
        action: "suppress_tier2_tier3",
        reason: `Backlog overloaded — suppress tier2 + tier3 expansion`,
        severity: "critical",
      });
    }
  }

  return decisions;
}

// ============================================================
// Apply to plan intents
// ============================================================

export function applyFlowGovernor(
  intents: PlanIntent[],
  state: FlowState,
  config?: FlowControlConfig,
): FlowGovernorResult {
  const cfg = config || loadFlowControlConfig();
  const decisions = evaluateFlowState(state, cfg);
  const effectiveLeads = computeEffectiveLeads(state, cfg);
  const flowMode = determineFlowMode(effectiveLeads, cfg);
  const thresholds = computeFlowThresholds(cfg);

  const actionSet = new Set(decisions.map((d) => d.action));
  const suppressed: string[] = [];
  const reprioritized: string[] = [];
  const boosted: string[] = [];

  for (const intent of intents) {
    // ---- Suppress non-tier1 (THROTTLE / SUPPRESS) ----
    if (actionSet.has("suppress_non_tier1")) {
      if (intent.geoTier && intent.geoTier !== "tier1_core" && intent.geoTier !== "unknown") {
        suppressed.push(intent.id);
        continue;
      }
    }

    // ---- Suppress tier2+tier3 (WAITLIST or backlog) ----
    if (actionSet.has("suppress_tier2_tier3") && !actionSet.has("suppress_non_tier1")) {
      if (intent.geoTier === "tier2_upgrade" || intent.geoTier === "tier3_selective") {
        suppressed.push(intent.id);
        continue;
      }
    }

    // ---- Install ladder ----
    if (isInstallIntent(intent) && isAdIntent(intent)) {
      if (actionSet.has("pause_install_ads")) {
        suppressed.push(intent.id);
        continue;
      }
      if (actionSet.has("restrict_install_tier1")) {
        if (intent.geoTier && intent.geoTier !== "tier1_core" && intent.geoTier !== "unknown") {
          suppressed.push(intent.id);
          continue;
        }
      }
      if (actionSet.has("reduce_install_bids_15") && intent.priority === "high") {
        intent.priority = "medium";
        reprioritized.push(intent.id);
      }
    }

    // ---- Repair bid reduction ----
    if (actionSet.has("reduce_repair_bids") && isRepairIntent(intent)) {
      if (intent.priority === "high") {
        intent.priority = "medium";
        reprioritized.push(intent.id);
      } else if (intent.priority === "medium") {
        intent.priority = "low";
        reprioritized.push(intent.id);
      }
    }

    // ---- Low-ticket repair share demote ----
    if (actionSet.has("demote_low_ticket_repair") && isRepairIntent(intent)) {
      if (intent.priority === "high") {
        intent.priority = "medium";
        if (!reprioritized.includes(intent.id)) reprioritized.push(intent.id);
      } else if (intent.priority === "medium") {
        intent.priority = "low";
        if (!reprioritized.includes(intent.id)) reprioritized.push(intent.id);
      }
    }

    // ---- Boost upgrade ----
    if ((actionSet.has("boost_upgrade_priority") || actionSet.has("promote_upgrade_install")) && isUpgradeIntent(intent)) {
      if (intent.priority === "low") {
        intent.priority = "medium";
        if (!boosted.includes(intent.id)) boosted.push(intent.id);
      } else if (intent.priority === "medium") {
        intent.priority = "high";
        if (!boosted.includes(intent.id)) boosted.push(intent.id);
      }
    }

    // ---- Promote install for repair share rebalance ----
    if (actionSet.has("promote_upgrade_install") && isInstallIntent(intent) && !actionSet.has("pause_install_ads")) {
      if (intent.priority === "low") {
        intent.priority = "medium";
        if (!boosted.includes(intent.id)) boosted.push(intent.id);
      } else if (intent.priority === "medium") {
        intent.priority = "high";
        if (!boosted.includes(intent.id)) boosted.push(intent.id);
      }
    }
  }

  const upgradeRatio = state.totalLeadsThisWeek > 0
    ? Math.round((state.upgradeLeadsThisWeek / state.totalLeadsThisWeek) * 100) / 100
    : 0;

  return {
    timestamp: nowISO(),
    state,
    config: cfg,
    decisions,
    intentModifications: { suppressed, reprioritized, boosted },
    summary: {
      leadsVsCap: {
        today: state.qualifiedLeadsToday,
        cap: cfg.maxQualifiedLeadsPerDay,
        pct: cfg.maxQualifiedLeadsPerDay > 0 ? Math.round((state.qualifiedLeadsToday / cfg.maxQualifiedLeadsPerDay) * 100) : 0,
      },
      installVsCap: {
        week: state.installLeadsThisWeek,
        cap: cfg.maxInstallLeadsPerWeek,
        pct: cfg.maxInstallLeadsPerWeek > 0 ? Math.round((state.installLeadsThisWeek / cfg.maxInstallLeadsPerWeek) * 100) : 0,
      },
      repairVsCap: {
        today: state.repairLeadsToday,
        cap: cfg.maxRepairLeadsPerDay,
        pct: cfg.maxRepairLeadsPerDay > 0 ? Math.round((state.repairLeadsToday / cfg.maxRepairLeadsPerDay) * 100) : 0,
      },
      upgradeRatio: {
        current: upgradeRatio,
        min: cfg.minUpgradeRatio,
        met: upgradeRatio >= cfg.minUpgradeRatio,
      },
      backlogStatus: {
        hours: state.backlogHours,
        buffer: cfg.backlogBufferHours,
        overloaded: state.backlogHours > cfg.backlogBufferHours,
      },
      totalSuppressed: suppressed.length,
      totalReprioritized: reprioritized.length,
      totalBoosted: boosted.length,
      flowMode,
      effectiveLeads,
      rawLeads: state.qualifiedLeadsToday,
      hardCap: thresholds.hardCap,
      softCap: thresholds.softCap,
      overflowCap: thresholds.overflowCap,
    },
  };
}
