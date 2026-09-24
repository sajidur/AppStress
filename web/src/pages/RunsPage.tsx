import { api } from '../api';
import { RunsTable } from '../components/RunsTable';
import { Card, Empty, ErrorBox, Loading } from '../components/ui';
import { useAsync, useInterval } from '../hooks';

export function RunsPage() {
  const { data, error, loading, reload } = useAsync(() => api.listRuns(200), []);
  const anyActive = data?.some((r) => ['starting', 'running', 'stopping'].includes(r.status));
  useInterval(() => void reload(), anyActive ? 5000 : null);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Run history</h1>
          <div className="sub muted">All test runs across all tests, newest first.</div>
        </div>
      </div>
      {error && <ErrorBox error={error} retry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : (
        <Card bodyless>{data && data.length ? <RunsTable runs={data} showTest /> : <Empty title="No runs yet" />}</Card>
      )}
    </div>
  );
}
