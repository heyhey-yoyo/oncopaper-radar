/* ============================================================
   OncoPaper Radar - App
   ============================================================ */

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
      evidence_level: 'Strong',
      why_interesting: 'First complete KRASG12D -> NRF2 -> ferroptosis resistance axis in PDAC with druggable metabolic targets. PDX and clinical validation strengthen confidence.',
      mechanism_chain: 'KRASG12D -> PI3K/AKT -> NRF2 -> GSH upregulation -> ferroptosis evasion',
      key_evidence: 'NRF2 knockout + RSL3 significantly inhibited tumor growth in 3 PDX models, synergistic with gemcitabine.',
      major_concern: 'PDX models in immunodeficient mice; immunogenic cell death from ferroptosis was not evaluated.',
      next_experiment: 'Test RSL3+gemcitabine+anti-PD-1 triple therapy in immunocompetent KPC mice.',
    },
    {
      rank: 2, title: 'Single-cell dissection of KRASG12D-mutant pancreatic tumors reveals a myeloid-driven immune exclusion program',
      authors: 'Park J, Rodriguez M, et al.', journal: 'Nature Cancer', pub_date: '2026-07-26',
      article_url: '#', relevance: 8, novelty: 9, evidence: 7, surprise: 8, experiment_value: 8, total: 40,
      evidence_level: 'Moderate',
      why_interesting: 'Novel immune exclusion mechanism: KRASG12D tumors educate specific macrophage subset via CSF1 to exclude T cells. New explanation for immunotherapy resistance.',
      mechanism_chain: 'KRASG12D -> tumor CSF1 -> CXCL1+ TAM -> MDSC recruitment -> CD8+ T cell exclusion',
      key_evidence: 'CSF1R inhibitor reduced CXCL1+ TAMs and restored T cell infiltration in KPC model.',
      major_concern: 'Sample size of 28 may be limiting; scRNA-seq cannot resolve spatial relationships.',
      next_experiment: 'Spatial transcriptomics to validate co-localization of CXCL1+ TAMs with T cell exclusion zones.',
    },
    {
      rank: 3, title: 'Irisin/FNDC5 suppresses PDAC liver metastasis by protecting hepatic stellate cell quiescence',
      authors: 'Thompson R, Lee S, et al.', journal: 'Gut', pub_date: '2026-07-25',
      article_url: '#', relevance: 7, novelty: 9, evidence: 7, surprise: 9, experiment_value: 8, total: 40,
      evidence_level: 'Moderate',
      why_interesting: 'Counterintuitive mechanism: myokine irisin blocks metastatic niche formation by maintaining stellate cell quiescence, independent of immune system.',
      mechanism_chain: 'Exercise -> irisin/FNDC5 -> hepatic stellate cell quiescence -> blocked pre-metastatic niche -> reduced liver metastasis',
      key_evidence: 'Exogenous irisin reduced liver metastases by 70% in mouse models without affecting primary tumor.',
      major_concern: 'Short irisin half-life challenges clinical translation; patient exercise capacity varies widely.',
      next_experiment: 'Develop irisin-Fc fusion protein for extended half-life; validate chronic anti-metastatic efficacy.',
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
const overlay = $('#overlay');
const drawer = $('#settingsDrawer');

/* ── Init ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  if (DEMO) { renderArticles(DEMO_DATA); showDemoBanner(); return; }

  // Topbar buttons
  $('#settingsBtn').addEventListener('click', openDrawer);
  $('#loginBtn').addEventListener('click', openLogin);
  $('#logoutBtn').addEventListener('click', doLogout);

  // Login modal
  $('#loginConfirmBtn').addEventListener('click', doLogin);
  $('#loginCancelBtn').addEventListener('click', closeLogin);
  $('#loginTokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // Overlay closes both drawer and login modal
  overlay.addEventListener('click', () => {
    if (!drawer.hidden) closeDrawer();
    if (!$('#loginModal').hidden) closeLogin();
  });

  // Drawer
  $('#closeDrawerBtn').addEventListener('click', closeDrawer);
  $('#saveConfigBtn').addEventListener('click', saveConfig);
  $('#syncBtn').addEventListener('click', triggerSync);
  $('#emptySettingsBtn').addEventListener('click', openDrawer);
  $('#drawerLoginBtn').addEventListener('click', openLogin);
  $('#generateProfileBtn').addEventListener('click', generateProfile);

  // Initial load
  if (S.token) verifyToken().then(() => loadLatest());
  else { updateAuthUI(); loadLatest(); }
});

/* ── Auth ─────────────────────────────────────────────────── */
function updateAuthUI() {
  if (S.isLoggedIn) {
    $('#loginBtn').hidden = true;
    $('#logoutBtn').hidden = false;
    $('#settingsBtn').classList.add('active');
    $('#saveConfigBtn').disabled = false;
    $('#syncBtn').disabled = false;
    $('#drawerLoginPrompt').hidden = true;
  } else {
    $('#loginBtn').hidden = false;
    $('#logoutBtn').hidden = true;
    $('#settingsBtn').classList.remove('active');
    $('#saveConfigBtn').disabled = true;
    $('#syncBtn').disabled = true;
    $('#drawerLoginPrompt').hidden = false;
  }
}

async function verifyToken() {
  try {
    await api('/settings');
    S.isLoggedIn = true;
  } catch {
    S.isLoggedIn = false;
    S.token = '';
    localStorage.removeItem('oncopaper_admin_token');
  }
  updateAuthUI();
}

function openLogin() {
  $('#loginModal').hidden = false;
  overlay.hidden = false;
  overlay.classList.add('show');
  $('#loginTokenInput').value = '';
  $('#loginMsg').hidden = true;
  setTimeout(() => $('#loginTokenInput').focus(), 100);
}

function closeLogin() {
  $('#loginModal').hidden = true;
  overlay.classList.remove('show');
  setTimeout(() => { overlay.hidden = true; }, 250);
}

async function doLogin() {
  const token = $('#loginTokenInput').value.trim();
  if (!token) { showLoginMsg('Please enter a token', 'error'); return; }

  S.token = token;
  try {
    await api('/settings');
    S.isLoggedIn = true;
    localStorage.setItem('oncopaper_admin_token', token);
    updateAuthUI();
    closeLogin();
    showToast('Logged in', 'success');
    if (!drawer.hidden) loadSettingsIntoForm();
  } catch {
    S.token = '';
    S.isLoggedIn = false;
    showLoginMsg('Invalid token', 'error');
  }
}

function doLogout() {
  S.token = '';
  S.isLoggedIn = false;
  localStorage.removeItem('oncopaper_admin_token');
  updateAuthUI();
  showToast('Logged out');
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
  } catch { showEmpty('error'); }
}

