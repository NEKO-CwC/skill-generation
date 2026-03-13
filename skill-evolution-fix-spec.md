# skill-evolution 插件修复任务文档（供 OpenCode / 多智能体执行）

## 1. 背景

目标仓库：`NEKO-CwC/skill-generation`

当前在 OpenClaw 2026.3.11 环境中的实测结果表明：插件 **已经被 OpenClaw 正确发现并加载**，但核心工作流并未按预期可靠运行。`openclaw plugins list` / `info` / `doctor` 可以确认插件处于 loaded 状态，说明问题不在“是否安装成功”，而主要在仓库实现本身。OpenClaw 官方文档也确认，插件是 Gateway 进程内加载的 in-process extensions，且 `agent_end` 与 `session_end` 是不同的生命周期钩子。 citeturn749978view2turn749978view3turn749978view4turn749978view0

## 2. 本次修复的总目标

将 `skill-evolution` 修复为一个在当前 OpenClaw 版本下可验证、可审计、可回滚的插件，使其满足以下能力：

1. 可靠捕获工具失败、用户纠正、正反馈。
2. session-local overlay 能够写入到正确目录，并在 prompt 构建时生效。
3. review / patch / merge / rollback 流程能真实读取用户配置，而不是偷偷退回默认值。
4. 路径全部以 workspace 为基准，不依赖进程当前工作目录。
5. 生命周期语义清晰：如果宣称“session 结束复盘”，就必须使用正确的 session 生命周期钩子，或者明确区分 run-end 与 session-end。
6. 可测试：至少具备自动化测试，覆盖工具错误、overlay 落盘、session 结束复盘、manual merge、auto merge、rollback。
7. 可审计：反馈事件不能只放在内存里，重启后仍应可追溯。

## 3. 已确认的问题清单

### 3.1 路径基准错误：大量使用相对路径

当前代码中，overlay、patch、backup、skills 都默认使用相对路径，例如：

- overlay 默认目录：`.skill-overlays`
- patch 目录：`.skill-patches`
- backup 目录：`.skill-backups`
- skill 目录：`skills`

`OverlayStoreImpl` 直接把 `storageDir` 当作根目录拼接，`agent_end` 里又直接读取 `skills/<skill>/SKILL.md`，`MergeManagerImpl` 默认也使用相对的 `skills` / `.skill-patches`。这会导致行为依赖 Gateway 进程当前工作目录，而不是 OpenClaw workspace。实测 session transcript 的 `cwd` 是 `/app`，因此插件很可能会把文件写到 `/app/.skill-overlays`、`/app/.skill-patches` 或 `/app/skills/...`，而不是 `/home/node/.openclaw/workspace/...`。 citeturn907540view2turn907540view1turn907540view3

### 3.2 配置未完整传递到 review / merge / rollback 组件

`SkillEvolutionPlugin` 构造时虽然拿到了 `config`，但初始化 `ReviewRunnerImpl`、`MergeManagerImpl`、`RollbackManagerImpl` 时并没有把该配置继续注入，导致后续流程可能使用各组件内部默认值，而不是 `openclaw.json` 中真实配置。这个问题会直接影响：

- `requireHumanMerge`
- `maxRollbackVersions`
- review 阶段的 merge mode 决策

也就是说，用户在主配置里修改了 auto-merge / rollback 相关设置，后续组件不一定会真正遵守。 citeturn907540view0turn907540view3

### 3.3 工具错误识别过于脆弱，只依赖 `event.isError`

插件注册 `after_tool_call` 时，仅将 `event.isError` 传入内部逻辑；而 `after_tool_call.ts` 也只在 `isError === true` 时触发 `onToolError` overlay 创建。如果某些 OpenClaw 工具失败结果是以结构化 payload 返回，例如包含 `status: "error"` 或 `error` 字段，但 `event.isError` 未被可靠置为 `true`，插件就会漏掉这类失败事件。实测 transcript 中已有失败工具结果，但插件未生成 overlay，说明当前适配不够健壮。 citeturn907540view5turn749978view0

### 3.4 生命周期语义错位：README 说 session-end，代码却挂 `agent_end`

OpenClaw 文档明确区分：

- `agent_end`：一次 agent completion / run 结束后的钩子
- `session_start` / `session_end`：session 生命周期边界

