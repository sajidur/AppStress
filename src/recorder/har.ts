import type { RecordedExchange, Recording } from '../types.js';

interface HarHeader {
  name: string;
  value: string;
}
interface HarEntry {
  startedDateTime: string;
  time: number;
  _resourceType?: string;
  pageref?: string;
  request: { method: string; url: string; headers: HarHeader[]; postData?: { text?: string; mimeType?: string } };
  response: { status: number; headers: HarHeader[]; content?: { text?: string; mimeType?: string; encoding?: string } };
}
interface Har {
  log: { pages?: { id: string; title: string }[]; entries: HarEntry[] };
}

const headerMap = (list: HarHeader[]) => {
  const out: Record<string, string> = {};
  for (const h of list) {
    const k = h.name.toLowerCase();
    out[k] = out[k] ? `${out[k]}\n${h.value}` : h.value;
  }
  return out;
};

function guessResourceType(e: HarEntry): string {
  if (e._resourceType) return e._resourceType;
  const mime = e.response.content?.mimeType ?? '';
  if (/html/.test(mime)) return 'document';
  if (/json|xml|text\/plain/.test(mime)) return 'fetch';
  return 'other';
}

/** Convert a browser-exported HAR (DevTools > Network > Save all as HAR) to a Recording. */
export function harToRecording(har: Har, userFields: Record<string, string> = {}): Recording {
  const entries = har.log.entries;
  const pageTitles = new Map((har.log.pages ?? []).map((p) => [p.id, p.title]));
  const exchanges: RecordedExchange[] = entries.map((e, i) => {
    const content = e.response.content;
    let body = content?.text;
    if (body && content?.encoding === 'base64') body = Buffer.from(body, 'base64').toString('utf8');
    return {
      id: i + 1,
      startedAt: Date.parse(e.startedDateTime),
      durationMs: Math.round(e.time),
      pageUrl: (e.pageref && pageTitles.get(e.pageref)) || '',
      resourceType: guessResourceType(e),
      request: {
        method: e.request.method,
        url: e.request.url,
        headers: headerMap(e.request.headers),
        postData: e.request.postData?.text,
      },
      response: { status: e.response.status, headers: headerMap(e.response.headers), body, mimeType: content?.mimeType },
    };
  });
  exchanges.sort((a, b) => a.startedAt - b.startedAt);
  const first = exchanges.find((x) => x.resourceType === 'document') ?? exchanges[0];
  return {
    version: 1,
    startUrl: first?.request.url ?? '',
    recordedAt: new Date().toISOString(),
    navigations: [],
    exchanges,
    userFields,
  };
}