function renderArticles(data) {
  const { digest, articles } = data;

  const bar = $('#statusBar');
  bar.hidden = false;
  $('#statusTag').textContent = articles.length + ' selected';
  $('#statusTag').className = articles.length ? 'status-tag ok' : 'status-tag warn';
  $('#statusMeta').textContent = `From ${digest.candidate_count} candidates`;
  $('#statusDate').textContent = new Date(digest.run_at).toLocaleString('zh-CN');

  $('#statusAiNote').innerHTML = `
    <span class="ai-badge">AI Scored</span>
    <span><strong>Llama 3.1 8B</strong> (Cloudflare Workers AI) scored ${digest.candidate_count} candidates.
    Analysis below is AI-generated from abstracts only; always verify against full text.</span>
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
        <span>${esc(a.authors || '-')}</span>
        <span class="sep">·</span>
        <span><strong>${esc(a.journal || '-')}</strong></span>
        <span class="sep">·</span>
        <span>${a.pub_date ?? ''}</span>
        <span class="sep">·</span>
        <span>Evidence <strong>${a.evidence_level}</strong></span>
      </div>

      <div class="scores-row">
        <div class="score-pill">Relevance <strong>${a.relevance}</strong></div>
        <div class="score-pill">Novelty <strong>${a.novelty}</strong></div>
        <div class="score-pill">Evidence <strong>${a.evidence}</strong></div>
        <div class="score-pill">Surprise <strong>${a.surprise}</strong></div>
        <div class="score-pill">Inspiration <strong>${a.experiment_value}</strong></div>
        <div class="score-pill score-pill-total">Total ${a.total}</div>
      </div>

      <div class="analysis-grid">
        <div class="analysis-item analysis-full">
          <h4>Why Interesting</h4>
          <p>${esc(a.why_interesting)}</p>
        </div>
        <div class="analysis-item">
          <h4>Mechanism</h4>
          <p>${esc(a.mechanism_chain) || '-'}</p>
        </div>
        <div class="analysis-item">
          <h4>Key Evidence</h4>
          <p>${esc(a.key_evidence) || '-'}</p>
        </div>
        <div class="analysis-item">
          <h4>Major Concern</h4>
          <p>${esc(a.major_concern) || '-'}</p>
        </div>
        <div class="analysis-item">
          <h4>Next Experiment</h4>
          <p>${esc(a.next_experiment) || '-'}</p>
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
    h2.textContent = 'No articles selected';
    p.textContent = 'Recent sync found no matching articles. Try broadening search terms or increasing lookback days.';
    if (actions) actions.style.display = '';
  } else if (reason === 'error') {
    h2.textContent = 'Load failed';
    p.textContent = 'Check if D1 database is initialized, or open browser console for details.';
    if (actions) actions.style.display = 'none';
  } else {
    h2.textContent = 'No digest yet';
    p.textContent = 'Configure search keywords and trigger a sync to discover papers.';
    if (actions) actions.style.display = '';
  }
}

function showDemoBanner() {
  $('#articlesView').insertAdjacentHTML('beforebegin', `
    <div class="demo-banner">
      Demo mode - showing fake data. Remove <code>?demo=1</code> from URL for real data.
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
  } catch { /* DB may not be ready */ }
}

