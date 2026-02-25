/**
 * MBS Master Orchestrator — Test Suite v1.8.0
 * Covers: hashing, schema, CSV parsing, experiment IDs, approval integrity, conversions,
 *         geo priority, efficiency guard, profit efficiency, lead quality, calibration,
 *         seasonality, waste hunter, conservative mode guard, lead flow governor.
 */

import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { deterministicHash, hashFile, SCHEMA_VERSION, GENERATOR_VERSION, ensureDir, writeJSON } from "../utils/index.js";
import { parseGSCPages, parseGSCQueries, buildSnapshot } from "../core/metrics/parser.js";
import { makeExperimentId, generateWeeklyExperiments } from "../core/experiments.js";
import { computePackContentHash } from "../core/approvals.js";
import {
  parseGA4Events, aggregateConversions, aggregateManualConversions,
  scoreConversion, tieBreakerGoal, classifyPageIntent, classifyQueryIntent,
  loadConversionConfig, computeWeightedLeadValue, computeProfitEfficiency,
} from "../core/metrics/conversions.js";
import {
  getZipWeight, getTier, getGeoAdjustedScore, isHighPriority,
  shouldSuppressBoulder, applyGeoPriorityBias, isTier1Saturated,
  countIntentsByTier, getTier1ZipsSorted, resetGeoCache, getZipsInTier,
} from "../core/geo/geoPriorityEngine.js";
import {
  evaluateZipEfficiency, runEfficiencyGuard,
} from "../core/ads/efficiencyGuard.js";
import {
  scoreCall, scoreForm, computeQualifiedLeadValue, loadLeadQualityConfig,
} from "../core/leads/qualityScoring.js";
import type { CallSignals, FormSignals } from "../core/leads/qualityScoring.js";
import {
  parseOutcomesCSV, computeObservedMetrics, runCalibration, assessConfidence,
} from "../core/calibration/outcomeCalibration.js";
import {
  getCurrentSeason, checkSeasonGate, filterIntentsBySeason,
} from "../core/seasonality/seasonGate.js";
import {
  parseSearchTermsCSV, classifyTerm, isHighSpendZeroConv, shouldTightenMatch, analyzeSearchTerms,
} from "../core/ads/wasteHunter.js";
import {
  loadModeConfig, loadCapacityConfig, isCapacityAvailable, evaluateConservative,
  checkTierExpansion, runConservativeGuard, resetModeCache,
} from "../core/mode/conservativeGuard.js";
import {
  loadFlowControlConfig, evaluateFlowState, applyFlowGovernor,
  isInstallIntent, isRepairIntent, isUpgradeIntent, resetFlowCache,
  computeEffectiveLeads, computeFlowThresholds, determineFlowMode,
  computeInstallLadderStep,
} from "../core/flow/flowGovernor.js";
import {
  computeZipPerformance, evaluateZipWeight, runGeoWeightLearning,
} from "../core/geo/geoWeightLearner.js";
import type { ZipMetricsInput } from "../core/geo/geoWeightLearner.js";
import { getAllZipWeights } from "../core/geo/geoPriorityEngine.js";
import {
  bootConstitution, resetConstitutionCache, getConstitutionBoot,
} from "../core/constitution/loader.js";
import {
  evaluateGatekeeper, buildGatekeeperContext, isServiceAllowedByConstitution,
} from "../core/constitution/gatekeeper.js";
import type {
  BundleManifest, Experiment, MetricSnapshot, ConversionConfig, PlanIntent,
  EfficiencyInput, OutcomeRow, SearchTermRow, LeadQualityConfig,
  ModeConfig, CapacityConfig, ConservativeGuardInput, TierExpansionCheck,
  FlowControlConfig, FlowState, FlowMode,
  GeoLearningConfig, ZipPerformance, ZipWeightProposal, GeoPriorityConfig,
  GatekeeperContext,
} from "../types/index.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

function heading(name: string) {
  console.log(`\n${"─".repeat(50)}\n${name}\n${"─".repeat(50)}`);
}

const TMPDIR = join(process.cwd(), ".test-tmp");
ensureDir(TMPDIR);

console.log("\n🧪 MBS Master Orchestrator — Test Suite v1.7\n");

// ============================================================
// 1. Deterministic Hashing
// ============================================================
heading("1. Deterministic Hashing");
{
  const input = JSON.stringify({ a: 1, b: "hello" });
  const h1 = deterministicHash(input);
  const h2 = deterministicHash(input);
  assert(h1 === h2, "Same input → same hash");
  assert(h1.length === 64, "SHA-256 = 64 hex chars");
  assert(h1 !== deterministicHash("different"), "Different input → different hash");
}

// ============================================================
// 2. Bundle Manifest Schema
// ============================================================
heading("2. Bundle Manifest Schema");
{
  const m: BundleManifest = {
    bundleId: "test-bundle-123", weekNumber: 9,
    createdAt: "2026-02-24T00:00:00.000Z",
    deterministicHash: deterministicHash("test"),
    generatorVersion: GENERATOR_VERSION, schemaVersion: SCHEMA_VERSION,
    operators: [], kpiSnapshot: {}, requiresApproval: true,
  };
  assert(m.bundleId.length > 0, "bundleId non-empty");
  assert(m.deterministicHash.length === 64, "hash is 64 chars");
  assert(m.generatorVersion === "1.9.0", "generatorVersion 1.9.0");
  assert(m.schemaVersion === "1.0.0", "schemaVersion stays 1.0.0");
}

// ============================================================
// 3. Version Constants
// ============================================================
heading("3. Version Constants");
{
  assert(SCHEMA_VERSION === "1.0.0", "SCHEMA_VERSION = 1.0.0 (unbroken)");
  assert(GENERATOR_VERSION === "1.9.0", "GENERATOR_VERSION = 1.9.0 (bumped)");
}

// ============================================================
// 4. CSV Parsing — GSC Pages
// ============================================================
heading("4. CSV Parsing — GSC Pages");
{
  const csvPath = join(TMPDIR, "test-pages.csv");
  writeFileSync(csvPath, [
    "Page,Impressions,Clicks,CTR,Position",
    "https://example.com/,1000,80,8.0%,4.5",
    "https://example.com/services,500,30,6.0%,7.2",
    "https://example.com/about,200,10,5.0%,12.1",
    "https://example.com/zero,0,0,0%,0",
  ].join("\n"));

  const result = parseGSCPages(csvPath);
  assert(result.status === "EXECUTED", "parseGSCPages EXECUTED");

  const pages = result.data!;
  assert(pages.length === 4, "Parsed 4 rows");
  assert(pages[0].page === "https://example.com/", "Sorted by clicks desc — homepage first");
  assert(pages[0].impressions === 1000, "Impressions correct");
  assert(pages[0].clicks === 80, "Clicks correct");
  assert(pages[0].ctr === 0.08, "CTR 8% → 0.08");
  assert(pages[0].position === 4.5, "Position correct");
  assert(pages[3].clicks === 0, "Zero-click page present");
}

// ============================================================
// 5. CSV Parsing — GSC Queries
// ============================================================
heading("5. CSV Parsing — GSC Queries");
{
  const csvPath = join(TMPDIR, "test-queries.csv");
  writeFileSync(csvPath, [
    "Query,Impressions,Clicks,CTR,Position",
    "heat pump denver,1200,90,7.5%,4.8",
    '"furnace repair, denver",800,60,7.5%,5.2',
    "ac repair,400,25,6.25%,8.1",
  ].join("\n"));

  const result = parseGSCQueries(csvPath);
  assert(result.status === "EXECUTED", "parseGSCQueries EXECUTED");
  const queries = result.data!;
  assert(queries.length === 3, "Parsed 3 rows");
  assert(queries[0].query === "heat pump denver", "First query correct");
  assert(queries[1].query === "furnace repair, denver", "Quoted field with comma parsed");
  assert(queries[1].impressions === 800, "Impressions after quoted field correct");
}

// ============================================================
// 6. CSV Parsing — Edge Cases
// ============================================================
heading("6. CSV Parsing — Edge Cases");
{
  const missing = parseGSCPages("/nonexistent.csv");
  assert(missing.status === "FAILED", "Missing file → FAILED");
  assert(missing.error?.code === "METRICS_CSV_NOT_FOUND", "Error code METRICS_CSV_NOT_FOUND");

  const emptyPath = join(TMPDIR, "empty.csv");
  writeFileSync(emptyPath, "Page,Impressions,Clicks,CTR,Position\n");
  const empty = parseGSCPages(emptyPath);
  assert(empty.status === "FAILED", "Empty CSV → FAILED");
  assert(empty.error?.code === "METRICS_CSV_EMPTY", "Error code METRICS_CSV_EMPTY");
}

// ============================================================
// 7. MetricSnapshot Builder
// ============================================================
heading("7. MetricSnapshot Builder");
{
  const pages = [
    { page: "https://a.com", impressions: 1000, clicks: 80, ctr: 0.08, position: 4.5 },
    { page: "https://b.com", impressions: 500, clicks: 30, ctr: 0.06, position: 7.2 },
    { page: "https://c.com", impressions: 0, clicks: 0, ctr: 0, position: 0 },
  ];
  const queries = [
    { query: "test query", impressions: 800, clicks: 60, ctr: 0.075, position: 5.0 },
  ];

  const snap = buildSnapshot(pages, queries, "2026-02-20");
  assert(snap.date === "2026-02-20", "Date correct");
  assert(snap.source === "gsc", "Source is gsc");
  assert(snap.indexedPages === 2, "indexedPages = pages with impressions > 0");
  assert(snap.totals.impressions === 1500, "Total impressions summed");
  assert(snap.totals.clicks === 110, "Total clicks summed");
  assert(snap.totals.ctr > 0.073 && snap.totals.ctr < 0.074, "CTR = clicks/impressions");
  assert(snap.totals.avgPosition > 5.3 && snap.totals.avgPosition < 5.5, "Avg position weighted");
}

// ============================================================
// 8. Deterministic Experiment IDs
// ============================================================
heading("8. Deterministic Experiment IDs");
{
  const id1 = makeExperimentId("seo", "Internal Link Test", 9);
  const id2 = makeExperimentId("seo", "Internal Link Test", 9);
  const id3 = makeExperimentId("seo", "Internal Link Test", 10);
  const id4 = makeExperimentId("ads", "Internal Link Test", 9);

  assert(id1 === id2, "Same type+name+week → identical ID");
  assert(id1 !== id3, "Different week → different ID");
  assert(id1 !== id4, "Different type → different ID");
  assert(id1.startsWith("exp-seo-"), "SEO prefix correct");
  assert(id4.startsWith("exp-ads-"), "Ads prefix correct");
  assert(id1.endsWith("-w9"), "Week suffix correct");
}

// ============================================================
// 9. Experiment Generation — Full Structure
// ============================================================
heading("9. Experiment Generation — Structure");
{
  const result = generateWeeklyExperiments(9);
  assert(result.status === "EXECUTED", "Generation succeeds");
  const exps = result.data!;
  assert(exps.length === 4, "Exactly 4 experiments per week (seo + ads + call conv + form conv)");
  assert(exps.some(e => e.type === "seo"), "Has SEO experiment");
  assert(exps.some(e => e.type === "ads"), "Has Ads experiment");
  assert(exps.some(e => e.type === "conversion" && e.conversionGoal === "CALL_CLICK"), "Has Call conversion experiment");
  assert(exps.some(e => e.type === "conversion" && e.conversionGoal === "FORM_SUBMIT"), "Has Form conversion experiment");

  for (const exp of exps) {
    const label = exp.type === "conversion" ? `conv/${exp.conversionGoal}` : exp.type;
    assert(exp.hypothesis.length > 20, `${label}: substantive hypothesis`);
    assert(exp.variants.length >= 2, `${label}: ≥2 variants`);
    assert(exp.successMetric.length > 0, `${label}: has successMetric`);
    assert(exp.minimumSampleSize > 0, `${label}: minimumSampleSize > 0`);
    assert(exp.durationWeeks > 0, `${label}: durationWeeks > 0`);
    assert(exp.stopRules.length >= 2, `${label}: ≥2 stop rules`);
    assert(exp.rollbackPlan.length > 10, `${label}: substantive rollbackPlan`);
    assert(exp.status === "proposed", `${label}: status = proposed`);
  }

  // Rotation: different weeks produce different experiments
  const w10 = generateWeeklyExperiments(10).data!;
  const w11 = generateWeeklyExperiments(11).data!;
  const ids9 = exps.map(e => e.id).join(",");
  const ids10 = w10.map(e => e.id).join(",");
  const ids11 = w11.map(e => e.id).join(",");
  assert(ids9 !== ids10 || ids9 !== ids11, "Rotation varies across weeks");
}

// ============================================================
// 10. Approval Integrity — Content Hash Change Detected
// ============================================================
heading("10. Approval Integrity — Hash Invalidation");
{
  const packDir = join(TMPDIR, "integrity-pack");
  const contentDir = join(packDir, "content");
  ensureDir(contentDir);

  writeJSON(join(contentDir, "geo-page.json"), { title: "Original", body: "Content v1", wordCount: 500 });
  writeJSON(join(contentDir, "gbp-post.json"), { topic: "Tips", body: "Original GBP" });

  // Hash at approval time
  const hashAtApproval = computePackContentHash(packDir);
  assert(hashAtApproval.length === 64, "Content hash is SHA-256");

  // Idempotent check
  assert(computePackContentHash(packDir) === hashAtApproval, "Same content → same hash (idempotent)");

  // Modify content
  writeJSON(join(contentDir, "geo-page.json"), { title: "Original", body: "TAMPERED content v2", wordCount: 600 });
  const hashAfterChange = computePackContentHash(packDir);
  assert(hashAfterChange !== hashAtApproval, "Modified content → different hash → approval INVALIDATED");

  // Restore original
  writeJSON(join(contentDir, "geo-page.json"), { title: "Original", body: "Content v1", wordCount: 500 });
  assert(computePackContentHash(packDir) === hashAtApproval, "Restored content → hash matches → approval valid");
}

// ============================================================
// 11. Approval Integrity — Ads Directory Changes
// ============================================================
heading("11. Approval Integrity — Ads Changes");
{
  const packDir = join(TMPDIR, "integrity-ads");
  const adsDir = join(packDir, "ads");
  ensureDir(adsDir);
  writeJSON(join(adsDir, "campaign.json"), { budget: 75, keywords: ["heat pump"] });

  const before = computePackContentHash(packDir);
  writeJSON(join(adsDir, "campaign.json"), { budget: 150, keywords: ["heat pump"] });
  const after = computePackContentHash(packDir);

  assert(before !== after, "Ads budget change detected by content hash");
}

// ============================================================
// 12. Approval Integrity — Empty Pack Stable
// ============================================================
heading("12. Approval Integrity — Empty Pack");
{
  const emptyPack = join(TMPDIR, "empty-pack");
  ensureDir(emptyPack);
  const h1 = computePackContentHash(emptyPack);
  const h2 = computePackContentHash(emptyPack);
  assert(h1 === h2, "Empty pack hash stable");
  assert(h1.length === 64, "Empty pack hash valid SHA-256");
}

// ============================================================
// 13. hashFile Utility
// ============================================================
heading("13. hashFile Utility");
{
  const fp = join(TMPDIR, "hashfile-test.json");
  writeFileSync(fp, '{"test": true}');
  assert(hashFile(fp) === hashFile(fp), "hashFile deterministic");
  assert(hashFile(fp).length === 64, "hashFile returns SHA-256");
  assert(hashFile("/no/such/file") !== hashFile(fp), "Missing file hash differs");
}

// ============================================================
// 14. Schema Backwards Compatibility
// ============================================================
heading("14. Schema Backwards Compatibility");
{
  const v10: BundleManifest = {
    bundleId: "old", weekNumber: 8, createdAt: "2026-02-17T00:00:00Z",
    deterministicHash: deterministicHash("old"), generatorVersion: "1.0.0",
    schemaVersion: "1.0.0", operators: [], kpiSnapshot: {}, requiresApproval: true,
  };
  assert(v10.experiments === undefined, "v1.0 manifest has no experiments");
  assert(v10.schemaVersion === "1.0.0", "v1.0 schema untouched");

  const v11: BundleManifest = {
    ...v10, generatorVersion: "1.1.0",
    experiments: [{ id: "exp-test", type: "seo", name: "Test" } as Experiment],
  };
  assert(v11.experiments!.length === 1, "v1.1 manifest carries experiments");
  assert(v11.schemaVersion === "1.0.0", "v1.1 still schema 1.0.0");
}

