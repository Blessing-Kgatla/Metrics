# UI Design Specification: RepoLens Dashboard

> Companion document to [project_requirements.md](project_requirements.md). This specification defines the interface RepoLens must deliver for the COMS3011A Repo Analysis Tool (RAT), grounded in the rubric's Architectural & UI Design and Usability criteria.
>
> Scope: layout, navigation, views, visual language, UI states, performance targets, and quality-of-life behavior.

## 1. Rubric-Derived UI Requirements

The rubric drives the UI requirements directly. Each graded criterion translates into concrete interface obligations:

| Rubric criterion (weight) | ≤ 100% target | UI obligation |
| --- | --- | --- |
| Requirements (50%) | Filtering, Author Merge, and Multi-repo support all implemented | Global filter bar (repository, author, file/directory, commit selection); repository manager for multiple repos; author-merge flows (mailmap + manual) |
| Architectural & UI Design (25%) | Efficient algorithms/architecture; inspired visualisation of metrics | Filter changes re-aggregate from precomputed data with no re-scan; visual language built from the brief's actual metrics (churn, growth, ownership) |
| Usability (25%) | Excellent navigation; good performance on large (~100,000 commits) repos | Breadcrumbs, deep-linkable state, keyboard access; progressive scanning and virtualised rendering for large repositories |

Two standing requirements apply to every screen:

1. **Metric visibility** — every metric defined in the brief (file, directory, repository, commit set, and author scopes) must be readable somewhere in the UI. See the coverage matrix (§8).
2. **Metric fidelity** — displayed numbers must be the exact graded formulas for the *active commit set* \(H\): \(l^+\), \(l^-\), \(\delta\), \(\lambda\), \(n\), \(\eta\), \(\rho\), and author \(n_{H,o,a}\), \(\lambda_{H,o,a}\), \(\omega_{H,o,a}\). No rounding that hides ordering; full precision available on hover/export.

Tier ladder from a UI perspective:

- **≤ 50%** — correct metrics visible (well-built tables are acceptable), both ingestions (ZIP + clone URL) usable from the UI.
- **≤ 75%** — working filters, multi-repo dashboard, and reasonably good visualisation.
- **≤ 100%** — inspired visualisation, excellent navigation, error handling on every failure path, QoL features, and smooth behavior on ~100,000-commit repositories.

## 2. Design Principles

1. **Metrics first** — every chart maps to a defined metric; decorative graphics are out.
2. **Progressive disclosure** — summary → scope → object detail (drill-downs and flyouts), never a wall of numbers.
3. **Explain the math** — every metric shown in the UI has a tooltip with its name, formula, and active scope (commit set size, date span, filters).
4. **No layout shift** — re-filtering keeps the previous render dimmed in place while updating (§6).
5. **Local-first speed** — the UI feels instant because aggregates are precomputed; loading indicators stay honest about background work.

## 3. Visual Hierarchy & Theme

RepoLens uses a high-contrast, modern utility theme optimized for long viewing sessions.

### 3.1 Color Palette

| Token | Value | Usage |
| --- | --- | --- |
| Background — Canvas | `#0D1117` | App background |
| Background — Surface | `#161B22` | Cards, panels, left nav |
| Background — Hover | `#21262D` | Table row / list hover |
| Border / Divider | `#30363D` | 1px borders, table rules |
| Text — Primary | `#E6EDF3` | Numbers, headings |
| Text — Secondary | `#8B949E` | Labels, metadata |
| Text — Muted | `#6E7681` | Disabled states, chart axes |
| Accent — Brand / System | `#00A3A6` | Selection, links, focus rings, primary actions |
| Signal — Pass / Safe | `#2EA043` | Healthy values, added lines |
| Signal — Warning | `#D29922` | Watch items, medium churn |
| Signal — Critical / Hot | `#F85149` | Alerts, high churn, removed lines |

Visualisation palettes (fixed so every chart reads consistently):

- **Churn scale (cool → hot):** `#1F6FEB` → `#00A3A6` → `#D29922` → `#F0883E` → `#F85149`. Stable files render cool; volatile files glow hot.
- **Ownership density:** accent `#00A3A6` at 8% → 100% alpha, so matrix cells intensify with author ownership \(\omega\).
- **Delta convention:** added `+` in Pass green, removed `−` in Critical red, net values in Primary text.

