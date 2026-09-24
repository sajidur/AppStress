/**
 * The value filters available in ${name|filter} placeholders and in "transform" of a saved value.
 * Kept free of Node imports so the browser UI can list them too.
 */
export interface FilterInfo {
  name: string;
  /** shown in menus */
  label: string;
  /** encode: prepare a value for sending; decode: read a value received; other: everything else */
  kind: 'encode' | 'decode' | 'hash' | 'other';
  help: string;
}

export const FILTERS: FilterInfo[] = [
  { name: 'base64', label: 'Base64', kind: 'encode', help: 'UTF-8 text as Base64. The server reads it with Encoding.UTF8.GetString(Convert.FromBase64String(x)) in C#, or Buffer.from(x, "base64") in Node.' },
  { name: 'base64url', label: 'Base64 (URL-safe, no padding)', kind: 'encode', help: 'Like Base64 with - and _ instead of + and /, and no = at the end. Used in JWTs.' },
  { name: 'base64utf16', label: 'Base64 of UTF-16 text', kind: 'encode', help: 'Base64 of UTF-16LE bytes: what Convert.ToBase64String(Encoding.Unicode.GetBytes(x)) makes in .NET.' },
  { name: 'hex', label: 'Hex', kind: 'encode', help: 'The UTF-8 bytes as lower-case hex digits.' },
  { name: 'urlencode', label: 'URL-encode', kind: 'encode', help: 'Escapes characters that are not allowed in a URL or form value.' },
  { name: 'json', label: 'JSON string escape', kind: 'encode', help: 'Escapes quotes and control characters so the value fits inside a JSON string.' },
  { name: 'base64decode', label: 'Base64 decode', kind: 'decode', help: 'Reads a Base64 value as UTF-8 text.' },
  { name: 'base64utf16decode', label: 'Base64 decode (UTF-16)', kind: 'decode', help: 'Reads a Base64 value as UTF-16LE text.' },
  { name: 'hexdecode', label: 'Hex decode', kind: 'decode', help: 'Reads hex digits as UTF-8 text.' },
  { name: 'urldecode', label: 'URL-decode', kind: 'decode', help: 'Undoes URL escaping (%20 becomes a space).' },
  { name: 'md5', label: 'MD5 hash (hex)', kind: 'hash', help: 'MD5 digest of the UTF-8 text as hex.' },
  { name: 'sha1', label: 'SHA-1 hash (hex)', kind: 'hash', help: 'SHA-1 digest of the UTF-8 text as hex.' },
  { name: 'sha256', label: 'SHA-256 hash (hex)', kind: 'hash', help: 'SHA-256 digest of the UTF-8 text as hex.' },
  { name: 'sha512', label: 'SHA-512 hash (hex)', kind: 'hash', help: 'SHA-512 digest of the UTF-8 text as hex.' },
  { name: 'lower', label: 'lower case', kind: 'other', help: 'Converts to lower case.' },
  { name: 'upper', label: 'UPPER CASE', kind: 'other', help: 'Converts to upper case.' },
  { name: 'trim', label: 'Trim spaces', kind: 'other', help: 'Removes spaces at the start and end.' },
];

export const FILTER_NAMES = new Set(FILTERS.map((f) => f.name));

/** Split "base64|urlencode" into filter names; returns the unknown ones too so callers can report them. */
export function parseFilterChain(chain: string | undefined): { filters: string[]; unknown: string[] } {
  const filters = (chain ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  return { filters, unknown: filters.filter((f) => !FILTER_NAMES.has(f)) };
}