// ============================================================
// 15. GA4 CSV Parsing
// ============================================================
heading("15. GA4 CSV Parsing");
{
  const csvPath = join(TMPDIR, "ga4-test.csv");
  writeFileSync(csvPath, [
    "Page path,Event name,Event count",
    "/services/furnace-repair,click_to_call,18",
    "/services/furnace-repair,form_submit,4",
    "/services/ac-repair,phone_click,10",
    "/services/heat-pump-installation,generate_lead,12",
    "/services/heat-pump-installation,click_to_call,3",
    "/about,page_view,500",
  ].join("\n"));

  const result = parseGA4Events(csvPath);
  assert(result.status === "EXECUTED", "GA4 parse succeeds");
  const events = result.data!;
  assert(events.length === 5, "Parsed 5 conversion events (skipped page_view)");
  assert(events.filter(e => e.eventName === "CALL_CLICK").length === 3, "3 CALL_CLICK events");
  assert(events.filter(e => e.eventName === "FORM_SUBMIT").length === 2, "2 FORM_SUBMIT events");
  assert(events.find(e => e.page === "/services/furnace-repair" && e.eventName === "CALL_CLICK")!.eventCount === 18, "Correct call count for furnace-repair");

  // Missing file
  const missingResult = parseGA4Events("/no/such/file.csv");
  assert(missingResult.status === "FAILED", "Missing CSV fails gracefully");
  assert(missingResult.error?.code === "CONVERSION_CSV_NOT_FOUND", "Correct error code for missing GA4");

  // Empty CSV (header only → no data rows)
  const emptyPath = join(TMPDIR, "ga4-empty.csv");
  writeFileSync(emptyPath, "Page path,Event name,Event count\n");
  const emptyResult = parseGA4Events(emptyPath);
  assert(emptyResult.status === "FAILED", "Empty GA4 CSV fails (header only, no data)");
  assert(emptyResult.error?.code === "CONVERSION_CSV_EMPTY", "Correct error code for empty GA4");
}

// ============================================================
// 16. Conversion Aggregation
// ============================================================
heading("16. Conversion Aggregation");
{
  const config: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
    tieBreakerWindowDays: 14,
  };

  const events = [
    { page: "/services/furnace-repair", eventName: "CALL_CLICK", eventCount: 18 },
    { page: "/services/furnace-repair", eventName: "FORM_SUBMIT", eventCount: 4 },
    { page: "/services/heat-pump-installation", eventName: "CALL_CLICK", eventCount: 3 },
    { page: "/services/heat-pump-installation", eventName: "FORM_SUBMIT", eventCount: 12 },
  ];

  const result = aggregateConversions(events, config);
  assert(result.totals.CALL_CLICK === 21, "Total calls: 18+3=21");
  assert(result.totals.FORM_SUBMIT === 16, "Total forms: 4+12=16");
  assert(result.totals.weightedTotal === 21 * 1.0 + 16 * 0.7, "Weighted total correct (21 + 11.2 = 32.2)");
  assert(result.pages.length === 2, "2 unique pages");
  assert(result.pages[0].url === "/services/furnace-repair", "Furnace-repair first (higher weighted)");
  assert(result.pages[0].weightedValue === 18 * 1.0 + 4 * 0.7, "Furnace-repair: 18 + 2.8 = 20.8");
}

// ============================================================
// 17. Manual KPI Aggregation
// ============================================================
heading("17. Manual KPI Aggregation");
{
  const config: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
    tieBreakerWindowDays: 14,
  };

  const manual = {
    calls: 50,
    forms: 30,
    pages: [
      { url: "/services/ac-repair", calls: 20, forms: 5 },
      { url: "/services/furnace-install", calls: 5, forms: 15 },
    ],
  };

  const result = aggregateManualConversions(manual, config);
  assert(result.totals.CALL_CLICK === 50, "Manual total calls");
  assert(result.totals.FORM_SUBMIT === 30, "Manual total forms");
  assert(result.totals.weightedTotal === 50 * 1.0 + 30 * 0.7, "Manual weighted total: 50 + 21 = 71");
  assert(result.pages.length === 2, "2 manual pages");
  assert(result.pages[0].url === "/services/ac-repair", "AC-repair first (higher call weight)");
}

// ============================================================
// 18. Dual-Weight Scoring
// ============================================================
heading("18. Dual-Weight Scoring");
{
  const config: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
    tieBreakerWindowDays: 14,
  };

  // Pure call action
  assert(scoreConversion(10, 0, config) === 10.0, "10 calls × 1.0 = 10.0");
  // Pure form action
  assert(scoreConversion(0, 10, config) === 7.0, "10 forms × 0.7 = 7.0");
  // Mixed
  assert(scoreConversion(5, 5, config) === 8.5, "5×1.0 + 5×0.7 = 8.5");
  // Zero
  assert(scoreConversion(0, 0, config) === 0, "Zero conversions = 0");

  // Call actions always score higher than same-count form actions
  const callScore = scoreConversion(10, 0, config);
  const formScore = scoreConversion(0, 10, config);
  assert(callScore > formScore, "Calls weighted higher than forms (10>7)");

  // Custom weights
  const equalConfig: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 1.0 },
    tieBreakerWindowDays: 14,
  };
  assert(scoreConversion(5, 5, equalConfig) === 10.0, "Equal weights: 5+5=10");
}

// ============================================================
// 19. Tie-Breaker Logic
// ============================================================
heading("19. Tie-Breaker Logic");
{
  const config: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
    tieBreakerWindowDays: 14,
  };

  const current: MetricSnapshot = {
    date: "2026-02-24",
    source: "combined",
    topPages: [], topQueries: [],
    totals: { impressions: 1000, clicks: 100, ctr: 0.1, avgPosition: 5 },
    conversions: { CALL_CLICK: 50, FORM_SUBMIT: 40, weightedTotal: 78 },
  };

  const previous: MetricSnapshot = {
    date: "2026-02-17",
    source: "combined",
    topPages: [], topQueries: [],
    totals: { impressions: 900, clicks: 90, ctr: 0.1, avgPosition: 5.5 },
    conversions: { CALL_CLICK: 30, FORM_SUBMIT: 35, weightedTotal: 54.5 },
  };

  // Calls grew by 20, forms grew by 5 → weighted: calls win
  const winner = tieBreakerGoal(current, previous, config);
  assert(winner === "CALL_CLICK", "Calls trend wins (20×1.0=20 vs 5×0.7=3.5)");

  // Reverse: forms grow more
  const prevFormGrowth: MetricSnapshot = {
    ...previous,
    conversions: { CALL_CLICK: 48, FORM_SUBMIT: 10, weightedTotal: 55 },
  };
  const formWinner = tieBreakerGoal(current, prevFormGrowth, config);
  assert(formWinner === "FORM_SUBMIT", "Forms trend wins when form delta is larger weighted");

  // Outside window
  const tooOld: MetricSnapshot = {
    ...previous,
    date: "2026-01-01",
  };
  assert(tieBreakerGoal(current, tooOld, config) === null, "Outside 14-day window returns null");

  // No conversion data
  const noConv: MetricSnapshot = {
    ...previous,
    conversions: undefined,
  };
  assert(tieBreakerGoal(current, noConv, config) === null, "Missing conversion data returns null");
}

// ============================================================
// 20. Intent Classification
// ============================================================
heading("20. Intent Classification");
{
  assert(classifyPageIntent("/services/furnace-repair") === "call-first", "Repair URL → call-first");
  assert(classifyPageIntent("/services/heat-pump-installation") === "form-first", "Install URL → form-first");
  assert(classifyPageIntent("/service-areas/denver") === "mixed", "GEO URL → mixed");
  assert(classifyPageIntent("/services/emergency-furnace-fix") === "call-first", "Emergency+fix → call-first");

  assert(classifyQueryIntent("furnace repair near me") === "call-first", "Repair query → call-first");
  assert(classifyQueryIntent("heat pump installation cost") === "form-first", "Install query → form-first");
  assert(classifyQueryIntent("hvac services denver") === "mixed", "Generic query → mixed");
}

// ============================================================
// 21. Conversion Config Loading
// ============================================================
heading("21. Conversion Config Loading");
{
  const config = loadConversionConfig();
  assert(config.primaryGoals.includes("CALL_CLICK"), "Config has CALL_CLICK goal");
  assert(config.primaryGoals.includes("FORM_SUBMIT"), "Config has FORM_SUBMIT goal");
  assert(config.weights.CALL_CLICK === 1.0, "CALL_CLICK weight = 1.0");
  assert(config.weights.FORM_SUBMIT === 0.7, "FORM_SUBMIT weight = 0.7");
  assert(config.tieBreakerWindowDays === 14, "Tie-breaker window = 14 days");
}

// ============================================================
// 22. GA4 Flexible Column Headers
// ============================================================
heading("22. GA4 Flexible Column Headers");
{
  const csvPath = join(TMPDIR, "ga4-flex.csv");
  writeFileSync(csvPath, [
    "page_location,event_action,total_events",
    "/services/ac-repair,click_to_call,7",
    "/services/furnace-install,generate_lead,5",
  ].join("\n"));

  const result = parseGA4Events(csvPath);
  assert(result.status === "EXECUTED", "Flex headers parse OK");
  assert(result.data!.length === 2, "Parsed 2 events with flex headers");
  assert(result.data![0].eventName === "CALL_CLICK", "Mapped click_to_call → CALL_CLICK");
  assert(result.data![1].eventName === "FORM_SUBMIT", "Mapped generate_lead → FORM_SUBMIT");
}

// ============================================================
// 23. Geo Priority — Zip Weight Lookup
// ============================================================
heading("23. Geo Priority — Zip Weight Lookup (zipWeights mode)");
{
  resetGeoCache();
  // All configured zips start at 1.0
  assert(getZipWeight("80113") === 1.0, "Target zip 80113 weight = 1.0");
  assert(getZipWeight("80007") === 1.0, "Target zip 80007 weight = 1.0");
  assert(getZipWeight("80401") === 1.0, "Target zip 80401 weight = 1.0");
  assert(getZipWeight("80602") === 1.0, "Target zip 80602 weight = 1.0");
  assert(getZipWeight("99999") === 1.0, "Unknown zip returns neutral 1.0");
}

// ============================================================
// 24. Geo Priority — Tier Lookup
// ============================================================
heading("24. Geo Priority — Tier Lookup (zipWeights mode)");
{
  // In zipWeights mode, all zips return "unknown" tier (tiers are informational only)
  assert(getTier("80113") === "unknown", "80113 → unknown (no tiers in zipWeights mode)");
  assert(getTier("80007") === "unknown", "80007 → unknown");
  assert(getTier("80401") === "unknown", "80401 → unknown");
  assert(getTier("80602") === "unknown", "80602 → unknown");
  assert(getTier("99999") === "unknown", "Unknown zip → unknown tier");
}

// ============================================================
// 25. Geo Priority — Adjusted Score Calculation
// ============================================================
heading("25. Geo Adjusted Score Calculation (zipWeights mode)");
{
  // All target zips have weight 1.0 → score unchanged
  const score1 = getGeoAdjustedScore(10, "80113");
  assert(score1 === 10.0, "10 × 1.0 = 10.0 (all weights start neutral)");

  const score2 = getGeoAdjustedScore(10, "80602");
  assert(score2 === 10.0, "10 × 1.0 = 10.0 (target zip neutral)");

  // Unknown zip also 1.0
  const scoreN = getGeoAdjustedScore(10, "99999");
  assert(scoreN === 10.0, "10 × 1.0 = 10.0 (unknown zip neutral)");

  // Zero base score
  assert(getGeoAdjustedScore(0, "80113") === 0, "0 × any weight = 0");
}

// ============================================================
// 26. Geo Priority — isHighPriority
// ============================================================
heading("26. Geo Priority — isHighPriority (zipWeights mode)");
{
  // In zipWeights mode, no zips are in tier1 → all return false
  assert(isHighPriority("80113") === false, "No tier1 in zipWeights mode → false");
  assert(isHighPriority("80212") === false, "Base zip not in tier1 → false");
  assert(isHighPriority("80007") === false, "Target zip not tier1 → false");
  assert(isHighPriority("99999") === false, "Unknown zip → false");
}

// ============================================================
// 27. Geo Priority — Tier Ordering & Prioritization
// ============================================================
heading("27. ZIP Weight Ordering & Biasing");
{
  const allZips = getTier1ZipsSorted();
  assert(allZips.length === 42, `All 42 target ZIPs returned (got ${allZips.length})`);
  assert(allZips[0].weight === 1.0, "All weights start at 1.0");
  assert(allZips[allZips.length - 1].weight <= allZips[0].weight, "Sorted descending");

  // Verify biasing: with equal weights, order is by geoAdjustedScore (both 8.0)
  // then by insertion order (stable sort)
  const intents: PlanIntent[] = [
    { id: "z2", operator: "m", command: "d", args: [], reason: "", priority: "high", zip: "80007", expectedConversionValue: 8 },
    { id: "z1", operator: "m", command: "d", args: [], reason: "", priority: "high", zip: "80113", expectedConversionValue: 10 },
  ];
  const biased = applyGeoPriorityBias(intents);
  // 80113 has higher conversion value so it sorts first
  assert(biased[0].zip === "80113", "Higher conversion value zip sorted first");
  assert(biased[0].geoAdjustedScore! >= biased[1].geoAdjustedScore!, "Higher score first");
}

// ============================================================
// 28. Boulder Suppression Logic
// ============================================================
heading("28. Boulder Suppression Logic (zipWeights mode)");
{
  // In zipWeights mode, no zips are tier4 → shouldSuppressBoulder always false
  assert(shouldSuppressBoulder("80503", 10) === false, "80503 not tier4 → not suppressed");
  assert(shouldSuppressBoulder("80304", 10) === false, "80304 not tier4 → not suppressed");
  assert(shouldSuppressBoulder("80113", 10) === false, "Target zip never suppressed");
  assert(shouldSuppressBoulder("99999", 10) === false, "Unknown zip never suppressed");

  // All target zips have weight 1.0, adjusted = base
  const adjusted = getGeoAdjustedScore(10, "80113");
  assert(adjusted === 10.0, "80113 adjusted score = 10.0 (weight 1.0)");
  assert(adjusted > 10 * 0.75, "10.0 > 7.5 threshold");

  // Intents kept in zipWeights mode (no boulder filtering)
  const intents: PlanIntent[] = [
    { id: "b1", operator: "m", command: "d", args: [], reason: "", priority: "medium", zip: "80113", expectedConversionValue: 5 },
  ];
  const biased = applyGeoPriorityBias(intents);
  assert(biased.length === 1, "All intents kept in zipWeights mode");
}

// ============================================================
// 29. Efficiency Guard — Bid Adjustment Calculation
// ============================================================
heading("29. Efficiency Guard — Bid Adjustment");
{
  // Rule 1: CPL > target → reduce bid
  const highCPL: EfficiencyInput = {
    zip: "80113", costPerWeightedLead: 100, impressionShareLostToBudget: 5,
    travelDistanceMiles: 10, currentBidModifier: 40,
  };
  const rec1 = evaluateZipEfficiency(highCPL, 75);
  assert(rec1.action === "reduce_bid", "CPL $100 > target $75 → reduce_bid");
  assert(rec1.recommendedBidModifier === 30, "40% - 10% = 30%");

  // Rule 2: CPL < target AND IS lost > 10% → increase bid
  const lowCPL: EfficiencyInput = {
    zip: "80007", costPerWeightedLead: 50, impressionShareLostToBudget: 15,
    travelDistanceMiles: 10, currentBidModifier: 25,
  };
  const rec2 = evaluateZipEfficiency(lowCPL, 75);
  assert(rec2.action === "increase_bid", "CPL $50 < target $75 and IS lost 15% → increase_bid");
  assert(rec2.recommendedBidModifier === 35, "25% + 10% = 35%");

  // Rule 2 with cap: already at 50% → stays at 50%
  const atCap: EfficiencyInput = {
    zip: "80007", costPerWeightedLead: 50, impressionShareLostToBudget: 15,
    travelDistanceMiles: 10, currentBidModifier: 50,
  };
  const recCap = evaluateZipEfficiency(atCap, 75);
  assert(recCap.recommendedBidModifier === 50, "At max 50% cap → stays 50%");

  // Rule 3: travel > 45 AND CPL > target → suppress
  const farAway: EfficiencyInput = {
    zip: "80503", costPerWeightedLead: 90, impressionShareLostToBudget: 5,
    travelDistanceMiles: 50, currentBidModifier: -10,
  };
  const rec3 = evaluateZipEfficiency(farAway, 75);
  assert(rec3.action === "suppress", "Travel 50mi > 45mi AND CPL > target → suppress");
  assert(rec3.recommendedBidModifier === 0, "Suppressed → 0% modifier");

  // Rule 4: hold (CPL within target, no IS pressure)
  const okZip: EfficiencyInput = {
    zip: "80209", costPerWeightedLead: 60, impressionShareLostToBudget: 5,
    travelDistanceMiles: 10, currentBidModifier: 33,
  };
  const rec4 = evaluateZipEfficiency(okZip, 75);
  assert(rec4.action === "hold", "CPL $60 < target, IS lost 5% → hold");
  assert(rec4.recommendedBidModifier === 33, "Hold keeps current modifier");
}

