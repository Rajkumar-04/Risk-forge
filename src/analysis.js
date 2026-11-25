/**
 * Release Control Center — Analysis Engine
 *
 * Normalizes security, Selenium, and E2E reports, compares versions,
 * computes risk scores, priorities, release statuses, trends, version diffs,
 * release gate checks, fleet analytics, and suggested remediation tasks.
 */

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

export const SEVERITY_WEIGHTS = {
  critical: 10,
  high: 5,
  medium: 2,
  low: 0.5,
};

export const DEFAULT_POLICY = {
  weights: { ...SEVERITY_WEIGHTS },
  testPenaltyScale: 60,
  thresholds: { p1: 60, p2: 35, p3: 15 },
  blockOnCritical: true,
};

export const PRIORITY_META = {
  P1: { code: 'P1', label: 'P1 Critical', shortLabel: 'Critical', rank: 1, tone: 'critical' },
  P2: { code: 'P2', label: 'P2 High', shortLabel: 'High', rank: 2, tone: 'high' },
  P3: { code: 'P3', label: 'P3 Medium', shortLabel: 'Medium', rank: 3, tone: 'medium' },
  P4: { code: 'P4', label: 'P4 Low', shortLabel: 'Low', rank: 4, tone: 'low' },
};

function toNonNegInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function normalizeSeverity(severity) {
  const value = String(severity || '').trim().toLowerCase();
  if (value === 'critical' || value === 'crit') return 'critical';
  if (value === 'high') return 'high';
  if (value === 'medium' || value === 'med' || value === 'moderate') return 'medium';
  if (value === 'low' || value === 'info') return 'low';
  return 'low';
}

function normalizeReportType(type, raw) {
  const value = String(type || '').trim().toLowerCase();
  if (value === 'security' || value === 'vulnerability' || value === 'vuln' || value === 'sast' || value === 'sca') {
    return 'security';
  }
  if (value === 'selenium' || value === 'ui') {
    return 'selenium';
  }
  if (value === 'e2e' || value === 'end-to-end' || value === 'end_to_end') {
    return 'e2e';
  }
  if (Array.isArray(raw?.findings)) return 'security';
  if (raw?.tests || Array.isArray(raw?.failures)) return 'e2e';
  return 'security';
}

