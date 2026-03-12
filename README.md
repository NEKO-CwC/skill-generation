# OpenClaw Skill Evolution Plugin

让 OpenClaw 的 skills 根据真实使用反馈持续演进的插件。

它会在 session 中收集工具错误、用户纠正和正向反馈，生成**仅当前 session 生效**的临时 overlay；在 session 结束后再进行复盘，产出 patch，并按配置选择**人工 merge**或**自动 merge**。同时为每个 skill 保留最多 **5 个回滚版本**。

## 这是什么

这是一个 **OpenClaw plugin**，不是普通 skill。

- 用于让 skill 的 `SKILL.md` / 使用说明逐步适配真实工作流
- 支持 session-local overlay，不会直接污染共享 skill 文件
- 支持 session 结束后的 patch 生成、merge 和 rollback
- 支持全局人工审核开关

## 这不是什么

请不要把它当成：

- `skills/` 目录下的 skill 包
- 依赖 `SKILL.md` 被发现的技能
- 复制进 `~/.openclaw/skills/` 就能工作的项目

它应当通过 **OpenClaw plugins** 机制安装和启用。

## 快速开始

### Agent 安装

```
Install and configure the skill-generation plugin of openclaw by following the instructions here:
https://raw.githubusercontent.com/NEKO-CwC/skill-generation/refs/heads/master/docs/install.md
```

### Human 安装

完整安装与配置说明请看：

- [安装指南](./docs/install.md)
- [配置说明](./docs/config.md)
- [故障排查](./docs/troubleshooting.md)

最简流程：

```bash
git clone https://github.com/NEKO-CwC/skill-generation.git
cd skill-generation
npm install
npm run build
npm run test

openclaw plugins install -l .
openclaw plugins enable skill-evolution
````

然后把配置写到 OpenClaw 主配置里的：

```jsonc
plugins.entries.skill-evolution.config
```

最后重启 OpenClaw，并用下面命令验证：

```bash
openclaw plugins list
openclaw plugins info skill-evolution
openclaw plugins doctor
```

## 注意事项

* 这是 **plugin，不是 skill**
* 不要放进 `skills/`
* 不要用 `openclaw skills list` 验证安装
* 如果 overlay 没有注入 prompt，优先检查：
  `plugins.entries.skill-evolution.hooks.allowPromptInjection`

## 核心能力

* 收集工具失败、用户纠正、正向反馈
* 生成 session-local overlay
* 在 session 结束时执行 deterministic review
* 生成 patch，并支持 manual / auto merge
* 保留最多 5 个 skill 历史版本用于回滚

