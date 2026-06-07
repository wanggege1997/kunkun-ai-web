# 问题与风险
- 可以继续使用 Neon PostgreSQL；上线时要确认阿里云 ECS 能访问 Neon，且 `DATABASE_URL` 建议带 `sslmode=require`。
- 微信支付公钥模式需要服务器 `.env.production` 配置 `WECHAT_PAY_PUBLIC_KEY_ID` 和 `WECHAT_PAY_PUBLIC_KEY_PATH`，并上传公钥文件。
- 商户 API 私钥和微信支付公钥不要通过 GitHub 上传，应通过宝塔文件管理或 SCP 上传到服务器 `certs/` 目录。
- 生产数据库仍需要执行 `npx prisma db push` 或等价迁移，否则新增支付字段不会存在。
- 当前无法真实扫码支付验证，需要生产环境变量、回调域名、公钥/私钥文件和公网环境配合联调。
- 服务器侧已验证 `pm2` 和 HTTPS 能返回 200；曾出现 `next start 3000` 被当成目录参数导致 PM2 反复重启，应统一使用 `next start -p 3000` 或 `ecosystem.config.cjs`。
- 宝塔/Nginx 曾从 `/www/server/nginx/proxy_cache_dir` 返回旧首页 HTML，导致域名 HTML 引用旧 `/_next/static` 文件；Next.js 站点应关闭首页和 API 的反向代理缓存，部署后如异常需清理该缓存目录并 reload Nginx。
