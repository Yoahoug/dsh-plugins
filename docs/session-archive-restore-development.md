# session-archive-restore 开发记录

## 调研结论

DSH 原生归档会话只提供 archive 操作，没有 unarchive 或永久删除。归档状态位于已经由
`WorkspaceRegistry` 打开的 `workspace` domain 的 `global.archivedSessionIds`。

## 设计

本插件消费 `webServer`、`storageDomain`、`sessionPersistence`、`sessions` 和
`workspaceRegistry` 已有服务，注册四个 loopback-only HTTP 路由：

- `GET /api/dsh-launcher/archive-sessions`
- `POST /api/dsh-launcher/archive-sessions/restore`
- `POST /api/dsh-launcher/archive-sessions/delete`
- `POST /api/dsh-launcher/archive-sessions/delete-all`

恢复时从当前 global 快照移除一个会话 ID，再通过同一个 domain 的 `global.set()` 持久化。
因此写入仍然经过 DSH 的单域写队列、JSON/SQLite 后端和 `domain/changed` 事件，不会出现启动器
直接改文件而被运行中的 DSH 内存状态覆盖的问题。

插件不创建第二个 workspace domain，不修改 DSH 主仓库。永久删除会同步清理工作区表、
`session_projcache` 行和 JSONL session artifact；正在运行的会话及非 JSONL 后端拒绝删除。

## 安全与并发

- 只接受 `127.0.0.1`、`::1` 和 IPv4-mapped loopback 请求；
- POST body 上限 16 KiB；
- 会话 ID 只接受有限字符集；
- 插件层增加串行 read-modify-write 队列；
- DSH domain 自身仍是最终持久化顺序的权威。
- 永久删除按钮由启动器前端二次确认；删除后不提供恢复能力。

## 启用

```yaml
- id: session-archive-restore
  name: '@dsh-plugins/session-archive-restore'
```

启动器只在运行中的接口可用时调用热恢复/删除；DSH 停止时由启动器执行 JSON 存储的离线恢复/删除。