Accessibility: all text/background pairs meet WCAG AA; focus states use a 2px accent ring.

### 3.2 Typography

| Role | Family | Size / Weight | Usage |
| --- | --- | --- | --- |
| Display | Inter / Inter Tight | 28 / 700 | Health score, key totals |
| H1 | Inter | 20 / 600 | View titles |
| H2 | Inter | 16 / 600 | Panel titles |
| Body | Inter | 14 / 400 | General UI |
| Caption | Inter | 12 / 500 | Labels, chips, chart axes |
| Mono | JetBrains Mono / Fira Code | 13 / 400 | Numbers, paths, commands, tables |

Rules: numeric columns are right-aligned and always Mono; file paths are always Mono; never use Mono for prose.

### 3.3 Spacing, Radius, Elevation

- 4px base grid; panel padding 16px; card gap 12px.
- Radii: cards 8px, controls 6px, pills 999px.
- Depth via 1px borders (dark theme); flyouts may add a soft shadow (black 40%, 12px blur).

## 4. Layout & Navigation

A fixed-height, single-page application. Three structural zones plus a persistent filter bar between the top bar and the content area.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ RepoLens │ Repo: ecommerce-api ▾ │ Branch: main ▾ │            Refresh Scan │
├──────────────────────────────────────────────────────────────────────────────┤
│ Repo: All ▾ │ Author: All ▾ │ Path: any ▾ │ Commits: Last 90 days ▾ │ Reset │
├──────────────┬───────────────────────────────────────────────────────────────┤
│ Summary      │  OVERVIEW CARDS                                               │
│ Galaxy       │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │
│ Ownership    │  │ Health 84  │ │ |H| 1,420  │ │  Totals    │ │ Bus Factor │  │
│ Repositories │  └────────────┘ └────────────┘ └────────────┘ └────────────┘  │
│ Settings     │                                                               │
│              │  HOT SPOTS (60%)               │  ACTIVITY TREND (40%)        │
│              │  ┌───────────────────────────┐ │  ┌──────────────────────────┐ │
│              │  │ file        λ  n  η  owner│ │  │  ╱╲    commits / week    │ │
│              │  └───────────────────────────┘ │  └──────────────────────────┘ │
└──────────────┴───────────────────────────────────────────────────────────────┘
  240px nav                          Main Content Area
