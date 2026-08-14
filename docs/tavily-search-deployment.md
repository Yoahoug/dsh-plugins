# Tavily 搜索引擎切换部署记录 — dsh-plugins × ~/.dsh

> 目标:在不修改 DSH 主仓库(`deepseek-harness`,只读)任何文件的前提下,把 agent 的 `web_search` 工具后端从官方 DeepSeek 搜索切换为 Tavily,并端到端验证可用。
>
> 本文是**部署执行记录**(2026-08-14,主仓库 HEAD `47f943859b`,profile `web`);调研与插件实现解剖见 [tavily-search-development.md](tavily-search-development.md)。

---

## 1. 结论

| 验证项 | 结果 |
|---|---|
| `pnpm run test`(插件单测) | ✅ 42/42 通过(settings 4 + tavily 32 + redirect 6) |
| `dsh --profile web --dump-config` | ✅ 合成树 `web.searchProvider = tavily`;`web-search-deepseek` 行 `disabled: true`;`web-search-tavily` 行已 insert |
| 真实 Tavily API(`pnpm run test:e2e`,有 key) | ✅ 1/1 通过(1.4s,返回 sources + 合成 answer) |
| 运行时挂载(隔离 DSH_HOME 真实 boot) | ✅ HTTP 200、零错误日志;插件被 loader 按裸名成功解析并挂载 |
| **HMR 热加载(实证)** | ✅ 补丁写入后**无需重启**:新装插件热挂载、官方 provider 热卸载、命名空间无缝交接;后续配置编辑即时生效(§4.5) |
| 主仓库 `git status` | ✅ 干净(零改动、零未跟踪文件) |
| 主仓库 `git pull` 冲突风险 | 零(未触碰主仓库任何文件) |
| UI 设置卡片 | 方案 A:插件 settings 命名空间复用 `web-search-deepseek`,卡片可渲染(见 §3.1) |

改动面:`dsh-plugins`(插件源码 1 处 + 测试/README 同步)+ `~/.dsh/`(profile 依赖、用户补丁、`.env`)。**主仓库零改动。**

---

## 2. 为什么这样部署(30 秒版)

- DSH 配置是分层补丁:官方 bundle(`dsh-base`)声明 `web` 行 `searchProvider: deepseek-official`,用户 profile 的 `cordis.patch.yml` 在其上做 id-targeted 覆盖,**最后写者胜出**——"默认官方搜索"是配置层的默认,在配置层解决。
- 搜索 provider 是标准能力缝扩展点:插件是 Service Provider,`inject: ['web']`,往 `ctx.web` 的 provider registry 注册(`registerSearchProvider`),**不拥有 `ctx.web` key**;`searchProvider` 配置钉死选择,模型不会自己挑 provider。
- `dsh plugin --profile web add` 是官方安装路径(转发 pnpm 到 profile 目录);out-of-tree bundle/插件是一等公民。
- 完整机制见 [tavily-search-development.md](tavily-search-development.md) §2、§4。

---

## 3. 执行步骤

### 3.1 插件改动:settings 命名空间复用(§4.3 选项 A)

**问题**:Web 设置页的搜索卡片(`dsh-client-ui-settings-plugins` 的 `WebSearchCard`)与 apiproxy 的 `WEB_SETTINGS_NAMESPACES` 白名单把 provider 的 settings 命名空间**硬编码为 `web-search-deepseek`**(主仓库代码层依赖,外部插件无法修改)。插件原本用自有命名空间 `web-search-tavily` → 卡片不渲染。

**处理(选项 A,零主仓库改动)**:插件 settings section 故意注册到 `web-search-deepseek` 命名空间,复用卡片。改动 1 处源码 + 同步测试/README:

- `packages/web-search-tavily/src/index.ts`:`WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = settingsNamespace('web-search-deepseek')`(常量名保留,加注释说明原因与前提)
- `packages/web-search-tavily/tests/settings.spec.ts`:3 处命名空间断言同步
- `packages/web-search-tavily/README.{md,zh.md}`:新增 "Settings namespace (UI card reuse)" 章节;修正示例包名 `@deepseek-ai/dsh-web-search-tavily` → `@dsh-plugins/web-search-tavily`;更新 `README.i18n.yaml` 双语 hash
- `README.md`(仓库根):插件清单状态更新 + 选项 A 说明

