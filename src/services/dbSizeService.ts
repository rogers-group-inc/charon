/**
 * src/services/dbSizeService.ts — database sizing for the Maintenance tab.
 *
 * Ported from polaris (src/services/dbSizeService.ts), minus the TimescaleDB
 * chunk fold (Charon has no hypertables). All figures are catalog-only
 * (pg_class.relpages × block size) rather than pg_*_size(), so the route stays
 * fast and the numbers are accurate as of the last ANALYZE — which is why the
 * breakdown also reports never-analyzed relations.
 *
 * The total is split into buckets that sum to it by construction — Charon's
 * own tables (public schema, indexes + TOAST included), the pg-boss queue
 * schema, PostgreSQL's catalog, and everything else — so the Database card's
 * table list can account for the total instead of sitting under it.
 */

import { prisma } from "../db.js";

export interface TableSize {
  name: string;
  rows: number;
  bytes: number;
  chunkCount: number;
  compressedChunkCount: number;
}

export type TableSizing = "no-timescale";

export interface TableSizeResult {
  tables: TableSize[];
  sizing: TableSizing;
}

export interface DatabaseSizeBreakdown {
  totalBytes: number;
  /** Charon-owned bytes (public schema). Named polarisBytes for shape parity. */
  polarisBytes: number;
  pgbossBytes: number;
  catalogBytes: number;
  otherBytes: number;
  neverAnalyzedRelations: number;
  neverAnalyzedMissingBytes: number | null;
}

/** Owned pages of a table: heap + its indexes + TOAST (+ TOAST index). */
const OWNED_PAGES_JOINS_SQL = `
    LEFT JOIN LATERAL (
      SELECT SUM(i.relpages)::bigint AS pages
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
      WHERE x.indrelid = c.oid
    ) idx ON true
    LEFT JOIN LATERAL (
      SELECT (tc.relpages + COALESCE((
        SELECT SUM(ti.relpages)::bigint
        FROM pg_index tx JOIN pg_class ti ON ti.oid = tx.indexrelid
        WHERE tx.indrelid = tc.oid
      ), 0))::bigint AS pages
      FROM pg_class tc WHERE tc.oid = c.reltoastrelid
    ) tst ON true`;

/** Per-table sizes for the public schema, biggest first. */
export async function getTableSizes(): Promise<TableSizeResult> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; rows: bigint | number; pages: bigint | number; bs: number }>>(`
    SELECT c.relname AS name,
           GREATEST(COALESCE(s.n_live_tup, c.reltuples::bigint, 0), 0)::bigint AS rows,
           (c.relpages + COALESCE(idx.pages, 0) + COALESCE(tst.pages, 0))::bigint AS pages,
           current_setting('block_size')::int AS bs
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid${OWNED_PAGES_JOINS_SQL}
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pages DESC, c.relname`);
  return {
    sizing: "no-timescale",
    tables: rows.map((r) => ({
      name: r.name,
      rows: Number(r.rows),
      bytes: Number(r.pages) * Number(r.bs),
      chunkCount: 0,
      compressedChunkCount: 0,
    })),
  };
}

/** Pure: bucket rows → the breakdown (buckets sum to the total). */
export function summarizeBuckets(rows: Array<{ bucket: string; bytes: number }>): Omit<DatabaseSizeBreakdown, "neverAnalyzedRelations" | "neverAnalyzedMissingBytes"> {
  const by = (b: string) => rows.filter((r) => r.bucket === b).reduce((s, r) => s + r.bytes, 0);
  const polarisBytes = by("charon");
  const pgbossBytes = by("pgboss");
  const catalogBytes = by("catalog");
  const otherBytes = rows.filter((r) => !["charon", "pgboss", "catalog"].includes(r.bucket)).reduce((s, r) => s + r.bytes, 0);
  return { totalBytes: polarisBytes + pgbossBytes + catalogBytes + otherBytes, polarisBytes, pgbossBytes, catalogBytes, otherBytes };
}

