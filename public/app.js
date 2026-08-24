/* ============================================================
   OncoPaper Radar - App
   The existing HTML/CSS and header are intentionally unchanged.
   Long-running work is monitored through short polling requests.
   ============================================================ */

const DEMO = new URLSearchParams(location.search).has('demo');
const DEMO_DATA = {
  digest: {
    run_at: '2026-07-29T05:00:00Z',
    query_text: '(KRAS G12D OR KRASG12D) AND (pancreatic cancer OR PDAC)',
    candidate_count: 14,
    selected_count: 3,
    status: 'ok',
    model: 'Qwen3-30B-A3B',
  },
  articles: [
    {
      rank: 1,
      title: 'KRASG12D drives metabolic reprogramming toward ferroptosis evasion in PDAC',
      authors: 'Chen L, Wang M, Zhang Q, et al.', journal: 'Cancer Cell', pub_date: '2026-07-24',
      article_url: '#', relevance: 9, novelty: 8, evidence: 8, surprise: 7, experiment_value: 9, total: 41,
      evidence_level: '强',
      why_interesting: '该研究提出可实验验证的代谢耐受机制，并提供体内证据。',
      mechanism_chain: 'KRASG12D → NRF2 → 谷胱甘肽合成 → 铁死亡逃逸。',
      key_evidence: '遗传干预与药理干预方向一致。',
      major_concern: '摘要信息不足以判断模型外推性。',
      next_experiment: '在免疫完整模型中完成 rescue 与联合治疗验证。',
    },
    {
      rank: 2,
      title: 'Single-cell dissection of KRASG12D-mutant pancreatic tumors reveals immune exclusion',
      authors: 'Park J, Rodriguez M, et al.', journal: 'Nature Cancer', pub_date: '2026-07-26',
      article_url: '#', relevance: 8, novelty: 9, evidence: 7, surprise: 8, experiment_value: 8, total: 40,
      evidence_level: '中',
      why_interesting: '单细胞结果指向可干预的髓系免疫排斥程序。',
      mechanism_chain: '肿瘤细胞信号 → 髓系细胞重编程 → CD8 T 细胞排斥。',
      key_evidence: '细胞状态变化与功能干预结果相互支持。',
      major_concern: '需要空间证据确认细胞间关系。',
      next_experiment: '使用空间组学与细胞特异性敲除进行验证。',
    },
    {
      rank: 3,
      title: 'Irisin/FNDC5 suppresses PDAC liver metastasis through hepatic stellate cells',
      authors: 'Thompson R, Lee S, et al.', journal: 'Gut', pub_date: '2026-07-25',
      article_url: '#', relevance: 7, novelty: 9, evidence: 7, surprise: 9, experiment_value: 8, total: 40,
      evidence_level: '中',
      why_interesting: '结果提示运动相关因子可能通过转移微环境而非原发灶发挥作用。',
      mechanism_chain: 'Irisin/FNDC5 → 星状细胞静息 → 转移前生态位受抑。',
      key_evidence: '外源干预降低肝转移负荷。',
      major_concern: '临床可达暴露与长期安全性仍不明确。',
      next_experiment: '开展剂量梯度、药代和肝转移模型中的因果验证。',
    },
  ],
};

const S = {
  token: sessionStorage.getItem('oncopaper_admin_token') || '',
  isLoggedIn: false,
  syncRunning: false,
  profileRunning: false,
  generatedProfile: null,
};

const $ = selector => document.querySelector(selector);
const overlay = $('#overlay');
const drawer = $('#settingsDrawer');

