import { createInterface } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import { setPinned, setUnitStatus, updateUnit } from '../core/units.ts';
import { writeProfileSnapshot } from '../profile/build.ts';
import { activateSkill, recordSkillOutcome } from '../skills/build.ts';

type View = 'candidates' | 'active' | 'skills';

export interface TuiItem {
  id: number;
  label: string;
  subtitle: string;
  status: string;
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

export function loadItems(db: DatabaseSync, view: View): TuiItem[] {
  try {
    if (view === 'skills') {
      const rows = db
        .prepare(
          'SELECT id, name, description, status, use_count, success_count, fail_count FROM skills ORDER BY id DESC LIMIT 200'
        )
        .all() as Array<Record<string, any>>;
      return rows.map((row) => ({
        id: row.id,
        label: `[${row.id}] ${row.status}  ${row.name}`,
        subtitle: `${row.description ?? ''}  use=${row.use_count ?? 0} ok=${row.success_count ?? 0} fail=${row.fail_count ?? 0}`,
        status: row.status,
      }));
    }
    const status = view === 'candidates' ? 'candidate' : 'active';
    const rows = db
      .prepare(
        `SELECT id, type, statement, confidence, scope, coalesce(pinned, 0) pinned
         FROM memory_units WHERE status = ? ORDER BY pinned DESC, confidence DESC, id DESC LIMIT 200`
      )
      .all(status) as Array<Record<string, any>>;
    return rows.map((row) => ({
      id: row.id,
      label: `[${row.id}]${row.pinned ? ' ★' : ''} ${row.type}  conf=${Number(row.confidence).toFixed(2)}`,
      subtitle: `${row.statement}  (${row.scope})`,
      status,
    }));
  } catch {
    return [];
  }
}

function draw(view: View, items: TuiItem[], cursor: number, status: string): void {
  let out = '\x1b[2J\x1b[H';
  out += 'mem review TUI   [1] candidates  [2] active  [3] skills\n\n';
  if (items.length === 0) {
    out += '  (no items in this view)\n';
  } else {
    items.forEach((item, index) => {
      const marker = index === cursor ? '▶ ' : '  ';
      out += `${marker}${item.label}\n     ${item.subtitle}\n`;
    });
  }
  out += `\n${status}\n`;
  out +=
    'j/k move  Tab switch  a approve/activate  r reject/retire  p pin  u unpin  e edit  o success  x fail  q quit\n';
  process.stdout.write(out);
}

export function runTui(db: DatabaseSync): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    (['candidates', 'active', 'skills'] as View[]).forEach((view, index) => {
      const items = loadItems(db, view);
      console.log(`${index + 1}. ${view} (${items.length})`);
      for (const item of items) console.log(`   ${item.label}\n     ${item.subtitle}`);
    });
    console.log('run this command in an interactive terminal for the full TUI');
    return;
  }

  let view: View = 'candidates';
  let cursor = 0;
  let status = 'ready';
  let items = loadItems(db, view);

  const reload = () => {
    items = loadItems(db, view);
    cursor = clampIndex(cursor, items.length);
    draw(view, items, cursor, status);
  };
  const selected = () => items[cursor];

  const editSelected = () => {
    const item = selected();
    if (!item || view === 'skills') return;
    process.stdin.setRawMode(false);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('new statement: ', (answer) => {
      rl.close();
      if (answer.trim()) {
        updateUnit(db, item.id, { statement: answer.trim() });
        writeProfileSnapshot(db);
        status = `unit ${item.id} updated`;
      }
      process.stdin.setRawMode(true);
      reload();
    });
  };

  const onData = (key: string) => {
    if (key === 'q' || key === '\u0003') {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[2J\x1b[H');
      return;
    }
    if (key === '\t') {
      view = view === 'candidates' ? 'active' : view === 'active' ? 'skills' : 'candidates';
      cursor = 0;
      reload();
      return;
    }
    if (key === '1' || key === '2' || key === '3') {
      view = key === '1' ? 'candidates' : key === '2' ? 'active' : 'skills';
      cursor = 0;
      reload();
      return;
    }
    if (key === 'j' || key === '\x1b[B') {
      cursor = clampIndex(cursor + 1, items.length);
      draw(view, items, cursor, status);
      return;
    }
    if (key === 'k' || key === '\x1b[A') {
      cursor = clampIndex(cursor - 1, items.length);
      draw(view, items, cursor, status);
      return;
    }
    const item = selected();
    if (!item) return;
    if (key === 'a') {
      if (view === 'candidates') {
        setUnitStatus(db, item.id, 'active');
        status = `unit ${item.id} approved`;
        writeProfileSnapshot(db);
      } else if (view === 'skills') {
        const result = activateSkill(db, item.id);
        status = result ? `skill ${item.id} -> ${result.path}` : `skill ${item.id} not found`;
      }
      reload();
      return;
    }
    if (key === 'r') {
      if (view === 'skills') {
        db.prepare(`UPDATE skills SET status = 'rejected', updated_at = ? WHERE id = ?`).run(
          new Date().toISOString(),
          item.id
        );
        status = `skill ${item.id} rejected`;
      } else {
        setUnitStatus(db, item.id, view === 'active' ? 'retired' : 'rejected');
        status = `unit ${item.id} ${view === 'active' ? 'retired' : 'rejected'}`;
        writeProfileSnapshot(db);
      }
      reload();
      return;
    }
    if (view !== 'skills' && (key === 'p' || key === 'u')) {
      setPinned(db, item.id, key === 'p');
      status = `unit ${item.id} ${key === 'p' ? 'pinned' : 'unpinned'}`;
      writeProfileSnapshot(db);
      reload();
      return;
    }
    if (key === 'e') {
      editSelected();
      return;
    }
    if (view === 'skills' && (key === 'o' || key === 'x')) {
      recordSkillOutcome(db, item.id, key === 'o');
      status = `skill ${item.id} outcome recorded (${key === 'o' ? 'success' : 'fail'})`;
      reload();
    }
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  reload();
}
