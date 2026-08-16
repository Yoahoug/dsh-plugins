# @dsh-plugins/session-archive-restore

为 DSH 增加归档会话的本地热管理接口。插件通过已经打开的 `workspace` domain
恢复或永久删除归档会话，不修改 DSH 主仓库、不重启服务。

## 接口

- `GET /api/dsh-launcher/archive-sessions`
- `POST /api/dsh-launcher/archive-sessions/restore`，请求体：`{"sessionId":"..."}`
- `POST /api/dsh-launcher/archive-sessions/delete`，请求体：`{"sessionId":"..."}`
- `POST /api/dsh-launcher/archive-sessions/delete-all`

接口只接受 loopback 请求。恢复或删除成功后，DSH 原生的 domain change 广播会使工作区同步显示结果。
删除会同时清理工作区引用、projection cache 和 JSONL 会话日志；正在运行的会话不能删除。

## Model Experience

该插件不参与模型推理、提示词或 KV-cache；它只提供桌面启动器使用的本地管理接口。

## 启用

```yaml
- id: session-archive-restore
  name: '@dsh-plugins/session-archive-restore'
```

安装插件：

```sh
dsh plugin --profile web add file:/绝对路径/dsh-plugins/packages/session-archive-restore
```

## Config

本插件没有用户可配置字段，直接使用 DSH 注入的 `webServer`、`storageDomain`、
`sessionPersistence`、`sessions` 和 `workspaceRegistry` 服务。

## Known Limitations and Deferred Work

当前不提供导出或会话日志迁移；非 JSONL 会话存储后端不支持永久删除。