/* ── Init ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  if (DEMO) {
    renderArticles(DEMO_DATA);
    showDemoBanner();
    return;
  }

  $('#settingsBtn').addEventListener('click', openDrawer);
  $('#loginBtn').addEventListener('click', openLogin);
  $('#logoutBtn').addEventListener('click', doLogout);
  $('#loginConfirmBtn').addEventListener('click', doLogin);
  $('#loginCancelBtn').addEventListener('click', closeLogin);
  $('#loginTokenInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') doLogin();
  });
  overlay.addEventListener('click', () => {
    if (!drawer.hidden) closeDrawer();
    if (!$('#loginModal').hidden) closeLogin();
  });
  $('#closeDrawerBtn').addEventListener('click', closeDrawer);
  $('#saveConfigBtn').addEventListener('click', saveConfig);
  $('#syncBtn').addEventListener('click', triggerSync);
  $('#emptySettingsBtn').addEventListener('click', openDrawer);
  $('#drawerLoginBtn').addEventListener('click', openLogin);
  $('#generateProfileBtn').addEventListener('click', generateProfile);

  if (S.token) {
    verifyToken().then(async () => {
      await loadLatest();
      if (S.isLoggedIn) resumeActiveSync();
    });
  } else {
    updateAuthUI();
    loadLatest();
  }

  updateQuotaTimer();
  setInterval(updateQuotaTimer, 1_000);
});

/* ── Auth ─────────────────────────────────────────────────── */
function updateAuthUI() {
  const privateControls = drawer.querySelectorAll('input, textarea');
  privateControls.forEach(control => { control.disabled = !S.isLoggedIn; });

  if (S.isLoggedIn) {
    $('#loginBtn').hidden = true;
    $('#logoutBtn').hidden = false;
    $('#settingsBtn').classList.add('active');
    $('#saveConfigBtn').disabled = false;
    $('#syncBtn').disabled = S.syncRunning;
    $('#generateProfileBtn').disabled = S.profileRunning;
    $('#drawerLoginPrompt').hidden = true;
  } else {
    $('#loginBtn').hidden = false;
    $('#logoutBtn').hidden = true;
    $('#settingsBtn').classList.remove('active');
    $('#saveConfigBtn').disabled = true;
    $('#syncBtn').disabled = true;
    $('#generateProfileBtn').disabled = true;
    $('#drawerLoginPrompt').hidden = false;
  }
}

