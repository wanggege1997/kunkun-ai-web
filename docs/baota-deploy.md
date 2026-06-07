# 宝塔部署说明

这份文档是给 `kunkunai.top` 正式上线用的。

你的项目是 Next.js 网站，不是普通的静态 HTML 文件。宝塔不能只靠“站点目录”直接展示它，需要这样运行：

```text
用户访问 https://kunkunai.top
        ↓
宝塔里的 Nginx 接收请求
        ↓
Nginx 反向代理到 http://127.0.0.1:3000
        ↓
PM2 正在运行的 Next.js 网站返回页面
```

也就是说：Next.js 网站先在服务器本机的 `3000` 端口跑起来，宝塔再把域名请求转给它。

## 一、准备生产环境变量

服务器上需要一个真实的环境变量文件：

```text
.env.production
```

这个文件里会放数据库密码、API Key、JWT 密钥等真实配置，所以不能上传到 GitHub。

项目里已经有一个模板文件：

```text
.env.production.example
```

这个模板可以上传 GitHub，因为里面只有占位符，没有真实密钥。

第一次部署时，在服务器项目目录执行：

```bash
cp .env.production.example .env.production
```

然后打开 `.env.production`，把里面的占位内容改成真实值。

最重要的几项：

```env
# 表示这是正式环境
NODE_ENV=production

# Next.js 在服务器本机监听的端口
PORT=3000

# 你的正式网站地址
INTERNAL_BASE_URL=https://kunkunai.top

# 正式数据库连接地址。可以继续使用 Neon PostgreSQL，不必购买阿里云数据库。
DATABASE_URL="postgresql://用户名:密码@数据库地址:5432/数据库名?schema=public"
```

如果继续用 Neon，把 Neon 控制台里的 PostgreSQL 连接串填到 `DATABASE_URL` 即可。建议使用带 SSL 的连接串，例如：

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST/neondb?sslmode=require"
```

服务器部署在阿里云 ECS，不要求数据库也在阿里云；只要 ECS 能访问 Neon，Prisma 就能正常连接。

这些也要填真实值：

```env
JWT_SECRET="一串很长的随机密钥"
INTERNAL_WORKER_SECRET="另一串很长的随机密钥"
REDEEM_CODE_SALT="再一串很长的随机密钥"
RUNNINGHUB_API_KEY="你的 RunningHub API Key"
UPSTASH_REDIS_REST_URL="你的 Redis REST 地址"
UPSTASH_REDIS_REST_TOKEN="你的 Redis REST Token"
OSS_BUCKET="你的 OSS Bucket 名称"
OSS_REGION="oss-cn-shanghai"
OSS_ACCESS_KEY_ID="你的阿里云 OSS AccessKey ID"
OSS_ACCESS_KEY_SECRET="你的阿里云 OSS AccessKey Secret"
OSS_ENDPOINT="https://oss-cn-shanghai-internal.aliyuncs.com"
OSS_TEMP_PREFIX="tmp-inputs/"
TEMP_UPLOAD_MAX_MB=50

# 微信 Native 支付
WECHAT_MCH_ID="你的微信商户号"
WECHAT_APP_ID="你的公众号/小程序 AppID"
WECHAT_API_V3_KEY="你的 API v3 key"
WECHAT_API_CERT_SERIAL_NO="商户 API 证书序列号"
WECHAT_API_PRIVATE_KEY_PATH="/www/wwwroot/kunkunai.top/certs/wechat-api-private.pem"
WECHAT_PAY_PUBLIC_KEY_ID="微信支付公钥ID，通常以 PUB_KEY_ID_ 开头"
WECHAT_PAY_PUBLIC_KEY_PATH="/www/wwwroot/kunkunai.top/certs/wechatpay-public-key.pem"
WECHAT_NOTIFY_URL="https://kunkunai.top/api/pay/wechat/notify"
WECHAT_REFUND_NOTIFY_URL="https://kunkunai.top/api/pay/wechat/refund-notify"
```

如果你的 ECS 和 OSS 都在阿里云上海地域，`OSS_ENDPOINT` 建议用内网地址：

```env
OSS_ENDPOINT="https://oss-cn-shanghai-internal.aliyuncs.com"
```

如果不是同地域，或者本地测试，就用公网地址：

```env
OSS_ENDPOINT="https://oss-cn-shanghai.aliyuncs.com"
```

备案公示信息也放在生产环境变量里：

```env
# 网站底部版权主体名称
NEXT_PUBLIC_SITE_OWNER_NAME="你的公司或主体名称"

# ICP 备案号，例如：浙ICP备2026123456号
NEXT_PUBLIC_ICP_RECORD_NUMBER="你的ICP备案号"

# 公安联网备案号，例如：浙公网安备33010602000000号
NEXT_PUBLIC_POLICE_RECORD_NUMBER="你的公网安备号"

# 公安备案链接里的纯数字编号，例如：33010602000000
NEXT_PUBLIC_POLICE_RECORD_CODE="你的公安备案数字编号"
```

如果公安联网备案还没有审核通过，先不要伪造备案号。等公安备案通过后，把真实备案号和数字编号填到服务器 `.env.production` 和 `.env`，然后重新构建并重启网站。

## 二、首次上传项目

推荐服务器目录：

```bash
/www/wwwroot/kunkunai.top
```

你可以先用宝塔文件管理器、WinSCP、SCP 或 Git 把项目放到这个目录。

长期更推荐用 Git，因为以后更新更方便：

```text
本地改代码 → git push → 服务器 git pull → 重新构建 → 重启 PM2
```

## 三、服务器安装依赖并构建

SSH 登录服务器后执行：

```bash
cd /www/wwwroot/kunkunai.top
npm ci
npx prisma generate
npx prisma db push
npm run build
```

这些命令的意思：

```text
cd /www/wwwroot/kunkunai.top
进入项目目录

