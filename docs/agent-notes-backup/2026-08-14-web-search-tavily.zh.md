# Agent Note：以 Tavily 作为出厂 web 搜索后端

Status: implemented

[English](2026-08-14-web-search-tavily.md) | 中文

## 问题

出厂 `web_search` 运行在 `@deepseek-ai/dsh-web-search-deepseek` 的 Anthropic 兼容 Messages 调用上，使用原生 `web_search_20250305` 服务端工具。每次搜索都消耗一次完整的辅助模型轮次，端点与 chat-completions 基址分叉，且提供方携带 DeepSeek 专属的会话事件与设置。产品需要一个专门的搜索 API：Tavily 的 `POST /search` 在单次普通 HTTP 往返中返回可选生成答案与扁平 `results[]`，不消耗模型轮次。

## 决策

`@deepseek-ai/dsh-web-search-tavily` 成为唯一的出厂搜索提供方。base 组合挂载 `dsh-web`（`searchProvider: tavily`）与 `web-search-tavily` 行（`apiKeyEnv: TAVILY_API_KEY`）；Exa、Perplexity 与 DeepSeek 三个搜索提供方包被删除，`dsh-tool-web` 的 `searchTimeoutMs: 60000` 覆盖被移除，因为普通 HTTP 搜索不再需要辅助模型轮次的预算。

**提供方形态。** 该插件是函数／命名空间插件（`inject: ['web']`），向 `ctx.web` 注册 `TavilySearchProvider`，结构沿用 Exa 包、凭据与设置沿用 DeepSeek 模式。配置携带 `apiKey`、`apiKeyEnv`（默认 `TAVILY_API_KEY`）、`baseURL`（默认 `https://api.tavily.com`，操作为 `/search`）、`searchDepth`（`basic`／`advanced`，默认 `basic`）、`maxResults`（默认 `5`）与 `includeAnswer`（默认 `true`）。密钥每次搜索通过可选的 `ctx.credentials` 服务解析，回退到启动环境——与 DeepSeek 提供方完全一致——因此在 Web Models/Settings 页输入或轮换的密钥无需重启即可作用于下一次搜索；密钥缺失时操作以点名该引用的 `WEB_PROVIDER_ERROR` 失败，而 `available()` 把已安装的解析器视为本地可用。

**映射。** Tavily 生成的 `answer` 成为 `WebSearchResult.content`；`results[]` 的每一项映射 `url`、`title`，裁剪后的 `content` 摘要映射为 `snippet`（摘要为空则丢弃该条目），`published_date` 映射为 `publishedAt`。请求在携带请求级 `maxResults` 时以 Tavily `max_results` 发送，否则发送配置默认值，作为成本／延迟优化；最终上限仍由 seam 强制执行。HTTP 重定向在访问 `Location` 指向的目标之前被拒绝（`redirect: 'error'`），遵循 web 包的重定向规则；中止分类与错误词汇与 Exa 提供方完全一致（`WEB_ABORTED`／`WEB_PROVIDER_ERROR`）。

**设置与 UI。** 插件注册 `web-search-tavily` 设置命名空间（端点、深度、结果数、密钥引用），并通过 source thunk 每次搜索投影选项，因此已存储的变更无需重新注册提供方即可作用于下一次搜索。Web 设置卡片（`dsh-client-ui-settings-plugins`）编辑 `apiKeyEnv`／`baseURL`／`maxResults`，并通过凭据领域写入密钥；apiproxy 的 `WEB_SETTINGS_NAMESPACES` allowlist 条目与卡片命名空间从 `web-search-deepseek` 更名为 `web-search-tavily`。DeepSeek 专属的 `web/deepseek-search-llm-request` 会话事件随之消失：Tavily 搜索是普通工具结果，以 `tool/call`／`tool/result` 持久记录，没有辅助模型请求。

**安全边界，保持不变。** `web_fetch` 仍保持禁用，且不挂载任何 fetch 提供方，维持"模型不得选择任意 URL 检索"的出厂姿态。

## 备选方案

**保留 DeepSeek 搜索并让 Tavily 与之并存。** 否决：产品只需要一个出厂搜索后端，且 base 组合显式固定 `searchProvider`，额外提供方只能通过 overlay 选择；被删包在本仓库没有外部消费者（pre-release 姿态）。

**在请求体中复用 `api_key`。** 否决：Tavily 两种形式都接受，但 `Authorization: Bearer` 头让密钥不进入 JSON 体，与 Exa 提供方的凭据处理及重定向拒绝理由一致。

**不发送默认 `max_results`。** 否决：Tavily 自身的默认值就是 5，但插件的 `maxResults` 默认值让出厂行为显式且可配置，Web 设置卡片也编辑它。

## 后果

每个出厂 surface 的 `web_search` 现在消耗一次针对 Tavily 的普通 HTTP 往返，而不是一次辅助模型轮次；模型可见的工具 schema、提示引导与来源卡片呈现不变，因为 `dsh-tool-web` 拥有它们。Web 快照通道（`apps/web/tests/web-search-round.e2e.ts`）重放模型流，同时让真实 Tavily 提供方调用确定性的本地 JSON 双端，断言 `/search` 请求（bearer 密钥、`query`、`search_depth`、`include_answer`、`max_results`）、映射到 content 的生成答案、受限的结构化结果与已定的卡片 golden。单元覆盖固定映射、可用性、请求成形、重定向拒绝（真实 HTTP）、凭据解析、设置分节与 HMR 安全注册；真实 API 冒烟测试在缺少 `$TAVILY_API_KEY` 时自行跳过。
