/* ============================================================
   OncoPaper Radar — Unified AI Service
   Model chain, JSON parsing, fallback, caching
   ============================================================ */

// ── Model chains ───────────────────────────────────────────
const GLM    = '@cf/zai-org/glm-4.7-flash';
const QWEN   = '@cf/qwen/qwen3-30b-a3b-fp8';
const GRANITE = '@cf/ibm-granite/granite-4.0-h-micro';

// Profile: Qwen first (GLM times out on free tier), GLM as quality fallback
const PROFILE_CHAIN = [QWEN, GLM, GRANITE];
// Scoring: GLM first (deep reasoning for nuanced paper evaluation)
const SCORE_CHAIN   = [GLM, QWEN, GRANITE];
// Default for other tasks
const MODEL_CHAIN   = [QWEN, GLM, GRANITE];

// ── Prompt version (bump to invalidate caches) ──────────────
export const PROMPT_VERSION = '2026-07-29-v1';

// ── Model display names ─────────────────────────────────────
export const MODEL_LABELS = {
  [GLM]:     'GLM-4.7-Flash',
  [QWEN]:    'Qwen3-30B-A3B',
  [GRANITE]: 'Granite 4.0 H Micro',
};

// ── Extract text from Workers AI response ──────────────────
function extractTexts(result) {
  // Returns { primary, fallback } — primary is content (most models put answer here)
  // fallback is reasoning_content (GLM may put answer here if content is reasoning)
  if (typeof result === 'string') return { primary: result };
  if (!result || typeof result !== 'object') return {};

  const msg = result.choices?.[0]?.message
           || result.response?.choices?.[0]?.message;
  if (!msg) {
    if (typeof result.response === 'string') return { primary: result.response };
    return {};
  }

  return {
    primary: typeof msg.content === 'string' ? msg.content : null,
    fallback: typeof msg.reasoning_content === 'string' ? msg.reasoning_content
           : typeof msg.reasoning === 'string' ? msg.reasoning : null,
  };
}

// ── JSON extraction with markdown guard ─────────────────────
function parseJSON(text) {
  // Direct parse
  try { return JSON.parse(text); } catch {/* */}

  // Strip ```json ... ``` fences
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
  try { return JSON.parse(cleaned); } catch {/* */}

  // Extract first {...}
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {/* */} }

  // Extract first [...]
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch {/* */} }

  return null;
}

// ── Unified AI call with fallback chain ────────────────────
export async function runAI(env, messages, options = {}) {
  const {
    temperature = 0.1,
    maxCompletionTokens = 8000,
    chain = MODEL_CHAIN,
  } = options;

  let lastError = null;

  for (const model of chain) {
    try {
      const params = { messages, temperature, max_completion_tokens: maxCompletionTokens, reasoning_effort: 'low' };
      console.log(`[AI] trying ${model}, tokens=${maxCompletionTokens}`);
      const result = await env.AI.run(model, params);

      const texts = extractTexts(result);
      const primary = texts.primary?.trim();
      const fallback = texts.fallback?.trim();
      console.log(`[AI] ${model} primary=${primary?.length || 0} fallback=${fallback?.length || 0}`);

      if ((!primary || primary.length < 3) && (!fallback || fallback.length < 3)) {
        const keys = Object.keys(result || {});
        throw new Error(`Empty response from ${model}. Keys: ${keys.join(',')}`);
      }

      return { text: primary || '', fallbackText: fallback || '', model };
    } catch (err) {
      lastError = err;
      console.error(`[AI] ${model} FAILED: ${err.message}`);
    }
  }

  throw new Error(`All models failed. Last error: ${lastError?.message}`);
}

// ── Run and parse JSON ─────────────────────────────────────
export async function runAIForJSON(env, messages, options = {}) {
  const { text, fallbackText, model } = await runAI(env, messages, {
    ...options,
    chain: options.chain ?? MODEL_CHAIN,
    temperature: options.temperature ?? 0.1,
  });

  // Try primary text first (content field), then fallback (reasoning_content)
  let parsed = parseJSON(text);
  let source = 'content';
  if (!parsed && fallbackText) {
    parsed = parseJSON(fallbackText);
    source = 'reasoning_content';
  }
  if (!parsed) {
    throw new Error(`Cannot parse JSON from ${model}. Content: ${text.slice(0, 150)}... Fallback: ${(fallbackText||'').slice(0, 150)}`);
  }
  console.log(`[AI] JSON parsed from ${source}, fields: ${Object.keys(parsed).join(',')}`);

  return { parsed, model };
}

