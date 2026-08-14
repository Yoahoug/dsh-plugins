# Message Revise — Web 消息回溯/编辑插件开发方案

> 目标:解决 web 界面无法回溯已发送消息的问题——用户消息发错/想改时,目前只能重新发一条,浪费上下文并污染思考链。本插件提供**原地修正已发送用户消息**的能力:模型看到的后续历史基于修正后的干净消息,append-only 日志仍保留原始记录。
>
> 调研基于主仓库 HEAD `47f943859b`(2026-08-14,`0.1.0-rc.5` 工作树);**主仓库零改动**,全部走现有扩展点。

---

## 1. 结论

| 问题 | 结论 |
|---|---|
| 能否实现"编辑已发送消息"? | ✅ 能。会话层原生支持 `surfaceOp: {op:'replace'}`(已被 compaction 生产使用),插件可直接调用 |
| 需要改主仓库吗? | **零改动**。走命令注册 + 会话 append + 前端 Conversation Node / extraActions 扩展点 |
| 模型看到什么? | 替换后的干净历史(replace 事件遮蔽旧范围);append-only 日志保留原始记录 |
| 交互形态 | `/revise` 斜杠命令(第一期)+ 消息行"编辑"按钮(第二期) |
| 前端 UI 面能否加载? | ✅ `ClientModuleRegistry` 从 loader entries 扫描,profile 补丁 insert 的外部 `dsh.client` 行可进 web roster |

## 2. 机制原理(调研事实)

### 2.1 会话层原生支持"替换历史消息"

`packages/core/session/src/surface.ts` 定义完整机制:

- 每个 surface-eligible 事件(`user/message`、`assistant/message`、`tool/result`)必须携带 `surfaceOp`:
  - `'append'` — 追加到模型可见表面尾部(普通消息)
  - `{ op: 'replace', start, end }` — **替换**表面中 start..end 范围内的节点
- 追加一个 `user/message` 事件携带 replace surfaceOp → 该消息成为新的表面节点,旧范围被遮蔽
- **append-only 日志保留原始记录**(审计/回放安全),**模型请求只看到替换后的表面**(`deriveMessages` 折叠表面)——"浪费上下文和污染思考链"从机制上解决
- **compaction 已在生产使用此机制**:`compaction-basic/src/region.ts:463` 用摘要消息 replace 掉一段历史——代码现成可参考
- 校验规则(append 时由 `SurfaceManager.validateNext` 强制):
  - `sourceEventSeqs` 必须包含所有被 shadow 的节点(provenance)
  - `tool/result` 替换只能改 content(本插件只动 `user/message`,不受限)
  - 替换范围必须存在且 start ≤ end

### 2.2 命令注册(host 侧,第一期入口)

`packages/interaction/commands` 服务 + `ctx.commands.register`:

```ts
ctx.commands.register({
  name: 'revise',
  description: '修正上一条用户消息',
  handler: async (invocation) => {
    // invocation.agent.session → 拿到 live Session
    // invocation.rawInput → 新文本
  },
})
```

- `CommandInvocation` 携带 `agent`(含 `session`)、`rawInput`、`signal`、`commandId`
- `/compact` 命令(`compaction/command-compact`)是完整模板:注册、handler、错误分类、成功文本
- 斜杠命令由 BFF `session.prompt` 识别(内容以 `/` 开头),走命令注册表,**不发给模型**

### 2.3 前端 UI 面(第二期:编辑按钮)

- `MessageIconActions` 已支持 `extraActions`(插件可塞自定义按钮)与 `onBranch`
- `conversation.chat.node` 可注册自定义消息渲染器(Conversation Node 机制,见 cookbook)
- 用户消息气泡(`MessageItem.tsx`)当前只有 copy+clock,**无 branch/编辑**——注释明确 "branch lives only under assistant answers"
- **web 前端加载外部 client 插件**:`ClientModuleRegistry` 从 `ctx.loader.entries()` 扫描全部行(含 profile 用户补丁 insert 的外部行),通过 `dsh.client` 声明 + `exports["./client"]` 进入 `window.__DSH_BOOT__` roster——**外部插件带 UI 面可行**

### 2.4 BFF 已透传 surfaceOp

`sessions.schema.ts:47` 的 `sessionEventSchema` 已包含 `surfaceOp` 字段——wire 层无需改。

## 3. 交互设计

### 3.1 第一期:`/revise` 斜杠命令(纯 host 插件,无 UI)

```text
/revise <新文本>                 # 修正最后一条用户消息
/revise 5 <新文本>               # 修正指定序号的消息(从 1 开始计数用户消息)
/revise undo                    # 撤销上一次修正(可选,第二期)
```

行为:
1. 解析参数:目标消息序号(默认最后一条用户消息)+ 新文本
2. 在 session 日志中定位目标 `user/message` 事件(append-origin)
3. 构造 replace 事件:`session.append('user/message', 修正消息, { surfaceOp: { op: 'replace', start: 目标seq, end: 表面尾部seq }, sourceEventSeqs: [被遮蔽节点...] })`
   - `end` 取当前表面尾部 → 目标消息**及其后的所有回复**都被遮蔽,模型从修正消息重新回答
4. 触发重放:复用 `agent.followup(message)`(与 `session.prompt` 相同的承认路径)让 agent 基于新表面重新处理——需确认具体重放 API(见 §6 风险)
5. 返回成功文本,如 `修正了消息 #5,已重新开始回复`

### 3.2 第二期:消息行"编辑"按钮(带 client 面)

