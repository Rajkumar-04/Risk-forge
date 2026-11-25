import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeApplications,
  buildExecutiveMarkdown,
  buildXlsxBytes,
  computeFleetAnalytics,
  computeKpis,
  DEFAULT_POLICY,
  normalizeReports,
  parseCsvText,
  parseXlsxBuffer,
  PRIORITY_META,
  reportsToSpreadsheetRows,
  spreadsheetRowsToReports,
} from './analysis';
import { generateSampleReports } from './sampleData';

const STORAGE_KEYS = {
  uploadedReports: 'rcc_uploaded_reports_v1',
  tasks: 'rcc_tasks_v1',
  theme: 'rcc_theme_v4',
  signOffs: 'rcc_signoffs_v1',
  policy: 'rcc_policy_v1',
  audit: 'rcc_audit_v1',
};

const BOARD_COLUMNS = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

const TEAM_FILTERS = ['All', 'Testing', 'Deployment'];
const STATUS_FILTERS = ['All', 'Blocked', 'Needs review', 'Ready'];
const PRIORITY_FILTERS = ['All', 'P1', 'P2', 'P3', 'P4'];
const OWNER_OPTIONS = ['Unassigned', 'QA Lead', 'SecOps', 'Release Eng', 'Platform'];

// Auto-load any *.json, *.csv, and *.xlsx files placed in src/reports/
const reportModules = import.meta.glob('./reports/*.json', { eager: true });
const csvModules = import.meta.glob('./reports/*.csv', { eager: true, query: '?raw', import: 'default' });
const xlsxModules = import.meta.glob('./reports/*.xlsx', { eager: true, query: '?url', import: 'default' });

function loadBundledReports() {
  const entries = Object.entries(reportModules);
  const raw = [];
  for (const [filePath, mod] of entries) {
    const payload = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
    const fileName = filePath.split('/').pop();
    if (Array.isArray(payload)) {
      payload.forEach((item) => {
        if (item && typeof item === 'object') {
          raw.push({ ...item, _source: `src/reports/${fileName}` });
        }
      });
    } else if (payload && typeof payload === 'object') {
      raw.push({ ...payload, _source: `src/reports/${fileName}` });
    }
  }

  const csvEntries = Object.entries(csvModules);
  const csvReports = [];
  for (const [filePath, csvText] of csvEntries) {
    const fileName = filePath.split('/').pop();
    const rows = parseCsvText(csvText);
    csvReports.push(...spreadsheetRowsToReports(rows, `src/reports/${fileName}`));
  }

  const xlsxUrls = Object.entries(xlsxModules).map(([filePath, url]) => ({
    fileName: filePath.split('/').pop(),
    url,
  }));

  return {
    fileCount: entries.length + csvEntries.length + xlsxUrls.length,
    reports: [...normalizeReports(raw), ...csvReports],
    xlsxUrls,
  };
}

function readLocalStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readStoredArray(key) {
  const val = readLocalStorage(key, []);
  return Array.isArray(val) ? val : [];
}

function readStoredObject(key) {
  const val = readLocalStorage(key, {});
  return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
}

function readStoredPolicy() {
  const stored = readStoredObject(STORAGE_KEYS.policy);
  return {
    weights: {
      ...DEFAULT_POLICY.weights,
      ...(stored.weights && typeof stored.weights === 'object' ? stored.weights : {}),
    },
    testPenaltyScale:
      Number.isFinite(Number(stored.testPenaltyScale))
        ? Number(stored.testPenaltyScale)
        : DEFAULT_POLICY.testPenaltyScale,
    thresholds: {
      ...DEFAULT_POLICY.thresholds,
      ...(stored.thresholds && typeof stored.thresholds === 'object' ? stored.thresholds : {}),
    },
    blockOnCritical:
      typeof stored.blockOnCritical === 'boolean'
        ? stored.blockOnCritical
        : DEFAULT_POLICY.blockOnCritical,
  };
}

function writeLocalStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota/storage access errors
  }
}

async function apiRequest(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    const errBody = contentType.includes('application/json')
      ? await res.json().catch(() => ({}))
      : {};
    throw new Error(errBody.error || `API request failed (${res.status})`);
  }
  if (!contentType.includes('application/json')) {
    throw new Error('Backend API unavailable (non-JSON response)');
  }
  return res.json();
}

function getInitialTheme() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEYS.theme);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Ignore storage access errors
  }
  return 'dark';
}

function formatDateTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTrend(trend) {
  if (!trend || trend.direction === 'new') {
    return { arrow: '★', text: 'New', title: 'No previous version for comparison' };
  }
  if (trend.direction === 'up') {
    return {
      arrow: '↑',
      text: `+${trend.delta}`,
      title: `Risk increased from ${trend.previousScore} (v${trend.previousVersion})`,
    };
  }
  if (trend.direction === 'down') {
    return {
      arrow: '↓',
      text: `${trend.delta}`,
      title: `Risk decreased from ${trend.previousScore} (v${trend.previousVersion})`,
    };
  }
  return {
    arrow: '→',
    text: '0',
    title: `Unchanged vs v${trend.previousVersion} (${trend.previousScore})`,
  };
}