function parseTimestamp(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Normalizes a single raw report object with safe defaults.
 */
export function normalizeReport(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const type = normalizeReportType(raw.type, raw);
  const app = String(raw.app || raw.application || 'Unknown App').trim() || 'Unknown App';
  const appType = String(raw.appType || raw.platform || '').trim();
  const version = String(raw.version || '0.0.0').trim() || '0.0.0';
  const build = String(raw.build || '').trim();
  const createdAt = raw.createdAt && parseTimestamp(raw.createdAt) > 0
    ? new Date(parseTimestamp(raw.createdAt)).toISOString()
    : '';

  const findings = Array.isArray(raw.findings)
    ? raw.findings
        .filter((f) => f && typeof f === 'object')
        .map((f) => ({
          title: String(f.title || f.name || 'Unnamed vulnerability').trim(),
          severity: normalizeSeverity(f.severity),
        }))
    : [];

  const rawTests = raw.tests && typeof raw.tests === 'object' ? raw.tests : {};
  let total = toNonNegInt(rawTests.total);
  let passed = toNonNegInt(rawTests.passed);
  let failed = toNonNegInt(rawTests.failed);

  const failures = Array.isArray(raw.failures)
    ? raw.failures
        .filter((f) => f && typeof f === 'object')
        .map((f) => ({
          name: String(f.name || f.title || 'Unnamed test').trim(),
          message: String(f.message || f.error || 'Failed without details').trim(),
        }))
    : [];

  if (failed === 0 && failures.length > 0 && rawTests.failed === undefined) {
    failed = failures.length;
  }
  if (total === 0 && (passed > 0 || failed > 0)) {
    total = passed + failed;
  } else if (total > 0 && rawTests.failed === undefined && passed <= total) {
    failed = Math.max(failed, total - passed);
  } else if (total > 0 && rawTests.passed === undefined && failed <= total) {
    passed = total - failed;
  }
  if (total < passed + failed) {
    total = passed + failed;
  }

  return {
    app,
    appType,
    version,
    type,
    build,
    createdAt,
    timestampMs: parseTimestamp(createdAt),
    findings,
    tests: { total, passed, failed },
    failures,
    _source: raw._source || null,
    _uploadId: raw._uploadId || null,
    _order: index,
  };
}

/**
 * Flattens one object or array of objects (or nested file payloads) into normalized reports.
 */
export function normalizeReports(input) {
  const flat = [];
  const collect = (item) => {
    if (Array.isArray(item)) {
      item.forEach(collect);
    } else if (item && typeof item === 'object') {
      flat.push(item);
    }
  };
  collect(input);

  return flat
    .map((item, idx) => normalizeReport(item, idx))
    .filter(Boolean);
}

/**
 * Compares two version strings (e.g., "2.10.0" > "2.5.0", "v1.2.0-rc.1" < "1.2.0").
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a, b) {
  const clean = (v) => String(v || '0.0.0').trim().replace(/^v/i, '');
  const splitVer = (v) => {
    const [withoutBuild] = clean(v).split('+');
    const [core, ...preParts] = withoutBuild.split('-');
    const pre = preParts.join('-');
    return {
      core: core.split('.').map((part) => {
        const num = Number(part);
        return /^\d+$/.test(part) && Number.isFinite(num) ? num : part.toLowerCase();
      }),
      pre: pre ? pre.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase())) : [],
    };
  };

  const va = splitVer(a);
  const vb = splitVer(b);
  const maxCore = Math.max(va.core.length, vb.core.length);

  for (let i = 0; i < maxCore; i += 1) {
    const pa = va.core[i] ?? 0;
    const pb = vb.core[i] ?? 0;
    if (typeof pa === 'number' && typeof pb === 'number') {
      if (pa !== pb) return pa > pb ? 1 : -1;
    } else {
      const sa = String(pa);
      const sb = String(pb);
      if (sa !== sb) return sa > sb ? 1 : -1;
    }
  }

  if (va.pre.length === 0 && vb.pre.length > 0) return 1;
  if (va.pre.length > 0 && vb.pre.length === 0) return -1;

  const maxPre = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < maxPre; i += 1) {
    const pa = va.pre[i];
    const pb = vb.pre[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (typeof pa === 'number' && typeof pb === 'number') {
      if (pa !== pb) return pa > pb ? 1 : -1;
    } else {
      const sa = String(pa);
      const sb = String(pb);
      if (sa !== sb) return sa > sb ? 1 : -1;
    }
  }

  return 0;
}

/**
 * Evaluates release gate checks for a single version.
 */
export function evaluateReleaseGates(evaluation, policy = DEFAULT_POLICY) {
  const { vulnCounts, riskScore, reportsByType } = evaluation;
  const securityPresent = Boolean(reportsByType.security);
  const seleniumPresent = Boolean(reportsByType.selenium);
  const e2ePresent = Boolean(reportsByType.e2e);

  return [
    {
      id: 'critical-vulns',
      label: 'Zero critical vulnerabilities',
      status: vulnCounts.critical === 0 ? 'pass' : 'fail',
      detail:
        vulnCounts.critical === 0
          ? 'No critical findings'
          : `${vulnCounts.critical} critical finding(s)`,
    },
    {
      id: 'risk-threshold',
      label: `Risk score below P1 gate (< ${policy.thresholds.p1})`,
      status: riskScore < policy.thresholds.p1 ? 'pass' : 'fail',
      detail: `Score ${riskScore}/100`,
    },
    {
      id: 'security-scan',
      label: 'Security scan coverage',
      status: securityPresent ? 'pass' : 'warn',
      detail: securityPresent ? `${vulnCounts.total} finding(s) scanned` : 'Report missing',
    },
    {
      id: 'selenium-suite',
      label: 'Selenium UI suite',
      status: !seleniumPresent
        ? 'warn'
        : reportsByType.selenium.tests.failed === 0
          ? 'pass'
          : 'fail',
      detail: !seleniumPresent
        ? 'Not reported'
        : `${reportsByType.selenium.tests.passed}/${reportsByType.selenium.tests.total} passed`,
    },
    {
      id: 'e2e-suite',
      label: 'End-to-End suite',
      status: !e2ePresent
        ? 'warn'
        : reportsByType.e2e.tests.failed === 0
          ? 'pass'
          : 'fail',
      detail: !e2ePresent
        ? 'Not reported'
        : `${reportsByType.e2e.tests.passed}/${reportsByType.e2e.tests.total} passed`,
    },
  ];
}

/**
 * Selects the latest report per report type (security, selenium, e2e) for a version,
 * then computes risk score, priority, release status, gates, and breakdown metrics.
 */
export function evaluateVersion(versionReports, policy = DEFAULT_POLICY) {
  const latestByType = {};

  for (const report of versionReports) {
    const existing = latestByType[report.type];
    if (
      !existing ||
      report.timestampMs > existing.timestampMs ||
      (report.timestampMs === existing.timestampMs && report._order > existing._order)
    ) {
      latestByType[report.type] = report;
    }
  }

  const security = latestByType.security || null;
  const selenium = latestByType.selenium || null;
  const e2e = latestByType.e2e || null;

  const vulnCounts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  const findings = security ? [...security.findings] : [];

  for (const finding of findings) {
    vulnCounts[finding.severity] = (vulnCounts[finding.severity] || 0) + 1;
    vulnCounts.total += 1;
  }

  findings.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  const weights = policy?.weights || SEVERITY_WEIGHTS;
  const vulnWeight =
    vulnCounts.critical * weights.critical +
    vulnCounts.high * weights.high +
    vulnCounts.medium * weights.medium +
    vulnCounts.low * weights.low;

  const testReports = [
    selenium ? { source: 'selenium', label: 'Selenium UI', report: selenium } : null,
    e2e ? { source: 'e2e', label: 'End-to-End', report: e2e } : null,
  ].filter(Boolean);

  const testTotals = testReports.reduce(
    (acc, item) => {
      acc.total += item.report.tests.total;
      acc.passed += item.report.tests.passed;
      acc.failed += item.report.tests.failed;
      return acc;
    },
    { total: 0, passed: 0, failed: 0 }
  );

  const failedTests = testReports.flatMap((item) =>
    item.report.failures.map((failure) => ({
      ...failure,
      source: item.source,
      sourceLabel: item.label,
    }))
  );

  const failureRate = testTotals.total > 0 ? testTotals.failed / testTotals.total : 0;
  const passRate = testTotals.total > 0 ? (testTotals.passed / testTotals.total) * 100 : 100;
  const testPenalty = failureRate * (policy?.testPenaltyScale ?? 60);
  const rawScore = vulnWeight + testPenalty;
  const riskScore = Math.min(100, Math.round(rawScore));

  const thresholds = policy?.thresholds || DEFAULT_POLICY.thresholds;
  const blockOnCritical = policy?.blockOnCritical ?? true;

  let priorityCode = 'P4';
  if ((blockOnCritical && vulnCounts.critical > 0) || riskScore >= thresholds.p1) {
    priorityCode = 'P1';
  } else if (riskScore >= thresholds.p2) {
    priorityCode = 'P2';
  } else if (riskScore >= thresholds.p3) {
    priorityCode = 'P3';
  }

  const priority = PRIORITY_META[priorityCode];
  const releaseStatus =
    priorityCode === 'P1'
      ? 'Blocked'
      : priorityCode === 'P2' || priorityCode === 'P3'
        ? 'Needs review'
        : 'Ready';

  const latestTimestampMs = versionReports.reduce(
    (max, r) => Math.max(max, r.timestampMs),
    0
  );
  const lastUpdated = latestTimestampMs > 0 ? new Date(latestTimestampMs).toISOString() : '';

  const builds = Array.from(
    new Set(
      Object.values(latestByType)
        .map((r) => r.build)
        .filter(Boolean)
    )
  );

  const baseEval = {
    riskScore,
    rawScore: Number(rawScore.toFixed(1)),
    vulnWeight: Number(vulnWeight.toFixed(1)),
    testPenalty: Number(testPenalty.toFixed(1)),
    failureRate: Number((failureRate * 100).toFixed(1)),
    passRate: Number(passRate.toFixed(1)),
    priority,
    releaseStatus,
    vulnCounts,
    findings,
    testTotals,
    failedTests,
    reportsByType: {
      security,
      selenium,
      e2e,
    },
    reportsCount: Object.keys(latestByType).length,
    totalFilesInVersion: versionReports.length,
    builds,
    lastUpdated,
    latestTimestampMs,
  };

  return {
    ...baseEval,
    gates: evaluateReleaseGates(baseEval, policy),
  };
}

/**
 * Compares findings and failed tests between latest and previous version.
 */
export function computeVersionDiff(latest, previous) {
  if (!previous) return null;

  const normKey = (str) => String(str || '').trim().toLowerCase();

  const prevFindingsSet = new Set(previous.findings.map((f) => normKey(f.title)));
  const latestFindingsSet = new Set(latest.findings.map((f) => normKey(f.title)));

  const newFindings = latest.findings.filter((f) => !prevFindingsSet.has(normKey(f.title)));
  const resolvedFindings = previous.findings.filter(
    (f) => !latestFindingsSet.has(normKey(f.title))
  );

  const prevFailuresSet = new Set(previous.failedTests.map((t) => normKey(t.name)));
  const latestFailuresSet = new Set(latest.failedTests.map((t) => normKey(t.name)));

  const newFailures = latest.failedTests.filter((t) => !prevFailuresSet.has(normKey(t.name)));
  const resolvedFailures = previous.failedTests.filter(
    (t) => !latestFailuresSet.has(normKey(t.name))
  );

  return {
    newFindings,
    resolvedFindings,
    newFailures,
    resolvedFailures,
  };
}

/**
 * Generates suggested remediation or rollout tasks for a given application analysis.
 */
export function buildSuggestedTasks(appName, version, evaluation) {
  const suggestions = [];

  if (evaluation.vulnCounts.critical > 0) {
    suggestions.push({
      key: `${appName}::${version}::hold-release`,
      team: 'Deployment',
      title: 'Hold release and ship patched build',
      reason: `${evaluation.vulnCounts.critical} critical ${
        evaluation.vulnCounts.critical === 1 ? 'vulnerability' : 'vulnerabilities'
      } detected`,
    });
  }

  if (evaluation.testTotals.failed > 0) {
    const sources = [];
    if (evaluation.reportsByType.selenium?.tests.failed > 0) sources.push('Selenium');
    if (evaluation.reportsByType.e2e?.tests.failed > 0) sources.push('E2E');
    suggestions.push({
      key: `${appName}::${version}::triage-tests`,
      team: 'Testing',
      title: 'Triage failing tests',
      reason: `${evaluation.testTotals.failed} failed ${
        sources.length > 0 ? `(${sources.join(' + ')})` : 'tests'
      }`,
    });
  }

  if (evaluation.releaseStatus === 'Ready') {
    suggestions.push({
      key: `${appName}::${version}::approve-rollout`,
      team: 'Deployment',
      title: 'Approve rollout',
      reason: `Risk score ${evaluation.riskScore}/100 with no release blockers`,
    });
  }

  return suggestions;
}

/**
 * Groups normalized reports by app, compares latest vs previous version,
 * and returns sorted application summaries.
 */
export function analyzeApplications(rawReports, policy = DEFAULT_POLICY) {
  const reports = normalizeReports(rawReports);
  const byApp = new Map();

  for (const report of reports) {
    if (!byApp.has(report.app)) {
      byApp.set(report.app, []);
    }
    byApp.get(report.app).push(report);
  }

  const apps = [];

  for (const [appName, appReports] of byApp.entries()) {
    const resolvedType =
      appReports.find((r) => r.appType)?.appType || 'Service';

    const byVersion = new Map();
    for (const report of appReports) {
      if (!byVersion.has(report.version)) {
        byVersion.set(report.version, []);
      }
      byVersion.get(report.version).push(report);
    }

    const versionEntries = Array.from(byVersion.entries()).map(([version, verReports]) => {
      const latestTs = verReports.reduce((m, r) => Math.max(m, r.timestampMs), 0);
      return {
        version,
        reports: verReports,
        latestTs,
      };
    });

    versionEntries.sort((a, b) => {
      const cmp = compareVersions(b.version, a.version);
      if (cmp !== 0) return cmp;
      return b.latestTs - a.latestTs;
    });

    const evaluatedVersions = versionEntries.map((entry, idx) => ({
      version: entry.version,
      isLatest: idx === 0,
      isPrevious: idx === 1,
      ...evaluateVersion(entry.reports, policy),
    }));

    const latest = evaluatedVersions[0];
    const previous = evaluatedVersions[1] || null;

    let trend;
    if (!previous) {
      trend = {
        direction: 'new',
        label: 'New',
        delta: null,
        previousVersion: null,
        previousScore: null,
      };
    } else {
      const delta = latest.riskScore - previous.riskScore;
      let direction = 'flat';
      let label = '0';
      if (delta > 0) {
        direction = 'up';
        label = `+${delta}`;
      } else if (delta < 0) {
        direction = 'down';
        label = `${delta}`;
      }
      trend = {
        direction,
        label,
        delta,
        previousVersion: previous.version,
        previousScore: previous.riskScore,
      };
    }

    const versionDiff = computeVersionDiff(latest, previous);
    const suggestedTasks = buildSuggestedTasks(appName, latest.version, latest);

    apps.push({
      id: appName,
      app: appName,
      appType: resolvedType,
      latestVersion: latest.version,
      previousVersion: previous ? previous.version : null,
      versionCount: versionEntries.length,
      versions: evaluatedVersions,
      ...latest,
      previousScore: previous ? previous.riskScore : null,
      trend,
      versionDiff,
      suggestedTasks,
    });
  }

  apps.sort((a, b) => {
    if (a.priority.rank !== b.priority.rank) {
      return a.priority.rank - b.priority.rank;
    }
    if (b.riskScore !== a.riskScore) {
      return b.riskScore - a.riskScore;
    }
    return a.app.localeCompare(b.app);
  });

  return apps;
}

/**
 * Computes top-level manager KPIs across analyzed apps and active tasks.
 */
export function computeKpis(apps, tasks) {
  return apps.reduce(
    (acc, app) => {
      acc.totalApps += 1;
      if (app.releaseStatus === 'Blocked') acc.blockedReleases += 1;
      if (app.releaseStatus === 'Needs review') acc.needsReviewReleases += 1;
      if (app.releaseStatus === 'Ready') acc.readyReleases += 1;
      acc.criticalVulnerabilities += app.vulnCounts.critical;
      acc.failedTests += app.testTotals.failed;
      acc.totalTests += app.testTotals.total;
      return acc;
    },
    {
      totalApps: 0,
      blockedReleases: 0,
      needsReviewReleases: 0,
      readyReleases: 0,
      criticalVulnerabilities: 0,
      failedTests: 0,
      totalTests: 0,
      openTasks: tasks.filter((t) => t.status !== 'done').length,
    }
  );
}

/**
 * Computes fleet-wide release analytics for the Insights view.
 */
export function computeFleetAnalytics(apps) {
  const priorityCounts = { P1: 0, P2: 0, P3: 0, P4: 0 };
  const severityTotals = { critical: 0, high: 0, medium: 0, low: 0 };
  const byTypeMap = new Map();
  const recurringMap = new Map();

  let totalScore = 0;
  let totalTests = 0;
  let totalPassed = 0;
  let seleniumTotals = { total: 0, passed: 0, failed: 0 };
  let e2eTotals = { total: 0, passed: 0, failed: 0 };

  for (const app of apps) {
    priorityCounts[app.priority.code] = (priorityCounts[app.priority.code] || 0) + 1;
    totalScore += app.riskScore;

    for (const sev of SEVERITY_ORDER) {
      severityTotals[sev] += app.vulnCounts[sev] || 0;
    }

    totalTests += app.testTotals.total;
    totalPassed += app.testTotals.passed;

    if (app.reportsByType.selenium) {
      seleniumTotals.total += app.reportsByType.selenium.tests.total;
      seleniumTotals.passed += app.reportsByType.selenium.tests.passed;
      seleniumTotals.failed += app.reportsByType.selenium.tests.failed;
    }
    if (app.reportsByType.e2e) {
      e2eTotals.total += app.reportsByType.e2e.tests.total;
      e2eTotals.passed += app.reportsByType.e2e.tests.passed;
      e2eTotals.failed += app.reportsByType.e2e.tests.failed;
    }

    if (!byTypeMap.has(app.appType)) {
      byTypeMap.set(app.appType, {
        appType: app.appType,
        count: 0,
        blocked: 0,
        totalScore: 0,
        failedTests: 0,
      });
    }
    const typeEntry = byTypeMap.get(app.appType);
    typeEntry.count += 1;
    if (app.releaseStatus === 'Blocked') typeEntry.blocked += 1;
    typeEntry.totalScore += app.riskScore;
    typeEntry.failedTests += app.testTotals.failed;

    for (const finding of app.findings) {
      const key = `${finding.severity}::${finding.title.toLowerCase()}`;
      if (!recurringMap.has(key)) {
        recurringMap.set(key, {
          title: finding.title,
          severity: finding.severity,
          apps: [],
        });
      }
      const entry = recurringMap.get(key);
      if (!entry.apps.includes(app.app)) {
        entry.apps.push(app.app);
      }
    }
  }

  const avgRiskScore = apps.length > 0 ? Math.round(totalScore / apps.length) : 0;
  const fleetPassRate = totalTests > 0 ? Number(((totalPassed / totalTests) * 100).toFixed(1)) : 100;
  const readinessIndex = Math.max(0, Math.min(100, 100 - avgRiskScore));

  const byType = Array.from(byTypeMap.values()).map((t) => ({
    ...t,
    avgScore: Math.round(t.totalScore / t.count),
  }));

  const topFindings = Array.from(recurringMap.values())
    .sort((a, b) => {
      const sevCmp = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
      if (sevCmp !== 0) return sevCmp;
      return b.apps.length - a.apps.length;
    })
    .slice(0, 8);

  return {
    priorityCounts,
    severityTotals,
    avgRiskScore,
    readinessIndex,
    fleetPassRate,
    seleniumTotals,
    e2eTotals,
    byType,
    topFindings,
  };
}

/**
 * Generates a Markdown executive release readiness report for export/sharing.
 */
export function buildExecutiveMarkdown(apps, tasks, kpis, signOffs = {}) {
  const dateStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    `# Release Control Center — Executive Summary`,
    `Generated: ${dateStr} UTC`,
    '',
    `## Fleet KPIs`,
    `- **Total Applications:** ${kpis.totalApps}`,
    `- **Blocked Releases (P1):** ${kpis.blockedReleases}`,
    `- **Needs Review (P2/P3):** ${kpis.needsReviewReleases}`,
    `- **Ready to Ship (P4):** ${kpis.readyReleases}`,
    `- **Critical Vulnerabilities:** ${kpis.criticalVulnerabilities}`,
    `- **Failed Tests (Selenium + E2E):** ${kpis.failedTests}`,
    `- **Open Tasks:** ${kpis.openTasks}`,
    '',
    `## Application Status`,
    `| Application | Type | Version | Risk | Priority | Status | Trend | Sign-off |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];

  for (const app of apps) {
    const signOffKey = `${app.app}::${app.latestVersion}`;
    const signOff = signOffs[signOffKey]?.decision || '—';
    lines.push(
      `| ${app.app} | ${app.appType} | v${app.latestVersion} | ${app.riskScore}/100 | ${app.priority.label} | ${app.releaseStatus} | ${app.trend.label} | ${signOff} |`
    );
  }

  const openTasks = tasks.filter((t) => t.status !== 'done');
  lines.push('', `## Open Action Items (${openTasks.length})`);
  if (openTasks.length === 0) {
    lines.push('_No open tasks assigned._');
  } else {
    for (const task of openTasks) {
      lines.push(
        `- **[${task.priorityCode}] ${task.app} v${task.version}** (${task.team}): ${task.title} _[${task.status}]_`
      );
    }
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Spreadsheet (.xlsx & .csv) Parsing and Excel (.xlsx) Export Helpers       */
/* -------------------------------------------------------------------------- */

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colLettersToIndex(ref) {
  const letters = String(ref || '').replace(/\d+/g, '').toUpperCase();
  let index = 0;
  for (let i = 0; i < letters.length; i += 1) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, index - 1);
}

function colIndexToLetters(index) {
  let n = index + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function excelSerialToIso(value) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 25569 && num < 70000) {
    const utcMs = Math.round((num - 25569) * 86400 * 1000);
    const d = new Date(utcMs);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return String(value ?? '').trim();
}

/**
 * Parses CSV/TSV text into an array of row objects keyed by header names.
 */
export function parseCsvText(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] || '';
  const delimiter =
    firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(field.trim());
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell !== '')) rows.push(row);
  }

  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = cells[idx] ?? '';
    });
    return obj;
  });
}

