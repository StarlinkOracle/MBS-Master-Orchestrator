/**
 * MBS Master Orchestrator — Lead Quality Scoring
 * Scores calls (proxy signals) and forms (field-based scoring).
 * Uses QualifiedLeadValue in profit model instead of raw counts.
 */

import { resolve } from "path";
import type { LeadQualityConfig, LeadQualityScore, ConversionConfig } from "../../types/index.js";
import { safeReadJSON } from "../../utils/index.js";

const ROOT = process.cwd();

// ============================================================
// Load config
// ============================================================

export function loadLeadQualityConfig(): LeadQualityConfig {
  return safeReadJSON<LeadQualityConfig>(
    resolve(ROOT, "config/lead_quality.json"),
    {
      call: {
        durationThresholdSec: 60,
        peakHoursBonus: 0.15,
        repeatCallerPenalty: 0.10,
        weights: { duration: 0.40, peakHour: 0.25, serviceMatch: 0.35 },
      },
      form: {
        requiredFields: ["name", "phone", "service"],
        bonusFields: ["address", "zipCode", "preferredDate", "urgency"],
        weights: { fieldCompleteness: 0.35, serviceSpecificity: 0.35, urgencySignal: 0.30 },
        urgencyKeywords: ["emergency", "urgent", "asap", "today", "broken", "not working"],
      },
      qualityThreshold: 0.60,
    }
  );
}

// ============================================================
// Call quality scoring (proxy signals)
// ============================================================

export interface CallSignals {
  durationSec: number;
  isPeakHour: boolean;
  serviceMatch: boolean;
  isRepeatCaller: boolean;
}

/**
 * Score a phone call lead using proxy signals.
 * - Duration: 0-1 scaled by threshold (calls ≥ threshold get full score)
 * - Peak hours (M-F 8am-6pm): bonus multiplier
 * - Service match (caller asked about a service we offer): high signal
 * - Repeat caller: slight penalty (likely existing customer / tire-kicker)
 */
export function scoreCall(signals: CallSignals, config?: LeadQualityConfig): LeadQualityScore {
  const cfg = config || loadLeadQualityConfig();
  const w = cfg.call.weights;

  // Duration score: 0-1 based on threshold
  const durationScore = Math.min(signals.durationSec / cfg.call.durationThresholdSec, 1.0);

  // Peak hour score: 1.0 + bonus if peak, 0.7 if off-peak
  const peakScore = signals.isPeakHour ? 1.0 : 0.7;

  // Service match score: 1.0 if matched, 0.3 if not
  const serviceScore = signals.serviceMatch ? 1.0 : 0.3;

  // Weighted raw score
  let rawScore = (durationScore * w.duration) + (peakScore * w.peakHour) + (serviceScore * w.serviceMatch);

  // Apply peak hour bonus
  if (signals.isPeakHour) rawScore = Math.min(rawScore + cfg.call.peakHoursBonus, 1.0);

  // Apply repeat caller penalty
  if (signals.isRepeatCaller) rawScore = Math.max(rawScore - cfg.call.repeatCallerPenalty, 0);

  rawScore = Math.round(rawScore * 100) / 100;
  const qualified = rawScore >= cfg.qualityThreshold;

  // Quality multiplier: qualified leads get full value, marginal get partial
  const qualityMultiplier = qualified ? 1.0 : rawScore / cfg.qualityThreshold;

  const signalsList: string[] = [];
  if (signals.durationSec >= cfg.call.durationThresholdSec) signalsList.push("long_call");
  else signalsList.push("short_call");
  if (signals.isPeakHour) signalsList.push("peak_hour");
  if (signals.serviceMatch) signalsList.push("service_match");
  if (signals.isRepeatCaller) signalsList.push("repeat_caller");

  return {
    leadType: "call",
    rawScore,
    qualityMultiplier: Math.round(qualityMultiplier * 100) / 100,
    qualified,
    signals: signalsList,
  };
}

// ============================================================
// Form quality scoring (field-based)
// ============================================================

export interface FormSignals {
  filledFields: string[];
  serviceText: string;
  messageText: string;
}

