'use strict';

/* RepoLens frontend — app shell, ZIP ingestion (Phase 1), history metrics
   (Phases 2-5), and remote URL cloning (Phase 6). */

const API = '/api';
const $ = (sel, el = document) => el.querySelector(sel);

const ICONS = {
  summary: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  galaxy: '<svg class="icon" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="9" r="2.2"/><circle cx="10" cy="18" r="2.2"/><path d="M8.2 6.6l7.6 1.8M7 8l2 8M16.8 10.6l-5.4 6"/></svg>',
  ownership: '<svg class="icon" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c0-3 2.4-4.8 5.5-4.8s5.5 1.8 5.5 4.8"/><circle cx="17" cy="9.5" r="2.2"/><path d="M16.4 14.6c2.6.3 4.1 1.9 4.1 4.4"/></svg>',
  repositories: '<svg class="icon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  settings: '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M2 12h3M19 12h3M4.9 19.1l2.2-2.2M16.9 7.1l2.2-2.2"/></svg>',
  upload: '<svg class="icon icon-lg" viewBox="0 0 24 24"><path d="M12 16V4m0 0 4 4m-4-4-4 4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
};

const VIEWS = [
  { id: 'summary', label: 'Summary & Overview', enabled: true },
  { id: 'galaxy', label: 'Codebase Galaxy', enabled: false },
  { id: 'ownership', label: 'Knowledge & Ownership', enabled: false },
  { id: 'repositories', label: 'Repositories', enabled: true },
  { id: 'settings', label: 'Exclusions & Settings', enabled: false },
];

const AVATAR_COLORS = ['#00A3A6', '#2EA043', '#D29922', '#F0883E', '#58A6FF', '#BC8CFF', '#39C5CF', '#F85149'];

const state = {
  repos: [],
  currentId: null,
  view: 'summary',
  busy: 0,
  summary: null, // { repoId, enriched, commits, authors, files, filesFilter }
  analysis: null, // { repoId, state, meta, error }
  analysisPoll: null,
  clonePoll: null,
  cloneViewPoll: null,
  loadToken: 0,
};

let uploadXhr = null;
let reposClonePoll = null;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

const intFmt = new Intl.NumberFormat('en-US');
const fmtInt = (v) => intFmt.format(Number(v) || 0);

function fmtRel(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  const months = Math.round(days / 30.44);
  if (months < 12) return `${months} mo ago`;
  return `${Math.round(months / 12)} y ago`;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  const out = parts.map((p) => (p[0] ? p[0].toUpperCase() : '')).join('');
  return out || '?';
}

function avatarColor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(API + path, options);
  } catch {
    throw new Error('Could not reach the RepoLens server');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const detail = data && data.detail;
    throw new Error(
      typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `Request failed (${res.status})`
    );
  }
  return data;
}

function setBusy(delta) {
  state.busy = Math.max(0, state.busy + delta);
  const bar = $('#scanbar');
  if (bar) bar.classList.toggle('active', state.busy > 0);
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('hide'), 3400);
  setTimeout(() => el.remove(), 3800);
}

const currentRepo = () => state.repos.find((r) => r.id === state.currentId) || null;

function persistCurrent() {
  if (state.currentId) localStorage.setItem('repolens.current', state.currentId);
  else localStorage.removeItem('repolens.current');
}

/* ------------------------------------------------------------------ */
/* top-level rendering                                                 */
/* ------------------------------------------------------------------ */

function render() {
  renderNav();
  renderTopbar();
  const content = $('#content');
  let repo = currentRepo();
  if (!state.repos.length) {
    content.innerHTML = emptyStateHTML();
    const add = $('#emptyAddBtn');
    if (add) add.addEventListener('click', openAddModal);
    return;
  }
  if (!repo) {
    state.currentId = state.repos[0].id;
    persistCurrent();
    repo = currentRepo();
    renderTopbar();
  }
  if (state.view === 'repositories') {
    renderRepositories();
    return;
  }
  renderSummary(repo);
}

function renderNav() {
  const nav = $('#sidenav');
  nav.innerHTML = VIEWS.map((v) => `
    <button class="nav-item${v.id === state.view ? ' active' : ''}${v.enabled ? '' : ' disabled'}"
            data-view="${v.id}"${v.enabled ? '' : ' aria-disabled="true" title="Arrives in a later phase"'}>
      ${ICONS[v.id] || ''}<span>${esc(v.label)}</span>
    </button>`).join('');
  nav.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = VIEWS.find((v) => v.id === btn.dataset.view);
      if (!view.enabled) {
        toast(`"${view.label}" arrives in a later phase`);
        return;
      }
      state.view = view.id;
      render();
    });
  });
}

function renderTopbar() {
  const repo = currentRepo();
  const options = state.repos.length
    ? state.repos.map((r) => (
      `<option value="${esc(r.id)}"${r.id === state.currentId ? ' selected' : ''}>` +
      `${esc(r.name)}${r.status === 'error' ? ' — error' : r.status === 'cloning' ? ' — cloning' : ''}</option>`
    )).join('')
    : '<option>No repositories</option>';
  [$('#repoSelectTop'), $('#repoSelectFilter')].forEach((sel) => {
    sel.innerHTML = options;
    sel.disabled = state.repos.length === 0;
  });

  const chip = $('#branchChip');
  const branch = repo && repo.stats ? repo.stats.branch : '';
  chip.hidden = !branch;
  if (branch) chip.textContent = branch;

  $('#refreshBtn').disabled = !repo;

  const scope = $('#filterScope');
  if (scope) {
    scope.textContent = repo && repo.stats
      ? `${fmtInt(repo.stats.commit_count)} commits · HEAD ${repo.stats.head || '—'}`
      : '—';
  }
}

/* ------------------------------------------------------------------ */
/* empty state                                                         */
/* ------------------------------------------------------------------ */

