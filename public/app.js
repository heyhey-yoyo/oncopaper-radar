/* ═══════════════════════════════════════════════════════════
   OncoPaper Radar — App Logic
   ═══════════════════════════════════════════════════════════ */

const DEMO = new URLSearchParams(location.search).has('demo');

const DEMO_DATA = {
  digest: {
    id: 1,
    run_at: '2026-07-29T05:00:00Z',
    query_text: '(KRAS G12D OR KRASG12D) AND (pancreatic cancer OR PDAC)',
    candidate_count: 14,
    selected_count: 3,
    status: 'ok',
  },
  articles: [
    {
      rank: 1, title: 'KRASG12D drives metabolic reprogramming toward ferroptosis evasion in PDAC via NRF2-dependent glutathione synthesis',
      authors: 'Chen L, Wang M, Zhang Q, et al.',
      journal: 'Cancer Cell', pub_date: '2026-07-24', article_url: '#',
      abstract: 'Mutant KRAS reprograms redox homeostasis in pancreatic ductal adenocarcinoma. Here we show that KRASG12D upregulates NRF2 via PI3K/AKT signaling, increasing glutathione biosynthesis and conferring resistance to ferroptosis. Genetic ablation of NRF2 or pharmacological inhibition with RSL3 synergizes with gemcitabine in patient-derived xenografts.',
      relevance: 9, novelty: 8, evidence: 8, surprise: 7, experiment_value: 9, total: 41,
      evidence_level: '强',
      why_interesting: '首次在 PDAC 中建立 KRASG12D → NRF2 → 铁死亡抵抗的完整信号轴，提供可成药的代谢靶点。PDX 模型和临床样本验证使结论可信度很高。',
      mechanism_chain: 'KRASG12D → PI3K/AKT → NRF2 → GSH 合成上调 → 铁死亡逃逸',
      key_evidence: 'NRF2 敲除 + RSL3 在 3 个 PDX 模型中显著抑制肿瘤生长且与吉西他滨协同。',
      major_concern: 'PDX 模型在免疫缺陷小鼠中进行，未评估铁死亡引起的免疫原性细胞死亡效应。',
      next_experiment: '在免疫健全的 KPC 小鼠模型中验证 RSL3+吉西他滨+anti-PD-1 三联方案。',
    },
    {
      rank: 2, title: 'Single-cell dissection of KRASG12D-mutant pancreatic tumors reveals a myeloid-driven immune exclusion program',
      authors: 'Park J, Rodriguez M, et al.',
      journal: 'Nature Cancer', pub_date: '2026-07-26', article_url: '#',
      abstract: 'Using scRNA-seq of 28 KRASG12D PDAC specimens, we identify a novel CXCL1+ tumor-associated macrophage (TAM) subset that recruits MDSCs and excludes CD8+ T cells. This subset is driven by tumor-cell-derived CSF1 in a KRAS-dependent manner.',
      relevance: 8, novelty: 9, evidence: 7, surprise: 8, experiment_value: 8, total: 40,
      evidence_level: '中',
      why_interesting: '发现了新的免疫排斥机制：KRASG12D 肿瘤通过 CSF1 驯化特定巨噬细胞亚群排斥 T 细胞。为免疫治疗抵抗提供新解释。',
      mechanism_chain: 'KRASG12D → 肿瘤分泌 CSF1 → CXCL1+ TAM → MDSC 招募 → CD8+ T 细胞排斥',
      key_evidence: 'CSF1R 抑制剂在 KPC 模型中减少 CXCL1+ TAM，恢复 T 细胞浸润。',
      major_concern: '样本量 28 例仍偏小，且 scRNA-seq 无法分辨空间关系。',
      next_experiment: '空间转录组学验证 CXCL1+ TAM 与 T 细胞排除区的空间共定位。',
    },
    {
      rank: 3, title: 'Irisin/FNDC5 suppresses PDAC liver metastasis by protecting hepatic stellate cell quiescence',
      authors: 'Thompson R, Lee S, et al.',
      journal: 'Gut', pub_date: '2026-07-25', article_url: '#',
      abstract: 'We show that the myokine irisin (FNDC5) is downregulated during PDAC liver metastasis. Restoring irisin levels prevents hepatic stellate cell activation, blocking the formation of a pro-metastatic niche independently of primary tumor burden.',
      relevance: 7, novelty: 9, evidence: 7, surprise: 9, experiment_value: 8, total: 40,
      evidence_level: '中',
      why_interesting: '运动因子 irisin 抗肿瘤转移的机制非常反直觉——不通过免疫系统而通过维持肝星状细胞静息来阻断转移前微环境。',
      mechanism_chain: '运动 → irisin/FNDC5 → 肝星状细胞静息维持 → 转移前微环境形成受阻 → 肝转移减少',
      key_evidence: '外源 irisin 注射在小鼠模型中减少 70% 肝转移灶且不影响原发瘤。',
      major_concern: 'irisin 半衰期短，临床转化需解决给药方式；患者运动能力差异大。',
      next_experiment: '开发 irisin-Fc 融合蛋白延长半衰期，验证慢性给药的抗转移效果。',
    },
  ],
};

