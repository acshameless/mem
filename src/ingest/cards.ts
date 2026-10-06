import type { DatabaseSync } from 'node:sqlite';
import { segmentForSearch } from '../core/tokenize.ts';

interface TurnRow {
  session_id: string;
  turn_index: number;
  block_index: number;
  role: string | null;
  display_role: string | null;
  kind: string | null;
  text: string | null;
}

function stripUserInput(text: string): string {
  return text
    .replace(/^\s*<user_input[^>]*>/i, '')
    .replace(/<\/user_input>\s*$/i, '')
    .trim();
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function extractPaths(parametersJson: string | null): string[] {
  if (!parametersJson) return [];
  const paths = new Set<string>();
  for (const match of parametersJson.matchAll(/"(?:path|file_path|filePath)"\s*:\s*"([^"]+)"/g)) {
    if (match[1]) paths.add(match[1]);
  }
  return [...paths].slice(0, 20);
}

export function generateSessionCards(db: DatabaseSync): number {
  const sessions = db.prepare('SELECT session_id FROM sessions').all() as Array<{
    session_id: string;
  }>;
  const firstUser = db.prepare(
    `SELECT * FROM turns
     WHERE session_id = ? AND role = 'user' AND kind = 'text'
       AND (display_role IS NULL OR display_role != 'system') AND text IS NOT NULL
     ORDER BY turn_index, block_index LIMIT 1`
  );
  const lastAssistant = db.prepare(
    `SELECT * FROM turns
     WHERE session_id = ? AND role = 'assistant' AND kind = 'text' AND text IS NOT NULL
     ORDER BY turn_index DESC, block_index DESC LIMIT 1`
  );
  const tools = db.prepare(
    `SELECT tool_name, count(*) c, sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) failed,
            max(parameters_json) sample
     FROM tool_calls WHERE session_id = ? AND tool_name IS NOT NULL
     GROUP BY tool_name ORDER BY c DESC`
  );
  const upsert = db.prepare(
    `INSERT INTO session_cards
       (session_id, goal, goal_seg, outcome, outcome_seg, tools_json, files_json, errors_json, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       goal=excluded.goal, goal_seg=excluded.goal_seg,
       outcome=excluded.outcome, outcome_seg=excluded.outcome_seg,
       tools_json=excluded.tools_json, files_json=excluded.files_json,
       errors_json=excluded.errors_json, generated_at=excluded.generated_at`
  );

  let generated = 0;
  for (const session of sessions) {
    const userTurn = firstUser.get(session.session_id) as TurnRow | undefined;
    const assistantTurn = lastAssistant.get(session.session_id) as TurnRow | undefined;
    const toolRows = tools.all(session.session_id) as Array<{
      tool_name: string;
      c: number;
      failed: number;
      sample: string | null;
    }>;

    const goal = userTurn?.text ? truncate(stripUserInput(userTurn.text), 400) : '';
    const outcome = assistantTurn?.text ? truncate(assistantTurn.text, 600) : '';
    if (!goal && !outcome) continue;

    const toolList = toolRows.map((row) => ({ name: row.tool_name, count: row.c }));
    const fileSet = new Set<string>();
    for (const row of toolRows) {
      for (const path of extractPaths(row.sample)) fileSet.add(path);
    }
    const errors = toolRows
      .filter((row) => row.failed > 0)
      .map((row) => ({ tool: row.tool_name, failed: row.failed }));

    upsert.run(
      session.session_id,
      goal,
      goal ? segmentForSearch(goal) : null,
      outcome,
      outcome ? segmentForSearch(outcome) : null,
      JSON.stringify(toolList),
      JSON.stringify([...fileSet]),
      JSON.stringify(errors),
      new Date().toISOString()
    );
    generated += 1;
  }
  return generated;
}
