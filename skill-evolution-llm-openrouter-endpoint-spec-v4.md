# Skill Evolution Plugin 修改规范（LLM Provider / OpenRouter / Endpoint Path）

适用对象：OpenCode / Claude Code

适用基线：`NEKO-CwC/skill-generation` 当前 master 分支（以本规范编写时公开仓库状态为准）

---

## 1. 目标

本轮修改只聚焦 LLM review 链路，不改动 session overlay / review queue / merge/rollback 的既有主流程。

### 1.1 主要目标

1. **原生支持 OpenRouter provider**
   - 不再要求用户把 OpenRouter 伪装成 `openai-compatible`。
   - 需要为 OpenRouter 提供明确的 provider 类型、默认 base URL、默认 path、响应解析与可选头部能力。

2. **支持自定义 API endpoint 与接口路径**
   - 不能再把 OpenAI-compatible provider 的请求路径硬编码为 `/v1/chat/completions`。
   - 需要允许用户分别配置：
     - `baseUrlOverride`
     - `chatCompletionsPathOverride`
     - （如需要）`messagesPathOverride` / 其他 provider-specific path
   - 需要提供 URL/path 规范化逻辑，避免双 `/v1`、双斜杠、尾斜杠拼接错误。

3. **对齐 schema / docs / runtime / tests**
   - 当前仓库中，`types.ts` / `docs/config.md` 的 LLM 配置已经比 `openclaw.plugin.json` 与 `src/plugin/config.ts` 丰富很多；本轮必须统一。

4. **让真实环境中的 OpenRouter 用法可直接成功**
   - 官方 OpenRouter 文档中：
     - OpenAI SDK 的 base URL 是 `https://openrouter.ai/api/v1`
     - 直接 HTTP 调用的 chat completions endpoint 是 `https://openrouter.ai/api/v1/chat/completions`
   - 插件必须兼容这类常见配置，不允许因路径重复拼接而 silently fallback。

---

## 2. 当前已知问题（必须修）

### 2.1 OpenRouter 仍未原生建模

当前类型与文档中，provider 只有：
- `anthropic`
- `openai-compatible`
- `custom`

缺少显式的 `openrouter` provider。

这会导致：
- OpenRouter 只能借道 `openai-compatible`
- 相关默认 URL / path / header / debug 文案都不清晰
- 用户配置体验差，错误定位困难

### 2.2 OpenAI-compatible 路径仍是硬编码拼接

当前 `ProviderAdapterImpl.buildOpenAiRequest()` 直接构造：

- `const url = \\`${baseUrl}/v1/chat/completions\\``

这对 `https://api.openai.com` 可以工作；
但对 OpenRouter 官方推荐的 OpenAI SDK base URL：

- `https://openrouter.ai/api/v1`

会变成：

- `https://openrouter.ai/api/v1/v1/chat/completions`

这是本轮必须修复的核心问题。

### 2.3 config schema / runtime 仍不一致

当前仓库里：
- `src/shared/types.ts` 已经定义了：`llm.mode / provider / authProfileRef / keyRef / baseUrlOverride / allowExecSecretRef / allowGatewayFallback / queue / review.engine`
- `docs/config.md` 也在描述这些字段
- 但 `openclaw.plugin.json` 与 `src/plugin/config.ts` 仍明显停留在旧版本，只验证很少的 `llm.*` 字段

这会导致：
- 文档看起来支持，但运行时配置可能无法被 schema 正确接受/校验
- 插件 UI / config tooling 与实际运行能力不一致

### 2.4 Provider abstraction 仍不够细

当前 provider adapter 只区分：
- Anthropic messages API
- OpenAI-compatible / custom 共用 chat completions API

这不足以处理：
- OpenRouter 原生 provider
- base URL 已带版本前缀的兼容 API
- 用户自定义接口路径
- 后续扩展更多 provider 时的可维护性

---

## 3. 与真实问题的对应关系

本规范直接针对以下真实故障模式：

1. **OpenRouter 双 `/v1`**
   - 用户将 `baseUrl` 设为 `https://openrouter.ai/api/v1`
   - 插件再拼 `/v1/chat/completions`
   - 最终 URL 错误，LLM 请求失败，review silently fallback 为 deterministic

2. **endpoint/path 不可控**
   - 某些代理 / 网关 / 自建中转会把 OpenAI-compatible API 暴露为：
     - `/api/openai/chat/completions`
     - `/openai/v1/chat/completions`
     - `/v1/chat/completions` 之外的固定网关路径
   - 如果插件只允许 base URL，而 path 固定，就无法兼容

