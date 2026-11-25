import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import {
  getDbStats,
  initDatabase,
  queryAll,
  queryOne,
  runSql,
  runTransaction,
} from './db.js';
import { DEFAULT_POLICY, normalizeReports } from '../src/analysis.js';
import { generateSampleReports } from '../src/sampleData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;
const DIST_DIR = path.join(__dirname, '..', 'dist');

function makeId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendAuditRow(action, detail, timestamp = new Date().toISOString(), persist = true) {
  runSql(
    'INSERT INTO audit_logs (id, timestamp, action, detail) VALUES (?, ?, ?, ?)',
    [makeId('aud'), timestamp, String(action), String(detail)],
    persist
  );
}

function hydrateReportRow(row) {
  let parsedPayload = {};
  try {
    parsedPayload = JSON.parse(row.payload_json || '{}');
  } catch {
    parsedPayload = {};
  }
  return {
    ...parsedPayload,
    app: row.app,
    appType: row.app_type,
    version: row.version,
    type: row.type,
    build: row.build,
    createdAt: row.created_at,
    _source: row.source || 'Database',
    _uploadId: row.id,
    _dbId: row.id,
  };
}

function hydrateTaskRow(row) {
  return {
    id: row.id,
    app: row.app,
    version: row.version,
    priorityCode: row.priority_code,
    team: row.team,
    owner: row.owner || 'Unassigned',
    source: row.source || 'Custom',
    title: row.title,
    status: row.status,
    suggestionKey: row.suggestion_key || null,
    createdAt: row.created_at,
  };
}

function readBootstrapPayload() {
  const reportRows = queryAll('SELECT * FROM reports ORDER BY uploaded_at ASC, rowid ASC');
  const taskRows = queryAll('SELECT * FROM tasks ORDER BY created_at DESC');
  const signOffRows = queryAll('SELECT * FROM sign_offs');
  const policyRow = queryOne('SELECT value_json FROM settings WHERE key = ?', ['policy']);
  const auditRows = queryAll('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100');

  const signOffs = {};
  for (const row of signOffRows) {
    signOffs[row.app_version_key] = {
      decision: row.decision,
      updatedAt: row.updated_at,
    };
  }

  let policy = DEFAULT_POLICY;
  if (policyRow?.value_json) {
    try {
      const parsed = JSON.parse(policyRow.value_json);
      policy = {
        ...DEFAULT_POLICY,
        ...parsed,
        weights: { ...DEFAULT_POLICY.weights, ...(parsed.weights || {}) },
        thresholds: { ...DEFAULT_POLICY.thresholds, ...(parsed.thresholds || {}) },
      };
    } catch {
      policy = DEFAULT_POLICY;
    }
  }

  return {
    reports: reportRows.map(hydrateReportRow),
    tasks: taskRows.map(hydrateTaskRow),
    signOffs,
    policy,
    auditLog: auditRows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      action: row.action,
      detail: row.detail,
    })),
    stats: getDbStats(),
  };
}

