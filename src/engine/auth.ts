import type { AuthConfig } from '../types.js';
import { render, TemplateError, type Vars } from './template.js';

export interface AuthResult {
  url: string;
  /** 'applied' when the auth was added, 'skipped' when a variable was not available yet, 'own' when the step sets its own */
  status: 'applied' | 'skipped' | 'own';
}

const hasHeader = (headers: Record<string, string>, name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

/**
 * Add the workflow-level authentication to a request (mutates `headers`, returns the possibly
 * extended URL). Never throws: an unresolved variable just means "not logged in yet".
 */
export function applyAuth(auth: AuthConfig, vars: Vars, headers: Record<string, string>, url: string): AuthResult {
  try {
    switch (auth.type) {
      case 'bearer': {
        if (hasHeader(headers, 'authorization')) return { url, status: 'own' };
        const token = render(auth.token ?? '', vars).trim();
        if (!token) return { url, status: 'skipped' };
        headers.authorization = /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
        return { url, status: 'applied' };
      }
      case 'basic': {
        if (hasHeader(headers, 'authorization')) return { url, status: 'own' };
        const user = render(auth.username ?? '', vars);
        const pass = render(auth.password ?? '', vars);
        headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
        return { url, status: 'applied' };
      }
      case 'header': {
        const name = (auth.name ?? '').trim();
        if (!name) return { url, status: 'skipped' };
        if (hasHeader(headers, name)) return { url, status: 'own' };
        const value = render(auth.value ?? '', vars);
        if (value === '') return { url, status: 'skipped' };
        headers[name.toLowerCase()] = value;
        return { url, status: 'applied' };
      }
      case 'query': {
        const name = (auth.name ?? '').trim();
        if (!name) return { url, status: 'skipped' };
        const u = new URL(url);
        if (u.searchParams.has(name)) return { url, status: 'own' };
        const value = render(auth.value ?? '', vars);
        if (value === '') return { url, status: 'skipped' };
        u.searchParams.append(name, value);
        return { url: u.toString(), status: 'applied' };
      }
    }
  } catch (e) {
    if (e instanceof TemplateError) return { url, status: 'skipped' };
    throw e;
  }
}
