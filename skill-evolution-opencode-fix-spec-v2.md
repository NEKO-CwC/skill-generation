# skill-evolution 修复规格文档 v2（面向 OpenCode + 多智能体执行）

## 0. 使用方式

本任务文档用于驱动 OpenCode 在当前仓库中做第二轮修复。

执行要求：

- **必须优先遵守仓库根目录下现有的 `AGENTS.md` 与 prompts 约束。** 本文档是修复规格，不覆盖仓库既有代理协作规范。
- **不要重写整个插件。** 只做最小必要修复。
- **先验证问题，再出计划，再改代码，再跑测试。**
- 所有对外行为变化必须同步更新 `README.md` 与 `docs/`。
- 所有新逻辑都必须补测试，不接受只靠手工验证。

---

## 1. 当前代码审查结论

### 1.1 插件已经不是“没跑起来”，而是“流程能跑、结果不对”

从当前仓库实现可确认：

- 插件已经有 `session_end` 钩子，review/patch/merge 主流程挂在 `session_end` 上。
- 路径已经统一经 `resolvePaths()` 解析到 workspace 下。
- `after_tool_call` 已经加入了 `status === "error"`、`error` 字段和文本错误模式兜底。
- feedback 已落盘到 `.skill-feedback/<sessionId>.jsonl`。

这说明插件现阶段的主要问题不再是“是否加载”，而是：

1. 目标归属错；
2. 错误语义丢失；
3. patch 不可合并；
4. 声称有 LLM 配置，但实际没有 LLM review；
5. default / unknown skill 没有可落地的写回目标。

---

## 2. 新确认的核心问题

### 2.1 **LLM review 目前根本没有接上，这不是偶发 bug，而是未实现功能**

代码事实：

- `README.md` 直接写明：**“No LLMs for review. This version uses deterministic rules for post-session reviews rather than LLM calls.”**
- `ReviewRunnerImpl.runReview()` 只是用 `summary` 计算：
  - `shouldRecommend`
  - `riskLevel`
  - `proposedDiff = summary.overlays.map(...).join('\n\n')`
- `PatchGeneratorImpl.generate()` 只是把 `ReviewResult` 机械拼成文本 patch。
- `SkillEvolutionConfig` 虽然定义了 `llm.inheritPrimaryConfig / modelOverride / thinkingOverride`，但当前 review 路径没有任何模型客户端、API 调用、task tool、provider 调度或 prompt 构建逻辑。

因此结论是：

- 当前“收到了 patch 后不会调用 LLM 给出 skill 修改建议”**不是单点回归**；
- 更准确地说，这是当前仓库版本的**功能缺口 / 设计不完整**；
- `llm.*` 配置目前只是占位字段，不构成真实能力。

### 2.2 default-skill / unknown-skill 没有真实 merge 目标

现在的 merge 目标仍被抽象成：

- `skills/<skillKey>/SKILL.md`

但运行时反馈会落到：

- `default-skill`
- `unknown-skill`

这些 key 并没有对应的真实 skill 目录，导致：

- overlay 能创建；
- feedback 能落盘；
- patch 能生成；
- 但 merge 没有真实目标文件可写。

这不是简单的“缺个文件夹”，而是插件缺少**Target Resolver（目标解析层）**。

### 2.3 patch 生成器产出的是“审计报告”，不是“可合并文档”

当前 `PatchGeneratorImpl.generate()` 产出的是：

- `--- PATCH: ... ---`
- `Patch ID`
- `Risk`
- `Source Session`
- `## Proposed Changes`
- `## Original Content`

这类输出是**审计报告**，不是更新后的 `SKILL.md` 内容。

但 `MergeManagerImpl.merge()` 在 auto-merge 模式下会直接把 `patchContent` 写回 `SKILL.md`。

结果是：

- 如果开启 auto-merge，`SKILL.md` 会被写成一份 patch 报告；
- 而不是被写成新的技能文档。

### 2.4 错误信息在关键链路中仍然退化成 `[object Object]`

运行日志已经证明：

- feedback 里 `messageExcerpt` 变成 `[object Object]`
- overlay 里 `Error excerpt` 变成 `[object Object]`
- patch 里 `Proposed Changes` 也变成 `[object Object]`

这说明当前在 `after_tool_call` 进入插件时，虽然增强了失败判定，但**没有完成错误 payload 的归一化和安全序列化**。