async function saveConfig() {
  if (!S.isLoggedIn) { showToast('Please login first', 'error'); return; }
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
    showDrawerMsg('Saved', 'success');
  } catch (e) {
    showDrawerMsg(e.message, 'error');
  }
}

async function triggerSync() {
  if (!S.isLoggedIn) { showToast('Please login first', 'error'); return; }
  const btn = $('#syncBtn');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Syncing...';

  try {
    const result = await api('/sync', { method: 'POST' });
    if (result.status === 'ok') {
      showDrawerMsg(`Sync complete, ${result.selected_count} selected`, 'success');
      closeDrawer();
      loadLatest();
    } else {
      showDrawerMsg(`Sync returned ${result.status}: no new articles`, 'error');
    }
  } catch (e) {
    showDrawerMsg(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

/* ── AI Profile Generation ────────────────────────────────── */
async function generateProfile() {
  if (!S.isLoggedIn) { showToast('Please login first', 'error'); return; }

  const raw = $('#pmidInput').value.trim();
  if (!raw) { showGenerateMsg('Please enter at least one PMID', 'error'); return; }

  const pmids = raw.split(/[,\n\s]+/).map(s => s.trim()).filter(Boolean);
  if (!pmids.length) { showGenerateMsg('No valid PMIDs found', 'error'); return; }

  const btn = $('#generateProfileBtn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const result = await api('/generate-profile', {
      method: 'POST',
      body: JSON.stringify({ pmids }),
    });
    $('#focus').value = result.focus || '';
    $('#queryGroups').value = (result.query_groups || []).join('\n');
    $('#excludeTerms').value = result.exclude_terms || '';
    showGenerateMsg('Generated. Review and save.', 'success');
  } catch (e) {
    showGenerateMsg(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function showGenerateMsg(text, type) {
  const el = $('#generateMsg');
  el.textContent = text;
  el.className = `drawer-message ${type}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 5000);
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
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
