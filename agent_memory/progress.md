# 当前任务进度

- 任务：发布微信 Native 支付与安全收口版本到 GitHub。
- 状态：准备提交并推送 `v0.2.0`。
- 已完成：
  - 微信 Native 扫码支付、微信支付公钥模式回调验签、支付/退款回调、管理员人工退款入口。
  - 积分接口 `points/recharge|consume|refund` 收口为内部密钥调用。
  - 前端取消任务改走 `api/tasks/cancel`。
  - 生产环境变量模板和宝塔部署文档更新，明确可继续使用 Neon PostgreSQL。
  - 站点 metadata 更新为 `坤坤 AI`。
  - 首页 lint warning 清理，logo 改用压缩 WebP。
  - 版本号从 `0.1.0` 提升到 `0.2.0`。
- 已验证：
  - `npx tsc --noEmit --incremental false --pretty false`
  - `npm run lint`
  - `npm run build`
- 发布规则：
  - 本次提交到 `main`。
  - 创建并推送 tag：`v0.2.0`。
  - 服务器可以继续拉 `main` 最新，也可以按 tag 拉取 `v0.2.0`。
