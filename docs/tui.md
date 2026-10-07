# TUI 使用参考

```bash
memctl tui            # 9 屏完整应用
memctl tui --review   # 仅候选审核（旧界面）
```

## 屏幕与操作

| # | 屏幕 | 内容 | 按键 |
|---|---|---|---|
| 1 | Dashboard | 会话/turns/cards/units/注入/自动蒸馏/最近会话 | – |
| 2 | Sessions | 会话列表 + card 详情 | `d` 蒸馏该会话、`f` 删除会话（输入 yes） |
| 3 | Search | `/` 输入查询，中文分段 FTS | `/` 搜索 |
| 4 | Candidates | 候选 + 证据/用量 | `a` 通过、`r` 拒绝、`e` 编辑、`p/u` 置顶、`f` 忘记 |
| 5 | Active | 已激活单元 | `r` 退休、`p/u` 置顶、`e` 编辑、`f` 忘记 |
| 6 | Skills | 草稿/已激活技能与成效 | `n` 生成、`a` 激活、`r` 拒绝、`o/x` 成功/失败 |
| 7 | Tasks | 任务级 memory/capture 开关 | `m` memory、`c` capture、`i` 新增 task id |
| 8 | Metrics | 注入量、采纳率、Top 使用单元 | – |
| 9 | Config | 模型/key/自动蒸馏/预算/来源 | `a` 自动蒸馏开关、`e` 静默分钟、`x` 导出、`i` 导入、`s` 密钥扫描 |

## 全局按键

| 按键 | 行为 |
|---|---|
| `1-9` / `Tab` / `Shift+Tab` | 切换屏幕 |
| `j/k` 或 `↑/↓` | 移动选中行 |
| `Enter` | 提交输入（输入模式） |
| `Esc` | 取消输入 |
| `q` / `Ctrl+C` | 退出 |

输入模式：`/` 触发搜索；`e` 编辑 statement；`i` 输入 task id 或导入目录；
`x` 输入导出目录（直接回车使用默认 `~/.llm-memory/exports/tui-<ts>`）；
Config 屏 `e` 输入静默分钟。

## 行为细节

- 审核类操作（approve/reject/edit/merge/pin/forget）会同步刷新 TASTE profile。
- Sessions 屏的 `d` 调用蒸馏模型（需要 key），完成后显示
  `sessions/units/errors` 统计；过程中状态栏显示 `distilling …`。
- 所有 TUI 写入直接落到 `~/.llm-memory/db/memory.db`；daemon 无需重启。
- 非 TTY 环境（管道、CI、无交互终端）自动降级：打印各屏文本清单后退出。

## Windows

- PowerShell / Windows Terminal 均可用；启动时自动尝试 `chcp 65001`。
- 老版 conhost 中文是双宽字符，可能有轻微换行偏移，建议用 Windows Terminal。

## 排障

| 现象 | 处理 |
|---|---|
| 中文乱码 | `chcp 65001`，或使用 Windows Terminal |
| 界面不出现/直接退出 | 当前不是 TTY（管道），属预期降级 |
| 蒸馏无反应 | Config 屏确认 key；或 `memctl embed --check` 检查模型连通 |
| 数据不更新 | `memctl status` 看 daemon 是否在写；查看 `~/.llm-memory/logs/memd.out.log` |