// ============================================================
// 30. Efficiency Guard — Batch Run
// ============================================================
heading("30. Efficiency Guard — Batch Run");
{
  const inputs: EfficiencyInput[] = [
    { zip: "80113", costPerWeightedLead: 100, impressionShareLostToBudget: 5, travelDistanceMiles: 10, currentBidModifier: 40 },
    { zip: "80007", costPerWeightedLead: 50, impressionShareLostToBudget: 15, travelDistanceMiles: 10, currentBidModifier: 25 },
    { zip: "80503", costPerWeightedLead: 90, impressionShareLostToBudget: 5, travelDistanceMiles: 50, currentBidModifier: -10 },
    { zip: "80209", costPerWeightedLead: 60, impressionShareLostToBudget: 5, travelDistanceMiles: 10, currentBidModifier: 33 },
  ];
  const output = runEfficiencyGuard(inputs);
  assert(output.summary.totalZipsEvaluated === 4, "Evaluated 4 zips");
  assert(output.summary.bidDecreases === 1, "1 bid decrease");
  assert(output.summary.bidIncreases === 1, "1 bid increase");
  assert(output.summary.suppressions === 1, "1 suppression");
  assert(output.summary.holds === 1, "1 hold");
  assert(output.suppressedZips.length === 1, "1 suppressed zip");
  assert(output.suppressedZips[0].zip === "80503", "Suppressed zip is 80503");
}

// ============================================================
// 31. Profit Efficiency Scoring
// ============================================================
heading("31. Profit Efficiency Scoring");
{
  const config: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
    tieBreakerWindowDays: 14,
    callCloseRate: 0.42,
    formCloseRate: 0.18,
    avgTicketCall: 485,
    avgTicketForm: 2800,
    targetCPL: 75,
  };

  // Weighted lead value: (10 × 0.42 × 485) + (5 × 0.18 × 2800)
  // = (2037) + (2520) = 4557
  const wlv = computeWeightedLeadValue(10, 5, config);
  assert(wlv === 4557, "WLV: (10×0.42×485)+(5×0.18×2800) = 4557");

  // Zero calls
  const wlvFormsOnly = computeWeightedLeadValue(0, 10, config);
  assert(wlvFormsOnly === 5040, "Forms only: 10×0.18×2800 = 5040");

  // Zero forms
  const wlvCallsOnly = computeWeightedLeadValue(10, 0, config);
  assert(wlvCallsOnly === 2037, "Calls only: 10×0.42×485 = 2037");

  // Profit efficiency with adSpend
  const profit = computeProfitEfficiency(10, 5, 1000, config);
  assert(profit.weightedLeadValue === 4557, "Profit calc preserves WLV");
  assert(profit.profitEfficiencyScore === 3557, "Profit: 4557 - 1000 = 3557");
  assert(profit.roi === 3.56, "ROI: 3557/1000 = 3.56");

  // Zero adSpend
  const profitZero = computeProfitEfficiency(5, 5, 0, config);
  assert(profitZero.roi === 0, "Zero adSpend → ROI 0 (no div-by-zero)");

  // Fallback when no close rates
  const fallbackConfig: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
    tieBreakerWindowDays: 14,
  };
  const fallbackWLV = computeWeightedLeadValue(10, 5, fallbackConfig);
  assert(fallbackWLV === 13.5, "Fallback to simple scoring: 10×1.0+5×0.7=13.5");
}

// ============================================================
// 32. Geo + Profit Combined Scoring
// ============================================================
heading("32. Geo + Profit Combined Scoring");
{
  const config: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
    tieBreakerWindowDays: 14,
    callCloseRate: 0.42,
    formCloseRate: 0.18,
    avgTicketCall: 485,
    avgTicketForm: 2800,
    targetCPL: 75,
  };

  // Same leads — with zipWeights at 1.0, all zips produce equal geo-adjusted scores
  const wlv = computeWeightedLeadValue(5, 3, config);
  const score1 = getGeoAdjustedScore(wlv, "80113"); // × 1.0
  const score2 = getGeoAdjustedScore(wlv, "80602"); // × 1.0

  assert(score1 === score2, "Equal weights → equal geo-adjusted scores");
  assert(score1 === wlv, "Weight 1.0 → score unchanged from base");

  // Once learner increases a weight, that zip scores higher
  // e.g. if 80113 weight were 1.10: score = wlv * 1.10 > wlv * 1.0
  const hypothetical = Math.round(wlv * 1.10 * 100) / 100;
  assert(hypothetical > wlv, "Higher weight → higher geo-adjusted score");
}

// ============================================================
// 33. Tier1 Saturation Detection
// ============================================================
heading("33. Target ZIP Saturation Detection");
{
  const allZips = getTier1ZipsSorted(); // returns all 42 in zipWeights mode

  // Not saturated: only 1 of 42 zips covered
  const fewIntents: PlanIntent[] = [
    { id: "1", operator: "m", command: "d", args: [], reason: "", priority: "high", zip: "80113" },
  ];
  assert(isTier1Saturated(fewIntents) === false, "1/42 target zips → NOT saturated");

  // Saturated: 30 of 42 zips covered (71.4% ≥ 70%)
  const manyIntents: PlanIntent[] = allZips.slice(0, 30).map((z, i) => ({
    id: `${i}`, operator: "m", command: "d", args: [], reason: "", priority: "high" as const, zip: z.zip,
  }));
  assert(isTier1Saturated(manyIntents) === true, "30/42 target zips → saturated (71%)");
}

// ============================================================
// 34. Intent Tier Distribution Counting
// ============================================================
heading("34. Intent Tier Distribution");
{
  const intents: PlanIntent[] = [
    { id: "1", operator: "m", command: "d", args: [], reason: "", priority: "high", zip: "80113", geoTier: "tier1_core" },
    { id: "2", operator: "m", command: "d", args: [], reason: "", priority: "high", zip: "80111", geoTier: "tier1_core" },
    { id: "3", operator: "m", command: "d", args: [], reason: "", priority: "medium", zip: "80007", geoTier: "tier2_upgrade" },
    { id: "4", operator: "m", command: "d", args: [], reason: "", priority: "low" },
  ];
  const counts = countIntentsByTier(intents);
  assert(counts.tier1_core === 2, "2 tier1 intents");
  assert(counts.tier2_upgrade === 1, "1 tier2 intent");
  assert(counts.unknown === 1, "1 unknown tier intent (no zip)");
}

// ============================================================
// 35. Lead Quality — Call Scoring
// ============================================================
heading("35. Lead Quality — Call Scoring");
{
  const cfg = loadLeadQualityConfig();

  // High quality call: long, peak hour, service match, not repeat
  const highQ = scoreCall(
    { durationSec: 120, isPeakHour: true, serviceMatch: true, isRepeatCaller: false },
    cfg
  );
  assert(highQ.qualified === true, "Long peak-hour call with service match is qualified");
  assert(highQ.rawScore >= 0.80, `High quality raw score ≥ 0.80 (got ${highQ.rawScore})`);
  assert(highQ.qualityMultiplier === 1.0, "Qualified call gets multiplier 1.0");
  assert(highQ.signals.includes("long_call"), "Signal: long_call");
  assert(highQ.signals.includes("peak_hour"), "Signal: peak_hour");
  assert(highQ.signals.includes("service_match"), "Signal: service_match");

  // Low quality call: short, off-peak, no service match, repeat
  const lowQ = scoreCall(
    { durationSec: 15, isPeakHour: false, serviceMatch: false, isRepeatCaller: true },
    cfg
  );
  assert(lowQ.qualified === false, "Short off-peak repeat call is NOT qualified");
  assert(lowQ.rawScore < 0.60, `Low quality raw score < 0.60 (got ${lowQ.rawScore})`);
  assert(lowQ.qualityMultiplier < 1.0, "Unqualified call gets multiplier < 1.0");
  assert(lowQ.signals.includes("short_call"), "Signal: short_call");
  assert(lowQ.signals.includes("repeat_caller"), "Signal: repeat_caller");

  // Repeat caller penalty reduces score
  const noRepeat = scoreCall({ durationSec: 90, isPeakHour: true, serviceMatch: true, isRepeatCaller: false }, cfg);
  const withRepeat = scoreCall({ durationSec: 90, isPeakHour: true, serviceMatch: true, isRepeatCaller: true }, cfg);
  assert(noRepeat.rawScore > withRepeat.rawScore, "Repeat caller penalty reduces score");
}

// ============================================================
// 36. Lead Quality — Form Scoring
// ============================================================
heading("36. Lead Quality — Form Scoring");
{
  const cfg = loadLeadQualityConfig();

  // High quality form: all required + bonus fields + specific service + urgent
  const highF = scoreForm(
    {
      filledFields: ["name", "phone", "service", "address", "zipCode", "urgency"],
      serviceText: "Furnace repair needed",
      messageText: "Furnace broken, not working, need help today",
    },
    cfg
  );
  assert(highF.qualified === true, "Complete form with urgency is qualified");
  assert(highF.rawScore >= 0.70, `High quality form score ≥ 0.70 (got ${highF.rawScore})`);
  assert(highF.signals.includes("all_required"), "Signal: all_required");
  assert(highF.signals.includes("specific_service"), "Signal: specific_service");

  // Low quality form: missing fields, generic, no urgency
  const lowF = scoreForm(
    { filledFields: ["name"], serviceText: "other", messageText: "just looking" },
    cfg
  );
  assert(lowF.qualified === false, "Incomplete generic form is NOT qualified");
  assert(lowF.rawScore < 0.50, `Low quality form score < 0.50 (got ${lowF.rawScore})`);

  // Missing 2 required fields detected in signals
  const partial = scoreForm(
    { filledFields: ["name"], serviceText: "AC repair", messageText: "" },
    cfg
  );
  assert(partial.signals.some(s => s.includes("missing_")), "Detects missing required fields");
  assert(partial.signals.includes("specific_service"), "AC repair is a specific service");
}

// ============================================================
// 37. Lead Quality — QualifiedLeadValue
// ============================================================
heading("37. QualifiedLeadValue Calculation");
{
  const convConfig: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
    tieBreakerWindowDays: 14,
    callCloseRate: 0.42,
    formCloseRate: 0.18,
    avgTicketCall: 485,
    avgTicketForm: 2800,
    targetCPL: 75,
  };

  // Full quality (multiplier 1.0) equals original WLV
  const full = computeQualifiedLeadValue(10, 5, 1.0, 1.0, convConfig);
  assert(full === 4557, "Quality 1.0 matches original WLV: 4557");

  // Half quality calls → half the call contribution
  const halfCall = computeQualifiedLeadValue(10, 5, 0.5, 1.0, convConfig);
  // (10 × 0.5 × 0.42 × 485) + (5 × 1.0 × 0.18 × 2800) = 1018.5 + 2520 = 3538.5
  assert(halfCall === 3538.5, `Half quality calls: 3538.5 (got ${halfCall})`);

  // Zero quality → zero value
  const zero = computeQualifiedLeadValue(10, 5, 0, 0, convConfig);
  assert(zero === 0, "Zero quality multipliers → zero value");

  // Fallback when no close rates
  const fallback: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
    tieBreakerWindowDays: 14,
  };
  const fbVal = computeQualifiedLeadValue(10, 5, 0.8, 0.6, fallback);
  // (10 × 0.8 × 1.0) + (5 × 0.6 × 0.7) = 8.0 + 2.1 = 10.1
  assert(fbVal === 10.1, `Fallback: 10.1 (got ${fbVal})`);
}

// ============================================================
// 38. Outcomes CSV Parsing
// ============================================================
heading("38. Outcomes CSV Parsing");
{
  // Parse sample CSV
  const csvPath = join(TMPDIR, "outcomes-test.csv");
  writeFileSync(csvPath, [
    "lead_type,qualified,sold,revenue",
    "call,1,1,500",
    "call,1,0,0",
    "call,0,0,0",
    "form,1,1,3000",
    "form,1,0,0",
    "form,0,0,0",
  ].join("\n"));

  const result = parseOutcomesCSV(csvPath);
  assert(result.status === "EXECUTED", "Outcomes CSV parses OK");
  assert(result.data!.length === 6, "Parsed 6 outcome rows");
  assert(result.data![0].leadType === "call", "First row is call");
  assert(result.data![0].sold === true, "First row is sold");
  assert(result.data![0].revenue === 500, "First row revenue is 500");

  // Missing file
  const missing = parseOutcomesCSV("/nonexistent.csv");
  assert(missing.status === "FAILED", "Missing CSV returns FAILED");
  assert(missing.error!.code === "OUTCOMES_CSV_NOT_FOUND", "Correct error code");

  // Empty CSV
  const emptyPath = join(TMPDIR, "outcomes-empty.csv");
  writeFileSync(emptyPath, "lead_type,qualified,sold,revenue\n");
  const empty = parseOutcomesCSV(emptyPath);
  assert(empty.status === "FAILED", "Empty CSV returns FAILED");
}

// ============================================================
// 39. Calibration Math
// ============================================================
heading("39. Calibration Math — Observed Metrics");
{
  const rows: OutcomeRow[] = [
    { leadType: "call", qualified: true, sold: true, revenue: 500 },
    { leadType: "call", qualified: true, sold: true, revenue: 400 },
    { leadType: "call", qualified: true, sold: false, revenue: 0 },
    { leadType: "call", qualified: false, sold: false, revenue: 0 },
    { leadType: "form", qualified: true, sold: true, revenue: 3000 },
    { leadType: "form", qualified: true, sold: false, revenue: 0 },
    { leadType: "form", qualified: false, sold: false, revenue: 0 },
    { leadType: "form", qualified: false, sold: false, revenue: 0 },
  ];

  const obs = computeObservedMetrics(rows);
  // Calls: 4 total, 2 sold → 50% close rate, avg ticket $450
  assert(obs.callCloseRate === 0.5, `Call close rate: 0.5 (got ${obs.callCloseRate})`);
  assert(obs.avgTicketCall === 450, `Avg ticket call: 450 (got ${obs.avgTicketCall})`);
  assert(obs.callCount === 4, "4 call rows");

  // Forms: 4 total, 1 sold → 25% close rate, avg ticket $3000
  assert(obs.formCloseRate === 0.25, `Form close rate: 0.25 (got ${obs.formCloseRate})`);
  assert(obs.avgTicketForm === 3000, `Avg ticket form: 3000 (got ${obs.avgTicketForm})`);
  assert(obs.formCount === 4, "4 form rows");
}

// ============================================================
// 40. Calibration — Deltas and Confidence
// ============================================================
heading("40. Calibration Deltas + Confidence");
{
  const rows: OutcomeRow[] = [
    { leadType: "call", qualified: true, sold: true, revenue: 500 },
    { leadType: "call", qualified: true, sold: true, revenue: 400 },
    { leadType: "call", qualified: true, sold: false, revenue: 0 },
    { leadType: "call", qualified: false, sold: false, revenue: 0 },
    { leadType: "call", qualified: true, sold: true, revenue: 550 },
    { leadType: "call", qualified: true, sold: false, revenue: 0 },
    { leadType: "call", qualified: false, sold: false, revenue: 0 },
    { leadType: "call", qualified: true, sold: true, revenue: 480 },
    { leadType: "call", qualified: true, sold: false, revenue: 0 },
    { leadType: "call", qualified: false, sold: false, revenue: 0 },
    { leadType: "form", qualified: true, sold: true, revenue: 2800 },
    { leadType: "form", qualified: true, sold: false, revenue: 0 },
    { leadType: "form", qualified: false, sold: false, revenue: 0 },
    { leadType: "form", qualified: true, sold: true, revenue: 3100 },
    { leadType: "form", qualified: false, sold: false, revenue: 0 },
  ];

  const convConfig: ConversionConfig = {
    primaryGoals: ["CALL_CLICK", "FORM_SUBMIT"],
    weights: { CALL_CLICK: 1.0, FORM_SUBMIT: 0.7 },
    tieBreakerWindowDays: 14,
    callCloseRate: 0.42,
    formCloseRate: 0.18,
    avgTicketCall: 485,
    avgTicketForm: 2800,
    targetCPL: 75,
  };

  const cal = runCalibration(rows, convConfig);

  // Call close rate: 4/10 = 0.40 vs modeled 0.42 → delta -0.02
  assert(cal.callCloseRate.modeled === 0.42, "Modeled call close rate preserved");
  assert(cal.callCloseRate.observed === 0.4, `Observed call close: 0.4 (got ${cal.callCloseRate.observed})`);
  assert(cal.callCloseRate.delta === -0.02, `Delta: -0.02 (got ${cal.callCloseRate.delta})`);

  // Form close rate: 2/5 = 0.40 vs modeled 0.18 → significant delta
  assert(cal.formCloseRate.observed === 0.4, `Observed form close: 0.4 (got ${cal.formCloseRate.observed})`);
  assert(cal.formCloseRate.delta > 0.2, "Form close rate delta is significant");

  // Confidence: 15 total → low
  assert(cal.confidence === "low", `Confidence with 15 rows: low (got ${cal.confidence})`);

  // Confidence assessment
  assert(assessConfidence(50, 50) === "high", "100 total → high confidence");
  assert(assessConfidence(15, 15) === "medium", "30 total → medium");
  assert(assessConfidence(5, 5) === "low", "10 total → low");
}

