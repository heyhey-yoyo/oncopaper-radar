/* ═══════════════════════════════════════════════════════════
   OncoPaper Radar — App
   ═══════════════════════════════════════════════════════════ */

const DEMO = new URLSearchParams(location.search).has('demo');

/* ── Demo data ────────────────────────────────────────────── */
const DEMO_DATA = {
  digest: {
    run_at: '2026-07-29T05:00:00Z',
    query_text: '(KRAS G12D OR KRASG12D) AND (pancreatic cancer OR PDAC)',
    candidate_count: 14,
    selected_count: 3,
    status: 'ok',
  },
  articles: [
    {
      rank: 1, title: 'KRASG12D drives metabolic reprogramming toward ferroptosis evasion in PDAC via NRF2-dependent glutathione synthesis',
      authors: 'Chen L, Wang M, Zhang Q, et al.', journal: 'Cancer Cell', pub_date: '2026-07-24',
      article_url: '#', relevance: 9, novelty: 8, evidence: 8, surprise: 7, experiment_value: 9, total: 41,
      evidence_level: '强',
      why_interesting: '首次在 PDAC 中建立 KRASG12D → NRF2 → 铁死亡抵抗的完整信号轴，提供可成药的代谢靶点。PDX 模型和临床样本验证使结论可信度很高。',
      mechanism_chain: 'KRASG12D → PI3K/AKT → NRF2 → GSH 合成上调 → 铁死亡逃逸',
      key_evidence: 'NRF2 敲除 + RSL3 在 3 个 PDX 模型中显著抑制肿瘤生长且与吉西他滨协同。',
      major_concern: 'PDX 模型在免疫缺陷小鼠中进行，未评估铁死亡引起的免疫原性细胞死亡效应。',
      next_experiment: '在免疫健全的 KPC 小鼠模型中验证 RSL3+吉西他滨+anti-PD-1 三联方案。',
    },
    {
      rank: 2, title: 'Single-cell dissection of KRASG12D-mutant pancreatic tumors reveals a myeloid-driven immune exclusion program',
      authors: 'Park J, Rodriguez M, et al.', journal: 'Nature Cancer', pub_date: '2026-07-26',
      article_url: '#', relevance: 8, novelty: 9, evidence: 7, surprise: 8, experiment_value: 8, total: 40,
      evidence_level: '中',
      why_interesting: '发现 KRASG12D 肿瘤通过 CSF1 驯化特定巨噬细胞亚群排斥 T 细胞，为免疫治疗抵抗提供新解释。',
      mechanism_chain: 'KRASG12D → 肿瘤分泌 CSF1 → CXCL1+ TAM → MDSC 招募 → CD8+ T 细胞排斥',
      key_evidence: 'CSF1R 抑制剂在 KPC 模型中减少 CXCL1+ TAM，恢复 T 细胞浸润。',
      major_concern: '样本量 28 例仍偏小，且 scRNA-seq 无法分辨空间关系。',
      next_experiment: '空间转录组学验证 CXCL1+ TAM 与 T 细胞排除区的空间共定位。',
    },
    {
      rank: 3, title: 'Irisin/FNDC5 suppresses PDAC liver metastasis by protecting hepatic stellate cell quiescence',
      authors: 'Thompson R, Lee S, et al.', journal: 'Gut', pub_date: '2026-07-25',
      article_url: '#', relevance: 7, novelty: 9, evidence: 7, surprise: 9, experiment_value: 8, total: 40,
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
  isLoggedIn: false,
};

/* ── DOM refs ─────────────────────────────────────────────── */
const $ = (s) => document.querySelector(s);

/* ── Init ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  if (DEMO) { renderArticles(DEMO_DATA); showDemoBanner(); return; }

  // 尝试用已存储的 token 验证登录
  if (S.token) verifyToken();

  // 顶栏按钮
  $('#settingsBtn').addEventListener('click', openDrawer);
  $('#loginBtn').addEventListener('click', openLogin);
  $('#logoutBtn').addEventListener('click', doLogout);

  // 登录弹窗
  $('#loginConfirmBtn').addEventListener('click', doLogin);
  $('#loginCancelBtn').addEventListener('click', closeLogin);
  $('#loginTokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // 抽屉
  $('#closeDrawerBtn').addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);
  $('#saveConfigBtn').addEventListener('click', saveConfig);
  $('#syncBtn').addEventListener('click', triggerSync);
  $('#emptySettingsBtn').addEventListener('click', openDrawer);
  $('#drawerLoginBtn').addEventListener('click', openLogin);

  loadLatest();
});

/* ── Auth ─────────────────────────────────────────────────── */
function updateAuthUI() {
  if (S.isLoggedIn) {
    $('#loginBtn').hidden = true;
    $('#logoutBtn').hidden = false;
    $('#settingsBtn').classList.add('active');
    $('#saveConfigBtn').disabled = false;
    $('#syncBtn').disabled = false;
    const prompt = $('#drawerLoginPrompt');
    if (prompt) prompt.hidden = true;
  } else {
    $('#loginBtn').hidden = false;
    $('#logoutBtn').hidden = true;
    $('#settingsBtn').classList.remove('active');
    $('#saveConfigBtn').disabled = true;
    $('#syncBtn').disabled = true;
    const prompt = $('#drawerLoginPrompt');
    if (prompt) prompt.hidden = false;
  }
}

async function verifyToken() {
  try {
    // 调用 settings 接口验证 token
    await api('/settings');
    S.isLoggedIn = true;
    updateAuthUI();
  } catch {
    S.isLoggedIn = false;
    S.token = '';
    localStorage.removeItem('oncopaper_admin_token');
    updateAuthUI();
  }
}

function openLogin() {
  $('#loginModal').hidden = false;
  $('#loginTokenInput').value = '';
  $('#loginMsg').hidden = true;
  $('#loginTokenInput').focus();
}

function closeLogin() {
  $('#loginModal').hidden = true;
}

async function doLogin() {
  const token = $('#loginTokenInput').value.trim();
  if (!token) { showLoginMsg('请输入令牌', 'error'); return; }

  S.token = token;
  try {
    await api('/settings');
    S.isLoggedIn = true;
    localStorage.setItem('oncopaper_admin_token', token);
    updateAuthUI();
    closeLogin();
    showToast('✅ 已登录', 'success');
    // 如果抽屉开着，刷新表单
    if (!drawer.hidden) loadSettingsIntoForm();
  } catch {
    S.token = '';
    S.isLoggedIn = false;
    showLoginMsg('令牌不正确', 'error');
  }
}

function doLogout() {
  S.token = '';
  S.isLoggedIn = false;
  localStorage.removeItem('oncopaper_admin_token');
  updateAuthUI();
  showToast('已退出登录');
}

function showLoginMsg(text, type) {
  const el = $('#loginMsg');
  el.textContent = text;
  el.className = `drawer-message ${type}`;
  el.hidden = false;
}

/* ── Drawer ───────────────────────────────────────────────── */
async function openDrawer() {
  drawer.hidden = false;
  overlay.hidden = false;
  requestAnimationFrame(() => {
    overlay.classList.add('show');
    drawer.classList.add('open');
  });
  await loadSettingsIntoForm();
  updateAuthUI();
}

function closeDrawer() {
  overlay.classList.remove('show');
  drawer.classList.remove('open');
  setTimeout(() => {
    drawer.hidden = true;
    overlay.hidden = true;
  }, 300);
}

/* ── API ──────────────────────────────────────────────────── */
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

/* ── Load / Render ────────────────────────────────────────── */
async function loadLatest() {
  showLoading();
  try {
    const data = await api('/digests/latest');
    if (!data.digest) { showEmpty(); return; }
    if (data.digest.status !== 'ok' || !data.articles.length) { showEmpty(data.digest.status); return; }
    renderArticles(data);
  } catch {
    showEmpty('error');
  }
}

function renderArticles(data) {
  const { digest, articles } = data;

  const bar = $('#statusBar');
  bar.hidden = false;
  const tag = $('#statusTag');
  tag.textContent = `入选 ${articles.length} 篇`;
  tag.className = articles.length ? 'status-tag ok' : 'status-tag warn';
  $('#statusMeta').textContent = `从 ${digest.candidate_count} 篇候选中选出 ${articles.length} 篇`;
  $('#statusDate').textContent = new Date(digest.run_at).toLocaleString('zh-CN');

  $('#statusAiNote').innerHTML = `
    <span class="ai-badge">🤖 AI 评分</span>
    <span>由 <strong>Llama 3.1 8B</strong>（Cloudflare Workers AI）对 ${digest.candidate_count} 篇候选论文逐篇评分。
    每篇文章的「为什么值得看」「机制链」「关键证据」「疑点」「下一步实验」均为 AI 基于摘要的独立判断，并非从原文提取。</span>
  `;

  $('#articlesList').innerHTML = articles.map(a => `
    <article class="article-card">
      <div class="article-head">
        <span class="article-rank">${a.rank}</span>
        <h3 class="article-title">
          <a href="${a.article_url}" target="_blank" rel="noopener">${esc(a.title)}</a>
        </h3>
      </div>

      <div class="article-meta">
        <span>${esc(a.authors || '—')}</span>
        <span class="sep">·</span>
        <span><strong>${esc(a.journal || '—')}</strong></span>
        <span class="sep">·</span>
        <span>${a.pub_date ?? ''}</span>
        <span class="sep">·</span>
        <span>证据 <strong>${a.evidence_level}</strong></span>
      </div>

      <div class="scores-row">
        <div class="score-pill">相关 <strong>${a.relevance}</strong></div>
        <div class="score-pill">新颖 <strong>${a.novelty}</strong></div>
        <div class="score-pill">证据 <strong>${a.evidence}</strong></div>
        <div class="score-pill">反直觉 <strong>${a.surprise}</strong></div>
        <div class="score-pill">启发 <strong>${a.experiment_value}</strong></div>
        <div class="score-pill score-pill-total">总分 ${a.total}</div>
      </div>

      <div class="analysis-grid">
        <div class="analysis-item analysis-full">
          <h4>为什么值得看</h4>
          <p>${esc(a.why_interesting)}</p>
        </div>
        <div class="analysis-item">
          <h4>机制链</h4>
          <p>${esc(a.mechanism_chain) || '—'}</p>
        </div>
        <div class="analysis-item">
          <h4>关键证据</h4>
          <p>${esc(a.key_evidence) || '—'}</p>
        </div>
        <div class="analysis-item">
          <h4>主要疑点</h4>
          <p>${esc(a.major_concern) || '—'}</p>
        </div>
        <div class="analysis-item">
          <h4>下一步实验</h4>
          <p>${esc(a.next_experiment) || '—'}</p>
        </div>
      </div>
    </article>
  `).join('');

  $('#articlesView').hidden = false;
  $('#emptyView').hidden = true;
  $('#loadingView').hidden = true;
}

/* ── States ───────────────────────────────────────────────── */
function showLoading() {
  $('#loadingView').hidden = false;
  $('#emptyView').hidden = true;
  $('#articlesView').hidden = true;
  $('#statusBar').hidden = true;
}

function showEmpty(reason) {
  $('#loadingView').hidden = true;
  $('#articlesView').hidden = true;
  $('#statusBar').hidden = true;
  const el = $('#emptyView');
  el.hidden = false;

  const h2 = el.querySelector('h2');
  const p = el.querySelector('p');
  const actions = el.querySelector('.empty-actions');

  if (reason === 'empty') {
    h2.textContent = '暂无入选文章';
    p.textContent = '最近一次同步没有找到符合条件的文章。试试放宽检索条件或增加回看天数。';
    if (actions) actions.style.display = '';
  } else if (reason === 'error') {
    h2.textContent = '加载失败';
    p.textContent = '请检查 D1 数据库是否已初始化，或打开浏览器控制台查看错误。';
    if (actions) actions.style.display = 'none';
  } else {
    h2.textContent = '还没有简报';
    p.textContent = '配置检索关键词后，点击同步即可发现感兴趣的论文。';
    if (actions) actions.style.display = '';
  }
}

function showDemoBanner() {
  $('#articlesView').insertAdjacentHTML('beforebegin', `
    <div class="demo-banner">
      ⚠️ 演示模式 — 这是假数据。去掉 URL 中的 <code>?demo=1</code> 查看真实数据。
    </div>
  `);
}

/* ── Settings / Sync ──────────────────────────────────────── */
async function loadSettingsIntoForm() {
  try {
    const s = await api('/settings');
    $('#focus').value = s.focus || '';
    $('#queryGroups').value = (s.query_groups || []).join('\n');
    $('#excludeTerms').value = s.exclude_terms || '';
    $('#maxArticles').value = s.max_articles || 5;
    $('#lookbackDays').value = s.lookback_days || 7;
    $('#excludeReviews').checked = s.exclude_reviews !== 0;
  } catch { /* 可能未初始化，忽略 */ }
}

async function saveConfig() {
  if (!S.isLoggedIn) { showToast('请先登录', 'error'); return; }
  try {
    const queryGroups = $('#queryGroups').value.split('\n').map(s => s.trim()).filter(Boolean);
    const body = {
      query_groups: queryGroups,
      focus: $('#focus').value.trim(),
      exclude_terms: $('#excludeTerms').value.trim(),
      max_articles: Number($('#maxArticles').value),
      lookback_days: Number($('#lookbackDays').value),
      exclude_reviews: $('#excludeReviews').checked,
    };
    await api('/settings', { method: 'POST', body: JSON.stringify(body) });
    showDrawerMsg('✅ 配置已保存', 'success');
  } catch (e) {
    showDrawerMsg(`❌ ${e.message}`, 'error');
  }
}

async function triggerSync() {
  if (!S.isLoggedIn) { showToast('请先登录', 'error'); return; }
  const btn = $('#syncBtn');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ 同步中...';

  try {
    const result = await api('/sync', { method: 'POST' });
    if (result.status === 'ok') {
      showDrawerMsg(`✅ 同步完成，入选 ${result.selected_count} 篇`, 'success');
      closeDrawer();
      loadLatest();
    } else {
      showDrawerMsg(`⚠️ ${result.status}: 无新文章`, 'error');
    }
  } catch (e) {
    showDrawerMsg(`❌ ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function showDrawerMsg(text, type) {
  const el = $('#drawerMessage');
  el.textContent = text;
  el.className = `drawer-message ${type}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

/* ── Toast ────────────────────────────────────────────────── */
function showToast(text, type = '') {
  const toast = $('#toast');
  toast.textContent = text;
  toast.className = `toast ${type} show`;
  setTimeout(() => { toast.className = 'toast'; }, 2500);
}

/* ── Utils ────────────────────────────────────────────────── */
const overlay = $('#overlay');
const drawer = $('#settingsDrawer');

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