而当前插件将“session 结束复盘”逻辑挂在 `agent_end` 上，并在其中直接执行清理 session overlay 和结束 session 内部状态。这与“session-local overlay”和“session 结束后 review”这套语义并不严格一致。应当明确决定：

- 是按 **run-end** 工作，还是
- 是按 **session-end** 工作

如果宣称 session-end review，则应迁移到 `session_end`，或实现双钩子模型并明确定义职责。 citeturn749978view0turn749978view1turn907540view1

### 3.5 feedback collector 只做内存存储，缺乏可追溯性

`FeedbackCollectorImpl` 仅使用进程内 `Map<sessionId, events[]>` 保存反馈事件，不落盘。这意味着只要 Gateway 重启、插件重载或进程退出，历史反馈就全部丢失。这样既无法支持“最近三次工作记录”类审计需求，也与“根据真实使用持续演进”这一目标不一致。 citeturn907540view6

## 4. 修复范围

本次修复至少覆盖以下文件或模块：

- `src/openclaw.ts`
- `src/plugin/index.ts`
- `src/plugin/config.ts`
- `src/plugin/hooks/after_tool_call.ts`
- `src/plugin/hooks/agent_end.ts`
- `src/plugin/hooks/before_prompt_build.ts`
- `src/plugin/hooks/message_received.ts`
- `src/plugin/overlay/overlay_store.ts`
- `src/plugin/feedback/collector.ts`
- `src/review/merge_manager.ts`
- `src/review/review_runner.ts`
- `src/review/rollback_manager.ts`
- `README.md`
- `docs/` 下安装、配置、故障排查文档
- 测试目录下对应单元测试 / 集成测试

## 5. 目标设计

### 5.1 统一路径解析

新增一个统一的路径解析层，推荐新增：

- `src/shared/paths.ts` 或等价模块

职责：

1. 接收 OpenClaw workspace 根目录。
2. 输出以下绝对路径：
   - overlays dir
   - patches dir
   - backups dir
   - skills dir
   - feedback events dir
3. 如果用户在配置中传入的是相对路径，则相对于 workspace 解析。
4. 如果传入的是绝对路径，则原样使用。

建议默认目标：

- overlays: `<workspace>/.skill-overlays`
- patches: `<workspace>/.skill-patches`
- backups: `<workspace>/.skill-backups`
- skills: `<workspace>/skills`
- feedback logs: `<workspace>/.skill-feedback`

### 5.2 配置注入必须全链路生效

修改 `SkillEvolutionPlugin` 构造逻辑，将同一份已验证配置显式注入：

- `OverlayStoreImpl`
- `FeedbackCollectorImpl`
- `ReviewRunnerImpl`
- `MergeManagerImpl`
- `RollbackManagerImpl`

所有组件禁止再偷偷使用孤立的内部默认配置，除非该默认配置明确只用于测试构造函数。

### 5.3 工具失败识别增加兜底策略

在 `after_tool_call` 入口增加统一错误判定函数，例如：

- 优先使用 `event.isError === true`
- 若 `event.result` 为对象，检查 `status === "error"`
- 检查是否存在 `error` 字段
- 若 `event.result` 为字符串，匹配常见错误模式，但仅作为低优先级兜底

目标是：即使 OpenClaw 某些工具没有稳定设置 `isError`，插件仍能尽可能识别明显失败。

### 5.4 生命周期重新设计

推荐采用以下方案二选一：

#### 方案 A：严格 session 语义

- `before_prompt_build`：写入 session skillKey、注入 overlay
- `after_tool_call`：收集反馈
- `message_received`：收集纠正/正反馈
- `session_end`：执行 review、patch、merge、清理 session overlay

#### 方案 B：双层语义

- `agent_end`：只做 run 级别统计，不清理 session 状态
- `session_end`：做真正的 session summary / review / cleanup

如果选方案 B，README 和 docs 必须明确写清楚两者职责。

### 5.5 feedback 事件落盘

为反馈事件增加持久化存储。最小设计：

- 每个 session 一个 JSONL 或 JSON 文件
- 目录：`<workspace>/.skill-feedback/<sessionId>.jsonl`
- 每条 event 写入一行或一个数组元素
- 插件启动后可读取已有 session 事件

要求：

