# 会话提示词：实现 @dsh-plugins/skill-external-roots 插件

你是 dsh-plugins 仓库的开发者。工作目录 `/Users/yoahoug/Desktop/dsh-plugins`（DeepSeek Harness 的外部插件 monorepo：`packages/` 下每个子目录是一个独立 npm 插件包，经 `dsh plugin --profile <name> add <package>` 安装到本地 profile，绝不修改主仓库源码）。

本会话目标：按 `packages/skill-external-roots/docs/development-plan.md` 从零实现新插件 **`@dsh-plugins/skill-external-roots`** —— 把本机 codex / claude / cursor / opencode 等外部 agent 工具目录里的既有技能，挂进运行中 dsh 的 `ctx.skills` 注册表（`source='external'`、rank 350），让模型可直接调用。该文件夹当前只有 `README.md`（规划中）与 `docs/development-plan.md`（方案），无任何实现代码。

## 硬性约束（AGENTS.md 为准，先读后写）

1. `/Users/yoahoug/Desktop/deepseek-harness` 主仓库**永远只读**；本仓库 `git status` 除本插件外**零改动**（当前唯一未跟踪项就是 `packages/skill-external-roots/`）。
2. `/Users/yoahoug/Desktop/dsh-launcher` 只读引用（其「技能」子界面与本插件共用默认根映射，但互不依赖）。
3. 只写 **Provider** 角色（+ 少量 Consumer），不新增服务、不拥有 `ctx.<key>`；可选服务用 `ctx.get(name)`。
4. 插件导出 **named-export `name` / `inject` / `Config` / `apply`，禁止 default export**；`Config` 全字段可选，默认值显式写进 schema。
5. 每个包必须拥有 `./invariant`：注册 manifest 名 + 至少一个事件/数据关系检查（或给出 `No runtime invariant:` 理由）；`apply` 返回 `ctx.invariants.register(...)` 的 disposer。
6. `peerDependencies` 用 DSH 公开 npm 包 `^0.1.0-rc.6` 线，**禁止 `workspace:^`**；密钥不进配置文件。
7. 双语 README + `README.i18n.yaml`：含 Model Experience、Known Limitations and Deferred Work、Config 表（键/默认值/含义）、可直接粘贴的补丁行示例。
8. 实现完成后必须在根 `README.md` 的插件清单表与「相关文档」登记，否则视为未完成。

## 开始前必读（按序）

- `AGENTS.md`（仓库规范全文：包结构/导出形式/测试/README 要求）
- `packages/skill-external-roots/docs/development-plan.md`（本插件的调研 + 设计 + 实施步骤，按它实现）
- `packages/web-search-tavily/`（模板：复制其包结构/package.json/exports/invariant/tests 风格）
- `/Users/yoahoug/Desktop/deepseek-harness/docs/subsystems/skills.zh.md`（`ctx.skills` 注册表与 `SkillProvider` 契约：`registerProvider`、`list()`/`get()`、`SkillSource` 允许自定义字符串）
- `/Users/yoahoug/Desktop/deepseek-harness/packages/skill/skill-filesystem/src/index.ts`（解析/监控范式：frontmatter 规则、kebab 校验、chokidar + `control.invalidate()`）
- `/Users/yoahoug/Desktop/deepseek-harness/docs/user/develop/basic/config.zh.md` 与 `publish.zh.md`（Config schema 与 bundle 包机制）

## 实现范围（按方案 §4/§5/§8）

1. **脚手架**：复制 `web-search-tavily` 骨架 → 包名 `@dsh-plugins/skill-external-roots`、version `0.1.0`；`src/{index,provider,types,invariant}.ts`、`tests/`、`tsconfig.json`（`rootDir: src`、`outDir: lib`）；`package.json` exports 含 `"."`、`"./invariant"`、`"./src/*"`、`"./package.json"`。
2. **`src/types.ts`**：仅 wire 类型，无运行时代码。
3. **`src/provider.ts`**：`ExternalRootsProvider implements SkillProvider`：
   - 默认根映射：`codex=~/.codex/skills`、`claude=~/.claude/skills`、`cursor=~/.cursor/skills` 与 `~/.cursor/skills-*`（**只探测存在的精确目录，不展开通配**）、`opencode=~/.config/opencode/skills`；不存在的根静默跳过；`agentsRoot` 默认 `false`（`~/.agents/skills` 已被内置 `skill-filesystem` 覆盖，避免重复）。
   - `list()`：枚举 `<kebab>/SKILL.md` 与扁平 `<kebab>.md`；frontmatter 必须 `name`+`description`，可选 `whenToUse`/`disable-model-invocation`/`user-invocable`；缺失/非法 YAML/非法 kebab → 跳过并日志点名；外部工具多余键（如 Cursor `environments`、Codex `license`）忽略；产出 `source:'external'`、`provider: providerName`（默认 `'external-roots'`）、`rank`（`config.rank ?? 350`）、`locator`、`resourceBase:{kind:'directory',path}`。
   - `get()`：重读正文返回 `SkillDefinition`（含 `content`）；名称与候选不再匹配则拒绝。
   - `watch` 默认 `true`：chokidar 监听各根目录直属条目增删改 → `control.invalidate()`（沿用官方 stability/poll 参数思路）；`watch:false` 逃生口并在 README 注明局限。
4. **`src/index.ts`**：`name='skill-external-roots'`、`inject=['skills']`、`Config`（方案 §4.2：`providerName`/`enabled{codex,claude,cursor,opencode}`/`customDirs`/`agentsRoot`/`rank`/`exclude`/`watch`，全可选 + 显式默认）；`apply` 内 `ctx.skills.registerProvider((control) => new ExternalRootsProvider(...))` + effect dispose + invariant 注册。
5. **`tests/`**：
   - 单测：根目录存在性探测与 `enabled` 开关矩阵；frontmatter 合法/缺 description/非法 kebab/非法 YAML 各例（用本机实测的 codex/claude/cursor 真实 SKILL.md 头部做 fixture）；`rank`/`exclude`/同名裁决；`agentsRoot:false` 默认不挂 `~/.agents/skills`。
   - 集成：cordis-plugin-loader 组装 `skills` + 本插件，断言 `ctx.skills.list({cwd})` 含外部技能、`get()` 返回正文、dispose 后移除。
6. **本机验证（必须逐条执行并记录结果）**：
   - `pnpm install && pnpm run build && pnpm run typecheck && pnpm run test` 全绿；
   - 安装到本地 profile：`dsh plugin --profile web add file:<本包绝对路径>`；若报 pnpm `allowBuilds` 提示，说明原因并按需处理（file: 安装一般不需要）；
   - `dsh --profile web --dump-config` 输出中出现 `# == skill-external-roots` 层；
   - 启动 dsh web：技能面板出现 `source=external` 的技能（如 codex 的 `read-opencode-session` 等），模型侧 `skill()` 可加载；
   - 对 `~/.codex/skills` 增删一个技能，web 侧目录自动刷新（watch 生效）。
7. **收尾**：README 双语 + i18n；根 `README.md` 登记；把实测结果补充进 `docs/development-plan.md`（或另建实现记录）；按仓库惯例提交（中文描述）。

## 完成定义

- 构建/类型/测试全绿；本地 web profile 安装后 `--dump-config` 出现新层、web 技能面板可见外部技能且模型可调用、watcher 刷新生效；
- 根 README 已登记本插件；主仓库与 dsh-launcher 仓库零改动；
- 交付回复给出：改动文件清单、每条验证命令与结果、遗留事项（如有）。
