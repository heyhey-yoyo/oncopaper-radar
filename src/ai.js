/* ============================================================
   OncoPaper Radar — bounded Workers AI service
   Small outputs, two-model fallback, strict validation, and
   deterministic fallbacks so a failed inference never loses a run.
   ============================================================ */

import { cleanTerm, cleanText, clampInt, splitOnPipe } from './utils.js';

// ⚠️ 改模型时只需更新下面的常量；MODEL_LABELS 与
// src/index.js 的 handleModelInfo() 都会自动跟随。
export const QWEN = '@cf/qwen/qwen3-30b-a3b-fp8';
export const GRANITE = '@cf/ibm-granite/granite-4.0-h-micro';

const PROFILE_CHAIN = [QWEN, GRANITE];
const SCORE_CHAIN = [QWEN, GRANITE];

export const PROMPT_VERSION = '2026-07-30-v3';
export const MODEL_LABELS = {
  [QWEN]: 'Qwen3-30B-A3B',
  [GRANITE]: 'Granite 4.0 H Micro',
  heuristic: 'Heuristic fallback',
};

function extractText(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  if (typeof result.response === 'string') return result.response;

  const message = result.choices?.[0]?.message
    ?? result.response?.choices?.[0]?.message;

  if (typeof message?.content === 'string' && message.content.trim()) {
    return message.content;
  }
  if (typeof message?.reasoning_content === 'string') {
    return message.reasoning_content;
  }
  if (typeof message?.reasoning === 'string') return message.reasoning;
  return '';
}

function parseJSON(text) {
  if (!text) return null;
  const attempts = [
    text.trim(),
    text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim(),
  ];

  for (const candidate of attempts) {
    try { return JSON.parse(candidate); } catch { /* continue */ }
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]); } catch { /* continue */ }
  }
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch { /* continue */ }
  }
  return null;
}

function buildParams(messages, maxTokens) {
  return {
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  };
}

