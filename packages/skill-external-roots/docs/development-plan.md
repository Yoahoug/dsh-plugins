# @dsh-plugins/skill-external-roots 开发方案（调研 + 设计 + 实施计划）

> 状态：**已实现并部署**（v0.1.0，2026-08-16）。本文件是调研/设计底稿；实现记录与本机实测结果见根
> `docs/skill-external-roots-development.md`，README（双语 + i18n）与根 README 插件清单均已同步。
> 配套上层方案：`dsh-launcher/docs/development-plan.md`（技能子界面依赖本插件的运行时能力）。

---

## 1. 背景与目标

dsh-launcher 新增「技能」子界面：扫描本机 codex / opencode / cursor / `.agent` / claude 等工具目录里的
既有技能，供用户浏览、导入、管理。扫描与导入是启动器（Rust 文件层）的事；但**让这些外部技能在运行中的
dsh 里被模型真正调用**，需要一个 dsh 侧插件——这就是本插件：把外部工具的技能根目录挂进 `ctx.skills`
注册表，成为一个独立的技能提供方（source = `external`）。

### 目标

- 零侵入：不修改 dsh 主仓库源码，纯插件 + profile 补丁激活；
- 开箱即用：默认覆盖 codex / claude / cursor / opencode / agents 常见根目录，可开关、可增删自定义目录；
- 与内置 `skill-filesystem` 共存：不同 provider 名、不同 source、rank 落在“项目技能之后、用户技能之前”，
  同名冲突时项目 > 外部 > 用户；
- 简单优先：v1 不做远程、不做 settings 表单 UI（可选增强项），解析规则与 dsh 官方约定一致。

---

## 2. 插件开发方法研读结论（必读清单）

| 文档 | 结论 |
|---|---|
| [docs/user/develop/basic/config.zh.md](../../../../deepseek-harness/docs/user/develop/basic/config.zh.md) | 插件导出 `name` / `Config`（Schemastery schema，默认值入 schema）/ `apply(ctx, config)`；配置变更触发 Cordis 热替换 |
| [docs/user/develop/basic/publish.zh.md](../../../../deepseek-harness/docs/user/develop/basic/publish.zh.md) | bundle 包结构（`package.json` 声明 `dsh.bundle.patch` + `cordis.patch.yml`）；`dsh plugin --profile <p> add/remove`；patch 按 id 整行替换 config |
| [docs/subsystems/skills.zh.md](../../../../deepseek-harness/docs/subsystems/skills.zh.md) | `ctx.skills` 分层注册表；`SkillProvider`（`name`/`list()`/`get()`）；`ctx.skills.registerProvider(create)` 同步注册，同层同名抛错；`SkillSource` 允许自定义字符串（`external`） |
| [packages/skill/skill-filesystem/src/index.ts](../../../../deepseek-harness/packages/skill/skill-filesystem/src/index.ts) | 官方本地提供方实现范式：根目录 rank、frontmatter 解析（`name`/`description` 必填、`whenToUse`、`disable-model-invocation`、`user-invocable`）、kebab-case 校验、chokidar 监控 |
| dsh-plugins [AGENTS.md](../../../AGENTS.md) | 只写 Provider（+少量 Consumer）；`inject` 用 `ctx.get(name)` 可选服务；包结构复制 `web-search-tavily`；必须拥有 `./invariant`；peerDependencies 用公开 npm 包（`^0.1.0-rc.6` 线），**禁止 `workspace:^`**；Config 全字段可选、默认值显式；双语 README + Model Experience + Known Limitations 章节 |

---

## 3. 调研：外部工具技能目录（本机实测 + 通用约定）

| 工具 | 根目录 | 条目格式 | frontmatter | 与 dsh 解析兼容 |
|---|---|---|---|---|
| OpenAI Codex | `~/.codex/skills/<name>/SKILL.md` | 目录包 | `name` `description`（另见 `license` 等） | ✅（多余键忽略） |
| Claude Code | `~/.claude/skills/<name>/SKILL.md` | 目录包 | `name` `description` | ✅ |
| Cursor | 项目 `.cursor/skills/`；全局无标准路径（本机实测 `~/.cursor/skills-cursor/`） | `<name>/SKILL.md` | `name` `description` `environments` 等 | ✅（`environments` 忽略） |
| OpenCode | `~/.config/opencode/skills`（候选；本机只有 `opencode.json`） | 目录包 | 同 dsh 约定 | 按同约定解析 |
| Agents（dsh 亲缘） | `~/.agents/skills`、`<project>/.agents/skills` | 目录包 | 与 dsh 完全一致 | ✅（dsh 原生已扫，插件应**跳过**避免重复） |

关键结论：