function emptyStateHTML() {
  return `
  <div class="empty-state">
    <div class="dropzone" id="emptyDropzone">
      <div class="dz-icon">${ICONS.upload}</div>
      <h2>No Git history found</h2>
      <p>Drag and drop a ZIP containing a <code>.git</code> file or directory here — or add one from a file.</p>
      <button class="btn primary" id="emptyAddBtn">${ICONS.plus} Add repository</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* summary view                                                        */
/* ------------------------------------------------------------------ */

function renderSummary(repo) {
  const content = $('#content');
  if (repo.status === 'cloning') {
    content.innerHTML = cloneProgressHTML(repo);
    scheduleCloneViewPoll(repo);
    return;
  }
  if (repo.status === 'error') {
    content.innerHTML = repoErrorHTML(repo);
    const btn = $('#retryScanBtn');
    if (btn) btn.addEventListener('click', refreshCurrent);
    return;
  }
  content.innerHTML = summaryHTML(repo);
  wireSummary();
  paintAnalysisBar(repo);
  if (state.summary && state.summary.repoId === repo.id && state.analysis && state.analysis.repoId === repo.id) {
    paintSummary(repo);
  } else {
    loadRepoData(repo);
  }
}

function summaryHTML(repo) {
  const s = repo.stats || {};
  const lc = s.last_commit;
  const lastSub = lc ? `${esc(lc.author_name)} · ${fmtRel(lc.date)}` : 'no commits yet';
  return `
  <div class="ribbon">
    <div class="card">
      <div class="kpi-label">Repository</div>
      <div class="kpi-value" title="${esc(repo.name)}">${esc(repo.name)}</div>
      <div class="kpi-sub" title="${esc(repo.source)}">${esc(repo.source)}</div>
    </div>
    <div class="card">
      <div class="kpi-label">Commits</div>
      <div class="kpi-value mono">${fmtInt(s.commit_count)}</div>
      <div class="kpi-sub">${fmtInt(s.merge_count)} merge commits</div>
    </div>
    <div class="card">
      <div class="kpi-label">Authors</div>
      <div class="kpi-value mono">${fmtInt(s.author_count)}</div>
      <div class="kpi-sub">distinct commit authors</div>
    </div>
    <div class="card">
      <div class="kpi-label">Tracked Files</div>
      <div class="kpi-value mono">${fmtInt(s.file_count)}</div>
      <div class="kpi-sub">in the current revision</div>
    </div>
    <div class="card">
      <div class="kpi-label">Last Commit</div>
      <div class="kpi-value mono">${lc ? esc(lc.short) : '—'}</div>
      <div class="kpi-sub" title="${lc ? esc(lc.subject) : ''}">${lastSub}</div>
    </div>
    <div class="card">
      <div class="kpi-label">Scan Time</div>
      <div class="kpi-value mono">${repo.analysis_ms != null ? `${fmtInt(repo.analysis_ms)} ms` : '—'}</div>
      <div class="kpi-sub">basic facts scan</div>
    </div>
  </div>
  <div class="analysis-bar" id="analysisBar"></div>
  <div class="split">
    <section class="panel">
      <div class="panel-header">
        <span class="panel-title">Recent Commits</span>
        <span class="panel-meta" id="commitsMeta"></span>
      </div>
      <div class="panel-body">
        <table class="table">
          <thead id="commitsHead"></thead>
          <tbody id="commitsBody">
            <tr><td colspan="6">
              <div class="skeleton sk-line"></div>
              <div class="skeleton sk-line w60"></div>
              <div class="skeleton sk-line w40"></div>
            </td></tr>
          </tbody>
        </table>
        <div class="load-more-wrap" id="loadMoreWrap" hidden>
          <button class="btn ghost" id="loadMoreBtn">Load more</button>
        </div>
      </div>
    </section>
    <div class="stack">
      <section class="panel">
        <div class="panel-header">
          <span class="panel-title">Authors</span>
          <span class="panel-meta" id="authorsMeta"></span>
        </div>
        <div class="panel-body" id="authorsBody" style="max-height:340px">
          <div class="skeleton sk-line"></div>
          <div class="skeleton sk-line w60"></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <span class="panel-title" id="filesTitle">Tracked Files</span>
          <input id="filesSearch" class="search" type="text" placeholder="Filter paths…" autocomplete="off">
          <span class="panel-meta" id="filesMeta"></span>
        </div>
        <div class="panel-body" id="filesBody" style="max-height:300px"></div>
      </section>
      <section class="panel" id="dirsPanel" hidden>
        <div class="panel-header">
          <span class="panel-title">Directories</span>
          <span class="panel-meta" id="dirsMeta"></span>
        </div>
        <div class="panel-body" id="dirsBody" style="max-height:260px"></div>
      </section>
    </div>
  </div>`;
}

function repoErrorHTML(repo) {
  return `
  <div class="view-header">
    <div>
      <h2 class="section-title">${esc(repo.name)}</h2>
      <div class="section-sub">${esc(repo.source)}</div>
    </div>
  </div>
  <div class="repo-error" style="padding:16px; max-width:640px">
    <strong>This repository could not be scanned.</strong>
    <div class="muted" style="margin-top:6px">${esc(repo.error || 'Unknown git error.')}</div>
    <div style="margin-top:12px">
      <button class="btn" id="retryScanBtn">Retry scan</button>
    </div>
  </div>`;
}

function cloneProgressHTML(repo) {
  const clone = repo.clone || {};
  const pct = Math.max(0, Math.min(100, clone.progress || 0));
  return `
  <div class="view-header">
    <div>
      <h2 class="section-title">${esc(repo.name)}</h2>
      <div class="section-sub" title="${esc(repo.url || repo.source)}">${esc(repo.source)}</div>
    </div>
  </div>
  <div class="clone-card">
    <strong>Cloning in progress…</strong>
    <div class="muted" style="margin-top:6px" id="cloneViewStatus">${pct}% — ${esc(clone.phase || 'connecting')}</div>
    <div class="progress-track"><div class="progress-fill" id="cloneViewFill" style="width:${pct}%"></div></div>
  </div>`;
}

function scheduleCloneViewPoll(repo, tries = 0) {
  stopCloneViewPoll();
  if (tries > 3000) return; // ~100 min at 2 s — plenty for the largest targets
  state.cloneViewPoll = setTimeout(async () => {
    state.cloneViewPoll = null;
    if (state.currentId !== repo.id || state.view !== 'summary') return;
    try {
      const rec = await api(`/repositories/${repo.id}`);
      if (state.currentId !== repo.id || state.view !== 'summary') return;
      const idx = state.repos.findIndex((r) => r.id === repo.id);
      if (idx >= 0) state.repos[idx] = rec;
      if (rec.status === 'cloning') {
        const clone = rec.clone || {};
        const pct = Math.max(0, Math.min(100, clone.progress || 0));
        const status = $('#cloneViewStatus');
        const fill = $('#cloneViewFill');
        if (status) status.textContent = `${pct}% — ${clone.phase || 'connecting'}`;
        if (fill) fill.style.width = `${pct}%`;
        scheduleCloneViewPoll(rec, tries + 1);
      } else {
        renderTopbar();
        renderSummary(rec);
        if (rec.status === 'ready') toast(`Cloned "${rec.name}"`, 'success');
      }
    } catch {
      scheduleCloneViewPoll(repo, tries + 1);
    }
  }, 2000);
}

function stopCloneViewPoll() {
  if (state.cloneViewPoll) {
    clearTimeout(state.cloneViewPoll);
    state.cloneViewPoll = null;
  }
}

function wireSummary() {
  const body = $('#commitsBody');
  if (body && !body.dataset.bound) {
    body.dataset.bound = '1';
    body.addEventListener('click', (e) => {
      const tr = e.target.closest('tr.expandable');
      if (!tr) return;
      const detail = body.querySelector(`tr.commit-detail[data-detail="${CSS.escape(tr.dataset.hash)}"]`);
      if (detail) detail.style.display = detail.style.display === 'none' ? '' : 'none';
    });
  }
  const more = $('#loadMoreBtn');
  if (more) more.addEventListener('click', loadMoreCommits);
  const search = $('#filesSearch');
  if (search) {
    search.addEventListener('input', () => {
      if (state.summary) {
        state.summary.filesFilter = search.value;
        paintFiles();
      }
    });
  }
}

async function loadRepoData(repo) {
  setBusy(1);
  state.loadToken += 1;
  const token = state.loadToken;
  try {
    const analysisRes = await api(`/repositories/${repo.id}/analysis`);
    if (token !== state.loadToken || state.currentId !== repo.id) return;
    state.analysis = { repoId: repo.id, state: 'none', meta: null, error: null, ...analysisRes };
    paintAnalysisBar(repo);
    if (analysisRes.state === 'running') scheduleAnalysisPoll(repo);
    await loadSummaryData(repo, token);
  } catch (err) {
    if (token !== state.loadToken) return;
    $('#content').innerHTML =
      `<div class="repo-error" style="padding:16px; max-width:640px">Could not load repository data: ${esc(err.message)}</div>`;
  } finally {
    setBusy(-1);
  }
}

async function loadSummaryData(repo, token) {
  const enriched = !!(state.analysis && state.analysis.repoId === repo.id && state.analysis.state === 'ready');
  const endpoint = enriched ? 'analysis/commits' : 'commits';
  const authorsEndpoint = enriched ? 'analysis/authors' : 'authors';
  const filesEndpoint = enriched ? 'analysis/files?offset=0&limit=500' : 'files';
  const requests = [
    api(`/repositories/${repo.id}/${endpoint}?offset=0&limit=50`),
    api(`/repositories/${repo.id}/${authorsEndpoint}`),
    api(`/repositories/${repo.id}/${filesEndpoint}`),
  ];
  if (enriched) requests.push(api(`/repositories/${repo.id}/analysis/dirs?offset=0&limit=500`));
  const [commits, authors, files, dirs] = await Promise.all(requests);
  if (state.currentId !== repo.id) return;
  if (token !== undefined && token !== state.loadToken) return;
  state.summary = { repoId: repo.id, enriched, commits, authors, files, dirs, filesFilter: '' };
  if (state.view === 'summary') paintSummary(repo);
  paintAnalysisBar(repo);
}

function paintAnalysisBar(repo) {
  const bar = $('#analysisBar');
  if (!bar) return;
  const a = state.analysis && state.analysis.repoId === repo.id ? state.analysis : null;
  const noHistory = !repo.stats || !repo.stats.commit_count;
  if (!a) {
    bar.innerHTML = '<span class="faint">Checking analysis…</span>';
    return;
  }
  if (a.state === 'none') {
    if (noHistory) {
      bar.innerHTML = '<span class="faint">No commits to index in this repository.</span>';
      return;
    }
    bar.innerHTML = `
      ${ICONS.summary}
      <div class="analysis-text">
        <strong>History not indexed yet.</strong>
        <span class="muted">Build per-commit file metrics — added/removed lines for every file in every non-merge commit (binary files are skipped).</span>
      </div>
      <button class="btn primary" id="runAnalysisBtn">Run analysis</button>`;
    $('#runAnalysisBtn').addEventListener('click', () => runAnalysis(repo));
    return;
  }
  if (a.state === 'running') {
    bar.innerHTML = `
      <div class="mini-progress"><div class="progress-fill indeterminate"></div></div>
      <span class="mono muted">Indexing history…</span>`;
    return;
  }
  if (a.state === 'ready') {
    const m = a.meta || {};
    bar.innerHTML = `
      <span class="tag ok" title="Metric scopes exclude merge commits; binary files are skipped.">indexed</span>
      <div class="analysis-text mono muted">
        <div>${fmtInt(m.commit_count)} non-merge commits · ${fmtInt(m.files_touched)} files${m.binary_skipped ? ` · ${fmtInt(m.binary_skipped)} binary skipped` : ''} · ${fmtInt(m.duration_ms)} ms</div>
        <div class="analysis-deltas"><span class="plus">+${fmtInt(m.total_added)}</span> <span class="minus">−${fmtInt(m.total_removed)}</span></div>
      </div>
      <button class="btn ghost" id="runAnalysisBtn">Rebuild</button>`;
    $('#runAnalysisBtn').addEventListener('click', () => runAnalysis(repo));
    return;
  }
  bar.innerHTML = `
    <span class="tag err">index error</span>
    <div class="analysis-text">${esc(a.error || 'Analysis failed.')}</div>
    <button class="btn" id="runAnalysisBtn">Retry</button>`;
  $('#runAnalysisBtn').addEventListener('click', () => runAnalysis(repo));
}

async function runAnalysis(repo) {
  if (state.analysis && state.analysis.repoId === repo.id && state.analysis.state === 'running') return;
  stopAnalysisPoll();
  state.analysis = { repoId: repo.id, state: 'running', meta: null, error: null };
  paintAnalysisBar(repo);
  setBusy(1);
  try {
    const res = await api(`/repositories/${repo.id}/analyze`, { method: 'POST' });
    if (state.currentId !== repo.id) return;
    state.analysis = { repoId: repo.id, ...res };
    toast(res.state === 'ready' ? 'History indexed' : 'Analysis failed', res.state === 'ready' ? 'success' : 'error');
    state.summary = null;
    await loadSummaryData(repo);
  } catch (err) {
    if (state.currentId === repo.id) {
      state.analysis = { repoId: repo.id, state: 'error', meta: null, error: err.message };
    }
    toast(err.message, 'error');
  } finally {
    setBusy(-1);
    if (state.currentId === repo.id && state.view === 'summary') paintAnalysisBar(repo);
  }
}

function scheduleAnalysisPoll(repo, tries = 0) {
  stopAnalysisPoll();
  if (tries > 150) return;
  state.analysisPoll = setTimeout(async () => {
    state.analysisPoll = null;
    if (state.currentId !== repo.id || state.view !== 'summary') return;
    try {
      const res = await api(`/repositories/${repo.id}/analysis`);
      if (state.currentId !== repo.id) return;
      state.analysis = { repoId: repo.id, state: 'none', meta: null, error: null, ...res };
      paintAnalysisBar(repo);
      if (res.state === 'running') {
        scheduleAnalysisPoll(repo, tries + 1);
      } else if (res.state === 'ready') {
        state.summary = null;
        await loadSummaryData(repo);
      }
    } catch {
      scheduleAnalysisPoll(repo, tries + 1);
    }
  }, 2000);
}

function stopAnalysisPoll() {
  if (state.analysisPoll) {
    clearTimeout(state.analysisPoll);
    state.analysisPoll = null;
  }
}

function paintSummary(repo) {
  const sum = state.summary;
  if (!sum || sum.repoId !== repo.id) return;
  paintCommits();
  paintAuthors();
  paintFiles();
  paintDirectories();
}

function paintCommits() {
  const sum = state.summary;
  if (!sum) return;
  const head = $('#commitsHead');
  const body = $('#commitsBody');
  if (!head || !body) return;
  const enriched = !!sum.enriched;
  head.innerHTML = enriched
    ? '<tr><th style="width:80px">Commit</th><th style="width:150px">Author</th><th style="width:96px">Date</th><th>Message</th><th class="num" style="width:84px">+ / −</th><th class="num" style="width:52px">Files</th></tr>'
    : '<tr><th style="width:92px">Commit</th><th style="width:190px">Author</th><th style="width:110px">Date</th><th>Message</th></tr>';
  const { items, total } = sum.commits;
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="${enriched ? 6 : 4}" class="faint" style="padding:18px 16px">No commits found — this repository has an empty history.</td></tr>`;
  } else if (enriched) {
    body.innerHTML = items.map((c) => `
      <tr class="expandable" data-hash="${esc(c.hash)}">
        <td><span class="hash" title="${esc(c.hash)}">${esc(c.short)}</span></td>
        <td>
          <div>${esc(c.author_name)}</div>
          <div class="cell-sub">${esc(c.author_email)}</div>
        </td>
        <td class="muted nowrap" title="${esc(c.date)}">${fmtRel(c.date)}</td>
        <td class="ellip" title="${esc(c.subject)}">${esc(c.subject)}</td>
        <td class="num nowrap"><span class="plus">+${fmtInt(c.added)}</span> <span class="minus">−${fmtInt(c.removed)}</span></td>
        <td class="num mono">${fmtInt(c.file_count)}</td>
      </tr>
      <tr class="commit-detail" data-detail="${esc(c.hash)}" style="display:none">
        <td colspan="6">${commitDetailHTML(c)}</td>
      </tr>`).join('');
  } else {
    body.innerHTML = items.map((c) => `
      <tr>
        <td><span class="hash" title="${esc(c.hash)}">${esc(c.short)}</span></td>
        <td>
          <div>${esc(c.author_name)}</div>
          <div class="cell-sub">${esc(c.author_email)}</div>
        </td>
        <td class="muted nowrap" title="${esc(c.date)}">${fmtRel(c.date)}</td>
        <td class="ellip" title="${esc(c.subject)}">${esc(c.subject)}${c.is_merge ? ' <span class="tag merge">merge</span>' : ''}</td>
      </tr>`).join('');
  }
  const meta = $('#commitsMeta');
  if (meta) {
    meta.textContent = enriched
      ? `${fmtInt(items.length)} of ${fmtInt(total)} non-merge`
      : `${fmtInt(items.length)} of ${fmtInt(total)}`;
  }
  const wrap = $('#loadMoreWrap');
  if (wrap) wrap.hidden = items.length >= total;
}

