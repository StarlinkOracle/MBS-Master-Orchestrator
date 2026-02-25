import { resolve, join } from "path";
import { existsSync, readdirSync } from "fs";
import type { MetricSnapshot, ToolEnvelope } from "../../types/index.js";
import { writeJSON, readJSON, ensureDir, todayISO, safeReadJSON } from "../../utils/index.js";
import { parseGSCPages, parseGSCQueries, buildSnapshot } from "./parser.js";
import {
  loadConversionConfig, parseGA4Events, loadManualKPIs,
  aggregateConversions, aggregateManualConversions,
} from "./conversions.js";

const ROOT = process.cwd();
const IMPORT_DIR = resolve(ROOT, "metrics/import");
const SNAPSHOTS_DIR = resolve(ROOT, "metrics/snapshots");

/**
 * Import CSVs from metrics/import/, build a snapshot, store it.
 * Convention:
 *   metrics/import/gsc-pages.csv
 *   metrics/import/gsc-queries.csv
 *   metrics/import/ga4-events.csv     (optional — conversion data)
 *   metrics/import/manual-kpis.json   (optional — fallback if no GA4)
 */
export function importMetrics(date?: string): ToolEnvelope<MetricSnapshot> {
  const snapshotDate = date || todayISO();
  const pagesPath = join(IMPORT_DIR, "gsc-pages.csv");
  const queriesPath = join(IMPORT_DIR, "gsc-queries.csv");
  const ga4Path = join(IMPORT_DIR, "ga4-events.csv");

  const hasPages = existsSync(pagesPath);
  const hasQueries = existsSync(queriesPath);

  if (!hasPages && !hasQueries) {
    return {
      status: "FAILED",
      error: {
        code: "METRICS_CSV_NOT_FOUND",
        message: `No CSV files found in ${IMPORT_DIR}. Expected gsc-pages.csv and/or gsc-queries.csv`,
      },
    };
  }

  let pages: import("../../types/index.js").GSCPageRow[] = [];
  let queries: import("../../types/index.js").GSCQueryRow[] = [];

  if (hasPages) {
    const pagesResult = parseGSCPages(pagesPath);
    if (pagesResult.status === "EXECUTED" && pagesResult.data) {
      pages = pagesResult.data;
    } else {
      return { status: "FAILED", error: pagesResult.error };
    }
  }

  if (hasQueries) {
    const queriesResult = parseGSCQueries(queriesPath);
    if (queriesResult.status === "EXECUTED" && queriesResult.data) {
      queries = queriesResult.data;
    } else {
      return { status: "FAILED", error: queriesResult.error };
    }
  }

  const snapshot = buildSnapshot(pages, queries, snapshotDate);

  // ---- Conversion ingestion: GA4 first, manual fallback ----
  const convConfig = loadConversionConfig();

  if (existsSync(ga4Path)) {
    const ga4Result = parseGA4Events(ga4Path);
    if (ga4Result.status === "EXECUTED" && ga4Result.data) {
      const conv = aggregateConversions(ga4Result.data, convConfig);
      snapshot.conversions = conv.totals;
      snapshot.topConversionPages = conv.pages;
      snapshot.source = "combined";
    }
  } else {
    // Fallback to manual-kpis.json
    const manual = loadManualKPIs();
    if (manual) {
      const conv = aggregateManualConversions(manual, convConfig);
      snapshot.conversions = conv.totals;
      snapshot.topConversionPages = conv.pages;
      snapshot.source = "combined";
    }
  }

  ensureDir(SNAPSHOTS_DIR);
  writeJSON(join(SNAPSHOTS_DIR, `${snapshotDate}.json`), snapshot);

  return { status: "EXECUTED", data: snapshot };
}

/**
 * Load the most recent snapshot, or a specific date.
 */
export function loadLatestSnapshot(): MetricSnapshot | null {
  if (!existsSync(SNAPSHOTS_DIR)) return null;

  const files = readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) return null;
  return safeReadJSON<MetricSnapshot>(join(SNAPSHOTS_DIR, files[0]), null as any);
}

export function loadSnapshot(date: string): MetricSnapshot | null {
  const filePath = join(SNAPSHOTS_DIR, `${date}.json`);
  return safeReadJSON<MetricSnapshot>(filePath, null as any);
}

/**
 * Load the two most recent snapshots for tie-breaker comparisons.
 */
export function loadRecentSnapshots(): { current: MetricSnapshot | null; previous: MetricSnapshot | null } {
  if (!existsSync(SNAPSHOTS_DIR)) return { current: null, previous: null };

  const files = readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const current = files.length > 0
    ? safeReadJSON<MetricSnapshot>(join(SNAPSHOTS_DIR, files[0]), null as any)
    : null;
  const previous = files.length > 1
    ? safeReadJSON<MetricSnapshot>(join(SNAPSHOTS_DIR, files[1]), null as any)
    : null;

  return { current, previous };
}
