# dsh-plugins — DeepSeek Harness 自定义插件仓库

本仓库集中管理基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(DSH)能力缝开发的**外部插件**。所有插件以独立 npm 包形式存在,通过 `dsh plugin --profile <name> add <package>` 安装到本地 profile,不修改 DSH 主仓库源码——上游更新再频繁也零冲突。

> 开发规范见 [AGENTS.md](AGENTS.md);README 只介绍仓库功能与安装方法。

## 为什么是独立插件仓库

DSH 是插件化架构(一切皆插件,vendored Cordis),能力缝 = Service Definition / Provider / Consumer 三角色。搜索 provider 是标准扩展点:

- `ctx.web` 服务由 `@deepseek-ai/dsh-web`(Service Definition)拥有
- provider 插件(如本仓库的 tavily)注册进 `ctx.web` 的 provider registry
- `searchProvider` 配置钉死选哪个 provider,模型不会自己选

**官方推荐形态**:插件放主仓库外 → `dsh plugin --profile web add` 安装 → 在 `~/.dsh/profiles/<name>/cordis.patch.yml`(用户补丁层,永远盖过 bundle 层)里覆盖 `searchProvider`。主仓库 `git pull` 永远干净。

## 目录结构

```
dsh-plugins/
├── README.md                       # 本文件:仓库总览
├── AGENTS.md                       # 开发规范(插件结构/测试/安全/发布)
├── docs/
│   ├── tavily-search-development.md  # Tavily 插件完整开发文档(调研+实现+部署)
│   └── tavily-search-deployment.md   # 部署执行记录(含验证结果)
├── packages/
│   └── web-search-tavily/          # Tavily 搜索 provider 插件
│       ├── src/                    # 插件源码(index/provider/types/invariant)
│       ├── tests/                  # vitest 单元 + 真实 HTTP + e2e
│       ├── lib/                    # 构建产物(tsc 输出)
│       └── package.json
```

## 插件清单

| 包 | 能力缝 | 角色 | 状态 |
|---|---|---|---|
| `@dsh-plugins/web-search-tavily` | web (search) | Service Provider | ✅ 已部署到 `~/.dsh/profiles/web`(部署记录见 [docs/tavily-search-deployment.md](docs/tavily-search-deployment.md));参考实现见 [docs/tavily-search-development.md](docs/tavily-search-development.md) |

## 安装到本地 profile

```sh
# 1. 在插件包目录构建
cd packages/web-search-tavily
pnpm install
pnpm run build          # 生成 lib/

# 2. 安装进 profile(方式一:npm 发布后)
dsh plugin --profile web add @dsh-plugins/web-search-tavily

# 3. 方式二:本地路径(未发布时)
dsh plugin --profile web add file:../../packages/web-search-tavily

# 4. 在用户补丁层切换默认搜索(改 ~/.dsh/profiles/web/cordis.patch.yml)
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'
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
EOF
```

## UI 设置卡片:命名空间复用

Web 设置页的搜索卡片与 apiproxy 设置白名单把 provider 的 settings 命名空间硬编码为 `web-search-deepseek`(主仓库代码层依赖,外部插件无法修改)。因此本插件的 settings section **故意注册在 `web-search-deepseek` 命名空间**下以复用卡片:

- 前提:profile 补丁必须 `disabled: true` 停用官方 `web-search-deepseek` 行(否则两个插件注册同一命名空间,settings 启动失败);
- 卡片 `maxUses` 字段被本插件忽略(Tavily 用 `maxResults`),卡片密钥控件经凭据服务写入 `apiKeyEnv`(默认 `TAVILY_API_KEY`)引用的值,本插件按引用解析;
- 若上游日后把卡片泛化为 provider 可声明的命名空间,再迁移回 `web-search-tavily`。