function statusTone(status) {
  if (status === 'Blocked') return 'critical';
  if (status === 'Needs review') return 'high';
  return 'low';
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function isDefaultPolicy(policy) {
  return JSON.stringify(policy) === JSON.stringify(DEFAULT_POLICY);
}

/**
 * Generates deterministic smooth SVG cubic-bezier curve path from numeric values,
 * auto-scaling the Y-axis to make small variations visually clear.
 */
function buildSmoothSvgPath(values, width = 260, height = 54) {
  const numeric = values.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
  if (numeric.length === 0) return { line: '', area: '', lastPt: null };

  const minVal = Math.min(...numeric);
  const maxVal = Math.max(...numeric);
  const span = Math.max(10, maxVal - minVal);
  const floor = Math.max(0, minVal - span * 0.22);
  const ceil = maxVal + span * 0.22;
  const range = Math.max(1, ceil - floor);

  const pts = numeric.map((v, idx) => {
    const x = numeric.length === 1 ? width / 2 : 4 + (idx / (numeric.length - 1)) * (width - 8);
    const norm = (v - floor) / range;
    const y = height - norm * (height - 14) - 7;
    return [x, y];
  });

  if (pts.length === 1) {
    return {
      line: `M 0 ${pts[0][1]} L ${width} ${pts[0][1]}`,
      area: `M 0 ${pts[0][1]} L ${width} ${pts[0][1]} L ${width} ${height} L 0 ${height} Z`,
      lastPt: pts[0],
    };
  }

  let line = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const cx = ((x0 + x1) / 2).toFixed(1);
    line += ` C ${cx} ${y0.toFixed(1)}, ${cx} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }

  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${height} L ${pts[0][0].toFixed(1)} ${height} Z`;
  return { line, area, lastPt: pts[pts.length - 1] };
}

function SparklineChart({ id, values, tone = 'info' }) {
  const { line, area, lastPt } = useMemo(() => buildSmoothSvgPath(values, 260, 54), [values]);
  const strokeColor =
    tone === 'critical'
      ? '#f43f5e'
      : tone === 'high'
        ? '#f97316'
        : tone === 'medium'
          ? '#f59e0b'
          : tone === 'low'
            ? '#10b981'
            : tone === 'violet'
              ? '#a78bfa'
              : '#38bdf8';

  const gradId = `spark-grad-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <svg
      className="sparkline-svg"
      viewBox="0 0 260 54"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.34" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line x1="0" y1="18" x2="260" y2="18" stroke="currentColor" strokeOpacity="0.08" strokeDasharray="3 3" />
      <line x1="0" y1="36" x2="260" y2="36" stroke="currentColor" strokeOpacity="0.08" strokeDasharray="3 3" />
      <path d={area} fill={`url(#${gradId})`} />
      <path
        d={line}
        fill="none"
        stroke={strokeColor}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      {lastPt && (
        <circle
          cx={lastPt[0]}
          cy={lastPt[1]}
          r="3.2"
          fill={strokeColor}
        />
      )}
    </svg>
  );
}

function IconUpload() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function IconSearch({ className = 'icon' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function IconSun() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export default function App() {
  const [activeScreen, setActiveScreen] = useState('applications');
  const [viewMode, setViewMode] = useState('both'); // 'cards' | 'table' | 'both'
  const [theme, setTheme] = useState(getInitialTheme);
  const [uploadedReports, setUploadedReports] = useState(() =>
    readStoredArray(STORAGE_KEYS.uploadedReports)
  );
  const [tasks, setTasks] = useState(() => readStoredArray(STORAGE_KEYS.tasks));
  const [signOffs, setSignOffs] = useState(() => readStoredObject(STORAGE_KEYS.signOffs));
  const [policy, setPolicy] = useState(readStoredPolicy);
  const [auditLog, setAuditLog] = useState(() => readStoredArray(STORAGE_KEYS.audit));
  const [includeSampleApps, setIncludeSampleApps] = useState(false);

  const [selectedAppName, setSelectedAppName] = useState(null);
  const [inspectedVersion, setInspectedVersion] = useState(null);
  const [uploadNotice, setUploadNotice] = useState(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  // Applications filters & sort
  const [appSearch, setAppSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [blockersOnly, setBlockersOnly] = useState(false);
  const [sortBy, setSortBy] = useState('priority');
  const [sortDir, setSortDir] = useState('asc');
  const [selectedRowNames, setSelectedRowNames] = useState([]);

  // Side panel filters & forms
  const [panelIssueFilter, setPanelIssueFilter] = useState('all');
  const [customTitle, setCustomTitle] = useState('');
  const [customTeam, setCustomTeam] = useState('Testing');

  // Tasks board state
  const [teamFilter, setTeamFilter] = useState('All');
  const [priorityFilter, setPriorityFilter] = useState('All');
  const [taskSearch, setTaskSearch] = useState('');
  const [dragOverColumn, setDragOverColumn] = useState(null);

  // Reports explorer state
  const [reportTypeFilter, setReportTypeFilter] = useState('All');
  const [reportSearch, setReportSearch] = useState('');
  const [inspectedRawReport, setInspectedRawReport] = useState(null);

  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);
  const skipPolicySyncRef = useRef(true);

  const [dbStatus, setDbStatus] = useState({
    connected: false,
    checking: true,
    engine: 'SQLite',
    dbPath: '',
    fileSizeBytes: 0,
    counts: { reports: 0, tasks: 0, signOffs: 0, auditLogs: 0 },
  });

  const refreshFromBackend = async () => {
    try {
      const data = await apiRequest('/api/bootstrap');
      skipPolicySyncRef.current = true;
      setUploadedReports(Array.isArray(data.reports) ? data.reports : []);
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
      setSignOffs(data.signOffs && typeof data.signOffs === 'object' ? data.signOffs : {});
      if (data.policy) setPolicy(data.policy);
      setAuditLog(Array.isArray(data.auditLog) ? data.auditLog : []);
      setDbStatus({
        connected: true,
        checking: false,
        ...(data.stats || {}),
      });
    } catch {
      setDbStatus((prev) => ({ ...prev, connected: false, checking: false }));
    }
  };

  useEffect(() => {
    refreshFromBackend();
  }, []);

  useEffect(() => {
    if (!dbStatus.connected) return undefined;
    if (skipPolicySyncRef.current) {
      skipPolicySyncRef.current = false;
      return undefined;
    }
    const timer = setTimeout(() => {
      apiRequest('/api/policy', {
        method: 'PUT',
        body: JSON.stringify({ policy }),
      })
        .then((res) => {
          if (res.stats) setDbStatus((prev) => ({ ...prev, ...res.stats }));
        })
        .catch(() => {});
    }, 350);
    return () => clearTimeout(timer);
  }, [policy, dbStatus.connected]);

  const bundled = useMemo(() => loadBundledReports(), []);
  const [bundledXlsxReports, setBundledXlsxReports] = useState([]);

  useEffect(() => {
    if (bundled.xlsxUrls.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      const loaded = [];
      for (const item of bundled.xlsxUrls) {
        try {
          const res = await fetch(item.url);
          const buf = await res.arrayBuffer();
          const rows = await parseXlsxBuffer(buf);
          loaded.push(...spreadsheetRowsToReports(rows, `src/reports/${item.fileName}`));
        } catch {
          // Ignore malformed bundled xlsx
        }
      }
      if (!cancelled) setBundledXlsxReports(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [bundled.xlsxUrls]);

  const sampleReports = useMemo(
    () =>
      generateSampleReports().map((r, i) => ({
        ...r,
        _source: 'sampleData.js',
        _order: i,
      })),
    []
  );

  const allBundledReports = useMemo(
    () => [...bundled.reports, ...bundledXlsxReports],
    [bundled.reports, bundledXlsxReports]
  );

  const usingSampleData =
    bundled.fileCount === 0 && allBundledReports.length === 0 && uploadedReports.length === 0;

  const activeRawReports = useMemo(() => {
    if (usingSampleData) return sampleReports;
    const realReports = [...allBundledReports, ...uploadedReports];
    return includeSampleApps ? [...realReports, ...sampleReports] : realReports;
  }, [usingSampleData, includeSampleApps, sampleReports, allBundledReports, uploadedReports]);

  const normalizedInventory = useMemo(
    () => normalizeReports(activeRawReports),
    [activeRawReports]
  );

  const applications = useMemo(
    () => analyzeApplications(activeRawReports, policy),
    [activeRawReports, policy]
  );

  const fleetAnalytics = useMemo(
    () => computeFleetAnalytics(applications),
    [applications]
  );

  const appTypes = useMemo(() => {
    const types = Array.from(new Set(applications.map((a) => a.appType))).sort();
    return ['All', ...types];
  }, [applications]);

  const openTaskCountsByApp = useMemo(() => {
    const counts = new Map();
    for (const task of tasks) {
      if (task.status !== 'done') {
        counts.set(task.app, (counts.get(task.app) || 0) + 1);
      }
    }
    return counts;
  }, [tasks]);

  const kpis = useMemo(
    () => computeKpis(applications, tasks),
    [applications, tasks]
  );

  const customPolicyActive = useMemo(() => !isDefaultPolicy(policy), [policy]);

  const filteredApplications = useMemo(() => {
    const query = appSearch.trim().toLowerCase();
    const list = applications.filter((app) => {
      if (blockersOnly && app.releaseStatus !== 'Blocked') return false;
      if (statusFilter !== 'All' && app.releaseStatus !== statusFilter) return false;
      if (typeFilter !== 'All' && app.appType !== typeFilter) return false;
      if (!query) return true;
      return (
        app.app.toLowerCase().includes(query) ||
        app.latestVersion.toLowerCase().includes(query) ||
        app.appType.toLowerCase().includes(query) ||
        app.findings.some((f) => f.title.toLowerCase().includes(query))
      );
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sortBy === 'priority') {
        if (a.priority.rank !== b.priority.rank) {
          return (a.priority.rank - b.priority.rank) * dir;
        }
        return (b.riskScore - a.riskScore) * dir;
      }
      if (sortBy === 'score') return (a.riskScore - b.riskScore) * dir;
      if (sortBy === 'name') return a.app.localeCompare(b.app) * dir;
      if (sortBy === 'passRate') return (a.passRate - b.passRate) * dir;
      if (sortBy === 'updated') return (a.latestTimestampMs - b.latestTimestampMs) * dir;
      return 0;
    });

    return list;
  }, [applications, blockersOnly, statusFilter, typeFilter, appSearch, sortBy, sortDir]);

  const selectedApp = useMemo(
    () => applications.find((item) => item.app === selectedAppName) || null,
    [applications, selectedAppName]
  );

  const pipelineFocusApp = useMemo(
    () => selectedApp || filteredApplications[0] || applications[0] || null,
    [selectedApp, filteredApplications, applications]
  );

  const activeVersionEval = useMemo(() => {
    if (!selectedApp) return null;
    if (inspectedVersion) {
      const match = selectedApp.versions.find((v) => v.version === inspectedVersion);
      if (match) return match;
    }
    return selectedApp.versions[0] || null;
  }, [selectedApp, inspectedVersion]);

  const selectedAppTasks = useMemo(() => {
    if (!selectedApp) return [];
    return tasks.filter((t) => t.app === selectedApp.app);
  }, [tasks, selectedApp]);

  const missingSuggestedTasksCount = useMemo(() => {
    const existingKeys = new Set(tasks.map((t) => t.suggestionKey).filter(Boolean));
    let count = 0;
    for (const app of applications) {
      for (const sug of app.suggestedTasks) {
        if (!existingKeys.has(sug.key)) count += 1;
      }
    }
    return count;
  }, [applications, tasks]);

  // Persistence effects
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    writeLocalStorage(STORAGE_KEYS.theme, theme);
  }, [theme]);

  useEffect(() => {
    writeLocalStorage(STORAGE_KEYS.uploadedReports, uploadedReports);
  }, [uploadedReports]);

  useEffect(() => {
    writeLocalStorage(STORAGE_KEYS.tasks, tasks);
  }, [tasks]);

  useEffect(() => {
    writeLocalStorage(STORAGE_KEYS.signOffs, signOffs);
  }, [signOffs]);

  useEffect(() => {
    writeLocalStorage(STORAGE_KEYS.policy, policy);
  }, [policy]);

  useEffect(() => {
    writeLocalStorage(STORAGE_KEYS.audit, auditLog);
  }, [auditLog]);

  useEffect(() => {
    const app = applications.find((item) => item.app === selectedAppName);
    setInspectedVersion(app ? app.latestVersion : null);
    setPanelIssueFilter('all');
    // Reset only when switching selected app
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAppName]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (inspectedRawReport) {
          setInspectedRawReport(null);
        } else if (selectedApp) {
          setSelectedAppName(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedApp, inspectedRawReport]);

  const appendAudit = (action, detail) => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      action,
      detail,
    };
    setAuditLog((prev) => [entry, ...prev].slice(0, 80));
  };

  const processFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const validReports = [];
    const errors = [];

    for (const file of files) {
      const lower = file.name.toLowerCase();
      try {
        if (lower.endsWith('.xlsx')) {
          const buf = await file.arrayBuffer();
          const rows = await parseXlsxBuffer(buf);
          const converted = spreadsheetRowsToReports(rows, `Uploaded: ${file.name}`).map(
            (rep, idx) => ({
              ...rep,
              _uploadId: `${Date.now()}-${file.name}-${idx}`,
            })
          );
          if (converted.length === 0) {
            errors.push(`${file.name}: no valid report rows found`);
          } else {
            validReports.push(...converted);
          }
        } else if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
          const text = await file.text();
          const rows = parseCsvText(text);
          const converted = spreadsheetRowsToReports(rows, `Uploaded: ${file.name}`).map(
            (rep, idx) => ({
              ...rep,
              _uploadId: `${Date.now()}-${file.name}-${idx}`,
            })
          );
          if (converted.length === 0) {
            errors.push(`${file.name}: no valid report rows found`);
          } else {
            validReports.push(...converted);
          }
        } else {
          const text = await file.text();
          const parsed = JSON.parse(text);
          const rawList = Array.isArray(parsed) ? parsed : [parsed];
          const tagged = rawList
            .filter((item) => item && typeof item === 'object')
            .map((item, idx) => ({
              ...item,
              _source: `Uploaded: ${file.name}`,
              _uploadId: `${Date.now()}-${file.name}-${idx}`,
            }));
          const normalized = normalizeReports(tagged);
          if (normalized.length === 0) {
            errors.push(`${file.name}: no valid report objects found`);
          } else {
            validReports.push(...normalized);
          }
        }
      } catch (err) {
        errors.push(`${file.name}: ${err?.message || 'failed to parse file'}`);
      }
    }

    if (validReports.length > 0) {
      if (dbStatus.connected) {
        try {
          const res = await apiRequest('/api/reports/bulk', {
            method: 'POST',
            body: JSON.stringify({ reports: validReports }),
          });
          setUploadedReports((prev) => [...prev, ...(res.reports || validReports)]);
          if (res.stats) setDbStatus((prev) => ({ ...prev, ...res.stats }));
          refreshFromBackend();
        } catch (err) {
          setUploadedReports((prev) => [...prev, ...validReports]);
          errors.push(`DB sync warning: ${err.message}`);
        }
      } else {
        setUploadedReports((prev) => [...prev, ...validReports]);
        appendAudit(
          'Reports uploaded',
          `Imported ${validReports.length} report(s) from ${files.length} file(s)`
        );
      }
    }

    if (errors.length > 0) {
      setUploadNotice({
        type: 'error',
        message: `Added ${validReports.length} report(s). Skipped: ${errors.join('; ')}.`,
      });
    } else {
      setUploadNotice({
        type: 'info',
        message: `Added ${validReports.length} report(s) from ${files.length} file(s).`,
      });
    }
  };

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFilesSelected = async (event) => {
    await processFiles(event.target.files);
    event.target.value = '';
  };

  const handleDragEnter = (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFile(true);
  };

  const handleDragOver = (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
  };

  const handleDragLeave = (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFile(false);
  };

  const handleDrop = async (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFile(false);
    await processFiles(event.dataTransfer.files);
  };

  const handleDownloadSampleTemplate = () => {
    const template = [
      {
        app: 'Checkout Service',
        appType: 'Service',
        version: '1.4.0',
        type: 'security',
        build: '#108',
        createdAt: new Date().toISOString(),
        findings: [
          { title: 'Hardcoded API key in staging helper', severity: 'critical' },
          { title: 'Missing rate limiter on refund endpoint', severity: 'medium' },
        ],
      },
      {
        app: 'Checkout Service',
        appType: 'Service',
        version: '1.4.0',
        type: 'selenium',
        build: '#108',
        createdAt: new Date().toISOString(),
        tests: { total: 40, passed: 36, failed: 4 },
        failures: [
          { name: 'checkout with saved card', message: 'Timeout waiting for confirmation' },
        ],
      },
      {
        app: 'Checkout Service',
        appType: 'Service',
        version: '1.4.0',
        type: 'e2e',
        build: '#108',
        createdAt: new Date().toISOString(),
        tests: { total: 20, passed: 20, failed: 0 },
        failures: [],
      },
    ];
    downloadTextFile(
      'sample-release-report.json',
      JSON.stringify(template, null, 2),
      'application/json'
    );
  };

  const handleDownloadSampleExcel = () => {
    const sampleRows = reportsToSpreadsheetRows([
      {
        app: 'Checkout Service',
        appType: 'Service',
        version: '1.3.0',
        type: 'security',
        build: '#195',
        createdAt: '2026-11-20T10:00:00Z',
        findings: [{ title: 'Outdated JWT dependency', severity: 'high' }],
      },
      {
        app: 'Checkout Service',
        appType: 'Service',
        version: '1.4.0',
        type: 'security',
        build: '#210',
        createdAt: new Date().toISOString(),
        findings: [
          { title: 'Hardcoded API key in staging helper', severity: 'critical' },
          { title: 'Missing rate limiter on refund endpoint', severity: 'medium' },
        ],
      },
      {
        app: 'Checkout Service',
        appType: 'Service',
        version: '1.4.0',
        type: 'selenium',
        build: '#210',
        createdAt: new Date().toISOString(),
        tests: { total: 40, passed: 36, failed: 4 },
        failures: [
          { name: 'checkout with saved card', message: 'Timeout waiting for confirmation' },
        ],
      },
      {
        app: 'Checkout Service',
        appType: 'Service',
        version: '1.4.0',
        type: 'e2e',
        build: '#210',
        createdAt: new Date().toISOString(),
        tests: { total: 20, passed: 20, failed: 0 },
        failures: [],
      },
    ]);
    const bytes = buildXlsxBytes([{ name: 'Release Reports', rows: sampleRows }]);
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sample-release-report.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleExportExcelWorkbook = () => {
    const summaryRows = applications.map((app) => ({
      App: app.app,
      Type: app.appType,
      LatestVersion: app.latestVersion,
      PreviousVersion: app.previousVersion || '',
      RiskScore: app.riskScore,
      Priority: app.priority.label,
      ReleaseStatus: app.releaseStatus,
      Trend: app.trend.label,
      CriticalVulns: app.vulnCounts.critical,
      HighVulns: app.vulnCounts.high,
      MediumVulns: app.vulnCounts.medium,
      LowVulns: app.vulnCounts.low,
      TestsPassed: app.testTotals.passed,
      TestsFailed: app.testTotals.failed,
      TestsTotal: app.testTotals.total,
      PassRatePct: app.passRate,
      LastUpdated: app.lastUpdated,
    }));
    const reportRows = reportsToSpreadsheetRows(activeRawReports);
    const taskRows = tasks.map((t) => ({
      App: t.app,
      Version: t.version,
      Priority: t.priorityCode,
      Team: t.team,
      Owner: t.owner || 'Unassigned',
      Status: t.status,
      Title: t.title,
      CreatedAt: t.createdAt,
    }));
    const bytes = buildXlsxBytes([
      { name: 'Summary', rows: summaryRows },
      { name: 'Raw Reports', rows: reportRows },
      { name: 'Tasks', rows: taskRows },
    ]);
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'release-control-center-export.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    appendAudit('Excel workbook exported', 'Downloaded release-control-center-export.xlsx');
  };

  const handleSeedDatabase = async () => {
    if (!dbStatus.connected) return;
    try {
      const res = await apiRequest('/api/reports/seed', { method: 'POST' });
      await refreshFromBackend();
      setUploadNotice({
        type: 'info',
        message: `Seeded ${res.reports?.length || 0} sample reports (7 apps) into SQLite database.`,
      });
    } catch (err) {
      setUploadNotice({ type: 'error', message: `Database seed failed: ${err.message}` });
    }
  };

  const handleClearUploaded = async () => {
    setUploadedReports([]);
    setSelectedAppName(null);
    setSelectedRowNames([]);
    if (dbStatus.connected) {
      await apiRequest('/api/reports', { method: 'DELETE' }).catch(() => {});
      await refreshFromBackend();
    } else {
      appendAudit('Uploaded reports cleared', 'Reverted to bundled or sample data');
    }
    setUploadNotice({
      type: 'info',
      message:
        allBundledReports.length > 0
          ? 'Cleared stored DB reports. Showing reports from src/reports/.'
          : 'Cleared stored DB reports. Reverted to sample dataset.',
    });
  };

  const removeSingleUploadedReport = async (uploadId) => {
    setUploadedReports((prev) => prev.filter((r) => r._uploadId !== uploadId));
    if (dbStatus.connected) {
      await apiRequest(`/api/reports/${encodeURIComponent(uploadId)}`, {
        method: 'DELETE',
      }).catch(() => {});
      refreshFromBackend();
    } else {
      appendAudit('Report removed', 'Deleted single uploaded report from browser storage');
    }
  };

  const createTask = ({
    app,
    version,
    priorityCode,
    team,
    title,
    suggestionKey = null,
    source = 'Custom',
  }) => {
    const trimmed = title.trim();
    if (!trimmed) return false;

    const newTask = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      app,
      version,
      priorityCode,
      team,
      owner: 'Unassigned',
      source,
      title: trimmed,
      status: 'todo',
      suggestionKey,
      createdAt: new Date().toISOString(),
    };
    setTasks((prev) => [newTask, ...prev]);
    if (dbStatus.connected) {
      apiRequest('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(newTask),
      })
        .then((res) => {
          if (res.stats) setDbStatus((prev) => ({ ...prev, ...res.stats }));
        })
        .catch(() => {});
    } else {
      appendAudit('Task assigned', `${team}: "${trimmed}" (${app} v${version})`);
    }
    return true;
  };

  const handleAssignSuggested = (appItem, suggestion) => {
    const alreadyAssigned = tasks.some(
      (t) => t.suggestionKey && t.suggestionKey === suggestion.key
    );
    if (alreadyAssigned) return;

    createTask({
      app: appItem.app,
      version: appItem.latestVersion,
      priorityCode: appItem.priority.code,
      team: suggestion.team,
      title: suggestion.title,
      suggestionKey: suggestion.key,
      source: 'Suggested',
    });
  };

  const handleAutoAssignBulk = (targetApps) => {
    const existingKeys = new Set(tasks.map((t) => t.suggestionKey).filter(Boolean));
    const toAdd = [];

    for (const appItem of targetApps) {
      for (const sug of appItem.suggestedTasks) {
        if (!existingKeys.has(sug.key)) {
          existingKeys.add(sug.key);
          toAdd.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            app: appItem.app,
            version: appItem.latestVersion,
            priorityCode: appItem.priority.code,
            team: sug.team,
            owner: 'Unassigned',
            source: 'Auto-batch',
            title: sug.title,
            status: 'todo',
            suggestionKey: sug.key,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }

    if (toAdd.length === 0) {
      setUploadNotice({
        type: 'info',
        message: 'All suggested tasks for these applications are already assigned.',
      });
      return;
    }

    setTasks((prev) => [...toAdd, ...prev]);
    if (dbStatus.connected) {
      apiRequest('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ tasks: toAdd }),
      })
        .then((res) => {
          if (res.stats) setDbStatus((prev) => ({ ...prev, ...res.stats }));
        })
        .catch(() => {});
    } else {
      appendAudit(
        'Batch tasks assigned',
        `Created ${toAdd.length} suggested task(s) across ${targetApps.length} application(s)`
      );
    }
    setUploadNotice({
      type: 'info',
      message: `Assigned ${toAdd.length} suggested task(s) to the Testing & Deployment boards.`,
    });
  };

  const handleCustomTaskSubmit = (event) => {
    event.preventDefault();
    if (!selectedApp || !customTitle.trim()) return;
    createTask({
      app: selectedApp.app,
      version: activeVersionEval?.version || selectedApp.latestVersion,
      priorityCode: (activeVersionEval || selectedApp).priority.code,
      team: customTeam,
      title: customTitle,
      source: 'Custom',
    });
    setCustomTitle('');
  };

  const moveTask = (taskId, nextStatus) => {
    setTasks((prev) =>
      prev.map((task) => {
        if (task.id !== taskId || task.status === nextStatus) return task;
        if (!dbStatus.connected) {
          appendAudit(
            'Task moved',
            `"${task.title}" (${task.app}) → ${BOARD_COLUMNS.find((c) => c.id === nextStatus)?.label}`
          );
        }
        return { ...task, status: nextStatus };
      })
    );
    if (dbStatus.connected) {
      apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      }).catch(() => {});
    }
  };

  const updateTaskOwner = (taskId, owner) => {
    setTasks((prev) =>
      prev.map((task) => (task.id === taskId ? { ...task, owner } : task))
    );
    if (dbStatus.connected) {
      apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ owner }),
      }).catch(() => {});
    }
  };

  const deleteTask = (taskId) => {
    const target = tasks.find((t) => t.id === taskId);
    setTasks((prev) => prev.filter((task) => task.id !== taskId));
    if (dbStatus.connected) {
      apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
      })
        .then((res) => {
          if (res.stats) setDbStatus((prev) => ({ ...prev, ...res.stats }));
        })
        .catch(() => {});
    } else if (target) {
      appendAudit('Task removed', `"${target.title}" (${target.app})`);
    }
  };

  const clearDoneTasks = () => {
    const count = tasks.filter((t) => t.status === 'done').length;
    setTasks((prev) => prev.filter((task) => task.status !== 'done'));
    if (dbStatus.connected) {
      apiRequest('/api/tasks?status=done', { method: 'DELETE' })
        .then((res) => {
          if (res.stats) setDbStatus((prev) => ({ ...prev, ...res.stats }));
        })
        .catch(() => {});
    } else {
      appendAudit('Completed tasks cleared', `Removed ${count} done task(s)`);
    }
  };

  const setReleaseSignOff = (appName, version, decision) => {
    const key = `${appName}::${version}`;
    if (!decision) {
      setSignOffs((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (!dbStatus.connected) appendAudit('Sign-off cleared', `${appName} v${version}`);
    } else {
      setSignOffs((prev) => ({
        ...prev,
        [key]: {
          decision,
          updatedAt: new Date().toISOString(),
        },
      }));
      if (!dbStatus.connected) appendAudit(`Release ${decision}`, `${appName} v${version}`);
    }
    if (dbStatus.connected) {
      apiRequest('/api/signoffs', {
        method: 'PUT',
        body: JSON.stringify({ app: appName, version, decision }),
      })
        .then((res) => {
          if (res.stats) setDbStatus((prev) => ({ ...prev, ...res.stats }));
        })
        .catch(() => {});
    }
  };

  const handleSortClick = (columnKey) => {
    if (sortBy === columnKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(columnKey);
      setSortDir(columnKey === 'priority' || columnKey === 'name' ? 'asc' : 'desc');
    }
  };

  const toggleRowSelection = (appName) => {
    setSelectedRowNames((prev) =>
      prev.includes(appName)
        ? prev.filter((n) => n !== appName)
        : [...prev, appName]
    );
  };

  const toggleSelectAllFiltered = () => {
    const visibleNames = filteredApplications.map((a) => a.app);
    const allSelected =
      visibleNames.length > 0 && visibleNames.every((n) => selectedRowNames.includes(n));
    if (allSelected) {
      setSelectedRowNames((prev) => prev.filter((n) => !visibleNames.includes(n)));
    } else {
      setSelectedRowNames((prev) => Array.from(new Set([...prev, ...visibleNames])));
    }
  };

  const handleCopyMarkdownBrief = async () => {
    const md = buildExecutiveMarkdown(applications, tasks, kpis, signOffs);
    try {
      await navigator.clipboard.writeText(md);
      setUploadNotice({
        type: 'info',
        message: 'Copied executive release brief (Markdown) to clipboard.',
      });
    } catch {
      downloadTextFile('release-summary.md', md, 'text/markdown');
    }
  };

  const handleDownloadMarkdownBrief = () => {
    const md = buildExecutiveMarkdown(applications, tasks, kpis, signOffs);
    downloadTextFile('release-readiness-report.md', md, 'text/markdown');
    appendAudit('Report exported', 'Downloaded release-readiness-report.md');
  };

  const handleExportTasksCsv = () => {
    const header = ['App', 'Version', 'Priority', 'Team', 'Owner', 'Status', 'Title', 'Created'];
    const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const rows = tasks.map((t) =>
      [t.app, t.version, t.priorityCode, t.team, t.owner || 'Unassigned', t.status, t.title, t.createdAt]
        .map(escapeCsv)
        .join(',')
    );
    downloadTextFile('release-tasks.csv', [header.join(','), ...rows].join('\n'), 'text/csv');
    appendAudit('Tasks exported', `Exported ${tasks.length} task(s) to CSV`);
  };

  const filteredTasks = useMemo(() => {
    const query = taskSearch.trim().toLowerCase();
    return tasks
      .filter((task) => {
        if (teamFilter !== 'All' && task.team !== teamFilter) return false;
        if (priorityFilter !== 'All' && task.priorityCode !== priorityFilter) return false;
        if (!query) return true;
        return (
          task.title.toLowerCase().includes(query) ||
          task.app.toLowerCase().includes(query) ||
          task.version.toLowerCase().includes(query) ||
          (task.owner || '').toLowerCase().includes(query)
        );
      })
      .sort((a, b) => {
        const ra = PRIORITY_META[a.priorityCode]?.rank ?? 9;
        const rb = PRIORITY_META[b.priorityCode]?.rank ?? 9;
        if (ra !== rb) return ra - rb;
        return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
      });
  }, [tasks, teamFilter, priorityFilter, taskSearch]);

  const taskStats = useMemo(() => {
    const open = tasks.filter((t) => t.status !== 'done');
    const done = tasks.filter((t) => t.status === 'done');
    return {
      total: tasks.length,
      openCount: open.length,
      testingOpen: open.filter((t) => t.team === 'Testing').length,
      deploymentOpen: open.filter((t) => t.team === 'Deployment').length,
      p1Open: open.filter((t) => t.priorityCode === 'P1').length,
      doneCount: done.length,
      pctDone: tasks.length > 0 ? Math.round((done.length / tasks.length) * 100) : 0,
    };
  }, [tasks]);

  const filteredInventory = useMemo(() => {
    const q = reportSearch.trim().toLowerCase();
    return normalizedInventory.filter((r) => {
      if (reportTypeFilter !== 'All' && r.type !== reportTypeFilter) return false;
      if (!q) return true;
      return (
        r.app.toLowerCase().includes(q) ||
        r.version.toLowerCase().includes(q) ||
        (r._source || '').toLowerCase().includes(q) ||
        r.build.toLowerCase().includes(q)
      );
    });
  }, [normalizedInventory, reportTypeFilter, reportSearch]);

  const handleRowKeyDown = (event, appName) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedAppName((prev) => (prev === appName ? null : appName));
    }
  };

  const resetAppFilters = () => {
    setAppSearch('');
    setStatusFilter('All');
    setTypeFilter('All');
    setBlockersOnly(false);
  };

  const hasAppFilters =
    appSearch.trim() !== '' ||
    statusFilter !== 'All' ||
    typeFilter !== 'All' ||
    blockersOnly;

  return (
    <div
      className="app-shell"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDraggingFile && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <IconUpload />
            <p className="drop-overlay-title">Drop JSON, Excel (.xlsx), or CSV files here</p>
            <p className="drop-overlay-sub">
              Security, Selenium, and E2E reports are parsed and analyzed automatically.
            </p>
          </div>
        </div>
      )}

      {inspectedRawReport && (
        <div
          className="modal-backdrop"
          onClick={() => setInspectedRawReport(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Raw JSON report payload"
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <div>
                <h2 className="card-title">
                  {inspectedRawReport.app} v{inspectedRawReport.version} ·{' '}
                  {inspectedRawReport.type.toUpperCase()}
                </h2>
                <span className="card-meta">
                  Source: {inspectedRawReport._source || 'Local JSON'}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setInspectedRawReport(null)}
                aria-label="Close JSON preview"
              >
                <IconClose />
              </button>
            </div>
            <pre className="code-pre">
              {JSON.stringify(
                {
                  app: inspectedRawReport.app,
                  appType: inspectedRawReport.appType || undefined,
                  version: inspectedRawReport.version,
                  type: inspectedRawReport.type,
                  build: inspectedRawReport.build || undefined,
                  createdAt: inspectedRawReport.createdAt || undefined,
                  ...(inspectedRawReport.type === 'security'
                    ? { findings: inspectedRawReport.findings }
                    : {
                        tests: inspectedRawReport.tests,
                        failures: inspectedRawReport.failures,
                      }),
                },
                null,
                2
              )}
            </pre>
          </div>
        </div>
      )}

      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <div className="brand-mark-inner">RC</div>
            </div>
            <div className="brand-title-row">
              <h1 className="brand-title">Release Control Center</h1>
            </div>
          </div>

          <nav className="nav-links" aria-label="Primary navigation">
            <button
              type="button"
              className={`nav-link ${activeScreen === 'applications' ? 'active' : ''}`}
              aria-pressed={activeScreen === 'applications'}
              onClick={() => setActiveScreen('applications')}
            >
              Dashboard
              <span className={`tab-count ${kpis.blockedReleases > 0 ? 'danger' : ''}`}>
                {applications.length}
              </span>
            </button>
            <button
              type="button"
              className={`nav-link ${activeScreen === 'tasks' ? 'active' : ''}`}
              aria-pressed={activeScreen === 'tasks'}
              onClick={() => setActiveScreen('tasks')}
            >
              Tasks Board
              <span className="tab-count">{kpis.openTasks}</span>
            </button>
            <button
              type="button"
              className={`nav-link ${activeScreen === 'insights' ? 'active' : ''}`}
              aria-pressed={activeScreen === 'insights'}
              onClick={() => setActiveScreen('insights')}
            >
              CI/CD Insights &amp; Policy
              {customPolicyActive && <span className="tab-count">Custom</span>}
            </button>
            <button
              type="button"
              className={`nav-link ${activeScreen === 'reports' ? 'active' : ''}`}
              aria-pressed={activeScreen === 'reports'}
              onClick={() => setActiveScreen('reports')}
            >
              Reports &amp; Audit
              <span className="tab-count">{normalizedInventory.length}</span>
            </button>
          </nav>

          <div className="topbar-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.xlsx,.csv,.tsv,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              multiple
              className="sr-only"
              aria-label="Upload JSON, Excel, or CSV report files"
              onChange={handleFilesSelected}
            />
            <button
              type="button"
              className="btn btn-cta"
              onClick={handleUploadClick}
            >
              + Add Report Files
            </button>
            {uploadedReports.length > 0 && (
              <button
                type="button"
                className="btn"
                onClick={handleClearUploaded}
                title="Remove uploaded reports from browser storage"
              >
                Clear ({uploadedReports.length})
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? (
                <>
                  <IconSun />
                  Light
                </>
              ) : (
                <>
                  <IconMoon />
                  Dark
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="main-content">
        {/* SCREEN 1: DASHBOARD / APPLICATIONS */}
        {activeScreen === 'applications' && (
          <>
            {/* Top Search & Pill Filter Bar (like screenshot) */}
            <section className="command-filter-bar" aria-label="Search and filter applications">
              <div className="command-search">
                <IconSearch className="icon search-icon" />
                <label htmlFor="app-search-input" className="sr-only">
                  Search applications, versions, or findings
                </label>
                <input
                  id="app-search-input"
                  type="search"
                  className="command-search-input"
                  placeholder="Search apps, versions, vulnerabilities..."
                  value={appSearch}
                  onChange={(e) => setAppSearch(e.target.value)}
                />
              </div>

              <div className="command-filter-groups">
                <div className="pill-group" role="group" aria-label="Filter by release status">
                  <span className="pill-group-label">Status:</span>
                  {STATUS_FILTERS.map((st) => (
                    <button
                      key={st}
                      type="button"
                      className={`seg-pill ${statusFilter === st ? 'active' : ''}`}
                      onClick={() => setStatusFilter(st)}
                    >
                      {st !== 'All' && (
                        <span
                          className={`dot ${
                            st === 'Blocked'
                              ? 'blocked'
                              : st === 'Needs review'
                                ? 'review'
                                : 'ready'
                          }`}
                        />
                      )}
                      {st}
                    </button>
                  ))}
                </div>

                <div className="pill-group" role="group" aria-label="Filter by application type">
                  <span className="pill-group-label">Type:</span>
                  {appTypes.map((tp) => (
                    <button
                      key={tp}
                      type="button"
                      className={`seg-pill ${typeFilter === tp ? 'active' : ''}`}
                      onClick={() => setTypeFilter(tp)}
                    >
                      {tp}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  className="toggle-switch-btn"
                  aria-pressed={blockersOnly}
                  onClick={() => setBlockersOnly((prev) => !prev)}
                >
                  <span>Blockers only</span>
                  <span className={`switch-track ${blockersOnly ? 'on' : ''}`}>
                    <span className="switch-thumb" />
                  </span>
                </button>

                <div className="pill-group" role="group" aria-label="Layout mode">
                  {[
                    { id: 'both', label: 'All' },
                    { id: 'cards', label: 'Cards' },
                    { id: 'table', label: 'Table' },
                  ].map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      className={`seg-pill ${viewMode === mode.id ? 'active' : ''}`}
                      onClick={() => setViewMode(mode.id)}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>

                <select
                  aria-label="Sort applications"
                  className="filter-select"
                  value={`${sortBy}:${sortDir}`}
                  onChange={(e) => {
                    const [col, dir] = e.target.value.split(':');
                    setSortBy(col);
                    setSortDir(dir);
                  }}
                >
                  <option value="priority:asc">↑↓ Sort: Priority</option>
                  <option value="score:desc">↑↓ Sort: Highest Risk</option>
                  <option value="passRate:asc">↑↓ Sort: Lowest Pass Rate</option>
                  <option value="updated:desc">↑↓ Sort: Last Updated</option>
                  <option value="name:asc">↑↓ Sort: Name A–Z</option>
                </select>
              </div>
            </section>

            {/* Slim data source & quick actions notice */}
            <div
              className={`status-banner ${uploadNotice?.type === 'error' ? 'error' : ''}`}
              role="status"
              aria-live="polite"
            >
              <div className="status-banner-left">
                <span
                  className={`chip ${dbStatus.connected ? 'low' : 'neutral'}`}
                  title={
                    dbStatus.connected
                      ? `Connected to ${dbStatus.engine || 'SQLite'} (${dbStatus.dbPath || ''})`
                      : 'Backend offline — using local browser storage'
                  }
                >
                  <span className={`dot ${dbStatus.connected ? 'ready' : 'review'}`} />
                  {dbStatus.checking
                    ? 'Connecting DB...'
                    : dbStatus.connected
                      ? 'SQLite Connected'
                      : 'Local Cache'}
                </span>
                <span className="source-pill">
                  {usingSampleData
                    ? 'Sample data'
                    : allBundledReports.length > 0 && uploadedReports.length > 0
                      ? 'src/reports + DB'
                      : uploadedReports.length > 0
                        ? 'SQLite DB'
                        : 'src/reports/*'}
                </span>
                <span>
                  {uploadNotice
                    ? uploadNotice.message
                    : usingSampleData
                      ? 'No files in src/reports/ — showing 7 sample apps (2 versions each). Drop .json, .xlsx, or .csv files anywhere.'
                      : `Analyzing ${activeRawReports.length} report(s) across ${applications.length} app(s).`}
                  {customPolicyActive && ' · Custom policy thresholds active'}
                </span>
              </div>
              <div className="status-banner-actions">
                {dbStatus.connected && uploadedReports.length === 0 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={handleSeedDatabase}
                    title="Insert the 7 sample applications into the SQLite database"
                  >
                    + Seed 7 Apps to DB
                  </button>
                )}
                {!usingSampleData && (
                  <button
                    type="button"
                    className={`btn btn-sm ${includeSampleApps ? 'btn-primary' : ''}`}
                    onClick={() => setIncludeSampleApps((prev) => !prev)}
                  >
                    {includeSampleApps ? 'Showing 7 sample apps ✓' : '+ Include 7 sample apps'}
                  </button>
                )}
                {missingSuggestedTasksCount > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => handleAutoAssignBulk(applications)}
                  >
                    Auto-assign suggested ({missingSuggestedTasksCount})
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleCopyMarkdownBrief}
                >
                  <IconCopy />
                  Copy Brief
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleDownloadSampleTemplate}
                >
                  <IconDownload />
                  Sample JSON
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleDownloadSampleExcel}
                >
                  <IconDownload />
                  Sample Excel
                </button>
                {uploadNotice && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setUploadNotice(null)}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>

            {/* 6-Card Executive KPI Strip (like screenshot) */}
            <section className="kpi-grid-6" aria-label="Release overview metrics">
              <button
                type="button"
                className="kpi-card kpi-cyan interactive"
                onClick={resetAppFilters}
                title="Show all applications"
              >
                <span className="kpi-label">Active Apps</span>
                <span className="kpi-value cyan">{kpis.totalApps}</span>
                <span className="kpi-sub">
                  {applications.filter((a) => a.versionCount > 1).length} with history
                </span>
              </button>

              <button
                type="button"
                className={`kpi-card kpi-rose interactive ${blockersOnly || statusFilter === 'Blocked' ? 'active-filter' : ''}`}
                onClick={() => setBlockersOnly((prev) => !prev)}
                title="Filter to blocked releases"
              >
                <span className="kpi-label">Blocked Releases</span>
                <span className={`kpi-value ${kpis.blockedReleases > 0 ? 'rose' : 'emerald'}`}>
                  {kpis.blockedReleases}
                </span>
                <span className={`kpi-sub ${kpis.blockedReleases > 0 ? 'danger' : 'success'}`}>
                  {kpis.blockedReleases > 0 ? 'P1 Critical gate fail' : 'All gates clear'}
                </span>
              </button>

              <article className="kpi-card kpi-orange">
                <span className="kpi-label">Critical Vulns</span>
                <span className={`kpi-value ${kpis.criticalVulnerabilities > 0 ? 'orange' : 'emerald'}`}>
                  {kpis.criticalVulnerabilities}
                </span>
                <span className={`kpi-sub ${kpis.criticalVulnerabilities > 0 ? 'danger' : 'success'}`}>
                  {fleetAnalytics.severityTotals.high} high · {fleetAnalytics.severityTotals.medium} med
                </span>
              </article>

              <article className="kpi-card kpi-violet">
                <span className="kpi-label">Test Pass Rate</span>
                <span className="kpi-value violet">{fleetAnalytics.fleetPassRate}%</span>
                <span className={`kpi-sub ${kpis.failedTests > 0 ? 'warning' : 'success'}`}>
                  {kpis.failedTests} failed of {kpis.totalTests}
                </span>
              </article>

              <article className="kpi-card kpi-emerald">
                <span className="kpi-label">Fleet Readiness</span>
                <span className="kpi-value emerald">{fleetAnalytics.readinessIndex}%</span>
                <span className="kpi-sub">
                  {kpis.needsReviewReleases} need review · {kpis.readyReleases} ready
                </span>
              </article>

              <button
                type="button"
                className="kpi-card kpi-amber interactive"
                onClick={() => setActiveScreen('tasks')}
                title="Open Tasks Board"
              >
                <span className="kpi-label">Open Tasks</span>
                <span className="kpi-value amber">{kpis.openTasks}</span>
                <span className="kpi-sub">
                  {taskStats.testingOpen} Testing · {taskStats.deploymentOpen} Deploy
                </span>
              </button>
            </section>

            {/* Main Workspace + Optional Right Inspector Drawer */}
            <section
              className={`workspace-split ${selectedApp ? 'has-selection' : ''}`}
              aria-label="Applications command center"
            >
              <div className="workspace-main">
                {filteredApplications.length === 0 ? (
                  <div className="empty-state">
                    <p className="empty-state-title">
                      {applications.length === 0
                        ? 'No application reports loaded'
                        : 'No applications match your filters'}
                    </p>
                    <p>
                      {applications.length === 0
                        ? 'Click + Add Report Files or drop JSON reports anywhere on this page.'
                        : 'Try clearing the search query or changing the status/type filters.'}
                    </p>
                    {hasAppFilters && (
                      <button
                        type="button"
                        className="btn btn-sm btn-cta"
                        onClick={resetAppFilters}
                        style={{ marginTop: '8px' }}
                      >
                        Reset filters
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    {/* 3-Column Bento Command Cards Grid */}
                    {(viewMode === 'both' || viewMode === 'cards') && (
                      <>
                        <div className="bento-grid">
                          {filteredApplications.map((app) => {
                            const isSelected = selectedApp?.app === app.app;
                            const trend = formatTrend(app.trend);
                            const openForApp = openTaskCountsByApp.get(app.app) || 0;
                            const sel = app.reportsByType.selenium;
                            const e2e = app.reportsByType.e2e;
                            const prevScore = app.previousScore ?? app.riskScore;
                            const prevVuln = app.versions[1]?.vulnWeight ?? app.vulnWeight;
                            const prevTest = app.versions[1]?.testPenalty ?? app.testPenalty;
                            const sparkValues = [
                              prevScore,
                              Math.round(prevVuln + prevTest * 0.6),
                              Math.round((prevScore + app.riskScore) / 2),
                              Math.round(app.vulnWeight * 1.1),
                              Math.round(app.vulnWeight + app.testPenalty * 0.7),
                              app.riskScore,
                            ];

                            return (
                              <article
                                key={app.app}
                                tabIndex={0}
                                role="button"
                                aria-pressed={isSelected}
                                className={`app-bento-card tone-${app.priority.tone} ${isSelected ? 'selected' : ''}`}
                                onClick={() =>
                                  setSelectedAppName((prev) =>
                                    prev === app.app ? null : app.app
                                  )
                                }
                                onKeyDown={(e) => handleRowKeyDown(e, app.app)}
                              >
                                <div className="bento-card-header">
                                  <div>
                                    <h2 className="bento-title">{app.app}</h2>
                                    <p className="bento-subtitle">
                                      {app.appType} · v{app.latestVersion}
                                      {app.builds[0] ? ` · ${app.builds[0]}` : ''}
                                    </p>
                                  </div>
                                  <span className={`chip ${statusTone(app.releaseStatus)}`}>
                                    <span
                                      className={`dot ${
                                        app.releaseStatus === 'Blocked'
                                          ? 'blocked'
                                          : app.releaseStatus === 'Needs review'
                                            ? 'review'
                                            : 'ready'
                                      }`}
                                    />
                                    {app.releaseStatus}
                                  </span>
                                </div>

                                <div className="mini-tiles-grid">
                                  <div className="mini-tile">
                                    <span className="mini-tile-label">Risk Score</span>
                                    <span className={`mini-tile-value ${app.priority.tone}`}>
                                      {app.riskScore}/100
                                    </span>
                                  </div>
                                  <div className="mini-tile">
                                    <span className="mini-tile-label">Priority</span>
                                    <span className={`mini-tile-value ${app.priority.tone}`}>
                                      {app.priority.shortLabel}
                                    </span>
                                  </div>
                                  <div className="mini-tile tile-rose">
                                    <span className="mini-tile-label">Crit / High</span>
                                    <span className="mini-tile-value">
                                      {app.vulnCounts.critical}C · {app.vulnCounts.high}H
                                    </span>
                                  </div>
                                  <div className="mini-tile tile-cyan">
                                    <span className="mini-tile-label">Selenium UI</span>
                                    <span className="mini-tile-value cyan">
                                      {sel ? `${sel.tests.passed}/${sel.tests.total}` : '—'}
                                    </span>
                                  </div>
                                  <div className="mini-tile tile-violet">
                                    <span className="mini-tile-label">E2E Tests</span>
                                    <span className="mini-tile-value violet">
                                      {e2e ? `${e2e.tests.passed}/${e2e.tests.total}` : '—'}
                                    </span>
                                  </div>
                                  <div className="mini-tile">
                                    <span className="mini-tile-label">Last Sync</span>
                                    <span className="mini-tile-value" style={{ fontSize: '12px' }}>
                                      {formatDateTime(app.lastUpdated)}
                                    </span>
                                  </div>
                                </div>

                                <div className="sparkline-box">
                                  <div className="sparkline-header">
                                    <span>
                                      Risk Trend (
                                      {app.previousVersion
                                        ? `v${app.previousVersion} → v${app.latestVersion}`
                                        : 'Initial'}
                                      )
                                    </span>
                                    <span className={`trend-badge ${app.trend.direction}`}>
                                      {trend.arrow} {trend.text}
                                    </span>
                                  </div>
                                  <SparklineChart
                                    id={app.app}
                                    values={sparkValues}
                                    tone={app.priority.tone}
                                  />
                                </div>

                                <div className="bento-footer">
                                  <div className="bento-footer-pills">
                                    <span
                                      className={`badge-outline ${
                                        app.vulnCounts.critical > 0 ? 'bad' : 'good'
                                      }`}
                                    >
                                      Security {app.vulnCounts.total}
                                    </span>
                                    <span className="badge-outline cyan">
                                      Pass {app.passRate}%
                                    </span>
                                    {openForApp > 0 && (
                                      <span className="badge-outline violet">
                                        {openForApp} {openForApp === 1 ? 'task' : 'tasks'}
                                      </span>
                                    )}
                                  </div>
                                  <span className="app-sub" style={{ fontWeight: 600 }}>
                                    Inspect →
                                  </span>
                                </div>
                              </article>
                            );
                          })}
                        </div>

                        {/* Bottom Bento Row: 1-col Team Dispatch + 2-col CI/CD Pipeline */}
                        {pipelineFocusApp && (
                          <div className="bento-bottom-row">
                            {/* Left 1-col Card: Team Dispatch & Tasks */}
                            <article className="app-bento-card tone-violet" style={{ cursor: 'default' }}>
                              <div className="bento-card-header">
                                <div>
                                  <h2 className="bento-title">Team Dispatch &amp; Tasks</h2>
                                  <p className="bento-subtitle">
                                    Testing &amp; Deployment Queue
                                  </p>
                                </div>
                                <span className="badge-outline violet">
                                  {taskStats.openCount} Open
                                </span>
                              </div>

                              <div className="mini-tiles-grid">
                                <div className="mini-tile tile-violet">
                                  <span className="mini-tile-label">Open Tasks</span>
                                  <span className="mini-tile-value violet">{taskStats.openCount}</span>
                                </div>
                                <div className="mini-tile tile-cyan">
                                  <span className="mini-tile-label">Testing</span>
                                  <span className="mini-tile-value cyan">{taskStats.testingOpen}</span>
                                </div>
                                <div className="mini-tile tile-amber">
                                  <span className="mini-tile-label">Deploy</span>
                                  <span className="mini-tile-value amber">{taskStats.deploymentOpen}</span>
                                </div>
                                <div className="mini-tile tile-rose">
                                  <span className="mini-tile-label">P1 Urgent</span>
                                  <span
                                    className={`mini-tile-value ${
                                      taskStats.p1Open > 0 ? 'critical' : ''
                                    }`}
                                  >
                                    {taskStats.p1Open}
                                  </span>
                                </div>
                                <div className="mini-tile tile-emerald">
                                  <span className="mini-tile-label">Done</span>
                                  <span className="mini-tile-value low">{taskStats.doneCount}</span>
                                </div>
                                <div className="mini-tile">
                                  <span className="mini-tile-label">Completion</span>
                                  <span className="mini-tile-value">{taskStats.pctDone}%</span>
                                </div>
                              </div>

                              <div className="sparkline-box">
                                <div className="sparkline-header">
                                  <span>Fleet Risk Across Apps</span>
                                  <span className="mono">{fleetAnalytics.avgRiskScore} avg</span>
                                </div>
                                <SparklineChart
                                  id="fleet-dispatch"
                                  values={
                                    applications.length === 1
                                      ? [
                                          applications[0].previousScore ?? applications[0].riskScore,
                                          applications[0].riskScore,
                                        ]
                                      : applications.map((a) => a.riskScore)
                                  }
                                  tone="violet"
                                />
                              </div>

                              <div className="bento-footer">
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  onClick={() => setActiveScreen('tasks')}
                                >
                                  Open Tasks Board →
                                </button>
                                {missingSuggestedTasksCount > 0 && (
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-cta"
                                    onClick={() => handleAutoAssignBulk(applications)}
                                  >
                                    Auto-assign ({missingSuggestedTasksCount})
                                  </button>
                                )}
                              </div>
                            </article>

                            {/* Right 2-col Card: CI/CD Pipeline & Gate Readiness */}
                            <article className="app-bento-card tone-cyan" style={{ cursor: 'default' }}>
                              <div className="bento-card-header">
                                <div>
                                  <h2 className="bento-title">
                                    CI/CD Pipeline · {pipelineFocusApp.app}{' '}
                                    <span className="mono">v{pipelineFocusApp.latestVersion}</span>
                                  </h2>
                                  <p className="bento-subtitle">
                                    Vulnerability scan · Selenium UI validation · End-to-End release gate
                                  </p>
                                </div>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                  <span className={`chip ${statusTone(pipelineFocusApp.releaseStatus)}`}>
                                    <span
                                      className={`dot ${
                                        pipelineFocusApp.releaseStatus === 'Blocked'
                                          ? 'blocked'
                                          : pipelineFocusApp.releaseStatus === 'Needs review'
                                            ? 'review'
                                            : 'ready'
                                      }`}
                                    />
                                    {pipelineFocusApp.releaseStatus}
                                  </span>
                                  <span className="chip neutral">
                                    Pass {pipelineFocusApp.passRate}%
                                  </span>
                                </div>
                              </div>

                              <div className="pipeline-stages">
                                {/* Stage 1: Security Scan */}
                                {(() => {
                                  const sec = pipelineFocusApp.reportsByType.security;
                                  const hasCrit = pipelineFocusApp.vulnCounts.critical > 0;
                                  const cls = !sec ? 'warn' : hasCrit ? 'fail' : 'pass';
                                  return (
                                    <div className="pipeline-stage-box">
                                      <div className="stage-top">
                                        <span className="stage-name">1. Security Scan</span>
                                        <span className={`chip ${hasCrit ? 'critical' : sec ? 'low' : 'neutral'}`}>
                                          {!sec
                                            ? 'Missing'
                                            : hasCrit
                                              ? `${pipelineFocusApp.vulnCounts.critical} Crit`
                                              : 'OK'}
                                        </span>
                                      </div>
                                      <div className="stage-bar-track">
                                        <div
                                          className={`stage-bar-fill ${cls}`}
                                          style={{ width: sec ? '100%' : '20%' }}
                                        />
                                      </div>
                                      <span className="app-sub">
                                        {sec
                                          ? `${pipelineFocusApp.vulnCounts.total} findings (${pipelineFocusApp.builds[0] || 'build'})`
                                          : 'No security report uploaded'}
                                      </span>
                                    </div>
                                  );
                                })()}

                                {/* Stage 2: Selenium UI */}
                                {(() => {
                                  const sel = pipelineFocusApp.reportsByType.selenium;
                                  const pct = sel && sel.tests.total > 0
                                    ? Math.round((sel.tests.passed / sel.tests.total) * 100)
                                    : 0;
                                  const cls = !sel ? 'warn' : sel.tests.failed > 0 ? 'fail' : 'pass';
                                  return (
                                    <div className="pipeline-stage-box">
                                      <div className="stage-top">
                                        <span className="stage-name">2. Selenium UI</span>
                                        <span className={`chip ${!sel ? 'neutral' : sel.tests.failed > 0 ? 'high' : 'low'}`}>
                                          {!sel ? 'Missing' : `${pct}% pass`}
                                        </span>
                                      </div>
                                      <div className="stage-bar-track">
                                        <div
                                          className={`stage-bar-fill ${cls}`}
                                          style={{ width: `${sel ? pct : 20}%` }}
                                        />
                                      </div>
                                      <span className="app-sub">
                                        {sel
                                          ? `${sel.tests.passed}/${sel.tests.total} passed · ${sel.tests.failed} failed`
                                          : 'No Selenium report'}
                                      </span>
                                    </div>
                                  );
                                })()}

                                {/* Stage 3: End-to-End */}
                                {(() => {
                                  const e2e = pipelineFocusApp.reportsByType.e2e;
                                  const pct = e2e && e2e.tests.total > 0
                                    ? Math.round((e2e.tests.passed / e2e.tests.total) * 100)
                                    : 0;
                                  const cls = !e2e ? 'warn' : e2e.tests.failed > 0 ? 'fail' : 'pass';
                                  return (
                                    <div className="pipeline-stage-box active-stage">
                                      <div className="stage-top">
                                        <span className="stage-name">3. End-to-End</span>
                                        <span className={`chip ${!e2e ? 'neutral' : e2e.tests.failed > 0 ? 'critical' : 'low'}`}>
                                          {!e2e ? 'Missing' : `${pct}% pass`}
                                        </span>
                                      </div>
                                      <div className="stage-bar-track">
                                        <div
                                          className={`stage-bar-fill ${cls}`}
                                          style={{ width: `${e2e ? pct : 20}%` }}
                                        />
                                      </div>
                                      <span className="app-sub">
                                        {e2e
                                          ? `${e2e.tests.passed}/${e2e.tests.total} passed · ${e2e.tests.failed} failed`
                                          : 'No E2E report'}
                                      </span>
                                    </div>
                                  );
                                })()}
                              </div>

                              <div className="pipeline-parallel-grid">
                                {(() => {
                                  const passedGates = pipelineFocusApp.gates.filter(
                                    (g) => g.status === 'pass'
                                  ).length;
                                  const gatePct = Math.round(
                                    (passedGates / pipelineFocusApp.gates.length) * 100
                                  );
                                  return (
                                    <div className="pipeline-stage-box">
                                      <div className="stage-top">
                                        <span className="stage-name">Release Gate Checklist</span>
                                        <span className={`chip ${passedGates === pipelineFocusApp.gates.length ? 'low' : 'high'}`}>
                                          {passedGates}/{pipelineFocusApp.gates.length} pass
                                        </span>
                                      </div>
                                      <div className="stage-bar-track">
                                        <div
                                          className={`stage-bar-fill ${
                                            passedGates === pipelineFocusApp.gates.length ? 'pass' : 'warn'
                                          }`}
                                          style={{ width: `${gatePct}%` }}
                                        />
                                      </div>
                                      <span className="app-sub">
                                        Risk score {pipelineFocusApp.riskScore}/100 ·{' '}
                                        {pipelineFocusApp.priority.label}
                                      </span>
                                    </div>
                                  );
                                })()}

                                <div className="pipeline-stage-box">
                                  <div className="stage-top">
                                    <span className="stage-name">Version Delta &amp; Actions</span>
                                    <button
                                      type="button"
                                      className="btn btn-xs btn-primary"
                                      onClick={() => setSelectedAppName(pipelineFocusApp.app)}
                                    >
                                      Inspect &amp; Assign
                                    </button>
                                  </div>
                                  <span className="app-sub">
                                    {pipelineFocusApp.versionDiff
                                      ? `+${pipelineFocusApp.versionDiff.newFindings.length} new vulns · +${pipelineFocusApp.versionDiff.newFailures.length} test regressions vs v${pipelineFocusApp.previousVersion}`
                                      : 'Initial tracked version'}
                                  </span>
                                </div>
                              </div>
                            </article>
                          </div>
                        )}
                      </>
                    )}

                    {/* Sortable Applications Matrix Table */}
                    {(viewMode === 'both' || viewMode === 'table') && (
                      <div className="card">
                        <div className="card-header">
                          <div>
                            <h2 className="card-title">
                              Applications Release Matrix ({filteredApplications.length})
                            </h2>
                            <span className="card-meta">
                              Sorted by priority &amp; score. Select any row to inspect reports &amp; assign tasks.
                            </span>
                          </div>
                        </div>

                        {selectedRowNames.length > 0 && (
                          <div className="batch-bar">
                            <strong>{selectedRowNames.length} application(s) selected</strong>
                            <div className="batch-actions">
                              <button
                                type="button"
                                className="btn btn-xs btn-primary"
                                onClick={() =>
                                  handleAutoAssignBulk(
                                    applications.filter((a) => selectedRowNames.includes(a.app))
                                  )
                                }
                              >
                                Assign suggested tasks
                              </button>
                              <button
                                type="button"
                                className="btn btn-xs"
                                onClick={() => setSelectedRowNames([])}
                              >
                                Clear selection
                              </button>
                            </div>
                          </div>
                        )}

                        <div className="table-scroll">
                          <table className="apps-table">
                            <thead>
                              <tr>
                                <th scope="col" className="checkbox-cell">
                                  <input
                                    type="checkbox"
                                    aria-label="Select all visible applications"
                                    checked={
                                      filteredApplications.length > 0 &&
                                      filteredApplications.every((a) =>
                                        selectedRowNames.includes(a.app)
                                      )
                                    }
                                    onChange={toggleSelectAllFiltered}
                                  />
                                </th>
                                <th scope="col">
                                  <button
                                    type="button"
                                    className={`sort-btn ${sortBy === 'name' ? 'active' : ''}`}
                                    onClick={() => handleSortClick('name')}
                                  >
                                    Application {sortBy === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                                  </button>
                                </th>
                                <th scope="col">Type</th>
                                <th scope="col">Version</th>
                                <th scope="col">Security (C/H/M/L)</th>
                                <th scope="col">
                                  <button
                                    type="button"
                                    className={`sort-btn ${sortBy === 'passRate' ? 'active' : ''}`}
                                    onClick={() => handleSortClick('passRate')}
                                  >
                                    Tests {sortBy === 'passRate' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                                  </button>
                                </th>
                                <th scope="col">
                                  <button
                                    type="button"
                                    className={`sort-btn ${sortBy === 'score' ? 'active' : ''}`}
                                    onClick={() => handleSortClick('score')}
                                  >
                                    Risk {sortBy === 'score' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                                  </button>
                                </th>
                                <th scope="col">
                                  <button
                                    type="button"
                                    className={`sort-btn ${sortBy === 'priority' ? 'active' : ''}`}
                                    onClick={() => handleSortClick('priority')}
                                  >
                                    Priority {sortBy === 'priority' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                                  </button>
                                </th>
                                <th scope="col">Status</th>
                                <th scope="col">Trend</th>
                                <th scope="col">
                                  <button
                                    type="button"
                                    className={`sort-btn ${sortBy === 'updated' ? 'active' : ''}`}
                                    onClick={() => handleSortClick('updated')}
                                  >
                                    Updated {sortBy === 'updated' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                                  </button>
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredApplications.map((app) => {
                                const isSelected = selectedApp?.app === app.app;
                                const trend = formatTrend(app.trend);
                                const openForApp = openTaskCountsByApp.get(app.app) || 0;
                                const signOff = signOffs[`${app.app}::${app.latestVersion}`];

                                return (
                                  <tr
                                    key={app.app}
                                    tabIndex={0}
                                    aria-selected={isSelected}
                                    className={isSelected ? 'selected' : ''}
                                    onClick={() =>
                                      setSelectedAppName((prev) =>
                                        prev === app.app ? null : app.app
                                      )
                                    }
                                    onKeyDown={(e) => handleRowKeyDown(e, app.app)}
                                  >
                                    <td
                                      className="checkbox-cell"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <input
                                        type="checkbox"
                                        aria-label={`Select ${app.app}`}
                                        checked={selectedRowNames.includes(app.app)}
                                        onChange={() => toggleRowSelection(app.app)}
                                      />
                                    </td>
                                    <td>
                                      <div className="app-name-cell">
                                        <div className="app-name-row">
                                          <span className="app-name">{app.app}</span>
                                          {openForApp > 0 && (
                                            <span className="task-mini-pill">
                                              {openForApp} {openForApp === 1 ? 'task' : 'tasks'}
                                            </span>
                                          )}
                                          {signOff && (
                                            <span
                                              className={`signoff-mini-pill ${
                                                signOff.decision === 'Approved' ? 'approved' : 'held'
                                              }`}
                                            >
                                              {signOff.decision}
                                            </span>
                                          )}
                                        </div>
                                        <span className="app-sub">
                                          {app.builds.length > 0
                                            ? `Build ${app.builds.join(', ')}`
                                            : `${app.reportsCount} report type(s)`}
                                        </span>
                                      </div>
                                    </td>
                                    <td>
                                      <span className="type-badge">{app.appType}</span>
                                    </td>
                                    <td className="mono">v{app.latestVersion}</td>
                                    <td>
                                      <div className="sev-mini-strip" title="Critical / High / Medium / Low">
                                        <span className={`sev-dot ${app.vulnCounts.critical > 0 ? 'critical' : ''}`}>
                                          {app.vulnCounts.critical}
                                        </span>
                                        <span className={`sev-dot ${app.vulnCounts.high > 0 ? 'high' : ''}`}>
                                          {app.vulnCounts.high}
                                        </span>
                                        <span className={`sev-dot ${app.vulnCounts.medium > 0 ? 'medium' : ''}`}>
                                          {app.vulnCounts.medium}
                                        </span>
                                        <span className={`sev-dot ${app.vulnCounts.low > 0 ? 'low' : ''}`}>
                                          {app.vulnCounts.low}
                                        </span>
                                      </div>
                                    </td>
                                    <td>
                                      <div className="test-health-cell">
                                        <span className="mono" style={{ fontSize: '12px' }}>
                                          {app.testTotals.total > 0
                                            ? `${app.passRate}% (${app.testTotals.failed} fail)`
                                            : 'No tests'}
                                        </span>
                                        {app.testTotals.total > 0 && (
                                          <div className="pass-bar-track" aria-hidden="true">
                                            <div
                                              className="pass-bar-fill"
                                              style={{ width: `${app.passRate}%` }}
                                            />
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                    <td>
                                      <div className="risk-cell">
                                        <div className="risk-track" aria-hidden="true">
                                          <div
                                            className={`risk-fill ${app.priority.tone}`}
                                            style={{ width: `${app.riskScore}%` }}
                                          />
                                        </div>
                                        <span className="risk-score">{app.riskScore}</span>
                                      </div>
                                    </td>
                                    <td>
                                      <span className={`chip ${app.priority.tone}`}>
                                        {app.priority.label}
                                      </span>
                                    </td>
                                    <td>
                                      <span className={`chip ${statusTone(app.releaseStatus)}`}>
                                        {app.releaseStatus}
                                      </span>
                                    </td>
                                    <td>
                                      <span
                                        className={`trend-badge ${app.trend.direction}`}
                                        title={trend.title}
                                      >
                                        <span aria-hidden="true">{trend.arrow}</span>
                                        <span>{trend.text}</span>
                                      </span>
                                    </td>
                                    <td className="app-sub">{formatDateTime(app.lastUpdated)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Right Side Panel Inspector */}
              {selectedApp && activeVersionEval && (
                <aside
                  className="card detail-panel"
                  aria-label={`${selectedApp.app} details`}
                >
                  <div className="card-header">
                    <div className="detail-top" style={{ width: '100%' }}>
                      <div>
                        <h2 className="detail-title">{selectedApp.app}</h2>
                        <div className="detail-meta">
                          <span className="type-badge">{selectedApp.appType}</span>
                          <span className="mono">v{activeVersionEval.version}</span>
                          <span className={`chip ${activeVersionEval.priority.tone}`}>
                            {activeVersionEval.priority.label}
                          </span>
                          <span
                            className={`chip ${statusTone(activeVersionEval.releaseStatus)}`}
                          >
                            {activeVersionEval.releaseStatus}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setSelectedAppName(null)}
                        aria-label="Close application details"
                      >
                        <IconClose />
                      </button>
                    </div>
                  </div>

                  <div className="detail-scroll">
                    {selectedApp.versions.length > 1 && (
                      <div className="section-block">
                        <h3 className="section-heading">Version history</h3>
                        <div className="version-switcher" role="group" aria-label="Select version">
                          {selectedApp.versions.map((ver) => (
                            <button
                              key={ver.version}
                              type="button"
                              className={`version-pill ${
                                activeVersionEval.version === ver.version ? 'active' : ''
                              }`}
                              aria-pressed={activeVersionEval.version === ver.version}
                              onClick={() => setInspectedVersion(ver.version)}
                            >
                              v{ver.version}
                              {ver.isLatest ? ' (Latest)' : ver.isPrevious ? ' (Prev)' : ''}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="score-breakdown-box">
                      <div className="score-breakdown-top">
                        <strong>Risk score: {activeVersionEval.riskScore}/100</strong>
                        {activeVersionEval.isLatest && selectedApp.trend.previousVersion && (
                          <span className={`trend-badge ${selectedApp.trend.direction}`}>
                            vs v{selectedApp.trend.previousVersion}: {selectedApp.trend.label}
                          </span>
                        )}
                      </div>
                      <div className="risk-track" aria-hidden="true">
                        <div
                          className={`risk-fill ${activeVersionEval.priority.tone}`}
                          style={{ width: `${activeVersionEval.riskScore}%` }}
                        />
                      </div>
                      <div className="score-formula">
                        <span>
                          Security weight: <strong>+{activeVersionEval.vulnWeight}</strong>
                        </span>
                        <span>·</span>
                        <span>
                          Test failure penalty ({activeVersionEval.failureRate}% ×{' '}
                          {policy.testPenaltyScale}):{' '}
                          <strong>+{activeVersionEval.testPenalty}</strong>
                        </span>
                      </div>
                    </div>

                    {activeVersionEval.isLatest && (() => {
                      const signOffKey = `${selectedApp.app}::${selectedApp.latestVersion}`;
                      const currentSignOff = signOffs[signOffKey];
                      return (
                        <div className="signoff-box">
                          <div className="section-header-row">
                            <span className="section-heading">Manager decision</span>
                            {currentSignOff && (
                              <span
                                className={`signoff-mini-pill ${
                                  currentSignOff.decision === 'Approved' ? 'approved' : 'held'
                                }`}
                              >
                                {currentSignOff.decision} · {formatDateTime(currentSignOff.updatedAt)}
                              </span>
                            )}
                          </div>
                          <div className="signoff-actions">
                            <button
                              type="button"
                              className="btn btn-sm btn-success"
                              onClick={() =>
                                setReleaseSignOff(
                                  selectedApp.app,
                                  selectedApp.latestVersion,
                                  'Approved'
                                )
                              }
                            >
                              Approve rollout
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() =>
                                setReleaseSignOff(
                                  selectedApp.app,
                                  selectedApp.latestVersion,
                                  'Held'
                                )
                              }
                            >
                              Place manual hold
                            </button>
                            {currentSignOff && (
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() =>
                                  setReleaseSignOff(
                                    selectedApp.app,
                                    selectedApp.latestVersion,
                                    null
                                  )
                                }
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    <div className="section-block">
                      <h3 className="section-heading">Release gates</h3>
                      <ul className="gate-list">
                        {activeVersionEval.gates.map((gate) => (
                          <li key={gate.id} className="gate-item">
                            <span className="gate-left">
                              <span className={`gate-dot ${gate.status}`} aria-hidden="true" />
                              {gate.label}
                            </span>
                            <span className="app-sub">{gate.detail}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {activeVersionEval.isLatest && selectedApp.versionDiff && (
                      <div className="section-block">
                        <h3 className="section-heading">
                          Changes vs v{selectedApp.previousVersion}
                        </h3>
                        <div className="diff-grid">
                          <div
                            className={`diff-card ${
                              selectedApp.versionDiff.newFindings.length +
                                selectedApp.versionDiff.newFailures.length >
                              0
                                ? 'bad'
                                : ''
                            }`}
                          >
                            <strong style={{ fontSize: '12px' }}>New regressions</strong>
                            <span style={{ fontSize: '12px' }}>
                              +{selectedApp.versionDiff.newFindings.length} vulns · +
                              {selectedApp.versionDiff.newFailures.length} failed tests
                            </span>
                          </div>
                          <div
                            className={`diff-card ${
                              selectedApp.versionDiff.resolvedFindings.length +
                                selectedApp.versionDiff.resolvedFailures.length >
                              0
                                ? 'good'
                                : ''
                            }`}
                          >
                            <strong style={{ fontSize: '12px' }}>Resolved</strong>
                            <span style={{ fontSize: '12px' }}>
                              -{selectedApp.versionDiff.resolvedFindings.length} vulns · -
                              {selectedApp.versionDiff.resolvedFailures.length} fixed tests
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="section-block">
                      <h3 className="section-heading">Reports received</h3>
                      <div className="report-summary-grid">
                        <div className="report-mini-card">
                          <span className="report-mini-title">Security</span>
                          {activeVersionEval.reportsByType.security ? (
                            <>
                              <span className="report-mini-stat">
                                {activeVersionEval.vulnCounts.total} findings
                              </span>
                              <span className="report-mini-sub">
                                C:{activeVersionEval.vulnCounts.critical} · H:
                                {activeVersionEval.vulnCounts.high} · M:
                                {activeVersionEval.vulnCounts.medium} · L:
                                {activeVersionEval.vulnCounts.low}
                              </span>
                            </>
                          ) : (
                            <span className="report-mini-sub">Not received</span>
                          )}
                        </div>

                        <div className="report-mini-card">
                          <span className="report-mini-title">Selenium UI</span>
                          {activeVersionEval.reportsByType.selenium ? (
                            <>
                              <span className="report-mini-stat">
                                {activeVersionEval.reportsByType.selenium.tests.passed}/
                                {activeVersionEval.reportsByType.selenium.tests.total} passed
                              </span>
                              <span className="report-mini-sub">
                                {activeVersionEval.reportsByType.selenium.tests.failed} failed
                              </span>
                            </>
                          ) : (
                            <span className="report-mini-sub">Not received</span>
                          )}
                        </div>

                        <div className="report-mini-card">
                          <span className="report-mini-title">End-to-End</span>
                          {activeVersionEval.reportsByType.e2e ? (
                            <>
                              <span className="report-mini-stat">
                                {activeVersionEval.reportsByType.e2e.tests.passed}/
                                {activeVersionEval.reportsByType.e2e.tests.total} passed
                              </span>
                              <span className="report-mini-sub">
                                {activeVersionEval.reportsByType.e2e.tests.failed} failed
                              </span>
                            </>
                          ) : (
                            <span className="report-mini-sub">Not received</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="section-block">
                      <div className="section-header-row">
                        <h3 className="section-heading">
                          Top problems ({activeVersionEval.findings.length})
                        </h3>
                        {activeVersionEval.findings.length > 0 && (
                          <select
                            aria-label="Filter vulnerabilities by severity"
                            className="owner-select"
                            value={panelIssueFilter}
                            onChange={(e) => setPanelIssueFilter(e.target.value)}
                          >
                            <option value="all">All severities</option>
                            <option value="critical">Critical</option>
                            <option value="high">High</option>
                            <option value="medium">Medium</option>
                            <option value="low">Low</option>
                          </select>
                        )}
                      </div>
                      {activeVersionEval.findings.length === 0 ? (
                        <div className="empty-state">
                          No vulnerabilities reported in v{activeVersionEval.version}.
                        </div>
                      ) : (
                        <ul className="issue-list">
                          {activeVersionEval.findings
                            .filter(
                              (f) => panelIssueFilter === 'all' || f.severity === panelIssueFilter
                            )
                            .map((finding, idx) => (
                              <li key={`${finding.title}-${idx}`} className="issue-item">
                                <div className="issue-item-header">
                                  <span className="issue-title">{finding.title}</span>
                                  <div className="issue-item-actions">
                                    <span
                                      className={`chip ${
                                        finding.severity === 'critical'
                                          ? 'critical'
                                          : finding.severity === 'high'
                                            ? 'high'
                                            : finding.severity === 'medium'
                                              ? 'medium'
                                              : 'low'
                                      }`}
                                    >
                                      {finding.severity}
                                    </span>
                                    <button
                                      type="button"
                                      className="btn btn-xs"
                                      onClick={() =>
                                        createTask({
                                          app: selectedApp.app,
                                          version: activeVersionEval.version,
                                          priorityCode: activeVersionEval.priority.code,
                                          team: 'Deployment',
                                          title: `Fix ${finding.severity} vuln: ${finding.title}`,
                                          source: 'Finding',
                                        })
                                      }
                                    >
                                      + Task
                                    </button>
                                  </div>
                                </div>
                              </li>
                            ))}
                        </ul>
                      )}
                    </div>

                    <div className="section-block">
                      <h3 className="section-heading">
                        Failed tests ({activeVersionEval.failedTests.length})
                      </h3>
                      {activeVersionEval.failedTests.length === 0 ? (
                        <div className="empty-state">
                          {activeVersionEval.testTotals.failed > 0
                            ? `${activeVersionEval.testTotals.failed} failed test(s) reported without individual test names.`
                            : 'All reported Selenium and E2E tests passed.'}
                        </div>
                      ) : (
                        <ul className="issue-list">
                          {activeVersionEval.failedTests.map((failure, idx) => (
                            <li
                              key={`${failure.source}-${failure.name}-${idx}`}
                              className="issue-item"
                            >
                              <div className="issue-item-header">
                                <span className="issue-title">{failure.name}</span>
                                <div className="issue-item-actions">
                                  <span className="chip neutral">{failure.sourceLabel}</span>
                                  <button
                                    type="button"
                                    className="btn btn-xs"
                                    onClick={() =>
                                      createTask({
                                        app: selectedApp.app,
                                        version: activeVersionEval.version,
                                        priorityCode: activeVersionEval.priority.code,
                                        team: 'Testing',
                                        title: `Fix ${failure.source} test: ${failure.name}`,
                                        source: 'Test failure',
                                      })
                                    }
                                  >
                                    + Task
                                  </button>
                                </div>
                              </div>
                              <span className="issue-detail">{failure.message}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {activeVersionEval.isLatest && (
                      <div className="section-block">
                        <h3 className="section-heading">Suggested tasks</h3>
                        {selectedApp.suggestedTasks.length === 0 ? (
                          <div className="empty-state">
                            No automatic tasks suggested for this version.
                          </div>
                        ) : (
                          selectedApp.suggestedTasks.map((suggestion) => {
                            const assigned = tasks.some(
                              (t) => t.suggestionKey === suggestion.key
                            );
                            return (
                              <div key={suggestion.key} className="suggestion-card">
                                <div className="suggestion-text">
                                  <span className="suggestion-title">
                                    {suggestion.title}
                                  </span>
                                  <span className="suggestion-reason">
                                    {suggestion.team} team · {suggestion.reason}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className={`btn btn-sm ${assigned ? '' : 'btn-cta'}`}
                                  disabled={assigned}
                                  onClick={() =>
                                    handleAssignSuggested(selectedApp, suggestion)
                                  }
                                >
                                  {assigned ? 'Assigned ✓' : 'Assign'}
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}

                    {selectedAppTasks.length > 0 && (
                      <div className="section-block">
                        <div className="section-header-row">
                          <h3 className="section-heading">
                            Assigned tasks ({selectedAppTasks.length})
                          </h3>
                          <button
                            type="button"
                            className="btn-link"
                            style={{ fontSize: '12px' }}
                            onClick={() => setActiveScreen('tasks')}
                          >
                            Open board →
                          </button>
                        </div>
                        <ul className="issue-list">
                          {selectedAppTasks.map((task) => (
                            <li key={task.id} className="issue-item">
                              <div className="issue-item-header">
                                <span className="issue-title">{task.title}</span>
                                <span className={`team-badge ${task.team.toLowerCase()}`}>
                                  {task.team}
                                </span>
                              </div>
                              <div className="section-header-row">
                                <span className="issue-detail">
                                  v{task.version} · {task.owner || 'Unassigned'} ·{' '}
                                  {BOARD_COLUMNS.find((c) => c.id === task.status)?.label}
                                </span>
                                {task.status !== 'done' && (
                                  <button
                                    type="button"
                                    className="btn btn-xs"
                                    onClick={() => moveTask(task.id, 'done')}
                                  >
                                    Mark done
                                  </button>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="section-block">
                      <h3 className="section-heading">Assign custom task</h3>
                      <form className="custom-task-form" onSubmit={handleCustomTaskSubmit}>
                        <label htmlFor="custom-task-title" className="sr-only">
                          Task title
                        </label>
                        <input
                          id="custom-task-title"
                          type="text"
                          className="input"
                          placeholder={`Task for ${selectedApp.app} v${activeVersionEval.version}...`}
                          value={customTitle}
                          onChange={(e) => setCustomTitle(e.target.value)}
                          required
                        />
                        <div className="form-row">
                          <label htmlFor="custom-task-team" className="sr-only">
                            Target team
                          </label>
                          <select
                            id="custom-task-team"
                            className="select select-team"
                            value={customTeam}
                            onChange={(e) => setCustomTeam(e.target.value)}
                          >
                            <option value="Testing">Testing</option>
                            <option value="Deployment">Deployment</option>
                          </select>
                          <button
                            type="submit"
                            className="btn btn-cta"
                            style={{ flex: 1 }}
                            disabled={!customTitle.trim()}
                          >
                            Assign task
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                </aside>
              )}
            </section>
          </>
        )}

        {/* SCREEN 2: TASKS BOARD */}
        {activeScreen === 'tasks' && (
          <section aria-label="Tasks board">
            <div className="board-toolbar" style={{ marginBottom: '12px' }}>
              <div>
                <h2 className="card-title" style={{ fontSize: '18px' }}>
                  Tasks board
                </h2>
                <span className="card-meta">
                  Drag cards between columns or use move buttons to coordinate Testing &amp; Deployment teams.
                </span>
              </div>

              <div className="board-controls">
                <div className="command-search" style={{ minWidth: '210px' }}>
                  <IconSearch className="icon search-icon" />
                  <label htmlFor="task-search-input" className="sr-only">
                    Search tasks
                  </label>
                  <input
                    id="task-search-input"
                    type="search"
                    className="command-search-input"
                    placeholder="Search tasks, app, or owner..."
                    value={taskSearch}
                    onChange={(e) => setTaskSearch(e.target.value)}
                  />
                </div>

                <label htmlFor="priority-filter-select" className="sr-only">
                  Filter by priority
                </label>
                <select
                  id="priority-filter-select"
                  className="filter-select"
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value)}
                >
                  {PRIORITY_FILTERS.map((pf) => (
                    <option key={pf} value={pf}>
                      Priority: {pf}
                    </option>
                  ))}
                </select>

                <div className="filter-pills" role="group" aria-label="Filter tasks by team">
                  {TEAM_FILTERS.map((team) => (
                    <button
                      key={team}
                      type="button"
                      className={`filter-pill ${teamFilter === team ? 'active' : ''}`}
                      aria-pressed={teamFilter === team}
                      onClick={() => setTeamFilter(team)}
                    >
                      {team}
                    </button>
                  ))}
                </div>

                {tasks.length > 0 && (
                  <button type="button" className="btn btn-sm" onClick={handleExportTasksCsv}>
                    <IconDownload />
                    Export CSV
                  </button>
                )}
              </div>
            </div>

            <div className="workload-strip">
              <div className="workload-stats">
                <span>
                  Testing open: <strong>{taskStats.testingOpen}</strong>
                </span>
                <span>
                  Deployment open: <strong>{taskStats.deploymentOpen}</strong>
                </span>
                <span>
                  P1 urgent open: <strong style={{ color: 'var(--p1-bar)' }}>{taskStats.p1Open}</strong>
                </span>
              </div>
              <div className="workload-progress">
                <span className="app-sub">
                  Completion ({taskStats.doneCount}/{taskStats.total})
                </span>
                <div className="risk-track" style={{ minWidth: '110px' }} aria-hidden="true">
                  <div
                    className="pass-bar-fill"
                    style={{ width: `${taskStats.pctDone}%` }}
                  />
                </div>
                <span className="mono" style={{ fontWeight: 700, fontSize: '12px' }}>
                  {taskStats.pctDone}%
                </span>
              </div>
            </div>

            <div className="board-columns">
              {BOARD_COLUMNS.map((col, colIndex) => {
                const columnTasks = filteredTasks.filter((t) => t.status === col.id);
                const prevColumn = BOARD_COLUMNS[colIndex - 1] || null;
                const nextColumn = BOARD_COLUMNS[colIndex + 1] || null;
                const hasDoneTasks = col.id === 'done' && tasks.some((t) => t.status === 'done');

                return (
                  <div
                    key={col.id}
                    className={`board-column ${dragOverColumn === col.id ? 'drag-over' : ''}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverColumn(col.id);
                    }}
                    onDragLeave={() => setDragOverColumn(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const draggedId = e.dataTransfer.getData('text/plain');
                      setDragOverColumn(null);
                      if (draggedId) moveTask(draggedId, col.id);
                    }}
                  >
                    <div className="column-header">
                      <div className="column-header-left">
                        <h3 className="column-title">{col.label}</h3>
                        <span className="column-count">{columnTasks.length}</span>
                      </div>
                      {hasDoneTasks && (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          onClick={clearDoneTasks}
                        >
                          Clear done
                        </button>
                      )}
                    </div>

                    {columnTasks.length === 0 ? (
                      <div className="empty-state">
                        <p className="empty-state-title">No tasks in {col.label}</p>
                        <p>
                          {tasks.length === 0
                            ? 'Select an application on the Dashboard or click Auto-assign suggested.'
                            : 'No tasks match the current filters in this column.'}
                        </p>
                      </div>
                    ) : (
                      <div className="task-list">
                        {columnTasks.map((task) => {
                          const pMeta = PRIORITY_META[task.priorityCode] || PRIORITY_META.P4;
                          return (
                            <article
                              key={task.id}
                              className="task-card"
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData('text/plain', task.id);
                              }}
                            >
                              <div className="task-card-top">
                                <button
                                  type="button"
                                  className="btn-link task-app"
                                  onClick={() => {
                                    setActiveScreen('applications');
                                    setSelectedAppName(task.app);
                                  }}
                                  title={`Inspect ${task.app} on Dashboard`}
                                >
                                  {task.app}{' '}
                                  <span className="mono">v{task.version}</span>
                                </button>
                                <span className={`chip ${pMeta.tone}`}>
                                  {pMeta.label}
                                </span>
                              </div>

                              <p className="task-title">{task.title}</p>

                              <div className="task-badges">
                                <span
                                  className={`team-badge ${task.team.toLowerCase()}`}
                                >
                                  {task.team} team
                                </span>
                                <select
                                  aria-label={`Assign owner for ${task.title}`}
                                  className="owner-select"
                                  value={task.owner || 'Unassigned'}
                                  onChange={(e) => updateTaskOwner(task.id, e.target.value)}
                                >
                                  {OWNER_OPTIONS.map((owner) => (
                                    <option key={owner} value={owner}>
                                      {owner}
                                    </option>
                                  ))}
                                </select>
                                {task.source && (
                                  <span className="app-sub">· {task.source}</span>
                                )}
                              </div>

                              <div className="task-actions">
                                <div className="task-move-group">
                                  {prevColumn && (
                                    <button
                                      type="button"
                                      className="btn btn-sm"
                                      onClick={() => moveTask(task.id, prevColumn.id)}
                                      aria-label={`Move "${task.title}" to ${prevColumn.label}`}
                                    >
                                      ← {prevColumn.label}
                                    </button>
                                  )}
                                  {nextColumn && (
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-primary"
                                      onClick={() => moveTask(task.id, nextColumn.id)}
                                      aria-label={`Move "${task.title}" to ${nextColumn.label}`}
                                    >
                                      {nextColumn.label} →
                                    </button>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-ghost"
                                  onClick={() => deleteTask(task.id)}
                                  aria-label={`Remove task "${task.title}"`}
                                  title="Remove task"
                                >
                                  Remove
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* SCREEN 3: INSIGHTS & POLICY SIMULATOR */}
        {activeScreen === 'insights' && (
          <section aria-label="Fleet insights and policy simulator" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="insights-grid">
              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Fleet risk &amp; priority distribution</h2>
                    <span className="card-meta">
                      Average risk score: {fleetAnalytics.avgRiskScore}/100 · Fleet readiness:{' '}
                      {fleetAnalytics.readinessIndex}%
                    </span>
                  </div>
                </div>
                <div className="insight-card-body">
                  {(['P1', 'P2', 'P3', 'P4']).map((code) => {
                    const count = fleetAnalytics.priorityCounts[code] || 0;
                    const pct = kpis.totalApps > 0 ? Math.round((count / kpis.totalApps) * 100) : 0;
                    const meta = PRIORITY_META[code];
                    return (
                      <div key={code} className="bar-row">
                        <div className="bar-row-top">
                          <span className={`chip ${meta.tone}`}>{meta.label}</span>
                          <span className="mono">
                            {count} app(s) ({pct}%)
                          </span>
                        </div>
                        <div className="bar-track">
                          <div className={`risk-fill ${meta.tone}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}

                  <div style={{ paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
                    <span className="section-heading">By application type</span>
                    <div className="report-summary-grid" style={{ marginTop: '8px' }}>
                      {fleetAnalytics.byType.map((item) => (
                        <div key={item.appType} className="report-mini-card">
                          <span className="report-mini-title">{item.appType}</span>
                          <span className="report-mini-stat">{item.count} app(s)</span>
                          <span className="report-mini-sub">
                            Avg risk {item.avgScore} · {item.blocked} blocked
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Version-over-version risk trajectory</h2>
                    <span className="card-meta">
                      Compares each application&apos;s previous release vs. latest build
                    </span>
                  </div>
                </div>
                <div className="insight-card-body">
                  {applications.map((app) => (
                    <div key={app.app} className="bar-row">
                      <div className="bar-row-top">
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => {
                            setActiveScreen('applications');
                            setSelectedAppName(app.app);
                          }}
                        >
                          {app.app}
                        </button>
                        <span className={`trend-badge ${app.trend.direction}`}>
                          {app.previousVersion ? `v${app.previousVersion} (${app.previousScore})` : 'New'} → v
                          {app.latestVersion} ({app.riskScore})
                        </span>
                      </div>
                      <div className="compare-bars">
                        {app.previousScore !== null && (
                          <div className="compare-bar-line">
                            <span style={{ width: '36px' }}>Prev</span>
                            <div className="compare-bar-track">
                              <div
                                className="compare-bar-prev"
                                style={{ width: `${app.previousScore}%` }}
                              />
                            </div>
                          </div>
                        )}
                        <div className="compare-bar-line">
                          <span style={{ width: '36px' }}>Latest</span>
                          <div className="compare-bar-track">
                            <div
                              className={`risk-fill ${app.priority.tone}`}
                              style={{ width: `${app.riskScore}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Top security findings across latest builds</h2>
                    <span className="card-meta">
                      Critical: {fleetAnalytics.severityTotals.critical} · High:{' '}
                      {fleetAnalytics.severityTotals.high} · Medium:{' '}
                      {fleetAnalytics.severityTotals.medium} · Low:{' '}
                      {fleetAnalytics.severityTotals.low}
                    </span>
                  </div>
                </div>
                <div className="insight-card-body">
                  {fleetAnalytics.topFindings.length === 0 ? (
                    <div className="empty-state">No vulnerabilities reported across the fleet.</div>
                  ) : (
                    <ul className="issue-list">
                      {fleetAnalytics.topFindings.map((item, idx) => (
                        <li key={`${item.title}-${idx}`} className="issue-item">
                          <div className="issue-item-header">
                            <span className="issue-title">{item.title}</span>
                            <span
                              className={`chip ${
                                item.severity === 'critical'
                                  ? 'critical'
                                  : item.severity === 'high'
                                    ? 'high'
                                    : item.severity === 'medium'
                                      ? 'medium'
                                      : 'low'
                              }`}
                            >
                              {item.severity}
                            </span>
                          </div>
                          <span className="issue-detail">
                            Affected: {item.apps.join(', ')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Test suite reliability</h2>
                    <span className="card-meta">
                      Combined pass rate: {fleetAnalytics.fleetPassRate}% across {kpis.totalTests} tests
                    </span>
                  </div>
                </div>
                <div className="insight-card-body">
                  {[
                    { label: 'Selenium UI suites', data: fleetAnalytics.seleniumTotals },
                    { label: 'End-to-End suites', data: fleetAnalytics.e2eTotals },
                  ].map((suite) => {
                    const rate =
                      suite.data.total > 0
                        ? Math.round((suite.data.passed / suite.data.total) * 100)
                        : 100;
                    return (
                      <div key={suite.label} className="bar-row">
                        <div className="bar-row-top">
                          <strong>{suite.label}</strong>
                          <span className="mono">
                            {suite.data.passed}/{suite.data.total} passed ({suite.data.failed} failed ·{' '}
                            {rate}%)
                          </span>
                        </div>
                        <div className="pass-bar-track" style={{ height: '10px' }}>
                          <div className="pass-bar-fill" style={{ width: `${rate}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Release Gate Policy Simulator</h2>
                  <span className="card-meta">
                    Adjust risk weights and priority thresholds to simulate stricter or looser release policies live.
                  </span>
                </div>
                {customPolicyActive && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setPolicy(DEFAULT_POLICY);
                      appendAudit('Policy reset', 'Restored default Release Control Center thresholds');
                    }}
                  >
                    Reset to defaults
                  </button>
                )}
              </div>
              <div className="insight-card-body">
                <div className="policy-grid">
                  <div className="policy-field">
                    <label htmlFor="pol-p1">
                      <span>P1 Blocked score threshold</span>
                      <strong className="mono">≥ {policy.thresholds.p1}</strong>
                    </label>
                    <input
                      id="pol-p1"
                      type="range"
                      min="30"
                      max="90"
                      step="5"
                      value={policy.thresholds.p1}
                      onChange={(e) =>
                        setPolicy((prev) => ({
                          ...prev,
                          thresholds: { ...prev.thresholds, p1: Number(e.target.value) },
                        }))
                      }
                    />
                  </div>
                  <div className="policy-field">
                    <label htmlFor="pol-p2">
                      <span>P2 High score threshold</span>
                      <strong className="mono">≥ {policy.thresholds.p2}</strong>
                    </label>
                    <input
                      id="pol-p2"
                      type="range"
                      min="15"
                      max="60"
                      step="5"
                      value={policy.thresholds.p2}
                      onChange={(e) =>
                        setPolicy((prev) => ({
                          ...prev,
                          thresholds: { ...prev.thresholds, p2: Number(e.target.value) },
                        }))
                      }
                    />
                  </div>
                  <div className="policy-field">
                    <label htmlFor="pol-p3">
                      <span>P3 Medium score threshold</span>
                      <strong className="mono">≥ {policy.thresholds.p3}</strong>
                    </label>
                    <input
                      id="pol-p3"
                      type="range"
                      min="5"
                      max="35"
                      step="5"
                      value={policy.thresholds.p3}
                      onChange={(e) =>
                        setPolicy((prev) => ({
                          ...prev,
                          thresholds: { ...prev.thresholds, p3: Number(e.target.value) },
                        }))
                      }
                    />
                  </div>
                  <div className="policy-field">
                    <label htmlFor="pol-crit">
                      <span>Critical vulnerability weight</span>
                      <strong className="mono">{policy.weights.critical} pts</strong>
                    </label>
                    <input
                      id="pol-crit"
                      type="range"
                      min="5"
                      max="30"
                      step="1"
                      value={policy.weights.critical}
                      onChange={(e) =>
                        setPolicy((prev) => ({
                          ...prev,
                          weights: { ...prev.weights, critical: Number(e.target.value) },
                        }))
                      }
                    />
                  </div>
                  <div className="policy-field">
                    <label htmlFor="pol-test">
                      <span>Test failure scale</span>
                      <strong className="mono">× {policy.testPenaltyScale}</strong>
                    </label>
                    <input
                      id="pol-test"
                      type="range"
                      min="20"
                      max="100"
                      step="5"
                      value={policy.testPenaltyScale}
                      onChange={(e) =>
                        setPolicy((prev) => ({
                          ...prev,
                          testPenaltyScale: Number(e.target.value),
                        }))
                      }
                    />
                  </div>
                  <div className="policy-field" style={{ justifyContent: 'center' }}>
                    <label style={{ cursor: 'pointer', alignItems: 'center' }}>
                      <span>Auto-block on any critical vuln</span>
                      <input
                        type="checkbox"
                        checked={policy.blockOnCritical}
                        onChange={(e) =>
                          setPolicy((prev) => ({
                            ...prev,
                            blockOnCritical: e.target.checked,
                          }))
                        }
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* SCREEN 4: REPORTS & AUDIT LOG */}
        {activeScreen === 'reports' && (
          <section aria-label="Reports explorer and audit log" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Backend &amp; SQLite Database Status</h2>
                  <span className="card-meta">
                    {dbStatus.connected
                      ? `${dbStatus.engine} · ${dbStatus.dbPath} (${Math.round((dbStatus.fileSizeBytes || 0) / 1024)} KB)`
                      : 'Backend API unavailable — running in browser-only fallback mode.'}
                  </span>
                </div>
                <div className="topbar-actions">
                  <span className={`chip ${dbStatus.connected ? 'low' : 'critical'}`}>
                    <span className={`dot ${dbStatus.connected ? 'ready' : 'blocked'}`} />
                    {dbStatus.connected ? 'Connected' : 'Disconnected'}
                  </span>
                  {dbStatus.connected && (
                    <>
                      <button type="button" className="btn btn-sm" onClick={refreshFromBackend}>
                        Refresh from DB
                      </button>
                      <button type="button" className="btn btn-sm btn-primary" onClick={handleSeedDatabase}>
                        Seed 7 Sample Apps to DB
                      </button>
                    </>
                  )}
                </div>
              </div>
              {dbStatus.connected && (
                <div className="insight-card-body" style={{ paddingTop: '12px', paddingBottom: '12px' }}>
                  <div className="mini-tiles-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
                    <div className="mini-tile">
                      <span className="mini-tile-label">DB Reports</span>
                      <span className="mini-tile-value">{dbStatus.counts?.reports ?? uploadedReports.length}</span>
                    </div>
                    <div className="mini-tile">
                      <span className="mini-tile-label">DB Tasks</span>
                      <span className="mini-tile-value">{dbStatus.counts?.tasks ?? tasks.length}</span>
                    </div>
                    <div className="mini-tile">
                      <span className="mini-tile-label">DB Sign-offs</span>
                      <span className="mini-tile-value">{dbStatus.counts?.signOffs ?? Object.keys(signOffs).length}</span>
                    </div>
                    <div className="mini-tile">
                      <span className="mini-tile-label">DB Audit Rows</span>
                      <span className="mini-tile-value">{dbStatus.counts?.auditLogs ?? auditLog.length}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Export Center</h2>
                  <span className="card-meta">
                    Generate release readiness summaries and task exports for stakeholders.
                  </span>
                </div>
                <div className="topbar-actions">
                  <button type="button" className="btn btn-sm" onClick={handleCopyMarkdownBrief}>
                    <IconCopy />
                    Copy Markdown brief
                  </button>
                  <button type="button" className="btn btn-sm" onClick={handleDownloadMarkdownBrief}>
                    <IconDownload />
                    Download .md report
                  </button>
                  <button type="button" className="btn btn-sm" onClick={handleExportExcelWorkbook}>
                    <IconDownload />
                    Export Excel (.xlsx)
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={tasks.length === 0}
                    onClick={handleExportTasksCsv}
                  >
                    <IconDownload />
                    Export tasks .csv
                  </button>
                </div>
              </div>
            </div>

            <div className="insights-grid">
              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">
                      Loaded Report Inventory ({filteredInventory.length})
                    </h2>
                    <span className="card-meta">
                      Inspect normalized JSON payloads or delete uploaded reports.
                    </span>
                  </div>
                </div>
                <div className="command-filter-bar" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                  <div className="command-search" style={{ minWidth: '180px' }}>
                    <IconSearch className="icon search-icon" />
                    <input
                      type="search"
                      className="command-search-input"
                      placeholder="Filter by app, version, build, source..."
                      value={reportSearch}
                      onChange={(e) => setReportSearch(e.target.value)}
                    />
                  </div>
                  <select
                    aria-label="Filter reports by type"
                    className="filter-select"
                    value={reportTypeFilter}
                    onChange={(e) => setReportTypeFilter(e.target.value)}
                  >
                    <option value="All">Type: All</option>
                    <option value="security">security</option>
                    <option value="selenium">selenium</option>
                    <option value="e2e">e2e</option>
                  </select>
                </div>
                <div className="table-scroll" style={{ maxHeight: '420px', overflowY: 'auto' }}>
                  <table className="apps-table" style={{ minWidth: '520px' }}>
                    <thead>
                      <tr>
                        <th scope="col">App &amp; Version</th>
                        <th scope="col">Type</th>
                        <th scope="col">Source</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredInventory.map((rep, idx) => (
                        <tr key={`${rep.app}-${rep.version}-${rep.type}-${idx}`}>
                          <td>
                            <div className="app-name-cell">
                              <span className="app-name">
                                {rep.app} <span className="mono">v{rep.version}</span>
                              </span>
                              <span className="app-sub">
                                {rep.build || 'No build'} · {formatDateTime(rep.createdAt)}
                              </span>
                            </div>
                          </td>
                          <td>
                            <span className="type-badge">{rep.type}</span>
                          </td>
                          <td className="app-sub">{rep._source || 'Local'}</td>
                          <td>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <button
                                type="button"
                                className="btn btn-xs"
                                onClick={() => setInspectedRawReport(rep)}
                              >
                                Inspect JSON
                              </button>
                              {rep._uploadId && (
                                <button
                                  type="button"
                                  className="btn btn-xs btn-danger"
                                  onClick={() => removeSingleUploadedReport(rep._uploadId)}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Manager Activity &amp; Audit Log</h2>
                    <span className="card-meta">
                      Recent uploads, task assignments, sign-offs, and policy changes.
                    </span>
                  </div>
                  {auditLog.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={() => {
                        setAuditLog([]);
                        if (dbStatus.connected) {
                          apiRequest('/api/audit', { method: 'DELETE' }).catch(() => {});
                        }
                      }}
                    >
                      Clear log
                    </button>
                  )}
                </div>
                <div className="insight-card-body" style={{ maxHeight: '470px', overflowY: 'auto' }}>
                  {auditLog.length === 0 ? (
                    <div className="empty-state">
                      <p className="empty-state-title">No recorded actions yet</p>
                      <p>
                        Actions like uploading reports, assigning tasks, or signing off releases will appear here.
                      </p>
                    </div>
                  ) : (
                    <ul className="issue-list">
                      {auditLog.map((entry) => (
                        <li key={entry.id} className="issue-item">
                          <div className="issue-item-header">
                            <span className="issue-title">{entry.action}</span>
                            <span className="app-sub">{formatDateTime(entry.timestamp)}</span>
                          </div>
                          <span className="issue-detail">{entry.detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
