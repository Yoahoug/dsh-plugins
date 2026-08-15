# skill-external-roots 插件开发与部署记录 — 外部 agent 工具技能挂进 ctx.skills

> 目标：在不修改 DSH 主仓库源码的前提下，把本机 codex / claude / cursor / opencode 等外部 agent 工具目录里的既有技能，挂进运行中 dsh 的 `ctx.skills` 注册表（`source: 'external'`、rank 350），让模型可直接调用。配套上层方案：dsh-launcher「技能」子界面（扫描/导入是启动器文件层的事；本插件提供"模型侧可调用"的运行时能力）。
>
> 本文档 = 实现记录 + 实测结果；调研与设计底稿见 `packages/skill-external-roots/docs/development-plan.md`（已标注实现状态）。

---

## 1. 结论先行

| 问题 | 结论 |
|---|---|
| 需要改主仓库吗? | **不需要**。纯 Provider 插件 + profile 用户补丁层激活 |
| 插件形态? | **Provider 型函数插件**（`inject: ['skills']`），向 `ctx.skills.registerProvider(...)` 注册 `ExternalRootsProvider`；不新增服务、不拥有 `ctx.<key>` |
| 挂哪些根? | codex `~/.codex/skills`、claude `~/.claude/skills`、cursor `~/.cursor/skills` + `~/.cursor/skills-cursor`（精确探测，不展开通配）、opencode `~/.config/opencode/skills`；不存在的根静默跳过；`customDirs` 追加；`agentsRoot` 默认 **false**（`~/.agents/skills` 已被内置 `skill-filesystem` 覆盖） |
| 技能怎么来? | 复用官方本地提供方解析规则：`<kebab>/SKILL.md` 目录包 + 扁平 `<kebab>.md`，frontmatter 必填 `name`+`description`，多余键（Cursor `environments`、Codex `license` 等）忽略 |
| 谁拥有 `ctx.skills`? | `@deepseek-ai/dsh-skill`（Service Definition）；本插件与 `@deepseek-ai/dsh-skill-filesystem` 一样只是注册进 registry |
| 与内置提供方如何协作? | 不同 provider 名（`external-roots` vs `filesystem`）、不同 source（`external` vs `custom`/`user-*`）；rank 350 落在"项目之后、用户之前"；同名冲突时项目 > 外部 > 用户 |
| 运行时刷新? | chokidar 监听各已存在根（沿用官方 stability/poll 参数思路）→ `control.invalidate()`；`watch: false` 逃生口 |
| Invariant? | 注册 manifest 名 + 每次 `skills/change` 检查"扫描→候选"数据关系（候选路径必须在记录根内；缺失根不得产候选） |

## 2. 包结构与导出

```
packages/skill-external-roots/
├── src/index.ts        name='skill-external-roots' / inject=['skills'] / Config / apply
├── src/provider.ts     ExternalRootsProvider(list/get) + roots 探测 + frontmatter 解析 + chokidar watch + health
├── src/types.ts        仅 wire 类型（ExternalSkillLocator / ExternalRootProbe / ExternalRootKind）
├── src/invariant.ts    manifest 名 + 数据关系检查（checkExternalRootsHealth）
├── tests/external-roots.spec.ts   单测（29 用例）
├── tests/registry.spec.ts         集成（cordis-plugin-loader 组装 skills + 本插件）
├── tests/external-roots.e2e.ts    真实机器根冒烟（无 codex/cursor 根时自跳过）
├── README.{md,zh.md} + README.i18n.yaml
└── package.json        @dsh-plugins/skill-external-roots@0.1.0
```

- named-export `name` / `inject` / `Config` / `apply`，**无 default export**；
- `exports` 含 `"."`、`"./invariant"`、`"./src/*"`、`"./package.json"`；
- `peerDependencies`：`@deepseek-ai/dsh-skill` / `dsh-invariants` `^0.1.0-rc.6`、`@deepseek-ai/cordis` `^4.0.1`（公开 npm 线，无 `workspace:^`）；`dependencies`：`@deepseek-ai/schemastery`、`chokidar`（`^5.0.0`）、`yaml`；`devDependencies` 另含 `@deepseek-ai/cordis-plugin-loader` `^1.0.2`（集成测试用）。
- Config 全字段可选，默认值显式写进 schema（`providerName`/`enabled{codex,claude,cursor,opencode}`/`customDirs`/`agentsRoot`/`rank`/`exclude`/`watch`，与方案 §4.2 一致）；无密钥字段。
- 方案 §5 草案里的 `@deepseek-ai/cordis-plugin-loader: ^4.0.1` 按 npm 实际版本修正为 `^1.0.2`（该包发布线是 1.x，不是 4.x）。

## 3. 关键实现决策

