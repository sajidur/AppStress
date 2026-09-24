import { createHash } from 'node:crypto';
import { escapeRegex } from '../util.js';

/**
 * Pages often send a value encoded (the user name as Base64, a password as a hash) and the server decodes it,
 * e.g. C#: Encoding.UTF8.GetString(Convert.FromBase64String(userName)). To replay that for every user the
 * encoded text has to be produced from each user's own value, so the recorded encoded text is recognised here.
 */

export interface EncodedForm {
  /** the encoded text as it appears in the request */
  text: string;
  /** filter chain that produces it from the plain value, e.g. "base64" or "sha256|upper" */
  filters: string;
  alphabet: 'base64' | 'hex';
}

/** Encoded forms of a plain value, longest first. Short values are only checked as hashes (too many false hits otherwise). */
export function encodedForms(value: string): EncodedForm[] {
  const forms: EncodedForm[] = [];
  const seen = new Set<string>([value]);
  const add = (text: string, filters: string, alphabet: EncodedForm['alphabet']) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    forms.push({ text, filters, alphabet });
  };
  if (value.length >= 3) {
    const utf8 = Buffer.from(value, 'utf8');
    add(utf8.toString('base64'), 'base64', 'base64');
    add(utf8.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url', 'base64');
    add(Buffer.from(value, 'utf16le').toString('base64'), 'base64utf16', 'base64');
    add(utf8.toString('hex'), 'hex', 'hex');
  }
  if (value.length >= 1) {
    for (const algo of ['sha512', 'sha256', 'sha1', 'md5']) {
      const digest = createHash(algo).update(value, 'utf8').digest('hex');
      add(digest, algo, 'hex');
      add(digest.toUpperCase(), `${algo}|upper`, 'hex');
    }
  }
  return forms.sort((a, b) => b.text.length - a.text.length);
}

/** characters that would make a match part of a longer token: [before, after]. Base64 may follow a "key=" and may run into padding. */
const NEIGHBOUR = { base64: ['A-Za-z0-9+/_-', 'A-Za-z0-9+/_=-'], hex: ['0-9a-fA-F', '0-9a-fA-F'], url: ['A-Za-z0-9%', 'A-Za-z0-9%'] } as const;

const standalone = (text: string, [before, after]: readonly [string, string]) => new RegExp(`(?<![${before}])${escapeRegex(text)}(?![${after}])`, 'g');

/**
 * Replace the encoded forms of \`${user.<field>}\` inside literal text (no placeholders) with the placeholder that
 * produces them. Adds the filter chains it used to `used`.
 */
export function replaceEncodedForms(text: string, field: string, forms: EncodedForm[], used: Set<string>): string {
  let out = text;
  for (const f of forms) {
    const ph = (chain: string) => '${user.' + field + '|' + chain + '}';
    out = out.replace(standalone(f.text, NEIGHBOUR[f.alphabet]), () => {
      used.add(f.filters);
      return ph(f.filters);
    });
    // the same text percent-encoded, as in a query string or a form body (= becomes %3D)
    const escaped = encodeURIComponent(f.text);
    if (escaped !== f.text) {
      out = out.replace(standalone(escaped, NEIGHBOUR.url), () => {
        used.add(`${f.filters}|urlencode`);
        return ph(`${f.filters}|urlencode`);
      });
    }
  }
  return out;
}

interface HasRequest {
  request: { url: string; headers: Record<string, string>; postData?: string };
}

const haystack = (k: HasRequest) => `${k.request.url}\n${k.request.postData ?? ''}\n${Object.values(k.request.headers).join('\n')}`;

/** Requests that carry the value as typed (also URL-, form- or JSON-escaped). */
export function plainHits<T extends HasRequest>(exchanges: T[], value: string): T[] {
  if (value.length < 2) return [];
  const forms = [value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2), JSON.stringify(value).slice(1, -1)];
  return exchanges.filter((k) => forms.some((f) => haystack(k).includes(f)));
}

/**
 * Requests that carry the value in an encoded form (Base64, hex, a hash), with the filter chain that produces it.
 * A match that only exists inside a longer one is dropped: "aGk" (Base64 without padding) is also found in "aGk=".
 */
export function encodedHits<T extends HasRequest>(exchanges: T[], value: string): { k: T; filters: string }[] {
  const forms = value.length < 1 ? [] : encodedForms(value);
  return exchanges.flatMap((k) => {
    const hay = haystack(k);
    const hits = forms.filter((f) => hay.includes(f.text) || hay.includes(encodeURIComponent(f.text)));
    return hits.filter((f) => !hits.some((g) => g !== f && g.text.length > f.text.length && g.text.includes(f.text))).map((f) => ({ k, filters: f.filters }));
  });
}
