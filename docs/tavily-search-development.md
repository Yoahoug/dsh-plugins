# Tavily 搜索插件开发文档 — DeepSeek Harness 搜索引擎切换

> 目标:在不修改 DSH 主仓库源码的前提下,把 agent 默认 `web_search` 工具的后端从官方 DeepSeek 搜索切换为 Tavily,且上游频繁更新时零冲突。
>
> 本文档由对主仓库 `deepseek-ai/deepseek-harness`(2026-08-14, `0.1.0-rc.5` 工作树)的调研写成,同时完整解剖了当时工作树中一版未提交的 Tavily 切换实现(已备份于 `docs/agent-notes-backup/` 与 `working-tree.patch`),供新会话参考。

---

## 1. 结论先行

| 问题 | 结论 |
|---|---|
| 需要 fork 主仓库吗? | **不需要**。当前账号对上游只有 READ 权限,但做外部插件不需要写主仓库 |
| 需要改主仓库源码吗? | **不需要**。全部通过 profile 用户补丁层 + 外部插件完成 |
| 默认就是官方 DeepSeek 搜索,怎么覆盖? | 在 `~/.dsh/profiles/<name>/cordis.patch.yml` 覆盖 `web` 行 `searchProvider: tavily`——用户补丁永远在 bundle 层之上,last write wins |
| 冲突风险? | 零。主仓库 `git pull` 永远干净,插件完全独立 |
| 想贡献上游怎么办? | 单独 fork + PR(仓库公开)。但**先做外部插件跑通**,PR 是后续选项 |

**核心机制**:DSH 的配置是分层补丁,不是单一文件。`@deepseek-ai/dsh-base` bundle 的 `cordis.patch.yml` 声明默认行(`web` 行 `searchProvider: deepseek-official`、`web-search-deepseek` 行等),用户 profile 的 `cordis.patch.yml` 在其上做 id-targeted 覆盖或 `insert` 新行,最后写者胜出。**"默认调用官方搜索"是配置层的默认,不是代码层的——配置层的事在配置层解决。**

---

## 2. 架构调研(事实与依据)

来源:`packages/boot/app-boot/README.md`(Profiles 章节)、`packages/bundle/base/cordis.patch.yml`、`apps/cli/src/args.ts`、`packages/web/web/src/index.ts`、`docs/subsystems/web.md`。

### 2.1 插件化架构