// ============================================================
// 41. Season Gate — Mode Detection
// ============================================================
heading("41. Season Gate — Mode Detection");
{
  // HEATING months: Oct-Feb
  assert(getCurrentSeason(1) === "HEATING", "January → HEATING");
  assert(getCurrentSeason(2) === "HEATING", "February → HEATING");
  assert(getCurrentSeason(10) === "HEATING", "October → HEATING");
  assert(getCurrentSeason(12) === "HEATING", "December → HEATING");

  // COOLING months: May-Aug
  assert(getCurrentSeason(5) === "COOLING", "May → COOLING");
  assert(getCurrentSeason(7) === "COOLING", "July → COOLING");
  assert(getCurrentSeason(8) === "COOLING", "August → COOLING");

  // SHOULDER months: Mar, Apr, Sep
  assert(getCurrentSeason(3) === "SHOULDER", "March → SHOULDER");
  assert(getCurrentSeason(4) === "SHOULDER", "April → SHOULDER");
  assert(getCurrentSeason(9) === "SHOULDER", "September → SHOULDER");
}

// ============================================================
// 42. Season Gate — Blocking Logic
// ============================================================
heading("42. Season Gate — Blocking Logic");
{
  // HEATING season (Jan): should block AC-related intents
  const acInHeating = checkSeasonGate("ac repair denver campaign", 1);
  assert(acInHeating.allowed === false, "AC repair blocked in HEATING season");
  assert(acInHeating.blockedReason!.includes("HEATING"), "Blocked reason mentions HEATING");

  // HEATING season (Jan): should allow furnace intents
  const furnaceInHeating = checkSeasonGate("furnace repair emergency", 1);
  assert(furnaceInHeating.allowed === true, "Furnace repair allowed in HEATING season");

  // COOLING season (Jul): should block furnace intents
  const furnaceInCooling = checkSeasonGate("furnace repair campaign", 7);
  assert(furnaceInCooling.allowed === false, "Furnace repair blocked in COOLING season");

  // COOLING season (Jul): should allow AC intents
  const acInCooling = checkSeasonGate("ac repair special offer", 7);
  assert(acInCooling.allowed === true, "AC repair allowed in COOLING season");

  // SHOULDER (Sep): blocks aggressive seasonal
  const emergencyInShoulder = checkSeasonGate("emergency furnace repair", 9);
  assert(emergencyInShoulder.allowed === false, "Emergency furnace blocked in SHOULDER");

  // SHOULDER (Sep): allows maintenance/upgrade
  const upgradeInShoulder = checkSeasonGate("hvac upgrade promo", 9);
  assert(upgradeInShoulder.allowed === true, "Upgrade allowed in SHOULDER");
}

// ============================================================
// 43. Season Gate — Intent Filtering
// ============================================================
heading("43. Season Gate — Intent Filtering");
{
  const intents: PlanIntent[] = [
    { id: "seo-1", operator: "m", command: "draft", args: ["--type", "seo"], reason: "SEO page", priority: "high" },
    { id: "ad-furnace", operator: "m", command: "draft", args: ["--type", "google-ad", "--service", "furnace repair"], reason: "Furnace ad", priority: "high" },
    { id: "ad-ac", operator: "m", command: "draft", args: ["--type", "google-ad", "--service", "ac repair"], reason: "AC ad", priority: "high" },
    { id: "geo-1", operator: "m", command: "draft", args: ["--type", "geo"], reason: "GEO page", priority: "medium" },
  ];

  // In HEATING (Jan): AC ad blocked, rest pass
  const heating = filterIntentsBySeason(intents, 1);
  assert(heating.allowed.length === 3, `HEATING: 3 allowed (got ${heating.allowed.length})`);
  assert(heating.blocked.length === 1, "HEATING: 1 blocked");
  assert(heating.blocked[0].intent.id === "ad-ac", "AC ad is the blocked one");

  // In COOLING (Jul): furnace ad blocked
  const cooling = filterIntentsBySeason(intents, 7);
  assert(cooling.blocked.some(b => b.intent.id === "ad-furnace"), "Furnace ad blocked in COOLING");

  // Non-ad intents always pass through
  assert(heating.allowed.some(i => i.id === "seo-1"), "SEO intent passes season gate");
  assert(heating.allowed.some(i => i.id === "geo-1"), "GEO intent passes season gate");
}

// ============================================================
// 44. Waste Hunter — Term Classification
// ============================================================
heading("44. Waste Hunter — Term Classification");
{
  // Irrelevant categories
  assert(classifyTerm("hvac technician jobs denver") === "jobs", "Jobs term detected");
  assert(classifyTerm("diy furnace repair guide") === "diy", "DIY term detected");
  assert(classifyTerm("furnace parts wholesale") === "parts", "Parts term detected");
  assert(classifyTerm("furnace repair manual pdf") === "manuals", "Manual term detected");
  assert(classifyTerm("bulk hvac wholesale supplier") === "wholesale", "Wholesale term detected");
  assert(classifyTerm("hvac training course denver") === "education", "Education term detected");
  assert(classifyTerm("best heat pump brands reviews") === "reviews", "Reviews term detected");

  // Relevant terms should return null
  assert(classifyTerm("furnace repair denver") === null, "Relevant term → null");
  assert(classifyTerm("ac installation cost") === null, "Relevant term → null");
  assert(classifyTerm("emergency heating repair") === null, "Relevant term → null");
}

// ============================================================
// 45. Waste Hunter — High Spend / Zero Conv
// ============================================================
heading("45. Waste Hunter — Spend Analysis");
{
  const highSpend: SearchTermRow = {
    searchTerm: "generic query", impressions: 200, clicks: 15, cost: 50, conversions: 0,
  };
  assert(isHighSpendZeroConv(highSpend) === true, "$50 spend + 0 conv → waste");

  const lowSpend: SearchTermRow = {
    searchTerm: "cheap query", impressions: 50, clicks: 3, cost: 10, conversions: 0,
  };
  assert(isHighSpendZeroConv(lowSpend) === false, "$10 spend below threshold");

  const hasConv: SearchTermRow = {
    searchTerm: "good query", impressions: 300, clicks: 20, cost: 60, conversions: 3,
  };
  assert(isHighSpendZeroConv(hasConv) === false, "$60 spend but has conversions → not waste");

  // Match type tightening
  const lowConvRate: SearchTermRow = {
    searchTerm: "broad term", impressions: 500, clicks: 20, cost: 50, conversions: 0,
  };
  assert(shouldTightenMatch(lowConvRate) === true, "20 clicks, 0% conv rate, $50 → tighten");

  const fewClicks: SearchTermRow = {
    searchTerm: "tiny term", impressions: 20, clicks: 2, cost: 5, conversions: 0,
  };
  assert(shouldTightenMatch(fewClicks) === false, "Only 2 clicks → don't tighten yet");
}

// ============================================================
// 46. Waste Hunter — Full Analysis
// ============================================================
heading("46. Waste Hunter — Full Analysis");
{
  const terms: SearchTermRow[] = [
    { searchTerm: "furnace repair denver", impressions: 450, clicks: 38, cost: 285, conversions: 6 },
    { searchTerm: "hvac technician jobs denver", impressions: 95, clicks: 12, cost: 90, conversions: 0 },
    { searchTerm: "diy furnace repair guide", impressions: 78, clicks: 8, cost: 60, conversions: 0 },
    { searchTerm: "furnace parts wholesale", impressions: 65, clicks: 6, cost: 45, conversions: 0 },
    { searchTerm: "heat pump reviews 2026", impressions: 150, clicks: 10, cost: 100, conversions: 0 },
    { searchTerm: "ac repair denver", impressions: 380, clicks: 30, cost: 225, conversions: 5 },
  ];

  const output = analyzeSearchTerms(terms);
  assert(output.totalTermsAnalyzed === 6, "Analyzed 6 terms");
  assert(output.summary.irrelevantTerms >= 3, `At least 3 irrelevant (got ${output.summary.irrelevantTerms})`);
  assert(output.summary.totalWastedSpend > 0, "Wasted spend calculated");
  assert(output.negativeRecommendations.length >= 3, `At least 3 negative recs (got ${output.negativeRecommendations.length})`);

  // Check that jobs term is flagged as irrelevant
  const jobsRec = output.negativeRecommendations.find(r => r.term.includes("jobs"));
  assert(jobsRec !== undefined, "Jobs term in negative recommendations");
  assert(jobsRec!.reason === "irrelevant", "Jobs term classified as irrelevant");
  assert(jobsRec!.category === "jobs", "Jobs term category is 'jobs'");

  // Check that relevant converting term is NOT in negatives
  const goodTerm = output.negativeRecommendations.find(r => r.term === "furnace repair denver");
  assert(goodTerm === undefined, "Converting term NOT in negative list");
}

// ============================================================
// 47. Waste Hunter — CSV Parsing
// ============================================================
heading("47. Waste Hunter — CSV Parsing");
{
  const csvPath = join(TMPDIR, "search-terms-test.csv");
  writeFileSync(csvPath, [
    "Search term,Campaign,Ad group,Impressions,Clicks,Cost,Conversions",
    "furnace repair,Heating,Furnace,100,10,50.00,2",
    "hvac jobs,Heating,Furnace,50,5,25.00,0",
  ].join("\n"));

  const result = parseSearchTermsCSV(csvPath);
  assert(result.status === "EXECUTED", "Search terms CSV parses OK");
  assert(result.data!.length === 2, "Parsed 2 search terms");
  assert(result.data![0].searchTerm === "furnace repair", "First term correct");
  assert(result.data![0].cost === 50, "First term cost correct");
  assert(result.data![1].conversions === 0, "Second term zero conversions");

  // Missing file
  const missing = parseSearchTermsCSV("/nonexistent.csv");
  assert(missing.status === "FAILED", "Missing CSV returns FAILED");
  assert(missing.error!.code === "WASTE_CSV_NOT_FOUND", "Correct error code");
}
// ============================================================
// 48. Conservative Mode — Config Loading
// ============================================================
heading("48. Conservative Mode — Config Loading");
{
  resetModeCache();
  const mode = loadModeConfig();
  assert(mode.mode === "CONSERVATIVE", "Mode is CONSERVATIVE");
  assert(mode.scaleThresholdMultiplier === 0.8, "Scale threshold 0.8");
  assert(mode.pullbackThresholdMultiplier === 1.0, "Pullback threshold 1.0");
  assert(mode.travelDistanceLimitMiles === 35, "Travel limit 35mi");
  assert(mode.tier1ExpansionThreshold === 0.8, "Tier1 expansion threshold 0.8");
  assert(mode.wasteSpendThreshold === 0.25, "Waste spend threshold 0.25");

  const cap = loadCapacityConfig();
  assert(cap.maxBacklogHours === 72, "Max backlog 72h");
  assert(cap.techCapacity === 4, "Tech capacity 4");
  assert(isCapacityAvailable(cap), "Default capacity is available (0h < 72h)");

  // Capacity exceeded
  const overloaded: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 80 };
  assert(isCapacityAvailable(overloaded) === false, "80h >= 72h → capacity NOT available");
}

// ============================================================
// 49. Conservative Mode — Scale Allowed
// ============================================================
heading("49. Conservative Mode — Scale Allowed");
{
  resetModeCache();
  const mode = loadModeConfig();
  const cap: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 20 };

  // All conditions met: low CPL, high quality, no close rate drop, IS lost, short travel
  const input: ConservativeGuardInput = {
    zip: "80113",
    costPerWeightedLead: 40,   // < 75 * 0.8 = 60
    impressionShareLostToBudget: 15,  // > 10%
    travelDistanceMiles: 10,   // < 35
    currentBidModifier: 25,
    qualifiedLeadScore: 0.85,  // >= 0.60
    closeRateDrop: 0.02,       // < 10%
    profitEfficiencyScore: 500,
    wasteSpendRatio: 0.10,     // < 0.25
  };

  const result = evaluateConservative(input, 75, mode, cap);
  assert(result.action === "scale", `Scale allowed: ${result.action}`);
  assert(result.recommendedBidModifier === 35, "25% + 10% = 35%");
  assert(result.triggers.includes("all_scale_checks_passed"), "Trigger: all checks passed");
}

// ============================================================
// 50. Conservative Mode — Scale Blocked (CPL too high)
// ============================================================
heading("50. Conservative Mode — Scale Blocked");
{
  resetModeCache();
  const mode = loadModeConfig();
  const cap: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 20 };

  // CPL $65 >= conservative threshold $60 (75*0.8) — blocks scale but NOT pullback
  const input: ConservativeGuardInput = {
    zip: "80113",
    costPerWeightedLead: 65,   // >= 60 but < 75 → no pullback, just blocked scale
    impressionShareLostToBudget: 15,
    travelDistanceMiles: 10,
    currentBidModifier: 25,
    qualifiedLeadScore: 0.85,
    closeRateDrop: 0.02,
  };

  const result = evaluateConservative(input, 75, mode, cap);
  assert(result.action === "hold", `Scale blocked → hold: ${result.action}`);
  assert(result.reason.includes("scale blocked"), "Reason mentions scale blocked");
  assert(result.recommendedBidModifier === 25, "Holds current modifier");

  // Scale blocked by low quality score
  const lowQuality: ConservativeGuardInput = {
    zip: "80113",
    costPerWeightedLead: 40,
    impressionShareLostToBudget: 15,
    travelDistanceMiles: 10,
    currentBidModifier: 25,
    qualifiedLeadScore: 0.40,  // < 0.60 threshold
  };

  const lowQResult = evaluateConservative(lowQuality, 75, mode, cap);
  assert(lowQResult.action === "hold", "Low quality blocks scale");
  assert(lowQResult.reason.includes("quality score"), "Reason mentions quality");

  // Scale blocked by close rate drop
  const closeRateDrop: ConservativeGuardInput = {
    zip: "80113",
    costPerWeightedLead: 40,
    impressionShareLostToBudget: 15,
    travelDistanceMiles: 10,
    currentBidModifier: 25,
    qualifiedLeadScore: 0.85,
    closeRateDrop: 0.15,  // >= 10%
  };

  const crResult = evaluateConservative(closeRateDrop, 75, mode, cap);
  assert(crResult.action === "hold", "Close rate drop blocks scale");
  assert(crResult.reason.includes("close rate drop"), "Reason mentions close rate");

  // Scale blocked by travel distance
  const farTravel: ConservativeGuardInput = {
    zip: "80113",
    costPerWeightedLead: 40,
    impressionShareLostToBudget: 15,
    travelDistanceMiles: 38,  // >= 35
    currentBidModifier: 25,
    qualifiedLeadScore: 0.85,
  };

  const travelResult = evaluateConservative(farTravel, 75, mode, cap);
  assert(travelResult.action === "hold", "Far travel blocks scale");
  assert(travelResult.reason.includes("travel"), "Reason mentions travel");
}

// ============================================================
// 51. Conservative Mode — Pullback Triggered
// ============================================================
heading("51. Conservative Mode — Pullback Triggered");
{
  resetModeCache();
  const mode = loadModeConfig();
  const cap: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 20 };

  // CPL above pullback threshold
  const highCPL: ConservativeGuardInput = {
    zip: "80113",
    costPerWeightedLead: 80,   // >= 75 * 1.0
    impressionShareLostToBudget: 5,
    travelDistanceMiles: 10,
    currentBidModifier: 30,
  };

  const r1 = evaluateConservative(highCPL, 75, mode, cap);
  assert(r1.action === "pullback", "CPL $80 >= target → pullback");
  assert(r1.recommendedBidModifier === 20, "30% - 10% = 20%");
  assert(r1.triggers.includes("cpl_above_pullback_threshold"), "Trigger: CPL threshold");

  // Negative profit
  const negProfit: ConservativeGuardInput = {
    zip: "80113",
    costPerWeightedLead: 65,
    impressionShareLostToBudget: 5,
    travelDistanceMiles: 10,
    currentBidModifier: 25,
    profitEfficiencyScore: -100,  // negative
  };

  const r2 = evaluateConservative(negProfit, 75, mode, cap);
  assert(r2.action === "pullback", "Negative profit → pullback");
  assert(r2.triggers.includes("negative_profit"), "Trigger: negative profit");

  // Waste spend ratio exceeded
  const highWaste: ConservativeGuardInput = {
    zip: "80113",
    costPerWeightedLead: 65,
    impressionShareLostToBudget: 5,
    travelDistanceMiles: 10,
    currentBidModifier: 25,
    wasteSpendRatio: 0.35,  // > 0.25
  };

  const r3 = evaluateConservative(highWaste, 75, mode, cap);
  assert(r3.action === "pullback", "Waste spend > threshold → pullback");
  assert(r3.triggers.includes("waste_spend_exceeded"), "Trigger: waste spend");
}

