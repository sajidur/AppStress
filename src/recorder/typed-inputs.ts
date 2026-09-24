import type { TypedInput } from '../types.js';

/**
 * Injected into every page while recording. It reports what is typed into form fields (which field, which
 * value) so the builder can follow each value to the requests that carry it. Fields are reported when the
 * user leaves them, presses Enter, or submits/clicks, so the final value is what gets recorded.
 */
export const TYPED_INPUT_SCRIPT = `(() => {
  if (window.__ltTypedInstalled) return;
  window.__ltTypedInstalled = true;
  const SKIP = { button: 1, submit: 1, reset: 1, checkbox: 1, radio: 1, file: 1, image: 1, hidden: 1, range: 1, color: 1 };
  const send = (el) => {
    try {
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
      const type = (el.type || tag).toLowerCase();
      if (SKIP[type]) return;
      const value = String(el.value == null ? '' : el.value);
      if (!value) return;
      let label = '';
      if (el.labels && el.labels.length) label = el.labels[0].innerText || '';
      label = (label || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80);
      window.__ltTyped({ field: el.name || el.id || '', label: label, type: type, value: value.slice(0, 500), page: location.href });
    } catch (e) {}
  };
  const sendAll = () => document.querySelectorAll('input, textarea, select').forEach((el) => { if (el.offsetParent !== null) send(el); });
  addEventListener('change', (e) => send(e.target), true);
  addEventListener('blur', (e) => send(e.target), true);
  addEventListener('keydown', (e) => { if (e.key === 'Enter') send(e.target); }, true);
  addEventListener('submit', sendAll, true);
  addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('button, input[type=submit], input[type=button], a') : null;
    if (t) sendAll();
  }, true);
})();`;

/** Keep the typed values in order, without repeats of the same field/value/page. */
export function addTyped(list: TypedInput[], d: Omit<TypedInput, 'at'>): void {
  if (!d || typeof d.value !== 'string' || d.value === '') return;
  if (list.some((t) => t.field === d.field && t.value === d.value && t.page === d.page && t.label === d.label)) return;
  // the same field re-typed: keep only the latest value for it
  const i = list.findIndex((t) => t.field === d.field && t.page === d.page && t.type === d.type && d.field !== '');
  const entry: TypedInput = { at: Date.now(), field: d.field, label: d.label || undefined, type: d.type, value: d.value, page: d.page };
  if (i >= 0) list[i] = entry;
  else list.push(entry);
}
