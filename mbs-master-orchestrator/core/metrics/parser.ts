import { readFileSync, existsSync } from "fs";
import type { GSCPageRow, GSCQueryRow, MetricSnapshot, ToolEnvelope } from "../../types/index.js";
import { todayISO } from "../../utils/index.js";

// ============================================================
// Generic CSV Parser
// ============================================================

function parseCSV(raw: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    // Handle quoted fields with commas inside
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
    rows.push(row);
  }

  return { headers, rows };
}

// ============================================================
// GSC Pages Parser
// ============================================================

export function parseGSCPages(csvPath: string): ToolEnvelope<GSCPageRow[]> {
  if (!existsSync(csvPath)) {
    return { status: "FAILED", error: { code: "METRICS_CSV_NOT_FOUND", message: `File not found: ${csvPath}` } };
  }

  const raw = readFileSync(csvPath, "utf-8");
  const { headers, rows } = parseCSV(raw);

  if (rows.length === 0) {
    return { status: "FAILED", error: { code: "METRICS_CSV_EMPTY", message: "CSV has no data rows" } };
  }

  // Map flexible column names
  const colMap = resolveColumns(headers, {
    page: ["page", "url", "landing_page", "pages"],
    impressions: ["impressions", "impr"],
    clicks: ["clicks", "click"],
    ctr: ["ctr", "click_through_rate"],
    position: ["position", "avg_position", "average_position", "pos"],
  });

  const results: GSCPageRow[] = [];
  for (const row of rows) {
    const page = row[colMap.page] || "";
    const impressions = parseNum(row[colMap.impressions]);
    const clicks = parseNum(row[colMap.clicks]);
    const rawCTR = row[colMap.ctr] || "";
    const ctr = rawCTR.includes("%") ? parseFloat(rawCTR) / 100 : parseNum(rawCTR);
    const position = parseNum(row[colMap.position]);

    if (page) {
      results.push({ page, impressions, clicks, ctr, position });
    }
  }

  // Sort by clicks desc
  results.sort((a, b) => b.clicks - a.clicks);

  return { status: "EXECUTED", data: results };
}

// ============================================================
// GSC Queries Parser
// ============================================================

export function parseGSCQueries(csvPath: string): ToolEnvelope<GSCQueryRow[]> {
  if (!existsSync(csvPath)) {
    return { status: "FAILED", error: { code: "METRICS_CSV_NOT_FOUND", message: `File not found: ${csvPath}` } };
  }

  const raw = readFileSync(csvPath, "utf-8");
  const { headers, rows } = parseCSV(raw);

  if (rows.length === 0) {
    return { status: "FAILED", error: { code: "METRICS_CSV_EMPTY", message: "CSV has no data rows" } };
  }

  const colMap = resolveColumns(headers, {
    query: ["query", "keyword", "search_query", "queries", "top_queries"],
    impressions: ["impressions", "impr"],
    clicks: ["clicks", "click"],
    ctr: ["ctr", "click_through_rate"],
    position: ["position", "avg_position", "average_position", "pos"],
  });

  const results: GSCQueryRow[] = [];
  for (const row of rows) {
    const query = row[colMap.query] || "";
    const impressions = parseNum(row[colMap.impressions]);
    const clicks = parseNum(row[colMap.clicks]);
    const rawCTR = row[colMap.ctr] || "";
    const ctr = rawCTR.includes("%") ? parseFloat(rawCTR) / 100 : parseNum(rawCTR);
    const position = parseNum(row[colMap.position]);

    if (query) {
      results.push({ query, impressions, clicks, ctr, position });
    }
  }

  results.sort((a, b) => b.clicks - a.clicks);

  return { status: "EXECUTED", data: results };
}

// ============================================================
// Build MetricSnapshot from parsed data
// ============================================================

export function buildSnapshot(
  pages: GSCPageRow[],
  queries: GSCQueryRow[],
  date?: string
): MetricSnapshot {
  const totalImpressions = pages.reduce((s, p) => s + p.impressions, 0);
  const totalClicks = pages.reduce((s, p) => s + p.clicks, 0);
  const totalCTR = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
  const avgPosition = pages.length > 0
    ? pages.reduce((s, p) => s + p.position * p.impressions, 0) / Math.max(totalImpressions, 1)
    : 0;

  // indexedPages = count of unique pages with at least 1 impression
  const indexedPages = pages.filter((p) => p.impressions > 0).length;

  return {
    date: date || todayISO(),
    source: "gsc",
    indexedPages,
    topPages: pages.slice(0, 50),
    topQueries: queries.slice(0, 50),
    totals: {
      impressions: totalImpressions,
      clicks: totalClicks,
      ctr: Math.round(totalCTR * 10000) / 10000,
      avgPosition: Math.round(avgPosition * 100) / 100,
    },
  };
}

// ============================================================
// Utilities
// ============================================================

function resolveColumns(
  headers: string[],
  mapping: Record<string, string[]>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, candidates] of Object.entries(mapping)) {
    const found = headers.find((h) => candidates.includes(h));
    result[key] = found || candidates[0];
  }
  return result;
}

function parseNum(val: string | undefined): number {
  if (!val) return 0;
  const cleaned = val.replace(/[,%]/g, "").trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}