这会直接导致：

- LLM review 即便将来接上，也拿不到可用错误上下文；
- patch 无法形成具体建议；
- 审计价值很差。

### 2.5 exa 错误没有被可靠归因到 exa skill

从现有运行结果看，用户声称“故意触发 exa 错误”，但最终落盘的是：

- `toolName: read`
- `toolName: web_search`
- `skillKey: default-skill`

没有稳定出现：

- `skillKey: exa`
- `toolName` 对应 exa skill wrapper

因此当前插件不能区分：

- 用户提到了 exa；
- 模型真的打算调用 exa；
- 底层真正失败的是 exa skill；
- 还是最终失败落在了别的通用工具上。

这说明系统缺少**错误归因层（Attribution Layer）**。

### 2.6 默认噪音没有被过滤

当前 session startup 中大量 `read` 缺文件（如 memory 文件不存在）也会被当作 skill evolution evidence。

这类错误通常属于：

- 启动流程缺省文件；
- 环境状态；
- 非 skill 本体问题；
- 低价值一次性失败。

如果继续把它们当演化证据，插件会不断学习噪音。

### 2.7 session 内 evidence 仍可能被拆散

当前代码在 `openclaw.ts` 里虽然新增了统一 `resolveSessionId()`，优先级是：

- `sessionId -> sessionKey -> conversationId -> channelId -> unknown-session`

这比之前好多了，但 message correction 是否能稳定和 tool session 合并，仍需集成测试验证。

如果在真实 OpenClaw runtime 里不同 hook 传来的上下文字段不一致，依旧可能出现：

- tool_error 在 UUID session 下；
- user_correction 在 `webchat` 或 channel key 下；
- skillKey 退化为 `unknown-skill`。

---

## 3. 对现有设计的总体判断

### 当前系统已经具备的能力

- 能跑完“收集 -> overlay -> session_end -> patch”主链路；
- 能落盘；
- 能在 manual merge 模式下排队 patch；
- 能捕捉一部分工具失败和用户纠正。

### 当前系统仍不具备的能力

- 不能真实地把错误归给正确 target；
- 不能生成可直接 merge 的 skill 文档内容；
- 不能调用 LLM 生成修改建议；
- 不能正确处理 default / builtin / global 行为；
- 不能避免学习噪音；
- 不能稳定审计原始错误语义。

---

## 4. 本轮修复总目标

把插件从“能产生日志和 patch 报告”升级为“能产出**正确 target、正确语义、正确格式**的修复建议”。

本轮必须同时解决：

1. **LLM review 缺失**
2. **Target Resolver 缺失**
3. **Error Normalizer 缺失**
4. **Patch / Merge 语义错位**
5. **Noise Filter 缺失**
6. **default / builtin / global 三类目标未分层**

---

## 5. 必须落地的新设计

### 5.1 新增 Target Resolver（目标解析层）

不要再把所有反馈都直接塞到 `skillKey -> skills/<skill>/SKILL.md`。

必须新增统一目标类型：

- `skill:<name>` —— 真实技能，例如 `skill:exa`
- `builtin:<tool>` —— 内建工具，例如 `builtin:read`, `builtin:browser`, `builtin:exec`
- `global:default` —— 通用行为 / 全局默认经验
- `unresolved` —— 暂时无法归属

建议输出结构：

```ts
interface EvolutionTarget {
  kind: 'skill' | 'builtin' | 'global' | 'unresolved';
  key: string;            // exa / read / default / unresolved
  storageKey: string;     // 用于目录名
  mergeMode: 'skill-doc' | 'global-doc' | 'queue-only';
}
```

#### 目标路由规则

1. 若 hook context 或 skill metadata 能明确指出某次调用来自 skill，则归到该 skill。
2. 若失败发生在 OpenClaw 内建工具，则归到 `builtin:<tool>`。
3. 若是跨工具通用行为（如“不要连续 retry 同一个缺失路径”），归到 `global:default`。
4. 若无法判断，则先落到 `unresolved`，不能直接当 `default-skill` merge。

---

### 5.2 新增 Global / Builtin 文档层，不要直接改系统 prompt

不要把 default-skill 直接写进 OpenClaw 主系统 prompt。

改成受控文档层：

- `workspace/.skill-global/DEFAULT_SKILL.md`
- `workspace/.skill-global/tools/read.md`
- `workspace/.skill-global/tools/browser.md`
- `workspace/.skill-global/tools/exec.md`

