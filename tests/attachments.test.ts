import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ingestHookAttachments } from '../src/ingest/attachments.ts';
import { ingestSessionDir } from '../src/ingest/sessions.ts';
import { openDb } from '../src/store/db.ts';

test('session images and checkpoint files become blobs and records', () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-attach-'));
  const previous = process.env.MEM_HOME;
  process.env.MEM_HOME = home;
  try {
    const db = openDb(join(home, 'db', 'memory.db'));
    const sessionDir = join(home, 'sessions', 'attach_session');
    mkdirSync(join(sessionDir, 'checkpoints'), { recursive: true });
    writeFileSync(
      join(sessionDir, 'attach_session.json'),
      JSON.stringify({ session_id: 'attach_session', source: 'cline', status: 'completed' })
    );
    const imageBase64 = Buffer.from('fake-png-bytes').toString('base64');
    writeFileSync(
      join(sessionDir, 'attach_session.messages.json'),
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { media_type: 'image/png', data: imageBase64 } }],
          },
        ],
      })
    );
    writeFileSync(join(sessionDir, 'checkpoints', 'state.json'), JSON.stringify({ step: 3 }));

    assert.equal(ingestSessionDir(db, sessionDir), true);
    const attachment = db
      .prepare(
        `SELECT kind, mime, hash, size FROM attachments WHERE session_id = 'attach_session'`
      )
      .get() as { kind: string; mime: string; hash: string; size: number };
    assert.equal(attachment.kind, 'image');
    assert.equal(attachment.mime, 'image/png');
    assert.ok(attachment.size > 0);
    assert.ok(existsSync(join(home, 'blobs', `${attachment.hash}.bin`)));

    const artifact = db
      .prepare(
        `SELECT relpath, hash FROM artifacts WHERE session_id = 'attach_session'`
      )
      .get() as { relpath: string; hash: string };
    assert.equal(artifact.relpath, 'checkpoints/state.json');
    assert.ok(existsSync(join(home, 'blobs', `${artifact.hash}.bin`)));
    assert.match(
      readFileSync(join(home, 'blobs', `${artifact.hash}.bin`), 'utf8'),
      /"step":3/
    );

    const dataUrl = `data:text/plain;base64,${Buffer.from('hook attachment').toString('base64')}`;
    db.prepare(
      `INSERT INTO hook_events (dedupe_key, event, task_id, payload_json)
       VALUES ('k_attach', 'UserPromptSubmit', 'conv_attach', ?)`
    ).run(JSON.stringify({ taskId: 'conv_attach', userPromptSubmit: { attachments: [dataUrl] } }));
    assert.ok(ingestHookAttachments(db) >= 1);
    const hookAttachment = db
      .prepare(`SELECT hash FROM attachments WHERE origin = 'hook'`)
      .get() as { hash: string };
    assert.ok(existsSync(join(home, 'blobs', `${hookAttachment.hash}.bin`)));
    db.close();
  } finally {
    if (previous === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previous;
  }
});
