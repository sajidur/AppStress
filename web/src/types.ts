// Types shared with the server (type-only imports, erased at build time).
export type {
  Extractor,
  Step,
  Workflow,
  TestSettings,
  Threshold,
  ThresholdResult,
  ThresholdMetric,
  ThresholdOp,
  Verdict,
  UsersMode,
  RunConfig,
} from '../../src/types';
export type { BuildReport } from '../../src/builder/builder';
export type { RunStats, StepStats, TimelinePoint } from '../../src/metrics/stats';
export type { RunProgress, WorkerInfo } from '../../src/distributed/controller';
export type { StepTrace } from '../../src/engine/executor';
export type { ExchangeSummary } from '../../src/recorder/recorder';
export type { BuildOptionsInput, RunRow, RunStatus, RunSummary, TestRow, DatasetRow } from '../../src/server/db';

import type { DatasetRow, RunRow, TestRow } from '../../src/server/db';
import type { RunProgress, WorkerInfo } from '../../src/distributed/controller';
import type { RunStats } from '../../src/metrics/stats';
import type { StepTrace } from '../../src/engine/executor';
import type { ExchangeSummary } from '../../src/recorder/recorder';
import type { Verdict } from '../../src/types';

export interface TestListItem {
  id: string;
  name: string;
  description: string;
  startUrl: string;
  updatedAt: number;
  hasWorkflow: boolean;
  stepCount: number;
  users: number;
  recordedRequests: number;
  runCount: number;
  lastVerdict: Verdict | null;
  lastRunAt: number | null;
}

export interface TestDetails extends TestRow {
  recording: { source: string; createdAt: number; exchangeCount: number; apiCount: number } | null;
  recordingActive: boolean;
  dataset: DatasetRow | null;
  activeRuns: string[];
}

export interface RecordingView {
  source: string;
  createdAt: number;
  startUrl: string;
  exchanges: ExchangeSummary[];
}

export interface DatasetView extends DatasetRow {
  preview: Record<string, string>[];
}

export interface ValidationResult {
  passed: boolean;
  traces: (StepTrace & { phase: string })[];
  user: Record<string, string> | null;
  userIndex: number | null;
}

export interface RunDetails extends RunRow {
  stats: RunStats | null;
  progress: RunProgress | null;
}

export interface SystemStatus {
  mode: 'memory' | 'distributed';
  redis: { ok: boolean };
  rabbitmq: { ok: boolean; messages?: number; consumers?: number; error?: string };
  workers: WorkerInfo[];
  capacity: number;
  embeddedWorker: { id: string; connected: boolean; activeVus: number; concurrency: number } | null;
  recorderHeadless: boolean;
  recorderEnabled: boolean;
}