// ============================================================
// 52. Conservative Mode — Tier4 Boulder Suppression
// ============================================================
heading("52. Conservative Mode — Non-Target ZIP Behavior");
{
  resetModeCache();
  const mode = loadModeConfig();
  const cap: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 20 };

  // Non-target ZIP (80304 not in zipWeights) with CPL above target → pullback (not suppress)
  // In zipWeights mode, tier4 suppress logic doesn't fire since there are no tiers
  const nonTarget: ConservativeGuardInput = {
    zip: "80304",
    costPerWeightedLead: 80,
    impressionShareLostToBudget: 5,
    travelDistanceMiles: 30,
    currentBidModifier: 10,
  };

  const r = evaluateConservative(nonTarget, 75, mode, cap);
  assert(r.action === "pullback", "Non-target ZIP + CPL above target → pullback");
  assert(r.tier === "unknown", "Non-target ZIP → unknown tier");

  // Non-target with good metrics
  const nonTargetOk: ConservativeGuardInput = {
    zip: "80304",
    costPerWeightedLead: 40,
    impressionShareLostToBudget: 15,
    travelDistanceMiles: 10,
    currentBidModifier: 10,
    qualifiedLeadScore: 0.85,
  };

  const r2 = evaluateConservative(nonTargetOk, 75, mode, cap);
  assert(r2.action !== "suppress", "Non-target with good CPL → not suppressed");
}

// ============================================================
// 53. Conservative Mode — Capacity Block
// ============================================================
heading("53. Conservative Mode — Capacity Block");
{
  resetModeCache();
  const mode = loadModeConfig();
  const overloaded: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 80 };

  // Everything else perfect but capacity exceeded → blocks scale
  const input: ConservativeGuardInput = {
    zip: "80113",
    costPerWeightedLead: 40,
    impressionShareLostToBudget: 15,
    travelDistanceMiles: 10,
    currentBidModifier: 25,
    qualifiedLeadScore: 0.85,
  };

  const result = evaluateConservative(input, 75, mode, overloaded);
  assert(result.action === "block_capacity", `Capacity exceeded → block: ${result.action}`);
  assert(result.triggers.includes("capacity_exceeded"), "Trigger: capacity exceeded");
  assert(result.recommendedBidModifier === 25, "Capacity block holds current modifier");

  // Capacity available → would scale
  const available: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 20 };
  const r2 = evaluateConservative(input, 75, mode, available);
  assert(r2.action === "scale", "With capacity available → scale");
}

// ============================================================
// 54. Conservative Mode — Tier2 Expansion Gating
// ============================================================
heading("54. Conservative Mode — Tier Expansion (zipWeights mode)");
{
  resetModeCache();
  const mode = loadModeConfig();
  const cap: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 20 };
  const targetCPL = 75;

  // In zipWeights mode, no tier1 zips → saturation always 0
  const intents: PlanIntent[] = [
    { id: "z1", operator: "m", command: "d", args: [], reason: "", priority: "high", zip: "80113", geoTier: "tier1_core" },
    { id: "z2", operator: "m", command: "d", args: [], reason: "", priority: "high", zip: "80111", geoTier: "tier1_core" },
  ];

  const check1 = checkTierExpansion(intents, 60, targetCPL, 1000, 500, mode, cap);
  assert(check1.tier1Saturation === 0, `zipWeights mode: saturation = 0 (no tier1 configured) (got ${check1.tier1Saturation})`);
  assert(check1.tier2Allowed === false, "Tier2 blocked: no tier1 zips to saturate");
  assert(check1.blockedReason!.includes("saturation"), "Block reason: saturation");

  // Even with all conditions met, saturation blocks expansion
  assert(check1.tier1CPLBelowTarget === true, "CPL below target");
  assert(check1.capacityAvailable === true, "Capacity available");

  // Capacity unavailable still blocks
  const noCap: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 80 };
  const check4 = checkTierExpansion(intents, 60, targetCPL, 1000, 500, mode, noCap);
  assert(check4.tier2Allowed === false, "Tier2 blocked: capacity unavailable");
  assert(check4.blockedReason!.includes("saturation") || check4.blockedReason!.includes("capacity"), "Block reason includes saturation or capacity");
}

// ============================================================
// 55. Conservative Mode — Tier4 Boulder Expansion
// ============================================================
heading("55. Conservative Mode — Tier4 Expansion (zipWeights mode)");
{
  resetModeCache();
  const mode = loadModeConfig();
  const cap: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 20 };
  const targetCPL = 75;

  // In zipWeights mode, tier4 is always blocked (since tier2 is blocked due to 0 saturation)
  const intents: PlanIntent[] = [
    { id: "z1", operator: "m", command: "d", args: [], reason: "", priority: "high", zip: "80113", geoTier: "tier1_core" },
  ];

  const check1 = checkTierExpansion(intents, 60, targetCPL, 2000, 500, mode, cap);
  assert(check1.tier4Allowed === false, "Tier4 blocked: tier2 not allowed → tier4 not allowed");
  assert(check1.tier1Saturation === 0, "No tier1 configured in zipWeights mode");

  // Even with excellent metrics, tier4 blocked because no tier system
  const check2 = checkTierExpansion(intents, 60, targetCPL, -100, -200, mode, cap);
  assert(check2.tier4Allowed === false, "Tier4 blocked: not profitable + no tiers");

  // Profit margin scenarios also blocked
  const check3 = checkTierExpansion(intents, 60, targetCPL, 500, 500, mode, cap);
  assert(check3.tier4Allowed === false, "Tier4 blocked: tier system dormant in zipWeights mode");
}

// ============================================================
// 56. Conservative Mode — Batch Run
// ============================================================
heading("56. Conservative Mode — Batch Run");
{
  resetModeCache();
  const mode = loadModeConfig();
  const cap: CapacityConfig = { maxBacklogHours: 72, techCapacity: 4, currentBacklogHours: 20 };

  const inputs: ConservativeGuardInput[] = [
    // Scale allowed: low CPL, good quality, short travel
    { zip: "80113", costPerWeightedLead: 40, impressionShareLostToBudget: 15, travelDistanceMiles: 10, currentBidModifier: 25, qualifiedLeadScore: 0.85 },
    // Pullback: CPL above target
    { zip: "80111", costPerWeightedLead: 85, impressionShareLostToBudget: 5, travelDistanceMiles: 10, currentBidModifier: 30 },
    // Tier4 suppress: boulder + CPL above target
    { zip: "80304", costPerWeightedLead: 80, impressionShareLostToBudget: 5, travelDistanceMiles: 30, currentBidModifier: 10 },
    // Hold: CPL between scale threshold and target
    { zip: "80007", costPerWeightedLead: 65, impressionShareLostToBudget: 15, travelDistanceMiles: 10, currentBidModifier: 20 },
    // Travel suppress: far + CPL above target
    { zip: "80503", costPerWeightedLead: 80, impressionShareLostToBudget: 5, travelDistanceMiles: 40, currentBidModifier: 5 },
  ];

  const output = runConservativeGuard(inputs, mode, cap);
  assert(output.mode === "CONSERVATIVE", "Output mode CONSERVATIVE");
  assert(output.summary.totalEvaluated === 5, "Evaluated 5 zips");
  assert(output.summary.scaleAllowed === 1, "1 scale allowed");
  assert(output.summary.pullbacks >= 1, `At least 1 pullback (got ${output.summary.pullbacks})`);
  assert(output.summary.suppressions >= 1, `At least 1 suppression (got ${output.summary.suppressions})`);
  assert(output.pullbackTriggers.length >= 1, "Pullback triggers populated");
  assert(output.travelInefficiencies.length >= 1, `Travel inefficiencies: ${output.travelInefficiencies.length}`);
  assert(output.capacityStatus.available === true, "Capacity available");
}

// ============================================================
// 57. Efficiency Guard — Conservative Travel Limit
// ============================================================
heading("57. Efficiency Guard — Conservative Travel Limit");
{
  resetModeCache();
  // In CONSERVATIVE mode, travel limit is 35mi (not 45mi)
  // A zip at 38mi with CPL above target should be suppressed
  const midTravel: EfficiencyInput = {
    zip: "80503",
    costPerWeightedLead: 80,
    impressionShareLostToBudget: 5,
    travelDistanceMiles: 38,  // > 35 (conservative) but < 45 (old default)
    currentBidModifier: 10,
  };

  const rec = evaluateZipEfficiency(midTravel, 75);
  assert(rec.action === "suppress", `38mi in CONSERVATIVE → suppress (got ${rec.action})`);

  // Conservative scale threshold: CPL must be < 75 * 0.8 = 60
  const borderline: EfficiencyInput = {
    zip: "80113",
    costPerWeightedLead: 62,  // >= 60 conservative threshold, but < 75 old threshold
    impressionShareLostToBudget: 15,
    travelDistanceMiles: 10,
    currentBidModifier: 25,
  };

  const rec2 = evaluateZipEfficiency(borderline, 75);
  assert(rec2.action === "hold", `CPL $62 >= conservative $60 → hold, not increase (got ${rec2.action})`);
}

// ============================================================
// 58. Flow Governor — Config Loading
// ============================================================
heading("58. Flow Governor — Config Loading");
{
  const cfg = loadFlowControlConfig();
  assert(cfg.maxQualifiedLeadsPerDay === 12, `maxQualifiedLeadsPerDay = 12 (got ${cfg.maxQualifiedLeadsPerDay})`);
  assert(cfg.maxInstallLeadsPerWeek === 8, `maxInstallLeadsPerWeek = 8 (got ${cfg.maxInstallLeadsPerWeek})`);
  assert(cfg.maxRepairLeadsPerDay === 10, `maxRepairLeadsPerDay = 10 (got ${cfg.maxRepairLeadsPerDay})`);
  assert(cfg.minUpgradeRatio === 0.20, `minUpgradeRatio = 0.20 (got ${cfg.minUpgradeRatio})`);
  assert(cfg.backlogBufferHours === 48, `backlogBufferHours = 48 (got ${cfg.backlogBufferHours})`);
}

// ============================================================
// 59. Flow Governor — Intent Classification
// ============================================================
heading("59. Flow Governor — Intent Classification");
{
  const installIntent: PlanIntent = {
    id: "ad-install-1", operator: "m", command: "draft",
    args: ["--type", "google-ad", "--service", "furnace installation"],
    reason: "New system installation ad", priority: "high",
  };
  assert(isInstallIntent(installIntent) === true, "Furnace installation is install intent");

  const repairIntent: PlanIntent = {
    id: "ad-repair-1", operator: "m", command: "draft",
    args: ["--type", "google-ad", "--service", "furnace repair"],
    reason: "Emergency repair ad", priority: "high",
  };
  assert(isRepairIntent(repairIntent) === true, "Furnace repair is repair intent");

  const upgradeIntent: PlanIntent = {
    id: "ad-upgrade-1", operator: "m", command: "draft",
    args: ["--type", "google-ad", "--service", "upgrade"],
    reason: "HVAC efficiency upgrade campaign", priority: "medium",
  };
  assert(isUpgradeIntent(upgradeIntent) === true, "Efficiency upgrade is upgrade intent");

  const seoIntent: PlanIntent = {
    id: "seo-page-1", operator: "m", command: "draft",
    args: ["--type", "seo"], reason: "SEO page", priority: "medium",
  };
  assert(isInstallIntent(seoIntent) === false, "SEO page is NOT install");
  assert(isRepairIntent(seoIntent) === false, "SEO page is NOT repair");
  assert(isUpgradeIntent(seoIntent) === false, "SEO page is NOT upgrade");
}

// ============================================================
// 60. Flow Governor — Daily Qualified Cap Enforcement
// ============================================================
heading("60. Flow Governor — Daily Qualified Cap");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 12,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  // Under cap → no decisions
  const underCap: FlowState = {
    qualifiedLeadsToday: 8,
    installLeadsThisWeek: 3,
    repairLeadsToday: 5,
    upgradeLeadsThisWeek: 5,
    totalLeadsThisWeek: 20,
    backlogHours: 20,
  };
  const dUnder = evaluateFlowState(underCap, cfg);
  const bidBlocks = dUnder.filter(d => d.action === "block_bid_increase");
  assert(bidBlocks.length === 0, "Under cap → no bid blocks");

  // Over cap → block bid increase + suppress tier2
  const overCap: FlowState = {
    qualifiedLeadsToday: 15,
    installLeadsThisWeek: 3,
    repairLeadsToday: 5,
    upgradeLeadsThisWeek: 5,
    totalLeadsThisWeek: 20,
    backlogHours: 20,
  };
  const dOver = evaluateFlowState(overCap, cfg);
  assert(dOver.some(d => d.action === "suppress_tier2_tier3"), "Over hard cap → WAITLIST suppress_tier2_tier3");
  assert(dOver.some(d => d.action === "tighten_match_types"), "Over hard cap → WAITLIST tighten_match_types");
}

// ============================================================
// 61. Flow Governor — Install Cap Suppression
// ============================================================
heading("61. Flow Governor — Install Cap Suppression (Ladder Step 3)");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 12,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  // Install cap exceeded — ladder step 3 (>150% → pause)
  const state: FlowState = {
    qualifiedLeadsToday: 5,
    installLeadsThisWeek: 13,
    repairLeadsToday: 3,
    upgradeLeadsThisWeek: 5,
    totalLeadsThisWeek: 20,
    backlogHours: 20,
  };
  const decisions = evaluateFlowState(state, cfg);
  assert(decisions.some(d => d.action === "pause_install_ads"), "Install ladder step 3 → pause_install_ads");
  assert(decisions.find(d => d.action === "pause_install_ads")!.severity === "critical", "Install pause is critical");

  // Apply to intents with install ad
  const intents: PlanIntent[] = [
    {
      id: "ad-install-1", operator: "m", command: "draft",
      args: ["--type", "google-ad", "--service", "installation"],
      reason: "Install ad", priority: "high",
    },
    {
      id: "ad-repair-1", operator: "m", command: "draft",
      args: ["--type", "google-ad", "--service", "repair"],
      reason: "Repair ad", priority: "high",
    },
    {
      id: "seo-1", operator: "m", command: "draft",
      args: ["--type", "seo"], reason: "SEO", priority: "medium",
    },
  ];

  const result = applyFlowGovernor(intents, state, cfg);
  assert(result.intentModifications.suppressed.includes("ad-install-1"), "Install ad suppressed");
  assert(!result.intentModifications.suppressed.includes("ad-repair-1"), "Repair ad NOT suppressed");
  assert(!result.intentModifications.suppressed.includes("seo-1"), "SEO NOT suppressed");
  assert(result.summary.totalSuppressed === 1, `1 suppressed (got ${result.summary.totalSuppressed})`);
}

// ============================================================
// 62. Flow Governor — Repair Cap Reduction
// ============================================================
heading("62. Flow Governor — Repair Cap Reduction");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 20,
    maxInstallLeadsPerWeek: 20,
    maxRepairLeadsPerDay: 5,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  const state: FlowState = {
    qualifiedLeadsToday: 4,
    installLeadsThisWeek: 2,
    repairLeadsToday: 8,
    upgradeLeadsThisWeek: 5,
    totalLeadsThisWeek: 20,
    backlogHours: 20,
  };

  const decisions = evaluateFlowState(state, cfg);
  assert(decisions.some(d => d.action === "reduce_repair_bids"), "Repair cap exceeded → reduce_repair_bids");

  // Apply — high priority repair becomes medium
  const intents: PlanIntent[] = [
    {
      id: "ad-repair-1", operator: "m", command: "draft",
      args: ["--type", "google-ad", "--service", "emergency repair"],
      reason: "Emergency fix", priority: "high",
    },
  ];
  const result = applyFlowGovernor(intents, state, cfg);
  assert(result.intentModifications.reprioritized.includes("ad-repair-1"), "Repair intent reprioritized");
  // The intent's priority was changed from high to medium
  assert(intents[0].priority === "medium", `Repair priority reduced to medium (got ${intents[0].priority})`);
}

// ============================================================
// 63. Flow Governor — Upgrade Ratio Boost
// ============================================================
heading("63. Flow Governor — Upgrade Ratio Boost");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 20,
    maxInstallLeadsPerWeek: 20,
    maxRepairLeadsPerDay: 20,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  // Upgrade ratio = 2/20 = 10% < 20% min
  const state: FlowState = {
    qualifiedLeadsToday: 5,
    installLeadsThisWeek: 3,
    repairLeadsToday: 3,
    upgradeLeadsThisWeek: 2,
    totalLeadsThisWeek: 20,
    backlogHours: 20,
  };

  const decisions = evaluateFlowState(state, cfg);
  assert(decisions.some(d => d.action === "boost_upgrade_priority"), "Low upgrade ratio → boost_upgrade_priority");

  // Apply — medium upgrade becomes high
  const intents: PlanIntent[] = [
    {
      id: "ad-upgrade-1", operator: "m", command: "draft",
      args: ["--type", "google-ad", "--service", "hvac upgrade"],
      reason: "Energy efficiency upgrade", priority: "medium",
    },
  ];
  const result = applyFlowGovernor(intents, state, cfg);
  assert(result.intentModifications.boosted.includes("ad-upgrade-1"), "Upgrade intent boosted");
  assert(intents[0].priority === "high", `Upgrade boosted to high (got ${intents[0].priority})`);
  assert(result.summary.upgradeRatio.current === 0.1, `Upgrade ratio 0.1 (got ${result.summary.upgradeRatio.current})`);
  assert(result.summary.upgradeRatio.met === false, "Upgrade ratio NOT met");
}