3. **provider 行为不可解释**
   - 用户在日志里只能看到“openai-compatible”或“custom”
   - 不能明确知道当前走的是 OpenRouter 语义还是通用兼容层

4. **配置文档和运行时不一致**
   - 用户按 docs 配置了 `llm.mode=explicit` / `baseUrlOverride` / `authProfileRef`
   - 但 schema / validate 未覆盖，配置链条可能出现 silent mismatch

---

## 4. 修改范围

### 必改文件

1. `src/shared/types.ts`
2. `src/plugin/config.ts`
3. `openclaw.plugin.json`
4. `docs/config.md`
5. `README.md`
6. `examples/config.example.yaml`
7. `src/review/provider_adapter.ts`
8. `src/review/auth_resolver.ts`
9. `src/review/llm_client_impl.ts`
10. 相关 tests（新增）

### 可选改动文件

1. `docs/spec.md`
2. `docs/architecture.md`
3. `docs/acceptance.md`
4. `tests/workflows/*`

---

## 5. 目标设计

### 5.1 新 provider 枚举

把 LLM provider 从：

- `anthropic`
- `openai-compatible`
- `custom`

扩展为至少：

- `anthropic`
- `openai-compatible`
- `openrouter`
- `custom`

#### 设计要求

- `openrouter` 是**一等 provider**，不是 alias。
- 日志、错误信息、默认 URL、默认 path、文档示例，都必须体现它是原生支持对象。
- `custom` 仍保留，但只用于“无法被 anthropic / openai-compatible / openrouter 正确表达”的非常规接口。

---

### 5.2 Base URL 与 Path 拆分

当前问题的根源，是把 URL 当成一个“裸 base + 固定 path”处理。必须改成：

#### 配置层新增/明确字段

在 `llm` 配置中新增并支持：

- `baseUrlOverride: string | null`
- `chatCompletionsPathOverride: string | null`
- `messagesPathOverride: string | null`（Anthropic / future proof）

如果不想暴露多个字段，也至少要提供一种等价机制，例如：

- `endpointOverrides.chatCompletions`
- `endpointOverrides.messages`

但**必须做到 path 可配置**。

#### URL 组合规则

实现统一 helper，例如：

- `joinUrl(baseUrl: string, path: string): string`
- `normalizeBaseUrl(...)`
- `normalizeApiPath(...)`

要求：

1. 自动处理：
   - base 末尾是否有 `/`
   - path 开头是否有 `/`
   - 多余的 `//`
2. **不自动追加额外的 `/v1`，除非该 provider 的默认 path 明确包含它**
3. provider 的默认 path 应独立声明，而不是散落在 string template 中

示例：

- OpenAI-compatible default:
  - base: `https://api.openai.com`
  - path: `/v1/chat/completions`
- OpenRouter default:
  - base: `https://openrouter.ai/api/v1`
  - path: `/chat/completions`
- Anthropic default:
  - base: `https://api.anthropic.com`
  - path: `/v1/messages`

这样才能同时兼容：
- OpenAI 官方
- OpenRouter 官方
- 自定义兼容网关

---

### 5.3 OpenRouter provider 的默认行为

#### 默认 endpoint

OpenRouter provider 的默认值应为：

- `baseUrl = https://openrouter.ai/api/v1`
- `chatCompletionsPath = /chat/completions`

#### 默认 headers

至少保留：
- `Authorization: Bearer ...`
- `Content-Type: application/json`

可选支持：
- `HTTP-Referer`
- `X-OpenRouter-Title`

这两个 header 在 OpenRouter 官方文档中是可选的 app attribution 头，不应成为必填，但可以作为增强配置提供。

#### 默认请求格式

仍走 OpenAI-compatible chat completions body：
- `model`
- `messages`
- 可选 `temperature` / `max_tokens` / `stream` 等

#### 默认 model

不要继续把 OpenRouter provider 与 `OPENAI_MODEL = 'gpt-4o'` 绑死。

要求：
- 引入 provider-aware 默认模型解析
- `openrouter` 默认模型可以是一个更中性/更兼容的值，或者明确要求通过 `modelOverride` 指定
- 如果保留默认值，也必须在 docs 里说明这个默认模型只是兜底，不保证在所有 OpenRouter 账户下都可用

建议实现：
- `resolveModel(provider, config)`
- 优先级：`config.llm.modelOverride` > provider default

