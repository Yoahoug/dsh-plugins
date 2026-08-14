# @dsh-plugins/web-search-tavily

[English](README.md) | 中文

由 [Tavily](https://tavily.com) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。它调用 Tavily 的 `POST /search` 端点，请求合成答案，并把生成的 `answer` 与扁平 `results[]` 映射为 seam 规范化的 `WebSearchResult`。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | Tavily API 密钥字面量；建议使用 `apiKeyEnv`，避免密钥进入配置文件。 |
| `apiKeyEnv` | `$TAVILY_API_KEY` | 每次搜索通过凭据服务解析的凭据引用，回退到启动环境。 |
| `baseURL` | `https://api.tavily.com` | 端点基址；追加 `/search`。无法解析时提供方不可用。 |
| `searchDepth` | `basic` | 以 Tavily `search_depth` 发送的检索深度：`basic`（快速）或 `advanced`（更深入的分析）。 |
| `maxResults` | `5` | 请求不含 `maxResults` 时使用的默认结果数。必须是正整数。 |
| `includeAnswer` | `true` | 是否让 Tavily 生成合成答案，并映射到结果的 `content`。 |

```yaml
- id: web-search-tavily
  name: '@dsh-plugins/web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

## 设置命名空间（UI 卡片复用）

本提供方将其设置 section 注册在 **`web-search-deepseek`** 命名空间下，而非 tavily 自有命名空间。Web 设置卡片与 apiproxy 设置允许列表都硬编码了该命名空间，因此外部提供方必须复用它才能在不修改 harness 的情况下渲染卡片（`docs/tavily-search-development.md` §4.3 选项 A）。后果：

- profile **必须保持官方 `web-search-deepseek` 行禁用**（`disabled: true`），否则两个插件注册同一命名空间，设置启动会失败。
- 卡片的 `maxUses` 字段对应官方提供方的配置键，本插件**忽略**它（Tavily 使用 `maxResults`）；卡片的密钥控件指向 section 的 `apiKeyEnv`（默认 `TAVILY_API_KEY`）并经凭据服务存储，本插件按该引用解析。
- 若 harness 日后将卡片泛化为提供方可声明的命名空间（上游选项 B），再把这个 section 迁移回 `web-search-tavily`。

## 映射

Tavily 生成的 `answer`（开启 `includeAnswer` 时）成为 `content`。每项结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← 裁剪后的 `content` 摘要（摘要为空的结果缺少可移植的 snippet，会被丢弃）、`publishedAt` ← `published_date`。请求的 `maxResults` 优先于已配置的 `maxResults` 默认值，并作为 Tavily `max_results` 发送，以优化成本和延迟；最终上限由 seam 强制执行。提供方失败（HTTP 错误、网络失败、响应体无法解析或结构不符）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、内容摘要、发布日期与合成答案，或将确切的错误消息 `Tavily search aborted`、`Tavily search request failed: <error>` 和 `Tavily returned an unprocessable response body: <error>` 置于消费方的错误包装层内；提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **内容摘要为空的结果会被整个丢弃**：没有可映射的可移植 snippet，因此返回源可能少于请求数量。
- **只公开 `searchDepth`／`maxResults`／`includeAnswer`**：Tavily 的其他控制项（topic、时间范围、域名过滤、新闻 `days`）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)）。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError` 时才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）会呈现为 `WEB_PROVIDER_ERROR`。
