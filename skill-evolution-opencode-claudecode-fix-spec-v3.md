# Skill Evolution Plugin 修订规范（适用于 OpenCode / Claude Code）

## 1. 文档目标

本文档用于指导代码代理（OpenCode、Claude Code 或类似多智能体代码代理）在仓库 `NEKO-CwC/skill-generation` 上继续完成收尾修订。

目标不是重写架构，而是基于当前提交：

- Commit: `52874f74d6d5fec67f32a24c1af221666001cf9b`
- Repo: `https://github.com/NEKO-CwC/skill-generation`

对**仍然存在的实现偏差**做最小必要修复，并让 README / docs / tests 与代码行为保持一致。

---

## 2. 当前基线（已验证）

当前版本已经完成了以下关键修复，这些内容**不要回退**：

1. 统一 session 解析链路
   - `resolveSessionId` 已统一 `sessionId -> sessionKey -> conversationId -> channelId -> 'unknown-session'`
   - `before_prompt_build` / `after_tool_call` / `message_received` / `agent_end` / `session_end` 已走统一逻辑

2. 反馈识别能力增强
   - `message_received` 已支持 English + Chinese feedback regex
   - `user_correction` 已可直接生成或追加 overlay，不再依赖高 severity

3. review 触发条件已扩大
   - deterministic review 不再只看工具错误，已纳入 correction / overlay 等证据

4. session_end 背景复盘链路已存在
   - session 结束时会 enqueue review task
   - background worker 会异步处理 review / patch / merge

5. target routing 已扩展
   - 已支持 `skill` / `builtin` / `global` / `unresolved`

6. feedback 已落盘
   - 不再是纯内存 collector

这些能力是当前版本的正确方向，后续修改必须保持兼容。

---

## 3. 需要继续修复的核心问题

### P0-1：workspace 重绑定后，review queue / worker 仍可能绑定旧路径

#### 问题描述
当前插件在注册阶段就会：

- 基于 `plugin.paths.reviewQueueDir` 创建 `ReviewQueueImpl`
- 基于当时的 `plugin.paths` 创建并注册 `ReviewWorkerImpl`

但后续 `captureWorkspaceDir(...)` 触发 `plugin.ensureWorkspaceDir(...)` 后，虽然 plugin 内部部分组件会重建，**reviewQueue 和已注册 worker 仍可能继续持有旧路径**。

这意味着：

- overlay / feedback 可能已经写到了新 workspace
- 但 queue / failed queue / worker 仍可能盯着旧目录
- background review 行为与 README 中“all paths are resolved from workspace root”的预期不一致

#### 修复目标
必须保证：

- 一旦真实 workspace 根目录被确认，review queue 与 worker 使用的目录也必须与之同步
- 不允许 queue 继续使用初始化时的 fallback `process.cwd()` 路径

#### 推荐实现路径（优先级从高到低）

**方案 A（推荐）**
延迟创建 reviewQueue 和 reviewWorker，直到第一次拿到真实 workspaceDir 后再创建并注册。

建议实现：

- `SkillEvolutionPlugin` 增加明确的 workspace-ready 状态
- `openclaw.ts` 中在首次成功 `captureWorkspaceDir(...)` 后：
  - 创建 `ReviewQueueImpl`
  - 创建 `ReviewWorkerImpl`
  - 调用 `api.registerService(worker)`
- 若直到整个插件生命周期都未拿到 workspaceDir，则可回退到同步 review，或记录 warning，但不要悄悄把后台队列写到错误目录

**方案 B（次选）**
允许 queue / worker 热更新：

- `plugin.ensureWorkspaceDir(...)` 返回“是否发生了路径重绑定”
- 一旦重绑定发生：
  - 重建 `ReviewQueueImpl`
  - 更新 plugin.reviewQueue
  - 重建 worker，或给 worker 增加 `updatePaths(...)`
- 只有在 OpenClaw service 生命周期允许的前提下才使用该方案

#### 禁止事项

- 不允许只重建 plugin.paths，而不处理 queue / worker
- 不允许将 queue 目录继续固定在初始化时的 cwd
- 不允许留下“前台写新目录，后台读旧目录”的分裂状态

---

### P0-2：`enabled: false` 时插件仍会注册 background service

#### 问题描述
当前注册顺序存在问题：

- 先创建 queue
- 先创建 worker
- 先 `registerService(worker)`
- 然后才判断 `if (!plugin.config.enabled) return`

这会导致：

- 虽然 hooks 不注册
- 但 background worker 仍可能被启用

这与一个合理的“总开关”预期不一致。

#### 修复目标
`enabled: false` 必须成为真正的 master switch：

- 不注册 hooks
- 不注册 services
- 不创建 queue / worker
- 不启动任何后台轮询
- 不产生任何 side effects

#### 实施要求
调整 `openclaw.ts` 中的初始化顺序：

1. 解析 config
2. 创建 plugin
3. 若 `plugin.config.enabled === false`，立即返回
4. 仅在 enabled 情况下初始化 queue / worker / hooks

#### 验收标准
当配置为 disabled 时：

- 插件日志最多允许出现“registered / disabled by config”类信息
- 不应创建 review queue 目录
- 不应创建 failed queue 目录
- 不应注册 worker service
- 不应产生 session hook side effects

---

### P1-1：README / docs 需要精确说明 workspace 绑定与后台服务初始化时机

#### 问题描述
当前 README 已大体描述双链路架构，但没有清楚说明：

- workspace 根目录的最终来源
- queue / worker 是否依赖 runtime context 才能安全初始化
- 如果 workspace 尚未解析，插件该采取何种降级策略