在 `before_prompt_build` 中按 target 选择注入：

- skill 场景：注入 `skills/<skill>/SKILL.md` 的 overlay
- builtin 场景：注入 `.skill-global/tools/<tool>.md`
- global 场景：注入 `.skill-global/DEFAULT_SKILL.md`

好处：

- 可审计
- 可回滚
- 不污染整个系统 prompt
- 支持按工具粒度演化

---

### 5.3 新增 Error Normalizer（错误归一化层）

必须在 `after_tool_call` 早期把错误对象规范化，禁止再让下游直接处理 `unknown` / `object`。

建议新增结构：

```ts
interface NormalizedToolError {
  status: 'error';
  toolName: string;
  message: string;
  errorType?: string;
  exitCode?: number;
  stderr?: string;
  rawExcerpt: string;
  fingerprint: string;
  source: 'event.error' | 'result.status' | 'result.error' | 'text-pattern' | 'unknown';
}
```

#### 归一化规则

优先顺序：

1. `event.error`
2. `result.status === 'error'`
3. `result.error`
4. `stderr / exitCode / message` 等常见字段
5. 文本模式兜底

#### 序列化要求

- 对象必须 JSON-safe stringify
- 带循环引用时安全截断
- 最大长度限制
- 原始 payload 如过大，可另存 blob 文件后在事件里引用

目标是彻底消灭 `[object Object]`。

---

### 5.4 新增 Noise Filter（噪音过滤层）

必须在 evidence 收集前做过滤或降权。

#### 默认忽略或降权的错误

- session startup 预期缺失文件
- 缺省 memory 文件不存在
- 单次探测性 read 失败
- 与 skill 本体无关的环境错误
- 用户只是口头提到某 skill，但没有真实执行链路

#### 至少支持两种处理

- `ignore`：不写 overlay，不参与 review
- `low-signal`：仅落盘审计，但不进入 patch 推荐

---

### 5.5 正式接入 LLM review

这是本轮必须完成的重点。

当前的 `llm.*` 配置已经存在，但未被消费。需要把它变成真实能力。

#### 目标

在 session_end review 阶段，**对当前目标文档 + 归一化错误 + 已收集 overlay + 用户纠正** 调用 LLM，生成“文档级修改建议”。

#### 最小可行实现

新增 `LLMReviewRunner` 或升级 `ReviewRunnerImpl`：

输入：

- target 类型与 key
- 原始文档内容（若存在）
- normalized events
- aggregated overlays
- recent corrections
- 当前 merge policy

输出：

- `isModificationRecommended`
- `justification`
- `proposedDocument`（完整候选文档）
- `changeSummary`
- `riskLevel`
- `metadata`

#### LLM prompt 必须约束

- 不要生成 patch 报告
- 只输出最终目标文档内容或严格结构化 JSON
- 若证据不足，返回“不修改”
- 若目标是 builtin/global，则写对应文档，不写 skill 专属内容
- 保持原文结构与语气
- 只做与当前 evidence 明确相关的最小修改

#### 配置行为

- `llm.inheritPrimaryConfig = true`：默认沿用当前主模型设置
- `llm.modelOverride`：允许显式指定 review 模型
- `llm.thinkingOverride`：允许指定 review 阶段的 reasoning/think 模式

#### 兼容策略

若 LLM 调用失败：

- 不中断整个 session_end
- 回退为 queue-only patch report
- 记录完整 review failure 日志

---

### 5.6 拆分“审计报告”和“可合并内容”

当前最大问题之一，是 patch 报告和 merge 内容混在一起。

必须拆成两类产物：

#### A. 审计报告（Report Patch）
保存到：

- `.skill-patches/<target>/<patchId>.md`

内容包括：

- patchId
- source session
- risk
- evidence summary
- normalized errors
- change summary
- original excerpt
- proposed excerpt

#### B. 可合并文档（Mergeable Document）
这是 auto-merge 真正写回目标文件的内容。

- 对 `skill:<name>`：写回 `skills/<name>/SKILL.md`
- 对 `builtin:<tool>`：写回 `.skill-global/tools/<tool>.md`
- 对 `global:default`：写回 `.skill-global/DEFAULT_SKILL.md`
- 对 `unresolved`：禁止 auto-merge，只允许 queue-only

**禁止再把 patch report 直接写进 `SKILL.md`。**