async function inflateRawBytes(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser DecompressionStream API is unavailable for compressed .xlsx files.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

async function extractZipTextEntries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const decoder = new TextDecoder('utf-8');

  // Find End of Central Directory (PK\x05\x06)
  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minOffset; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid .xlsx archive (ZIP directory not found).');
  }

  const totalEntries = readUint16LE(bytes, eocdOffset + 10);
  const cdOffset = readUint32LE(bytes, eocdOffset + 16);

  const entries = new Map();
  let ptr = cdOffset;

  for (let i = 0; i < totalEntries && ptr + 46 <= bytes.length; i += 1) {
    if (
      bytes[ptr] !== 0x50 ||
      bytes[ptr + 1] !== 0x4b ||
      bytes[ptr + 2] !== 0x01 ||
      bytes[ptr + 3] !== 0x02
    ) {
      break;
    }

    const method = readUint16LE(bytes, ptr + 10);
    const compSize = readUint32LE(bytes, ptr + 20);
    const nameLen = readUint16LE(bytes, ptr + 28);
    const extraLen = readUint16LE(bytes, ptr + 30);
    const commentLen = readUint16LE(bytes, ptr + 32);
    const localHeaderOffset = readUint32LE(bytes, ptr + 42);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

    ptr += 46 + nameLen + extraLen + commentLen;

    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;

    const lfhNameLen = readUint16LE(bytes, localHeaderOffset + 26);
    const lfhExtraLen = readUint16LE(bytes, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const rawSlice = bytes.subarray(dataStart, dataStart + compSize);

    let unpacked;
    if (method === 0) {
      unpacked = rawSlice;
    } else if (method === 8) {
      unpacked = await inflateRawBytes(rawSlice);
    } else {
      throw new Error(`Unsupported ZIP compression method (${method}) in .xlsx file.`);
    }
    entries.set(name, decoder.decode(unpacked));
  }

  return entries;
}