function commitDetailHTML(c) {
  const files = c.files || [];
  if (!files.length) {
    return '<div class="faint">No file changes (empty commit).</div>';
  }
  const shown = files.slice(0, 60);
  return `
    <div class="detail-title">Files changed · δ = added − removed · λ = added + removed</div>
    <div class="detail-wrap">
      ${shown.map((f) => `
      <div class="cd-file">
        <span class="cd-path" title="${esc(f.path)}">${esc(f.path)}</span>
        <span class="plus">+${fmtInt(f.added)}</span>
        <span class="minus">−${fmtInt(f.removed)}</span>
        <span class="muted">δ ${f.growth >= 0 ? '+' : ''}${fmtInt(f.growth)}</span>
        <span class="muted">λ ${fmtInt(f.churn)}</span>
      </div>`).join('')}
      ${files.length > shown.length ? `<div class="faint" style="padding:4px 0">… ${fmtInt(files.length - shown.length)} more files</div>` : ''}
    </div>`;
}

function paintAuthors() {
  const sum = state.summary;
  if (!sum) return;
  const body = $('#authorsBody');
  if (!body) return;
  const items = sum.authors.items || [];
  if (!items.length) {
    body.innerHTML = '<div class="faint" style="padding:16px">No authors found.</div>';
  } else if (sum.enriched) {
    body.innerHTML = items.map((a) => {
      const share = Math.round(a.omega * 100);
      return `
      <div class="author-row" title="${esc(a.name)} — λ ${fmtInt(a.churn)} churn · +${fmtInt(a.added)} −${fmtInt(a.removed)} lines · ${fmtInt(a.commits)} commits · ${fmtInt(a.files)} files">
        <div class="avatar" style="background:${avatarColor(a.email || a.name)}">${esc(initials(a.name))}</div>
        <div class="author-meta">
          <div class="author-name" title="${esc(a.name)}">${esc(a.name)}</div>
          <div class="author-email" title="${esc(a.email)}">${esc(a.email || 'no email')}</div>
          <div class="cell-sub">${fmtInt(a.commits)} commits · ${fmtInt(a.files)} files</div>
          <div class="share-bar"><div style="width:${share}%"></div></div>
        </div>
        <div class="author-count">${fmtInt(a.churn)}<div class="cell-sub">ω ${share}%</div></div>
      </div>`;
    }).join('');
  } else {
    const total = items.reduce((acc, a) => acc + a.commits, 0) || 1;
    body.innerHTML = items.map((a) => {
      const share = Math.round((a.commits / total) * 100);
      return `
      <div class="author-row">
        <div class="avatar" style="background:${avatarColor(a.email || a.name)}">${esc(initials(a.name))}</div>
        <div class="author-meta">
          <div class="author-name" title="${esc(a.name)}">${esc(a.name)}</div>
          <div class="author-email" title="${esc(a.email)}">${esc(a.email || 'no email')}</div>
          <div class="share-bar"><div style="width:${share}%"></div></div>
        </div>
        <div class="author-count">${fmtInt(a.commits)}<div class="cell-sub">${share}%</div></div>
      </div>`;
    }).join('');
  }
  const meta = $('#authorsMeta');
  if (meta) {
    meta.textContent = `${fmtInt(items.length)} ${items.length === 1 ? 'identity' : 'identities'}`;
    meta.title = sum.enriched
      ? 'Ownership ω — author churn ÷ total repository churn over non-merge commits'
      : 'All commits on the current branch, grouped by git shortlog';
  }
}