**前提与代价**(已核实机制):

- 官方 `web-search-deepseek` 行必须 `disabled: true`(补丁中已做),否则两个插件注册同一命名空间,settings 启动报 `namespace already registered`。
- 卡片保存 `{baseURL, maxUses, apiKey}` 时,schemastery `z.object` 非 strict 模式对未知键是 **merge 保留不报错**(vendor/schemastery `object` resolver:`if (!strict) merge(result, data)`),所以 `maxUses` 写入不会失败,只是被本插件忽略(Tavily 用 `maxResults` 默认 5)。
- 卡片凭证控件读 section 的 `apiKeyEnv`(**resolved 值含 schema 默认**,即 `TAVILY_API_KEY`),经 credentials 服务写入该引用——正好是本插件解析的引用。
- 命名不符(卡片显示 DeepSeek 字样/`maxUses` 字段)是已知代价,README 已说明;上游泛化卡片(选项 B)后再迁移回 `web-search-tavily`。

### 3.2 测试与构建

```sh
cd /Users/yoahoug/Desktop/dsh-plugins
pnpm run test        # 42/42 通过
cd packages/web-search-tavily
pnpm run build       # tsc → lib/(含新命名空间)
pnpm run typecheck   # 通过
```

### 3.3 安装进 profile

```sh
# 主仓库提供 CLI(source launch,tsx)
cd /Users/yoahoug/Desktop/deepseek-harness
pnpm dsh plugin --profile web add file:/Users/yoahoug/Desktop/dsh-plugins/packages/web-search-tavily
```

结果:`~/.dsh/profiles/web/package.json` 增加依赖 `"@dsh-plugins/web-search-tavily": "file:.../packages/web-search-tavily"`,profile 内 pnpm 完成安装(4 个包)。CLI 提示 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`——**符合预期**:行由用户补丁 insert,包按裸名从 profile `node_modules` 解析(已用 `node --input-type=module -e "import('@dsh-plugins/web-search-tavily')"` 在 profile 目录验证解析成功,导出 `name/inject/apply/Config` 齐全)。

### 3.4 用户补丁层

`~/.dsh/profiles/web/cordis.patch.yml`(`[]` → 完整补丁,id-targeted 整段替换 config,故 `web` 行 restate 其唯一字段):

```yaml
- id: web
  config:
    searchProvider: tavily

- id: web-search-deepseek
  disabled: true

- insert:
    - id: web-search-tavily
      name: '@dsh-plugins/web-search-tavily'
      config:
        apiKeyEnv: TAVILY_API_KEY
```

要点:

- id-targeted 补丁**整段替换**目标行 config(不深合并),`web` 行 bundle 原 config 只有 `searchProvider`,restate 后即完整;
- `disabled: true` 是选项 A 的硬前提(§3.1);
- `insert` 无 id 时 push 到顶层条目列表(vendor/include `applyEntryPatches`);
- 空文件/纯注释文件会 throw,本补丁是真实条目,无此问题。

### 3.5 凭证(最终布局)

**两层都配了**(managed store 热生效 + `.env` 启动 fallback):

- `~/.dsh/.credentials.yaml`(managed store,`chmod 600`,**运行中热发布**——credentials-local 用 chokidar 监视,外部编辑立即生效,下一条搜索即可解析):
  ```yaml
  DEEPSEEK_API_KEY: sk-...      # 原有,未动
  TAVILY_API_KEY: tvly-...      # 本次追加
  ```
- `~/.dsh/.env`(新文件,`chmod 600`):
  ```
  TAVILY_API_KEY=tvly-...
  ```

**优先级与生效时机**(credentials-local 源码 `resolve()`):

```
进程环境变量(启动快照,最高,不可写) > ~/.dsh/.credentials.yaml(managed,热发布)
> <调用目录>/.env(启动快照)> ~/.dsh/.env(启动快照)
```

> ⚠️ 教训:`~/.dsh/.env` 是**启动时快照**,运行中进程看不到之后写入的 key。部署当日先写了 `.env`,但 GUI 早于写入启动,`credentials.describe` 探测到 `configured: false`;改写入 `.credentials.yaml` 后热发布,探测变为 `configured: true, source: file`。**换 key 改 `.credentials.yaml`(或 UI 卡片)立即生效;改 `.env` 需重启进程。**

---

## 4. 验证结果

### 4.1 单元测试

```
Test Files  3 passed (3)
     Tests  42 passed (42)
