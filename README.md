# Release Control Center (Pro)

A local React 18 + Vite dashboard for engineering managers to inspect CI/CD release reports (vulnerability scans, Selenium UI tests, and end-to-end tests), evaluate release gates, track risk trends across versions, and coordinate remediation tasks across the **Testing** and **Deployment** teams.

## Key Capabilities

- **Applications Command View**: Fleet Readiness Index gauge, interactive KPI cards, smart presets (`Release blockers`, `Needs review`, `Ready to ship`, `Security risks`, `Failing tests`, `Unassigned issues`), multi-column sorting, inline `C/H/M/L` security & test pass-rate bars, batch selection, and one-click auto-assignment of suggested tasks.
- **Side Detail Inspector**: Version switcher (`Latest` vs `Prev`), risk score formula breakdown, release gate checks, version-over-version regression/resolution diffs, manager rollout sign-off / manual hold controls, severity-filtered vulnerabilities, failed test traces, and one-click `+ Task` creation directly from any individual finding or failed test.
- **Tasks Board**: Drag-and-drop Kanban columns (`To do`, `In progress`, `Done`) with keyboard-accessible move buttons, team/priority/search filtering, inline owner assignment, workload completion strip, and CSV export.
- **Insights & Policy Simulator**: Fleet priority and app-type distributions, version-over-version risk trajectory bars, top recurring vulnerabilities, suite reliability metrics, and a live Release Gate Policy Simulator.
- **Reports & Audit Log**: Loaded JSON report explorer (inspect raw JSON or delete individual uploaded reports), Markdown executive brief copy/download, and a persistent manager activity log.

## Setup & Running (Frontend + Express Backend + SQLite Database)

```bash
npm install
npm run dev
```

`npm run dev` launches both servers concurrently:
- **Frontend (Vite):** `http://localhost:5173` (proxies `/api/*` to the backend)
- **Backend API (Express):** `http://localhost:4000`
- **Database (SQLite via `sql.js`):** persisted on disk at `server/data/release-control.sqlite` (`reports`, `tasks`, `sign_offs`, `settings`, `audit_logs`)

To build and run in production mode (`Express` serves `dist/` + `/api/*`):

```bash
npm run build
npm start
```

## Backend API Endpoints

- `GET /api/health` — SQLite connection status & table row counts
- `GET /api/bootstrap` — Loads stored reports, tasks, sign-offs, policy, and audit log
- `POST /api/reports/bulk`, `POST /api/reports/seed`, `DELETE /api/reports`, `DELETE /api/reports/:id`
- `POST /api/tasks`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`, `DELETE /api/tasks?status=done`
- `PUT /api/signoffs`, `PUT /api/policy`, `DELETE /api/audit`

## Adding Your Own Report Files

You can load **JSON (`.json`)**, **Excel (`.xlsx`)**, and **CSV (`.csv`)** reports in two ways (no GitHub integration or backend required):

1. **Drop files into `src/reports/`**:
   - Any `*.json`, `*.xlsx`, or `*.csv` file inside `src/reports/` is automatically loaded via `import.meta.glob`.
   - When `src/reports/` is empty (and no files have been uploaded in the browser), the dashboard automatically generates sample data for 7 applications (previous and latest versions each).
2. **Upload in the browser**:
   - Click **+ Add Report Files** in the top bar (or drag-and-drop `.json`, `.xlsx`, or `.csv` files anywhere on the dashboard).
   - Uploaded reports and tasks are saved in `localStorage`.
   - Use **Clear** to remove browser-uploaded reports and revert to `src/reports/` or the sample dataset.

### Excel (`.xlsx`) / CSV Report Columns

Each row in an Excel or CSV sheet is grouped automatically by `(app, version, type)`:

`app`, `appType`, `version`, `type` (`security` | `selenium` | `e2e`), `build`, `createdAt`, `finding`, `severity` (`critical` | `high` | `medium` | `low`), `total`, `passed`, `failed`, `failureName`, `failureMessage`

Click **Sample Excel** in the dashboard banner to download a ready-to-edit `.xlsx` template, or inspect [sample-excel-report.xlsx](file:///c:/Users/Raj/Desktop/capstone%20project/src/reports/sample-excel-report.xlsx).

## Report JSON Format

Each `.json` file may contain a single report object or an array of report objects.

### Vulnerability Report (`type: "security"`)

```json
{
  "app": "Payments API",
  "appType": "Service",
  "version": "2.5.0",
  "type": "security",
  "build": "#412",
  "createdAt": "2026-11-24T09:00:00Z",
  "findings": [
    { "title": "Hardcoded API key", "severity": "critical" }
  ]
}
```

- Supported `severity` values: `critical`, `high`, `medium`, `low`.

### Test Report (`type: "selenium"` or `"e2e"`)

```json
{
  "app": "Payments API",
  "version": "2.5.0",
  "type": "selenium",
  "tests": { "total": 40, "passed": 36, "failed": 4 },
  "failures": [
    { "name": "checkout with saved card", "message": "timeout" }
  ]
}
```

Missing fields are normalized with safe defaults (`src/analysis.js`).

## Analysis Rules (`src/analysis.js`)

- **Versioning**: Reports are grouped by `app` and `version`, with semantic version comparison to identify the `latest` and `previous` versions.
- **Risk Score (0–100)**:
  - Vulnerability weights: `critical` = 10, `high` = 5, `medium` = 2, `low` = 0.5
  - Test failure component: `(total failed / total tests) × 60` across Selenium and E2E reports
  - Capped at `100`
- **Priority & Release Status**:
  - **P1 Critical** (any critical vulnerability or score ≥ 60) → **Blocked**
  - **P2 High** (score ≥ 35) → **Needs review**
  - **P3 Medium** (score ≥ 15) → **Needs review**
  - **P4 Low** (score < 15) → **Ready**
- **Trend**: Risk score change between the previous and latest version (`up`, `down`, `0`, or `New`).
- **Auto-Suggested Tasks**:
  - Critical vulnerability → Deployment team: *Hold release and ship patched build*
  - Failing Selenium or E2E tests → Testing team: *Triage failing tests*
  - Ready status → Deployment team: *Approve rollout*