/* ── State ────────────────────────────────────────────────── */
const S = {
  token: localStorage.getItem('oncopaper_admin_token') || '',
  settings: null,
  latest: null,
};

/* ── Init ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  if (DEMO) {
    renderAll(DEMO_DATA);
    return;
  }
  loadLatest();
  document.getElementById('adminBtn').addEventListener('click', toggleAdmin);
  document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
  document.getElementById('syncBtn').addEventListener('click', triggerSync);

  // 恢复存储的令牌
  const tokenInput = document.getElementById('adminToken');
  if (S.token) tokenInput.value = S.token;
  tokenInput.addEventListener('change', () => {
    S.token = tokenInput.value.trim();
    localStorage.setItem('oncopaper_admin_token', S.token);
  });
});

/* ── API helpers ──────────────────────────────────────────── */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers['Authorization'] = `Bearer ${S.token}`;
  const res = await fetch(`/api${path}`, { headers, ...opts });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ── Load latest ──────────────────────────────────────────── */
async function loadLatest() {
  showLoading('加载最新简报...');
  try {
    const data = await api('/digests/latest');
    S.latest = data;
    if (!data.digest) {
      showEmpty();
    } else if (data.digest.status !== 'ok') {
      showEmpty(data.digest.status);
    } else if (!data.articles.length) {
      showEmpty('empty');
    } else {
      renderAll(data);
    }
  } catch (e) {
    showEmpty('error');
    console.error(e);
  }
}

/* ── Render ───────────────────────────────────────────────── */
function renderAll(data) {
  const { digest, articles } = data;

  // 概览
  const overview = document.getElementById('overviewCard');
  overview.hidden = false;
  document.getElementById('overviewDate').textContent =
    `📅 ${new Date(digest.run_at).toLocaleString('zh-CN')}`;

  const badge = document.getElementById('overviewBadge');
  badge.textContent = `入选 ${articles.length} 篇`;
  badge.className = articles.length ? 'overview-badge' : 'overview-badge warn';

  document.getElementById('overviewMeta').textContent =
    `从 ${digest.candidate_count} 篇候选中选出 · 检索: ${digest.query_text?.slice(0, 80) ?? ''}…`;

  // 文章
  const container = document.getElementById('articlesList');
  container.innerHTML = articles.map(a => `
    <div class="card article-card">
      <div class="article-header">
        <span class="article-rank">${a.rank}</span>
        <h3 class="article-title">
          <a href="${a.article_url}" target="_blank" rel="noopener">${escHtml(a.title)}</a>
        </h3>
      </div>

      <div class="article-meta">
        <span>${escHtml(a.authors || 'Unknown')}</span>
        <span>·</span>
        <span><strong>${escHtml(a.journal || 'N/A')}</strong></span>
        <span>·</span>
        <span>${a.pub_date ?? ''}</span>
        <span>·</span>
        <span>证据: <strong>${a.evidence_level}</strong></span>
      </div>

      <div class="scores">
        <div class="score-item"><span class="score-label">相关</span><span class="score-value">${a.relevance}</span></div>
        <div class="score-item"><span class="score-label">新颖</span><span class="score-value">${a.novelty}</span></div>
        <div class="score-item"><span class="score-label">证据</span><span class="score-value">${a.evidence}</span></div>
        <div class="score-item"><span class="score-label">反直觉</span><span class="score-value">${a.surprise}</span></div>
        <div class="score-item"><span class="score-label">启发</span><span class="score-value">${a.experiment_value}</span></div>
        <span class="score-total">总分 ${a.total}</span>
      </div>

      <div class="analysis">
        <div class="analysis-item analysis-full">
          <h4>为什么值得看</h4>
          <p>${escHtml(a.why_interesting)}</p>
        </div>
        <div class="analysis-item">
          <h4>机制链</h4>
          <p>${escHtml(a.mechanism_chain) || '—'}</p>
        </div>
        <div class="analysis-item">
          <h4>关键证据</h4>
          <p>${escHtml(a.key_evidence) || '—'}</p>
        </div>
        <div class="analysis-item">
          <h4>主要疑点</h4>
          <p>${escHtml(a.major_concern) || '—'}</p>
        </div>
        <div class="analysis-item">
          <h4>下一步实验</h4>
          <p>${escHtml(a.next_experiment) || '—'}</p>
        </div>
      </div>
    </div>
  `).join('');

  document.getElementById('emptyState').hidden = true;
  document.getElementById('loadingState').hidden = true;

  // 如果在 demo 模式，显示提示
  if (DEMO) {
    overview.insertAdjacentHTML('beforebegin',
      '<div class="card" style="padding:12px 20px;margin-bottom:20px;background:#fffbeb;border-color:#fcd34d">' +
      '<strong>⚠️ 演示模式</strong> — 这是假数据，不调用 Europe PMC、Workers AI 或 D1。去掉 URL 中的 <code>?demo=1</code> 查看真实数据。</div>'
    );
  }
}

