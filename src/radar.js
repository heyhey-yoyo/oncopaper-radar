export const PROCESSING_VERSION = '2026-07-31-v2';

export function normalizeDoi(value) {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();
}

export function articleIdentityAliases(article) {
  const aliases = [];
  const pmid = String(article?.pmid ?? '').trim();
  const pmcid = String(article?.pmcid ?? '').trim().toLowerCase();
  const doi = normalizeDoi(article?.doi);
  const source = String(article?.source ?? '').trim().toLowerCase();
  const rawExternalId = String(article?.external_id ?? '').trim();
  const externalId = rawExternalId.toLowerCase();

  if (pmid) aliases.push(`pmid:${pmid}`);
  if (pmcid) aliases.push(`pmcid:${pmcid}`);
  if (doi) aliases.push(`doi:${doi}`);
  // Keep the pre-alias-table fallback ID for existing source-only records,
  // while also storing the namespaced/lowercase alias used by the new resolver.
  if (source && rawExternalId) aliases.push(`${source}:${rawExternalId}`);
  if (source && externalId) aliases.push(`source:${source}:${externalId}`);
  return [...new Set(aliases)];
}

export function preferredCanonicalId(article) {
  const aliases = articleIdentityAliases(article);
  return aliases.find(alias => alias.startsWith('pmid:'))
    || aliases.find(alias => alias.startsWith('pmcid:'))
    || aliases.find(alias => alias.startsWith('doi:'))
    || aliases[0]
    || `unknown:${String(article?.id ?? 'article')}`;
}

export function shareArticleIdentity(left, right) {
  const leftAliases = new Set(articleIdentityAliases(left));
  return articleIdentityAliases(right).some(alias => leftAliases.has(alias));
}

function richerText(left, right) {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  if (!a) return right ?? null;
  if (!b) return left ?? null;
  return b.length > a.length ? right : left;
}

export function mergeArticleRecords(existing, incoming) {
  const merged = {
    ...incoming,
    ...existing,
    id: existing?.id || incoming?.id,
    canonical_id: existing?.canonical_id || incoming?.canonical_id,
    source: existing?.source || incoming?.source,
    external_id: existing?.external_id || incoming?.external_id,
    pmid: existing?.pmid || incoming?.pmid || null,
    pmcid: existing?.pmcid || incoming?.pmcid || null,
    doi: normalizeDoi(existing?.doi || incoming?.doi) || null,
    title: richerText(existing?.title, incoming?.title) || 'Untitled',
    authors: richerText(existing?.authors, incoming?.authors),
    journal: richerText(existing?.journal, incoming?.journal),
    pub_date: existing?.pub_date || incoming?.pub_date || null,
    abstract: richerText(existing?.abstract, incoming?.abstract),
    article_url: existing?.article_url || incoming?.article_url,
    inserted_at: existing?.inserted_at || incoming?.inserted_at,
  };

  if (merged.doi) merged.article_url = `https://doi.org/${merged.doi}`;
  else if (merged.pmid) merged.article_url = `https://pubmed.ncbi.nlm.nih.gov/${merged.pmid}/`;
  merged.canonical_id ||= preferredCanonicalId(merged);
  return merged;
}

export function mergeArticlesByIdentity(articles) {
  const merged = [];

  for (const raw of articles) {
    if (!raw?.title) continue;
    let article = {
      ...raw,
      doi: normalizeDoi(raw.doi) || null,
      canonical_id: raw.canonical_id || preferredCanonicalId(raw),
    };

    const matched = [];
    for (let index = 0; index < merged.length; index += 1) {
      if (shareArticleIdentity(merged[index], article)) matched.push(index);
    }

    if (!matched.length) {
      merged.push(article);
      continue;
    }

    const first = matched[0];
    article = mergeArticleRecords(merged[first], article);
    for (let index = matched.length - 1; index >= 1; index -= 1) {
      const duplicateIndex = matched[index];
      article = mergeArticleRecords(merged[duplicateIndex], article);
      merged.splice(duplicateIndex, 1);
    }
    merged[first] = article;
  }

  return merged;
}

export function processingFingerprintPayload(settings, promptVersion) {
  return {
    processingVersion: PROCESSING_VERSION,
    promptVersion,
    queryGroups: settings.queryGroups,
    focus: settings.focus,
    excludeTerms: settings.excludeTerms,
    maxArticles: settings.maxArticles,
    lookbackDays: settings.lookbackDays,
    excludeReviews: settings.excludeReviews,
    queryPlan: settings.queryPlan,
  };
}


export function chooseDigestForDisplay(latestAttempt, latestSuccess) {
  return {
    digest: latestSuccess || latestAttempt || null,
    latestAttempt: latestAttempt || null,
  };
}

export function buildTierProbeOrder(tiers, chosenIndex) {
  const startIndex = Number.isInteger(chosenIndex) && chosenIndex >= 0 ? chosenIndex : 0;
  return tiers.slice(Math.min(startIndex, Math.max(0, tiers.length - 1)));
}

export async function probeTiersUntilUsable({
  tiers,
  chosenIndex = -1,
  probeTier,
  assessCandidates,
  maxCandidates = 80,
}) {
  const attempts = [];
  let candidates = [];
  let hadSuccessfulSource = false;

  for (const tier of buildTierProbeOrder(tiers, chosenIndex)) {
    const result = await probeTier(tier);
    attempts.push({ tier, result });
    if (!result.success) continue;

    hadSuccessfulSource = true;
    candidates = mergeArticlesByIdentity([...candidates, ...(result.candidates || [])]);

    const assessment = await assessCandidates(candidates);
    const usableCount = Number(assessment?.usableCount ?? 0);
    const prioritized = Array.isArray(assessment?.candidates)
      ? assessment.candidates
      : candidates;
    candidates = prioritized.slice(0, maxCandidates);

    const isLast = tier === tiers[tiers.length - 1];
    if (usableCount > 0 || isLast) {
      return { candidates, tier, result, attempts, hadSuccessfulSource, usableCount };
    }
  }

  return {
    candidates,
    tier: attempts.at(-1)?.tier ?? null,
    result: attempts.at(-1)?.result ?? null,
    attempts,
    hadSuccessfulSource,
    usableCount: 0,
  };
}
