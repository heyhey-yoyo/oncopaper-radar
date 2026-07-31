/* ============================================================
   OncoPaper Radar — shared helpers
   Single home for the text/type helpers that were previously
   duplicated across ai.js / query.js / index.js.
   ============================================================ */

// ⚠️ D1 SQL变量上限较低，chunk 控制在 30 以内避免 "too many SQL variables"
export const D1_BIND_CHUNK = 30;

export function cleanText(value, maxLength = 1000) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function cleanTerm(value) {
  return cleanText(value, 100)
    .replace(/["'`\\()[\]{}:^~*?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function chunk(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

export function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function deduplicateBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function friendlyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/3007|timeout/i.test(message)) return 'Workers AI timed out. The workflow can be retried without blocking the page.';
  if (/3036|quota|account limited/i.test(message)) return 'Workers AI quota is exhausted. The next run will use the available quota after reset.';
  if (/3040|capacity/i.test(message)) return 'The selected Workers AI model is temporarily at capacity.';
  return cleanText(message, 1000) || 'Unexpected error.';
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
