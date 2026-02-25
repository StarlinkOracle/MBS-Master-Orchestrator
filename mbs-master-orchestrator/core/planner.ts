import { resolve } from "path";
import type { KPITargets, WeeklyPlan, PlanIntent, ToolEnvelope, OperatorConfig, MetricSnapshot } from "../types/index.js";
import { readJSON, nowISO, currentWeekNumber, safeReadJSON } from "../utils/index.js";
import { loadLatestSnapshot } from "./metrics/index.js";
import {
  loadConversionConfig, scoreConversion, classifyPageIntent, classifyQueryIntent,
  computeWeightedLeadValue, computeProfitEfficiency,
} from "./metrics/conversions.js";
import {
  loadGeoPriorityConfig, getZipWeight, getTier, getGeoAdjustedScore,
  isHighPriority, getTier1ZipsSorted, getTier2ZipsSorted,
  applyGeoPriorityBias, shouldSuppressBoulder, countIntentsByTier,
  getAllZipWeights,
} from "./geo/geoPriorityEngine.js";
import { filterIntentsBySeason, getCurrentSeason } from "./seasonality/seasonGate.js";
import { loadModeConfig, isCapacityAvailable, checkTierExpansion, loadCapacityConfig } from "./mode/conservativeGuard.js";
import { loadFlowControlConfig, applyFlowGovernor, evaluateFlowState } from "./flow/flowGovernor.js";

const ROOT = process.cwd();

function loadKPIs(): KPITargets {
  return readJSON<KPITargets>(resolve(ROOT, "config/kpi_targets.json"));
}

function loadOperators(): OperatorConfig[] {
  return readJSON<{ operators: OperatorConfig[] }>(resolve(ROOT, "config/orchestrator.json")).operators.filter((o) => o.enabled);
}

/**
 * Overlay real snapshot values onto KPI targets' `current` fields.
 * Snapshot wins over static config when available.
 */
function resolveKPICurrents(kpi: KPITargets, snapshot: MetricSnapshot | null): KPITargets {
  const resolved = JSON.parse(JSON.stringify(kpi)) as KPITargets;
  if (!snapshot) return resolved;

  // indexedPages: count of pages with ≥1 impression
  if (snapshot.indexedPages != null) {
    resolved.indexedPages.current = snapshot.indexedPages;
  }

  return resolved;
}

