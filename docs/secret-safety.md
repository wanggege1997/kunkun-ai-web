# 密钥安全说明

这份文档说明哪些文件可以上传 GitHub，哪些不能上传。

## 一、什么是密钥文件

密钥文件就是放真实密码和 API Key 的文件，比如：

```text
.env
.env.local
.env.production
```

里面可能有：

```text
数据库账号密码
JWT_SECRET
RunningHub API Key
Redis Token
阿里云 OSS AccessKey
```

这些不能上传 GitHub，否则别人看到仓库就能看到你的密钥。

## 二、哪些文件可以上传

可以上传这种模板文件：

```text
.env.production.example
```

原因是它只放占位符，例如：

```env
JWT_SECRET="replace-with-a-long-random-string"
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public"
```

这些不是真实密钥，只是告诉你服务器上要填哪些配置。

## 三、哪些文件不能上传

这些文件不能上传：

```text
.env
.env.local
.env.production
.env.development
```

项目里的 `.gitignore` 已经配置好了，会忽略真实 `.env` 文件：

```gitignore
.env*
!.env*.example
```

意思是：

```text
.env*
忽略所有 .env 开头的文件

!.env*.example
但是允许上传 .env.production.example 这种模板文件
```

所以 GitHub 上只会有模板，不会有真实密钥。

## 四、推送 GitHub 前怎么检查

在本地项目目录执行：

```bash
git status --short
```

看输出里有没有这些文件：

```text
.env
.env.local
.env.production
```

如果没有，就正常。

再执行：

```bash
git ls-files -- .env .env.local .env.production .env.*
```

正常情况下，这个命令不应该显示真实 `.env` 文件。

再执行：

```bash
git check-ignore -v .env .env.local .env.production
```

正常情况下，它会显示这些文件被 `.gitignore` 忽略了。

## 五、如果不小心把密钥文件加入 Git 了

不要直接删除本地文件。用下面命令让 Git 不再跟踪它：

```bash
git rm --cached .env
git rm --cached .env.local
git rm --cached .env.production
```

这只会从 Git 记录里移除，不会删除你电脑上的文件。

如果密钥已经推送到 GitHub，建议立刻更换对应密钥，比如数据库密码、API Key、OSS AccessKey。