---

### 5.7 新增 Pending Error Queue（替代“把标签塞进 message 再删除”）

不要往用户 message 或模型 message 本体里塞 `<errortoolcall>` 再删。

改成内部 pending queue：

```ts
interface PendingHint {
  target: EvolutionTarget;
  fingerprint: string;
  count: number;
  lastError: string;
  instruction: string;
  expiresAt: number;
}
```

规则：

- 同类失败重复达到阈值（如 2~3 次）后，生成 pending hint
- 在下次 `before_prompt_build` 通过隐藏 system context 注入
- 成功或过期后清除
- 不写入用户可见 message

示例注入格式：

```xml
<skill_evolution_feedback>
  <target>builtin:read</target>
  <fingerprint>enoent-memory-file-missing</fingerprint>
  <count>3</count>
  <instruction>Avoid repeatedly reading the same missing memory file. Check existence first.</instruction>
</skill_evolution_feedback>
```

---

## 6. 具体改动要求（按模块）

### 6.1 `src/review/review_runner.ts`

必须从“deterministic overlay summarizer”升级为真正的 review orchestration。

要求：

- 支持 LLM review 路径
- deterministic 仅作为 fallback
- 输出中增加：
  - `target`
  - `changeSummary`
  - `proposedDocument`
  - `evidenceSummary`
- 不要再把 `proposedDiff` 简单设为 `summary.overlays.join()`

### 6.2 `src/review/patch_generator.ts`

必须拆分：

- `generateReportPatch(...)`
- `generateMergeableDocument(...)` 或等价结构

不要再让一个 `string` 同时承担审计报告和 merge 内容。

### 6.3 `src/review/merge_manager.ts`

要求：

- auto-merge 只能写“mergeable document”
- report patch 只写 `.skill-patches`
- `unresolved` target 禁止 auto-merge
- builtin/global target 要写到新目标路径，而不是 `skills/<skill>/SKILL.md`

### 6.4 `src/plugin/hooks/after_tool_call.ts`

要求：

- 引入 `normalizeToolError()`
- feedback / overlay / report 使用 normalized error，而不是原始对象 `toString()`
- 记录 `fingerprint`
- 增加 noise filter 决策
- 能区分“失败工具名”和“归属 target”

### 6.5 `src/plugin/hooks/message_received.ts`

要求：

- correction 不能只是生成 `unknown-skill` overlay
- 要尝试与最近活跃 target 绑定
- 若无法绑定，进入 `global:default` 或 `unresolved`
- 不允许无脑写死 `unknown-skill` 后直接进入 merge 流程

### 6.6 `src/plugin/index.ts`

要求：

- 组合根中新增：
  - TargetResolver
  - ErrorNormalizer
  - NoiseFilter
  - PendingHintStore（可选）
- 若使用 runtime `workspaceDir`，必须在真正拿到 context 后绑定，不依赖 schema 外字段

### 6.7 `src/shared/types.ts`

要求补充：

- `EvolutionTarget`
- `NormalizedToolError`
- `PendingHint`
- `ReviewResult` 新字段
- 区分 report patch 与 mergeable document 的类型

### 6.8 `openclaw.plugin.json`

如果仍要允许配置 `workspaceDir` 或 `skillsDir`，必须把它们正式写进 schema；否则就删除代码对 schema 外字段的依赖。

### 6.9 `README.md` 与 `docs/`

必须修正文档，明确说明：

- 当前版本是否真的支持 LLM review
- `llm.*` 配置是否已生效
- default/global/builtin target 的写入位置
- manual merge 与 auto merge 的真实差异
- `.skill-global/` 的用途
- `unresolved` target 只 queue、不自动 merge

---

## 7. 新的验收标准（替换旧版 AC）

### AC-1 LLM review 真实生效

给出一组明确 evidence 后，review 阶段必须：

- 触发一次真实 LLM review；
- 产出结构化结果或候选文档；
- 不能只把 overlay 文本直接拼成 patch。

### AC-2 default/builtin/global 目标可落地

- `default-skill` 不再作为 merge 终点
- builtin 工具能写入 `.skill-global/tools/<tool>.md`
- 通用行为能写入 `.skill-global/DEFAULT_SKILL.md`
- 无法归属时落入 `unresolved`，不能误写 skill 文档

### AC-3 不再出现 `[object Object]`

feedback / overlay / report patch 中都必须保留可读错误信息。

