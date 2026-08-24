import {
  articleIdentityAliases,
  mergeArticlesByIdentity,
  normalizeDoi,
  preferredCanonicalId,
  probeTiersUntilUsable,
} from './radar.js';
import { buildEuropePMCQuery, buildPubMedQuery } from './query.js';
import { loadCandidateState } from './storage.js';
import { cleanText, clampInt, chunk, deduplicateBy, friendlyError, D1_BIND_CHUNK } from './utils.js';

const MAX_CANDIDATES = 80;
const MIN_SEARCH_RESULTS = 5;

/* ── Search ───────────────────────────────────────────────── */
export async function searchLiterature(env, settings) {
  const tiers = buildQueryTiers(settings);
  const counts = [];
  let chosenIndex = -1;

  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    try {
      const count = await countEuropePMC(tier.europeQuery);
      counts.push({ label: tier.label, count });
      if (count >= MIN_SEARCH_RESULTS) {
        chosenIndex = index;
        break;
      }
    } catch (error) {
      counts.push({ label: tier.label, count: null });
      console.error(`[Europe PMC] count failed for ${tier.label}`, error);
    }
  }

  if (chosenIndex < 0) {
    const positive = counts
      .map((item, index) => ({ ...item, index }))
      .filter(item => Number(item.count) > 0)
      .sort((a, b) => b.count - a.count)[0];
    if (positive) chosenIndex = positive.index;
  }

  const sourceErrors = [];
  const probe = await probeTiersUntilUsable({
    tiers,
    chosenIndex,
    maxCandidates: MAX_CANDIDATES,
    probeTier: async tier => {
      const [europeResult, pubmedResult] = await Promise.allSettled([
        fetchEuropePMC(tier.europeQuery, 60),
        fetchPubMed(tier.pubmedQuery, env.NCBI_API_KEY),
      ]);

      const europeArticles = europeResult.status === 'fulfilled' ? europeResult.value.articles : [];
      if (europeResult.status === 'rejected') {
        sourceErrors.push(`Europe PMC (${tier.label}): ${friendlyError(europeResult.reason)}`);
        console.error('[Search] Europe PMC', europeResult.reason);
      }

      let pubmedArticles = [];
      let pubmedIDs = [];
      if (pubmedResult.status === 'fulfilled') {
        pubmedIDs = pubmedResult.value.slice(0, 50);
        const existingPMIDs = new Set(europeArticles.map(article => article.pmid).filter(Boolean));
        const missing = pubmedIDs.filter(pmid => !existingPMIDs.has(pmid));
        if (missing.length) {
          try {
            pubmedArticles = await fetchPapersByPMIDs(missing, env.NCBI_API_KEY);
          } catch (error) {
            sourceErrors.push(`PubMed metadata (${tier.label}): ${friendlyError(error)}`);
            console.error('[Search] PubMed metadata lookup', error);
          }
        }
      } else {
        sourceErrors.push(`PubMed (${tier.label}): ${friendlyError(pubmedResult.reason)}`);
        console.error('[Search] PubMed', pubmedResult.reason);
      }

      if (europeResult.status === 'rejected' && pubmedResult.status === 'rejected') {
        return { success: false, candidates: [] };
      }

      const candidates = await resolveCandidateIdentities(
        env,
        mergeArticlesByIdentity([...europeArticles, ...pubmedArticles]),
      );
      return {
        success: true,
        candidates,
      };
    },
    assessCandidates: async candidates => {
      if (!candidates.length) return { usableCount: 0, candidates: [] };
      const state = await loadCandidateState(env, candidates, settings.profileHash);
      const usable = [];
      const historical = [];
      for (const article of candidates) {
        (state.processed.has(article.canonical_id) ? historical : usable).push(article);
      }
      return {
        usableCount: usable.length,
        candidates: [...usable, ...historical],
      };
    },
  });

  if (!probe.hadSuccessfulSource) {
    throw new Error(`Both literature sources failed. ${sourceErrors.slice(-4).join(' | ')}`);
  }

  const tier = probe.tier || tiers.at(-1);
  return {
    candidates: probe.candidates,
    queryText: `Europe PMC: ${tier.europeQuery}
PubMed: ${tier.pubmedQuery}`,
    tierLabel: tier.label,
  };
}

