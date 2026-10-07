import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadDistillConfig, type DistillConfig } from '../src/core/config.ts';
import { forgetSession, isForgotten } from '../src/core/forget.ts';
import { ingestHookAttachments } from '../src/ingest/attachments.ts';
import { ingestHookDir, ingestHookFile } from '../src/ingest/hooks.ts';
import { ingestAllSessions, ingestSessionDir } from '../src/ingest/sessions.ts';
import { correlateSessions } from '../src/ingest/correlate.ts';
import { updateSessionLifecycle } from '../src/ingest/lifecycle.ts';
import { generateSessionCards } from '../src/ingest/cards.ts';
import { mergeHookToolDurations } from '../src/ingest/tool_durations.ts';
import { ingestInjectionDir } from '../src/ingest/injections.ts';
import { backfillTurnSegments } from '../src/ingest/backfill.ts';
import { rebuildPaths, listPaths } from '../src/core/trajectory.ts';
import { buildBundle, distillSessions } from '../src/distill/run.ts';
import { insertUnit, listUnits, setUnitStatus, updateUnitUsage } from '../src/core/units.ts';
import { writeProfileSnapshot, profilesDir } from '../src/profile/build.ts';
import { activateSkill, draftSkill, recordSkillOutcome } from '../src/skills/build.ts';
import { exportStore, importStore } from '../src/core/portable.ts';
import { redactRawStore, scanStore } from '../src/core/scan.ts';
import { embedPendingTurns, semanticSearch, type EmbeddingConfig } from '../src/embed/embed.ts';
import { hooksDoctor } from '../src/core/hooks_doctor.ts';
import { openDb } from '../src/store/db.ts';

const WORKSPACE = '/tmp/e2e-workspace';

interface SessionSpec {
  id: string;
  prompt: string;
  status: string;
  tools: Array<{ name: string; success: boolean; result: string }>;
  image?: boolean;
  checkpoint?: boolean;
  skillCall?: boolean;
}

function writeSession(root: string, spec: SessionSpec): string {
  const dir = join(root, spec.id);
  mkdirSync(dir, { recursive: true });
  const started = new Date(1791294000000 + Math.floor(Math.random() * 1_000_000)).toISOString();
  writeFileSync(
    join(dir, `${spec.id}.json`),
    JSON.stringify({
      session_id: spec.id,
      source: 'cline',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      cwd: WORKSPACE,
      workspace_root: WORKSPACE,
      status: spec.status,
      started_at: started,
      updated_at: started,
      prompt: spec.prompt,
      metadata: { tokensIn: 100, tokensOut: 50, title: spec.prompt },
    })
  );
  const messages: unknown[] = [
    { role: 'user', content: [{ type: 'text', text: `<user_input mode="act">${spec.prompt}</user_input>` }] },
  ];
  if (spec.image) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'image',
          source: { media_type: 'image/png', data: Buffer.from('e2e-image').toString('base64') },
        },
      ],
    });
  }
  spec.tools.forEach((tool, index) => {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: `${spec.id}-call-${index}`, name: tool.name, input: { arg: index } },
      ],
    });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `${spec.id}-call-${index}`,
          name: tool.name,
          content: [{ success: tool.success, result: tool.result }],
          is_error: !tool.success,
        },
      ],
    });
  });
  messages.push({ role: 'assistant', content: [{ type: 'text', text: '任务完成。' }] });
  writeFileSync(
    join(dir, `${spec.id}.messages.json`),
    JSON.stringify({ updated_at: started, system_prompt: 'sys', messages })
  );
  if (spec.checkpoint) {
    mkdirSync(join(dir, 'checkpoints'), { recursive: true });
    writeFileSync(join(dir, 'checkpoints', 'state.json'), JSON.stringify({ step: 7 }));
  }
  return dir;
}

function hookLine(event: string, taskId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event,
    received_at: new Date().toISOString(),
    payload: {
      clineVersion: '4.1.22',
      hookName: event,
      taskId,
      timestamp: String(1791294000000),
      workspaceRoots: [WORKSPACE],
      model: { provider: 'unknown', slug: 'unknown' },
      ...extra,
    },
  });
}

