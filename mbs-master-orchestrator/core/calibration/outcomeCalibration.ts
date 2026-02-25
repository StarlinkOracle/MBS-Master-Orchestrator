/**
 * MBS Master Orchestrator — Outcome Calibration
 * Imports real outcome data (outcomes.csv) and compares observed close rates +
 * avg ticket values against the modeled values in conversion.json.
 * Writes proposed updates to config/learned.json (approval-gated, never auto-applied).
 */

import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import type {
  OutcomeRow, CalibrationResult, ConversionConfig, ToolEnvelope,
} from "../../types/index.js";
import { nowISO, writeJSON, safeReadJSON } from "../../utils/index.js";
import { loadConversionConfig } from "../metrics/conversions.js";

const ROOT = process.cwd();

// ============================================================
// CSV Parser
// ============================================================

/**
 * Parse outcomes.csv with columns: lead_type, qualified, sold, revenue
 */
export function parseOutcomesCSV(csvPath: string): ToolEnvelope<OutcomeRow[]> {
  if (!existsSync(csvPath)) {
    return { status: "FAILED", error: { code: "OUTCOMES_CSV_NOT_FOUND", message: `File not found: ${csvPath}` } };
  }

  const raw = readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { status: "FAILED", error: { code: "OUTCOMES_CSV_EMPTY", message: "Outcomes CSV has no data rows" } };
  }

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const typeCol = headers.indexOf("lead_type");
  const qualCol = headers.indexOf("qualified");
  const soldCol = headers.indexOf("sold");
  const revCol = headers.indexOf("revenue");

  if (typeCol < 0 || qualCol < 0 || soldCol < 0 || revCol < 0) {
    return { status: "FAILED", error: { code: "OUTCOMES_CSV_INVALID", message: "Missing required columns: lead_type, qualified, sold, revenue" } };
  }

  const rows: OutcomeRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",").map((v) => v.trim());
    const leadType = vals[typeCol]?.toLowerCase();
    if (leadType !== "call" && leadType !== "form") continue;

    rows.push({
      leadType: leadType as "call" | "form",
      qualified: vals[qualCol] === "1" || vals[qualCol]?.toLowerCase() === "true",
      sold: vals[soldCol] === "1" || vals[soldCol]?.toLowerCase() === "true",
      revenue: parseFloat(vals[revCol]) || 0,
    });
  }

  return { status: "EXECUTED", data: rows };
}

// ============================================================
// Calibration math
// ============================================================

/**
 * Compute observed close rates and avg ticket from outcome rows.
 */
export function computeObservedMetrics(rows: OutcomeRow[]): {
  callCloseRate: number;
  formCloseRate: number;
  avgTicketCall: number;
  avgTicketForm: number;
  callCount: number;
  formCount: number;
} {
  const calls = rows.filter((r) => r.leadType === "call");
  const forms = rows.filter((r) => r.leadType === "form");

  const callSold = calls.filter((r) => r.sold);
  const formSold = forms.filter((r) => r.sold);

  const callCloseRate = calls.length > 0 ? Math.round((callSold.length / calls.length) * 10000) / 10000 : 0;
  const formCloseRate = forms.length > 0 ? Math.round((formSold.length / forms.length) * 10000) / 10000 : 0;

  const avgTicketCall = callSold.length > 0
    ? Math.round(callSold.reduce((s, r) => s + r.revenue, 0) / callSold.length * 100) / 100
    : 0;
  const avgTicketForm = formSold.length > 0
    ? Math.round(formSold.reduce((s, r) => s + r.revenue, 0) / formSold.length * 100) / 100
    : 0;

  return {
    callCloseRate,
    formCloseRate,
    avgTicketCall,
    avgTicketForm,
    callCount: calls.length,
    formCount: forms.length,
  };
}

/**
 * Determine confidence level based on sample size.
 */
export function assessConfidence(callCount: number, formCount: number): "low" | "medium" | "high" {
  const total = callCount + formCount;
  if (total >= 100) return "high";
  if (total >= 30) return "medium";
  return "low";
}

