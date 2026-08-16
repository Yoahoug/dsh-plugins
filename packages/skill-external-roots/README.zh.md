# @dsh-plugins/skill-external-roots

[English](README.md) | 中文

面向 harness [skills 能力 seam](../../../deepseek-harness/docs/subsystems/skills.zh.md)（`ctx.skills`）的 `SkillProvider`：把外部 agent 工具目录里既有技能——OpenAI Codex `~/.codex/skills`、Claude Code `~/.claude/skills`、Cursor `~/.cursor/skills*`、OpenCode `~/.config/opencode/skills`——挂进运行中注册表，产出 `source: 'external'` 候选项，**rank 350**（项目技能 100/200 之后、用户技能 400/500 之前）。这些工具写的技能即可经标准 `skill()` 工具与 `<available_skills>` 目录被 dsh 模型直接调用。

这是一个**实现**包：它向 `ctx.skills` 注册提供方，不拥有 `ctx.skills` 键（归属 `@deepseek-ai/dsh-skill`），也不注册面向模型的工具（归属 `@deepseek-ai/dsh-tool-skill`）。它是函数/命名空间插件（`inject: ['skills']`），像 `@deepseek-ai/dsh-skill-filesystem` 一样注册进注册表。

## 根目录映射

| 工具 | 默认根 | 说明 |
|---|---|---|
| OpenAI Codex | `~/.codex/skills` | 只挂 `.system/` 之外的用户技能；工具自带的内部 `.system` 技能被跳过。 |
| Claude Code | `~/.claude/skills` | |
| Cursor | `~/.cursor/skills`、`~/.cursor/skills-cursor` | Cursor 无统一全局路径；按这两个精确候选做存在性探测（绝不展开通配），只挂存在的。 |
| OpenCode | `~/.config/opencode/skills` | 候选根；不存在时静默跳过。 |
| Agents（显式开启） | `$DSH_AGENTS_HOME`/`~/.agents` 下的 `skills` | **默认关闭**：内置 `skill-filesystem` 已扫描它（user-agents rank 500）——再挂会让每个 agent 技能出现两次。 |

不存在的根静默跳过；`customDirs` 追加任意根（同样 `source: 'external'`）。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `external-roots` | `ctx.skills` 注册表中的提供方名（与内置 `filesystem` 分层共存）。 |
| `enabled.codex` / `claude` / `cursor` / `opencode` | `true` | 按工具族开关；关闭的族完全不探测。 |
| `customDirs` | `[]` | 默认根之后按序扫描的额外根。 |
| `agentsRoot` | `false` | 显式挂 `~/.agents/skills`（与内置提供方重复，仅供特殊场景）。 |
| `rank` | `350` | 候选项 rank；项目(100/200) < 外部 < 用户(400/500)。 |
| `exclude` | `[]` | 按解析出的 frontmatter `name` 从目录中剔除的技能名。 |
| `watch` | `true` | chokidar 在根目录直属变化（增删技能、`SKILL.md` 修改）时使注册表失效。 |
| `skillControlFile` | 未配置 | 启动器写入的**按技能注入控制文件**（`$DSH_HOME/skills-control.json`）：`roots` 里 `false` 的族不探测、`skills` 里 `false` 的技能不挂载；文件变化即 `invalidate()`（**运行中 dsh 无需重启**）。未配置 = v1 行为（全注入、无文件 IO）。 |
| `activeFile` | 未配置 | 每次 `list()` 后把**实际注入（过滤后）的候选清单**原子写回该文件（`$DSH_HOME/state/skills-active.json`）——启动器「已启动」子界面的数据源；内容未变不重写。 |

补丁行（profile `cordis.patch.yml`，含启动器注入控制联动）：

```yaml
- insert:
    - id: skill-external-roots
      name: '@dsh-plugins/skill-external-roots'
      config:
        enabled:
          codex: true
          claude: true
          cursor: true
          opencode: true
        skillControlFile: /Users/you/.dsh/skills-control.json
        activeFile: /Users/you/.dsh/state/skills-active.json
```

控制文件（`$DSH_HOME/skills-control.json`，由 dsh-launcher 技能页开关维护，也可手写）语义：