- 即使网关重启，仍可审计本次 session 已收集到的反馈
- 测试可以直接断言文件内容

### 5.6 merge / rollback 行为与配置严格一致

当前配置为 `requireHumanMerge: true` 时，应该：

- 不修改 `SKILL.md`
- 不创建 rollback backup
- 仅写入 patch 文件到 `<workspace>/.skill-patches/<skillKey>/<patchId>.md`

当 `requireHumanMerge: false` 时，应该：

- 先备份当前 `SKILL.md` 到 `<workspace>/.skill-backups/...`
- 再覆盖目标 skill 文件
- 执行 rollback prune

这两个模式都必须有测试覆盖。

## 6. 交付标准（Acceptance Criteria）

### AC-1 插件继续可加载

- `openclaw plugins list` 能显示 `skill-evolution` 为 loaded
- `openclaw plugins info skill-evolution` 能正常显示来源与版本
- `openclaw plugins doctor` 不报 manifest / schema / hook 注册错误 citeturn749978view2turn749978view3turn749978view4

### AC-2 overlay 路径正确

当触发一次工具失败后，overlay 必须出现在 workspace 下，而不是随机 cwd：

- `<workspace>/.skill-overlays/<sessionId>/<skillKey>.json`

### AC-3 session / run 语义正确

如果最终设计宣称 session-end review，则：

- review 必须在 `session_end` 触发
- 单次 `agent_end` 不应提前清理 session 级状态

### AC-4 manual merge 模式正确

在 `requireHumanMerge: true` 下：

- 生成 patch 文件
- 原始 `SKILL.md` 不变
- `.skill-backups` 不新增备份

### AC-5 auto merge 模式正确

在 `requireHumanMerge: false` 下：

- 生成 backup
- 修改目标 `SKILL.md`
- 可成功 rollback 到备份版本

### AC-6 工具错误识别更稳健

至少覆盖这 3 种输入：

1. `event.isError = true`
2. `event.result = { status: "error", ... }`
3. `event.result = { error: "..." }`

这三种都能被识别为 `tool_error`。

### AC-7 反馈历史可审计

- 反馈事件落盘
- 网关重启后可读取既有事件
- 测试能验证最近 session 的 event 文件存在且内容正确

## 7. 推荐实施顺序

### Phase 1：重构基础设施

1. 新增路径解析模块
2. 为各组件引入统一 config + paths 注入
3. 修改 overlay / patch / backup / skills / feedback 全部使用绝对路径

### Phase 2：修复生命周期与错误判定

1. 重构 `after_tool_call` 错误识别
2. 调整 `agent_end` / `session_end` 生命周期设计
3. 修复 `before_prompt_build` 与 session skillKey 的协作

### Phase 3：落盘与审计

1. feedback collector 改为持久化实现
2. 增加 session summary / patch / merge 的日志信息
3. 增加错误上下文，便于 `openclaw logs` 排查

### Phase 4：测试与文档

1. 补齐单元测试与集成测试
2. 更新 README / docs
3. 提供“如何验证插件真的工作”的 troubleshooting 文档

## 8. 测试计划

至少补这几类测试：

### 单元测试

- 路径解析：相对路径 / 绝对路径 / workspace 拼接
- 错误识别：`isError` / `status:error` / `error` 字段
- merge policy：manual 与 auto 两种模式
- rollback prune 行为

### 集成测试

#### Case 1：工具失败后生成 overlay

- 构造 sessionId + skillKey
- 触发 `after_tool_call`
- 断言 overlay 文件出现在 workspace 正确路径下

#### Case 2：manual merge

- 配置 `requireHumanMerge: true`
- 准备 skill 原文件
- 构造足够 evidence
- 触发 review pipeline
- 断言 `.skill-patches` 有新文件，`SKILL.md` 未变

#### Case 3：auto merge + backup + rollback

- 配置 `requireHumanMerge: false`
- 准备原始 `SKILL.md`
- 触发 review pipeline
- 断言 `SKILL.md` 被修改
- 断言 `.skill-backups` 有备份
- 执行 rollback
- 断言内容恢复

#### Case 4：session_end 语义

- 在多轮消息和多次 tool call 后
- 仅在 session 结束时触发 review / cleanup
- 断言 overlay 不会在中途 run 结束后提前清掉