- DSH 基于 vendored Cordis,**一切皆插件**;能力缝 = Service Definition / Service Provider / Consumer 三角色([能力缝](../AGENTS.md#conventions))。
- web 能力缝:`dsh-web` 是 Service Definition(拥有 `ctx.web` + provider registries),搜索 provider 包是 Service Provider(注册进 `ctx.web`),`dsh-tool-web` 是 Consumer(定义 `web_search`/`web_fetch` 工具 schema)。
- **搜索 provider 不拥有 `ctx.web` key**,只是往 registry 里注册——所以加一个 provider 是纯增量,不需要动服务本身。
- `searchProvider` / `fetchProvider` 配置**钉死**选哪个 provider,不是隐藏的优先级链(模型无法自行挑选请求目标,官方注释明确)。

### 2.2 Profile / Bundle / Overlay 分层

- **Profile**:`$DSH_HOME/profiles/<name>/`(本机 `~/.dsh/profiles/web/`),含 `package.json`(声明 `dsh.profile.bundles` 有序 bundle 列表 + 插件依赖)+ **用户自己的 `cordis.patch.yml`**。
- **Bundle**:npm 包,manifest 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。`dsh-base`、`dsh-web-app`、`dsh-headless` 是官方 shipped bundles。
- **用户补丁层**:`profiles/<name>/cordis.patch.yml`(per-profile)与 `$DSH_HOME/cordis.patch.yml`(home 级,outranks per-profile),**应用顺序在所有 bundle 层之后**——"the last write winning per row"。
- **补丁语义**(app-boot README 原文):
  - id-targeted patch **整段替换**目标行的整个 `config`(不深合并,需 restate 未变字段)
  - `insert` 添加新行
  - `!!js` 表达式允许在 config 中插值
  - 补丁 naming 不存在的 id → stderr 警告(不致命)
  - 空文件/纯注释文件会 throw;禁用该层写 `[]`
- **HMR**:profile 补丁文件改动实时重载(`watchUserPatches`),失败时保留最后好树,不中断运行。
- **`dsh plugin --profile <name> add <package>`**:把剩余参数转发给 profile 目录内的 pnpm,安装外部插件依赖。**out-of-tree bundle/插件是官方一等公民**(bundle README 原文:"Out-of-tree bundles install into a profile through `dsh plugin --profile <name> add <package>`")。
- **验证**:`dsh --profile web --dump-config` 离线合成完整配置树(含 `# ==` 层注释),`--dump-default-config` 只打 bundle 层。

### 2.3 上游现状

- 仓库 public(`deepseek-ai/deepseek-harness`),非 fork;`0.1.0-rc.5` 工作树,commit `8c1e8d9890` "publish the dsh family publicly"。
- npm 已发布:`@deepseek-ai/dsh-web` 最新 `0.1.0-rc.6`(dist-tag `next`),peer 依赖统一 `^0.1.0-rc.6`、`@deepseek-ai/cordis ^4.0.1`。
- 本机 profile:`~/.dsh/profiles/web/`,bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`,用户补丁当前为 `[]`。
- 上游 PR 惯例:直接推主仓库分支(`deepseek-harness/feat/...`),同仓库内 PR;外部贡献者需要 fork。

---

## 3. 现状实现解剖:2026-08-14 工作树的 Tavily 切换

> 以下解剖的是工作树中**未提交**的实现(49 个修改/删除文件 + 未跟踪新包),已完整备份:
> - 新包源码:`docs/agent-notes-backup/` 同级的 `packages/web-search-tavily/`(已迁入本仓库 `packages/web-search-tavily/`)
> - 全部 diff:`working-tree.patch` + `staged.patch`(仓库根)
> - Agent Note:`docs/agent-notes-backup/2026-08-14-web-search-tavily.{md,zh.md,i18n.yaml}`

### 3.1 新增插件包 `packages/web/web-search-tavily/`(正确部分,保留)

结构完整、质量高,正是官方推荐形态的 provider 插件:

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 函数/命名空间插件(`name`/`inject`/`Config`/`apply`,无 default export)。`inject: ['web']`,注册 settings section + `ctx.web.registerSearchProvider(...)` |
| `src/provider.ts` | `TavilySearchProvider implements WebSearchProvider`:`id = 'tavily'`、`available()`、`search()`。每次操作**快照一次 options** 防 settings 中途变更混用;凭证经 credentials 服务解析(环境变量 fallback) |
| `src/types.ts` | Tavily wire types(`TavilySearchRequest/Result/Response/Error`) |
| `src/invariant.ts` | 包级 invariant 伴侣(注册 manifest 名,空 installer:无独立事件关系) |
| `tests/tavily.spec.ts` (296 行) | 映射、请求整形、凭证解析、错误分类 |
| `tests/redirect.spec.ts` (127 行) | **真实 HTTP** 证明 `redirect: 'error'` 拒绝跨源 Location(web 包规则) |
| `tests/settings.spec.ts` (118 行) | settings section 读写 + HMR 安全注册 |
| `tests/tavily.e2e.ts` (31 行) | 真实 Tavily API 冒烟,无 `$TAVILY_API_KEY` 自跳过 |
| `README.{md,zh.md,i18n.yaml}` | 包文档,含 Model Experience + Known Limitations 章节 |
| `tsconfig.json` / `package.json` | 包构建与依赖(注意:peerDeps 是 `workspace:^`,独立后需改为 npm 版本) |

关键实现要点(新会话可直接沿用):

```ts
// 映射:Tavily answer → content;results[] → sources;空 snippet 条目丢弃
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  const sources = (response.results ?? []).map(mapTavilyResult)
    .filter((s): s is WebSearchSource => s !== undefined)
  const answer = response.answer?.trim()
  return {
    ...answer ? { content: answer } : {},
    sources,
    truncated: false,  // 截断由 web 服务负责,provider 报 false
  }
}
```

```ts
// 请求:POST {baseURL}/search,Authorization: Bearer,redirect: 'error'
fetch(`${options.baseURL}/search`, {
  method: 'POST', redirect: 'error',
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ... },
  body: JSON.stringify({ query, search_depth, include_answer, max_results }),
  ...signal ? { signal } : {},
})
```

```ts
// 注册:settings section 经 source thunk 投影 options,改动无需重注册 provider
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, current())))
}
```

### 3.2 改动文件分类(49 个修改/删除 + 1 个新目录)

| 类别 | 文件 | 作用 | 评估 |
|---|---|---|---|
| **① bundle 默认切换**(源码级,冲突源) | `packages/bundle/base/cordis.patch.yml` | `web` 行 `searchProvider: deepseek-official → tavily`;`web-search-deepseek` 行 → `web-search-tavily` 行;`tool-web` 行删 `searchTimeoutMs: 60000` | ❌ 不该改。随包发布的 shipped patch,上游必动,必冲突。**替代:profile 用户补丁层** |
| ② 删上游包 | `packages/web/web-search-deepseek/`、`web-search-exa/`、`web-search-perplexity/` 全删 | 移除官方三个 provider | ❌ 不必删。选择哪个 provider 是配置层的事;插件方案下它们留在 bundle 里无害(仅未选中) |
| ③ 仓库级配置 | `knip.json`、`tsconfig.host.json`、`pnpm-lock.yaml`、各 `package.json` | 把依赖/条目从三包换成 tavily | ❌ 仓库内方案才需要;独立插件方案全部撤销 |
| ④ UI 卡片硬编码 | `packages/client/ui-settings-plugins/src/client/web-search-card-controller.ts`、`WebSearchCard.tsx`、`locales.ts` + 测试 | 命名空间 `web-search-deepseek → web-search-tavily`、`maxUses → maxResults`、`DEEPSEEK_API_KEY → TAVILY_API_KEY` | ⚠️ 唯一真正的代码层问题:settings 卡片写死了 provider 命名空间(见 §4.3) |
| ⑤ apiproxy 白名单 | `packages/host/apiproxy/src/api-proxy.ts` | `WEB_SETTINGS_NAMESPACES` 数组改命名空间名 | ⚠️ 同上:web 设置页允许列表写死命名空间 |
| ⑥ e2e/集成测试 | `apps/web/tests/scaffold.ts`、`web-search-round.e2e.ts`、`tool-web/tests/integration.spec.ts`、`apiproxy/tests/api-proxy-config.spec.ts` | 把 DeepSeek/Exa double 换成 Tavily double | 仓库内方案才需要 |
| ⑦ 文档 | `docs/subsystems/web.{md,zh.md}`、各包 README | provider 描述更新 | 仓库内方案才需要 |
| ⑧ Agent Note | `.agents/notes/implemented/feature/2026-08-14-web-search-tavily.{md,zh.md,i18n.yaml}`(未跟踪) | 决策记录 | 已备份;外部插件开发可另写,不用提交主仓库 |

### 3.3 原实现的问题总结

1. 把"换 provider"做成了"改 shipped 默认 + 删上游包"——与上游更新直接对冲,每次 `git pull` 都冲突。
2. 仓库级配置(lockfile/tsconfig/knip)改动最碎、冲突频率最高,收益为零。
3. UI 卡片与 apiproxy 白名单是**真实的代码层依赖**,原实现靠改主仓库绕过,没有解决"不改主仓库时卡片怎么办"的问题(§4.3)。
4. 正确的拆分:插件本体(正确)与部署方式(错误)分开;部署应走 profile 补丁层,而不是主仓库。

---

## 4. 官方推荐路径

### 4.1 总体架构

```
┌─ DSH 主仓库 (只读,永不修改) ─────────────────────────────┐
│  dsh-base bundle (shipped patch)                          │
│    web 行: searchProvider: deepseek-official   ← 官方默认 │
│    web-search-deepseek 行                                 │
└──────────────────────────┬───────────────────────────────┘
                           │ patch 应用顺序:bundle 层在下