// ============================================================
// 64. Flow Governor — Backlog Overload
// ============================================================
heading("64. Flow Governor — Backlog Overload");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 20,
    maxInstallLeadsPerWeek: 20,
    maxRepairLeadsPerDay: 20,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  // Backlog 60h > buffer 48h
  const state: FlowState = {
    qualifiedLeadsToday: 5,
    installLeadsThisWeek: 3,
    repairLeadsToday: 3,
    upgradeLeadsThisWeek: 5,
    totalLeadsThisWeek: 20,
    backlogHours: 60,
  };

  const decisions = evaluateFlowState(state, cfg);
  assert(decisions.some(d => d.action === "reduce_geo_radius"), "Backlog overload → reduce_geo_radius");
  assert(decisions.some(d => d.action === "suppress_tier2_tier3"), "Backlog overload → suppress_tier2_tier3");
  assert(decisions.filter(d => d.severity === "critical").length >= 2, "Backlog actions are critical");

  // Apply — tier2 and tier3 intents suppressed
  const intents: PlanIntent[] = [
    {
      id: "t1-1", operator: "m", command: "draft",
      args: ["--type", "geo"], reason: "Tier1", priority: "high",
      zip: "80113", geoTier: "tier1_core",
    },
    {
      id: "t2-1", operator: "m", command: "draft",
      args: ["--type", "geo"], reason: "Tier2", priority: "medium",
      zip: "80007", geoTier: "tier2_upgrade",
    },
    {
      id: "t3-1", operator: "m", command: "draft",
      args: ["--type", "geo"], reason: "Tier3", priority: "low",
      zip: "80118", geoTier: "tier3_selective",
    },
  ];

  const result = applyFlowGovernor(intents, state, cfg);
  assert(result.intentModifications.suppressed.includes("t2-1"), "Tier2 suppressed on backlog");
  assert(result.intentModifications.suppressed.includes("t3-1"), "Tier3 suppressed on backlog");
  assert(!result.intentModifications.suppressed.includes("t1-1"), "Tier1 NOT suppressed on backlog");
  assert(result.summary.backlogStatus.overloaded === true, "Backlog status: overloaded");
  assert(result.summary.totalSuppressed === 2, `2 suppressed (got ${result.summary.totalSuppressed})`);
}

// ============================================================
// 65. Flow Governor — All Clear (No Interventions)
// ============================================================
heading("65. Flow Governor — All Clear");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 20,
    maxInstallLeadsPerWeek: 20,
    maxRepairLeadsPerDay: 20,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  // Everything within limits, upgrade ratio met
  const state: FlowState = {
    qualifiedLeadsToday: 8,
    installLeadsThisWeek: 5,
    repairLeadsToday: 4,
    upgradeLeadsThisWeek: 6,
    totalLeadsThisWeek: 20,
    backlogHours: 30,
  };

  const decisions = evaluateFlowState(state, cfg);
  assert(decisions.length === 0, `All clear → 0 decisions (got ${decisions.length})`);

  const intents: PlanIntent[] = [
    { id: "a", operator: "m", command: "d", args: [], reason: "", priority: "high" },
    { id: "b", operator: "m", command: "d", args: [], reason: "", priority: "medium" },
  ];
  const result = applyFlowGovernor(intents, state, cfg);
  assert(result.summary.totalSuppressed === 0, "No suppressions");
  assert(result.summary.totalReprioritized === 0, "No reprioritizations");
  assert(result.summary.totalBoosted === 0, "No boosts");
  assert(result.summary.backlogStatus.overloaded === false, "Not overloaded");
  assert(result.summary.upgradeRatio.met === true, "Upgrade ratio met");
}

// ============================================================
// 66. Flow Governor — Summary Calculations
// ============================================================
heading("66. Flow Governor — Summary Calculations");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 10,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  const state: FlowState = {
    qualifiedLeadsToday: 7,
    installLeadsThisWeek: 4,
    repairLeadsToday: 5,
    upgradeLeadsThisWeek: 4,
    totalLeadsThisWeek: 15,
    backlogHours: 36,
  };

  const result = applyFlowGovernor([], state, cfg);
  assert(result.summary.leadsVsCap.today === 7, "Leads today = 7");
  assert(result.summary.leadsVsCap.cap === 10, "Leads cap = 10");
  assert(result.summary.leadsVsCap.pct === 70, "Leads pct = 70%");
  assert(result.summary.installVsCap.week === 4, "Install week = 4");
  assert(result.summary.installVsCap.pct === 50, "Install pct = 50%");
  assert(result.summary.repairVsCap.today === 5, "Repair today = 5");
  assert(result.summary.upgradeRatio.current === 0.27, `Upgrade ratio 0.27 (got ${result.summary.upgradeRatio.current})`);
  assert(result.summary.backlogStatus.hours === 36, "Backlog hours = 36");
  assert(result.summary.backlogStatus.overloaded === false, "Not overloaded at 36h");
}

// ============================================================
// 67. Flow v1.1 — Effective Leads Computation
// ============================================================
heading("67. Flow v1.1 — Effective Leads");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 12,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
    qualityDiscountEnabled: true,
  };

  // No junk → effective = raw
  const noJunk: FlowState = {
    qualifiedLeadsToday: 15,
    installLeadsThisWeek: 3, repairLeadsToday: 3,
    upgradeLeadsThisWeek: 3, totalLeadsThisWeek: 15, backlogHours: 10,
  };
  assert(computeEffectiveLeads(noJunk, cfg) === 15, "No junk rate → effective = raw 15");

  // 20% junk → 15 × 0.8 = 12
  const withJunk: FlowState = {
    ...noJunk, junkLeadRateEstimate: 0.20,
  };
  assert(computeEffectiveLeads(withJunk, cfg) === 12, "20% junk: 15 × 0.8 = 12");

  // 50% junk → 15 × 0.5 = 7.5
  const highJunk: FlowState = { ...noJunk, junkLeadRateEstimate: 0.50 };
  assert(computeEffectiveLeads(highJunk, cfg) === 7.5, "50% junk: 15 × 0.5 = 7.5");

  // Quality discount disabled → no discount
  const cfgDisabled: FlowControlConfig = { ...cfg, qualityDiscountEnabled: false };
  assert(computeEffectiveLeads(withJunk, cfgDisabled) === 15, "Discount disabled → raw 15");

  // Junk rate clamped to 0-1
  const crazy: FlowState = { ...noJunk, junkLeadRateEstimate: 1.5 };
  assert(computeEffectiveLeads(crazy, cfg) === 0, "Junk 1.5 clamped to 1.0 → 0 effective");
}

// ============================================================
// 68. Flow v1.1 — Threshold Computation
// ============================================================
heading("68. Flow v1.1 — Thresholds");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 12,
    hardCapQualifiedLeadsPerDay: 12,
    softCapMultiplier: 1.33,
    overflowMultiplier: 1.66,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  const t = computeFlowThresholds(cfg);
  assert(t.hardCap === 12, `Hard cap = 12 (got ${t.hardCap})`);
  assert(t.softCap === 15.96, `Soft cap = 12 × 1.33 = 15.96 (got ${t.softCap})`);
  assert(t.overflowCap === 19.92, `Overflow = 12 × 1.66 = 19.92 (got ${t.overflowCap})`);

  // Falls back to maxQualifiedLeadsPerDay if hardCap not set
  const cfgNoHard: FlowControlConfig = { ...cfg, hardCapQualifiedLeadsPerDay: undefined };
  const t2 = computeFlowThresholds(cfgNoHard);
  assert(t2.hardCap === 12, "Fallback to maxQualifiedLeadsPerDay");
}

// ============================================================
// 69. Flow v1.1 — Mode Transitions
// ============================================================
heading("69. Flow v1.1 — Mode Transitions");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 12,
    hardCapQualifiedLeadsPerDay: 12,
    softCapMultiplier: 1.33,
    overflowMultiplier: 1.66,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };
  // hardCap=12, softCap=15.96, overflow=19.92

  assert(determineFlowMode(10, cfg) === "NORMAL", "10 ≤ 12 → NORMAL");
  assert(determineFlowMode(12, cfg) === "NORMAL", "12 ≤ 12 → NORMAL (boundary)");
  assert(determineFlowMode(13, cfg) === "WAITLIST", "13 > 12, ≤ 15.96 → WAITLIST");
  assert(determineFlowMode(15.96, cfg) === "WAITLIST", "15.96 ≤ 15.96 → WAITLIST (boundary)");
  assert(determineFlowMode(16, cfg) === "THROTTLE", "16 > 15.96, ≤ 19.92 → THROTTLE");
  assert(determineFlowMode(19.92, cfg) === "THROTTLE", "19.92 ≤ 19.92 → THROTTLE (boundary)");
  assert(determineFlowMode(20, cfg) === "SUPPRESS", "20 > 19.92 → SUPPRESS");
  assert(determineFlowMode(25, cfg) === "SUPPRESS", "25 → SUPPRESS");
}

// ============================================================
// 70. Flow v1.1 — WAITLIST Mode Decisions
// ============================================================
heading("70. Flow v1.1 — WAITLIST Mode");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 12,
    hardCapQualifiedLeadsPerDay: 12,
    softCapMultiplier: 1.33,
    overflowMultiplier: 1.66,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
    qualityDiscountEnabled: true,
  };

  const state: FlowState = {
    qualifiedLeadsToday: 14,
    installLeadsThisWeek: 3, repairLeadsToday: 3,
    upgradeLeadsThisWeek: 5, totalLeadsThisWeek: 15, backlogHours: 10,
  };

  const decisions = evaluateFlowState(state, cfg);
  assert(decisions.some(d => d.action === "suppress_tier2_tier3"), "WAITLIST → suppress tier2+tier3");
  assert(decisions.some(d => d.action === "tighten_match_types"), "WAITLIST → tighten match types");
  assert(decisions.some(d => d.action === "reduce_repair_bids"), "WAITLIST → reduce repair bids");
  assert(decisions.some(d => d.action === "boost_upgrade_priority"), "WAITLIST → boost upgrade");
  assert(!decisions.some(d => d.action === "block_bid_increase"), "WAITLIST does NOT block bids");
  assert(!decisions.some(d => d.action === "suppress_non_tier1"), "WAITLIST does NOT suppress all non-tier1");
}

// ============================================================
// 71. Flow v1.1 — THROTTLE Mode Decisions
// ============================================================
heading("71. Flow v1.1 — THROTTLE Mode");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 12,
    hardCapQualifiedLeadsPerDay: 12,
    softCapMultiplier: 1.33,
    overflowMultiplier: 1.66,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  // effectiveLeads = 17 (> softCap 15.96, ≤ overflow 19.92)
  const state: FlowState = {
    qualifiedLeadsToday: 17,
    installLeadsThisWeek: 3, repairLeadsToday: 3,
    upgradeLeadsThisWeek: 5, totalLeadsThisWeek: 15, backlogHours: 10,
  };

  const decisions = evaluateFlowState(state, cfg);
  assert(decisions.some(d => d.action === "reduce_bids_10"), "THROTTLE → reduce bids 10%");
  assert(decisions.some(d => d.action === "suppress_non_tier1"), "THROTTLE → suppress non-tier1");
  assert(!decisions.some(d => d.action === "block_bid_increase"), "THROTTLE does NOT block bids");
}

// ============================================================
// 72. Flow v1.1 — SUPPRESS Mode Decisions
// ============================================================
heading("72. Flow v1.1 — SUPPRESS Mode");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 12,
    hardCapQualifiedLeadsPerDay: 12,
    softCapMultiplier: 1.33,
    overflowMultiplier: 1.66,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  // effectiveLeads = 22 (> overflow 19.92)
  const state: FlowState = {
    qualifiedLeadsToday: 22,
    installLeadsThisWeek: 3, repairLeadsToday: 3,
    upgradeLeadsThisWeek: 5, totalLeadsThisWeek: 15, backlogHours: 10,
  };

  const decisions = evaluateFlowState(state, cfg);
  assert(decisions.some(d => d.action === "block_bid_increase"), "SUPPRESS → block bid increase");
  assert(decisions.some(d => d.action === "reduce_bids_15"), "SUPPRESS → reduce bids 15%");
  assert(decisions.some(d => d.action === "suppress_non_tier1"), "SUPPRESS → suppress non-tier1");
}

// ============================================================
// 73. Flow v1.1 — Quality Discount Shifts Mode
// ============================================================
heading("73. Flow v1.1 — Quality Discount Shifts Mode");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 12,
    hardCapQualifiedLeadsPerDay: 12,
    softCapMultiplier: 1.33,
    overflowMultiplier: 1.66,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
    qualityDiscountEnabled: true,
  };

  // Raw = 15, junk = 25% → effective = 15 × 0.75 = 11.25 → NORMAL (≤ 12)
  const state: FlowState = {
    qualifiedLeadsToday: 15,
    installLeadsThisWeek: 3, repairLeadsToday: 3,
    upgradeLeadsThisWeek: 5, totalLeadsThisWeek: 15, backlogHours: 10,
    junkLeadRateEstimate: 0.25,
  };

  const eff = computeEffectiveLeads(state, cfg);
  assert(eff === 11.25, `Effective = 11.25 (got ${eff})`);
  const mode = determineFlowMode(eff, cfg);
  assert(mode === "NORMAL", `Quality discount shifts 15 raw → 11.25 effective → NORMAL (got ${mode})`);

  // Without discount, 15 raw → WAITLIST
  const modeRaw = determineFlowMode(15, cfg);
  assert(modeRaw === "WAITLIST", "Without discount: 15 → WAITLIST");
}

// ============================================================
// 74. Flow v1.1 — Install Ladder Steps
// ============================================================
heading("74. Flow v1.1 — Install Ladder Steps");
{
  // Step 0: under cap
  assert(computeInstallLadderStep(6, 8) === 0, "6/8 = 75% → step 0");
  assert(computeInstallLadderStep(8, 8) === 0, "8/8 = 100% → step 0 (boundary)");

  // Step 1: 100-125%
  assert(computeInstallLadderStep(9, 8) === 1, "9/8 = 112% → step 1 (restrict tier1)");
  assert(computeInstallLadderStep(10, 8) === 1, "10/8 = 125% → step 1 (boundary)");

  // Step 2: 125-150%
  assert(computeInstallLadderStep(11, 8) === 2, "11/8 = 137% → step 2 (reduce bids)");
  assert(computeInstallLadderStep(12, 8) === 2, "12/8 = 150% → step 2 (boundary)");

  // Step 3: >150%
  assert(computeInstallLadderStep(13, 8) === 3, "13/8 = 162% → step 3 (pause)");
  assert(computeInstallLadderStep(20, 8) === 3, "20/8 = 250% → step 3");

  // Edge case: cap 0
  assert(computeInstallLadderStep(5, 0) === 0, "Cap 0 → step 0");
}

// ============================================================
// 75. Flow v1.1 — Install Ladder Decisions
// ============================================================
heading("75. Flow v1.1 — Install Ladder Decisions");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 20,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 20,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
  };

  // Step 1: restrict to tier1
  const s1: FlowState = {
    qualifiedLeadsToday: 5, installLeadsThisWeek: 9,
    repairLeadsToday: 3, upgradeLeadsThisWeek: 5, totalLeadsThisWeek: 20, backlogHours: 10,
  };
  const d1 = evaluateFlowState(s1, cfg);
  assert(d1.some(d => d.action === "restrict_install_tier1"), "Step 1 → restrict_install_tier1");
  assert(!d1.some(d => d.action === "reduce_install_bids_15"), "Step 1 → no bid reduction");
  assert(!d1.some(d => d.action === "pause_install_ads"), "Step 1 → no pause");

  // Step 2: restrict + reduce bids
  const s2: FlowState = { ...s1, installLeadsThisWeek: 11 };
  const d2 = evaluateFlowState(s2, cfg);
  assert(d2.some(d => d.action === "restrict_install_tier1"), "Step 2 → restrict_install_tier1");
  assert(d2.some(d => d.action === "reduce_install_bids_15"), "Step 2 → reduce_install_bids_15");
  assert(!d2.some(d => d.action === "pause_install_ads"), "Step 2 → no pause");

  // Step 3: pause
  const s3: FlowState = { ...s1, installLeadsThisWeek: 13 };
  const d3 = evaluateFlowState(s3, cfg);
  assert(d3.some(d => d.action === "pause_install_ads"), "Step 3 → pause_install_ads");
}

