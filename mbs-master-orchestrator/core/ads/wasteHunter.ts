/**
 * MBS Master Orchestrator — Waste Hunter
 * Parses Google Ads search terms CSV and identifies waste:
 * - High spend / zero conversion terms
 * - Irrelevant terms (jobs, DIY, parts, manuals, wholesale)
 * Outputs negative keyword recommendations + match-type tightening suggestions.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import type {
  SearchTermRow, WasteTermRecommendation, WasteHunterOutput, ToolEnvelope,
} from "../../types/index.js";
import { nowISO, writeJSON, writeText, ensureDir } from "../../utils/index.js";

const ROOT = process.cwd();

// ============================================================
// Irrelevant term patterns
// ============================================================

const IRRELEVANT_CATEGORIES: Record<string, string[]> = {
  jobs: ["job", "jobs", "career", "careers", "hiring", "salary", "technician jobs", "employment", "work for", "apprentice"],
  diy: ["diy", "how to fix", "how to repair", "tutorial", "guide", "youtube", "video", "instructions", "step by step"],
  parts: ["parts", "part number", "oem", "component"],
  manuals: ["manual", "manual pdf", "schematic", "wiring diagram", "spec sheet", "specifications", "model number"],
  wholesale: ["wholesale", "bulk", "commercial", "industrial", "contractor supply", "trade", "supplier", "distributor"],
  education: ["school", "training", "course", "certification", "license", "class", "degree", "program"],
  reviews: ["reviews", "review", "best brands", "comparison", "vs", "ratings", "consumer reports"],
};

// ============================================================
// CSV Parser
// ============================================================

/**
 * Parse Google Ads search terms CSV.
 * Expected columns: Search term, Campaign, Ad group, Impressions, Clicks, Cost, Conversions
 */
export function parseSearchTermsCSV(csvPath: string): ToolEnvelope<SearchTermRow[]> {
  if (!existsSync(csvPath)) {
    return { status: "FAILED", error: { code: "WASTE_CSV_NOT_FOUND", message: `File not found: ${csvPath}` } };
  }

  const raw = readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { status: "FAILED", error: { code: "WASTE_CSV_EMPTY", message: "Search terms CSV has no data rows" } };
  }

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));

  const termCol = headers.find((h) => ["search_term", "search_query", "query", "term"].includes(h)) || headers[0];
  const campCol = headers.find((h) => ["campaign", "campaign_name"].includes(h));
  const groupCol = headers.find((h) => ["ad_group", "adgroup", "ad_group_name"].includes(h));
  const imprCol = headers.find((h) => ["impressions", "impr"].includes(h));
  const clickCol = headers.find((h) => ["clicks"].includes(h));
  const costCol = headers.find((h) => ["cost", "spend", "cost_(usd)"].includes(h));
  const convCol = headers.find((h) => ["conversions", "conv", "conv."].includes(h));

  const results: SearchTermRow[] = [];

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

    const searchTerm = row[termCol] || "";
    if (!searchTerm) continue;

    results.push({
      searchTerm,
      campaign: campCol ? row[campCol] : undefined,
      adGroup: groupCol ? row[groupCol] : undefined,
      impressions: parseInt(row[imprCol || ""] || "0", 10) || 0,
      clicks: parseInt(row[clickCol || ""] || "0", 10) || 0,
      cost: parseFloat(row[costCol || ""] || "0") || 0,
      conversions: parseFloat(row[convCol || ""] || "0") || 0,
    });
  }

  return { status: "EXECUTED", data: results };
}

// ============================================================
// Classification
// ============================================================

/**
 * Classify a search term against irrelevant categories.
 * Returns the category name or null if not irrelevant.
 */
export function classifyTerm(term: string): string | null {
  const lower = term.toLowerCase();
  for (const [category, patterns] of Object.entries(IRRELEVANT_CATEGORIES)) {
    if (patterns.some((p) => lower.includes(p))) {
      return category;
    }
  }
  return null;
}

/**
 * Check if a term is high-spend / zero-conversion waste.
 * Threshold: spent > $20 with 0 conversions.
 */
export function isHighSpendZeroConv(row: SearchTermRow, spendThreshold: number = 20): boolean {
  return row.cost > spendThreshold && row.conversions === 0;
}

/**
 * Determine if a term should get match-type tightening.
 * Terms with moderate spend, some conversions, but low conversion rate.
 * Suggests moving from broad to phrase or exact match.
 */
export function shouldTightenMatch(row: SearchTermRow): boolean {
  if (row.clicks < 5) return false;
  const convRate = row.conversions / row.clicks;
  // Low conversion rate (< 5%) with meaningful clicks → tighten
  return convRate < 0.05 && row.cost > 30;
}

// ============================================================
// Analysis
// ============================================================