---

### 5.4 AuthResolver 行为调整

当前 `AuthResolverImpl` 已有以下链路：
- `authProfileRef`
- `keyRef`
- agent default profile
- gateway fallback

这轮不需要推翻，但要做两件事：

#### 1. provider 值允许 `openrouter`

返回的 `ResolvedAuth.provider` 需要支持 `openrouter`。

#### 2. `baseUrlOverride` 与 profile/baseUrl 的优先级明确化

必须定义稳定的优先级：

1. `llm.baseUrlOverride`
2. auth profile 自带 `baseUrl`
3. provider 默认 base URL

不要出现“有 profile baseUrl 但又被 provider 默认值覆盖”的情况。

#### 3. gateway fallback 的 provider 语义明确

如果通过 gateway fallback 拿到的是 `OPENAI_API_KEY`，不代表 provider 就是 OpenRouter。

要求：
- gateway fallback 只提供 credential，不应隐式改变 `config.llm.provider`
- provider 始终由插件配置决定

---

### 5.5 ProviderAdapter 重构要求

当前 `ProviderAdapterImpl` 太扁平。需要改成“provider spec + request builder”模式。

建议结构：

- `provider_specs.ts`
- `provider_adapter.ts`

#### 每个 provider spec 至少包含

- `providerId`
- `defaultBaseUrl`
- `defaultPaths`
  - `chatCompletions`
  - `messages`（如适用）
- `defaultHeaders(resolvedAuth, config)`
- `buildBody(prompt, systemPrompt, config)`
- `parseResponse(rawJson)`

#### OpenRouter spec 要求

- 请求路径默认 `/chat/completions`
- 返回解析复用 OpenAI-compatible choices/message/content 结构
- 可选 app attribution headers 支持

#### Custom provider 要求

如果保留 `custom`，必须定义它的最小契约：

- 必须显式给出 `baseUrlOverride`
- 必须显式给出 `chatCompletionsPathOverride`（不能再假设 `/v1/chat/completions`）

也就是说，`custom` 不应该再是“openai-compatible but maybe weird”；它应该是“完全自定义 endpoint 的兼容层”。

---

## 6. schema / config / docs 对齐要求

### 6.1 `src/shared/types.ts`

必须保证 `SkillEvolutionConfig.llm` 与 runtime 真正支持的字段一致。

新增/明确：

- `provider: 'anthropic' | 'openai-compatible' | 'openrouter' | 'custom'`
- `baseUrlOverride: string | null`
- `chatCompletionsPathOverride: string | null`
- `messagesPathOverride: string | null`
- 可选：
  - `defaultHeaders?: Record<string, string>`
  - `openrouterSiteUrl?: string | null`
  - `openrouterAppName?: string | null`

### 6.2 `src/plugin/config.ts`

必须：
- 为新增字段提供默认值
- 正确 merge 嵌套配置
- 正确 validate 所有新字段

尤其要覆盖：
- provider 枚举含 `openrouter`
- override 字段允许 `null` 或非空 string
- custom provider 下对 path override 的附加约束

### 6.3 `openclaw.plugin.json`

必须同步更新 schema。

这是 P0，因为当前仓库已经出现“docs/types 比 schema/runtime 丰富”的不一致。

要求：
- schema 能完整表达当前 LLM 配置能力
- `additionalProperties: false` 仍可保留，但前提是所有受支持字段都被正式声明

### 6.4 README / docs

文档必须明确区分三种配置模式：

1. **Anthropic**
2. **OpenRouter（原生 provider）**
3. **OpenAI-compatible / Custom endpoint**

并补以下示例：

#### 示例 A：OpenRouter 官方

- provider: `openrouter`
- baseUrlOverride: `null`
- 默认走 `https://openrouter.ai/api/v1/chat/completions`

#### 示例 B：OpenRouter 自定义镜像 / 代理

- provider: `openrouter`
- `baseUrlOverride: https://<proxy>/api/v1`
- 可选 path override（仅在代理 path 不标准时使用）

#### 示例 C：OpenAI-compatible 自定义网关

- provider: `openai-compatible`
- `baseUrlOverride: https://example.com/openai`
- `chatCompletionsPathOverride: /v1/chat/completions`

#### 示例 D：完全 custom endpoint

- provider: `custom`
- baseUrl 和 path 都由配置提供

---

## 7. 针对你这次实际故障，规范里必须新增的验收项

### 7.1 回归测试：OpenRouter 官方 base URL 不得出现双 `/v1`