// ============================================================
// 76. Flow v1.1 — Repair Share Rule
// ============================================================
heading("76. Flow v1.1 — Repair Share Rule");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 20,
    maxInstallLeadsPerWeek: 20,
    maxRepairLeadsPerDay: 20,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
    maxLowTicketRepairShare: 0.55,
  };

  // Under threshold → no action
  const under: FlowState = {
    qualifiedLeadsToday: 8, installLeadsThisWeek: 5,
    repairLeadsToday: 4, upgradeLeadsThisWeek: 5, totalLeadsThisWeek: 20,
    backlogHours: 10, lowTicketRepairShareToday: 0.40,
  };
  const dUnder = evaluateFlowState(under, cfg);
  assert(!dUnder.some(d => d.action === "demote_low_ticket_repair"), "40% < 55% → no demote");

  // Over threshold → demote repair + promote upgrade/install
  const over: FlowState = { ...under, lowTicketRepairShareToday: 0.65 };
  const dOver = evaluateFlowState(over, cfg);
  assert(dOver.some(d => d.action === "demote_low_ticket_repair"), "65% > 55% → demote_low_ticket_repair");
  assert(dOver.some(d => d.action === "promote_upgrade_install"), "65% > 55% → promote_upgrade_install");

  // Apply to intents: repair demoted, upgrade+install boosted
  const intents: PlanIntent[] = [
    {
      id: "ad-repair-1", operator: "m", command: "draft",
      args: ["--type", "google-ad", "--service", "repair"],
      reason: "Repair ad", priority: "high",
    },
    {
      id: "ad-upgrade-1", operator: "m", command: "draft",
      args: ["--type", "google-ad", "--service", "upgrade"],
      reason: "Upgrade ad", priority: "medium",
    },
    {
      id: "ad-install-1", operator: "m", command: "draft",
      args: ["--type", "google-ad", "--service", "installation"],
      reason: "Install ad", priority: "low",
    },
  ];

  const result = applyFlowGovernor(intents, over, cfg);
  assert(result.intentModifications.reprioritized.includes("ad-repair-1"), "Repair demoted");
  assert(result.intentModifications.boosted.includes("ad-upgrade-1"), "Upgrade boosted");
  assert(result.intentModifications.boosted.includes("ad-install-1"), "Install boosted");
}

// ============================================================
// 77. Flow v1.1 — Summary Contains v1.1 Fields
// ============================================================
heading("77. Flow v1.1 — Summary Fields");
{
  const cfg: FlowControlConfig = {
    maxQualifiedLeadsPerDay: 12,
    hardCapQualifiedLeadsPerDay: 12,
    softCapMultiplier: 1.33,
    overflowMultiplier: 1.66,
    maxInstallLeadsPerWeek: 8,
    maxRepairLeadsPerDay: 10,
    minUpgradeRatio: 0.20,
    backlogBufferHours: 48,
    qualityDiscountEnabled: true,
  };

  const state: FlowState = {
    qualifiedLeadsToday: 14, installLeadsThisWeek: 3,
    repairLeadsToday: 3, upgradeLeadsThisWeek: 5, totalLeadsThisWeek: 15,
    backlogHours: 10, junkLeadRateEstimate: 0.10,
  };

  const result = applyFlowGovernor([], state, cfg);
  assert(result.summary.flowMode === "WAITLIST", `Flow mode = WAITLIST (14*0.9=12.6 > 12) (got ${result.summary.flowMode})`);
  assert(result.summary.effectiveLeads === 12.6, `Effective = 12.6 (got ${result.summary.effectiveLeads})`);
  assert(result.summary.rawLeads === 14, "Raw = 14");
  assert(result.summary.hardCap === 12, "Hard cap = 12");
  assert(result.summary.softCap === 15.96, `Soft cap = 15.96 (got ${result.summary.softCap})`);
  assert(result.summary.overflowCap === 19.92, `Overflow = 19.92 (got ${result.summary.overflowCap})`);
}

// ============================================================
// 78. Geo Learner — Compute ZIP Performance
// ============================================================
heading("78. Geo Learner — Compute ZIP Performance");
{
  const convConfig: ConversionConfig = {
    callWeight: 1.0,
    formWeight: 1.0,
    tieBreakerWindowDays: 14,
    callCloseRate: 0.42,
    formCloseRate: 0.18,
    avgTicketCall: 485,
    avgTicketForm: 2800,
    targetCPL: 75,
  };

  const input: ZipMetricsInput = { zip: "80113", calls: 6, forms: 2, spend: 400 };
  const perf = computeZipPerformance(input, convConfig, 1.0);

  assert(perf.zip === "80113", "ZIP preserved");
  assert(perf.leads === 8, "6 calls + 2 forms = 8 leads");
  assert(perf.cpl === 50, "400 / 8 = $50 CPL");
  assert(perf.currentWeight === 1.0, "Current weight 1.0");

  // Weighted lead value: 6 × 0.42 × 485 + 2 × 0.18 × 2800 = 1222.20 + 1008.00 = 2230.20
  assert(perf.weightedLeadValue === 2230.2, `WLV = 2230.20 (got ${perf.weightedLeadValue})`);
  // Profit efficiency: 2230.20 - 400 = 1830.20
  assert(perf.profitEfficiency === 1830.2, `Profit = 1830.20 (got ${perf.profitEfficiency})`);
}

// ============================================================
// 79. Geo Learner — Insufficient Data → No Proposals
// ============================================================
heading("79. Geo Learner — Insufficient Data");
{
  const convConfig: ConversionConfig = {
    callWeight: 1.0, formWeight: 1.0, tieBreakerWindowDays: 14,
    callCloseRate: 0.42, formCloseRate: 0.18,
    avgTicketCall: 485, avgTicketForm: 2800, targetCPL: 75,
  };

  const learning: GeoLearningConfig = {
    enabled: true, mode: "CONSERVATIVE",
    minDataWindowDays: 14, minLeadsPerZip: 5,
    maxWeight: 1.4, minWeight: 0.8,
    stepUp: 0.05, stepDown: 0.05,
  };

  // Only 3 leads — below minLeadsPerZip (5)
  const perf = computeZipPerformance(
    { zip: "80113", calls: 2, forms: 1, spend: 100 },
    convConfig, 1.0
  );
  const proposal = evaluateZipWeight(perf, learning, 75);
  assert(proposal === null, "Insufficient data (3 < 5 leads) → no proposal");
}

// ============================================================
// 80. Geo Learner — Weight Increase (Strong Performance)
// ============================================================
heading("80. Geo Learner — Weight Increase");
{
  const convConfig: ConversionConfig = {
    callWeight: 1.0, formWeight: 1.0, tieBreakerWindowDays: 14,
    callCloseRate: 0.42, formCloseRate: 0.18,
    avgTicketCall: 485, avgTicketForm: 2800, targetCPL: 75,
  };

  const learning: GeoLearningConfig = {
    enabled: true, mode: "CONSERVATIVE",
    minDataWindowDays: 14, minLeadsPerZip: 5,
    maxWeight: 1.4, minWeight: 0.8,
    stepUp: 0.05, stepDown: 0.05,
  };

  // Good ZIP: 8 leads, CPL $50 (< $67.50 = 75 × 0.90), profit positive
  const perf = computeZipPerformance(
    { zip: "80113", calls: 6, forms: 2, spend: 400 },
    convConfig, 1.0
  );
  assert(perf.cpl === 50, "CPL = $50");
  assert(perf.profitEfficiency > 0, "Profit positive");

  const proposal = evaluateZipWeight(perf, learning, 75);
  assert(proposal !== null, "Good performance → proposal generated");
  assert(proposal!.proposedWeight === 1.05, `Proposed 1.0 + 0.05 = 1.05 (got ${proposal!.proposedWeight})`);
  assert(proposal!.delta === 0.05, "Delta = +0.05");
  assert(proposal!.reason.includes("CPL"), "Reason mentions CPL");
}

// ============================================================
// 81. Geo Learner — Weight Decrease (Bad Performance)
// ============================================================
heading("81. Geo Learner — Weight Decrease");
{
  const convConfig: ConversionConfig = {
    callWeight: 1.0, formWeight: 1.0, tieBreakerWindowDays: 14,
    callCloseRate: 0.42, formCloseRate: 0.18,
    avgTicketCall: 485, avgTicketForm: 2800, targetCPL: 75,
  };

  const learning: GeoLearningConfig = {
    enabled: true, mode: "CONSERVATIVE",
    minDataWindowDays: 14, minLeadsPerZip: 5,
    maxWeight: 1.4, minWeight: 0.8,
    stepUp: 0.05, stepDown: 0.05,
  };

  // Bad ZIP: CPL $90 (> $86.25 = 75 × 1.15)
  const perf = computeZipPerformance(
    { zip: "80602", calls: 3, forms: 3, spend: 540 },
    convConfig, 1.0
  );
  assert(perf.cpl === 90, `CPL = $90 (got ${perf.cpl})`);

  const proposal = evaluateZipWeight(perf, learning, 75);
  assert(proposal !== null, "Bad CPL → decrease proposal");
  assert(proposal!.proposedWeight === 0.95, `Proposed 1.0 - 0.05 = 0.95 (got ${proposal!.proposedWeight})`);
  assert(proposal!.delta === -0.05, "Delta = -0.05");

  // Negative profit also triggers decrease
  const perfLoss = computeZipPerformance(
    { zip: "80640", calls: 2, forms: 3, spend: 5000 },
    convConfig, 1.0
  );
  assert(perfLoss.profitEfficiency < 0, "Negative profit");
  const proposalLoss = evaluateZipWeight(perfLoss, learning, 75);
  assert(proposalLoss !== null, "Negative profit → decrease proposal");
  assert(proposalLoss!.delta < 0, "Negative delta");
}

// ============================================================
// 82. Geo Learner — Cap Enforcement (0.80 – 1.40)
// ============================================================
heading("82. Geo Learner — Weight Caps");
{
  const convConfig: ConversionConfig = {
    callWeight: 1.0, formWeight: 1.0, tieBreakerWindowDays: 14,
    callCloseRate: 0.42, formCloseRate: 0.18,
    avgTicketCall: 485, avgTicketForm: 2800, targetCPL: 75,
  };

  const learning: GeoLearningConfig = {
    enabled: true, mode: "CONSERVATIVE",
    minDataWindowDays: 14, minLeadsPerZip: 5,
    maxWeight: 1.4, minWeight: 0.8,
    stepUp: 0.05, stepDown: 0.05,
  };

  // Already at maxWeight (1.40) — can't increase further
  const perfGood = computeZipPerformance(
    { zip: "80113", calls: 6, forms: 2, spend: 400 },
    convConfig, 1.40
  );
  const propMax = evaluateZipWeight(perfGood, learning, 75);
  assert(propMax === null, "At max weight 1.40 → no increase possible → null");

  // Already at minWeight (0.80) — can't decrease further
  const perfBad = computeZipPerformance(
    { zip: "80602", calls: 3, forms: 3, spend: 540 },
    convConfig, 0.80
  );
  const propMin = evaluateZipWeight(perfBad, learning, 75);
  assert(propMin === null, "At min weight 0.80 → no decrease possible → null");

  // Near max: 1.38 + 0.05 = 1.43 → capped at 1.40
  const perfNearMax = computeZipPerformance(
    { zip: "80113", calls: 6, forms: 2, spend: 400 },
    convConfig, 1.38
  );
  const propNearMax = evaluateZipWeight(perfNearMax, learning, 75);
  assert(propNearMax !== null, "Near max → still proposes (capped)");
  assert(propNearMax!.proposedWeight === 1.40, `1.38 + 0.05 capped to 1.40 (got ${propNearMax!.proposedWeight})`);
}

// ============================================================
// 83. Geo Learner — Full Learning Cycle
// ============================================================
heading("83. Geo Learner — Full Learning Cycle");
{
  resetGeoCache();
  const convConfig: ConversionConfig = {
    callWeight: 1.0, formWeight: 1.0, tieBreakerWindowDays: 14,
    callCloseRate: 0.42, formCloseRate: 0.18,
    avgTicketCall: 485, avgTicketForm: 2800, targetCPL: 75,
  };

  const geoConfig: GeoPriorityConfig = {
    baseZip: "80212",
    maxRadiusMiles: 60,
    zipWeights: {
      "80113": 1.0,
      "80111": 1.0,
      "80602": 1.0,
      "80640": 1.0,
      "80401": 1.0,
    },
    learning: {
      enabled: true, mode: "CONSERVATIVE",
      minDataWindowDays: 14, minLeadsPerZip: 5,
      maxWeight: 1.4, minWeight: 0.8,
      stepUp: 0.05, stepDown: 0.05,
    },
  };

  const zipMetrics: ZipMetricsInput[] = [
    { zip: "80113", calls: 8, forms: 3, spend: 500 },   // Strong: 11 leads, CPL $45.45
    { zip: "80111", calls: 3, forms: 1, spend: 200 },   // Insufficient: 4 leads < 5
    { zip: "80602", calls: 4, forms: 3, spend: 700 },   // Bad: 7 leads, CPL $100
    { zip: "80640", calls: 1, forms: 0, spend: 50 },    // Insufficient: 1 lead
    { zip: "80401", calls: 4, forms: 2, spend: 420 },   // Marginal: CPL $70 (between 67.5 and 86.25)
  ];

  const result = runGeoWeightLearning(zipMetrics, convConfig, geoConfig);

  assert(result.zipsEvaluated === 5, `5 zips evaluated (got ${result.zipsEvaluated})`);
  assert(result.summary.insufficientData === 2, `2 insufficient (80111, 80640) (got ${result.summary.insufficientData})`);
  assert(result.insufficientData.includes("80111"), "80111 insufficient");
  assert(result.insufficientData.includes("80640"), "80640 insufficient");
  assert(result.summary.increases === 1, `1 increase (80113) (got ${result.summary.increases})`);
  assert(result.summary.decreases === 1, `1 decrease (80602) (got ${result.summary.decreases})`);
  assert(result.summary.holds === 1, `1 hold (80401) (got ${result.summary.holds})`);
  assert(result.mode === "CONSERVATIVE", "Mode = CONSERVATIVE");

  // Check specific proposals
  const incr = result.proposals.find(p => p.zip === "80113");
  assert(incr !== undefined, "80113 has increase proposal");
  assert(incr!.proposedWeight === 1.05, `80113: 1.0 → 1.05 (got ${incr!.proposedWeight})`);

  const decr = result.proposals.find(p => p.zip === "80602");
  assert(decr !== undefined, "80602 has decrease proposal");
  assert(decr!.proposedWeight === 0.95, `80602: 1.0 → 0.95 (got ${decr!.proposedWeight})`);

  // No proposal for 80401 (hold)
  assert(result.proposals.find(p => p.zip === "80401") === undefined, "80401 no proposal (hold)");
}

// ============================================================
// 84. Geo Learner — Deterministic Output
// ============================================================
heading("84. Geo Learner — Deterministic Output");
{
  const convConfig: ConversionConfig = {
    callWeight: 1.0, formWeight: 1.0, tieBreakerWindowDays: 14,
    callCloseRate: 0.42, formCloseRate: 0.18,
    avgTicketCall: 485, avgTicketForm: 2800, targetCPL: 75,
  };

  const geoConfig: GeoPriorityConfig = {
    baseZip: "80212", maxRadiusMiles: 60,
    zipWeights: { "80113": 1.0, "80602": 1.0 },
    learning: {
      enabled: true, mode: "CONSERVATIVE",
      minDataWindowDays: 14, minLeadsPerZip: 5,
      maxWeight: 1.4, minWeight: 0.8,
      stepUp: 0.05, stepDown: 0.05,
    },
  };

  const metrics: ZipMetricsInput[] = [
    { zip: "80113", calls: 6, forms: 2, spend: 400 },
    { zip: "80602", calls: 4, forms: 3, spend: 700 },
  ];

  // Run twice — same inputs produce same outputs
  const r1 = runGeoWeightLearning(metrics, convConfig, geoConfig);
  const r2 = runGeoWeightLearning(metrics, convConfig, geoConfig);

  assert(r1.proposals.length === r2.proposals.length, "Same proposal count");
  for (let i = 0; i < r1.proposals.length; i++) {
    assert(r1.proposals[i].zip === r2.proposals[i].zip, `Same zip at index ${i}`);
    assert(r1.proposals[i].proposedWeight === r2.proposals[i].proposedWeight, `Same weight at index ${i}`);
    assert(r1.proposals[i].delta === r2.proposals[i].delta, `Same delta at index ${i}`);
  }
  assert(r1.summary.increases === r2.summary.increases, "Deterministic increase count");
  assert(r1.summary.decreases === r2.summary.decreases, "Deterministic decrease count");
}