function parseSharedStringsXml(xml) {
  if (!xml) return [];
  const strings = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = siRegex.exec(xml)) !== null) {
    const inner = match[1];
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let combined = '';
    let tMatch;
    while ((tMatch = tRegex.exec(inner)) !== null) {
      combined += decodeXmlEntities(tMatch[1]);
    }
    strings.push(combined);
  }
  return strings;
}

function parseWorksheetXml(xml, sharedStrings) {
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  const tableRows = [];

  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowContent = rowMatch[1];
    const rowArray = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];

      const refMatch = /\br="([A-Za-z]+\d+)"/.exec(attrs);
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const cellType = typeMatch ? typeMatch[1] : '';
      const colIdx = refMatch ? colLettersToIndex(refMatch[1]) : rowArray.length;

      let value = '';
      if (cellType === 'inlineStr') {
        const tMatches = Array.from(body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g));
        value = tMatches.map((m) => decodeXmlEntities(m[1])).join('');
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const rawVal = vMatch ? decodeXmlEntities(vMatch[1]) : '';
        if (cellType === 's') {
          value = sharedStrings[Number(rawVal)] ?? '';
        } else {
          value = rawVal;
        }
      }

      rowArray[colIdx] = String(value).trim();
    }

    if (rowArray.some((cell) => cell !== undefined && cell !== '')) {
      tableRows.push(rowArray);
    }
  }

  if (tableRows.length < 2) return [];
  const headers = tableRows[0].map((h) => String(h || '').trim());
  return tableRows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = cells[idx] ?? '';
    });
    return obj;
  });
}

