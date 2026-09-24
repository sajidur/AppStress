import { useCallback, useEffect, useRef, useState } from 'react';

/** Load data asynchronously; `reload()` re-runs, `setData()` updates locally. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await fn();
      if (id === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(e as Error);
    } finally {
      if (id === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

/** Subscribe to a Server-Sent Events stream (auto-reconnects via EventSource). */
export function useEventStream<E>(url: string | null, onEvent: (e: E) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        handler.current(JSON.parse(m.data) as E);
      } catch {
        /* ignore malformed events */
      }
    };
    return () => {
      es.close();
      setConnected(false);
    };
  }, [url]);

  return connected;
}

export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => saved.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function readFileText(file: File): Promise<string> {
  return file.text();
}