```

### 4.2 合成配置树

```sh
cd /Users/yoahoug/Desktop/deepseek-harness
pnpm dsh --profile web --dump-config
```

关键行(注意 `# ==` 层注释标明来源):

```yaml
# == @deepseek-ai/dsh-base, patched by /Users/yoahoug/.dsh/profiles/web/cordis.patch.yml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: tavily
- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
  disabled: true
...
# == /Users/yoahoug/.dsh/profiles/web/cordis.patch.yml
- id: web-search-tavily
  name: '@dsh-plugins/web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

### 4.3 真实 Tavily API(e2e)

```sh
cd /Users/yoahoug/Desktop/dsh-plugins
TAVILY_API_KEY=$(grep -oE 'TAVILY_API_KEY=.*' ~/.dsh/.env | cut -d= -f2-) pnpm run test:e2e
# ✓ TavilySearchProvider real API > returns sources and a synthesized answer for a live query (1413ms)
```

真实 `POST https://api.tavily.com/search` 成功:`sources[]` 全部为 http(s) URL、`content` 为合成 answer。e2e 自跳过逻辑(无 key 时 `describe.skip`)保持 CI 无密钥安全。

### 4.4 运行时挂载(隔离真实 boot)

不能用运行中的 GUI(3080)做破坏性验证,改用**隔离 DSH_HOME** 起真实 web profile 实例(profile 目录符号链接复用已安装的 node_modules,会话/存储写入 `/tmp`):

```sh
DSH_HOME=/tmp/dsh-home COREPACK_HOME=/tmp/corepack-home pnpm dsh --profile web --port 0
# dsh web: http://127.0.0.1:52168  → HTTP 200,日志零 error/warn/fail
```

证明:补丁+插件在真实 boot 路径完整可挂载(loader 解析裸名、插件 `apply` 注册 settings section + search provider 无冲突、无 `namespace already registered`)。之后已清理临时目录。

### 4.5 HMR 热加载(实证:无需重启)

官方契约(app-boot README Profiles 章节 + `apps/cli/src/profile-boot.ts` 注释):**每个长驻 surface 都通过 `watchUserPatches` 保持 `cordis.patch.yml` 实时生效**,`cordis.patch.yml` 编辑在长驻面上始终热应用;失败的读/解析/加载候选保留最后好树并广播 `hmr/config-update-failed`。

**实证(隔离实例,`settings.describe` RPC 观测,loopback 通过 trust fence)**:

1. 以旧补丁 `[]` boot → 命名空间 `web-search-deepseek` 的 base 为官方形态:
   ```json
   {"apiKeyEnv": "DEEPSEEK_API_KEY", "model": "deepseek-v4-flash", "apiVersion": "2023-06-01", "maxTokens": 4096, "maxUses": 5}
   ```
2. 写入真实补丁(disable 官方 + insert tavily)→ 8 秒后再探:
   ```json
   {"apiKeyEnv": "TAVILY_API_KEY", "searchDepth": "basic", "maxResults": 5, "includeAnswer": true}
   ```
   → **新装插件被热挂载、官方 provider 被热卸载、同一命名空间无缝交接**(这正是 loader 先挂新条目后卸旧条目的时序窗口,本次竞态以卸载先行胜出)。
3. 再改 tavily 行 config(`maxResults: 7`)→ base 即时变为 `"maxResults": 7` → **后续配置编辑全部热生效**。

**结论**:

- `dsh plugin add` 之后写补丁,顺序保证:补丁写入触发的 HMR 重组时,profile `node_modules` 已含插件,裸名从根 config 目录(profile 目录)经 Node 父级查找解析——**无需重启**;
- **运行中 GUI(3080)实测**:部署当日对 `http://127.0.0.1:3080/api/settings.describe` 做只读探测,`web-search-deepseek` 命名空间 base 已呈 tavily 形态(`apiKeyEnv: TAVILY_API_KEY, searchDepth: basic, maxResults: 5, includeAnswer: true`)——切换在运行实例上**已热生效,无需重启**;
- 运行中的 GUI(3080)在我 10:11 写入补丁时正在运行,同一序列已被实证成功,切换**应当已经热生效**;
- 唯一需要重启的情形:GUI 在补丁写入时未运行(补丁在 boot 时读取,天然生效,无需重启);或补丁写入时插件尚未安装完。
- 观测边界:web profile 未挂 console logger,HMR 事件无日志;本次用 `POST /api/settings.describe`(envelope `{type:"client-request",rpcId,method:"settings.describe",payload:{}}`)做行为级观测。

