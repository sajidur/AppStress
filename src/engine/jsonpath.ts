/** Tiny JSON path support: $.a.b[0]["c-d"] — enough for recorded correlations. */
export type PathToken = string | number;

export function tokenizePath(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[["']((?:[^"'\\]|\\.)*)["']\]/y;
  let s = path.trim();
  if (s.startsWith('$')) s = s.slice(1);
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) throw new Error(`invalid JSON path "${path}"`);
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(Number(m[2]));
    else tokens.push(m[3].replace(/\\(.)/g, '$1'));
    pos = re.lastIndex;
  }
  return tokens;
}

export function formatPath(tokens: PathToken[]): string {
  return (
    '$' +
    tokens
      .map((t) =>
        typeof t === 'number' ? `[${t}]` : /^[A-Za-z_$][\w$]*$/.test(t) ? `.${t}` : `[${JSON.stringify(t)}]`,
      )
      .join('')
  );
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const t of tokenizePath(path)) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[t];
  }
  return cur;
}

/** Walk JSON leaves (strings / numbers) with their paths. */
export function* walkLeaves(
  value: unknown,
  tokens: PathToken[] = [],
  depth = 0,
): Generator<{ tokens: PathToken[]; value: string | number }> {
  if (depth > 12) return;
  if (typeof value === 'string' || typeof value === 'number') {
    yield { tokens, value };
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 200; i++) yield* walkLeaves(value[i], [...tokens, i], depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* walkLeaves(v, [...tokens, k], depth + 1);
  }
}