function timeoutError(label, milliseconds) {
  const error = new Error(`${label} exceeded ${Math.round(milliseconds / 1000)} seconds`);
  error.name = 'AIModelTimeout';
  return error;
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label, milliseconds)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runAIForJSON(env, messages, options = {}) {
  const chain = options.chain ?? SCORE_CHAIN;
  const maxTokens = clampInt(options.maxTokens ?? 900, 128, 3000);
  const modelTimeoutMs = clampInt(options.modelTimeoutMs ?? 60_000, 10_000, 120_000);
  const totalTimeoutMs = clampInt(options.totalTimeoutMs ?? 90_000, 15_000, 150_000);
  const deadline = Date.now() + totalTimeoutMs;
  const errors = [];

  for (const model of chain.slice(0, 2)) {
    const remaining = deadline - Date.now();
    if (remaining < 5_000) break;
    const attemptTimeout = Math.min(modelTimeoutMs, remaining);
    try {
      console.log(`[AI] ${options.label || 'json'}: ${model}, max_tokens=${maxTokens}`);
      const result = await withTimeout(
        env.AI.run(model, buildParams(messages, maxTokens)),
        attemptTimeout,
        MODEL_LABELS[model] || model,
      );
      const text = extractText(result).trim();
      const parsed = parseJSON(text);
      if (!parsed) throw new Error(`Invalid JSON; response prefix: ${text.slice(0, 120)}`);
      return { parsed, model };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${MODEL_LABELS[model] || model}: ${message}`);
      console.error(`[AI] ${model} failed: ${message}`);
      // A timed-out binding call may still be winding down. Do not start a
      // second expensive model concurrently; let the deterministic fallback run.
      if (error?.name === 'AIModelTimeout') break;
    }
  }

  throw new Error(`All bounded AI attempts failed: ${errors.join(' | ')}`);
}

function normalizeConcept(raw) {
  const terms = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.terms)
      ? raw.terms
      : typeof raw === 'string'
        ? splitOnPipe(raw)
        : [];

  const seen = new Set();
  const output = [];
  for (const value of terms) {
    const term = cleanTerm(value);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    output.push(term);
    if (output.length >= 4) break;
  }
  return output;
}

function normalizeProfile(parsed) {
  const mustRaw = parsed.mustConcepts ?? parsed.must ?? [];
  const shouldRaw = parsed.shouldConcepts ?? parsed.should ?? [];
  let must = (Array.isArray(mustRaw) ? mustRaw : []).map(normalizeConcept).filter(Boolean);
  let should = (Array.isArray(shouldRaw) ? shouldRaw : []).map(normalizeConcept).filter(Boolean);

  // Compatibility with older model output while still enforcing tight limits.
  if (!must.length && Array.isArray(parsed.concepts)) {
    const concepts = parsed.concepts.map(normalizeConcept).filter(group => group.length);
    must = concepts.slice(0, 2);
    should = concepts.slice(2, 4);
  }

  must = must.filter(group => group.length).slice(0, 2);
  should = should.filter(group => group.length).slice(0, 2);

  let termBudget = 16;
  const trimToBudget = groups => groups.map(group => {
    const trimmed = group.slice(0, Math.max(0, termBudget));
    termBudget -= trimmed.length;
    return trimmed;
  }).filter(group => group.length);

  must = trimToBudget(must);
  should = trimToBudget(should);

  const exclusions = Array.isArray(parsed.excludeTerms)
    ? parsed.excludeTerms
    : Array.isArray(parsed.exclude)
      ? parsed.exclude
      : typeof parsed.excludeTerms === 'string'
        ? splitOnPipe(parsed.excludeTerms)
        : [];

  const excludeTerms = [];
  const seenExcludes = new Set();
  for (const item of exclusions) {
    const term = cleanTerm(item);
    const key = term.toLowerCase();
    if (!term || seenExcludes.has(key)) continue;
    seenExcludes.add(key);
    excludeTerms.push(term);
    if (excludeTerms.length >= 3) break;
  }

  if (!must.length) throw new Error('Profile did not contain a usable must concept');

  return {
    focus: cleanText(parsed.researcherProfile ?? parsed.profile ?? parsed.focus, 3500),
    must,
    should,
    excludeTerms,
    rationale: cleanText(parsed.rationale, 800),
  };
}

function mostFrequentMatches(text, pattern, limit) {
  const counts = new Map();
  for (const match of text.matchAll(pattern)) {
    const term = cleanTerm(match[0]);
    if (!term) continue;
    const key = term.toLowerCase();
    counts.set(key, { term, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.term.length - b.term.length)
    .slice(0, limit)
    .map(item => item.term);
}

function normalizeDiseasePhrase(value) {
  let words = cleanTerm(value).split(/\s+/).filter(Boolean);
  const separators = new Set(['in', 'of', 'for', 'with', 'via', 'through', 'and']);
  for (let index = words.length - 2; index >= 0; index -= 1) {
    if (separators.has(words[index].toLowerCase())) {
      words = words.slice(index + 1);
      break;
    }
  }
  const generic = new Set(['signaling', 'mechanism', 'mechanisms', 'role', 'roles', 'analysis', 'study', 'studies']);
  while (words.length > 2 && generic.has(words[0].toLowerCase())) words.shift();
  return words.slice(-5).join(' ');
}

function fallbackProfile(papers, cause) {
  const titles = papers.map(paper => cleanText(paper.title, 400)).filter(Boolean);
  const titleText = titles.join(' ');
  const diseases = [...new Set(mostFrequentMatches(
    titleText,
    /\b(?:[A-Za-z][A-Za-z-]*\s+){0,5}(?:cancer|carcinoma|adenocarcinoma|leukemia|lymphoma|melanoma|sarcoma|glioma|glioblastoma|myeloma|neoplasm|tumou?r)s?\b/gi,
    8,
  ).map(normalizeDiseasePhrase).filter(Boolean))].slice(0, 4);

  const blocked = new Set([
    'DNA', 'RNA', 'MRNA', 'CELL', 'CELLS', 'CANCER', 'TUMOR', 'TUMOUR',
    'CRISPR', 'PMID', 'PMC', 'THE', 'AND', 'FOR', 'WITH', 'FROM', 'VIA',
    'PDAC', 'NSCLC', 'SCLC', 'HCC', 'CRC', 'AML', 'ALL', 'DLBCL', 'GBM', 'RCC',
  ]);
  const targetCounts = new Map();
  for (const match of titleText.matchAll(/\b[A-Z][A-Z0-9]{1,9}(?:[- ](?:[A-Z]?\d{1,4}[A-Z]?|[A-Z]{1,5}))?\b/g)) {
    const term = cleanTerm(match[0]);
    if (!term || blocked.has(term) || /^\d+$/.test(term)) continue;
    const key = term.toLowerCase();
    targetCounts.set(key, { term, count: (targetCounts.get(key)?.count ?? 0) + 1 });
  }
  const targets = [...targetCounts.values()]
    .sort((a, b) => b.count - a.count || b.term.length - a.term.length)
    .slice(0, 4)
    .map(item => item.term);

  const groups = [];
  if (diseases.length) groups.push(diseases.join(' | '));
  if (targets.length) groups.push(targets.join(' | '));

  if (!groups.length && titles[0]) {
    const stopWords = new Set(['with', 'from', 'that', 'this', 'through', 'using', 'reveals', 'drives', 'study']);
    const phrase = titles[0].split(/\s+/)
      .map(word => cleanTerm(word))
      .filter(word => word.length >= 4 && !stopWords.has(word.toLowerCase()))
      .slice(0, 4)
      .join(' ');
    if (phrase) groups.push(phrase);
  }

  return {
    focus: '根据种子论文标题生成的保守画像：优先关注相关肿瘤类型、分子靶点、因果机制、遗传学干预、体内模型和患者样本证据。当前 AI 画像推理不可用，请在保存前人工核对检索概念。',
    query_groups: groups.slice(0, 2),
    exclude_terms: 'prognostic signature | nomogram',
    query_plan: {
      must_count: Math.min(groups.length, 2),
      should_count: 0,
      fallback: true,
      rationale: `AI 画像失败后由标题规则生成：${cleanText(cause?.message, 240)}`,
    },
    model: 'heuristic',
  };
}

export async function generateProfile(env, papers) {
  const safePapers = papers.slice(0, 12);
  const papersText = safePapers.map((paper, index) => (
    `${index + 1}. PMID ${cleanText(paper.pmid, 20)}\n`
    + `Title: ${cleanText(paper.title, 300)}\n`
    + `Abstract: ${cleanText(paper.abstract || 'No abstract', 650)}`
  )).join('\n\n');

  const messages = [
    {
      role: 'system',
      content: `你是肿瘤分子机制研究者。你的目标不是尽可能罗列关键词，而是生成高召回、可执行的检索计划。\n\n严格规则：\n1. mustConcepts 只能有 1-2 组，表示缺一不可的核心主题，通常是疾病和靶点/核心机制。\n2. shouldConcepts 最多 2 组，只用于严格检索失败后的逐级放宽和后续排序。实验技术默认放 shouldConcepts。\n3. 每组最多 4 个英文标准名或真正高频别名；全部术语合计不超过 16 个。\n4. 不要自动补入过宽父概念，例如已有 KRAS G12D 时不要仅为完整性加入 KRAS。\n5. excludeTerms 最多 3 个，只保留高精度噪声短语。\n6. researcherProfile 用中文概括研究偏好，控制在 250-450 字。\n7. 仅输出 JSON：\n{\n  "researcherProfile": "...",\n  "mustConcepts": [{"terms":["..."]}],\n  "shouldConcepts": [{"terms":["..."]}],\n  "excludeTerms": ["..."],\n  "rationale": "..."\n}`,
    },
    { role: 'user', content: `根据以下论文生成画像：\n\n${papersText}` },
  ];

  try {
    const { parsed, model } = await runAIForJSON(env, messages, {
      chain: PROFILE_CHAIN,
      maxTokens: 850,
      modelTimeoutMs: 60_000,
      totalTimeoutMs: 90_000,
      label: 'profile',
    });
    const profile = normalizeProfile(parsed);
    const queryGroups = [...profile.must, ...profile.should].map(group => group.join(' | '));

    return {
      focus: profile.focus,
      query_groups: queryGroups,
      exclude_terms: profile.excludeTerms.join(' | '),
      query_plan: {
        must_count: profile.must.length,
        should_count: profile.should.length,
        rationale: profile.rationale,
      },
      model,
    };
  } catch (error) {
    console.error(`[AI] profile fallback: ${error.message}`);
    return fallbackProfile(safePapers, error);
  }
}

function containsAny(text, terms) {
  const source = String(text ?? '').toLowerCase();
  return terms.some(term => source.includes(String(term).toLowerCase()));
}

export function heuristicScore(article, queryGroups = []) {
  const title = String(article.title ?? '').toLowerCase();
  const abstract = String(article.abstract ?? '').toLowerCase();
  let titleMatches = 0;
  let abstractMatches = 0;

  for (const group of queryGroups) {
    const terms = splitOnPipe(group).map(term => term.trim()).filter(Boolean);
    if (containsAny(title, terms)) titleMatches += 1;
    else if (containsAny(abstract, terms)) abstractMatches += 1;
  }

  const signalText = `${title} ${abstract}`;
  const mechanistic = /(mechanis|pathway|axis|mediated|dependent|regulat|drives|suppresses)/i.test(signalText);
  const causal = /(knockout|knockdown|rescue|mutant|inhibitor|overexpression|deletion|crispr)/i.test(signalText);
  const inVivo = /(mouse|mice|xenograft|organoid|patient-derived|in vivo|clinical sample)/i.test(signalText);
  const noveltySignal = /(novel|unexpected|previously unknown|first|uncover|reveal)/i.test(signalText);
  const hasAbstract = abstract.length >= 120;

  const relevance = clampInt(4 + titleMatches * 2 + abstractMatches, 1, 10);
  const evidence = clampInt(3 + Number(causal) * 2 + Number(inVivo) * 2 + Number(hasAbstract), 1, 10);
  const novelty = clampInt(4 + Number(noveltySignal) * 2 + Number(mechanistic), 1, 10);
  const surprise = clampInt(4 + Number(/unexpected|paradox|contrary|independent of/i.test(signalText)) * 3, 1, 10);
  const experimentValue = clampInt(4 + Number(causal) * 2 + Number(mechanistic) + Number(inVivo), 1, 10);

  return {
    relevance,
    novelty,
    evidence,
    surprise,
    experiment_value: experimentValue,
    total: relevance + novelty + evidence + surprise + experimentValue,
  };
}

function normalizeRankItems(parsed, articleCount) {
  const rawItems = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.articles ?? parsed.results ?? [];
  if (!Array.isArray(rawItems)) return [];

  const seen = new Set();
  const output = [];
  for (const raw of rawItems) {
    const index = Number(raw?.index);
    if (!Number.isInteger(index) || index < 0 || index >= articleCount || seen.has(index)) continue;
    seen.add(index);
    const relevance = clampInt(raw.relevance ?? 5, 1, 10);
    const novelty = clampInt(raw.novelty ?? 5, 1, 10);
    const evidence = clampInt(raw.evidence ?? 5, 1, 10);
    const surprise = clampInt(raw.surprise ?? 5, 1, 10);
    const experimentValue = clampInt(raw.experiment_value ?? raw.experimentValue ?? 5, 1, 10);
    output.push({
      index,
      relevance,
      novelty,
      evidence,
      surprise,
      experiment_value: experimentValue,
      total: relevance + novelty + evidence + surprise + experimentValue,
    });
  }
  return output;
}

function fallbackAnalysis(article, scores) {
  const title = cleanText(article.title, 240);
  const abstract = cleanText(article.abstract, 500);
  const evidenceLevel = scores.evidence >= 8 ? '强' : scores.evidence >= 5 ? '中' : '弱';
  return {
    evidence_level: evidenceLevel,
    why_interesting: `该论文与当前检索主题匹配，题目为“${title}”。AI 详细解读暂不可用，建议优先核对摘要、实验设计和原始数据。`,
    mechanism_chain: abstract
      ? `摘要提示其围绕“${title}”展开；具体因果链需结合全文核验。`
      : '无可用摘要，无法可靠提取机制链。',
    key_evidence: abstract ? '请重点核对摘要中提到的干预、对照、体内模型和患者样本证据。' : '无摘要，需直接查看全文。',
    major_concern: '当前条目仅基于标题、摘要和元数据，不能替代全文质量评估。',
    next_experiment: '根据论文核心结论设计独立干预与 rescue 实验，并在正交模型中复现。',
  };
}

function normalizeEnrichment(parsed, selected) {
  const rawItems = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.articles ?? [];
  if (!Array.isArray(rawItems)) return new Map();
  const map = new Map();

  for (const raw of rawItems) {
    const index = Number(raw?.index);
    if (!Number.isInteger(index) || index < 0 || index >= selected.length || map.has(index)) continue;
    map.set(index, {
      evidence_level: ['强', '中', '弱'].includes(raw.evidence_level) ? raw.evidence_level : null,
      why_interesting: cleanText(raw.why_interesting, 700),
      mechanism_chain: cleanText(raw.mechanism_chain, 500),
      key_evidence: cleanText(raw.key_evidence, 500),
      major_concern: cleanText(raw.major_concern, 500),
      next_experiment: cleanText(raw.next_experiment, 500),
    });
  }
  return map;
}

export async function scorePapers(env, articles, focus, maxArticles, queryGroups = []) {
  const batch = articles.slice(0, 10);
  const focusText = cleanText(
    focus || '优先原创机制研究、遗传学因果证据、rescue、体内模型和患者样本。',
    1800,
  );

  const baseline = batch.map(article => heuristicScore(article, queryGroups));
  let ranking = baseline.map((score, index) => ({ index, ...score }));
  const models = [];
  let rankingAIAvailable = false;

  if (batch.length) {
    const compactArticles = batch.map((article, index) => (
      `${index}. ${cleanText(article.title, 260)}\n${cleanText(article.abstract || 'No abstract', 520)}`
    )).join('\n\n');

    try {
      const { parsed, model } = await runAIForJSON(env, [
        {
          role: 'system',
          content: `你是肿瘤机制论文筛选器。依据标题和摘要，对每个候选给出五个 1-10 整数分数：relevance、novelty、evidence、surprise、experiment_value。不要生成解释文字。每个候选恰好出现一次。仅输出：{"items":[{"index":0,"relevance":1,"novelty":1,"evidence":1,"surprise":1,"experiment_value":1}]}`,
        },
        { role: 'user', content: `研究偏好：${focusText}\n\n候选：\n${compactArticles}` },
      ], {
        chain: SCORE_CHAIN, maxTokens: 700, modelTimeoutMs: 50_000,
        totalTimeoutMs: 75_000, label: 'ranking',
      });

      const normalized = normalizeRankItems(parsed, batch.length);
      if (normalized.length) {
        const byIndex = new Map(normalized.map(item => [item.index, item]));
        ranking = baseline.map((score, index) => byIndex.get(index) ?? { index, ...score });
        models.push(model);
        rankingAIAvailable = true;
      }
    } catch (error) {
      console.error(`[AI] ranking fallback: ${error.message}`);
    }
  }

  ranking.sort((a, b) => b.total - a.total || a.index - b.index);
  const selectedRanks = ranking.slice(0, clampInt(maxArticles, 1, 10));
  const selected = selectedRanks.map(item => ({ article: batch[item.index], scores: item }));
  let enrichment = new Map();

  if (selected.length && rankingAIAvailable) {
    const detailsText = selected.map(({ article, scores }, index) => (
      `${index}. ${cleanText(article.title, 260)}\n`
      + `Scores: relevance=${scores.relevance}, novelty=${scores.novelty}, evidence=${scores.evidence}, surprise=${scores.surprise}, experiment_value=${scores.experiment_value}\n`
      + `Abstract: ${cleanText(article.abstract || 'No abstract', 620)}`
    )).join('\n\n');

    try {
      const { parsed, model } = await runAIForJSON(env, [
        {
          role: 'system',
          content: `你是严谨的肿瘤分子机制研究者。仅依据标题和摘要，为已入选论文生成简洁中文解读。不得虚构样本量、模型、统计结果或因果关系；摘要未提供时必须明确说无法判断。仅输出 JSON：{"items":[{"index":0,"evidence_level":"强|中|弱","why_interesting":"1-2句","mechanism_chain":"1句","key_evidence":"1句","major_concern":"1句","next_experiment":"1句"}]}`,
        },
        { role: 'user', content: `研究偏好：${focusText}\n\n入选论文：\n${detailsText}` },
      ], {
        chain: SCORE_CHAIN, maxTokens: 2500, modelTimeoutMs: 60_000,
        totalTimeoutMs: 90_000, label: 'enrichment',
      });
      enrichment = normalizeEnrichment(parsed, selected);
      models.push(model);
    } catch (error) {
      console.error(`[AI] enrichment fallback: ${error.message}`);
    }
  }

  const output = selected.map(({ article, scores }, index) => {
    const fallback = fallbackAnalysis(article, scores);
    const detail = enrichment.get(index) ?? {};
    return {
      ...article,
      rank: index + 1,
      relevance: scores.relevance,
      novelty: scores.novelty,
      evidence: scores.evidence,
      surprise: scores.surprise,
      experiment_value: scores.experiment_value,
      total: scores.total,
      evidence_level: detail.evidence_level || fallback.evidence_level,
      why_interesting: detail.why_interesting || fallback.why_interesting,
      mechanism_chain: detail.mechanism_chain || fallback.mechanism_chain,
      key_evidence: detail.key_evidence || fallback.key_evidence,
      major_concern: detail.major_concern || fallback.major_concern,
      next_experiment: detail.next_experiment || fallback.next_experiment,
    };
  });

  const uniqueModels = [...new Set(models)];
  return {
    articles: output,
    models: uniqueModels,
    model: uniqueModels.length ? uniqueModels.map(model => MODEL_LABELS[model] || model).join(' + ') : MODEL_LABELS.heuristic,
  };
}
