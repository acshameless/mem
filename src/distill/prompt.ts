import type { ChatMessage } from './provider.ts';

export interface ParsedUnit {
  type: string;
  statement: string;
  detail: string | null;
  scope: string;
  confidence: number;
  evidence: unknown[];
  relation: 'new' | 'duplicate' | 'supersedes';
  targetId: number | null;
}

export interface ActiveUnit {
  id: number;
  type: string;
  statement: string;
  scope: string;
}

const SYSTEM_PROMPT = `你是个人记忆蒸馏器。阅读用户与 AI 的对话，提取对未来的 AI 协作长期有价值的信息。

类型定义：
- taste：沟通风格、表达偏好、回答长度、语言偏好
- preference：工具、流程、工作方式偏好
- decision：用户明确做出的选择或决定
- fact：稳定的个人或项目事实
- procedure：已验证有效的做法
- pitfall：踩过的坑、禁忌、明确不喜欢的东西

规则：
- 只提取用户明确表达或强烈暗示、且跨会话可复用的信息。
- 不要提取一次性任务细节、密钥、密码、临时状态。
- statement 用一句中文陈述，最多 80 字。detail 可补充，最多 300 字。
- evidence 引用原文短句，最多 100 字。
- scope 默认 person。只有明确属于某个项目时才用 workspace。
- confidence 取 0-1，不确定时降低。
- relation 规则：与「当前已激活记忆」中的某条语义相同 → duplicate，并给出 target_id；
  新表达是对某条已激活记忆的修订或替代 → supersedes，并给出 target_id；
  其余 → new。
- 没有可提取内容时返回空数组。

只输出 JSON，格式如下：
{"units":[{"type":"taste","statement":"...","detail":"...","scope":"person","confidence":0.8,"relation":"new","target_id":null,"evidence":[{"quote":"..."}]}]}`;

export function buildDistillMessages(bundle: string, activeUnits: ActiveUnit[] = []): ChatMessage[] {
  const activeBlock =
    activeUnits.length > 0
      ? '当前已激活记忆（去重与替换判断用，不要重复提取）：\n' +
        activeUnits
          .map((unit) => `[${unit.id}] ${unit.type} ${unit.scope}: ${unit.statement}`)
          .join('\n') +
        '\n\n---\n'
      : '';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: activeBlock + bundle },
  ];
}

export function parseUnits(text: string): ParsedUnit[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.units) ? parsed.units : [];
  const allowed = new Set(['taste', 'preference', 'decision', 'fact', 'procedure', 'pitfall']);
  const units: ParsedUnit[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type ?? '').trim();
    const statement = String(item.statement ?? '').trim();
    if (!allowed.has(type) || statement.length < 4) continue;
    const confidence = Number(item.confidence);
    const relationRaw = String(item.relation ?? 'new');
    const relation =
      relationRaw === 'duplicate' || relationRaw === 'supersedes' ? relationRaw : 'new';
    const targetRaw = Number(item.target_id ?? item.targetId);
    units.push({
      type,
      statement: statement.slice(0, 300),
      detail: item.detail ? String(item.detail).slice(0, 800) : null,
      scope: typeof item.scope === 'string' && item.scope.startsWith('workspace')
        ? item.scope
        : 'person',
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
      evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 5) : [],
      relation,
      targetId: Number.isInteger(targetRaw) && targetRaw > 0 ? targetRaw : null,
    });
  }
  return units;
}
