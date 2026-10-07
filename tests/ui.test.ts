import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { insertUnit } from '../src/core/units.ts';
import { openDb } from '../src/store/db.ts';
import { startUi, UI_PAGE } from '../src/ui/server.ts';

test('web UI serves the page, state, and unit actions', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'mem-ui-'));
  const previous = process.env.MEM_HOME;
  process.env.MEM_HOME = home;
  try {
    assert.match(UI_PAGE, /mem UI/);
    assert.match(UI_PAGE, /\/api\/state/);
    assert.match(UI_PAGE, /activate/);

    const db = openDb(join(home, 'db', 'memory.db'));
    const unitId = insertUnit(db, {
      type: 'taste',
      statement: 'Web UI 测试候选',
      status: 'candidate',
    });
    let ui: Awaited<ReturnType<typeof startUi>>;
    try {
      ui = await startUi(db, { port: 0 });
    } catch (error) {
      if (String(error).includes('EPERM')) {
        db.close();
        t.skip('sandbox blocks socket listen; run this test on a normal machine');
        return;
      }
      throw error;
    }
    const base = `http://127.0.0.1:${ui.port}`;

    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /mem UI/);

    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    assert.equal(state.counts.candidates, 1);

    const response = await fetch(`${base}/api/unit/${unitId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(response.status, 200);
    const row = db
      .prepare('SELECT status FROM memory_units WHERE id = ?')
      .get(unitId) as { status: string };
    assert.equal(row.status, 'active');

    ui.close();
    db.close();
  } finally {
    if (previous === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previous;
  }
});