```

### 4.1 Top Bar (fixed)

- Left: RepoLens logo + repository switcher dropdown (multi-repo; includes an "All repositories" scope and an "Add repository…" action — §5.4).
- Repository path string on hover with click-to-copy (tooltip shows full path).
- Right: branch selector — selects the reference commit \(h_r\) used for metric computation (defaults to `HEAD`); "Refresh Scan" button (re-index, keeps last render visible while running).
- A thin indeterminate progress bar appears directly beneath the top bar while any scan or re-aggregation runs (§6).

### 4.2 Left Navigation (fixed, 240px)

Five destinations; the active item shows a 3px accent left bar plus surface tint. The rail is collapsible to a 48px icon-only mode (QoL). Each item has a monochrome icon anchor.

| Item | Purpose |
| --- | --- |
| Summary & Overview | Default landing view; KPIs, hot spots, activity trend |
| Codebase Galaxy | Structural map of files colored by churn |
| Knowledge & Ownership | Contributor/ownership matrix, bus factor, author merging |
| Repositories | Multi-repo management and ingestion (ZIP / clone URL) |
| Exclusions & Settings | File exclusions, mailmap status, visualization defaults |

### 4.3 Global Filter Bar (persistent — core requirement)

Controls, left to right:

- **Repository** — All repositories or one specific repo.
- **Author** — specific author or all (respects merged identities).
- **Path** — file/directory picker with fuzzy search; selecting a directory scopes all views to that subtree.
- **Commits** — the commit-set selector:
  - All history
  - Last 30 / 90 days (time presets, i.e. \(H_t\))
  - Custom range (inclusive start, exclusive end — the \(H_{i,j}\) semantics, using committer-date in UTC)
  - Select commits… (searchable multi-select modal: hash, author, date, message — an arbitrary \(H \subseteq \bar{H}\))
- **Active filter chips** — each removable individually; "Reset" clears all.
- **Scope readout** — right-aligned: `|H| = 1,420 commits · Jan 2 – Apr 1 · merges excluded`.

Behavior: every control edits the active commit set \(H\) and re-aggregates all views; filters combine with AND; the full filter state is encoded in the URL for sharing and reload persistence.

### 4.4 Content Area & Navigation Depth

- The main region scrolls internally; the left nav, top bar, and filter bar stay fixed.
- Breadcrumb trail for drill-down: `Repository ▸ Directory ▸ File` — every segment is clickable and re-scopes the workspace.
- When the repository filter is "All repositories": Summary aggregates across repos; structural views (Galaxy) require a single repo and display a picker prompt instead.

## 5. View Specifications

### 5.1 View 1 — Summary & Overview

Default landing state after launching `repolens --web`.

**Metric ribbon (top row) — six cards:**

| Card | Content |
| --- | --- |
| Health Score | Big bold number out of 100; conditional colors (80+ Pass green, 50–79 Warning yellow, <50 Critical red). Derived composite (ownership concentration + churn volatility + bus-factor density); tooltip shows the factor breakdown and labels it derived. |
| Commits in Scope | \(|H|\) with date span and "merges excluded" note; updates live with filters. |
| Repository Totals | Root-of-commit-tree metrics for \(H\): added \(l^+\), removed \(l^-\), growth \(\delta\), churn \(\lambda\) — the brief's repository metrics. |
| Bus Factor Alerts | Count of files/directories whose top author exceeds 85% ownership \(\omega\) (churn share, per the brief's ownership definition). |
| Primary Tech Stack | Horizontal segmented bar of file LOC distribution (binary and excluded files removed from the denominator). Hover reveals the full breakdown (e.g. TS 82%, Go 12%). |
| Analysis Time | Duration of the last scan (e.g. 1.8s) with the ingestion mode used (ZIP / clone). |

**Hot Spots table (left, 60% width):**

Columns: File Path (left-truncated in Mono, filename always visible) · Churn \(\lambda\) (heat bar using the churn scale) · Modifications \(n\) · Frequency \(\eta\) · Churn Rate \(\rho\) (visible on hover) · Top Owner (author + \(\omega\)%) · Sparkline (per-commit \(\lambda\)).

- Ranking: Hot Spot score = percentile(\(\lambda\)) × percentile(\(\eta\)); formula in the header tooltip; any column sortable.
- Interaction: row hover background `#21262D`, reveals a copy-path icon and an "Open in Editor" shortcut; row click opens the file detail flyout (§5.2).

**Recent Activity Trend (right, 40% width):**

- Default series: commits per week over the selected range (90 days default).
- Series switcher: added \(l^+\) / removed \(l^-\) stacked, growth \(\delta\), or churn \(\lambda\).
- Bucketing auto-adjusts (day/week/month) to range width; brush-to-zoom; clicking a bucket pre-filters the commit picker to that interval.

### 5.2 View 2 — Codebase Galaxy (Canvas)

An interactive canvas mapping code architecture visually.

- **Graph:** force-directed, rendered on canvas/WebGL. Nodes are files; directory containment forms clusters so structure stays readable.
- **Sizing rule:** node radius proportional to file LOC (log scale to keep small files visible).
- **Coloring rule:** churn \(\lambda\) over \(H\) on the cool → hot scale — stable legacy code deep blue/green, heavily modified files glowing orange/red. Legend fixed bottom-left.
- **Hover:** tooltip with path, \(\lambda\), \(n\), \(\eta\), top owner.
- **Click — detail flyout (right sheet):** exact metrics panel for \(H\) (\(l^+\), \(l^-\), \(\delta\), \(\lambda\), \(n\), \(\eta\), \(\rho\)), historical timeline (churn per week), top contributors with \(\omega\) bars, actions: Open in Editor, Copy Path, Exclude File.
- **Controls:** pan & zoom; threshold slider hiding files below a LOC or modification count (noise reduction); render budget — top 5,000 nodes by churn by default, "render all" opt-in (§7).

