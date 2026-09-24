import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BuildReport } from '../builder/builder.js';
import type { RunStats } from '../metrics/stats.js';
import type { CallSample, Recording, RunConfig, TestSettings, ThresholdResult, Verdict, Workflow } from '../types.js';

/* ------------------------------------------------------------------ row types */

export interface BuildOptionsInput {
  userFields: Record<string, string>;
  includeDocuments: boolean;
  /** request types that count as test steps (document, xhr, script, ...); overrides includeDocuments */
  resourceTypes?: string[];
  domains: string[];
  exclude: string[];
  minThinkMs: number;
  maxThinkMs: number;
  correlate: boolean;
  cacheLoginTtlSec?: number;
  keepTracking?: boolean;
}

export interface TestRow {
  id: string;
  name: string;
  description: string;
  startUrl: string;
  settings: TestSettings;
  workflow: Workflow | null;
  buildOptions: BuildOptionsInput | null;
  buildReport: BuildReport | null;
  createdAt: number;
  updatedAt: number;
}

export interface DatasetRow {
  filename: string;
  columns: string[];
  rowCount: number;
  createdAt: number;
}

export type RunStatus = 'starting' | 'running' | 'stopping' | 'completed' | 'stopped' | 'timeout' | 'failed';
export const ACTIVE_STATUSES: RunStatus[] = ['starting', 'running', 'stopping'];

export interface RunSummary {
  requests: number;
  errors: number;
  errorRate: number;
  rps: number;
  avgMs: number;
  p95: number;
  iterations: number;
  durationSec: number;
}

export interface RunRow {
  id: string;
  testId: string;
  testName?: string;
  status: RunStatus;
  verdict: Verdict | null;
  settings: TestSettings;
  config: RunConfig | null;
  summary: RunSummary | null;
  thresholds: ThresholdResult[] | null;
  error: string | null;
  triggeredBy: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/* ------------------------------------------------------------------ schema */

const MIGRATIONS: string[] = [
  `CREATE TABLE tests (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     start_url TEXT NOT NULL,
     settings TEXT NOT NULL,
     workflow TEXT,
     build_options TEXT,
     build_report TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE recordings (
     test_id TEXT PRIMARY KEY REFERENCES tests(id) ON DELETE CASCADE,
     data TEXT NOT NULL,
     exchange_count INTEGER NOT NULL,
     api_count INTEGER NOT NULL,
     source TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE datasets (
     test_id TEXT PRIMARY KEY REFERENCES tests(id) ON DELETE CASCADE,
     filename TEXT NOT NULL,
     columns TEXT NOT NULL,
     rows TEXT NOT NULL,
     row_count INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
     status TEXT NOT NULL,
     verdict TEXT,
     settings TEXT NOT NULL,
     workflow TEXT NOT NULL,
     config TEXT,
     summary TEXT,
     stats TEXT,
     thresholds TEXT,
     error TEXT,
     triggered_by TEXT NOT NULL DEFAULT 'ui',
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX runs_by_test ON runs(test_id, created_at DESC);
   CREATE INDEX runs_by_status ON runs(status);`,
  // full request/response details of sampled calls (JSON array of CallSample)
  `ALTER TABLE runs ADD COLUMN samples TEXT;`,
];

const json = <T>(v: unknown): T | null => (v === null || v === undefined ? null : (JSON.parse(String(v)) as T));

/** Persistent store (SQLite, built into Node) for tests, recordings, users files and run results. */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  close() {
    this.db.close();
  }

  /* ---------------------------------------------------------------- tests */