/* ── Admin ────────────────────────────────────────────────── */
async function toggleAdmin() {
  const panel = document.getElementById('adminPanel');
  if (panel.hidden) {
    panel.hidden = false;
    await loadSettings();
  } else {
    panel.hidden = true;
  }
}

async function loadSettings() {
  try {
    const s = await api('/settings');
    S.settings = s;
    document.getElementById('queryGroups').value = (s.query_groups || []).join('\n');
    document.getElementById('focus').value = s.focus || '';
    document.getElementById('excludeTerms').value = s.exclude_terms || '';
    document.getElementById('maxArticles').value = s.max_articles || 5;
    document.getElementById('lookbackDays').value = s.lookback_days || 7;
    document.getElementById('excludeReviews').checked = s.exclude_reviews !== 0;
    document.getElementById('adminMessage').hidden = true;
  } catch (e) {
    // 可能数据库还没初始化，不报错
    console.warn('Load settings failed:', e);
  }
}

async function saveConfig() {
  const msg = document.getElementById('adminMessage');
  try {
    const queryGroups = document.getElementById('queryGroups').value
      .split('\n').map(s => s.trim()).filter(Boolean);
    const body = {
      query_groups: queryGroups,
      focus: document.getElementById('focus').value.trim(),
      exclude_terms: document.getElementById('excludeTerms').value.trim(),
      max_articles: Number(document.getElementById('maxArticles').value),
      lookback_days: Number(document.getElementById('lookbackDays').value),
      exclude_reviews: document.getElementById('excludeReviews').checked,
    };
    await api('/settings', { method: 'POST', body: JSON.stringify(body) });
    msg.hidden = false;
    msg.className = 'message success';
    msg.textContent = '✅ 配置已保存';
  } catch (e) {
    msg.hidden = false;
    msg.className = 'message error';
    msg.textContent = `❌ ${e.message}`;
  }
}

async function triggerSync() {
  const msg = document.getElementById('adminMessage');
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 同步中...';
  try {
    const result = await api('/sync', { method: 'POST' });
    msg.hidden = false;
    msg.className = 'message success';
    msg.textContent = result.status === 'ok'
      ? `✅ 同步完成！入选 ${result.selected_count} 篇`
      : `⚠️ ${result.status}: ${result.error || '无新文章'}`;
    if (result.status === 'ok') await loadLatest();
  } catch (e) {
    msg.hidden = false;
    msg.className = 'message error';
    msg.textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ 立即同步';
  }
}

/* ── UI helpers ───────────────────────────────────────────── */
function showLoading(text) {
  document.getElementById('loadingState').hidden = false;
  document.getElementById('loadingText').textContent = text;
  document.getElementById('emptyState').hidden = true;
  document.getElementById('overviewCard').hidden = true;
  document.getElementById('articlesList').innerHTML = '';
}

function showEmpty(reason) {
  document.getElementById('loadingState').hidden = true;
  document.getElementById('overviewCard').hidden = true;
  document.getElementById('articlesList').innerHTML = '';

  const el = document.getElementById('emptyState');
  el.hidden = false;
  const h2 = el.querySelector('h2');
  const p = el.querySelector('p');

  if (reason === 'empty') {
    h2.textContent = '暂无入选文章';
    p.textContent = '最近一次同步没有找到符合条件的文章。试试放宽检索条件或增加回看天数。';
  } else if (reason === 'error') {
    h2.textContent = '加载失败';
    p.textContent = '请检查 D1 是否已初始化，或打开浏览器控制台查看错误。';
  } else {
    // 无论证记录
    h2.textContent = '还没有简报';
    p.textContent = '点击右上角 ⚙️ 配置检索关键词，然后手动同步或等待每日自动同步。';
  }
}

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