┌─ ~/.dsh/profiles/web/ (用户层,永远在上) ──────────────────┐
│  package.json: 依赖 + dsh.profile.bundles                 │
│  cordis.patch.yml: 用户补丁 ← 在这里覆盖                  │
│    web 行: searchProvider: tavily      (last write wins)  │
│    web-search-deepseek 行: disabled: true                 │
│    insert: web-search-tavily 行                            │
└──────────────────────────┬───────────────────────────────┘
                           │
┌─ dsh-plugins/packages/web-search-tavily (本仓库) ─────────┐
│  独立 npm 包 → dsh plugin --profile web add 安装           │
│  peerDeps: @deepseek-ai/dsh-web ^0.1.0-rc.6 等             │
└───────────────────────────────────────────────────────────┘
```

### 4.2 推荐步骤(新会话执行)

1. **构建插件**:在 `dsh-plugins/packages/web-search-tavily/` 独立构建(先改 `workspace:^` → npm 版本,见 §5)。
2. **安装进 profile**:
   ```sh
   dsh plugin --profile web add file:/Users/yoahoug/Desktop/dsh-plugins/packages/web-search-tavily
   # 或发布 npm 后:dsh plugin --profile web add @dsh-plugins/web-search-tavily
   ```
3. **覆盖默认搜索**(编辑 `~/.dsh/profiles/web/cordis.patch.yml`,当前是 `[]`):
   ```yaml
   # 覆盖 web 行(整段替换 config,restate 未变字段)
   - id: web
     config:
       searchProvider: tavily
   # 停用官方 deepseek provider(可选,省得加载)
   - id: web-search-deepseek
     disabled: true
   # 插入 tavily provider
   - insert:
       - id: web-search-tavily
         name: '@dsh-plugins/web-search-tavily'
         config:
           apiKeyEnv: TAVILY_API_KEY
   ```
4. **验证**:
   ```sh
   dsh --profile web --dump-config      # 确认合成树:web.searchProvider = tavily
   echo "$TAVILY_API_KEY" > ~/.dsh/.env # 凭证(或经 credentials 服务)
   dsh --profile web "用 web_search 搜索 DeepSeek Harness"
   ```
5. 补丁有 HMR,改 `cordis.patch.yml` 无需重启即可生效(失败保留旧树)。

### 4.3 遗留问题:UI 设置卡片(唯一代码层依赖)

`dsh-client-ui-settings-plugins` 的 WebSearchCard 与 `apiproxy` 的 `WEB_SETTINGS_NAMESPACES` 白名单**硬编码了 provider 的 settings 命名空间**(原为 `web-search-deepseek`)。不改主仓库时,卡片不会渲染 tavily 的配置卡片。三个选项:

| 选项 | 做法 | 代价 |
|---|---|---|
| A. 复用命名空间(推荐,零改动) | 插件 settings 命名空间就叫 `web-search-deepseek`(或后续版本官方泛化后再迁移) | 命名不符,但配置页可用;README 说明 |
| B. 提 PR 泛化上游 | 把卡片/白名单改为 provider 可声明(如 settings section 提供 `card` 元数据),PR 给上游 | 需要上游评审,周期长;合并后一劳永逸 |
| C. 接受无卡片 | 不改主仓库,web_search 照常工作,只是设置页没有该 provider 的卡片 | 配置只能手写 `cordis.patch.yml`/env |

**推荐 A + 长期 B**:先以 A 快速跑通(功能完全不受影响),把 B 作为后续贡献。

### 4.4 为什么不需要 fork 主仓库

- 只做外部插件 + profile 补丁:不需要对主仓库有任何写权限,`gh auth` 的 READ 权限足够(仅用于读公开仓库)。
- 想贡献(如 4.3-B、或把 tavily 变官方默认)时再 fork:主仓库公开,fork + PR 无门槛;但那是**独立于本次插件开发**的第二件事。
- 备份当前工作树 diff(`working-tree.patch`)已保留,若日后想基于它提 PR(把 tavily 设为上游默认),可直接 `git apply` 到 fork 分支。

---

## 5. 独立插件仓库的依赖调整(重要)

原插件 `package.json` 的 peer/devDependencies 是 **`workspace:^`**,那是主仓库 monorepo 内部协议;独立后必须改为 npm 公开版本:

| 依赖 | 独立版本 |
|---|---|
| `@deepseek-ai/dsh-web` | `^0.1.0-rc.6` |
| `@deepseek-ai/dsh-credentials` | `^0.1.0-rc.6` |
| `@deepseek-ai/dsh-launch-environment` | `^0.1.0-rc.6` |
| `@deepseek-ai/dsh-invariants` | `^0.1.0-rc.6` |
| `@deepseek-ai/dsh-settings` | `^0.1.0-rc.6` |
| `@deepseek-ai/schemastery` | 按主仓库实际(见其 package.json) |
| `@deepseek-ai/cordis` | `^4.0.1` |

另外 `tsconfig.json` 里的 `references` 指向主仓库 vendor/各包路径,独立后应删除或改为 npm 包类型解析;构建产物 `lib/` 保留即可。

---

## 6. 验证清单

- [ ] `pnpm install && pnpm run test`(插件包):映射/请求/凭证/错误分类单测通过
- [ ] `redirect.spec.ts`:真实 HTTP 证明重定向不被跟随(凭证不跨源)
- [ ] `tavily.e2e.ts`:有 `$TAVILY_API_KEY` 时真实搜索通过;无 key 自跳过
- [ ] `dsh --profile web --dump-config | grep -A2 searchProvider` → `tavily`
- [ ] 真实会话:`web_search` 返回 Tavily 结果(answer → content,sources 带 snippet)
- [ ] 主仓库 `git status` 干净;`git pull --rebase` 无冲突
- [ ] 改 `~/.dsh/profiles/web/cordis.patch.yml` 触发 HMR 热重载,配置生效

---

## 7. 备份与恢复记录

- 2026-08-14 工作树 63 个改动(49 修改/删除 + 3 staged 归档 + 新包)已全部备份到 `dsh-plugins/`:
  - 插件源码 → `packages/web-search-tavily/`
  - 全部 diff → 主仓库根 `working-tree.patch`、`staged.patch`(见 §8 恢复操作前的快照)
  - Agent Notes → `docs/agent-notes-backup/`
- 主仓库已 `git restore` 回官方状态(本地构建缓存 node_modules/lib 保留)。