// ── Generate researcher profile from PMIDs ──────────────────
export async function generateProfile(env, papers) {
  const papersText = papers.map((p, i) =>
    `${i + 1}. [PMID: ${p.pmid}] ${p.title}\n   ${(p.abstract || '').slice(0, 800)}`
  ).join('\n\n');

  const messages = [
    { role: 'system', content: `你是肿瘤分子机制领域的资深研究者。分析用户提供的论文，深入理解其研究方向和偏好：

1. researcherProfile: 详细总结研究兴趣（300-500字）：
   - 核心生物学问题（疾病、通路、表型）
   - 主要使用的方法学（体内模型、类器官、组学、生信等）
   - 实验设计偏好（rescue实验、时间序列、剂量梯度等）
   - 理论倾向（机制优先、转化导向、筛选发现等）

2. concepts: 提取核心检索概念，每行一个概念，同义词用 | 分隔
   - 基因/蛋白: 如 KRAS G12D | KRASG12D | KRAS
   - 疾病: 如 pancreatic cancer | PDAC | pancreatic ductal adenocarcinoma
   - 通路/表型: 如 ferroptosis | lipid peroxidation | iron death
   - 技术: 如 single-cell RNA-seq | scRNA-seq
   每个概念尽量列出英文标准名 + 常见别名

3. excludeTerms: 根据论文类型和方向，推测应排除的噪声词
   - 例如如果关注原创机制研究，可排除: prognostic signature | nomogram | bioinformatics analysis | pan-cancer

4. rationale: 用 3-5 句说明推断依据

只输出 JSON，不要任何额外文字。` },
    { role: 'user', content: `以下是我感兴趣的论文，请分析我的研究兴趣：\n\n${papersText}` },
  ];

  const { parsed, model } = await runAIForJSON(env, messages, { chain: PROFILE_CHAIN, maxCompletionTokens: 6000 });

  return {
    focus: parsed.researcherProfile || '',
    query_groups: (parsed.concepts || []).map(c => Array.isArray(c) ? c.join(' | ') : c),
    exclude_terms: (parsed.excludeTerms || []).join(' | '),
    model,
  };
}

// ── Score a batch of papers ─────────────────────────────────
export async function scorePapers(env, articles, focus, maxArticles) {
  const batch = articles.slice(0, 10);
  const focusText = focus || 'Prioritize mechanistic studies with genetic evidence, rescue experiments, and in vivo validation.';

  const articlesText = batch.map((a, i) =>
    `${i}. [PMID: ${a.pmid || 'N/A'}] ${a.title}\n   ${(a.abstract || 'No abstract').slice(0, 800)}`
  ).join('\n\n');

  const { parsed, model } = await runAIForJSON(env, [
    { role: 'system', content: `你是肿瘤分子机制领域的资深研究者。从候选论文中选出最值得关注的 ${maxArticles} 篇。

研究者偏好：${focusText}

输出 JSON：
{
  "articles": [
    {
      "index": 候选编号,
      "relevance": 1-10,
      "novelty": 1-10,
      "evidence": 1-10,
      "surprise": 1-10,
      "experiment_value": 1-10,
      "evidence_level": "强/中/弱",
      "why_interesting": "2-3句话",
      "mechanism_chain": "1-2句话",
      "key_evidence": "一句话",
      "major_concern": "一句话",
      "next_experiment": "一句话"
    }
  ]
}

只输出 JSON。未入选的论文不要包含。按总分从高到低排列，最多${maxArticles}篇。` },
    { role: 'user', content: `候选论文：\n\n${articlesText}` },
  ], { chain: SCORE_CHAIN, temperature: 0, maxCompletionTokens: 800 * maxArticles + 1000 });

  const items = Array.isArray(parsed) ? parsed : (parsed.articles ?? parsed.results ?? []);
  if (!items.length) throw new Error('AI returned empty articles array');

  return {
    articles: items.slice(0, maxArticles).map((item, idx) => {
      const articleIdx = typeof item.index === 'number' ? item.index : idx;
      const article = batch[articleIdx] ?? batch[idx];
      const total = (item.relevance ?? 0) + (item.novelty ?? 0) + (item.evidence ?? 0) +
                    (item.surprise ?? 0) + (item.experiment_value ?? 0);
      return {
        ...article,
        rank: idx + 1,
        relevance: item.relevance ?? 5,
        novelty: item.novelty ?? 5,
        evidence: item.evidence ?? 5,
        surprise: item.surprise ?? 5,
        experiment_value: item.experiment_value ?? 5,
        total,
        evidence_level: item.evidence_level ?? '中',
        why_interesting: item.why_interesting ?? '',
        mechanism_chain: item.mechanism_chain ?? '',
        key_evidence: item.key_evidence ?? '',
        major_concern: item.major_concern ?? '',
        next_experiment: item.next_experiment ?? '',
      };
    }),
    model,
  };
}

// ── PMID-based paper cache ──────────────────────────────────
export function cacheKey(pmid, task) {
  return `ai-cache:${PROMPT_VERSION}:${task}:${pmid}`;
}

export async function getCached(env, pmid, task) {
  try {
    const row = await env.DB.prepare(
      'SELECT result, model, created_at FROM paper_cache WHERE cache_key = ?'
    ).bind(cacheKey(pmid, task)).first();
    if (row) return JSON.parse(row.result);
  } catch {/* table may not exist */}
  return null;
}

export async function setCache(env, pmid, task, result, model) {
  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO paper_cache (cache_key, pmid, task, model, result, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
    `).bind(cacheKey(pmid, task), pmid, task, model, JSON.stringify(result)).run();
  } catch {/* table may not exist */}
}

// ── Concurrency limiter ─────────────────────────────────────
export async function asyncPool(limit, items, fn) {
  const results = [];
  const executing = new Set();
  for (const [i, item] of items.entries()) {
    const p = Promise.resolve().then(() => fn(item, i));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}