### 5.3 View 3 — Knowledge & Ownership Matrix

The human layer of the codebase.

- **The matrix map:** contributors (rows) × main directories (columns). Cell intensity = author ownership — the fraction of churn on that directory from that author (\(\omega_{H,o,a} = \lambda_{H,o,a} / \lambda_{H,o}\)). Hover shows exact values; clicking a cell drills into that directory with the author filter applied.
- **Bus factor flagging:** any module/directory whose top author exceeds 85% ownership \(\omega\) shows a warning icon with a tooltip ("Sole owner: @alice-dev — 92% of churn over H"), prompting cross-training or documentation. (Threshold is measured on churn ownership, matching the RAT metric definition.)
- **Contributor table** (below the matrix):

| Contributor | Key Modules Owned | Ownership % | Commits |
| --- | --- | --- | --- |
| @alice-dev | /src/services/payment | 64% | author modifications \(n_{H,o,a}\) share |

Columns: Contributor · Key Modules Owned (top directories by \(\omega\)) · Ownership % (churn share) · Commits (author modifications share); all sortable and searchable by name/email.

- **Author merging (rubric requirement):** each row exposes "Merge identities…" opening a modal that lists the raw name/email identities seen in git, with a mailmap status pill ("Mailmap applied — 12 of 14 identities merged automatically"). Manual merges create a persisted mapping, re-resolve retroactively, and update every author metric; merges are undoable via toast.

### 5.4 View 4 — Repositories (multi-repo management & ingestion)

- **Repository cards:** name, ingestion source (ZIP / Clone URL), branch (\(h_r\)), status (Scanning… / Ready / Error), scale (commits, files, directories), last scan time and duration, actions (Open, Refresh, Remove).
- **Add Repository:** drag-and-drop a ZIP containing `.git`, or paste a remote clone URL (deep clone). Progress is a determinate bar with live counters ("12,400 / 96,402 commits") and a Cancel action; long scans continue in the background while the rest of the app stays usable.
- **Dashboard scope:** "All repositories" in the filter bar aggregates metrics across repos in Summary; structural views operate per selected repo.

### 5.5 View 5 — File Exclusions & Settings

- **Exclusions:** glob patterns and directory-tree checkboxes; excluded objects leave all aggregates. Binary files are always excluded per spec — shown as a locked group with a visible count (not user-toggleable).
- **Author identities:** mailmap status, list of manual merges with an un-merge action.
- **Visualization defaults:** galaxy node budget, threshold slider defaults, chart preferences.
- **Performance:** render-limit preferences only — no setting may disable full-history computation (correctness requirement).
- **About:** analyzer version, current commit set, ingestion mode.

## 6. UI States, Errors & Micro-interactions

| State | Specification |
| --- | --- |
| Loading / Scanning | A minimal, fast-spinning indeterminate progress bar directly beneath the top bar. No heavy layout-shifting skeletons. For scans longer than ~2s it becomes determinate with a commit counter. |
| Filter re-aggregation | Stale-while-update: previous render dims to 60% opacity, a small spinner appears on the changed chip, numbers swap in place — never a blank panel or reflow. Target < 200ms. |
| Empty / No repo | Clean center-aligned layout: "No Git history found. Drag and drop a folder containing a .git directory here" — followed by "or add a repository via ZIP upload / clone URL" with both actions inline. |
| Empty filter result | Center message "No commits match the current filters" with a "Clear filters" button and a suggestion of the nearest broader scope. |
| Partial results | Warning banner: "Showing partial results — scan in progress (68%)". Views render from what is indexed so far. |
| Ingestion errors | Invalid ZIP (no `.git`) and clone failures (network/auth) show an error card with the reason and a Retry button. No silent failures. |
| Zero-commit scope | When \(|H| = 0\), \(\eta\) and \(\rho\) display as 0 per the metric definition, with the note "no commits in range". |
| Table row hover | Background shifts to `#21262D`; a copy-path icon appears and copies the path natively to the clipboard (icon swaps to a check for 1.5s). |
| Galaxy node hover / click | Node brightens, tooltip appears; click slides the detail flyout in from the right. |
| Matrix cell hover | Cell tooltip with exact \(\omega\), \(\lambda_{H,o,a}\) and \(\lambda_{H,o}\) values; row/column headers highlight for crosshair scanning. |
| Notifications | Toasts for scan complete, export ready, and identity merges — merges include an Undo action. |

