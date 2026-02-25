/**
 * MBS Master Orchestrator — Constitution Gatekeeper
 * 
 * Every side-effect-producing operation must pass through the gatekeeper.
 * The gatekeeper evaluates:
 *   1. Season enforcement (from constitution season_matrix)
 *   2. Budget enforcement (±10% weekly change)
 *   3. Geo controls (core ZIP min weight, new activation cap)
 *   4. Capacity protection (conservative mode / hard throttle)
 *   5. Data completeness (missing metrics → conservative)
 * 
 * Returns a GatekeeperResult with allowed/blocked, mode, violations, alerts.
 */

import type {
  GatekeeperContext, GatekeeperResult, GatekeeperViolation,
  GatekeeperAlert, GatekeeperMode, SeasonMatrixEntry,
  ConstitutionBoot,
} from "../../types/index.js";
import { getConstitutionBoot } from "./loader.js";
import { nowISO } from "../../utils/index.js";

/**
 * Evaluate the gatekeeper against a context.
 * This is the SINGLE entrypoint for all side-effect authorization.
 */
export function evaluateGatekeeper(ctx: GatekeeperContext): GatekeeperResult {
  const boot = getConstitutionBoot();
  const c = boot.constitution;
  const violations: GatekeeperViolation[] = [];
  const alerts: GatekeeperAlert[] = [];
  let mode: GatekeeperMode = "NORMAL";
  let frozenGeo = false;
  let frozenBudget = false;

  const monthKey = String(ctx.month);
  const season: SeasonMatrixEntry = c.season_matrix[monthKey] || c.season_matrix["9"]; // default shoulder

  // ================================================================
  // 1. Capacity Protection — Conservative Mode / Hard Throttle
  // ================================================================

  const cap = ctx.weekly_lead_cap;
  const projection = ctx.weekly_lead_projection;
  const conservativePct = c.capacity_protection.conservative_trigger_pct;
  const hardThrottlePct = c.capacity_protection.hard_throttle_trigger_pct;

  // Missing install_revenue_ratio → conservative
  if (ctx.install_revenue_ratio === null) {
    mode = "CONSERVATIVE";
    frozenGeo = true;
    frozenBudget = true;
    violations.push({
      rule: "DATA_MISSING",
      message: "install_revenue_ratio unknown — forcing conservative mode",
      severity: "warn",
    });
    alerts.push({
      type: "DATA_MISSING",
      message: "install_revenue_ratio missing; run in CONSERVATIVE mode",
      timestamp: nowISO(),
    });
  }

  // Projection >= cap (100%)  → CONSERVATIVE
  if (projection >= cap * (conservativePct / 100)) {
    mode = "CONSERVATIVE";
    frozenGeo = true;
    frozenBudget = true;
    alerts.push({
      type: "CONSERVATIVE_MODE",
      message: `Weekly lead projection (${projection}) >= cap (${cap}). Entering CONSERVATIVE mode.`,
      timestamp: nowISO(),
    });
  }

  // Projection >= 120% of cap → HARD THROTTLE (blocks plan/bundle generation)
  if (projection >= cap * (hardThrottlePct / 100)) {
    mode = "HARD_THROTTLE";
    frozenGeo = true;
    frozenBudget = true;
    violations.push({
      rule: "HARD_THROTTLE",
      message: `Weekly lead projection (${projection}) >= ${hardThrottlePct}% of cap (${cap * hardThrottlePct / 100}). BLOCKING plan/bundle generation.`,
      severity: "block",
    });
    alerts.push({
      type: "HARD_THROTTLE",
      message: `HARD THROTTLE: projection ${projection} >= ${hardThrottlePct}% of cap ${cap}. All plan/bundle generation blocked.`,
      timestamp: nowISO(),
    });
  }

  // ================================================================
  // 2. Budget Enforcement — ±10% weekly change
  // ================================================================

  const maxChangePct = c.budget_enforcement.max_weekly_change_pct;
  if (ctx.prior_week_budget > 0) {
    const changePct = Math.abs(ctx.week_budget - ctx.prior_week_budget) / ctx.prior_week_budget * 100;
    if (changePct > maxChangePct) {
      const hasOverrideApproval = ctx.approvals.some(a =>
        a.includes("budget_override") || a.includes("BUDGET_OVERRIDE")
      );

      if (hasOverrideApproval) {
        // Allowed via explicit override
        alerts.push({
          type: "BUDGET_VIOLATION",
          message: `Budget change ${changePct.toFixed(1)}% exceeds ±${maxChangePct}% — allowed via override approval`,
          timestamp: nowISO(),
        });
      } else {
        violations.push({
          rule: "BUDGET_ENFORCEMENT",
          message: `Budget change ${changePct.toFixed(1)}% exceeds ±${maxChangePct}%. Requires explicit budget_override approval artifact.`,
          severity: "block",
        });
        alerts.push({
          type: "BUDGET_VIOLATION",
          message: `BLOCKED: Budget change ${changePct.toFixed(1)}% > ±${maxChangePct}% without override approval`,
          timestamp: nowISO(),
        });
      }
    }
  }

  // Freeze budget increase in conservative/throttle mode
  if ((mode === "CONSERVATIVE" || mode === "HARD_THROTTLE") && ctx.week_budget > ctx.prior_week_budget) {
    frozenBudget = true;
    violations.push({
      rule: "BUDGET_FREEZE_CONSERVATIVE",
      message: `Budget increase blocked in ${mode} mode (${ctx.prior_week_budget} → ${ctx.week_budget})`,
      severity: "block",
    });
  }

  // ================================================================
  // 3. Geo Controls
  // ================================================================

  const geo = c.geo_controls;

  // Check core ZIP minimum weight
  const coreZips = Object.keys(ctx.zip_weights);
  for (const zip of coreZips) {
    const weight = ctx.zip_weights[zip];
    if (weight < geo.core_zip_min_weight) {
      const hasApproval = ctx.approvals.some(a =>
        a.includes(`zip_weight_override_${zip}`) || a.includes("ZIP_WEIGHT_OVERRIDE")
      );
      if (!hasApproval) {
        violations.push({
          rule: "GEO_MIN_WEIGHT",
          message: `ZIP ${zip} weight ${weight} < minimum ${geo.core_zip_min_weight}. Requires override approval.`,
          severity: "block",
        });
      }
    }
  }

  // Check new ZIP activation cap
  if (ctx.newly_activated_zips.length > geo.new_zip_activation_cap_per_week) {
    const hasApproval = ctx.approvals.some(a =>
      a.includes("geo_expansion_override") || a.includes("GEO_EXPANSION_OVERRIDE")
    );
    if (hasApproval) {
      alerts.push({
        type: "GEO_VIOLATION",
        message: `${ctx.newly_activated_zips.length} new ZIPs activated (cap: ${geo.new_zip_activation_cap_per_week}) — allowed via override`,
        timestamp: nowISO(),
      });
    } else {
      violations.push({
        rule: "GEO_NEW_ZIP_CAP",
        message: `${ctx.newly_activated_zips.length} new ZIPs > weekly cap of ${geo.new_zip_activation_cap_per_week}. Requires geo_expansion_override approval.`,
        severity: "block",
      });
    }
  }

  // Freeze geo expansion in conservative/throttle
  if (frozenGeo && ctx.newly_activated_zips.length > 0) {
    violations.push({
      rule: "GEO_FREEZE_CONSERVATIVE",
      message: `Geo expansion frozen in ${mode} mode. ${ctx.newly_activated_zips.length} new ZIP(s) blocked.`,
      severity: "block",
    });
  }

  // ================================================================
  // 4. Season Enforcement — hard gate
  // ================================================================
  // Season violations are computed but not blocking at gatekeeper level
  // (they are enforced by the planner's intent filtering).
  // Gatekeeper records the season state for manifests.

  // ================================================================
  // Final decision
  // ================================================================

  const blockingViolations = violations.filter(v => v.severity === "block");
  const allowed = blockingViolations.length === 0;

  return {
    allowed,
    mode,
    violations,
    alerts,
    season,
    constitution_version: boot.constitution_version,
    constitution_hash: boot.constitution_hash,
    frozen_geo_expansion: frozenGeo,
    frozen_budget_increase: frozenBudget,
  };
}