function paintFiles() {
  const sum = state.summary;
  if (!sum) return;
  const body = $('#filesBody');
  if (!body) return;
  const title = $('#filesTitle');
  if (title) title.textContent = sum.enriched ? 'File Metrics' : 'Tracked Files';
  const filter = (sum.filesFilter || '').trim().toLowerCase();
  const all = sum.files.items || [];
  const meta = $('#filesMeta');
  if (sum.enriched) {
    const matched = filter ? all.filter((f) => f.path.toLowerCase().includes(filter)) : all;
    body.innerHTML = fileMetricsHTML(matched);
    if (meta) {
      meta.textContent = `${fmtInt(matched.length)} / ${fmtInt(sum.files.total)}${sum.files.total > all.length ? '+' : ''}`;
      meta.title = 'Per-file metrics over non-merge commits · binary files are not measured';
    }
    return;
  }
  const matched = filter ? all.filter((p) => p.toLowerCase().includes(filter)) : all;
  const shown = matched.slice(0, 300);
  body.innerHTML = shown.length
    ? shown.map((p) => `<div class="file-row" title="${esc(p)}">${esc(p)}</div>`).join('')
    : '<div class="faint" style="padding:16px">No matching files.</div>';
  if (matched.length > shown.length) {
    body.innerHTML +=
      `<div class="faint" style="padding:8px 16px; font-size:12px">… ${fmtInt(matched.length - shown.length)} more — refine your filter</div>`;
  }
  if (meta) {
    meta.textContent = `${fmtInt(matched.length)} / ${fmtInt(sum.files.total)}${sum.files.truncated ? '+' : ''}`;
    meta.title = 'Tracked files in the current revision';
  }
}

