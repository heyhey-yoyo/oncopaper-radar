import { cleanTerm } from './utils.js';

const MAX_QUERY_GROUPS = 5;
const MAX_TERMS_PER_GROUP = 4;
const MAX_EXCLUDE_TERMS = 3;

export function splitGroup(value) {
  const output = [];
  const seen = new Set();
  for (const item of String(value ?? '').split('|')) {
    const term = cleanTerm(item);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    output.push(term);
  }
  return output;
}

export function normalizeQueryGroups(value) {
  const raw = Array.isArray(value) ? value : [];
  const output = [];
  const seen = new Set();
  for (const group of raw) {
    const terms = splitGroup(group).slice(0, MAX_TERMS_PER_GROUP);
    if (!terms.length) continue;
    const normalized = terms.join(' | ');
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= MAX_QUERY_GROUPS) break;
  }
  return output;
}

export function normalizeExcludeTerms(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split('|');
  const output = [];
  const seen = new Set();
  for (const item of raw) {
    const term = cleanTerm(item);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    output.push(term);
    if (output.length >= MAX_EXCLUDE_TERMS) break;
  }
  return output;
}

function quoteTerm(term) {
  return `"${cleanTerm(term).replaceAll('"', '')}"`;
}

export function buildEuropePMCQuery(queryGroups, excludeTerms, excludeReviews, fromDate, toDate) {
  const groups = normalizeQueryGroups(queryGroups).map(group => {
    const terms = splitGroup(group).map(term => `TITLE_ABS:${quoteTerm(term)}`);
    return `(${terms.join(' OR ')})`;
  });
  if (!groups.length) throw new Error('At least one query group is required.');

  let query = `${groups.join(' AND ')} AND FIRST_PDATE:[${fromDate} TO ${toDate}]`;
  for (const term of normalizeExcludeTerms(excludeTerms)) {
    query += ` NOT TITLE_ABS:${quoteTerm(term)}`;
  }
  if (excludeReviews) query += ' NOT PUB_TYPE:"Review"';
  return query;
}

export function buildPubMedQuery(queryGroups, excludeTerms, excludeReviews, fromDate, toDate) {
  const groups = normalizeQueryGroups(queryGroups).map(group => {
    const terms = splitGroup(group).map(term => `${quoteTerm(term)}[Title/Abstract]`);
    return `(${terms.join(' OR ')})`;
  });
  if (!groups.length) throw new Error('At least one query group is required.');

  const from = String(fromDate).replaceAll('-', '/');
  const to = String(toDate).replaceAll('-', '/');
  let query = `${groups.join(' AND ')} AND ("${from}"[Date - Publication] : "${to}"[Date - Publication])`;
  for (const term of normalizeExcludeTerms(excludeTerms)) {
    query += ` NOT ${quoteTerm(term)}[Title/Abstract]`;
  }
  if (excludeReviews) query += ' NOT review[Publication Type]';
  return query;
}