输入：
- provider: `openrouter`
- baseUrlOverride: `null`

预期：
- URL = `https://openrouter.ai/api/v1/chat/completions`

输入：
- provider: `openrouter`
- baseUrlOverride: `https://openrouter.ai/api/v1`

预期：
- URL 仍是 `https://openrouter.ai/api/v1/chat/completions`
- **绝不允许** 变成 `/api/v1/v1/chat/completions`

### 7.2 回归测试：OpenAI-compatible 传统 base URL 仍可用

输入：
- provider: `openai-compatible`
- baseUrlOverride: `https://api.openai.com`

预期：
- URL = `https://api.openai.com/v1/chat/completions`

### 7.3 回归测试：自定义 path 生效

输入：
- provider: `custom`
- baseUrlOverride: `https://gateway.example.com/openai`
- chatCompletionsPathOverride: `/chat/completions`

预期：
- URL = `https://gateway.example.com/openai/chat/completions`

### 7.4 回归测试：对象错误摘要不再出现 `[object Object]`

当前 `after_tool_call` 已经开始通过安全 stringify 输出 excerpt。保留并扩展这条测试，确保：
- `messageExcerpt`
- overlay 中的 `Error excerpt`

在输入为对象时，输出的是 JSON-like 文本而不是 `[object Object]`。

### 7.5 回归测试：LLM 失败日志必须包含 provider + resolved URL

当 LLM 请求失败时，日志必须至少包含：
- provider
- resolved URL
- HTTP status（如果有）
- fallback reason

这样下次遇到 API path 拼接错误时，不需要再人工猜测。

---

## 8. 具体实现建议

### 8.1 不要再把 provider 差异塞在 if/else 里

把：
- provider 默认值
- URL path
- body schema
- response parser

拆成 provider spec。

### 8.2 URL 构造必须集中化

禁止在多个文件里各自 string template 拼 URL。

所有 URL 只能通过统一 helper 生成，例如：
- `buildEndpointUrl(resolved, endpointKind, config)`

### 8.3 错误消息要面向排障

对于 provider/endpoint 失败，报错文本建议包含：
- provider name
- base URL
- endpoint path
- full resolved URL（可打码 query，但保留路径）

### 8.4 保持 deterministic fallback，不改这条安全带

这轮不要移除 fallback。

要求：
- LLM call 失败时，仍回退 deterministic review
- 但 patch/audit report 里应能明确看出是：
  - `reviewSource: deterministic`
  - `fallbackReason: <provider/http/path/auth>`（建议新增）

---

## 9. 非目标（本轮不要做）

以下内容不是本轮重点，不要扩写范围：

1. 不要重写 review queue 架构
2. 不要改 merge/rollback 行为策略
3. 不要增加新的 review engine（如 Responses API）
4. 不要把 OpenRouter SDK 直接引入为运行时依赖
   - 本轮只需要 HTTP/fetch 兼容实现
5. 不要把任意 provider 统一为“自动猜测”
   - provider 必须显式配置，避免隐式歧义

---

## 10. 输出要求（给 OpenCode / Claude Code）

代理在提交修改时，必须同时提交：

1. 代码修改
2. schema 修改
3. README / docs 修改
4. examples 修改
5. tests 修改
6. 一份简短的变更摘要，明确回答：
   - OpenRouter 是否原生支持
   - 自定义 endpoint/path 是否支持
   - 如何避免双 `/v1`
   - 哪些配置示例现在是官方推荐写法

---

## 11. 最终验收标准

只有同时满足以下条件，才算完成：

1. `provider=openrouter` 可直接工作
2. OpenRouter 官方 base URL 不会触发双 `/v1`
3. 自定义 endpoint + 自定义 path 可同时工作
4. `openclaw.plugin.json` / `config.ts` / `types.ts` / `docs/config.md` 字段完全一致
5. 对象错误摘要不再出现 `[object Object]`
6. LLM 失败日志足够定位 provider/path 问题
7. 所有新增测试通过
8. 旧的 anthropic / openai-compatible 路径不回归

---

## 12. 建议优先级

### P0
- provider enum 增加 `openrouter`
- URL/path 构造重构
- 修复双 `/v1`
- schema/runtime/docs 对齐

### P1
- 自定义 endpoint/path override
- 更好的错误日志
- OpenRouter 可选 attribution headers

### P2
- 更细的 provider-aware 默认模型策略
- 更精细的 fallback reason 结构化输出