async function startServer() {
  await initDatabase();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      ...getDbStats(),
    });
  });

  app.get('/api/bootstrap', (_req, res) => {
    res.json(readBootstrapPayload());
  });

  // Reports endpoints
  app.post('/api/reports/bulk', (req, res) => {
    const incoming = Array.isArray(req.body?.reports) ? req.body.reports : [];
    const normalized = normalizeReports(incoming);
    if (normalized.length === 0) {
      return res.status(400).json({ error: 'No valid report objects provided' });
    }

    const now = new Date().toISOString();
    const inserted = runTransaction(() => {
      const created = [];
      for (const rep of normalized) {
        const id = rep._uploadId || makeId('rep');
        const source = rep._source || 'Uploaded via API';
        const payloadJson = JSON.stringify({
          findings: rep.findings,
          tests: rep.tests,
          failures: rep.failures,
        });
        runSql(
          `INSERT OR REPLACE INTO reports
            (id, app, app_type, version, type, build, created_at, source, payload_json, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            rep.app,
            rep.appType || '',
            rep.version,
            rep.type,
            rep.build || '',
            rep.createdAt || '',
            source,
            payloadJson,
            now,
          ],
          false
        );
        created.push({
          ...rep,
          _source: source,
          _uploadId: id,
          _dbId: id,
        });
      }
      appendAuditRow(
        'Reports saved to DB',
        `Stored ${created.length} report(s) in SQLite`,
        now,
        false
      );
      return created;
    });

    return res.status(201).json({ reports: inserted, stats: getDbStats() });
  });

  app.post('/api/reports/seed', (_req, res) => {
    const samples = normalizeReports(
      generateSampleReports().map((r) => ({ ...r, _source: 'DB Seed (sampleData)' }))
    );
    const now = new Date().toISOString();

    const inserted = runTransaction(() => {
      const created = [];
      for (let i = 0; i < samples.length; i += 1) {
        const rep = samples[i];
        const id = `seed-${rep.app}-${rep.version}-${rep.type}-${i}`;
        runSql(
          `INSERT OR REPLACE INTO reports
            (id, app, app_type, version, type, build, created_at, source, payload_json, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            rep.app,
            rep.appType || '',
            rep.version,
            rep.type,
            rep.build || '',
            rep.createdAt || '',
            'DB Seed (sampleData)',
            JSON.stringify({
              findings: rep.findings,
              tests: rep.tests,
              failures: rep.failures,
            }),
            now,
          ],
          false
        );
        created.push({
          ...rep,
          _source: 'DB Seed (sampleData)',
          _uploadId: id,
          _dbId: id,
        });
      }
      appendAuditRow(
        'Database seeded',
        `Seeded ${created.length} sample reports (7 apps) into SQLite`,
        now,
        false
      );
      return created;
    });

    return res.status(201).json({ reports: inserted, stats: getDbStats() });
  });

  app.delete('/api/reports/:id', (req, res) => {
    const { id } = req.params;
    const existing = queryOne('SELECT app, version, type FROM reports WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Report not found' });
    }
    runTransaction(() => {
      runSql('DELETE FROM reports WHERE id = ?', [id], false);
      appendAuditRow(
        'Report deleted',
        `Removed ${existing.app} v${existing.version} (${existing.type}) from DB`,
        new Date().toISOString(),
        false
      );
    });
    return res.json({ ok: true, stats: getDbStats() });
  });

  app.delete('/api/reports', (_req, res) => {
    runTransaction(() => {
      runSql('DELETE FROM reports', [], false);
      appendAuditRow(
        'Stored reports cleared',
        'Cleared uploaded/seeded reports from SQLite',
        new Date().toISOString(),
        false
      );
    });
    return res.json({ ok: true, stats: getDbStats() });
  });

  // Tasks endpoints
  app.post('/api/tasks', (req, res) => {
    const rawList = Array.isArray(req.body?.tasks)
      ? req.body.tasks
      : req.body && typeof req.body === 'object'
        ? [req.body]
        : [];

    if (rawList.length === 0) {
      return res.status(400).json({ error: 'No tasks provided' });
    }

    const created = runTransaction(() => {
      const saved = [];
      for (const item of rawList) {
        const title = String(item.title || '').trim();
        if (!title) continue;
        const task = {
          id: item.id || makeId('tsk'),
          app: String(item.app || 'Unknown App'),
          version: String(item.version || '0.0.0'),
          priorityCode: String(item.priorityCode || 'P4'),
          team: String(item.team || 'Testing'),
          owner: String(item.owner || 'Unassigned'),
          source: String(item.source || 'Custom'),
          title,
          status: String(item.status || 'todo'),
          suggestionKey: item.suggestionKey || null,
          createdAt: item.createdAt || new Date().toISOString(),
        };
        runSql(
          `INSERT OR REPLACE INTO tasks
            (id, app, version, priority_code, team, owner, source, title, status, suggestion_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            task.id,
            task.app,
            task.version,
            task.priorityCode,
            task.team,
            task.owner,
            task.source,
            task.title,
            task.status,
            task.suggestionKey,
            task.createdAt,
          ],
          false
        );
        saved.push(task);
      }
      if (saved.length === 1) {
        appendAuditRow(
          'Task assigned',
          `${saved[0].team}: "${saved[0].title}" (${saved[0].app} v${saved[0].version})`,
          new Date().toISOString(),
          false
        );
      } else if (saved.length > 1) {
        appendAuditRow(
          'Batch tasks assigned',
          `Created ${saved.length} tasks in SQLite`,
          new Date().toISOString(),
          false
        );
      }
      return saved;
    });

    return res.status(201).json({ tasks: created, stats: getDbStats() });
  });

  app.patch('/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    const existing = queryOne('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const nextStatus = req.body?.status !== undefined ? String(req.body.status) : existing.status;
    const nextOwner = req.body?.owner !== undefined ? String(req.body.owner) : existing.owner;

    runTransaction(() => {
      runSql(
        'UPDATE tasks SET status = ?, owner = ? WHERE id = ?',
        [nextStatus, nextOwner, id],
        false
      );
      if (nextStatus !== existing.status) {
        appendAuditRow(
          'Task moved',
          `"${existing.title}" (${existing.app}) → ${nextStatus}`,
          new Date().toISOString(),
          false
        );
      }
    });

    const updated = hydrateTaskRow(queryOne('SELECT * FROM tasks WHERE id = ?', [id]));
    return res.json({ task: updated, stats: getDbStats() });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    const existing = queryOne('SELECT title, app FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }
    runTransaction(() => {
      runSql('DELETE FROM tasks WHERE id = ?', [id], false);
      appendAuditRow(
        'Task removed',
        `"${existing.title}" (${existing.app})`,
        new Date().toISOString(),
        false
      );
    });
    return res.json({ ok: true, stats: getDbStats() });
  });

  app.delete('/api/tasks', (req, res) => {
    const status = req.query.status ? String(req.query.status) : '';
    runTransaction(() => {
      if (status) {
        const count = queryOne('SELECT COUNT(*) AS count FROM tasks WHERE status = ?', [status])?.count || 0;
        runSql('DELETE FROM tasks WHERE status = ?', [status], false);
        appendAuditRow(
          'Completed tasks cleared',
          `Removed ${count} ${status} task(s) from SQLite`,
          new Date().toISOString(),
          false
        );
      } else {
        runSql('DELETE FROM tasks', [], false);
        appendAuditRow('All tasks cleared', 'Cleared tasks table', new Date().toISOString(), false);
      }
    });
    return res.json({ ok: true, stats: getDbStats() });
  });

  // Sign-offs endpoints
  app.put('/api/signoffs', (req, res) => {
    const appName = String(req.body?.app || '').trim();
    const version = String(req.body?.version || '').trim();
    const decision = req.body?.decision ? String(req.body.decision) : null;

    if (!appName || !version) {
      return res.status(400).json({ error: 'app and version are required' });
    }

    const key = `${appName}::${version}`;
    const now = new Date().toISOString();

    runTransaction(() => {
      if (!decision) {
        runSql('DELETE FROM sign_offs WHERE app_version_key = ?', [key], false);
        appendAuditRow('Sign-off cleared', `${appName} v${version}`, now, false);
      } else {
        runSql(
          `INSERT OR REPLACE INTO sign_offs (app_version_key, app, version, decision, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [key, appName, version, decision, now],
          false
        );
        appendAuditRow(`Release ${decision}`, `${appName} v${version}`, now, false);
      }
    });

    return res.json({
      ok: true,
      key,
      signOff: decision ? { decision, updatedAt: now } : null,
      stats: getDbStats(),
    });
  });

  // Policy endpoint
  app.put('/api/policy', (req, res) => {
    const nextPolicy = req.body?.policy;
    if (!nextPolicy || typeof nextPolicy !== 'object') {
      return res.status(400).json({ error: 'Invalid policy payload' });
    }
    const now = new Date().toISOString();
    runTransaction(() => {
      runSql(
        'INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
        ['policy', JSON.stringify(nextPolicy), now],
        false
      );
      appendAuditRow('Policy updated', 'Saved release gate thresholds to SQLite', now, false);
    });
    return res.json({ ok: true, policy: nextPolicy, stats: getDbStats() });
  });

  // Audit log endpoints
  app.delete('/api/audit', (_req, res) => {
    runSql('DELETE FROM audit_logs');
    return res.json({ ok: true, stats: getDbStats() });
  });

  // Serve built frontend in production if dist/ exists
  if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      return res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`[Release Control API] Running on http://localhost:${PORT}`);
    console.log(`[Release Control DB]  SQLite file: ${getDbStats().dbPath}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Release Control API:', err);
  process.exit(1);
});
