# 问题与风险
- 可以继续使用 Neon PostgreSQL；上线时要确认阿里云 ECS 能访问 Neon，且 `DATABASE_URL` 建议带 `sslmode=require`。
- 微信支付公钥模式需要服务器 `.env.production` 配置 `WECHAT_PAY_PUBLIC_KEY_ID` 和 `WECHAT_PAY_PUBLIC_KEY_PATH`，并上传公钥文件。
- 商户 API 私钥和微信支付公钥不要通过 GitHub 上传，应通过宝塔文件管理或 SCP 上传到服务器 `certs/` 目录。
- 生产数据库仍需要执行 `npx prisma db push` 或等价迁移，否则新增支付字段不会存在。
- 当前无法真实扫码支付验证，需要生产环境变量、回调域名、公钥/私钥文件和公网环境配合联调。
- 服务器侧 `pm2`、`nginx`、HTTPS 检查尚未在真实远端环境执行。