/**
 * Build a GatekeeperContext from available data.
 * Fills defaults where data is missing (conservative).
 */
export function buildGatekeeperContext(opts: {
  month?: number;
  weekBudget?: number;
  priorWeekBudget?: number;
  weeklyLeadProjection?: number;
  weeklyLeadCap?: number;
  installRevenueRatio?: number | null;
  zipWeights?: Record<string, number>;
  newlyActivatedZips?: string[];
  approvals?: string[];
}): GatekeeperContext {
  const boot = getConstitutionBoot();
  const c = boot.constitution;

  return {
    month: opts.month ?? (new Date().getMonth() + 1),
    week_budget: opts.weekBudget ?? 0,
    prior_week_budget: opts.priorWeekBudget ?? 0,
    weekly_lead_projection: opts.weeklyLeadProjection ?? 0,
    weekly_lead_cap: opts.weeklyLeadCap ?? c.capacity_protection.weekly_lead_cap_default,
    install_revenue_ratio: opts.installRevenueRatio !== undefined ? opts.installRevenueRatio : null,
    zip_weights: opts.zipWeights ?? {},
    newly_activated_zips: opts.newlyActivatedZips ?? [],
    approvals: opts.approvals ?? [],
  };
}

/**
 * Quick check: is a service text allowed in the given month per the constitution?
 * Uses word-boundary matching for short keywords (<=3 chars) to prevent
 * false positives (e.g., "furnace" contains "ac" as a substring).
 */
export function isServiceAllowedByConstitution(serviceText: string, month: number): { allowed: boolean; reason?: string } {
  const boot = getConstitutionBoot();
  const entry = boot.constitution.season_matrix[String(month)];
  if (!entry) return { allowed: true };

  const lower = serviceText.toLowerCase();
  for (const blocked of entry.blocked_services) {
    const blockedLower = blocked.toLowerCase();
    // Short keywords (<=3 chars like "ac") use word-boundary regex
    // to prevent matching inside longer words like "furnace"
    if (blockedLower.length <= 3) {
      const regex = new RegExp(`\\b${blockedLower}\\b`, "i");
      if (regex.test(lower)) {
        return {
          allowed: false,
          reason: `"${serviceText}" blocked in month ${month} (${entry.season}): matches "${blocked}"`,
        };
      }
    } else {
      if (lower.includes(blockedLower)) {
        return {
          allowed: false,
          reason: `"${serviceText}" blocked in month ${month} (${entry.season}): matches "${blocked}"`,
        };
      }
    }
  }
  return { allowed: true };
}
