import test from 'node:test';
import assert from 'node:assert/strict';
import {
  articleIdentityAliases,
  buildTierProbeOrder,
  chooseDigestForDisplay,
  mergeArticlesByIdentity,
  preferredCanonicalId,
  probeTiersUntilUsable,
  processingFingerprintPayload,
} from '../src/radar.js';

test('processing fingerprint changes when result-affecting settings change', () => {
  const base = {
    queryGroups: ['KRAS G12D', 'PDAC'],
    focus: 'mechanism',
    excludeTerms: ['review'],
    maxArticles: 5,
    lookbackDays: 7,
    excludeReviews: true,
    queryPlan: null,
  };
  assert.notDeepEqual(
    processingFingerprintPayload(base, 'prompt-v1'),
    processingFingerprintPayload({ ...base, maxArticles: 10 }, 'prompt-v1'),
  );
  assert.notDeepEqual(
    processingFingerprintPayload(base, 'prompt-v1'),
    processingFingerprintPayload({ ...base, lookbackDays: 14 }, 'prompt-v1'),
  );
});

test('PMID remains a stable preferred identity when DOI metadata appears later', () => {
  const withoutDoi = { pmid: '12345678', title: 'Paper', source: 'MED', external_id: '12345678' };
  const withDoi = { ...withoutDoi, doi: '10.1000/Example' };
  assert.equal(preferredCanonicalId(withDoi), 'pmid:12345678');
  assert.deepEqual(articleIdentityAliases(withDoi), [
    'pmid:12345678',
    'doi:10.1000/example',
    'med:12345678',
    'source:med:12345678',
  ]);

  const merged = mergeArticlesByIdentity([
    { ...withoutDoi, id: 'old', canonical_id: 'pmid:12345678' },
    { ...withDoi, id: 'new', abstract: 'New abstract' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].canonical_id, 'pmid:12345678');
  assert.equal(merged[0].doi, '10.1000/example');
  assert.equal(merged[0].abstract, 'New abstract');
});

test('a bridging record merges DOI-only and PMID-only records', () => {
  const merged = mergeArticlesByIdentity([
    { id: 'doi', doi: '10.1000/x', title: 'Paper' },
    { id: 'pmid', pmid: '22222', title: 'Paper' },
    { id: 'bridge', doi: '10.1000/x', pmid: '22222', title: 'Paper', abstract: 'Abstract' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].abstract, 'Abstract');
});


test('source-only papers keep the legacy canonical ID and expose the new alias', () => {
  const article = { source: 'PPR', external_id: 'PPR123', id: 'ppr_PPR123', title: 'Preprint' };
  assert.equal(preferredCanonicalId(article), 'ppr:PPR123');
  assert.deepEqual(articleIdentityAliases(article), [
    'ppr:PPR123',
    'source:ppr:ppr123',
  ]);
});

test('chosen search tier is followed by wider tiers', () => {
  const tiers = [{ label: 'strict' }, { label: 'relaxed' }, { label: 'wide' }];
  assert.deepEqual(buildTierProbeOrder(tiers, 0).map(tier => tier.label), ['strict', 'relaxed', 'wide']);
  assert.deepEqual(buildTierProbeOrder(tiers, 1).map(tier => tier.label), ['relaxed', 'wide']);
});

test('formal search continues when chosen tier is empty or only historical', async () => {
  const tiers = [{ label: 'strict' }, { label: 'relaxed' }, { label: 'wide' }];
  const calls = [];
  const result = await probeTiersUntilUsable({
    tiers,
    chosenIndex: 0,
    probeTier: async tier => {
      calls.push(tier.label);
      if (tier.label === 'strict') return { success: true, candidates: [] };
      if (tier.label === 'relaxed') {
        return { success: true, candidates: [{ id: 'old', pmid: '1', title: 'Old paper' }] };
      }
      return { success: true, candidates: [{ id: 'new', pmid: '2', title: 'New paper' }] };
    },
    assessCandidates: async candidates => {
      const usable = candidates.filter(article => article.pmid === '2');
      return {
        usableCount: usable.length,
        candidates: [...usable, ...candidates.filter(article => article.pmid !== '2')],
      };
    },
  });

  assert.deepEqual(calls, ['strict', 'relaxed', 'wide']);
  assert.equal(result.tier.label, 'wide');
  assert.equal(result.usableCount, 1);
  assert.equal(result.candidates.length, 2);
});


test('fresh wider-tier candidates survive a full historical candidate cap', async () => {
  const tiers = [{ label: 'strict' }, { label: 'wide' }];
  const historical = Array.from({ length: 80 }, (_, index) => ({
    id: `old-${index}`,
    pmid: String(index + 1),
    title: `Old ${index}`,
  }));
  const fresh = { id: 'new', pmid: '999999', title: 'New paper' };

  const result = await probeTiersUntilUsable({
    tiers,
    chosenIndex: 0,
    maxCandidates: 80,
    probeTier: async tier => tier.label === 'strict'
      ? { success: true, candidates: historical }
      : { success: true, candidates: [fresh] },
    assessCandidates: async candidates => {
      const usable = candidates.filter(article => article.pmid === fresh.pmid);
      const alreadyProcessed = candidates.filter(article => article.pmid !== fresh.pmid);
      return {
        usableCount: usable.length,
        candidates: [...usable, ...alreadyProcessed],
      };
    },
  });

  assert.equal(result.usableCount, 1);
  assert.equal(result.candidates.length, 80);
  assert.ok(result.candidates.some(article => article.pmid === fresh.pmid));
});


test('fresh candidates beyond a single tier cap are prioritized before truncation', async () => {
  const tier = { label: 'strict' };
  const historical = Array.from({ length: 80 }, (_, index) => ({
    id: `old-${index}`,
    pmid: String(index + 1),
    title: `Old ${index}`,
  }));
  const fresh = { id: 'new', pmid: '999999', title: 'New paper' };

  const result = await probeTiersUntilUsable({
    tiers: [tier],
    chosenIndex: 0,
    maxCandidates: 80,
    probeTier: async () => ({ success: true, candidates: [...historical, fresh] }),
    assessCandidates: async candidates => ({
      usableCount: 1,
      candidates: [fresh, ...candidates.filter(article => article.pmid !== fresh.pmid)],
    }),
  });

  assert.equal(result.usableCount, 1);
  assert.equal(result.candidates.length, 80);
  assert.equal(result.candidates[0].pmid, fresh.pmid);
});


test('latest failed run does not hide the most recent successful digest', () => {
  const latestAttempt = { id: 12, status: 'error' };
  const latestSuccess = { id: 11, status: 'ok' };
  assert.deepEqual(chooseDigestForDisplay(latestAttempt, latestSuccess), {
    digest: latestSuccess,
    latestAttempt,
  });
});