- 用户消息气泡加"编辑"图标(经 `conversation.chat.node` 自定义 renderer 或 `extraActions`)
- 点击 → 气泡变输入框,预填原文 → 保存 → 调用 host 侧同一修正逻辑
- 需要:插件同时有 host 面(命令/逻辑)与 client 面(UI),经现有 RPC(`session.prompt` 类)或新 command 通道通信

## 4. 插件包结构

```
packages/message-revise/
├── package.json            # @dsh-plugins/message-revise
├── tsconfig.json           # extends 根 tsconfig.base.json
├── src/
│   ├── index.ts            # host 插件入口:name/inject/Config/apply,注册 /revise 命令
│   ├── revise.ts           # 核心修正逻辑:定位消息 → 构造 replace → 重放
│   ├── locate.ts           # 用户消息定位(序号 → seq、默认最后一条、边界校验)
│   ├── types.ts            # 参数/结果类型
│   └── invariant.ts        # 包级 invariant 伴侣
├── tests/
│   ├── locate.spec.ts      # 消息定位(序号/默认/越界)
│   ├── revise.spec.ts      # replace 构造:surfaceOp、sourceEventSeqs、边界
│   └── revise.e2e.ts       # 真实会话:修正后模型看到新历史(有 key)
├── README.{md,zh.md} + README.i18n.yaml
└── (第二期)src/client/     # UI 面:编辑按钮 renderer
```

## 5. 关键实现细节

### 5.1 定位目标消息

```ts
// 用户消息按 append-origin 顺序编号(跳过 replace 副本):
// session.events 过滤 isAppendSurfaceEvent && type === 'user/message'
function locateUserMessage(session: Session, ordinal: number): SessionEvent | undefined
```

### 5.2 构造 replace(核心)

```ts
const surface = session.surface.nodes           // 当前模型可见表面 seq 列表
const tailSeq = surface.at(-1)                  // 表面尾部(遮蔽到它为止)
const target = locateUserMessage(session, ordinal)
const shadowed = surface.filter(seq => seq >= target.seq && seq <= tailSeq)

session.append('user/message', revisedMessage, {
  surfaceOp: { op: 'replace', start: target.seq, end: tailSeq },
  sourceEventSeqs: [...shadowed],
})
```

### 5.3 重放触发

- 目标:`agent.followup(revisedMessage)` — 与普通 prompt 相同的承认路径
- 需确认:followup 是否基于当前表面自动重建请求(是,`deriveMessages` 折叠表面)——见 §6 风险 1

## 6. 风险与待验证项(开发前 30 分钟验证)

| # | 风险 | 影响 | 验证方法 |
|---|---|---|---|
| 1 | **重放 API**:`agent.followup` 是否基于新表面重建请求 | 高(方案核心) | 隔离 profile 里 append replace 后调用 followup,看模型请求历史是否干净 |
| 2 | `session.append` 从插件调用是否有权限/时序限制 | 中 | 隔离环境直接调用;compaction 是核心包,外部插件可能需经 agent/session 服务 |
| 3 | replace 后表面 `end` 选择:截到回复尾 vs 对话尾 | 中(语义) | 产品决策:默认遮蔽到对话尾部(从修正处重答) |
| 4 | `sourceEventSeqs` 构造错误 → append 抛错 | 低(可测) | 单测覆盖 provenance 校验 |
| 5 | 前端 `dsh.client` roster 对 file: 安装包的 resolve | 中 | 第二期:file: 包经 `ctx.baseUrl` resolve 是否命中;不行则先发布 npm |
| 6 | 修正后 KV-cache 失效 | 低(预期) | 修正必然改变模型输入,缓存失效是正确行为 |

## 7. 实施步骤

**第一期(host 插件,先跑通核心)**:
1. 建包骨架(package.json/tsconfig/invariant/README)
2. 实现 `locate.ts` + `revise.ts`(纯函数,先单测)
3. 实现 `/revise` 命令注册(参考 `command-compact` 模板)
4. 单测:定位、replace 构造、错误分类
5. 隔离 profile 集成验证(§6 风险 1、2)
6. 安装进 profile、真实会话验证
7. 部署记录更新

**第二期(UI 按钮)**:
8. client 面:消息行编辑按钮(Conversation Node / extraActions)
9. `dsh.client` 声明 + client bundle 构建
10. 前端集成测试(参考 GUI 测试三层级)

## 8. 验证清单

- [ ] `pnpm run test`(插件包):locate/revise 单测通过
- [ ] replace 事件 `surfaceOp`/`sourceEventSeqs` 符合 `SurfaceManager.validateNext` 校验
- [ ] 隔离会话:修正后 `session.surface.nodes` 显示新消息、旧范围被遮蔽
- [ ] 真实会话:agent 回复基于修正后的消息(无错误文本残留)
- [ ] 主仓库 `git status` 干净
- [ ] (第二期)web 前端出现编辑按钮,点击→编辑→保存→重放

## 9. 相关参考

- 主仓库 `packages/core/session/src/surface.ts` — replace 机制完整实现
- 主仓库 `packages/compaction/compaction-basic/src/region.ts` — replace 生产用法
- 主仓库 `packages/compaction/command-compact/src/index.ts` — 命令注册模板
- 主仓库 `packages/interaction/commands/src/index.ts` — 命令服务定义
- 主仓库 `docs/cookbook/adding-a-conversation-node.md` — 前端消息行扩展
- 主仓库 `packages/client/modules/src/index.ts` — web roster 扫描机制