function buildEnvironment(): {
  home: string;
  sessionsDir: string;
  skillsDir: string;
  hooksDir: string;
  env: NodeJS.ProcessEnv;
} {
  const home = mkdtempSync(join(tmpdir(), 'mem-e2e-'));
  const sessionsDir = join(home, 'cline', 'sessions');
  const skillsDir = join(home, 'cline', 'skills');
  const hooksDir = join(home, 'hooks');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  const env = {
    ...process.env,
    MEM_HOME: home,
    MEM_DB: join(home, 'db', 'memory.db'),
    CLINE_DATA_DIR: join(home, 'cline'),
    CLINE_SKILLS_DIR: skillsDir,
    CLINE_HOOKS_DIR: hooksDir,
    CLINE_HOOK_DIR: hooksDir,
  };
  return { home, sessionsDir, skillsDir, hooksDir, env };
}

function mockDistillFetch(units: unknown[]): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                units,
                session: {
                  summary: 'E2E 会话总结',
                  decisions: ['采用方案 A'],
                  open_questions: ['是否补充本地模型'],
                  lessons: ['先验证再扩展'],
                },
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;
}

function runPipeline(db: ReturnType<typeof openDb>, env: NodeJS.ProcessEnv, sessionsDir: string, hooksDir: string): void {
  const rawDir = join(env.MEM_HOME!, 'raw', 'hooks');
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(
    join(rawDir, 'e2e.jsonl'),
    [
      hookLine('TaskStart', 'conv_good', { taskStart: { taskMetadata: { taskId: 'conv_good', ulid: '', initialTask: '部署' } } }),
      hookLine('TaskResume', 'conv_good', {}),
      hookLine('UserPromptSubmit', 'conv_good', {
        userPromptSubmit: {
          prompt: '<user_input mode="act">部署项目到生产环境</user_input>',
          attachments: [
            `data:text/plain;base64,${Buffer.from('prompt attachment').toString('base64')}`,
          ],
        },
      }),
      hookLine('PreToolUse', 'conv_good', { preToolUse: { toolName: 'run_commands', parameters: {} } }),
      hookLine('PostToolUse', 'conv_good', {
        postToolUse: { toolName: 'run_commands', parameters: {}, result: 'ok', success: true, executionTimeMs: 42 },
      }),
      hookLine('TaskComplete', 'conv_good', { taskComplete: { taskMetadata: { taskId: 'conv_good', ulid: '', result: 'done', command: '' } } }),
      hookLine('TaskStart', 'conv_bad', { taskStart: { taskMetadata: { taskId: 'conv_bad', ulid: '', initialTask: '部署' } } }),
      hookLine('TaskComplete', 'conv_bad', { taskComplete: { taskMetadata: { taskId: 'conv_bad', ulid: '', result: 'failed', command: '' } } }),
      hookLine('TaskCancel', 'conv_cancel', {}),
      hookLine('Notification', 'conv_good', { notification: { event: 'user_attention', source: 'test', message: 'check', severity: 'info' } }),
      hookLine('PreCompact', 'conv_good', {
        preCompact: {
          contextSize: 4096,
          compactionStrategy: 'auto',
          contextJsonPath: join(hooksDir, 'context.json'),
          contextRawPath: join(hooksDir, 'context.raw'),
          tokensIn: 1000,
          tokensOut: 200,
        },
      }),
    ].join('\n') + '\n'
  );
  writeFileSync(join(hooksDir, 'context.json'), '{"before":"compaction"}');
  writeFileSync(join(hooksDir, 'context.raw'), 'raw before compaction');

  ingestHookFile(db, join(rawDir, 'e2e.jsonl'));
  ingestAllSessions(db, sessionsDir);
  correlateSessions(db);
  updateSessionLifecycle(db);
  ingestHookAttachments(db);
  generateSessionCards(db);
  mergeHookToolDurations(db);
  backfillTurnSegments(db);
  ingestInjectionDir(db, join(env.MEM_HOME!, 'raw', 'injections'));
  updateUnitUsage(db);
  rebuildPaths(db);
}