### AC-4 patch 与 merge 语义分离

- report patch 可审计
- mergeable document 可写回
- auto-merge 不会把 patch 报告写进 `SKILL.md`

### AC-5 exa / builtin 错误归因正确

当故意触发 exa skill 错误时：

- 应尽可能归到 `skill:exa`
- 至少不能无条件退化成 `default-skill`

### AC-6 startup 噪音不进入演化建议

预期缺失文件等噪音错误不能主导 patch 结果。

### AC-7 correction 与 tool error 能汇总到同一 target

用户纠正与工具错误不能再长期分裂为 `webchat / unknown-skill / UUID session` 多条不相关链路。

---

## 8. 建议的多智能体分工（适配 OpenCode）

> 注意：以下分工建立在“遵守仓库现有 `AGENTS.md` 与 prompts”的前提下。

### Agent A：Target / Path / Merge 架构

负责：

- Target Resolver
- `.skill-global/` 目标体系
- mergeable document / report patch 分离
- merge_manager 重构
- schema 补充或删除 schema 外依赖

输出：

- 目标分层实现
- 路径与 merge 重构
- 相关单元测试

### Agent B：Error / Noise / Attribution

负责：

- normalizeToolError
- 安全序列化
- fingerprint
- noise filter
- exa/builtin 归因逻辑

输出：

- 错误归一化实现
- 噪音过滤规则
- 相关单元测试

### Agent C：LLM Review

负责：

- LLM review prompt 设计
- review_runner 重构
- fallback 策略
- review 结果结构设计

输出：

- review 路径接入
- 相关集成测试
- 文档说明

### Agent D：Session / Hint / Overlay

负责：

- correction 与 tool error 的 target 绑定
- pending hint queue
- before_prompt_build 注入策略
- session 聚合一致性测试

输出：

- hook 级修复
- prompt 注入策略
- 生命周期测试

### Agent E：审查与验收

负责：

- 按 AC-1 ~ AC-7 验收
- 检查是否还有 `[object Object]`
- 检查 default-skill 是否仍被当作 merge 终点
- 检查 `llm.*` 配置是否只是占位

输出：

- 阻断项清单
- 最终 merge 建议

---

## 9. 给 OpenCode 的执行提示词

你现在要在仓库 `NEKO-CwC/skill-generation` 中执行一次第二轮修复。

你必须优先遵守仓库现有 `AGENTS.md` 和 prompts 约束；本任务文档只定义修复目标，不覆盖仓库既有代理协作规范。

你的目标不是“让插件继续产出 patch 文件”，而是让它：

1. 正确识别并归因错误；
2. 正确决定目标文档（skill / builtin / global / unresolved）；
3. 正确调用 LLM 生成修改建议；
4. 正确区分审计 patch 和可合并文档；
5. 避免把 patch 报告直接写进 `SKILL.md`；
6. 避免把 startup 噪音当演化证据；
7. 避免继续产出 `default-skill` / `unknown-skill` 的无效 merge 目标。

请先完整阅读：

- `AGENTS.md`
- prompts 配置
- `README.md`
- `docs/`
- `src/openclaw.ts`
- `src/plugin/`
- `src/review/`
- `src/shared/`
- `tests/`
- 本文档

执行原则：

- 先确认问题，再出计划，再改代码；
- 多 agent 分工，但最终由一个 agent 做统一收敛；
- 每完成一个阶段必须跑测试；
- 所有行为变化同步更新文档；
- 不允许留下 schema 外配置依赖；
- 不允许继续让 `[object Object]` 出现在 overlay / patch / feedback 中；
- 不允许继续把 `default-skill` 作为最终 merge 目标；
- 不允许在宣称支持 `llm.*` 的同时，review 路径完全不调模型。

最终输出必须包含：

- 修改摘要
- 变更文件列表
- 新增/更新测试
- 验收结果（对照 AC-1 ~ AC-7）
- 剩余风险

---

## 10. 本轮修复的最低成功标准

只要出现以下任一情况，本轮修复视为**未完成**：

- 仍然没有真实 LLM review；
- 仍然把 patch report 直接作为 `SKILL.md` 内容写回；
- 仍然出现 `[object Object]`；
- 仍然把 `default-skill` / `unknown-skill` 当最终 merge 目标；
- exa 错误仍无法和 exa target 建立可靠联系；
- startup 噪音仍主导 patch 结果。