/**
 * Analyze all search terms and produce waste recommendations.
 */
export function analyzeSearchTerms(terms: SearchTermRow[]): WasteHunterOutput {
  const negativeRecs: WasteTermRecommendation[] = [];
  const tightenRecs: WasteTermRecommendation[] = [];
  let totalWastedSpend = 0;
  let highSpendZeroConv = 0;
  let irrelevantCount = 0;

  for (const term of terms) {
    // Check irrelevant first (always add as negative)
    const category = classifyTerm(term.searchTerm);
    if (category) {
      negativeRecs.push({
        term: term.searchTerm,
        reason: "irrelevant",
        action: "add_negative",
        matchType: "phrase",
        spend: term.cost,
        clicks: term.clicks,
        conversions: term.conversions,
        category,
      });
      totalWastedSpend += term.cost;
      irrelevantCount++;
      continue;
    }

    // Check high spend / zero conversions
    if (isHighSpendZeroConv(term)) {
      negativeRecs.push({
        term: term.searchTerm,
        reason: "high_spend_zero_conv",
        action: "add_negative",
        matchType: "exact",
        spend: term.cost,
        clicks: term.clicks,
        conversions: term.conversions,
      });
      totalWastedSpend += term.cost;
      highSpendZeroConv++;
      continue;
    }

    // Check match-type tightening
    if (shouldTightenMatch(term)) {
      tightenRecs.push({
        term: term.searchTerm,
        reason: "low_relevance",
        action: "tighten_match",
        matchType: "exact",
        spend: term.cost,
        clicks: term.clicks,
        conversions: term.conversions,
      });
    }
  }

  return {
    timestamp: nowISO(),
    totalTermsAnalyzed: terms.length,
    negativeRecommendations: negativeRecs,
    matchTypeTightenings: tightenRecs,
    summary: {
      totalWastedSpend: Math.round(totalWastedSpend * 100) / 100,
      highSpendZeroConv,
      irrelevantTerms: irrelevantCount,
      tightenSuggestions: tightenRecs.length,
    },
  };
}

// ============================================================
// File output
// ============================================================

/**
 * Run waste hunter on search terms CSV and write output files.
 */
export function runWasteHunter(csvPath?: string): ToolEnvelope<WasteHunterOutput> {
  const path = csvPath || join(ROOT, "metrics/import/search-terms.csv");
  const parseResult = parseSearchTermsCSV(path);
  if (parseResult.status !== "EXECUTED" || !parseResult.data) {
    return { status: parseResult.status, error: parseResult.error };
  }

  const output = analyzeSearchTerms(parseResult.data);

  // Write output files
  const outDir = resolve(ROOT, "ads");
  ensureDir(outDir);
  writeJSON(join(outDir, "waste_hunter_recommendations.json"), output);

  // Human-readable summary
  const lines: string[] = [
    "# Waste Hunter Report",
    "",
    `**Generated:** ${output.timestamp}`,
    `**Terms Analyzed:** ${output.totalTermsAnalyzed}`,
    `**Total Wasted Spend:** $${output.summary.totalWastedSpend.toFixed(2)}`,
    "",
    `| Category | Count |`,
    `|---|---|`,
    `| High spend / zero conv | ${output.summary.highSpendZeroConv} |`,
    `| Irrelevant terms | ${output.summary.irrelevantTerms} |`,
    `| Match-type tightening | ${output.summary.tightenSuggestions} |`,
    "",
  ];

  if (output.negativeRecommendations.length > 0) {
    lines.push("## Negative Keyword Recommendations", "");
    lines.push("| Term | Reason | Match Type | Spend | Clicks | Conv |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of output.negativeRecommendations) {
      lines.push(`| ${r.term} | ${r.reason}${r.category ? ` (${r.category})` : ""} | ${r.matchType} | $${r.spend.toFixed(2)} | ${r.clicks} | ${r.conversions} |`);
    }
    lines.push("");
  }

  if (output.matchTypeTightenings.length > 0) {
    lines.push("## Match-Type Tightening Suggestions", "");
    lines.push("| Term | Current Spend | Conv Rate | Suggested |");
    lines.push("|---|---|---|---|");
    for (const r of output.matchTypeTightenings) {
      const cvr = r.clicks > 0 ? ((r.conversions / r.clicks) * 100).toFixed(1) : "0.0";
      lines.push(`| ${r.term} | $${r.spend.toFixed(2)} | ${cvr}% | → ${r.matchType} |`);
    }
    lines.push("");
  }

  lines.push("---", "", "**⚠️ Review before applying.** Add negatives in Google Ads campaign settings.");
  writeText(join(outDir, "waste_hunter_summary.md"), lines.join("\n"));

  return { status: "EXECUTED", data: output };
}