/**
 * Score a form submission based on field completeness, service specificity,
 * and urgency signals in the message.
 */
export function scoreForm(signals: FormSignals, config?: LeadQualityConfig): LeadQualityScore {
  const cfg = config || loadLeadQualityConfig();
  const w = cfg.form.weights;

  // Field completeness: required fields filled / total required + bonus fields
  const requiredFilled = cfg.form.requiredFields.filter((f) => signals.filledFields.includes(f)).length;
  const requiredTotal = cfg.form.requiredFields.length;
  const bonusFilled = cfg.form.bonusFields.filter((f) => signals.filledFields.includes(f)).length;
  const bonusTotal = cfg.form.bonusFields.length;

  const fieldScore = requiredTotal > 0
    ? (requiredFilled / requiredTotal) * 0.7 + (bonusTotal > 0 ? (bonusFilled / bonusTotal) * 0.3 : 0.3)
    : 0;

  // Service specificity: does the service text mention a specific service?
  const serviceKeywords = ["furnace", "ac", "air condition", "heat pump", "boiler", "duct", "thermostat", "hvac"];
  const serviceLower = signals.serviceText.toLowerCase();
  const hasSpecificService = serviceKeywords.some((k) => serviceLower.includes(k));
  const serviceScore = hasSpecificService ? 1.0 : 0.4;

  // Urgency signals in message
  const msgLower = (signals.messageText || "").toLowerCase();
  const urgencyMatches = cfg.form.urgencyKeywords.filter((k) => msgLower.includes(k)).length;
  const urgencyScore = Math.min(urgencyMatches / 2, 1.0); // 2+ keywords = max urgency

  const rawScore = Math.round(
    ((fieldScore * w.fieldCompleteness) + (serviceScore * w.serviceSpecificity) + (urgencyScore * w.urgencySignal)) * 100
  ) / 100;

  const qualified = rawScore >= cfg.qualityThreshold;
  const qualityMultiplier = qualified ? 1.0 : Math.round((rawScore / cfg.qualityThreshold) * 100) / 100;

  const signalsList: string[] = [];
  if (requiredFilled === requiredTotal) signalsList.push("all_required");
  else signalsList.push(`missing_${requiredTotal - requiredFilled}_required`);
  if (bonusFilled > 0) signalsList.push(`${bonusFilled}_bonus_fields`);
  if (hasSpecificService) signalsList.push("specific_service");
  if (urgencyMatches > 0) signalsList.push(`urgency_${urgencyMatches}_keywords`);

  return {
    leadType: "form",
    rawScore,
    qualityMultiplier,
    qualified,
    signals: signalsList,
  };
}

// ============================================================
// Quality-adjusted lead value
// ============================================================

/**
 * Compute QualifiedLeadValue using quality multipliers instead of raw counts.
 *
 * qualifiedCallValue = calls × avgCallQualityMultiplier × callCloseRate × avgTicketCall
 * qualifiedFormValue = forms × avgFormQualityMultiplier × formCloseRate × avgTicketForm
 *
 * If quality multipliers not provided, uses 1.0 (backwards compatible).
 */
export function computeQualifiedLeadValue(
  calls: number,
  forms: number,
  callQualityMultiplier: number,
  formQualityMultiplier: number,
  convConfig: ConversionConfig
): number {
  const ccr = convConfig.callCloseRate ?? 0;
  const fcr = convConfig.formCloseRate ?? 0;
  const atc = convConfig.avgTicketCall ?? 0;
  const atf = convConfig.avgTicketForm ?? 0;

  if (ccr > 0 && atc > 0) {
    return Math.round(
      ((calls * callQualityMultiplier * ccr * atc) + (forms * formQualityMultiplier * fcr * atf)) * 100
    ) / 100;
  }

  // Fallback to simple weighted
  const cw = convConfig.weights.CALL_CLICK ?? 1.0;
  const fw = convConfig.weights.FORM_SUBMIT ?? 0.7;
  return Math.round(((calls * callQualityMultiplier * cw) + (forms * formQualityMultiplier * fw)) * 100) / 100;
}