function buildQueryTiers(settings) {
  const groups = settings.queryGroups;
  const planMustCount = clampInt(settings.queryPlan?.must_count ?? Math.min(2, groups.length), 1, groups.length);
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - settings.lookbackDays);
  const fromDate = from.toISOString().slice(0, 10);
  const toDate = new Date().toISOString().slice(0, 10);
  const tiers = [];

  // Generated profiles store required groups first and optional preference
  // groups last. Remove optional groups before weakening a required concept.
  for (let count = groups.length; count >= planMustCount; count -= 1) {
    const activeGroups = groups.slice(0, count);
    tiers.push({
      label: count === groups.length ? `strict-${count}-groups` : `without-optional-${count}-groups`,
      europeQuery: buildEuropePMCQuery(activeGroups, settings.excludeTerms, settings.excludeReviews, fromDate, toDate),
      pubmedQuery: buildPubMedQuery(activeGroups, settings.excludeTerms, settings.excludeReviews, fromDate, toDate),
    });
  }

  const strongest = groups.slice(0, planMustCount);
  tiers.push({
    label: 'required-without-negative-terms',
    europeQuery: buildEuropePMCQuery(strongest, [], settings.excludeReviews, fromDate, toDate),
    pubmedQuery: buildPubMedQuery(strongest, [], settings.excludeReviews, fromDate, toDate),
  });

  for (let count = planMustCount - 1; count >= 1; count -= 1) {
    const activeGroups = groups.slice(0, count);
    tiers.push({
      label: `relaxed-required-${count}-groups`,
      europeQuery: buildEuropePMCQuery(activeGroups, settings.excludeTerms, settings.excludeReviews, fromDate, toDate),
      pubmedQuery: buildPubMedQuery(activeGroups, settings.excludeTerms, settings.excludeReviews, fromDate, toDate),
    });
  }

  if (planMustCount > 1) {
    tiers.push({
      label: 'single-core-without-negative-terms',
      europeQuery: buildEuropePMCQuery(groups.slice(0, 1), [], settings.excludeReviews, fromDate, toDate),
      pubmedQuery: buildPubMedQuery(groups.slice(0, 1), [], settings.excludeReviews, fromDate, toDate),
    });
  }

  return deduplicateBy(tiers, item => item.europeQuery);
}

async function postEuropePMC(params, label = 'HTTP') {
  const response = await fetch('https://www.ebi.ac.uk/europepmc/webservices/rest/searchPOST', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!response.ok) throw new Error(`Europe PMC ${label} HTTP ${response.status}`);
  return response.json();
}

async function countEuropePMC(query) {
  const params = new URLSearchParams({
    query,
    resultType: 'lite',
    pageSize: '1',
    format: 'json',
    synonym: 'true',
  });
  const data = await postEuropePMC(params);
  return Number(data.hitCount ?? 0);
}

async function fetchEuropePMC(query, pageSize) {
  const params = new URLSearchParams({
    query,
    resultType: 'core',
    pageSize: String(pageSize),
    format: 'json',
    sort: 'P_PDATE_D desc',
    synonym: 'true',
  });
  const data = await postEuropePMC(params);
  return {
    hitCount: Number(data.hitCount ?? 0),
    articles: (data.resultList?.result ?? []).map(mapEuropePMCArticle),
  };
}

async function fetchPubMed(query, apiKey) {
  const params = new URLSearchParams({
    db: 'pubmed', retmode: 'json', retmax: '50', sort: 'pub date', term: query,
    tool: 'oncopaper-radar',
  });
  if (apiKey) params.set('api_key', apiKey);
  const response = await fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!response.ok) throw new Error(`PubMed ESearch HTTP ${response.status}`);
  const data = await response.json();
  return data.esearchresult?.idlist ?? [];
}

export async function fetchPapersByPMIDs(pmids, apiKey) {
  const unique = [...new Set(pmids.map(String).filter(value => /^\d+$/.test(value)))].slice(0, 50);
  if (!unique.length) return [];

  const chunks = chunk(unique, 20);
  const articles = [];
  const errors = [];
  let successfulMetadataRequest = false;

  for (const ids of chunks) {
    const query = `(${ids.map(id => `EXT_ID:${id}`).join(' OR ')}) AND SRC:MED`;
    const params = new URLSearchParams({
      query, resultType: 'core', pageSize: String(ids.length), format: 'json',
    });
    try {
      const data = await postEuropePMC(params, 'PMID lookup');
      successfulMetadataRequest = true;
      articles.push(...(data.resultList?.result ?? []).map(mapEuropePMCArticle));
    } catch (error) {
      errors.push(friendlyError(error));
      console.error('[Europe PMC] PMID lookup failed; PubMed fallback will be used', error);
    }
  }

  const found = new Set(articles.map(article => article.pmid).filter(Boolean));
  const missing = unique.filter(id => !found.has(id));
  if (missing.length) {
    try {
      const summaries = await fetchPubMedSummaries(missing, apiKey);
      successfulMetadataRequest = true;
      articles.push(...summaries);
    } catch (error) {
      errors.push(friendlyError(error));
      console.error('[PubMed] summary fallback failed', error);
    }
  }

  if (!successfulMetadataRequest) {
    throw new Error(`Unable to load PubMed metadata. ${errors.join(' | ')}`);
  }
  return mergeArticlesByIdentity(articles);
}

