# @dsh-plugins/message-revise

Web 消息回溯/编辑:修正一条已发送的用户消息,让模型从修正后的干净历史继续。

**状态:开发方案已落地,待实现。** 完整方案见 [docs/message-revise-development.md](../../docs/message-revise-development.md)。

## 解决的问题

Web 界面无法回溯已发送消息——发错字只能重新发一条,浪费上下文并污染思考链。

## 方案要点

- 基于 DSH 会话层原生 `surfaceOp: { op: 'replace', start, end }` 机制(compaction 同款),追加一条 `user/message` 事件替换旧消息及其后的回复
- append-only 日志保留原始记录;模型请求只看到替换后的干净表面
- 第一期:`/revise` 斜杠命令(纯 host 插件);第二期:消息行"编辑"按钮(带 client 面)
- **主仓库零改动**,全部走命令注册 + 会话 append + 前端 Conversation Node / extraActions 扩展点

## 验证状态

- [ ] 定位/替换单测
- [ ] 隔离会话 surface replace 验证
- [ ] 真实会话重放验证
- [ ] (第二期)前端编辑按钮

## Known Limitations and Deferred Work

- 修正必然改变模型输入,会失效该轮 KV cache(预期行为)
- `end` 边界语义(遮蔽到对话尾部 vs 单条消息)待产品决策,默认遮蔽到尾部从修正处重答