npm ci
按照 package-lock.json 安装依赖，适合服务器部署

npx prisma generate
生成 Prisma 数据库客户端

npx prisma db push
把 prisma/schema.prisma 里的数据库结构同步到正式数据库

npm run build
构建 Next.js 正式版本
```

## 四、用 PM2 启动网站

PM2 的作用是：让网站在后台一直运行，服务器重启后也方便恢复。

第一次安装 PM2：

```bash
npm install -g pm2
```

启动项目：

```bash
pm2 start ecosystem.config.cjs
```

保存 PM2 状态：

```bash
pm2 save
```

设置开机自启：

```bash
pm2 startup
```

执行 `pm2 startup` 后，终端可能会输出一行新的命令，让你复制再执行一次。按它提示做就行。

检查是否启动成功：

```bash
pm2 status
curl -I http://127.0.0.1:3000
```

如果 `curl` 返回 `200`、`301` 或 `302`，一般说明 Next.js 已经跑起来了。

## 五、宝塔里设置反向代理

进入宝塔：

```text
网站 → 找到 kunkunai.top → 设置 → 反向代理 → 添加反向代理
```

填写：

```text
代理名称：kunkunai
目标 URL：http://127.0.0.1:3000
发送域名：$host
```

保存后，宝塔/Nginx 会把访问 `https://kunkunai.top` 的请求转给 Next.js。

### 反向代理缓存设置

Next.js 站点不要缓存首页 HTML 和 `/api/*`。如果 Nginx 返回了旧 HTML，页面会继续引用旧的 `/_next/static/` 文件，用户就可能看到白屏、404、502 或一直卡在旧的加载状态。

在宝塔反向代理配置文件里找到类似：

```nginx
location ^~ /
{
    proxy_pass http://127.0.0.1:3000;
    ...
}
```

在 `location ^~ /` 内加入：

```nginx
proxy_cache off;
proxy_no_cache 1;
proxy_cache_bypass 1;
add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate" always;
```

保存后执行：

```bash
nginx -t
/etc/init.d/nginx reload
rm -rf /www/server/nginx/proxy_cache_dir/*
```

部署后可用下面两条命令确认 Nginx 返回的 HTML 和本机 Next.js 一致：

```bash
curl -s https://kunkunai.top | grep -o '/_next/static/[^"]*\.css' | head -1
curl -s http://127.0.0.1:3000 | grep -o '/_next/static/[^"]*\.css' | head -1
```

两条输出应当一致。

## 六、处理宝塔默认页

如果访问域名还显示：

```text
恭喜，站点创建成功！
```

说明还在显示宝塔默认首页。

处理方式：

```text
宝塔 → 文件 → /www/wwwroot/kunkunai.top
```

找到默认的：

```text
index.html
```

把它删除或改名，比如改成：

```text
index.html.bak
```

然后重新访问：

```text
https://kunkunai.top
```

## 七、开启 HTTPS

宝塔里进入：

```text
网站 → kunkunai.top → SSL
```

申请证书并开启：

```text
强制 HTTPS
```

你的网站正式访问地址应为：

```text
https://kunkunai.top
```

## 八、以后怎么更新网站

如果以后用 Git 更新，服务器上执行：

```bash
cd /www/wwwroot/kunkunai.top
git pull
npm ci
npx prisma generate
npx prisma db push
npm run build
pm2 restart kunkunai --update-env
/etc/init.d/nginx reload
```

每条命令的意思：

```text
git pull
从 GitHub 拉取最新代码

npm ci
按锁定版本安装依赖

npx prisma generate
重新生成 Prisma 客户端

npx prisma db push
同步数据库结构

npm run build
重新构建网站

pm2 restart kunkunai --update-env
重启网站服务，让新代码生效

/etc/init.d/nginx reload
让宝塔 Nginx 重新加载反向代理配置
```

## 九、常用排查命令

查看 PM2 运行状态：

```bash
pm2 status
```

查看网站运行日志：

```bash
pm2 logs kunkunai
```

检查 Next.js 本机端口：

```bash
curl -I http://127.0.0.1:3000
```

检查正式域名：

```bash
curl -I https://kunkunai.top
```

如果本机 `3000` 通，但域名不通，通常是宝塔反向代理或 Nginx 配置问题。

如果本机 `3000` 不通，通常是 PM2 没启动成功、环境变量错了，或者构建失败。

## 十、上线检查清单

正式部署完成后建议再跑一遍：

```bash
pm2 status
pm2 logs kunkunai
curl -I http://127.0.0.1:3000
curl -I https://kunkunai.top
```

如果 `http://127.0.0.1:3000` 通，但域名不通，重点查宝塔反向代理和 Nginx。
如果域名通但微信回调失败，重点查 `WECHAT_NOTIFY_URL`、微信支付公钥 ID、公钥文件、API v3 密钥和商户私钥路径。
