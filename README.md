# dsh-plugins — DeepSeek Harness 外部插件仓库

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH)能力缝开发的**外部插件集合**。插件以独立 npm 包形式放在 `packages/`,通过 `dsh plugin --profile <name> add <package>` 安装到本地 profile,不修改 DSH 主仓库源码——上游更新再频繁也零冲突。

## 目录结构

```
dsh-plugins/
├── packages/            # 插件包(每个子目录一个独立 npm 包)
├── docs/                # 开发与部署文档
├── AGENTS.md            # 开发规范(插件结构/测试/安全/发布)
└── README.md            # 本文件
```

## 插件清单

| 包 | 能力缝 | 角色 | 说明 |
|---|---|---|---|
| [`@dsh-plugins/web-search-tavily`](packages/web-search-tavily/README.md) | web (search) | Service Provider | Tavily 搜索 provider;已部署到 `~/.dsh/profiles/web`,把 agent 默认 `web_search` 后端切换为 Tavily(部署记录见 [docs/tavily-search-deployment.md](docs/tavily-search-deployment.md)) |
| [`@dsh-plugins/vision-bridge`](packages/vision-bridge/README.zh.md) | llm/stream (waterfall) | Consumer | 给无视觉模型桥接图片理解:在 `llm/stream` 层把用户上传图片改写为提示文本,经 OpenAI 兼容视觉端点(`gemini-3.6-flash`)转成描述交给模型;工具 `describe_image`,多模态模型默认不暴露(开发记录见 [docs/vision-bridge-development.md](docs/vision-bridge-development.md)) |

## 快速开始

以 `web-search-tavily` 为例(其他包流程相同):

```sh
# 构建插件
cd packages/web-search-tavily
pnpm install && pnpm run build

# 安装到 profile(已发布时用包名,未发布用本地路径)
dsh plugin --profile web add @dsh-plugins/web-search-tavily
dsh plugin --profile web add file:../../packages/web-search-tavily

# 在用户补丁层切换默认搜索(详见部署记录)
# ~/.dsh/profiles/web/cordis.patch.yml → 见 docs/tavily-search-deployment.md
```

## 相关文档

- [docs/tavily-search-development.md](docs/tavily-search-development.md) — Tavily 搜索插件开发文档(能力缝机制、实现解剖)
- [docs/tavily-search-deployment.md](docs/tavily-search-deployment.md) — Tavily 部署记录(补丁写法、凭证配置、验证结果)
- [docs/vision-bridge-development.md](docs/vision-bridge-development.md) — vision-bridge 开发文档(无视觉模型的图片理解桥接)
- [AGENTS.md](AGENTS.md) — 开发规范:新增插件的结构、测试、安全、发布要求