## 9. 文档更新要求

README 与 docs 必须修正这些表述：

1. 明确插件是 in-process Gateway plugin。 citeturn749978view2
2. 明确路径默认基于 workspace，而不是 cwd。
3. 明确 `agent_end` 与 `session_end` 的区别；如果项目最终采用其中一种，也要在文档中说清。
4. 明确 manual merge 与 auto merge 的差异：
   - manual：只产 patch
   - auto：修改 `SKILL.md` 并生成 backup
5. 增加排查步骤：
   - `openclaw plugins list`
   - `openclaw plugins info skill-evolution`
   - `openclaw plugins doctor` citeturn749978view2turn749978view3turn749978view4

## 10. 对多智能体执行器的约束

请使用项目中的 `AGENTS` 与 prompts 配置开展多智能体协作，但必须遵守以下限制：

1. 不要重写整个项目，只做最小必要修复。
2. 先读现有测试、README、docs，再开始改代码。
3. 每一阶段完成后必须运行测试，避免一次性大改。
4. 对外行为变化必须同步更新 README 与 docs。
5. 所有路径和生命周期修改都必须有测试，不接受“只靠人工验证”。
6. 不要把“插件已 loaded”误判成“插件已经正常工作”；loaded 只说明被 Gateway 成功发现并注册。 citeturn749978view2turn749978view3

## 11. 建议的多智能体分工

### Agent A：架构与路径修复

负责：

- 路径解析层设计
- config 全链路注入
- overlay / patch / backup / skills 目录改造

输出：

- 新的路径模块
- 相关构造函数改造
- 对应单元测试

### Agent B：生命周期与事件捕获修复

负责：

- `after_tool_call` 错误判定增强
- `agent_end` / `session_end` 语义修复
- feedback collector 持久化

输出：

- hook 逻辑更新
- event 持久化实现
- 生命周期相关测试

### Agent C：merge / rollback / 文档

负责：

- merge policy 与 rollback 行为校准
- README / docs 更新
- troubleshooting 文档补齐

输出：

- merge / rollback 测试
- 文档修订
- 示例配置修订

### Agent D：审查与验收

负责：

- 校验是否真的满足 AC-1 ~ AC-7
- 检查是否还存在相对路径泄漏
- 检查配置是否存在“主配置未注入子组件”的残留

输出：

- 审查报告
- 阻断项清单
- 最终 merge 建议

## 12. 给 OpenCode 的执行提示词

可直接将以下提示词交给 OpenCode：

---

你现在要在仓库 `NEKO-CwC/skill-generation` 中执行一次多智能体协作修复。

你的任务目标不是“让插件看起来 loaded”，而是让它在 OpenClaw 2026.3.11 环境中真实可靠地工作。

请先完整阅读：

- README.md
- docs/
- src/openclaw.ts
- src/plugin/
- src/review/
- tests/
- 本任务文档

然后按以下原则执行：

1. 先做问题确认，再出计划，再改代码。
2. 按模块拆分给多个子 agent，但最终由一个 agent 统一收敛。
3. 优先修复以下问题：
   - 相对路径依赖 cwd
   - config 没有传递给 review/merge/rollback 组件
   - after_tool_call 只依赖 event.isError
   - README 所说的 session-end 与代码里 agent_end 不一致
   - feedback 仅内存存储
4. 所有变更必须补测试。
5. 所有对外行为变化必须更新 README 与 docs。
6. 最终输出要包含：
   - 修改摘要
   - 变更文件列表
   - 测试结果
   - 剩余风险

验收标准：

- 插件仍可被 `openclaw plugins list/info/doctor` 正常识别。
- 触发工具失败后，overlay 出现在 workspace 下正确目录。
- manual merge 仅产 patch，不改 SKILL.md。
- auto merge 会备份并修改 SKILL.md，且可 rollback。
- 反馈历史可落盘审计。
- 生命周期语义与文档一致。

如果发现某个设计目标与 OpenClaw 官方 hook 语义冲突，以 OpenClaw 官方文档为准，并同步修正文档。 citeturn749978view0turn749978view1turn749978view2

---

## 13. 备注

本任务文档刻意偏工程执行而非产品描述，目的是让 OpenCode / 多智能体可以直接拿它作为修复规格说明书使用。