- 各工具技能目录都是 `<kebab-name>/SKILL.md` + YAML frontmatter，与 dsh `skill-filesystem` 约定基本同构；
  dsh 解析器只要求 `name` + `description`，其余键忽略——**可直接复用同一套解析规则**；
- `~/.agents/skills` 已被内置 `skill-filesystem`（user-agents rank 500）覆盖，本插件**默认不挂** agents 根，
  避免同一技能出现两个提供方；仅在用户显式配置时才挂；
- Cursor 无标准全局路径，默认做“存在性探测”若干候选（`~/.cursor/skills`、`~/.cursor/skills-*` 不展开通配，
  只列存在的精确候选），并开放 `customDirs` 让用户补任意目录。

---

## 4. 设计

### 4.1 角色与注册

- 角色：**Service Provider**（消费 `ctx.skills` 服务，不新增服务、不拥有 `ctx.<key>`）；
- `name = 'skill-external-roots'`，`inject = ['skills']`；
- `apply` 内同步调用 `ctx.skills.registerProvider((control) => new ExternalRootsProvider(ctx, control, config))`
  并在 effect 里 dispose；provider 名取 `config.providerName ?? 'external-roots'`（与内置 `filesystem` 不同层名，可共存）。

### 4.2 Config（Schemastery，全字段可选）

```ts
export interface Config {
  providerName?: string            // 默认 'external-roots'
  enabled?: { codex?: boolean; claude?: boolean; cursor?: boolean; opencode?: boolean }
                                   // 默认全 true;存在才挂载,不存在静默跳过
  customDirs?: string[]            // 追加任意根目录(source=external)
  agentsRoot?: boolean             // 默认 false;true 时显式挂 ~/.agents/skills(与内置重复,仅供特殊场景)
  rank?: number                    // 默认 350(项目 100/200 < 外部 350 < 用户 400/500)
  exclude?: string[]               // 按技能名排除,默认 [] 
  watch?: boolean                  // 默认 true(chokidar,沿用官方范式)
}
```

### 4.3 Provider 实现要点

- `list(options)`：对每个启用且存在的根，列出 `<kebab>/SKILL.md` 与扁平 `<kebab>.md` 条目；
  解析 frontmatter（复用官方规则：缺 `name`/`description`、非法 kebab、非法 YAML → 跳过并日志点名）；
  产出 `SkillCandidate`：`source: 'external'`、`provider: providerName`、`rank`、`locator: { path, directory }`、
  `resourceBase: { kind: 'directory', path }`；
- `get(candidate, options)`：重读正文，返回 `SkillDefinition`（含 `content`）；名称与候选不再匹配则拒绝；
- 监控：chokidar 监听根目录直属条目增删改 → `control.invalidate()`（沿用官方 `SkillWatchManager` 的
  stability/poll 思路，可裁剪）；`watch: false` 时仅靠 registry 的按需 `list()`（目录变化需人工/启动器触发
  snapshot，README 注明局限）；
- 与 `skill-filesystem` 的 rank 协作：外部技能 rank 350，同名的项目技能（100/200）与用户技能（400/500）
  均按层内 rank 裁决，行为可预期；文档写明“外部技能可被用户技能覆盖”。

### 4.4 可选增强（v2，不在 v1 范围）

- **HTTP 管理端点**：`inject: ['webServer']`（可选，`ctx.get`），注册
  `GET /api/skill-external-roots`（精确路由，返回启用根/条目数/最近扫描结果），供 dsh-launcher 拉取
  “模型侧已可调用”的实时状态；依赖运行组合具备 `webServer` 服务（web profile 有）。v1 不做，避免依赖面扩大。

### 4.5 部署方式（profile 补丁示例）

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 追加
- insert:
    - id: skill-external-roots
      name: '@dsh-plugins/skill-external-roots'
      config:
        enabled:
          codex: true
          claude: true
          cursor: true
          opencode: true