function fileMetricsHTML(rows) {
  if (!rows.length) return '<div class="faint" style="padding:16px">No measured file changes.</div>';
  return `
  <table class="table metrics-table">
    <thead>
      <tr>
        <th>File</th>
        <th class="num" style="width:44px" title="Churn λ — added + removed lines">λ</th>
        <th class="num" style="width:36px" title="Modifications n — commits that changed the file">n</th>
        <th class="num" style="width:46px" title="Modification frequency η — n ÷ |H|">η</th>
        <th class="num" style="width:46px" title="Churn rate ρ — λ ÷ |H|">ρ</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((f) => `
      <tr title="${esc(f.path)} — +${fmtInt(f.added)} −${fmtInt(f.removed)} lines · δ ${f.growth >= 0 ? '+' : ''}${fmtInt(f.growth)}">
        <td>${esc(f.path)}</td>
        <td class="num mono">${fmtInt(f.churn)}</td>
        <td class="num mono">${fmtInt(f.n)}</td>
        <td class="num mono">${f.eta.toFixed(2)}</td>
        <td class="num mono">${f.rho.toFixed(2)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function paintDirectories() {
  const sum = state.summary;
  if (!sum) return;
  const panel = $('#dirsPanel');
  const body = $('#dirsBody');
  if (!panel || !body) return;
  if (!sum.dirs) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const items = sum.dirs.items || [];
  body.innerHTML = dirsTableHTML(items);
  const meta = $('#dirsMeta');
  if (meta) {
    meta.textContent = `${fmtInt(items.length)} / ${fmtInt(sum.dirs.total)}`;
    meta.title = 'Directory rollups over immediate children, bottom-up · "/" is the repository root (repository metrics)';
  }
}

function dirsTableHTML(rows) {
  if (!rows.length) return '<div class="faint" style="padding:16px">No directory changes.</div>';
  return `
  <table class="table metrics-table">
    <thead>
      <tr>
        <th>Directory</th>
        <th class="num" style="width:44px" title="Churn λ — added + removed lines">λ</th>
        <th class="num" style="width:36px" title="Modifications n — commits in which anything under this directory changed">n</th>
        <th class="num" style="width:46px" title="Modification frequency η — n ÷ |H|">η</th>
        <th class="num" style="width:46px" title="Churn rate ρ — λ ÷ |H|">ρ</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((d) => {
        const root = d.path === '/';
        const depth = root ? 0 : d.path.split('/').length;
        const label = root ? '/' : `${d.path}/`;
        return `
      <tr class="${root ? 'dir-root' : ''}" title="${esc(d.path)} — +${fmtInt(d.added)} −${fmtInt(d.removed)} lines · δ ${d.growth >= 0 ? '+' : ''}${fmtInt(d.growth)}${root ? ' · repository metrics' : ''}">
        <td style="padding-left:${16 + depth * 14}px">${esc(label)}</td>
        <td class="num mono">${fmtInt(d.churn)}</td>
        <td class="num mono">${fmtInt(d.n)}</td>
        <td class="num mono">${d.eta.toFixed(2)}</td>
        <td class="num mono">${d.rho.toFixed(2)}</td>
      </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

async function loadMoreCommits() {
  const repo = currentRepo();
  const sum = state.summary;
  if (!repo || !sum || sum.repoId !== repo.id) return;
  const btn = $('#loadMoreBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  setBusy(1);
  try {
    const endpoint = sum.enriched ? 'analysis/commits' : 'commits';
    const page = await api(`/repositories/${repo.id}/${endpoint}?offset=${sum.commits.items.length}&limit=50`);
    sum.commits.items = sum.commits.items.concat(page.items);
    sum.commits.total = page.total;
    paintCommits();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(-1);
    const btn2 = $('#loadMoreBtn');
    if (btn2) { btn2.disabled = false; btn2.textContent = 'Load more'; }
  }
}

/* ------------------------------------------------------------------ */
/* repositories view                                                   */
/* ------------------------------------------------------------------ */

function renderRepositories() {
  const content = $('#content');
  content.innerHTML = `
  <div class="view-header">
    <div>
      <h2 class="section-title">Repositories</h2>
      <div class="section-sub">${fmtInt(state.repos.length)} ingested · stored locally under <span class="mono">data/repos/</span></div>
    </div>
    <div class="spacer"></div>
    <button class="btn primary" id="viewAddRepoBtn">${ICONS.plus} Add repository</button>
  </div>
  <div class="repo-grid" id="repoGrid">
    ${state.repos.map(repoCardHTML).join('')}
  </div>`;
  $('#viewAddRepoBtn').addEventListener('click', openAddModal);
  $('#repoGrid').addEventListener('click', onRepoGridClick);
  scheduleReposClonePoll();
}

function scheduleReposClonePoll() {
  if (reposClonePoll) {
    clearTimeout(reposClonePoll);
    reposClonePoll = null;
  }
  if (!state.repos.some((r) => r.status === 'cloning')) return;
  reposClonePoll = setTimeout(async () => {
    reposClonePoll = null;
    if (state.view !== 'repositories') return;
    await loadRepos(true);
    if (state.view !== 'repositories') return;
    renderRepositories();
  }, 2500);
}

function analysisNote(repo) {
  const aState = repo.analysis && repo.analysis.state;
  if (aState === 'ready') return '<span class="faint"> · indexed</span>';
  if (aState === 'running') return '<span class="faint"> · indexing…</span>';
  if (aState === 'error') return '<span class="faint"> · index failed</span>';
  return '<span class="faint"> · not indexed</span>';
}

function repoCardHTML(repo) {
  const s = repo.stats || {};
  const cloning = repo.status === 'cloning';
  const clonePct = cloning ? Math.max(0, Math.min(100, (repo.clone && repo.clone.progress) || 0)) : 0;
  const statusTag = repo.status === 'ready'
    ? '<span class="tag ok">ready</span>'
    : repo.status === 'error'
      ? '<span class="tag err">error</span>'
      : cloning
        ? `<span class="tag" title="${esc((repo.clone && repo.clone.phase) || 'cloning')}">cloning ${clonePct}%</span>`
        : `<span class="tag">${esc(repo.status)}</span>`;
  return `
  <article class="repo-card" data-id="${esc(repo.id)}">
    <div class="repo-card-head">
      <h3 title="${esc(repo.name)}">${esc(repo.name)}</h3>
      ${statusTag}
    </div>
    <div class="repo-source">Added ${fmtRel(repo.added_at)} · ${esc(repo.source)}${analysisNote(repo)}</div>
    ${s.commit_count != null ? `
    <div class="repo-stats">
      <span><strong>${fmtInt(s.commit_count)}</strong> commits</span>
      <span><strong>${fmtInt(s.author_count)}</strong> authors</span>
      <span><strong>${fmtInt(s.file_count)}</strong> files</span>
      ${s.branch ? `<span class="mono">${esc(s.branch)}</span>` : ''}
    </div>` : ''}
    ${repo.status === 'error' && repo.error ? `<div class="repo-error">${esc(repo.error)}</div>` : ''}
    <div class="repo-path" title="Click to copy path">${esc(repo.path)}</div>
    <div class="repo-actions">
      <button class="btn primary" data-action="open" ${repo.status !== 'ready' ? 'disabled' : ''}>Open</button>
      <button class="btn ghost" data-action="refresh" ${cloning ? 'disabled' : ''}>Refresh Scan</button>
      <button class="btn danger" data-action="remove">Remove</button>
    </div>
  </article>`;
}

async function onRepoGridClick(e) {
  const pathEl = e.target.closest('.repo-path');
  if (pathEl) {
    const repo = state.repos.find((r) => r.id === pathEl.closest('.repo-card').dataset.id);
    if (repo) {
      try {
        await navigator.clipboard.writeText(repo.path);
        toast('Path copied', 'success');
      } catch {
        toast('Could not copy path', 'error');
      }
    }
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const repo = state.repos.find((r) => r.id === btn.closest('.repo-card').dataset.id);
  if (!repo) return;
  const action = btn.dataset.action;

  if (action === 'open') {
    state.view = 'summary';
    selectRepo(repo.id);
  } else if (action === 'refresh') {
    setBusy(1);
    try {
      await api(`/repositories/${repo.id}/refresh`, { method: 'POST' });
      if (state.currentId === repo.id) state.summary = null;
      await loadRepos();
      toast('Rescan complete', 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(-1);
    }
  } else if (action === 'remove') {
    if (!window.confirm(`Remove "${repo.name}"? The extracted copy will be deleted from RepoLens.`)) return;
    setBusy(1);
    try {
      await api(`/repositories/${repo.id}`, { method: 'DELETE' });
      if (state.currentId === repo.id) {
        stopAnalysisPoll();
        state.currentId = null;
        state.summary = null;
        state.analysis = null;
        persistCurrent();
      }
      await loadRepos();
      toast('Repository removed', 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(-1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* repository selection & refresh                                      */
/* ------------------------------------------------------------------ */

function selectRepo(id) {
  if (!state.repos.some((r) => r.id === id)) return;
  stopAnalysisPoll();
  stopCloneViewPoll();
  state.currentId = id;
  persistCurrent();
  state.summary = null;
  state.analysis = null;
  render();
}

async function loadRepos(silent = false) {
  setBusy(1);
  try {
    const data = await api('/repositories');
    state.repos = data.repos || [];
  } catch (err) {
    if (!silent) toast(err.message, 'error');
  } finally {
    setBusy(-1);
  }
}

async function refreshCurrent() {
  const repo = currentRepo();
  if (!repo) return;
  setBusy(1);
  try {
    await api(`/repositories/${repo.id}/refresh`, { method: 'POST' });
    state.summary = null;
    await loadRepos();
    toast('Rescan complete', 'success');
    render();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(-1);
  }
}

/* ------------------------------------------------------------------ */
/* add repository modal & upload                                       */
/* ------------------------------------------------------------------ */

function modalHTML() {
  return `
  <div class="modal-overlay" id="modalOverlay">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <h2 id="modalTitle">Add repository</h2>
      <p class="modal-sub">Upload a ZIP containing a repository, or clone a public Git URL. The archive may hold the repository folder itself or its contents — as long as the <code>.git</code> file or directory is inside.</p>
      <div class="modal-drop" id="modalDrop">
        ${ICONS.upload}
        <div>Drag and drop a <strong>.zip</strong> here, or <span class="link">browse</span></div>
        <input type="file" id="fileInput" accept=".zip,application/zip" hidden>
      </div>
      <div class="url-row">
        <input class="filter-input" type="text" id="cloneUrl" placeholder="https://github.com/owner/repo.git" autocomplete="off" spellcheck="false">
        <button class="btn" id="cloneBtn">Clone</button>
      </div>
      <div id="uploadProgress" hidden>
        <div class="progress-track"><div class="progress-fill" id="progressFill"></div></div>
        <div class="upload-status" id="uploadStatus"></div>
      </div>
      <div class="modal-footer">
        <button class="btn ghost" id="modalCancel">Cancel</button>
      </div>
    </div>
  </div>`;
}

function openAddModal() {
  if ($('#modalOverlay')) return;
  $('#modalRoot').innerHTML = modalHTML();
  const drop = $('#modalDrop');
  const input = $('#fileInput');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) startUpload(input.files[0]);
  });
  ['dragenter', 'dragover'].forEach((evt) => drop.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((evt) => drop.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('dragover');
  }));
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) startUpload(file);
  });
  $('#modalCancel').addEventListener('click', cancelModal);
  $('#modalOverlay').addEventListener('mousedown', (e) => {
    if (e.target === $('#modalOverlay')) cancelModal();
  });
  const cloneBtn = $('#cloneBtn');
  const cloneInput = $('#cloneUrl');
  if (cloneBtn && cloneInput) {
    cloneBtn.addEventListener('click', () => startClone(cloneInput.value));
    cloneInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        startClone(cloneInput.value);
      }
    });
  }
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
}

function cancelModal() {
  stopClonePoll();
  if (uploadXhr) {
    try { uploadXhr.abort(); } catch { /* already finished */ }
    uploadXhr = null;
    toast('Upload cancelled');
  }
  closeModal();
}

function setUploadError(message) {
  const progress = $('#uploadProgress');
  if (progress) progress.hidden = false;
  const fill = $('#progressFill');
  if (fill) {
    fill.classList.remove('indeterminate');
    fill.style.width = '100%';
    fill.style.background = 'var(--crit)';
  }
  const status = $('#uploadStatus');
  if (status) {
    status.textContent = message;
    status.classList.add('error');
  }
  const cancel = $('#modalCancel');
  if (cancel) cancel.textContent = 'Close';
}

function startUpload(file) {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    setUploadError('Only .zip archives are supported.');
    return;
  }
  const progress = $('#uploadProgress');
  const fill = $('#progressFill');
  const status = $('#uploadStatus');
  const cancel = $('#modalCancel');
  if (!progress || !fill || !status) return;

  progress.hidden = false;
  fill.classList.remove('indeterminate');
  fill.style.background = '';
  fill.style.width = '0%';
  status.classList.remove('error');
  status.textContent = `Uploading ${file.name}… 0%`;
  if (cancel) cancel.textContent = 'Cancel upload';

  const xhr = new XMLHttpRequest();
  uploadXhr = xhr;
  xhr.open('POST', `${API}/repositories`);
  xhr.responseType = 'json';

  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    fill.style.width = `${pct}%`;
    if (pct < 100) {
      status.textContent = `Uploading ${file.name}… ${pct}%`;
    } else {
      fill.classList.add('indeterminate');
      fill.style.width = '40%';
      status.textContent = 'Extracting and scanning repository…';
    }
  });

  xhr.addEventListener('load', async () => {
    uploadXhr = null;
    if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
      const repo = xhr.response;
      closeModal();
      toast(`Added "${repo.name}"`, 'success');
      await loadRepos();
      stopAnalysisPoll();
      state.currentId = repo.id;
      persistCurrent();
      state.view = 'summary';
      state.summary = null;
      state.analysis = null;
      render();
    } else {
      const raw = xhr.response && xhr.response.detail;
      const detail = typeof raw === 'string' ? raw : `Upload failed (${xhr.status})`;
      setUploadError(detail);
    }
  });
  xhr.addEventListener('error', () => {
    uploadXhr = null;
    setUploadError('Network error during upload.');
  });
  xhr.addEventListener('abort', () => { uploadXhr = null; });

  const fd = new FormData();
  fd.append('file', file, file.name);
  xhr.send(fd);
}