1. **根解析是"精确候选 + 存在性探测"**：`defaultRootCandidates()` 纯函数产出有序路径（codex → claude → cursor×2 → opencode → agents(可选) → customDirs）；provider 逐个 `stat` 探测，目录才挂载——不存在的根静默跳过，绝不展开通配。
2. **解析规则与官方对齐、对未知键宽松**：`parseExternalSkill()` 复用 `---` frontmatter + `isSkillName` kebab 校验 + 布尔文法（`true/1/yes/on` 等）；未知键忽略（不因 Cursor `environments`、Codex `license` 拒载）；与官方不同处：camelCase 遗留键不抛错（外部工具不受 dsh 约定约束），仅忽略。
3. **`.system` 桶跳过**：Codex 的 `~/.codex/skills/.system/` 是其内部技能（`review-agent`、`skill-creator`…），不挂进 dsh 目录（list 与 watcher 事件过滤两处都跳过）。
4. **watcher 简化版**：已存在根用 chokidar（`depth: 1` + `awaitWriteFinish` stability/poll + `usePolling` 可注入）；不存在的根用「最近存在祖先」`watchFile` 轮询（根被创建时下一次读取失效）；相关事件按官方 `isRelevantWatchEvent` 语义过滤（直属目录增删、扁平 `.md` 增删改、`<skill>/SKILL.md` 增删改）。`watch:false` 时不建任何 watcher。
5. **invariant 走模块级 health 单例**：`apply` 创建 `ExternalRootsHealth` 并经 `registerExternalRootsHealth()` 注册；provider 每次 `list()` 记录 `{root, exists, candidates}`；invariant 伴侣在安装时 + 每次 `skills/change` 检查"候选 ∈ 根内"与"缺失根零候选"两条关系。
6. **集成测试用真实 Loader**：`Context + cordis-plugin-loader`，`loader.internal.import` 桩把 `@deepseek-ai/dsh-skill` 与 `@dsh-plugins/skill-external-roots` 映射到进程内模块（源文件，不经 lib/）；`loader.create` 返回 entry id，`loader.remove(id)` 验证 dispose 后移除。

## 4. 实测结果（本机，2026-08-16）

### 4.1 构建 / 类型 / 测试

```sh
$ cd /Users/yoahoug/Desktop/dsh-plugins
$ pnpm install                        # 新 workspace 包 + 依赖落位
$ pnpm run build                      # tsc → lib/，3 包全绿
$ pnpm run typecheck                  # 全绿
$ pnpm run test                       # 9 文件 139 用例全绿（本包 29 单测 + 3 集成）
$ pnpm run test:e2e                   # 本包真实机器根冒烟通过（tavily/vision 无 key 自跳过）
```

### 4.2 安装与激活（web profile）

```sh
$ cd /Users/yoahoug/Desktop/deepseek-harness   # 主仓库只读，仅运行 dsh CLI
$ pnpm dsh plugin --profile web add file:/Users/yoahoug/Desktop/dsh-plugins/packages/skill-external-roots
# ✓ 安装成功：+ @dsh-plugins/skill-external-roots file:...
# 提示：declares no dsh.bundle — installed as a plain dependency, not a profile layer
# （与 web-search-tavily / vision-bridge 同款：无 bundle manifest，走用户补丁层 insert 激活）
# 未出现 pnpm allowBuilds 提示（file: 安装不运行 build 脚本，无需授权）
```

`~/.dsh/profiles/web/cordis.patch.yml` 追加 insert 行（`id: skill-external-roots`，配置 `enabled` 四族全开）。

```sh
$ pnpm dsh --profile web --dump-config | grep -A8 skill-external-roots
- id: skill-external-roots
  name: '@dsh-plugins/skill-external-roots'
  config:
    enabled:
      codex: true
      claude: true
      cursor: true
      opencode: true
```

### 4.3 运行中 dsh web 验证（新开实例，端口 3099，未动既有 3080 实例）

新开实例：`pnpm dsh --profile web --port 3099`。经 web 前端同一 RPC 通道（`POST /api/session.create` + `POST /api/skill.list`，即 web「/」技能面板的 `ui-skill` 数据源）验证：

- `session.create`（cwd=dsh-plugins，preset=no-subagent）→ `skill.list` 返回 **29 个技能**，含外部工具技能：codex 的 `read-opencode-session` / `gh-private-exe-release` / `miniapp-request-study`，cursor 的 `automate` / `canvas` / `create-skill` / `sdk` 等（另有 preset 侧 `skill-filesystem` 提供的 `server-ops` / `tavily-*` / `win-host`）；
- **watch 生效**：向 `~/.codex/skills` 新增 `zz-watch-probe` 技能 → 3 秒内 `skill.list` 出现 `zz-watch-probe`（且本会话模型侧 `<available_skills>` 目录同步出现）；删除后 3 秒内消失；
- **模型侧可加载**：外部技能进入模型 `<available_skills>` 目录（只有 name+description），`skill()` 加载正文路径 = registry `get()` → provider 重读文件，由单测/e2e 覆盖（真实机器根 `get()` 返回正文断言通过）；
- 验证完毕停掉 3099 实例、删除探测 session；既有 3080 实例保持健康（HTTP 200）且同样加载了新组合（其会话目录已含外部技能）。

### 4.4 遗留事项

- **OpenCode 根在本机不存在**（`~/.config/opencode` 只有 `opencode.json` 等）→ 静默跳过，符合设计；
- **Claude 根全部是指向 `~/.agents/skills/*` 的符号链接**：`~/.claude/skills` 名下技能与 agents 根内容相同，属用户既有布局；本插件按目录包规则跟随符号链接解析（与官方一致），不产生去重（同名单靠 rank/层裁决）。
- **`invariants` 服务行未在 web profile 挂载**（既有组合没有 `/invariant` 行）；如部署方启用，按 README 加 `skill-external-roots-invariant` 行即可。

## 5. 相关文件

- 方案底稿（调研/设计/实施计划）：`packages/skill-external-roots/docs/development-plan.md`
- 根 README 插件清单表与「相关文档」：`README.md`
- 主仓库契约：`deepseek-harness/docs/subsystems/skills.zh.md`、`deepseek-harness/packages/skill/skill-filesystem/src/index.ts`
- 模板：`packages/web-search-tavily/`