/** The total, split into buckets — every relation counted once, by its owner's schema. */
export async function getDatabaseSizeBreakdown(): Promise<DatabaseSizeBreakdown> {
  const [bucketRows, never] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ bucket: string; bytes: bigint | number }>>(`
      WITH rels AS (
        SELECT c.relpages,
               COALESCE(tpn.nspname, itn.nspname, n.nspname) AS owner_ns
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_index x ON c.relkind = 'i' AND x.indexrelid = c.oid
        LEFT JOIN pg_class it ON it.oid = x.indrelid
        LEFT JOIN pg_namespace itn ON itn.oid = it.relnamespace
        LEFT JOIN pg_class tp ON c.relkind = 't' AND tp.reltoastrelid = c.oid
        LEFT JOIN pg_namespace tpn ON tpn.oid = tp.relnamespace
        WHERE c.relkind IN ('r', 'i', 't', 'm')
      )
      SELECT CASE
               WHEN owner_ns IN ('pg_catalog', 'information_schema') THEN 'catalog'
               WHEN owner_ns = 'pgboss' THEN 'pgboss'
               WHEN owner_ns = 'public' THEN 'charon'
               ELSE 'other'
             END AS bucket,
             (SUM(relpages)::bigint * current_setting('block_size')::bigint) AS bytes
      FROM rels GROUP BY 1`),
    // Relations nothing has ever ANALYZEd report relpages 0 regardless of
    // content; their real size is what the totals above are missing.
    prisma.$queryRawUnsafe<Array<{ relations: bigint | number; missing: bigint | number | null }>>(`
      SELECT count(*)::bigint AS relations,
             COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::bigint AS missing
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
      WHERE c.relkind = 'r' AND c.relpages = 0
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND s.last_analyze IS NULL AND s.last_autoanalyze IS NULL
        AND s.last_vacuum IS NULL AND s.last_autovacuum IS NULL`).catch(() => [{ relations: 0, missing: null }]),
  ]);
  const summary = summarizeBuckets(bucketRows.map((r) => ({ bucket: r.bucket, bytes: Number(r.bytes) })));
  const n = never[0];
  const missing = n?.missing == null ? null : Number(n.missing);
  return {
    ...summary,
    neverAnalyzedRelations: Number(n?.relations ?? 0),
    neverAnalyzedMissingBytes: missing,
  };
}

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + " GB";
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(1) + " KB";
  return b + " B";
}

/** "PostgreSQL 15.13 on x86_64-pc-linux-gnu, …" → "15.13". */
export function parsePostgresVersion(banner: string): string | null {
  return banner.match(/PostgreSQL\s+(\d+(?:\.\d+)?)/i)?.[1] ?? null;
}

/**
 * GET /server-settings/database — engine identity, connection state, size and
 * the per-table list with its size accounting (polaris response shape).
 */
export async function getDatabaseInfo() {
  const [versionResult, dbNameResult, breakdown, tableSizes, connResult, uptimeResult, sslResult] = await Promise.all([
    prisma.$queryRawUnsafe<{ version: string }[]>("SELECT version()"),
    prisma.$queryRawUnsafe<{ db: string }[]>("SELECT current_database() AS db"),
    getDatabaseSizeBreakdown(),
    getTableSizes(),
    prisma.$queryRawUnsafe<{ active: number; max: number }[]>(`
      SELECT (SELECT count(*)::integer FROM pg_stat_activity WHERE datname = current_database()) AS active,
             (SELECT setting::integer FROM pg_settings WHERE name = 'max_connections') AS max`),
    prisma.$queryRawUnsafe<{ uptime: string }[]>("SELECT date_trunc('second', current_timestamp - pg_postmaster_start_time())::text AS uptime"),
    prisma.$queryRawUnsafe<{ ssl: boolean }[]>("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()").catch(() => []),
  ]);

  const version = versionResult[0]?.version || "Unknown";
  const tables = tableSizes.tables.map((t) => ({
    name: t.name, rows: t.rows, sizeBytes: t.bytes, size: fmtBytes(t.bytes),
    chunkCount: t.chunkCount, compressedChunkCount: t.compressedChunkCount,
  }));
  const tablesBytes = tables.reduce((s, t) => s + t.sizeBytes, 0);

  // Host/port from the URL for display only — never the credentials.
  let host = "localhost";
  let port = 5432;
  try {
    const u = new URL(process.env.DATABASE_URL || "");
    host = u.hostname || host;
    port = u.port ? parseInt(u.port, 10) : 5432;
  } catch { /* defaults */ }

  return {
    type: "PostgreSQL",
    version: parsePostgresVersion(version) ?? version,
    host,
    port,
    database: dbNameResult[0]?.db || "unknown",
    // What the live backend negotiated, not what the URL asked for.
    ssl: sslResult[0]?.ssl ? "Enabled" : "Disabled",
    databaseSize: fmtBytes(breakdown.totalBytes),
    sizeBytes: breakdown.totalBytes,
    tableCount: tables.length,
    tables,
    sizeAccounting: {
      tablesBytes,
      sizing: tableSizes.sizing,
      unlisted: {
        pgbossBytes: breakdown.pgbossBytes,
        catalogBytes: breakdown.catalogBytes,
        otherBytes: breakdown.otherBytes,
        unattributedBytes: Math.max(0, breakdown.polarisBytes - tablesBytes),
      },
      neverAnalyzedRelations: breakdown.neverAnalyzedRelations,
      neverAnalyzedMissingBytes: breakdown.neverAnalyzedMissingBytes,
    },
    activeConnections: Number(connResult[0]?.active || 0),
    maxConnections: Number(connResult[0]?.max || 100),
    uptime: String(uptimeResult[0]?.uptime || "Unknown"),
  };
}
