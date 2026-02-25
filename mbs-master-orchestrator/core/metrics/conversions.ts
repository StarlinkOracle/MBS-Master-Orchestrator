import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import type {
  ConversionGoal, ConversionConfig, ConversionPageRow,
  GA4EventRow, MetricSnapshot, ToolEnvelope,
} from "../../types/index.js";
import { safeReadJSON } from "../../utils/index.js";

const ROOT = process.cwd();
const IMPORT_DIR = resolve(ROOT, "metrics/import");

// ============================================================
// Load conversion config
// ============================================================

export function loadConversionConfig(): ConversionConfig {
  return safeReadJSON<ConversionConfig>(
    resolve(ROOT, "config/conversion.json"),
    {
      primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
      weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
      tieBreakerWindowDays: 14,
    }
  );
}

// ============================================================
// GA4 Event CSV Parser
// ============================================================

/**
 * Parse GA4 export CSV.
 * Expected columns: Page path (or page/url), Event name, Event count
 * Maps event names to our ConversionGoal types:
 *   click_to_call / phone_click / CALL_CLICK → CALL_CLICK
 *   generate_lead / form_submit / FORM_SUBMIT → FORM_SUBMIT
 */
export function parseGA4Events(csvPath: string): ToolEnvelope<GA4EventRow[]> {
  if (!existsSync(csvPath)) {
    return { status: "FAILED", error: { code: "CONVERSION_CSV_NOT_FOUND", message: `File not found: ${csvPath}` } };
  }

  const raw = readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { status: "FAILED", error: { code: "CONVERSION_CSV_EMPTY", message: "GA4 CSV has no data rows" } };
  }

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));

  // Resolve column names flexibly
  const pageCol = headers.find((h) =>
    ["page_path", "page", "url", "landing_page", "page_location"].includes(h)
  ) || headers[0];
  const eventCol = headers.find((h) =>
    ["event_name", "event", "eventname", "event_action"].includes(h)
  ) || headers[1];
  const countCol = headers.find((h) =>
    ["event_count", "count", "events", "eventcount", "total_events"].includes(h)
  ) || headers[2];

  const results: GA4EventRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values: string[] = [];
    let current = "";
    let inQuote = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === "," && !inQuote) { values.push(current.trim()); current = ""; continue; }
      current += ch;
    }
    values.push(current.trim());

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ""; });

    const page = row[pageCol] || "";
    const rawEvent = (row[eventCol] || "").toLowerCase();
    const count = parseInt(row[countCol] || "0", 10) || 0;

    if (!page || count === 0) continue;

    // Map GA4 event names to our conversion goals
    const eventName = mapEventName(rawEvent);
    if (eventName) {
      results.push({ page, eventName, eventCount: count });
    }
  }

  return { status: "EXECUTED", data: results };
}

function mapEventName(raw: string): string {
  const callPatterns = ["click_to_call", "phone_click", "call_click", "call", "tel_click"];
  const formPatterns = ["generate_lead", "form_submit", "form_submission", "form_complete", "submit_form", "estimate_request"];

  if (callPatterns.some((p) => raw.includes(p))) return "CALL_CLICK";
  if (formPatterns.some((p) => raw.includes(p))) return "FORM_SUBMIT";
  return "";
}

// ============================================================
// Manual KPI Override
// ============================================================

export interface ManualKPIs {
  calls?: number;
  forms?: number;
  pages?: { url: string; calls: number; forms: number }[];
}

export function loadManualKPIs(): ManualKPIs | null {
  const path = join(IMPORT_DIR, "manual-kpis.json");
  return safeReadJSON<ManualKPIs>(path, null as any);
}

// ============================================================
// Aggregate GA4 events into conversion page rows
// ============================================================

export function aggregateConversions(
  events: GA4EventRow[],
  config: ConversionConfig
): { totals: { CALL_CLICK: number; FORM_SUBMIT: number; weightedTotal: number }; pages: ConversionPageRow[] } {
  const pageMap = new Map<string, { calls: number; forms: number }>();

  for (const ev of events) {
    const existing = pageMap.get(ev.page) || { calls: 0, forms: 0 };
    if (ev.eventName === "CALL_CLICK") existing.calls += ev.eventCount;
    else if (ev.eventName === "FORM_SUBMIT") existing.forms += ev.eventCount;
    pageMap.set(ev.page, existing);
  }

  const callWeight = config.weights.CALL_CLICK ?? 1.0;
  const formWeight = config.weights.FORM_SUBMIT ?? 0.7;

  let totalCalls = 0;
  let totalForms = 0;
  const pages: ConversionPageRow[] = [];

  for (const [url, { calls, forms }] of pageMap) {
    totalCalls += calls;
    totalForms += forms;
    pages.push({
      url,
      calls,
      forms,
      weightedValue: calls * callWeight + forms * formWeight,
    });
  }

  // Sort by weighted value descending
  pages.sort((a, b) => b.weightedValue - a.weightedValue);

  return {
    totals: {
      CALL_CLICK: totalCalls,
      FORM_SUBMIT: totalForms,
      weightedTotal: Math.round((totalCalls * callWeight + totalForms * formWeight) * 100) / 100,
    },
    pages: pages.slice(0, 20),
  };
}

// ============================================================
// Build conversion data from manual override
// ============================================================