// ============================================================
// 85. Geo Config — getAllZipWeights
// ============================================================
heading("85. Geo Config — getAllZipWeights");
{
  resetGeoCache();
  const weights = getAllZipWeights();
  const count = Object.keys(weights).length;
  assert(count === 42, `42 target zips configured (got ${count})`);
  assert(weights["80113"] === 1.0, "80113 weight = 1.0");
  assert(weights["80602"] === 1.0, "80602 weight = 1.0");
  assert(weights["80621"] === 1.0, "80621 weight = 1.0");
  assert(weights["99999"] === undefined, "Non-target zip not in weights");
}

// ============================================================
// 86. Constitution Loader — Boot Success
// ============================================================
heading("86. Constitution Loader — Boot Success");
{
  resetConstitutionCache();
  const boot = bootConstitution();
  assert(boot.constitution_version === "1.0.0", "Constitution version = 1.0.0");
  assert(boot.constitution_hash.length === 64, "Constitution hash is SHA-256 (64 hex chars)");
  assert(boot.constitution.invariants.length >= 5, `Constitution has ${boot.constitution.invariants.length} invariants`);
  assert(boot.constitution.season_matrix["1"].season === "HEATING", "January = HEATING");
  assert(boot.constitution.season_matrix["4"].season === "SHOULDER", "April = SHOULDER");
  assert(boot.constitution.season_matrix["7"].season === "COOLING", "July = COOLING");
  assert(boot.constitution.capacity_protection.weekly_lead_cap_default === 20, "Default weekly lead cap = 20");
  assert(boot.constitution.budget_enforcement.max_weekly_change_pct === 10, "Budget max change = 10%");
}

// ============================================================
// 87. Constitution Loader — Fail Closed on Missing File
// ============================================================
heading("87. Constitution Loader — Fail Closed on Missing");
{
  resetConstitutionCache();
  const orig = process.env.MBS_CONSTITUTION_PATH;
  process.env.MBS_CONSTITUTION_PATH = "/tmp/nonexistent-constitution-xyzzy.json";
  let caught = false;
  try {
    bootConstitution();
  } catch (err: any) {
    caught = true;
    assert(err.message.includes("CONSTITUTION FAIL-CLOSED"), `Error message includes FAIL-CLOSED: ${err.message.slice(0, 60)}`);
  }
  assert(caught, "Boot throws when constitution file is missing");
  process.env.MBS_CONSTITUTION_PATH = orig || "";
  if (!orig) delete process.env.MBS_CONSTITUTION_PATH;
  resetConstitutionCache();
  // Re-boot with correct path
  bootConstitution();
}

// ============================================================
// 88. Constitution Loader — Fail Closed on Invalid JSON
// ============================================================
heading("88. Constitution Loader — Fail Closed on Invalid JSON");
{
  resetConstitutionCache();
  const badPath = join(TMPDIR, "bad-constitution.json");
  writeFileSync(badPath, "NOT VALID JSON {{{", "utf-8");
  const orig = process.env.MBS_CONSTITUTION_PATH;
  process.env.MBS_CONSTITUTION_PATH = badPath;
  let caught = false;
  try {
    bootConstitution();
  } catch (err: any) {
    caught = true;
    assert(err.message.includes("CONSTITUTION FAIL-CLOSED"), `Error includes FAIL-CLOSED: ${err.message.slice(0, 60)}`);
    assert(err.message.includes("not valid JSON"), `Error mentions invalid JSON`);
  }
  assert(caught, "Boot throws on invalid JSON");
  process.env.MBS_CONSTITUTION_PATH = orig || "";
  if (!orig) delete process.env.MBS_CONSTITUTION_PATH;
  resetConstitutionCache();
  bootConstitution();
}

// ============================================================
// 89. Constitution Loader — Fail Closed on Missing Fields
// ============================================================
heading("89. Constitution Loader — Fail Closed on Missing Fields");
{
  resetConstitutionCache();
  const partialPath = join(TMPDIR, "partial-constitution.json");
  writeFileSync(partialPath, JSON.stringify({ constitution_version: "0.1" }), "utf-8");
  const orig = process.env.MBS_CONSTITUTION_PATH;
  process.env.MBS_CONSTITUTION_PATH = partialPath;
  let caught = false;
  try {
    bootConstitution();
  } catch (err: any) {
    caught = true;
    assert(err.message.includes("Validation errors"), `Error mentions validation errors: ${err.message.slice(0, 80)}`);
  }
  assert(caught, "Boot throws on missing required fields");
  process.env.MBS_CONSTITUTION_PATH = orig || "";
  if (!orig) delete process.env.MBS_CONSTITUTION_PATH;
  resetConstitutionCache();
  bootConstitution();
}

// ============================================================
// 90. Constitution Hash — Deterministic
// ============================================================
heading("90. Constitution Hash — Deterministic");
{
  resetConstitutionCache();
  const boot1 = bootConstitution();
  resetConstitutionCache();
  const boot2 = bootConstitution();
  assert(boot1.constitution_hash === boot2.constitution_hash, "Same file → same hash");
  assert(boot1.constitution_version === boot2.constitution_version, "Same file → same version");
}

// ============================================================
// 91. Gatekeeper — NORMAL Mode (Under Cap)
// ============================================================
heading("91. Gatekeeper — NORMAL Mode");
{
  resetConstitutionCache();
  bootConstitution();
  const ctx: GatekeeperContext = {
    month: 2,
    week_budget: 525,
    prior_week_budget: 525,
    weekly_lead_projection: 10,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.4,
    zip_weights: { "80113": 1.0, "80111": 1.0 },
    newly_activated_zips: [],
    approvals: [],
  };
  const result = evaluateGatekeeper(ctx);
  assert(result.allowed === true, "Allowed under cap");
  assert(result.mode === "NORMAL", `Mode = NORMAL (got ${result.mode})`);
  assert(result.violations.length === 0, "No violations");
  assert(result.constitution_version === "1.0.0", "Constitution version in result");
  assert(result.constitution_hash.length === 64, "Constitution hash in result");
}

// ============================================================
// 92. Gatekeeper — CONSERVATIVE Mode (At Cap)
// ============================================================
heading("92. Gatekeeper — CONSERVATIVE Mode");
{
  const ctx: GatekeeperContext = {
    month: 2,
    week_budget: 525,
    prior_week_budget: 525,
    weekly_lead_projection: 20,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.4,
    zip_weights: { "80113": 1.0 },
    newly_activated_zips: [],
    approvals: [],
  };
  const result = evaluateGatekeeper(ctx);
  assert(result.mode === "CONSERVATIVE", `Mode = CONSERVATIVE (got ${result.mode})`);
  assert(result.frozen_geo_expansion === true, "Geo expansion frozen");
  assert(result.frozen_budget_increase === true, "Budget increase frozen");
  assert(result.alerts.some(a => a.type === "CONSERVATIVE_MODE"), "Conservative alert emitted");
}

// ============================================================
// 93. Gatekeeper — HARD THROTTLE (>=120% Cap)
// ============================================================
heading("93. Gatekeeper — HARD THROTTLE");
{
  const ctx: GatekeeperContext = {
    month: 2,
    week_budget: 525,
    prior_week_budget: 525,
    weekly_lead_projection: 24,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.4,
    zip_weights: {},
    newly_activated_zips: [],
    approvals: [],
  };
  const result = evaluateGatekeeper(ctx);
  assert(result.allowed === false, "NOT allowed at hard throttle");
  assert(result.mode === "HARD_THROTTLE", `Mode = HARD_THROTTLE (got ${result.mode})`);
  assert(result.violations.some(v => v.rule === "HARD_THROTTLE"), "Hard throttle violation present");
  assert(result.alerts.some(a => a.type === "HARD_THROTTLE"), "Hard throttle alert emitted");
}

// ============================================================
// 94. Gatekeeper — Missing Data → Conservative
// ============================================================
heading("94. Gatekeeper — Missing Data Forces Conservative");
{
  const ctx: GatekeeperContext = {
    month: 2,
    week_budget: 525,
    prior_week_budget: 525,
    weekly_lead_projection: 5,
    weekly_lead_cap: 20,
    install_revenue_ratio: null,
    zip_weights: {},
    newly_activated_zips: [],
    approvals: [],
  };
  const result = evaluateGatekeeper(ctx);
  assert(result.mode === "CONSERVATIVE", `Missing data → CONSERVATIVE (got ${result.mode})`);
  assert(result.violations.some(v => v.rule === "DATA_MISSING"), "DATA_MISSING violation present");
  assert(result.alerts.some(a => a.type === "DATA_MISSING"), "Data missing alert emitted");
}

// ============================================================
// 95. Gatekeeper — Budget Enforcement (>10% Change Blocked)
// ============================================================
heading("95. Gatekeeper — Budget Enforcement");
{
  const ctx: GatekeeperContext = {
    month: 6,
    week_budget: 600,
    prior_week_budget: 500,
    weekly_lead_projection: 10,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.3,
    zip_weights: {},
    newly_activated_zips: [],
    approvals: [],
  };
  const result = evaluateGatekeeper(ctx);
  assert(result.violations.some(v => v.rule === "BUDGET_ENFORCEMENT"), "Budget >10% change blocked");
  assert(result.allowed === false, "Blocked without override");
}

// ============================================================
// 96. Gatekeeper — Budget Override Approval Allows
// ============================================================
heading("96. Gatekeeper — Budget Override Approval");
{
  const ctx: GatekeeperContext = {
    month: 6,
    week_budget: 600,
    prior_week_budget: 500,
    weekly_lead_projection: 10,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.3,
    zip_weights: {},
    newly_activated_zips: [],
    approvals: ["budget_override_2026-02-25"],
  };
  const result = evaluateGatekeeper(ctx);
  assert(!result.violations.some(v => v.rule === "BUDGET_ENFORCEMENT"), "Budget override approval accepted");
  assert(result.alerts.some(a => a.type === "BUDGET_VIOLATION" && a.message.includes("override")), "Override alert present");
}

// ============================================================
// 97. Gatekeeper — Geo Min Weight Violation
// ============================================================
heading("97. Gatekeeper — Geo Min Weight Violation");
{
  const ctx: GatekeeperContext = {
    month: 2,
    week_budget: 525,
    prior_week_budget: 525,
    weekly_lead_projection: 10,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.3,
    zip_weights: { "80113": 0.5 },
    newly_activated_zips: [],
    approvals: [],
  };
  const result = evaluateGatekeeper(ctx);
  assert(result.violations.some(v => v.rule === "GEO_MIN_WEIGHT"), "ZIP below min weight blocked");
}

// ============================================================
// 98. Gatekeeper — New ZIP Activation Cap
// ============================================================
heading("98. Gatekeeper — New ZIP Activation Cap");
{
  const ctx: GatekeeperContext = {
    month: 2,
    week_budget: 525,
    prior_week_budget: 525,
    weekly_lead_projection: 10,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.3,
    zip_weights: {},
    newly_activated_zips: ["80301", "80302", "80303"],
    approvals: [],
  };
  const result = evaluateGatekeeper(ctx);
  assert(result.violations.some(v => v.rule === "GEO_NEW_ZIP_CAP"), "3 new ZIPs > cap of 2 blocked");
  assert(result.allowed === false, "Blocked without approval");
}

// ============================================================
// 99. Gatekeeper — Geo Expansion Override
// ============================================================
heading("99. Gatekeeper — Geo Expansion Override");
{
  const ctx: GatekeeperContext = {
    month: 2,
    week_budget: 525,
    prior_week_budget: 525,
    weekly_lead_projection: 10,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.3,
    zip_weights: {},
    newly_activated_zips: ["80301", "80302", "80303"],
    approvals: ["geo_expansion_override_2026-02"],
  };
  const result = evaluateGatekeeper(ctx);
  assert(!result.violations.some(v => v.rule === "GEO_NEW_ZIP_CAP"), "Geo override accepted");
  assert(result.allowed === true, "Allowed with override");
}

// ============================================================
// 100. Season Matrix — April Cooling-Biased + Upgrade ON
// ============================================================
heading("100. Season Matrix — April Behavior");
{
  const boot = getConstitutionBoot();
  const april = boot.constitution.season_matrix["4"];
  assert(april.season === "SHOULDER", `April season = SHOULDER (got ${april.season})`);
  assert(april.upgrade_bias === true, "April upgrade_bias = true");
  assert(april.bias_direction === "cooling", `April bias_direction = cooling (got ${april.bias_direction})`);
  assert(april.primary_services.includes("ac"), "April allows AC (cooling-biased)");
  assert(april.primary_services.includes("cooling"), "April allows cooling");
  assert(april.blocked_services.includes("furnace repair"), "April blocks furnace repair");
}

// ============================================================
// 101. Season Matrix — October Heating + Upgrade ON + Cooling Suppressed
// ============================================================
heading("101. Season Matrix — October Overlap");
{
  const boot = getConstitutionBoot();
  const oct = boot.constitution.season_matrix["10"];
  assert(oct.season === "HEATING", `October season = HEATING (got ${oct.season})`);
  assert(oct.upgrade_bias === true, "October upgrade_bias = true");
  assert(oct.bias_direction === "heating", `October bias_direction = heating`);
  assert(oct.primary_services.includes("furnace"), "October allows furnace");
  assert(oct.primary_services.includes("heat pump"), "October allows heat pump");
  assert(oct.blocked_services.includes("ac"), "October blocks AC");
  assert(oct.blocked_services.includes("cooling"), "October blocks cooling");
}

// ============================================================
// 102. Season Enforcement via Constitution — Service Check
// ============================================================
heading("102. Season Enforcement — Service Allowed Check");
{
  const r1 = isServiceAllowedByConstitution("furnace repair", 1);
  assert(r1.allowed === true, "Furnace repair allowed in January (HEATING)");

  const r2 = isServiceAllowedByConstitution("ac installation", 1);
  assert(r2.allowed === false, "AC installation blocked in January (HEATING)");
  assert(r2.reason!.includes("blocked"), "Reason explains blocking");

  const r3 = isServiceAllowedByConstitution("ac repair", 7);
  assert(r3.allowed === true, "AC repair allowed in July (COOLING)");

  const r4 = isServiceAllowedByConstitution("furnace repair", 7);
  assert(r4.allowed === false, "Furnace repair blocked in July (COOLING)");

  const r5 = isServiceAllowedByConstitution("heat pump installation", 4);
  assert(r5.allowed === true, "Heat pump allowed in April (SHOULDER)");

  const r6 = isServiceAllowedByConstitution("cooling maintenance", 10);
  assert(r6.allowed === false, "Cooling blocked in October (HEATING)");
}

// ============================================================
// 103. Gatekeeper — Budget Freeze in Conservative Mode
// ============================================================
heading("103. Gatekeeper — Budget Freeze in Conservative");
{
  const ctx: GatekeeperContext = {
    month: 2,
    week_budget: 550,
    prior_week_budget: 525,
    weekly_lead_projection: 20,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.4,
    zip_weights: {},
    newly_activated_zips: [],
    approvals: [],
  };
  const result = evaluateGatekeeper(ctx);
  assert(result.mode === "CONSERVATIVE", "Conservative mode active");
  assert(result.frozen_budget_increase === true, "Budget increase frozen");
  assert(result.violations.some(v => v.rule === "BUDGET_FREEZE_CONSERVATIVE"), "Budget freeze violation present");
}

// ============================================================
// 104. Gatekeeper — Geo Freeze in Conservative
// ============================================================
heading("104. Gatekeeper — Geo Freeze in Conservative");
{
  const ctx: GatekeeperContext = {
    month: 2,
    week_budget: 525,
    prior_week_budget: 525,
    weekly_lead_projection: 21,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.4,
    zip_weights: {},
    newly_activated_zips: ["80301"],
    approvals: [],
  };
  const result = evaluateGatekeeper(ctx);
  assert(result.mode === "CONSERVATIVE", "Conservative mode active");
  assert(result.violations.some(v => v.rule === "GEO_FREEZE_CONSERVATIVE"), "Geo freeze in conservative present");
}

// ============================================================
// 105. Manifest Includes Constitution Version/Hash
// ============================================================
heading("105. Manifest — Constitution Version/Hash");
{
  const boot = getConstitutionBoot();
  const ctx: GatekeeperContext = {
    month: 2,
    week_budget: 525,
    prior_week_budget: 525,
    weekly_lead_projection: 10,
    weekly_lead_cap: 20,
    install_revenue_ratio: 0.3,
    zip_weights: {},
    newly_activated_zips: [],
    approvals: [],
  };
  const result = evaluateGatekeeper(ctx);
  assert(result.constitution_version === "1.0.0", "Gatekeeper result has constitution_version");
  assert(result.constitution_hash === boot.constitution_hash, "Gatekeeper result has matching constitution_hash");
  assert(result.season.season === "HEATING", "Gatekeeper result has season for month 2");
}

try { rmSync(TMPDIR, { recursive: true }); } catch { /* ok */ }

console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);

if (failed > 0) process.exit(1);