```

安装：`dsh plugin --profile web add file:<abs 路径>/packages/skill-external-roots`
（安装前 `pnpm install && pnpm run build` 产出 `lib/`）。

---

## 5. 包结构（按 dsh-plugins AGENTS.md 模板）

```
packages/skill-external-roots/
├── src/index.ts        name/inject/Config/apply + registerProvider + invariant disposer
├── src/provider.ts     ExternalRootsProvider(list/get + frontmatter 解析 + watcher)
├── src/types.ts        wire 类型(无运行时代码)
├── src/invariant.ts    包级 invariant(注册 manifest 名;检查“外部根目录存在性→条目数”关系)
├── tests/              单测(roots 解析/frontmatter/rank/排除)+ 集成(注册后 ctx.skills.list)
├── README.md / README.zh.md + README.i18n.yaml
├── tsconfig.json       extends 根 tsconfig.base.json,rootDir: src,outDir: lib
└── package.json        @dsh-plugins/skill-external-roots
```

`package.json` 要点：

```jsonc
{
  "name": "@dsh-plugins/skill-external-roots",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
               "./invariant": { "types": "./lib/invariant.d.ts", "default": "./lib/invariant.js" },
               "./src/*": "./src/*", "./package.json": "./package.json" },
  "peerDependencies": {
    "@deepseek-ai/dsh-skill": "^0.1.0-rc.6",
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1",
    "yaml": "^2"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-skill": "^0.1.0-rc.6",
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/cordis-plugin-loader": "^4.0.1"   // 集成测试用
  },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit" }
}
```

> 依赖核对：`dsh-skill` 是 `ctx.skills` 的服务定义包（公开 npm）；provider 类型（`SkillProvider` 等）从
> 它导入；不需要 `dsh-fs`（本插件走 node fs 即可，与 web-search-tavily 同级的本地工具风格）。
>
> 实现修正：`@deepseek-ai/cordis-plugin-loader` 的 npm 发布线是 `1.0.x`（非方案所写 `^4.0.1`），
> 实际 devDependency 为 `^1.0.2`；`chokidar` 按主仓库同为 `^5.0.0`。

---

## 6. 测试计划

- **单元**（`tests/external-roots.spec.ts`）：
  - 根目录存在性探测与 enabled 开关矩阵；
  - frontmatter 解析：合法/缺 description/非法 kebab/非法 YAML 各例（复制 codex/claude/cursor 实测样例为 fixture）；
  - rank / exclude / 同名裁决（构造同 kebab 名，断言 source/rank）；
  - `agentsRoot: false` 默认不挂 `~/.agents/skills`。
- **集成**（`tests/registry.spec.ts`）：用 cordis-plugin-loader 组装 `skills` + 本插件，断言
  `ctx.skills.list({ cwd })` 出现外部技能、`get()` 返回正文、dispose 后移除。
- **settings**：v1 不注册 settings section（无 UI 卡需求），README 说明配置走 profile 补丁。
- **e2e**：无 key 依赖，纯本地；真实 `~/.codex/skills` 冒烟（CI 可能无此目录 → 自跳过）。

## 7. 完成定义（Definition of Done）

- [x] 按上文包结构实现，`pnpm run build` / `typecheck` 通过，单测 + 集成测试绿（9 文件 139 用例，2026-08-16）；
- [x] 本机 `web` profile 安装后：`dsh --profile web --dump-config` 出现 `skill-external-roots` 行；dsh web 技能
      面板出现外部技能并可被模型 `skill()` 调用；对 `~/.codex/skills` 新增/删除技能，目录自动刷新
      （实测：新增 `zz-watch-probe` 3 秒内出现、删除 3 秒内消失，web `skill.list` 与本会话模型目录同步）；
- [x] README（双语 + i18n）含 Model Experience、Known Limitations、Config 表、可直接粘贴的补丁行；
- [x] 登记进 dsh-plugins 根 `README.md` 插件清单表与「相关文档」章节；主仓库零改动（`git status` 校验）；
- [ ] 与 dsh-launcher 技能子界面联调：启动器「一键启用」也可改用本插件路径（二选一，默认走 customSkillDirs）——
      待启动器侧排期，未阻塞本插件交付。

## 8. 实施步骤（建议顺序）

1. 根 `docs/` 落一份开发记录（本文即 v1 调研/设计底稿，实现过程追加实测结果）；
2. 脚手架：复制 `web-search-tavily` 模板 → 改名为 `skill-external-roots`（包名/README/tsconfig）；
3. `src/types.ts` + `src/provider.ts`（解析与 roots 探测）→ `src/index.ts`（注册 + invariant）→ 测试；
4. 本机 profile 安装 + dump-config 验证 + dsh web 技能面板验证；
5. README 双语 + 根 README 登记 → 提交（含 docs 更新）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 各工具技能 frontmatter 演化出 dsh 不认识的必填键 | 解析器只取 dsh 需要的键，多余键忽略并记录；不因未知键拒载 |
| 与 `skill-filesystem` 同名冲突/重复展示 | 不同 provider 名；`agentsRoot` 默认 false；rank 策略文档化 |
| chokidar 大目录开销 | 沿用官方 stability/poll 参数；`watch: false` 逃生口 |
| peer 依赖版本漂移（dsh rc 线更新） | 跟随 web-search-tavily 的 `^0.1.0-rc.6` 线，发布前统一核对 |
| 启动器扫描与插件根列表不一致 | 两者共用同一份“默认根映射”（本插件 Config 默认值 + 启动器设置项），联调时互相对齐并各自文档化 |
