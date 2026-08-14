# AGENTS.md

dsh-plugins 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH)的**外部插件 monorepo**:`packages/` 下每个子目录是一个独立 npm 插件包,通过 `dsh plugin --profile <name> add <package>` 安装到本地 profile,由用户补丁层激活。**核心前提:绝不修改 DSH 主仓库源码。** 开发前先读 [docs/tavily-search-development.md](docs/tavily-search-development.md)(能力缝机制、分层补丁原理、完整调研)与主仓库的 [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md)(上层规范,本文件是其裁剪)。

## 仓库布局

```
docs/      调研、开发、部署记录(每件大事一份文档)
packages/  每个子目录 = 一个插件 npm 包(以 web-search-tavily 为模板)
README.md  只介绍仓库功能与安装方法;开发规范一律在本文件
```

## 核心原则

- **主仓库只读**:所有行为经由插件 + 用户补丁层(`~/.dsh/profiles/<name>/cordis.patch.yml`)达成;主仓库 `git pull` 必须永远干净。
- **能力缝**:插件是 Service Definition / Provider / Consumer 三角色之一;本仓库只写 **Provider**(和少量 Consumer),不写 Service Definition。
- **Provider 不拥有 `ctx.<key>`**:注册进宿主服务的 registry(如 `ctx.web.registerSearchProvider`),key 由 Service Definition 拥有;写 Provider 时不要新增服务、不要改 `ctx` 类型。
- **选择是配置层的**:`searchProvider` 等由配置钉死,模型不能自选,插件也不提供"默认激活"——激活由 profile 补丁 `insert` / 覆盖完成。
- **文档先行**:新增插件前,先在 `docs/` 写调研/设计记录,再实现。

## 插件包规范

### 导出形式

- 函数插件 named-export `name` / `inject` / `Config` / `apply`,**无 default export**(混用会让 Loader 丢弃函数插件的命名空间,见主仓库 postmortem 0001)。
- 可选服务用 `ctx.get(name)`,不用 `ctx.<name>` 属性代理。

### 包结构(复制 `web-search-tavily` 作模板)

```
packages/<name>/
├── src/index.ts       插件入口(name/inject/Config/apply + settings section 注册)
├── src/provider.ts    能力实现(如 TavilySearchProvider implements WebSearchProvider)
├── src/types.ts       仅 wire 类型,无运行时代码
├── src/invariant.ts   包级 invariant 伴侣(必须,见下)
├── tests/             包级测试(单测 + 真实 HTTP + e2e)
├── README.{md,zh.md} + README.i18n.yaml   双语文档
├── tsconfig.json      extends 根 tsconfig.base.json,rootDir: src,outDir: lib
└── package.json       @dsh-plugins/<name>,exports 含 "./src/*"
```

### 每个包必须拥有 `./invariant`

注册 manifest 名;检查一个事件/数据关系,或给出包特定 `No runtime invariant:` 理由;`apply` 返回 `ctx.invariants.register(...)` 的 disposer。

### Config 与 settings

- Config 全字段可选,`apply` 内填 env/常量默认值;默认值显式,不做隐藏的 `?? default`。
- 密钥字段 `z.string().role('secret')`,凭证引用 `z.string().role('credential-ref')`。
- settings section 经 `installSettingsSection` 注册,用 source thunk 把每次操作的 section 投影成 options,改动无需重注册 provider。
- 命名空间复用等非显然前提必须写进 README(见 `web-search-tavily` 的 UI 卡片复用记录)。

## 依赖与凭证

- `peerDependencies` 引用 DSH 公开 npm 包(`^0.1.0-rc.6` 线),**绝不使用 `workspace:^`**(主仓库内部协议)。
- 凭证优先 `apiKeyEnv` + credentials 服务(环境变量 fallback);`apiKey` 字面量仅作 fallback;密钥不进配置文件。
- 缺凭证诊断必须点名缺失的引用(如 `no API key for "TAVILY_API_KEY"`)。

## 安全规范

- 凭证携带请求必须 `redirect: 'error'`(web 包规则:拒绝跨源转发)。
- 错误分类:provider 失败 `WEB_PROVIDER_ERROR`,取消 `WEB_ABORTED`(web 缝);其他缝沿用其宿主约定的错误码。
- 不做 SSRF 防护的能力不得默认挂载(如 fetch 保持 disabled,由部署方显式开启)。

## 测试政策

- **单元**:映射、请求整形、凭证解析、错误分类(`tavily.spec.ts` 为模板)。
- **真实 HTTP**:redirect 拒绝必须用真实服务器证明(`redirect.spec.ts` 为模板);mock 断言无法观察该边界。
- **settings**:section 读写 + HMR 安全注册(注册后 dispose 纤维,观察移除)。
- **e2e**:真实 API 冒烟,无 key 自跳过(`tavily.e2e.ts` 为模板)。
- 行为改动必须同步改测试;测试描述行为,不描述正确性。

## README 规范

- 双语 + `README.i18n.yaml` 同步。
- 含 **Model Experience** 章节(model / token / KV-cache 效果)与 **Known Limitations and Deferred Work** 章节。
- 含 Config 表(键 / 默认值 / 含义)与可直接粘贴的补丁行示例。
- 非显然约束(命名空间复用、前提条件)必须记录。

## 构建、测试、发布

```sh
pnpm run test          # 全部单测(vitest)
pnpm run test:e2e      # 真实 API(无 key 自跳过)
pnpm run build         # tsc → lib/(根脚本转发到各包)
pnpm run typecheck
```

- 发布前:version bump、README 同步、`lib/` 重建;包名 `@dsh-plugins/<name>`,语义化版本。
- 提交前:主仓库必须保持零改动;`git status` 只含本仓库文件。

## 编辑这些说明

`CLAUDE.md` 是 `AGENTS.md` 的符号链接;编辑真实文件。每条规则自包含,并链接高层次文档而非复述。