/* ------------------------------------------------------------------ */
/* remote URL cloning (Phase 6)                                        */
/* ------------------------------------------------------------------ */

function stopClonePoll() {
  if (state.clonePoll) {
    clearTimeout(state.clonePoll);
    state.clonePoll = null;
  }
}

async function startClone(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) {
    setUploadError('Enter a repository URL to clone.');
    return;
  }
  const progress = $('#uploadProgress');
  const fill = $('#progressFill');
  const status = $('#uploadStatus');
  const cloneBtn = $('#cloneBtn');
  const cancel = $('#modalCancel');
  if (!progress || !fill || !status) return;

  progress.hidden = false;
  fill.classList.remove('indeterminate');
  fill.style.background = '';
  fill.style.width = '0%';
  status.classList.remove('error');
  status.textContent = 'Contacting remote…';
  if (cloneBtn) {
    cloneBtn.disabled = true;
    cloneBtn.textContent = 'Cloning…';
  }
  if (cancel) cancel.textContent = 'Close';

  let repo;
  try {
    repo = await api('/repositories/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch (err) {
    if (cloneBtn) {
      cloneBtn.disabled = false;
      cloneBtn.textContent = 'Clone';
    }
    setUploadError(err.message);
    return;
  }
  toast(`Cloning "${repo.name}"…`);
  pollClone(repo);
}