### 4.6 主仓库干净

```sh
git -C /Users/yoahoug/Desktop/deepseek-harness status --porcelain   # 空输出
```

HEAD `47f943859b` 无改动、无未跟踪文件。`dsh-plugins` 本身不是 git 仓库,无需提交。

---

## 5. 遇到的问题与解决

| 问题 | 现象 | 解决 |
|---|---|---|
| 沙箱拦截 corepack 缓存写入 | `dsh plugin add` 报 `EPERM mkdir ~/.cache/node/corepack/...` | `COREPACK_HOME=/tmp/corepack-home` 重定向 |
| 沙箱拦截 profile 写入 | `EPERM open ~/.dsh/profiles/web/package.json` | 任务范围本就在 `~/.dsh/`,升级完整文件权限后重试(一次性) |
| 插件命名空间 vs 卡片硬编码 | 自有命名空间 `web-search-tavily` 不被 UI 卡片渲染 | 选项 A:复用 `web-search-deepseek` 命名空间(§3.1),README 说明 |
| 卡片 `maxUses` 未知键 | 担心保存失败 | 核实 schemastery 非 strict merge 语义,未知键保留不报错,忽略即可 |
| 卡片凭证 ref 指向 | 担心写错 ref | resolved 值含 schema 默认 `apiKeyEnv: TAVILY_API_KEY`,卡片凭证控件自动指向正确引用 |
| 真实会话不可用 CLI 驱动 | `dsh --profile web` 只服务浏览器 UI,无一次性任务模式 | 以 e2e(真实 API)+ 隔离 boot(运行时挂载)+ settings RPC(热加载行为)覆盖;交互式 GUI 会话留作人工最终检查 |
| HMR 日志不可见 | web profile 无 console logger | 用 `POST /api/settings.describe` 观测命名空间 base 归属,实证热加载成功(§4.5) |

---

## 6. 当前配置快照

- `~/.dsh/profiles/web/package.json`:`dependencies["@dsh-plugins/web-search-tavily"] = "file:/Users/yoahoug/Desktop/dsh-plugins/packages/web-search-tavily"`(corepack 顺带写入 `packageManager` 字段,pnpm 正常行为)
- `~/.dsh/profiles/web/cordis.patch.yml`:§3.4 内容
- `~/.dsh/.env`:`TAVILY_API_KEY=tvly-dev-...`(600)
- `~/.dsh/.credentials.yaml`:`DEEPSEEK_API_KEY`(原有,未动)
- `~/.dsh/settings.yaml`:llm-deepseek baseURL 等(原有,未动)
- 插件:`packages/web-search-tavily/`(源码 + `lib/` 构建产物),测试 42 个 + e2e 1 个

## 7. 使用与回滚

- 生效:补丁写入即热生效(§4.5 实证,无需重启);若怀疑未生效,可再 touch 一次 `cordis.patch.yml` 触发重组,或重启 GUI。
- 改配置:编辑 `cordis.patch.yml` 热生效(如 `includeAnswer: false`、`baseURL`、`searchDepth`、`maxResults` 加进 tavily 行 config)。
- 回滚:改回 `searchProvider: deepseek-official`、删 `disabled: true`、删 insert 行(或整文件写回 `[]`);`dsh plugin --profile web remove @dsh-plugins/web-search-tavily` 卸载;删 `~/.dsh/.env` 中 TAVILY_API_KEY。
- 凭证换源:优先存 `~/.dsh/.credentials.yaml`(managed store)或经卡片/CLI 写;`.env` 只是 fallback。

## 8. 后续

- 选项 B(上游 PR):把 UI 卡片与 apiproxy 白名单泛化为 provider 可声明的命名空间,合入后本插件迁移回 `web-search-tavily`。
- 发布 npm:把 `@dsh-plugins/web-search-tavily` 发到 registry 后,安装命令可改为按包名(`dsh plugin --profile web add @dsh-plugins/web-search-tavily`),摆脱 `file:` 本地路径。
