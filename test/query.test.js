import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEuropePMCQuery,
  buildPubMedQuery,
  normalizeExcludeTerms,
  normalizeQueryGroups,
} from '../src/query.js';

test('query groups are deduplicated and strictly bounded', () => {
  const groups = normalizeQueryGroups([
    'KRAS G12D | KRASG12D | KRAS G12D | KRAS-G12D | extra',
    'pancreatic cancer | PDAC',
    'ferroptosis',
    'single-cell RNA sequencing',
    'organoid',
    'sixth group must be dropped',
  ]);
  assert.equal(groups.length, 5);
  assert.equal(groups[0].split('|').length, 4);
});

test('full-width pipe is treated as an OR separator', () => {
  assert.deepEqual(
    normalizeQueryGroups(['KRAS G12D｜KRASG12D', 'pancreatic cancer ｜ PDAC']),
    ['KRAS G12D | KRASG12D', 'pancreatic cancer | PDAC'],
  );
  assert.deepEqual(normalizeExcludeTerms('nomogram｜review | meta-analysis'), ['nomogram', 'review', 'meta-analysis']);
  const query = buildEuropePMCQuery(['KRAS G12D｜KRASG12D'], [], false, '2026-07-01', '2026-07-30');
  assert.match(query, /TITLE_ABS:"KRAS G12D" OR TITLE_ABS:"KRASG12D"/);
});

test('exclude terms are sanitized, deduplicated, and limited to three', () => {
  assert.deepEqual(
    normalizeExcludeTerms('nomogram | nomogram | prognostic signature | review | fourth'),
    ['nomogram', 'prognostic signature', 'review'],
  );
});

test('Europe PMC query uses title/abstract fields and publication date range', () => {
  const query = buildEuropePMCQuery(
    ['KRAS G12D | KRASG12D', 'pancreatic cancer | PDAC'],
    ['nomogram'],
    true,
    '2026-07-01',
    '2026-07-30',
  );
  assert.match(query, /TITLE_ABS:"KRAS G12D"/);
  assert.match(query, /FIRST_PDATE:\[2026-07-01 TO 2026-07-30\]/);
  assert.match(query, /NOT PUB_TYPE:"Review"/);
});

test('PubMed query applies a field tag to every synonym', () => {
  const query = buildPubMedQuery(
    ['KRAS G12D | KRASG12D', 'pancreatic cancer | PDAC'],
    [],
    true,
    '2026-07-01',
    '2026-07-30',
  );
  assert.match(query, /"KRAS G12D"\[Title\/Abstract\]/);
  assert.match(query, /"KRASG12D"\[Title\/Abstract\]/);
  assert.match(query, /NOT review\[Publication Type\]/);
});