/**
 * Parses an Excel (.xlsx) ArrayBuffer across all worksheets into row objects.
 */
export async function parseXlsxBuffer(arrayBuffer) {
  const entries = await extractZipTextEntries(arrayBuffer);
  const sharedStrings = parseSharedStringsXml(entries.get('xl/sharedStrings.xml'));

  const sheetPaths = Array.from(entries.keys())
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (sheetPaths.length === 0) {
    throw new Error('No worksheets found inside .xlsx file.');
  }

  const allRows = [];
  for (const sheetPath of sheetPaths) {
    const rows = parseWorksheetXml(entries.get(sheetPath), sharedStrings);
    allRows.push(...rows);
  }
  return allRows;
}

function getRowField(row, candidates) {
  const normalizedMap = new Map();
  for (const [k, v] of Object.entries(row)) {
    const normKey = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
    normalizedMap.set(normKey, v);
  }
  for (const candidate of candidates) {
    if (normalizedMap.has(candidate)) {
      const val = normalizedMap.get(candidate);
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        return String(val).trim();
      }
    }
  }
  return '';
}

/**
 * Converts flat spreadsheet rows (from .xlsx or .csv) into normalized CI/CD reports,
 * grouping multiple finding/failure rows by (app, version, type).
 */
export function spreadsheetRowsToReports(rows, sourceLabel = 'Spreadsheet') {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const grouped = new Map();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const app = getRowField(row, ['app', 'application', 'service', 'name']);
    const version = getRowField(row, ['version', 'ver', 'release']) || '0.0.0';
    const rawType = getRowField(row, ['type', 'reporttype', 'kind', 'suite']);
    if (!app) continue;

    const appType = getRowField(row, ['apptype', 'platform', 'category']);
    const build = getRowField(row, ['build', 'buildnumber', 'run']);
    const rawDate = getRowField(row, ['createdat', 'date', 'timestamp', 'updatedat']);
    const createdAt = rawDate ? excelSerialToIso(rawDate) : '';

    const findingTitle = getRowField(row, [
      'finding',
      'findingtitle',
      'vulnerability',
      'title',
      'issue',
      'problem',
    ]);
    const severity = getRowField(row, ['severity', 'sev', 'risk']);

    const totalStr = getRowField(row, ['total', 'teststotal', 'totaltests']);
    const passedStr = getRowField(row, ['passed', 'testspassed', 'passedtests']);
    const failedStr = getRowField(row, ['failed', 'testsfailed', 'failedtests']);
    const failureName = getRowField(row, ['failurename', 'testname', 'failedtest', 'test']);
    const failureMessage = getRowField(row, ['failuremessage', 'errormessage', 'message', 'error']);

    const inferredType = rawType
      ? normalizeReportType(rawType, {})
      : findingTitle || severity
        ? 'security'
        : totalStr || passedStr || failedStr || failureName
          ? 'e2e'
          : 'security';

    const key = `${app}::${version}::${inferredType}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        app,
        appType,
        version,
        type: inferredType,
        build,
        createdAt,
        findings: [],
        tests: { total: 0, passed: 0, failed: 0 },
        failures: [],
        _source: sourceLabel,
      });
    }

    const bucket = grouped.get(key);
    if (!bucket.appType && appType) bucket.appType = appType;
    if (!bucket.build && build) bucket.build = build;
    if (createdAt && (!bucket.createdAt || parseTimestamp(createdAt) > parseTimestamp(bucket.createdAt))) {
      bucket.createdAt = createdAt;
    }

    if (inferredType === 'security') {
      if (findingTitle) {
        bucket.findings.push({
          title: findingTitle,
          severity: normalizeSeverity(severity || 'low'),
        });
      }
    } else {
      if (totalStr !== '') bucket.tests.total = Math.max(bucket.tests.total, toNonNegInt(totalStr));
      if (passedStr !== '') bucket.tests.passed = Math.max(bucket.tests.passed, toNonNegInt(passedStr));
      if (failedStr !== '') bucket.tests.failed = Math.max(bucket.tests.failed, toNonNegInt(failedStr));
      if (failureName) {
        bucket.failures.push({
          name: failureName,
          message: failureMessage || 'Failed',
        });
      }
    }
  }

  return normalizeReports(Array.from(grouped.values()));
}

/**
 * Flattens report objects into spreadsheet-friendly rows for Excel export.
 */
export function reportsToSpreadsheetRows(rawReports) {
  const reports = normalizeReports(rawReports);
  const rows = [];

  for (const rep of reports) {
    if (rep.type === 'security') {
      if (rep.findings.length === 0) {
        rows.push({
          app: rep.app,
          appType: rep.appType || 'Service',
          version: rep.version,
          type: rep.type,
          build: rep.build,
          createdAt: rep.createdAt,
          finding: '',
          severity: '',
          total: '',
          passed: '',
          failed: '',
          failureName: '',
          failureMessage: '',
        });
      } else {
        for (const f of rep.findings) {
          rows.push({
            app: rep.app,
            appType: rep.appType || 'Service',
            version: rep.version,
            type: rep.type,
            build: rep.build,
            createdAt: rep.createdAt,
            finding: f.title,
            severity: f.severity,
            total: '',
            passed: '',
            failed: '',
            failureName: '',
            failureMessage: '',
          });
        }
      }
    } else if (rep.failures.length === 0) {
      rows.push({
        app: rep.app,
        appType: rep.appType || 'Service',
        version: rep.version,
        type: rep.type,
        build: rep.build,
        createdAt: rep.createdAt,
        finding: '',
        severity: '',
        total: rep.tests.total,
        passed: rep.tests.passed,
        failed: rep.tests.failed,
        failureName: '',
        failureMessage: '',
      });
    } else {
      for (const fail of rep.failures) {
        rows.push({
          app: rep.app,
          appType: rep.appType || 'Service',
          version: rep.version,
          type: rep.type,
          build: rep.build,
          createdAt: rep.createdAt,
          finding: '',
          severity: '',
          total: rep.tests.total,
          passed: rep.tests.passed,
          failed: rep.tests.failed,
          failureName: fail.name,
          failureMessage: fail.message,
        });
      }
    }
  }

  return rows;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16LE(arr, offset, val) {
  arr[offset] = val & 0xff;
  arr[offset + 1] = (val >>> 8) & 0xff;
}

function writeUint32LE(arr, offset, val) {
  arr[offset] = val & 0xff;
  arr[offset + 1] = (val >>> 8) & 0xff;
  arr[offset + 2] = (val >>> 16) & 0xff;
  arr[offset + 3] = (val >>> 24) & 0xff;
}

function buildWorksheetXmlFromRows(rows) {
  const headers =
    rows.length > 0
      ? Object.keys(rows[0])
      : [
          'app',
          'appType',
          'version',
          'type',
          'build',
          'createdAt',
          'finding',
          'severity',
          'total',
          'passed',
          'failed',
          'failureName',
          'failureMessage',
        ];

  const allGridRows = [
    headers,
    ...rows.map((r) => headers.map((h) => r[h] ?? '')),
  ];

  const xmlRows = allGridRows
    .map((cells, rIdx) => {
      const rowNum = rIdx + 1;
      const cellXml = cells
        .map((val, cIdx) => {
          const ref = `${colIndexToLetters(cIdx)}${rowNum}`;
          if (typeof val === 'number' && Number.isFinite(val)) {
            return `<c r="${ref}"><v>${val}</v></c>`;
          }
          const strVal = String(val ?? '');
          if (strVal === '') return '';
          const styleAttr = rIdx === 0 ? ' s="1"' : '';
          return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t>${escapeXml(strVal)}</t></is></c>`;
        })
        .filter(Boolean)
        .join('');
      return `<row r="${rowNum}">${cellXml}</row>`;
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${xmlRows}</sheetData>` +
    '</worksheet>'
  );
}

/**
 * Generates a valid .xlsx workbook Uint8Array from an array of { name, rows } sheets.
 */
export function buildXlsxBytes(sheets) {
  const encoder = new TextEncoder();
  const safeSheets = sheets.length > 0 ? sheets : [{ name: 'Reports', rows: [] }];

  const files = [
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        safeSheets
          .map(
            (_, idx) =>
              `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' +
        safeSheets
          .map(
            (s, idx) =>
              `<sheet name="${escapeXml(s.name.slice(0, 31))}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`
          )
          .join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        safeSheets
          .map(
            (_, idx) =>
              `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`
          )
          .join('') +
        `<Relationship Id="rId${safeSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    },
    {
      name: 'xl/styles.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '</styleSheet>',
    },
    ...safeSheets.map((s, idx) => ({
      name: `xl/worksheets/sheet${idx + 1}.xml`,
      content: buildWorksheetXmlFromRows(s.rows),
    })),
  ];

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);

    const lfh = new Uint8Array(30 + nameBytes.length);
    writeUint32LE(lfh, 0, 0x04034b50);
    writeUint16LE(lfh, 4, 20);
    writeUint16LE(lfh, 6, 0x0800); // UTF-8 filename flag
    writeUint16LE(lfh, 8, 0); // Store
    writeUint32LE(lfh, 14, crc);
    writeUint32LE(lfh, 18, dataBytes.length);
    writeUint32LE(lfh, 22, dataBytes.length);
    writeUint16LE(lfh, 26, nameBytes.length);
    lfh.set(nameBytes, 30);

    localParts.push(lfh, dataBytes);

    const cdh = new Uint8Array(46 + nameBytes.length);
    writeUint32LE(cdh, 0, 0x02014b50);
    writeUint16LE(cdh, 4, 20);
    writeUint16LE(cdh, 6, 20);
    writeUint16LE(cdh, 8, 0x0800);
    writeUint16LE(cdh, 10, 0);
    writeUint32LE(cdh, 16, crc);
    writeUint32LE(cdh, 20, dataBytes.length);
    writeUint32LE(cdh, 24, dataBytes.length);
    writeUint16LE(cdh, 28, nameBytes.length);
    writeUint32LE(cdh, 42, offset);
    cdh.set(nameBytes, 46);

    centralParts.push(cdh);
    offset += lfh.length + dataBytes.length;
  }

  const cdSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  writeUint32LE(eocd, 0, 0x06054b50);
  writeUint16LE(eocd, 8, files.length);
  writeUint16LE(eocd, 10, files.length);
  writeUint32LE(eocd, 12, cdSize);
  writeUint32LE(eocd, 16, offset);

  const totalSize = offset + cdSize + eocd.length;
  const output = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of localParts) {
    output.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    output.set(part, pos);
    pos += part.length;
  }
  output.set(eocd, pos);

  return output;
}