/**
 * Run full calibration: compare modeled vs observed and produce deltas.
 */
export function runCalibration(rows: OutcomeRow[], convConfig?: ConversionConfig): CalibrationResult {
  const config = convConfig || loadConversionConfig();
  const observed = computeObservedMetrics(rows);
  const confidence = assessConfidence(observed.callCount, observed.formCount);

  const modeledCallClose = config.callCloseRate || 0;
  const modeledFormClose = config.formCloseRate || 0;
  const modeledTicketCall = config.avgTicketCall || 0;
  const modeledTicketForm = config.avgTicketForm || 0;

  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const result: CalibrationResult = {
    callCloseRate: {
      modeled: modeledCallClose,
      observed: observed.callCloseRate,
      delta: round4(observed.callCloseRate - modeledCallClose),
    },
    formCloseRate: {
      modeled: modeledFormClose,
      observed: observed.formCloseRate,
      delta: round4(observed.formCloseRate - modeledFormClose),
    },
    avgTicketCall: {
      modeled: modeledTicketCall,
      observed: observed.avgTicketCall,
      delta: round2(observed.avgTicketCall - modeledTicketCall),
    },
    avgTicketForm: {
      modeled: modeledTicketForm,
      observed: observed.avgTicketForm,
      delta: round2(observed.avgTicketForm - modeledTicketForm),
    },
    sampleSize: {
      calls: observed.callCount,
      forms: observed.formCount,
    },
    proposedUpdates: {},
    confidence,
  };

  // Only propose updates if deltas are meaningful (> 5% relative or absolute thresholds)
  if (observed.callCount >= 10 && Math.abs(result.callCloseRate.delta) > 0.02) {
    result.proposedUpdates.callCloseRate = observed.callCloseRate;
  }
  if (observed.formCount >= 5 && Math.abs(result.formCloseRate.delta) > 0.02) {
    result.proposedUpdates.formCloseRate = observed.formCloseRate;
  }
  if (observed.callCount >= 10 && Math.abs(result.avgTicketCall.delta) > 25) {
    result.proposedUpdates.avgTicketCall = observed.avgTicketCall;
  }
  if (observed.formCount >= 5 && Math.abs(result.avgTicketForm.delta) > 50) {
    result.proposedUpdates.avgTicketForm = observed.avgTicketForm;
  }

  return result;
}

// ============================================================
// File output (approval-gated)
// ============================================================

/**
 * Write proposed calibration updates to config/learned.json.
 * These are PROPOSED only — not auto-applied to conversion.json.
 */
export function writeCalibrationProposal(calibration: CalibrationResult): string {
  const learnedPath = resolve(ROOT, "config/learned.json");
  const current = safeReadJSON<Record<string, unknown>>(learnedPath, {
    lastUpdated: "",
    preferredIntentOrder: [],
    skipReasons: {},
    adjustments: {},
  });

  // Write proposed updates under a calibration key
  (current as any).calibration = {
    proposedAt: nowISO(),
    confidence: calibration.confidence,
    sampleSize: calibration.sampleSize,
    proposedUpdates: calibration.proposedUpdates,
    deltas: {
      callCloseRate: calibration.callCloseRate,
      formCloseRate: calibration.formCloseRate,
      avgTicketCall: calibration.avgTicketCall,
      avgTicketForm: calibration.avgTicketForm,
    },
    status: "pending_approval",
  };
  (current as any).lastUpdated = nowISO();

  writeJSON(learnedPath, current);
  return learnedPath;
}

/**
 * Full calibration pipeline: parse CSV → compute → write proposal.
 */
export function runCalibrationPipeline(csvPath?: string): ToolEnvelope<CalibrationResult> {
  const path = csvPath || join(ROOT, "metrics/import/outcomes.csv");
  const parseResult = parseOutcomesCSV(path);
  if (parseResult.status !== "EXECUTED" || !parseResult.data) {
    return { status: parseResult.status, error: parseResult.error };
  }

  const calibration = runCalibration(parseResult.data);
  writeCalibrationProposal(calibration);

  return { status: "EXECUTED", data: calibration };
}