function pollClone(repo, tries = 0) {
  stopClonePoll();
  if (tries > 3000) return; // ~60 min at 1.2 s — plenty for the largest targets
  state.clonePoll = setTimeout(async () => {
    state.clonePoll = null;
    if (!$('#modalOverlay')) return; // modal closed; the job keeps running server-side
    let rec;
    try {
      rec = await api(`/repositories/${repo.id}`);
    } catch {
      pollClone(repo, tries + 1);
      return;
    }
    const clone = rec.clone || {};
    const fill = $('#progressFill');
    const status = $('#uploadStatus');
    if (fill && status && !status.classList.contains('error')) {
      const pct = Math.max(2, Math.min(100, clone.progress || 0));
      fill.classList.remove('indeterminate');
      fill.style.width = `${pct}%`;
      status.textContent = rec.status === 'ready' || clone.state === 'done'
        ? 'Preparing repository…'
        : `Cloning… ${pct}% — ${clone.phase || 'connecting'}`;
    }
    if (rec.status === 'ready') {
      finishCloneModal(rec);
      return;
    }
    if (rec.status === 'error') {
      setUploadError(rec.error || clone.error || 'Clone failed.');
      return;
    }
    pollClone(repo, tries + 1);
  }, 1200);
}

async function finishCloneModal(repo) {
  stopClonePoll();
  closeModal();
  toast(`Cloned "${repo.name}"`, 'success');
  await loadRepos();
  stopAnalysisPoll();
  state.currentId = repo.id;
  persistCurrent();
  state.view = 'summary';
  state.summary = null;
  state.analysis = null;
  render();
}