async function fetchPubMedSummaries(pmids, apiKey) {
  const params = new URLSearchParams({ db: 'pubmed', retmode: 'json', id: pmids.join(','), tool: 'oncopaper-radar' });
  if (apiKey) params.set('api_key', apiKey);
  const response = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`PubMed ESummary HTTP ${response.status}`);
  const data = await response.json();
  return pmids.map(pmid => {
    const record = data.result?.[pmid];
    if (!record) return null;
    const doi = normalizeDoi(record.articleids?.find(item => item.idtype === 'doi')?.value) || null;
    return {
      id: `pubmed_${pmid}`,
      canonical_id: preferredCanonicalId({ pmid, doi, source: 'MED', external_id: pmid }),
      source: 'MED', external_id: pmid, pmid, pmcid: null, doi,
      title: cleanText(record.title || 'Untitled', 1000),
      authors: (record.authors ?? []).map(author => author.name).filter(Boolean).join(', ') || null,
      journal: record.fulljournalname || record.source || null,
      pub_date: record.pubdate || null,
      abstract: null,
      article_url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      inserted_at: new Date().toISOString(),
    };
  }).filter(Boolean);
}

function mapEuropePMCArticle(record) {
  const source = record.source || 'MED';
  const externalId = String(record.id || record.pmid || record.pmcid || crypto.randomUUID());
  const article = {
    id: `epmc_${source}_${externalId}`,
    source,
    external_id: externalId,
    pmid: record.pmid || null,
    pmcid: record.pmcid || null,
    doi: normalizeDoi(record.doi) || null,
    title: cleanText(record.title || 'Untitled', 1000),
    authors: cleanText(record.authorString, 1500) || null,
    journal: cleanText(record.journalTitle || record.bookTitle || record.source, 300) || null,
    pub_date: record.firstPublicationDate || record.electronicPublicationDate || record.pubYear || null,
    abstract: cleanText(record.abstractText, 12_000) || null,
    article_url: record.doi
      ? `https://doi.org/${record.doi}`
      : record.pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/`
        : `https://europepmc.org/article/${source}/${externalId}`,
    inserted_at: new Date().toISOString(),
  };
  article.canonical_id = preferredCanonicalId(article);
  return article;
}

async function resolveCandidateIdentities(env, candidates) {
  const merged = mergeArticlesByIdentity(candidates);
  const aliases = [...new Set(merged.flatMap(articleIdentityAliases))];
  const aliasRows = new Map();
  const canonicalArticleIds = new Map();

  for (const aliasChunk of chunk(aliases, D1_BIND_CHUNK)) {
    if (!aliasChunk.length) continue;
    const placeholders = aliasChunk.map(() => '?').join(',');
    const rows = (await env.DB.prepare(`
      SELECT aa.alias, aa.canonical_id, pa.article_id
      FROM article_aliases aa
      LEFT JOIN processed_articles pa ON pa.canonical_id = aa.canonical_id
      WHERE aa.alias IN (${placeholders})
    `).bind(...aliasChunk).all()).results;
    for (const row of rows) {
      aliasRows.set(row.alias, row.canonical_id);
      if (row.article_id) canonicalArticleIds.set(row.canonical_id, row.article_id);
    }
  }

  return merged.map(article => {
    const aliasesForArticle = articleIdentityAliases(article);
    const canonicalId = aliasesForArticle.map(alias => aliasRows.get(alias)).find(Boolean)
      || article.canonical_id
      || preferredCanonicalId(article);
    const articleId = canonicalArticleIds.get(canonicalId) || article.id;
    return { ...article, id: articleId, canonical_id: canonicalId };
  });
}