## 7. Performance Targets & Responsiveness

Targets by repository scale (aligned with the rubric's ~1,000 / ~10,000 / ~100,000 commit examples):

| Scale | Example | Targets |
| --- | --- | --- |
| Small (~1k commits) | cJSON | Full scan + first summary render < 1.5s; filter updates < 100ms; no progress UI shown. |
| Medium (~10k commits) | Redis | Scan streams progressively; summary usable during scan (partial-results badge); filter updates < 200ms; tables virtualised above 500 rows. |
| Large (~100k commits) | git | Background indexing with progress and cancel; UI fully interactive during scan; filter re-aggregation < 300ms from precomputed rollups; galaxy renders top 5,000 nodes by default; exports run off-thread. |

UI-side architecture notes: aggregations read from pre-indexed rollups (per-commit facts + materialised directory sums), so changing filters never triggers a re-scan; charts render on canvas/WebGL; large tables and exports run off the main thread; updates dim rather than reflow.

## 8. Metric Coverage Matrix

Every brief metric and where it surfaces in the UI. All values shown are for the active commit set \(H\) and re-render on filter change.

| Metric | Scope(s) | Primary surface | Secondary |
| --- | --- | --- | --- |
| Added lines \(l^+\) | file, directory, repo | Repository Totals card | Flyouts, activity chart (stack), CSV export |
| Removed lines \(l^-\) | file, directory, repo | Repository Totals card | Flyouts, activity chart (stack), CSV export |
| Growth \(\delta\) | file, directory, repo, commit set | Flyout metric panel | Activity chart series, CSV export |
| Churn \(\lambda\) | file, directory, repo, commit set | Hot Spots heat column; Galaxy node color | Flyouts, sparklines, CSV export |
| Modifications \(n\) | file, directory, repo, commit set | Hot Spots column | Flyout panel, CSV export |
| Modification frequency \(\eta\) | file, directory, repo, commit set | Hot Spots column (ranking input) | Flyout panel, CSV export |
| Churn rate \(\rho\) | file, directory, repo, commit set | Hot Spots hover | Flyout panel, CSV export |
| Author modifications \(n_{H,o,a}\) | author | Ownership table "Commits" column | Flyout contributor bars |
| Author churn \(\lambda_{H,o,a}\) | author | Matrix cell tooltip | Flyout contributor bars |
| Ownership \(\omega\) | author | Matrix cell intensity; bus-factor flags | Ownership table %, flyout bars |

## 9. Accessibility & Quality-of-Life

- WCAG AA contrast throughout; 2px accent focus rings; full keyboard access to nav, tables, dialogs; Esc closes flyouts and modals.
- Deep links: every filter/scope combination is a URL; "Copy view link" action.
- Exports: CSV for all tables (exact values, full precision); PNG/SVG for charts.
- Saved views: name and recall filter presets per repository.
- Metric tooltips everywhere a metric appears (name, formula, active scope).
- Editor integration: "Open in Editor" on every path surface.
- Reduced-motion preference disables galaxy physics animation.

## Appendix: Improvements over the Base Specification

- Added the global filter bar (repository / author / file-directory / commit selection) — the brief's core dashboard requirement, previously absent.
- Added the Repositories view covering multi-repo management and both ingestion forms (ZIP + clone URL) with progress and error handling.
- Re-grounded metrics: hot spots now use churn \(\lambda\), modifications \(n\), frequency \(\eta\), and rate \(\rho\); ownership and bus factor use \(\omega\) (churn share) instead of lines written, matching the graded definitions.
- Added the rubric-derived requirements section and the metric coverage matrix to guarantee every graded metric is visible.
- Added error, partial-result, and zero-commit states with defined copy and recovery actions.
- Added performance targets per repository scale, plus render budgets for the galaxy view.
- Added QoL: deep links, saved views, exports, keyboard access, undoable identity merges.