/* ------------------------------------------------------------------ */
/* global drag & drop + hotkeys                                        */
/* ------------------------------------------------------------------ */

function wireGlobalDrag() {
  const overlay = $('#dropOverlay');
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || $('#modalOverlay')) return;
    e.preventDefault();
    depth += 1;
    overlay.classList.add('show');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove('show');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    overlay.classList.remove('show');
    depth = 0;
    if ($('#modalOverlay')) return; // the modal dropzone handles its own drop
    const file = Array.from(e.dataTransfer.files || []).find((f) => f.name.toLowerCase().endsWith('.zip'));
    if (file) {
      openAddModal();
      startUpload(file);
    } else {
      toast('Only .zip archives are supported', 'error');
    }
  });
}

function wireHotkeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#modalOverlay')) cancelModal();
  });
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  wireGlobalDrag();
  wireHotkeys();
  $('#addRepoBtn').addEventListener('click', openAddModal);
  $('#refreshBtn').addEventListener('click', refreshCurrent);
  [$('#repoSelectTop'), $('#repoSelectFilter')].forEach((sel) => {
    sel.addEventListener('change', (e) => {
      if (e.target.value) selectRepo(e.target.value);
    });
  });

  const saved = localStorage.getItem('repolens.current');
  await loadRepos();
  if (state.repos.length) {
    state.currentId = saved && state.repos.some((r) => r.id === saved) ? saved : state.repos[0].id;
    persistCurrent();
  }
  render();
}

init();