export function generateWeeklyPlan(weekNumber?: number): ToolEnvelope<WeeklyPlan> {
  const kpiRaw = loadKPIs();
  const snapshot = loadLatestSnapshot();
  const kpi = resolveKPICurrents(kpiRaw, snapshot);
  const convConfig = loadConversionConfig();
  const operators = loadOperators();
  const week = weekNumber || currentWeekNumber();
  const intents: PlanIntent[] = [];
  const modeConfig = loadModeConfig();
  const conservativeBlocked: { id: string; reason: string }[] = [];

  const snapshotNote = snapshot
    ? ` (from ${snapshot.date} snapshot: ${snapshot.totals.impressions} impr, ${snapshot.totals.clicks} clicks)`
    : " (no snapshot — using static config)";

  const convNote = snapshot?.conversions
    ? ` | Conversions: ${snapshot.conversions.CALL_CLICK || 0} calls, ${snapshot.conversions.FORM_SUBMIT || 0} forms`
    : "";

  // Always: weekly report from each operator
  for (const op of operators) {
    intents.push({
      id: `w${week}-${op.name}-report`,
      operator: op.name,
      command: "report",
      args: ["--weekly"],
      reason: "Standard weekly reporting",
      priority: "medium",
    });
  }

  // KPI-driven decisions
  const hasMarketing = operators.some((o) => o.name === "marketing");

  if (hasMarketing) {
    // Indexed pages gap
    const pageGap = kpi.indexedPages.target - kpi.indexedPages.current;
    if (pageGap > 20) {
      intents.push({
        id: `w${week}-marketing-index-accel`,
        operator: "marketing",
        command: "plan",
        args: ["--days", "30"],
        reason: `Index gap: ${pageGap} pages behind target (${kpi.indexedPages.current}/${kpi.indexedPages.target})${snapshotNote}`,
        priority: "high",
        kpiDriver: "indexedPages",
      });

      intents.push({
        id: `w${week}-marketing-geo-draft`,
        operator: "marketing",
        command: "draft",
        args: ["--intent", `week-${week}-geo-batch`, "--type", "geo"],
        reason: "Accelerate GEO page production to close index gap",
        priority: "high",
        kpiDriver: "indexedPages",
        expectedCalls: 2,
        expectedForms: 3,
        expectedConversionValue: scoreConversion(2, 3, convConfig),
      });
    } else if (pageGap > 0) {
      intents.push({
        id: `w${week}-marketing-geo-steady`,
        operator: "marketing",
        command: "draft",
        args: ["--intent", `week-${week}-geo`, "--type", "geo"],
        reason: `Steady index growth: ${pageGap} pages remaining${snapshotNote}`,
        priority: "medium",
        kpiDriver: "indexedPages",
        expectedCalls: 1,
        expectedForms: 2,
        expectedConversionValue: scoreConversion(1, 2, convConfig),
      });
    }

    // ---- Conversion-driven priorities using snapshot data ----
    if (snapshot) {
      // Low-CTR pages need attention
      const lowCTRPages = snapshot.topPages.filter((p) => p.ctr < 0.03 && p.impressions > 100);
      if (lowCTRPages.length > 3) {
        intents.push({
          id: `w${week}-marketing-ctr-fix`,
          operator: "marketing",
          command: "draft",
          args: ["--intent", `week-${week}-title-meta-refresh`, "--type", "seo"],
          reason: `${lowCTRPages.length} pages with CTR < 3% and 100+ impressions — title/meta refresh needed`,
          priority: "high",
          kpiDriver: "indexedPages",
          expectedCalls: 3,
          expectedForms: 2,
          expectedConversionValue: scoreConversion(3, 2, convConfig),
        });
      }

      // High-impression queries without matching pages
      const highImprQueries = snapshot.topQueries.filter((q) => q.impressions > 200 && q.position > 10);
      if (highImprQueries.length > 0) {
        const topQuery = highImprQueries[0];
        const intent = classifyQueryIntent(topQuery.query);
        const expCalls = intent === "call-first" ? 5 : intent === "form-first" ? 1 : 3;
        const expForms = intent === "form-first" ? 5 : intent === "call-first" ? 1 : 3;

        intents.push({
          id: `w${week}-marketing-opportunity`,
          operator: "marketing",
          command: "draft",
          args: ["--intent", `week-${week}-opportunity`, "--type", "seo", "--service", topQuery.query],
          reason: `High-impression query "${topQuery.query}" (${topQuery.impressions} impr) at position ${topQuery.position.toFixed(1)} — ${intent} content opportunity${convNote}`,
          priority: "high",
          kpiDriver: "indexedPages",
          expectedCalls: expCalls,
          expectedForms: expForms,
          expectedConversionValue: scoreConversion(expCalls, expForms, convConfig),
        });
      }

      // ---- Conversion-specific page priorities ----
      if (snapshot.topConversionPages && snapshot.topConversionPages.length > 0) {
        // Find top call-driving pages that need content improvement
        const callPages = snapshot.topConversionPages
          .filter((p) => p.calls > p.forms)
          .slice(0, 3);

        if (callPages.length > 0) {
          const topCallPage = callPages[0];
          intents.push({
            id: `w${week}-marketing-call-optimize`,
            operator: "marketing",
            command: "draft",
            args: ["--intent", `week-${week}-call-cta`, "--type", "seo", "--service", "Repair CTA Optimization"],
            reason: `Call-first page "${topCallPage.url}" driving ${topCallPage.calls} calls — optimize CTA placement and trust signals`,
            priority: "high",
            kpiDriver: "monthlyLeads",
            expectedCalls: 4,
            expectedForms: 0,
            expectedConversionValue: scoreConversion(4, 0, convConfig),
          });
        }

        // Find top form-driving pages
        const formPages = snapshot.topConversionPages
          .filter((p) => p.forms > p.calls)
          .slice(0, 3);

        if (formPages.length > 0) {
          const topFormPage = formPages[0];
          intents.push({
            id: `w${week}-marketing-form-optimize`,
            operator: "marketing",
            command: "draft",
            args: ["--intent", `week-${week}-form-cta`, "--type", "seo", "--service", "Estimate Form Optimization"],
            reason: `Form-first page "${topFormPage.url}" driving ${topFormPage.forms} forms — optimize estimate form and module layout`,
            priority: "high",
            kpiDriver: "monthlyLeads",
            expectedCalls: 0,
            expectedForms: 4,
            expectedConversionValue: scoreConversion(0, 4, convConfig),
          });
        }
      }
    }

    // GBP post cadence
    if (kpi.weeklyGBPPosts.current < kpi.weeklyGBPPosts.target) {
      intents.push({
        id: `w${week}-marketing-gbp`,
        operator: "marketing",
        command: "draft",
        args: ["--intent", `week-${week}-gbp`, "--type", "gbp"],
        reason: `GBP posts below target (${kpi.weeklyGBPPosts.current}/${kpi.weeklyGBPPosts.target} per week)`,
        priority: "medium",
        kpiDriver: "weeklyGBPPosts",
        expectedCalls: 2,
        expectedForms: 0,
        expectedConversionValue: scoreConversion(2, 0, convConfig),
      });
    }

    // Ad campaign cadence
    if (kpi.monthlyAdCampaigns.current < kpi.monthlyAdCampaigns.target) {
      intents.push({
        id: `w${week}-marketing-ads`,
        operator: "marketing",
        command: "draft",
        args: ["--intent", `week-${week}-ads`, "--type", "google-ad"],
        reason: `Ad campaigns below monthly target (${kpi.monthlyAdCampaigns.current}/${kpi.monthlyAdCampaigns.target})`,
        priority: "high",
        kpiDriver: "monthlyAdCampaigns",
        expectedCalls: 5,
        expectedForms: 3,
        expectedConversionValue: scoreConversion(5, 3, convConfig),
      });
    }

    // Blog cadence
    if (kpi.weeklyBlogPosts.current < kpi.weeklyBlogPosts.target) {
      intents.push({
        id: `w${week}-marketing-blog`,
        operator: "marketing",
        command: "draft",
        args: ["--intent", `week-${week}-blog`, "--type", "seo", "--service", "Heat Pump Installation"],
        reason: `Blog posts below weekly target (${kpi.weeklyBlogPosts.current}/${kpi.weeklyBlogPosts.target})`,
        priority: "low",
        kpiDriver: "weeklyBlogPosts",
        expectedCalls: 0,
        expectedForms: 1,
        expectedConversionValue: scoreConversion(0, 1, convConfig),
      });
    }

    // Seasonal: check month for furnace season (Oct-Feb)
    const month = new Date().getMonth() + 1;
    if (month >= 10 || month <= 2) {
      intents.push({
        id: `w${week}-marketing-furnace-seasonal`,
        operator: "marketing",
        command: "draft",
        args: ["--intent", `week-${week}-furnace-push`, "--type", "google-ad", "--service", "Furnace Repair"],
        reason: "Furnace season (Oct-Feb): boost heating campaign — repair intent drives calls",
        priority: "high",
        kpiDriver: "monthlyLeads",
        expectedCalls: 8,
        expectedForms: 2,
        expectedConversionValue: scoreConversion(8, 2, convConfig),
      });
    }

    // AC season (May-Sep)
    if (month >= 5 && month <= 9) {
      intents.push({
        id: `w${week}-marketing-ac-seasonal`,
        operator: "marketing",
        command: "draft",
        args: ["--intent", `week-${week}-ac-push`, "--type", "google-ad", "--service", "AC Repair"],
        reason: "AC season (May-Sep): boost cooling campaign — repair intent drives calls",
        priority: "high",
        kpiDriver: "monthlyLeads",
        expectedCalls: 8,
        expectedForms: 2,
        expectedConversionValue: scoreConversion(8, 2, convConfig),
      });
    }

    // ---- Geo-targeted intents (zipWeights-based, all start at 1.0) ----
    const geoConfig = loadGeoPriorityConfig();
    const allWeights = getAllZipWeights();
    const sortedZips = Object.entries(allWeights)
      .map(([zip, weight]) => ({ zip, weight }))
      .sort((a, b) => b.weight - a.weight);

    // Generate geo page intents for top zips (capped for small team)
    const geoIntentLimit = Math.min(sortedZips.length, 8); // manageable for 3-4 person team
    for (const { zip, weight } of sortedZips.slice(0, geoIntentLimit)) {
      const baseScore = scoreConversion(4, 2, convConfig);
      const geoScore = getGeoAdjustedScore(baseScore, zip);
      intents.push({
        id: `w${week}-marketing-geo-${zip}`,
        operator: "marketing",
        command: "draft",
        args: ["--intent", `week-${week}-geo-${zip}`, "--type", "geo", "--zip", zip],
        reason: `Target ZIP ${zip} (weight ${weight.toFixed(2)}) — geo page targeting`,
        priority: weight > 1.0 ? "high" : "medium",
        kpiDriver: "indexedPages",
        expectedCalls: 4,
        expectedForms: 2,
        expectedConversionValue: baseScore,
        zip,
        geoTier: "unknown",
        geoAdjustedScore: geoScore,
      });
    }
  }

  // ---- Compute profit efficiency for intents with conversion data ----
  for (const intent of intents) {
    if ((intent.expectedCalls || 0) > 0 || (intent.expectedForms || 0) > 0) {
      const profit = computeProfitEfficiency(
        intent.expectedCalls || 0,
        intent.expectedForms || 0,
        0, // adSpend unknown at planning time — uses lead value only
        convConfig
      );
      intent.profitEfficiencyScore = intent.geoAdjustedScore != null
        ? Math.round(profit.weightedLeadValue * getZipWeight(intent.zip || "") * 100) / 100
        : profit.weightedLeadValue;
    }
  }

  // ---- Apply geo priority biasing (sort + suppress Boulder) ----
  const biasedIntents = applyGeoPriorityBias(intents);

  // ---- Apply season gate: block out-of-season ad intents ----
  const { allowed: seasonFiltered, blocked: seasonBlocked } = filterIntentsBySeason(biasedIntents);

  // ---- Apply flow governor: lead flow control for small teams ----
  const flowConfig = loadFlowControlConfig();
  // Load flow state from config/flow_state.json or use safe defaults
  const flowState = safeReadJSON<import("../types/index.js").FlowState>(
    resolve(ROOT, "config/flow_state.json"),
    {
      qualifiedLeadsToday: 0,
      installLeadsThisWeek: 0,
      repairLeadsToday: 0,
      upgradeLeadsThisWeek: 0,
      totalLeadsThisWeek: 0,
      backlogHours: 0,
    }
  );

  const flowResult = applyFlowGovernor(seasonFiltered, flowState, flowConfig);
  // The kept intents are those not suppressed by flow governor
  const flowFiltered = seasonFiltered.filter(
    (i) => !flowResult.intentModifications.suppressed.includes(i.id)
  );

  const flowBlocked = flowResult.intentModifications.suppressed.map((id) => ({
    id,
    reason: `Flow governor: lead cap or backlog limit reached`,
  }));

  const flowReprioritized = flowResult.intentModifications.reprioritized.map((id) => ({
    id,
    reason: `Flow governor: priority reduced due to cap`,
  }));

  const plan: WeeklyPlan = {
    planId: `plan-w${week}-${nowISO().split("T")[0]}`,
    weekNumber: week,
    createdAt: nowISO(),
    intents: flowFiltered,
    seasonBlocked: seasonBlocked.length > 0
      ? seasonBlocked.map((b) => ({ id: b.intent.id, reason: b.reason }))
      : undefined,
    seasonMode: getCurrentSeason(),
    conservativeBlocked: conservativeBlocked.length > 0 ? conservativeBlocked : undefined,
    operatingMode: modeConfig.mode,
    flowBlocked: flowBlocked.length > 0 ? flowBlocked : undefined,
    flowReprioritized: flowReprioritized.length > 0 ? flowReprioritized : undefined,
  };

  return { status: "EXECUTED", data: plan };
}