export function aggregateManualConversions(
  manual: ManualKPIs,
  config: ConversionConfig
): { totals: { CALL_CLICK: number; FORM_SUBMIT: number; weightedTotal: number }; pages: ConversionPageRow[] } {
  const callWeight = config.weights.CALL_CLICK ?? 1.0;
  const formWeight = config.weights.FORM_SUBMIT ?? 0.7;
  const totalCalls = manual.calls || 0;
  const totalForms = manual.forms || 0;

  const pages: ConversionPageRow[] = (manual.pages || []).map((p) => ({
    url: p.url,
    calls: p.calls,
    forms: p.forms,
    weightedValue: p.calls * callWeight + p.forms * formWeight,
  }));

  pages.sort((a, b) => b.weightedValue - a.weightedValue);

  return {
    totals: {
      CALL_CLICK: totalCalls,
      FORM_SUBMIT: totalForms,
      weightedTotal: Math.round((totalCalls * callWeight + totalForms * formWeight) * 100) / 100,
    },
    pages,
  };
}

// ============================================================
// Conversion-aware scoring for planner
// ============================================================

/**
 * Score a candidate action by weighted conversion value.
 * expectedConversionValue = expectedCalls * weightCall + expectedForms * weightForm
 */
export function scoreConversion(
  expectedCalls: number,
  expectedForms: number,
  config: ConversionConfig
): number {
  const callWeight = config.weights.CALL_CLICK ?? 1.0;
  const formWeight = config.weights.FORM_SUBMIT ?? 0.7;
  return Math.round((expectedCalls * callWeight + expectedForms * formWeight) * 100) / 100;
}

// ============================================================
// Weighted Lead Value (revenue-weighted)
// ============================================================

/**
 * Compute the weighted lead value in dollars:
 *   (calls × callCloseRate × avgTicketCall) + (forms × formCloseRate × avgTicketForm)
 *
 * Falls back to simple conversion scoring if close rates not configured.
 */
export function computeWeightedLeadValue(
  calls: number,
  forms: number,
  config: ConversionConfig
): number {
  const ccr = config.callCloseRate ?? 0;
  const fcr = config.formCloseRate ?? 0;
  const atc = config.avgTicketCall ?? 0;
  const atf = config.avgTicketForm ?? 0;

  // If close rates are configured, use revenue-weighted formula
  if (ccr > 0 && atc > 0) {
    return Math.round(((calls * ccr * atc) + (forms * fcr * atf)) * 100) / 100;
  }

  // Fallback to simple weighted scoring
  return scoreConversion(calls, forms, config);
}

/**
 * Compute profit efficiency score:
 *   profitEfficiencyScore = weightedLeadValue - adSpend
 *
 * And ROI:
 *   roi = profitEfficiencyScore / adSpend  (avoid div-by-zero)
 *
 * Planner optimizes for MAX(profitEfficiencyScore / adSpend).
 */
export function computeProfitEfficiency(
  calls: number,
  forms: number,
  adSpend: number,
  config: ConversionConfig
): { weightedLeadValue: number; profitEfficiencyScore: number; roi: number } {
  const wlv = computeWeightedLeadValue(calls, forms, config);
  const profit = Math.round((wlv - adSpend) * 100) / 100;
  const roi = adSpend > 0 ? Math.round((profit / adSpend) * 100) / 100 : 0;
  return { weightedLeadValue: wlv, profitEfficiencyScore: profit, roi };
}

// ============================================================
// Tie-breaker: recent conversion trend comparison
// ============================================================

/**
 * Given two snapshots within tieBreakerWindowDays, determine which
 * conversion goal is trending better. Returns the goal whose delta
 * is larger, or null if tied/no data.
 */
export function tieBreakerGoal(
  current: MetricSnapshot | null,
  previous: MetricSnapshot | null,
  config: ConversionConfig
): ConversionGoal | null {
  if (!current?.conversions || !previous?.conversions) return null;

  // Check the window
  const currentDate = new Date(current.date);
  const previousDate = new Date(previous.date);
  const daysDiff = (currentDate.getTime() - previousDate.getTime()) / 86400000;
  if (daysDiff > config.tieBreakerWindowDays || daysDiff < 0) return null;

  const callDelta = (current.conversions.CALL_CLICK || 0) - (previous.conversions.CALL_CLICK || 0);
  const formDelta = (current.conversions.FORM_SUBMIT || 0) - (previous.conversions.FORM_SUBMIT || 0);

  const callWeight = config.weights.CALL_CLICK ?? 1.0;
  const formWeight = config.weights.FORM_SUBMIT ?? 0.7;

  const weightedCallDelta = callDelta * callWeight;
  const weightedFormDelta = formDelta * formWeight;

  if (weightedCallDelta > weightedFormDelta) return "CALL_CLICK";
  if (weightedFormDelta > weightedCallDelta) return "FORM_SUBMIT";
  return null;
}

// ============================================================
// Intent classification: repair → calls, install → forms
// ============================================================

const REPAIR_KEYWORDS = ["repair", "fix", "emergency", "broken", "not working", "stopped", "leak", "noise"];
const INSTALL_KEYWORDS = ["install", "installation", "new", "replacement", "upgrade", "estimate", "quote"];

export function classifyPageIntent(url: string): "call-first" | "form-first" | "mixed" {
  const lower = url.toLowerCase();
  const isRepair = REPAIR_KEYWORDS.some((k) => lower.includes(k));
  const isInstall = INSTALL_KEYWORDS.some((k) => lower.includes(k));

  if (isRepair && !isInstall) return "call-first";
  if (isInstall && !isRepair) return "form-first";
  return "mixed";
}

export function classifyQueryIntent(query: string): "call-first" | "form-first" | "mixed" {
  const lower = query.toLowerCase();
  const isRepair = REPAIR_KEYWORDS.some((k) => lower.includes(k));
  const isInstall = INSTALL_KEYWORDS.some((k) => lower.includes(k));

  if (isRepair && !isInstall) return "call-first";
  if (isInstall && !isRepair) return "form-first";
  return "mixed";
}