这会导致实现修好了，但文档仍然让后续维护者误解初始化模型。

#### 修复目标
README / docs 需要明确：

- 路径以 resolved workspace root 为准
- background review queue 只有在 workspace root 已知后才初始化，或会在首次绑定后重建
- 若 workspace root 无法解析，插件的降级行为是什么

#### 最小文档更新范围
至少更新：

- `README.md`
- `docs/config.md`
- 如有必要，`docs/architecture.md`

#### 文档必须包含的信息

- queue / worker 的初始化前提
- `enabled` 的真实语义：完全禁用插件行为
- 目录落点的明确说明
- 对 fallback / warning / degraded mode 的描述

---

## 4. 可选增强项（非阻塞，但建议处理）

### P2-1：澄清“纯正反馈是否应驱动修改建议”

#### 现状
当前版本已经：

- 收集 positive feedback
- 在 review 里统计 positiveCount

但从实现语义上看，“只有 positive feedback、没有 correction/error/overlay”的 session，通常仍不会触发 skill 修改建议。

#### 处理建议
二选一即可，不要求同时做：

**方案 A：保持现状，但写清楚**
在 README / docs 说明：

- positive feedback 会被收集与计数
- 主要用于上下文判断与 justification
- 默认不会单独触发 patch generation

**方案 B：增强语义**
允许在满足阈值时，pure positive feedback 也触发低风险建议，例如：

- 仅生成 note / hint 类 patch
- 不允许 auto-merge
- 只进入 manual queue

#### 优先级
此项不是当前 release blocker。
如果时间有限，优先选择方案 A（文档澄清）。

---

## 5. 任务拆解（适合多代理并行）

### Agent A：核心运行时修复
负责：

- `src/openclaw.ts`
- `src/plugin/index.ts`
- 必要时 `src/service/review_queue.ts`
- 必要时 `src/service/review_worker.ts`

交付目标：

- 修复 workspace 重绑定后的 queue / worker 一致性
- 修复 `enabled: false` 仍注册 service 的问题
- 不破坏现有 hooks 行为

### Agent B：测试与回归
负责：

- `tests/plugin/*`
- `tests/service/*`
- `tests/workflows/*`
- 新增 regression tests

至少补这些测试：

1. disabled mode does not register worker / queue side effects
2. workspace rebound updates background review path behavior
3. queue / worker use resolved workspace root, not startup cwd
4. session_end async flow still works after runtime workspace capture

### Agent C：文档与一致性
负责：

- `README.md`
- `docs/config.md`
- `docs/architecture.md`（如需要）

要求：

- 不夸大当前尚未实现的行为
- 与实际初始化顺序、队列启动条件、路径解析逻辑完全一致
- 清楚区分“实时链路”和“后台链路”

---

## 6. 必须满足的验收标准

### A. 功能验收

1. 当插件启用且首次收到带 `workspaceDir` 的 hook context 后：
   - 所有后续落盘目录都在该 workspace root 下
   - review queue / failed queue / worker 处理目录与 plugin.paths 保持一致

2. 当插件在未解析 workspace 的情况下收到事件：
   - 行为必须可解释
   - 要么延迟后台队列初始化
   - 要么明确降级并记录 warning
   - 不允许静默写到错误目录

3. 当 `enabled: false`：
   - 无 hooks
   - 无 worker
   - 无 queue
   - 无 side effects

### B. 回归验收

以下能力必须仍然工作：

- unified session id resolution
- English + Chinese correction detection
- correction overlay append behavior
- session_end enqueue review task
- target routing to skill/builtin/global/unresolved
- feedback persistence

### C. 文档验收

README / docs 中关于以下内容的描述必须与实现一致：

- queue / worker 初始化时机
- workspace root 的来源
- disabled mode 的行为
- positive feedback 的作用边界（若未增强）

---

## 7. 非目标（不要做）

以下内容不是本轮修复目标，除非为完成 P0 必须触碰：

- 重写整个 review engine
- 改写 target model
- 重构 provider / auth / llm client
- 改变 patch 文本格式
- 改变 manual vs auto merge 的总体策略
- 大规模风格化重构或目录迁移

---

## 8. 建议提交策略

推荐最少拆成 3 个提交：

1. runtime fix
   - workspace / queue / worker / enabled 语义修复

2. tests
   - regression + service lifecycle + workspace rebind tests

3. docs
   - README / config / architecture 同步更新

如果代理支持更细粒度 PR，也可拆为：

- `fix(runtime): align worker lifecycle with resolved workspace`
- `fix(runtime): do not register background services when plugin is disabled`
- `test: add workspace-rebind and disabled-mode regressions`
- `docs: document workspace binding and review-service lifecycle`

---

## 9. 最终交付物

本轮修改完成后，必须交付：

1. 修改后的代码
2. 新增/更新后的测试
3. 更新后的 README / docs
4. 一段简短变更说明，明确回答：
   - queue / worker 何时初始化
   - workspace 如何确定
   - disabled mode 是否彻底无副作用
   - positive feedback 是否能单独驱动 patch（若不能，要写明）

---

## 10. 给代码代理的执行提示

请严格遵循以下策略：

- 先读 README、`src/openclaw.ts`、`src/plugin/index.ts`、`src/plugin/hooks/session_end.ts`、`src/service/review_queue.ts`、`src/service/review_worker.ts`
- 先做最小修复，不要做无关重构
- 修复后必须补测试
- 测试通过后再改文档
- 若发现 OpenClaw service API 不支持热重绑 worker，优先改为“延迟注册 worker”，不要硬做复杂 service 重启机制
- 所有文档描述必须以代码最终行为为准，而不是反过来让代码迁就旧文案

