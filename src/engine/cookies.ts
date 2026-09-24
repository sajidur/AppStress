interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  expires?: number;
  secure: boolean;
}

/** Small per-virtual-user cookie jar (domain / path / expiry / secure aware). */
export class CookieJar {
  private cookies: Cookie[] = [];

  store(url: string, setCookieHeaders: string[]): void {
    const u = new URL(url);
    for (const header of setCookieHeaders) {
      const [nameValue, ...attrs] = header.split(';').map((p) => p.trim());
      const eq = nameValue.indexOf('=');
      if (eq <= 0) continue;
      const cookie: Cookie = {
        name: nameValue.slice(0, eq).trim(),
        value: nameValue.slice(eq + 1).trim(),
        domain: u.hostname.toLowerCase(),
        hostOnly: true,
        path: defaultPath(u.pathname),
        secure: false,
      };
      for (const attr of attrs) {
        const [rawKey, ...rest] = attr.split('=');
        const key = rawKey.trim().toLowerCase();
        const val = rest.join('=').trim();
        if (key === 'domain' && val) {
          cookie.domain = val.replace(/^\./, '').toLowerCase();
          cookie.hostOnly = false;
        } else if (key === 'path' && val.startsWith('/')) cookie.path = val;
        else if (key === 'max-age') cookie.expires = Date.now() + Number(val) * 1000;
        else if (key === 'expires' && cookie.expires === undefined) {
          const t = Date.parse(val);
          if (!Number.isNaN(t)) cookie.expires = t;
        } else if (key === 'secure') cookie.secure = true;
      }
      this.cookies = this.cookies.filter(
        (c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path),
      );
      if (cookie.expires === undefined || cookie.expires > Date.now()) this.cookies.push(cookie);
    }
  }

  header(url: string): string | undefined {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const now = Date.now();
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
    const matching = this.cookies.filter(
      (c) =>
        (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain)) &&
        u.pathname.startsWith(c.path) &&
        (!c.secure || u.protocol === 'https:'),
    );
    if (!matching.length) return undefined;
    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  clear(): void {
    this.cookies = [];
  }
}

function defaultPath(pathname: string): string {
  const i = pathname.lastIndexOf('/');
  return i <= 0 ? '/' : pathname.slice(0, i);
}