  private toTest(r: Record<string, unknown>): TestRow {
    return {
      id: String(r.id),
      name: String(r.name),
      description: String(r.description ?? ''),
      startUrl: String(r.start_url),
      settings: json<TestSettings>(r.settings)!,
      workflow: json<Workflow>(r.workflow),
      buildOptions: json<BuildOptionsInput>(r.build_options),
      buildReport: json<BuildReport>(r.build_report),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  listTests() {
    const rows = this.db
      .prepare(
        `SELECT t.*, d.row_count AS users, r.api_count AS recorded,
           (SELECT COUNT(*) FROM runs WHERE test_id = t.id) AS run_count,
           (SELECT verdict FROM runs WHERE test_id = t.id AND finished_at IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS last_verdict,
           (SELECT MAX(created_at) FROM runs WHERE test_id = t.id) AS last_run_at
         FROM tests t
         LEFT JOIN datasets d ON d.test_id = t.id
         LEFT JOIN recordings r ON r.test_id = t.id
         ORDER BY t.updated_at DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => {
      const t = this.toTest(r);
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        startUrl: t.startUrl,
        updatedAt: t.updatedAt,
        hasWorkflow: !!t.workflow,
        stepCount: t.workflow ? t.workflow.setup.length + t.workflow.steps.length : 0,
        users: r.users === null ? 0 : Number(r.users),
        recordedRequests: r.recorded === null ? 0 : Number(r.recorded),
        runCount: Number(r.run_count),
        lastVerdict: (r.last_verdict as Verdict | null) ?? null,
        lastRunAt: r.last_run_at === null ? null : Number(r.last_run_at),
      };
    });
  }

  getTest(id: string): TestRow | null {
    const r = this.db.prepare('SELECT * FROM tests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.toTest(r) : null;
  }

  createTest(t: Pick<TestRow, 'id' | 'name' | 'description' | 'startUrl' | 'settings'>): TestRow {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO tests (id, name, description, start_url, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.name, t.description, t.startUrl, JSON.stringify(t.settings), now, now);
    return this.getTest(t.id)!;
  }

  updateTest(id: string, patch: Partial<Pick<TestRow, 'name' | 'description' | 'startUrl' | 'settings' | 'workflow' | 'buildOptions' | 'buildReport'>>): TestRow | null {
    const cols: Record<string, string> = {
      name: 'name',
      description: 'description',
      startUrl: 'start_url',
      settings: 'settings',
      workflow: 'workflow',
      buildOptions: 'build_options',
      buildReport: 'build_report',
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      sets.push(`${cols[k]} = ?`);
      values.push(v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      values.push(Date.now(), id);
      this.db.prepare(`UPDATE tests SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    return this.getTest(id);
  }

  deleteTest(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM tests WHERE id = ?').run(id).changes) > 0;
  }

  touchTest(id: string) {
    this.db.prepare('UPDATE tests SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /* ---------------------------------------------------------------- recordings */

  saveRecording(testId: string, rec: Recording, apiCount: number, source: 'browser' | 'har' | 'import') {
    this.db
      .prepare(
        `INSERT INTO recordings (test_id, data, exchange_count, api_count, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(test_id) DO UPDATE SET data = excluded.data, exchange_count = excluded.exchange_count,
           api_count = excluded.api_count, source = excluded.source, created_at = excluded.created_at`,
      )
      .run(testId, JSON.stringify(rec), rec.exchanges.length, apiCount, source, Date.now());
    this.touchTest(testId);
  }

  getRecording(testId: string): { recording: Recording; source: string; createdAt: number } | null {
    const r = this.db.prepare('SELECT data, source, created_at FROM recordings WHERE test_id = ?').get(testId) as
      | Record<string, unknown>
      | undefined;
    return r ? { recording: JSON.parse(String(r.data)), source: String(r.source), createdAt: Number(r.created_at) } : null;
  }

  /* ---------------------------------------------------------------- datasets */

  saveDataset(testId: string, filename: string, columns: string[], rows: Record<string, string>[]) {
    this.db
      .prepare(
        `INSERT INTO datasets (test_id, filename, columns, rows, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(test_id) DO UPDATE SET filename = excluded.filename, columns = excluded.columns, rows = excluded.rows,
           row_count = excluded.row_count, created_at = excluded.created_at`,
      )
      .run(testId, filename, JSON.stringify(columns), JSON.stringify(rows), rows.length, Date.now());
    this.touchTest(testId);
  }

  getDatasetMeta(testId: string): DatasetRow | null {
    const r = this.db.prepare('SELECT filename, columns, row_count, created_at FROM datasets WHERE test_id = ?').get(testId) as
      | Record<string, unknown>
      | undefined;
    return r ? { filename: String(r.filename), columns: JSON.parse(String(r.columns)), rowCount: Number(r.row_count), createdAt: Number(r.created_at) } : null;
  }

  getDatasetRows(testId: string): Record<string, string>[] {
    const r = this.db.prepare('SELECT rows FROM datasets WHERE test_id = ?').get(testId) as Record<string, unknown> | undefined;
    return r ? JSON.parse(String(r.rows)) : [];
  }

  deleteDataset(testId: string) {
    this.db.prepare('DELETE FROM datasets WHERE test_id = ?').run(testId);
    this.touchTest(testId);
  }

  /* ---------------------------------------------------------------- runs */

  private toRun(r: Record<string, unknown>): RunRow {
    return {
      id: String(r.id),
      testId: String(r.test_id),
      testName: r.test_name === undefined ? undefined : String(r.test_name),
      status: r.status as RunStatus,
      verdict: (r.verdict as Verdict | null) ?? null,
      settings: json<TestSettings>(r.settings)!,
      config: json<RunConfig>(r.config),
      summary: json<RunSummary>(r.summary),
      thresholds: json<ThresholdResult[]>(r.thresholds),
      error: (r.error as string | null) ?? null,
      triggeredBy: String(r.triggered_by),
      createdAt: Number(r.created_at),
      startedAt: r.started_at === null ? null : Number(r.started_at),
      finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    };
  }

  createRun(r: { id: string; testId: string; settings: TestSettings; workflow: Workflow; triggeredBy: string }): RunRow {
    this.db
      .prepare('INSERT INTO runs (id, test_id, status, settings, workflow, triggered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.testId, 'starting', JSON.stringify(r.settings), JSON.stringify(r.workflow), r.triggeredBy, Date.now());
    this.touchTest(r.testId);
    return this.getRun(r.id)!;
  }

  updateRun(
    id: string,
    patch: Partial<{ status: RunStatus; verdict: Verdict; config: RunConfig; summary: RunSummary; stats: RunStats; samples: CallSample[]; thresholds: ThresholdResult[]; error: string; startedAt: number; finishedAt: number }>,
  ) {
    const cols: Record<string, string> = {
      status: 'status',
      verdict: 'verdict',
      config: 'config',
      summary: 'summary',
      stats: 'stats',
      samples: 'samples',
      thresholds: 'thresholds',
      error: 'error',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      values.push(typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v));
    }
    if (!sets.length) return;
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getRun(id: string): RunRow | null {
    const r = this.db
      .prepare('SELECT runs.*, tests.name AS test_name FROM runs JOIN tests ON tests.id = runs.test_id WHERE runs.id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return r ? this.toRun(r) : null;
  }

  getRunDetails(id: string): { stats: RunStats | null; workflow: Workflow } | null {
    const r = this.db.prepare('SELECT stats, workflow FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? { stats: json<RunStats>(r.stats), workflow: json<Workflow>(r.workflow)! } : null;
  }

  /** Calls kept with full request/response details, or [] when the run has none. */
  getRunSamples(id: string): CallSample[] {
    const r = this.db.prepare('SELECT samples FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return json<CallSample[]>(r?.samples) ?? [];
  }

  listRuns(filter: { testId?: string; limit?: number; statuses?: RunStatus[] } = {}): RunRow[] {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (filter.testId) {
      where.push('runs.test_id = ?');
      values.push(filter.testId);
    }
    if (filter.statuses?.length) {
      where.push(`runs.status IN (${filter.statuses.map(() => '?').join(', ')})`);
      values.push(...filter.statuses);
    }
    values.push(filter.limit ?? 100);
    const rows = this.db
      .prepare(
        `SELECT runs.id, runs.test_id, runs.status, runs.verdict, runs.settings, runs.config, runs.summary, runs.thresholds,
                runs.error, runs.triggered_by, runs.created_at, runs.started_at, runs.finished_at, tests.name AS test_name
         FROM runs JOIN tests ON tests.id = runs.test_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY runs.created_at DESC LIMIT ?`,
      )
      .all(...values) as Record<string, unknown>[];
    return rows.map((r) => this.toRun(r));
  }

  deleteRun(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM runs WHERE id = ?').run(id).changes) > 0;
  }
}