async function verifyToken() {
  try {
    await api('/auth/check');
    S.isLoggedIn = true;
  } catch {
    S.isLoggedIn = false;
    S.token = '';
    sessionStorage.removeItem('oncopaper_admin_token');
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
  setTimeout(() => { if (drawer.hidden) overlay.hidden = true; }, 250);
}

async function doLogin() {
  const token = $('#loginTokenInput').value.trim();
  if (!token) {
    showLoginMsg('Please enter a token', 'error');
    return;
  }

  S.token = token;
  try {
    await api('/auth/check');
    S.isLoggedIn = true;
    sessionStorage.setItem('oncopaper_admin_token', token);
    updateAuthUI();
    closeLogin();
    showToast('Logged in', 'success');
    if (!drawer.hidden) await loadSettingsIntoForm();
    resumeActiveSync();
  } catch (error) {
    S.token = '';
    S.isLoggedIn = false;
    sessionStorage.removeItem('oncopaper_admin_token');
    updateAuthUI();
    showLoginMsg(error.message || 'Invalid token', 'error');
  }
}

function doLogout() {
  S.token = '';
  S.isLoggedIn = false;
  sessionStorage.removeItem('oncopaper_admin_token');
  clearPrivateSettingsForm();
  updateAuthUI();
  showToast('Logged out');
}

function showLoginMsg(text, type) {
  const element = $('#loginMsg');
  element.textContent = text;
  element.className = `drawer-message ${type}`;
  element.hidden = false;
}

/* ── Drawer ───────────────────────────────────────────────── */
async function openDrawer() {
  drawer.hidden = false;
  overlay.hidden = false;
  requestAnimationFrame(() => {
    overlay.classList.add('show');
    drawer.classList.add('open');
  });
  if (S.isLoggedIn) await loadSettingsIntoForm();
  else clearPrivateSettingsForm();
  loadModelInfo();
  updateAuthUI();
}

function closeDrawer() {
  overlay.classList.remove('show');
  drawer.classList.remove('open');
  setTimeout(() => {
    drawer.hidden = true;
    if ($('#loginModal').hidden) overlay.hidden = true;
  }, 300);
}

/* ── API ──────────────────────────────────────────────────── */
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;

  try {
    const response = await fetch(`/api${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request timed out. The background workflow may still be running.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Load / render ────────────────────────────────────────── */
async function loadLatest() {
  showLoading('加载简报...');
  try {
    const data = await api('/digests/latest');
    if (!data.digest) {
      showEmpty(data.latest_attempt?.status, data.latest_attempt);
      return;
    }
    if (data.digest.status !== 'ok' || !data.articles?.length) {
      showEmpty(data.latest_attempt?.status || data.digest.status, data.latest_attempt || data.digest);
      return;
    }
    renderArticles(data);
  } catch {
    showEmpty('error');
  }
}

function renderArticles(data) {
  const { digest, articles, latest_attempt: latestAttempt } = data;
  const latestIsNewerFailure = latestAttempt
    && latestAttempt.id !== digest.id
    && latestAttempt.status !== 'ok';

  $('#statusBar').hidden = false;
  $('#statusTag').textContent = latestIsNewerFailure ? 'Previous successful digest' : `${articles.length} selected`;
  $('#statusTag').className = latestIsNewerFailure ? 'status-tag warn' : 'status-tag ok';
  $('#statusMeta').textContent = latestIsNewerFailure
    ? `Latest sync: ${latestAttempt.status}; showing ${articles.length} earlier selections`
    : `From ${digest.candidate_count} candidates`;
  $('#statusDate').textContent = formatDatabaseTime(digest.run_at);
  const modelLabel = digest.model || 'Qwen3-30B-A3B';
  const usedHeuristicOnly = /heuristic/i.test(modelLabel);
  const latestNotice = latestIsNewerFailure ? `
    <span class="run-warning">Latest ${esc(latestAttempt.status)} run at ${esc(formatDatabaseTime(latestAttempt.run_at))}${latestAttempt.message ? `: ${esc(latestAttempt.message)}` : ''}. The papers below are from the most recent successful digest.</span>
  ` : '';
  const aiDetails = `
    <span class="ai-badge">${usedHeuristicOnly ? 'Rule Fallback' : 'AI Scored'}</span>
    <span>Model: <strong>${esc(modelLabel)}</strong> via Cloudflare Workers AI. Screened ${Number(digest.candidate_count) || 0} candidates.
    ${usedHeuristicOnly ? 'The AI service was unavailable, so bounded rule-based scoring was used.' : 'Analysis is AI-generated from titles and abstracts only;'} Always verify against full text.</span>
  `;
  const statusAiNote = $('#statusAiNote');
  statusAiNote.classList.toggle('has-run-warning', Boolean(latestIsNewerFailure));
  statusAiNote.innerHTML = latestIsNewerFailure
    ? `${latestNotice}<span class="ai-note-details">${aiDetails}</span>`
    : aiDetails;

  $('#articlesList').innerHTML = articles.map(article => `
    <article class="article-card">
      <div class="article-head">
        <span class="article-rank">${Number(article.rank) || '-'}</span>
        <h3 class="article-title">
          <a href="${safeHref(article.article_url)}" target="_blank" rel="noopener noreferrer">${esc(article.title)}</a>
        </h3>
      </div>
      <div class="article-meta">
        <div><span>${esc(article.authors || '-')}</span></div>
        <div><strong>${esc(article.journal || '-')}</strong></div>
        <div><span>${esc(article.pub_date || '')}</span></div>
        <div><span>Evidence <strong>${esc(article.evidence_level || '-')}</strong></span></div>
      </div>
      <div class="scores-row">
        <div class="score-pill">Relevance <strong>${score(article.relevance)}</strong></div>
        <div class="score-pill">Novelty <strong>${score(article.novelty)}</strong></div>
        <div class="score-pill">Evidence <strong>${score(article.evidence)}</strong></div>
        <div class="score-pill">Surprise <strong>${score(article.surprise)}</strong></div>
        <div class="score-pill">Inspiration <strong>${score(article.experiment_value)}</strong></div>
        <div class="score-pill score-pill-total">Total ${Number(article.total) || 0}</div>
      </div>
      <div class="analysis-grid">
        <div class="analysis-item analysis-full">
          <h4>Why Interesting</h4>
          <p>${esc(article.why_interesting) || '-'}</p>
        </div>
        <div class="analysis-item">
          <h4>Mechanism</h4>
          <p>${esc(article.mechanism_chain) || '-'}</p>
        </div>
        <div class="analysis-item">
          <h4>Key Evidence</h4>
          <p>${esc(article.key_evidence) || '-'}</p>
        </div>
        <div class="analysis-item">
          <h4>Major Concern</h4>
          <p>${esc(article.major_concern) || '-'}</p>
        </div>
        <div class="analysis-item">
          <h4>Next Experiment</h4>
          <p>${esc(article.next_experiment) || '-'}</p>
        </div>
      </div>
    </article>
  `).join('');

  $('#articlesView').hidden = false;
  $('#emptyView').hidden = true;
  $('#loadingView').hidden = true;
}

function showLoading(text = '加载中...') {
  $('#loadingText').textContent = text;
  $('#loadingView').hidden = false;
  $('#emptyView').hidden = true;
  $('#articlesView').hidden = true;
  $('#statusBar').hidden = true;
}

function showEmpty(reason, latestAttempt = null) {
  $('#loadingView').hidden = true;
  $('#articlesView').hidden = true;
  $('#statusBar').hidden = true;
  const element = $('#emptyView');
  element.hidden = false;
  const title = element.querySelector('h2');
  const paragraph = element.querySelector('p');
  const actions = element.querySelector('.empty-actions');
  const time = latestAttempt?.run_at ? ` (${formatDatabaseTime(latestAttempt.run_at)})` : '';

  if (reason === 'empty') {
    title.textContent = 'No articles selected';
    paragraph.textContent = `${latestAttempt?.message || 'Recent sync found no new matching articles.'}${time}`;
    if (actions) actions.style.display = '';
  } else if (reason === 'error') {
    title.textContent = latestAttempt ? 'Latest sync failed' : 'Load failed';
    paragraph.textContent = latestAttempt
      ? `${latestAttempt.message || 'Check the Worker logs for details.'}${time}`
      : 'Check the D1 binding and Worker logs for details.';
    if (actions) actions.style.display = 'none';
  } else if (reason === 'skipped') {
    title.textContent = 'Latest sync was skipped';
    paragraph.textContent = `${latestAttempt?.message || 'Automatic sync is disabled.'}${time}`;
    if (actions) actions.style.display = '';
  } else {
    title.textContent = 'No digest yet';
    paragraph.textContent = 'Log in, configure search keywords, and trigger a sync to discover papers.';
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

/* ── Settings ─────────────────────────────────────────────── */
function clearPrivateSettingsForm() {
  $('#pmidInput').value = '';
  $('#focus').value = '';
  $('#queryGroups').value = '';
  $('#excludeTerms').value = '';
  $('#maxArticles').value = 5;
  $('#lookbackDays').value = 7;
  $('#excludeReviews').checked = true;
  S.generatedProfile = null;
}

async function loadSettingsIntoForm() {
  try {
    const settings = await api('/settings');
    $('#focus').value = settings.focus || '';
    $('#queryGroups').value = (settings.query_groups || []).join('\n');
    $('#excludeTerms').value = settings.exclude_terms || '';
    $('#maxArticles').value = settings.max_articles || 5;
    $('#lookbackDays').value = settings.lookback_days || 7;
    $('#excludeReviews').checked = settings.exclude_reviews !== 0;
    S.generatedProfile = settings.generated_profile || null;
  } catch {
    // The initial database may still be deploying.
  }
}

async function saveConfig() {
  if (!S.isLoggedIn) {
    showToast('Please login first', 'error');
    return;
  }

  try {
    const queryGroups = $('#queryGroups').value
      .split('\n')
      .map(value => value.trim())
      .filter(Boolean);
    const body = {
      query_groups: queryGroups,
      focus: $('#focus').value.trim(),
      exclude_terms: $('#excludeTerms').value.trim(),
      max_articles: Number($('#maxArticles').value),
      lookback_days: Number($('#lookbackDays').value),
      exclude_reviews: $('#excludeReviews').checked,
      generated_profile: S.generatedProfile,
    };
    const result = await api('/settings', { method: 'POST', body: JSON.stringify(body) });
    $('#queryGroups').value = (result.query_groups || queryGroups).join('\n');
    showDrawerMsg('Saved. Terms were normalized to safe limits.', 'success');
  } catch (error) {
    showDrawerMsg(error.message, 'error');
  }
}

/* ── Sync workflow ────────────────────────────────────────── */
async function triggerSync() {
  if (!S.isLoggedIn) {
    showToast('Please login first', 'error');
    return;
  }
  if (S.syncRunning) return;

  setSyncRunning(true);
  try {
    const queued = await api('/sync', { method: 'POST' });
    showDrawerMsg(queued.already_running ? 'A sync is already running. Reconnected to it.' : 'Sync queued in Cloudflare Workflows.', 'success', 20_000);
    const run = await waitForRun(queued.run_id, updateSyncProgress);
    const result = run.result || {};

    if (run.status === 'failed') throw new Error(run.error || 'Sync failed');
    if (result.status === 'ok') {
      showDrawerMsg(`Sync complete, ${result.selected_count || 0} selected`, 'success');
      closeDrawer();
      await loadLatest();
    } else {
      showDrawerMsg(result.message || `Sync completed with status: ${result.status || 'empty'}`, 'error', 10_000);
      await loadLatest();
    }
  } catch (error) {
    showDrawerMsg(error.message, 'error', 12_000);
  } finally {
    setSyncRunning(false);
  }
}

async function resumeActiveSync() {
  if (!S.isLoggedIn || S.syncRunning) return;
  try {
    const data = await api('/runs/active?type=sync');
    if (!data.run) return;
    setSyncRunning(true);
    showToast('Reconnected to an active sync', 'success');
    const run = await waitForRun(data.run.id, updateSyncProgress);
    if (run.status === 'completed') await loadLatest();
  } catch {
    // Do not interrupt normal page loading for a failed resume check.
  } finally {
    setSyncRunning(false);
  }
}

function setSyncRunning(running) {
  S.syncRunning = running;
  const button = $('#syncBtn');
  button.disabled = running || !S.isLoggedIn;
  if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
  button.innerHTML = running ? 'Starting workflow...' : button.dataset.originalHtml;
  updateAuthUI();
}

function updateSyncProgress(run) {
  const button = $('#syncBtn');
  button.innerHTML = `${esc(run.stage || 'Working')} ${Number(run.progress) || 0}%`;
  showDrawerMsg(`Background sync: ${run.stage || run.status} (${Number(run.progress) || 0}%)`, 'success', 5_000);
}

/* ── Profile workflow ─────────────────────────────────────── */
async function generateProfile() {
  if (!S.isLoggedIn) {
    showToast('Please login first. Use the login button in the header.', 'error');
    return;
  }
  if (S.profileRunning) return;

  const raw = $('#pmidInput').value.trim();
  const pmids = [...new Set(raw.split(/[,\n\s]+/).map(value => value.trim()).filter(value => /^\d{5,10}$/.test(value)))];
  if (!pmids.length) {
    showGenerateMsg('Please enter valid numeric PMIDs', 'error');
    return;
  }
  if (pmids.length > 12) {
    showGenerateMsg('At most 12 PMIDs are allowed per profile generation.', 'error');
    return;
  }

  setProfileRunning(true);
  try {
    const queued = await api('/generate-profile', {
      method: 'POST',
      body: JSON.stringify({ pmids }),
    });
    showGenerateMsg('Profile generation queued.', 'success', 20_000);
    const run = await waitForRun(queued.run_id, updateProfileProgress);
    if (run.status === 'failed') throw new Error(run.error || 'Profile generation failed');
    const result = run.result || {};
    $('#focus').value = result.focus || '';
    $('#queryGroups').value = (result.query_groups || []).join('\n');
    $('#excludeTerms').value = result.exclude_terms || '';
    S.generatedProfile = result.query_plan || null;
    showGenerateMsg(`Generated from ${result.paper_count || pmids.length} papers. Review and save.`, 'success', 10_000);
  } catch (error) {
    showGenerateMsg(error.message, 'error', 12_000);
  } finally {
    setProfileRunning(false);
  }
}

function setProfileRunning(running) {
  S.profileRunning = running;
  const button = $('#generateProfileBtn');
  if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
  button.disabled = running || !S.isLoggedIn;
  button.textContent = running ? 'Starting workflow...' : button.dataset.originalText;
  updateAuthUI();
}

function updateProfileProgress(run) {
  $('#generateProfileBtn').textContent = `${run.stage || 'Generating'} ${Number(run.progress) || 0}%`;
  showGenerateMsg(`Background task: ${run.stage || run.status}`, 'success', 5_000);
}

async function waitForRun(runId, onUpdate) {
  let transientErrors = 0;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const run = await api(`/runs/${encodeURIComponent(runId)}`);
      transientErrors = 0;
      if (onUpdate) onUpdate(run);
      if (run.status === 'completed' || run.status === 'failed') return run;
    } catch (error) {
      transientErrors += 1;
      if (transientErrors >= 5) throw error;
    }
    await sleep(2_000);
  }
  throw new Error('The workflow is still running. You can close the page and reconnect later.');
}

/* ── Model info ───────────────────────────────────────────── */
async function loadModelInfo() {
  try {
    const info = await fetch('/api/model-info').then(response => response.json());
    $('#modelInfoText').textContent = `Primary: ${info.primary} | Fallback: ${info.fallback} | ${info.execution}`;
  } catch {
    // Non-critical metadata.
  }
}

/* ── Messages ─────────────────────────────────────────────── */
function flashMessage(element, text, type, duration) {
  element.textContent = text;
  element.className = `drawer-message ${type}`;
  element.hidden = false;
  clearTimeout(element._timer);
  element._timer = setTimeout(() => { element.hidden = true; }, duration);
}

function showGenerateMsg(text, type, duration = 5_000) {
  flashMessage($('#generateMsg'), text, type, duration);
}

function showDrawerMsg(text, type, duration = 4_000) {
  flashMessage($('#drawerMessage'), text, type, duration);
}

function showToast(text, type = '') {
  const toast = $('#toast');
  toast.hidden = false;
  toast.textContent = text;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.className = 'toast';
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 2_500);
}

/* ── Quota timer ──────────────────────────────────────────── */
function updateQuotaTimer() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const difference = next - now;
  const hours = Math.floor(difference / 3_600_000);
  const minutes = Math.floor((difference % 3_600_000) / 60_000);
  const seconds = Math.floor((difference % 60_000) / 1_000);
  $('#quotaReset').textContent = `Quota resets in ${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

/* ── Utils ────────────────────────────────────────────────── */
function formatDatabaseTime(value) {
  if (!value) return '';
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
}

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeHref(value) {
  const href = String(value || '#');
  return /^(https?:\/\/|#)/i.test(href) ? esc(href) : '#';
}

function score(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(10, Math.max(1, Math.round(number))) : '-';
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