test('e2e: capture, lifecycle, paths, distill, review, profile, skills', async () => {
  const { home, sessionsDir, skillsDir, hooksDir, env } = buildEnvironment();
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const db = openDb(env.MEM_DB!);
    writeSession(sessionsDir, {
      id: 'e2e_good',
      prompt: '部署项目到生产环境',
      status: 'completed',
      tools: [
        { name: 'read_files', success: true, result: 'files' },
        { name: 'run_commands', success: true, result: 'deployed' },
      ],
      checkpoint: true,
    });
    writeSession(sessionsDir, {
      id: 'e2e_bad',
      prompt: '部署项目到生产环境',
      status: 'failed',
      tools: [
        { name: 'run_commands', success: false, result: 'boom' },
        { name: 'run_commands', success: false, result: 'boom again' },
      ],
    });
    writeSession(sessionsDir, {
      id: 'e2e_skill',
      prompt: '用技能完成部署',
      status: 'completed',
      tools: [
        { name: 'use_skill', success: true, result: 'skill loaded' },
        { name: 'mem_recall', success: true, result: 'history rows' },
      ],
      image: true,
    });
    runPipeline(db, env, sessionsDir, hooksDir);

    const lifecycle = (id: string) =>
      (db.prepare('SELECT lifecycle FROM sessions WHERE session_id = ?').get(id) as {
        lifecycle: string;
      }).lifecycle;
    assert.equal(lifecycle('e2e_good'), 'completed');
    assert.equal(lifecycle('e2e_bad'), 'failed');

    assert.ok(
      (db.prepare('SELECT count(*) c FROM attachments').get() as { c: number }).c >= 2,
      'image and hook attachments must be stored'
    );
    assert.ok(
      (db.prepare('SELECT count(*) c FROM artifacts').get() as { c: number }).c >= 1,
      'checkpoint files must be stored'
    );

    const [best] = listPaths(db);
    assert.equal(best.best_session_id, 'e2e_good');
    const bundle = buildBundle(
      db,
      {
        session_id: 'e2e_skill',
        workspace_root: WORKSPACE,
        started_at: null,
        updated_at: null,
        model: 'mock',
        distilled_at: null,
        distill_status: null,
      },
      8000
    );
    assert.match(bundle, /TRAJECTORY/);
    assert.match(bundle, /use_skill/);
    assert.match(bundle, /mem_recall/);

    const config: DistillConfig = {
      provider: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'mock',
      apiKey: '',
      maxSessionsPerRun: 5,
      maxCharsPerSession: 8000,
      temperature: 0,
    };
    const fetchImpl = mockDistillFetch([
      {
        type: 'procedure',
        statement: '部署前先读取文件再运行命令',
        confidence: 0.9,
        relation: 'new',
        evidence: [{ quote: 'deployed' }],
      },
    ]);
    const summary = await distillSessions(db, config, { sessionId: 'e2e_good', fetchImpl });
    assert.equal(summary.units, 1);
    const candidate = listUnits(db, { status: 'candidate', limit: 1 })[0];
    setUnitStatus(db, candidate.id, 'active');
    writeProfileSnapshot(db);
    assert.ok(existsSync(join(profilesDir(), 'TASTE.md')));

    const skillId = await draftSkill(db, config, fetchImpl);
    assert.ok(skillId);
    const activated = activateSkill(db, skillId!);
    assert.ok(activated && existsSync(activated.path));
    assert.match(readFileSync(activated!.path, 'utf8'), /E2E|部署|已验证/);
    assert.equal(recordSkillOutcome(db, skillId!, true), true);
    db.close();
  } finally {
    for (const key of ['MEM_HOME', 'MEM_DB', 'CLINE_DATA_DIR', 'CLINE_SKILLS_DIR', 'CLINE_HOOKS_DIR']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('e2e: hook injection, per-task off switch, and export/import/forget/scan', async () => {
  const { sessionsDir, hooksDir, env } = buildEnvironment();
  Object.assign(process.env, env);
  try {
    const db = openDb(env.MEM_DB!);
    writeSession(sessionsDir, {
      id: 'e2e_inject',
      prompt: '部署项目到生产环境',
      status: 'completed',
      tools: [{ name: 'run_commands', success: true, result: 'ok' }],
    });
    runPipeline(db, env, sessionsDir, hooksDir);
    db.prepare(
      `UPDATE sessions SET hook_task_id = 'conv_inject' WHERE session_id = 'e2e_inject'`
    ).run();
    insertUnit(db, {
      type: 'taste',
      statement: '部署时先给结论',
      status: 'active',
      confidence: 0.9,
    });
    db.close();

    const hook = (prompt: string, taskId = 'conv_new') =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['src/hooks/user_prompt_submit.ts'], {
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.on('close', (code) =>
          code === 0 ? resolve(stdout.trim()) : reject(new Error(String(code)))
        );
        child.stdin.write(
          JSON.stringify({
            taskId,
            workspaceRoots: [WORKSPACE],
            userPromptSubmit: { prompt: `<user_input mode="act">${prompt}</user_input>`, attachments: [] },
          })
        );
        child.stdin.end();
      });

    const injected = JSON.parse(await hook('部署项目要注意什么'));
    assert.match(injected.contextModification, /<memory version="1"/);
    assert.match(injected.contextModification, /<taste>/);

    const off = JSON.parse(await hook('@nomem 部署项目要注意什么'));
    assert.equal(off.contextModification, '');

    const reopened = openDb(env.MEM_DB!);
    const exportDir = join(env.MEM_HOME!, 'export');
    const exported = exportStore(reopened, exportDir);
    assert.ok(exported.units >= 1);
    const second = openDb(join(env.MEM_HOME!, 'db', 'second.db'));
    const imported = importStore(second, exportDir);
    assert.ok(imported.units >= 1);

    const forgetResult = forgetSession(second, 'e2e_inject', { includeActive: false });
    assert.ok(forgetResult.counts.turns >= 0);
    assert.equal(isForgotten(second, 'session', 'e2e_inject'), true);
    assert.equal(ingestSessionDir(second, join(sessionsDir, 'e2e_inject')), false);

    const scan = scanStore(reopened, env.MEM_HOME!);
    assert.ok(scan.filesScanned >= 1);
    void redactRawStore(env.MEM_HOME!);

    second.close();
    reopened.close();
  } finally {
    for (const key of ['MEM_HOME', 'MEM_DB', 'CLINE_DATA_DIR', 'CLINE_SKILLS_DIR', 'CLINE_HOOKS_DIR']) {
      if (env[key] === undefined) delete process.env[key];
    }
  }
});

test('e2e: local embedding search, rerank data, and hooks doctor', async () => {
  const { home, hooksDir, env } = buildEnvironment();
  Object.assign(process.env, env);
  try {
    const db = openDb(env.MEM_DB!);
    db.prepare(`INSERT INTO sessions (session_id, source, status) VALUES ('emb', 'test', 'idle')`).run();
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
       VALUES ('emb', 0, 0, 'user', 'text', '缓存层设计要点')`
    ).run();
    const embedding: EmbeddingConfig = {
      enabled: true,
      provider: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'embeddinggemma-2',
      apiKey: '',
      dimensions: 8,
      taskType: null,
      project: null,
      location: null,
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const embedded = await embedPendingTurns(db, embedding, { fetchImpl });
    assert.equal(embedded.embedded, 1);
    const hits = await semanticSearch(db, embedding, '缓存', { fetchImpl, limit: 3 });
    assert.equal(hits.length, 1);

    for (const event of [
      'TaskStart',
      'TaskResume',
      'TaskCancel',
      'TaskComplete',
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'PreCompact',
      'Notification',
    ]) {
      writeFileSync(join(hooksDir, event), '#!/bin/bash\n');
      chmodSync(join(hooksDir, event), 0o755);
    }
    const status = hooksDoctor(db, hooksDir, 'darwin');
    assert.equal(status.length, 9);
    assert.ok(status.every((row) => row.health === 'warn_never_fired' || row.health === 'ok'));
    db.close();
    assert.ok(existsSync(home));
  } finally {
    for (const key of ['MEM_HOME', 'MEM_DB', 'CLINE_DATA_DIR', 'CLINE_SKILLS_DIR', 'CLINE_HOOKS_DIR']) {
      if (env[key] === undefined) delete process.env[key];
    }
  }
});