```json
{ "version": 1,
  "roots": { "codex": true, "claude": true, "cursor": true, "opencode": true },
  "skills": { "tavily-extract": true, "win-host": false } }
```

- `roots.<family> = false` → 该族整根不探测（与 Config `enabled` 取与）；
- `skills.<name> = false` → 该技能不挂载（与 Config `exclude` 合并）；
- 缺失文件 / 缺失字段 = 启用（v1 行为）；文件变化由 1.5s 轮询感知并 `invalidate()` → **关闭一个技能后运行中的 dsh 一两秒内即不再注入**。

安装：`dsh plugin --profile web add file:<绝对路径>/packages/skill-external-roots`（`file:` 安装无需 pnpm `allowBuilds` 授权；先 `pnpm run build` 产出 `lib/`）。

## 解析规则

沿用官方本地提供方约定（[`skill-filesystem`](../../../deepseek-harness/packages/skill/skill-filesystem/src/index.ts)）：目录包 `<kebab>/SKILL.md` 与扁平 `<kebab>.md`；`---` 定界的 YAML frontmatter 映射，必须含 kebab-case `name` 与非空 `description`；可选 `whenToUse`、`disable-model-invocation`、`user-invocable`、`metadata`。工具专属多余键（Cursor `environments`、Codex `license` 等）忽略。frontmatter 缺失/非法、kebab 名非法、或命中 `exclude` 的文件跳过并记日志点名。候选项带 `source: 'external'`、配置的 `provider`/`rank`、`{ path, directory }` locator 与 `{ kind: 'directory' }` 的 `resourceBase`。`get()` 重读正文；frontmatter `name` 与候选不再匹配的定义被拒绝（注册表失效并重新发现）。

## 模型体验

间接经 [`dsh-tool-skill`](../../../deepseek-harness/packages/skill/tool-skill/README.md)：模型的 `<available_skills>` 目录获得外部技能（只有 `name` + `description`——绝不含正文或绝对路径），`skill({ name })` 按需加载完整正文，`resourceBase` 以技能目录解析相对资源。列出的技能从磁盘消失后按不可用处理。根目录变化（watch 开启）时 `skills/change` 使消费方目录失效，模型侧目录无需重启即刷新。

#### KV 缓存效果

除 `skills/change` 目录刷新外无直接失效：模型侧目录摘要只在列出名/描述变化时改变；只改正文只影响后续 `skill()` 加载，不重新生成目录消息。

## 已知限制与遗留工作

- **`watch: false` 意味着无实时刷新**：没有 watcher 时，注册表只在另一次失效后重收集（其他提供方变化、新的 `cwd`、或应用重启）——关闭该逃生口时请在部署里注明。
- **全新根目录在下一次发现时出现，而非立即**：凭空创建 `~/.codex/skills` 通过「最近存在祖先」轮询观察，在下次目录读取时失效；已存在根内部的变化由原生 chokidar 事件覆盖。
- **同名技能按根扫描序裁决**（codex → claude → cursor → opencode → agents → `customDirs`）：同一 rank 内第一个根胜出。覆盖需用更高优先级提供方（项目/用户根）或专用 `rank`。
- **`.system` 内部技能桶被跳过**（Codex 内置 `review-agent`、`skill-creator` 等）；字面名为 `.system` 的用户技能无法挂载。
- **无设置表单 UI**：v1 配置走 profile 补丁（方案 §4.4 的 HTTP 管理端点留到 v2）。
- **OpenCode 全局根是候选而非标准**：`~/.config/opencode/skills` 探测后不存在即静默跳过；安装位置不同时用 `customDirs` 补。
- **Cursor 路径是探测清单而非扫描**：除两个探测候选外的 `~/.cursor/skills*` 风格目录需要 `customDirs`。

## Invariant 伴侣

`@dsh-plugins/skill-external-roots/invariant` 注册包 manifest 名，并在每次 `skills/change` 时检查「扫描→候选」数据关系：每个已记录候选路径必须位于其记录根之内；记录为缺失的根不得产出候选。运行组合携带 `invariants` 服务时作为独立行挂载：

```yaml
- insert:
    - id: skill-external-roots-invariant
      name: '@dsh-plugins/skill-external-roots/invariant'
```
