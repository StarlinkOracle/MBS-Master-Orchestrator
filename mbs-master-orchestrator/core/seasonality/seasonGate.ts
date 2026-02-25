/**
 * MBS Master Orchestrator — Seasonality Gate
 * Blocks out-of-season ad intents to prevent budget waste.
 *
 * HEATING (Oct-Feb): furnace, boiler, heating heat pump only
 * COOLING (May-Aug): AC, cooling heat pump only
 * SHOULDER (Mar-Apr, Sep): upgrade promos + light maintenance only
 */

import type { SeasonMode, SeasonRule, SeasonGateResult, PlanIntent } from "../../types/index.js";

// ============================================================
// Season definitions
// ============================================================

const SEASON_RULES: SeasonRule[] = [
  {
    mode: "HEATING",
    months: [10, 11, 12, 1, 2],
    allowedServices: [
      "furnace", "boiler", "heating", "heat pump", "heater",
      "furnace repair", "furnace installation", "furnace tune-up",
      "boiler repair", "boiler installation",
      "hp-heating",
    ],
    blockedPatterns: [
      "ac repair", "ac installation", "ac tune-up",
      "air conditioning", "cooling", "hp-cooling",
      "air conditioner",
    ],
  },
  {
    mode: "COOLING",
    months: [5, 6, 7, 8],
    allowedServices: [
      "ac", "air conditioning", "air conditioner", "cooling",
      "ac repair", "ac installation", "ac tune-up",
      "hp-cooling", "heat pump",
    ],
    blockedPatterns: [
      "furnace repair", "furnace installation", "furnace tune-up",
      "boiler repair", "boiler installation",
      "heating", "heater", "hp-heating",
    ],
  },
  {
    mode: "SHOULDER",
    months: [3, 4, 9],
    allowedServices: [
      "upgrade", "replacement", "maintenance", "tune-up",
      "duct cleaning", "thermostat", "indoor air quality",
      "heat pump", "hvac maintenance",
    ],
    blockedPatterns: [
      // Shoulder blocks aggressive single-season campaigns
      "emergency furnace", "emergency ac",
      "furnace repair", "ac repair",
    ],
  },
];

// ============================================================
// Core functions
// ============================================================

/**
 * Determine current season mode based on month (1-12).
 */
export function getCurrentSeason(month?: number): SeasonMode {
  const m = month ?? (new Date().getMonth() + 1);
  const rule = SEASON_RULES.find((r) => r.months.includes(m));
  return rule?.mode ?? "SHOULDER";
}

/**
 * Get the full season rule for the current month.
 */
export function getSeasonRule(month?: number): SeasonRule {
  const m = month ?? (new Date().getMonth() + 1);
  return SEASON_RULES.find((r) => r.months.includes(m)) || SEASON_RULES[2]; // default SHOULDER
}

/**
 * Check if a service/intent string is allowed in the current season.
 * Returns a SeasonGateResult with allowed status and blocked reason if applicable.
 */
export function checkSeasonGate(serviceText: string, month?: number): SeasonGateResult {
  const m = month ?? (new Date().getMonth() + 1);
  const season = getCurrentSeason(m);
  const rule = getSeasonRule(m);
  const lower = serviceText.toLowerCase();

  // Check if the intent matches a blocked pattern
  const blockedMatch = rule.blockedPatterns.find((p) => lower.includes(p));
  if (blockedMatch) {
    return {
      currentSeason: season,
      month: m,
      allowed: false,
      blockedReason: `"${serviceText}" blocked in ${season} season (matches: "${blockedMatch}")`,
    };
  }

  return {
    currentSeason: season,
    month: m,
    allowed: true,
  };
}

/**
 * Filter plan intents through the season gate.
 * Returns { allowed, blocked } lists.
 */
export function filterIntentsBySeason(
  intents: PlanIntent[],
  month?: number
): { allowed: PlanIntent[]; blocked: { intent: PlanIntent; reason: string }[] } {
  const allowed: PlanIntent[] = [];
  const blocked: { intent: PlanIntent; reason: string }[] = [];

  for (const intent of intents) {
    // Build a string to check from the intent's args and reason
    const checkText = [
      ...intent.args,
      intent.reason,
      intent.id,
    ].join(" ");

    // Only gate ad-related intents (google-ad, meta, ads)
    const isAdIntent = intent.args.some((a) =>
      ["google-ad", "meta", "ads"].includes(a)
    ) || intent.command === "ads" || intent.id.includes("-ads") || intent.id.includes("-seasonal");

    if (!isAdIntent) {
      // Non-ad intents pass through ungated
      allowed.push(intent);
      continue;
    }

    const result = checkSeasonGate(checkText, month);
    if (result.allowed) {
      allowed.push(intent);
    } else {
      blocked.push({ intent, reason: result.blockedReason || "Season gate blocked" });
    }
  }

  return { allowed, blocked };
}
