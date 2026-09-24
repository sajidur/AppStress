import type {
  BuildOptionsInput,
  BuildReport,
  DatasetView,
  RecordingView,
  RunDetails,
  RunRow,
  SystemStatus,
  TestDetails,
  TestListItem,
  TestSettings,
  ValidationResult,
  Workflow,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the Load Test Studio server', 0);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  system: () => request<SystemStatus>('GET', '/system'),

  listTests: () => request<TestListItem[]>('GET', '/tests'),
  createTest: (b: { name: string; startUrl: string; description?: string }) => request<{ id: string }>('POST', '/tests', b),
  getTest: (id: string) => request<TestDetails>('GET', `/tests/${enc(id)}`),
  updateTest: (id: string, b: { name?: string; startUrl?: string; description?: string }) => request<TestDetails>('PATCH', `/tests/${enc(id)}`, b),
  deleteTest: (id: string) => request<void>('DELETE', `/tests/${enc(id)}`),
  duplicateTest: (id: string) => request<{ id: string }>('POST', `/tests/${enc(id)}/duplicate`),

  startRecording: (id: string, b: { url?: string; timeoutSec?: number }) => request<void>('POST', `/tests/${enc(id)}/recording/start`, b),
  stopRecording: (id: string) => request<void>('POST', `/tests/${enc(id)}/recording/stop`),
  getRecording: (id: string) => request<{ recording: RecordingView | null }>('GET', `/tests/${enc(id)}/recording`),
  importRecording: (id: string, content: string) =>
    request<{ exchangeCount: number; apiCount: number }>('POST', `/tests/${enc(id)}/recording/import`, { content }),
  recordingEventsUrl: (id: string) => `/api/tests/${enc(id)}/recording/events`,

  uploadUsers: (id: string, filename: string, content: string) =>
    request<{ filename: string; columns: string[]; rowCount: number }>('POST', `/tests/${enc(id)}/users`, { filename, content }),
  getUsers: (id: string, limit = 25) => request<{ dataset: DatasetView | null }>('GET', `/tests/${enc(id)}/users?limit=${limit}`),
  deleteUsers: (id: string) => request<void>('DELETE', `/tests/${enc(id)}/users`),

  suggestUserFields: (id: string) => request<{ userFields: Record<string, string> }>('GET', `/tests/${enc(id)}/workflow/suggest-user-fields`),
  buildWorkflow: (id: string, opts: BuildOptionsInput) => request<{ workflow: Workflow; report: BuildReport }>('POST', `/tests/${enc(id)}/workflow/build`, opts),
  saveWorkflow: (id: string, wf: Workflow) => request<{ workflow: Workflow }>('PUT', `/tests/${enc(id)}/workflow`, wf),
  validateWorkflow: (id: string, b: { userIndex: number; iterations: number }) => request<ValidationResult>('POST', `/tests/${enc(id)}/workflow/validate`, b),

  saveSettings: (id: string, s: TestSettings) => request<{ settings: TestSettings }>('PUT', `/tests/${enc(id)}/settings`, s),

  startRun: (id: string) => request<RunRow>('POST', `/tests/${enc(id)}/runs`, { triggeredBy: 'ui' }),
  listTestRuns: (id: string) => request<RunRow[]>('GET', `/tests/${enc(id)}/runs`),
  listRuns: (limit = 100) => request<RunRow[]>('GET', `/runs?limit=${limit}`),
  getRun: (id: string) => request<RunDetails>('GET', `/runs/${enc(id)}`),
  stopRun: (id: string) => request<void>('POST', `/runs/${enc(id)}/stop`),
  deleteRun: (id: string) => request<void>('DELETE', `/runs/${enc(id)}`),
  runEventsUrl: (id: string) => `/api/runs/${enc(id)}/events`,
  reportUrl: (id: string, kind: 'report.html' | 'report.json' | 'junit.xml') => `/api/runs/${enc(id)}/${kind}`,
};
