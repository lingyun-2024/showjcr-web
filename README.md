# ShowJCR 投稿站

ShowJCR 的网页版投稿目录和会议截止日历。访客无需登录即可查询。使用 GitHub 账号登录后，可以在不同设备上查看同一份会议收藏。

## 数据来源

- 目录以 CCF 国际 2026、CCF-T 2025 和 CACR 2025 为准，共 760 项，其中会议 396 项、期刊 364 项。评级同时显示各目录的原始级别。「投稿日历」「期刊与会议」和「我的截稿」可按成果类别筛选。该类别沿用桌面版复核结果，取 CCF、CACR 与 2025 年中科院 SCI 大类对应等级中的最高等级。候选期刊的 2025 年中科院 SCI 大类分区内置于公开目录，来源为项目所有者确认可公开发布的 ShowJCR 逐条复核表。访客打开页面即可按 1–4 区、1–2 区和无有效分区筛选。
- 公共地区字段来自目录中的国内刊号或可引用来源。缺少支持的条目显示「待确认」。主办方所属地区独立于会议举办地点。
- CCFDDL 提供 [JSON 截稿数据](https://ccfddl.com/conference/allconf.json)。网站每 15 分钟检查一次更新，失败时保留上一次成功的数据。会议官网的征稿公告是最终依据。期刊仅提供目录查询。
- 公共目录是 [catalog.json](public/catalog.json)。如需从本地 ShowJCR 复核表重新生成，运行 `python scripts/export_catalog.py <本地 TSV 路径>`。脚本导出目录、公开地区证据、匹配字段和候选期刊的 2025 年分区。当前版本的数据库与学院文件由桌面软件在本地管理。

## 本地运行

使用 Node.js 24 或更新版本。

```sh
npm ci
npm run db:local
npm run check
npm run dev
```

打开 `http://localhost:8787`。第一次查询会启动截稿同步，等待同步完成后页面会自动更新。也可以在本地向 `/cdn-cgi/handler/scheduled` 发起 Wrangler 的定时事件测试。若需验证完整登录流程，注册一个专用于本地测试的 GitHub OAuth 应用，回调为 `http://localhost:8787/api/auth/github/callback`，按 [.dev.vars.example](.dev.vars.example) 在未跟踪的 `.dev.vars` 中配置。

## 自部署

1. 安装依赖并运行 `npx wrangler login`，在浏览器中授权自己的 Cloudflare 账号。
2. 用 `npx wrangler d1 create showjcr-web` 新建 D1，或用 `npx wrangler d1 list` 找到已有同名数据库。把实际 UUID 填入 [wrangler.jsonc](wrangler.jsonc) 的 `d1_databases[0].database_id`，保留绑定名 `DB`。同一个数据库只需创建一次。
3. 运行 `npm run db:remote` 和 `npm run deploy`，记下 Worker 的公开 HTTPS 地址。定时任务随 Worker 部署。
4. 在自己的 [GitHub OAuth Apps](https://github.com/settings/developers) 注册应用。Homepage URL 填公开站点地址，Authorization callback URL 填同一地址加 `/api/auth/github/callback`。
5. 在终端逐条运行 `npx wrangler secret put GITHUB_CLIENT_ID`、`npx wrangler secret put GITHUB_CLIENT_SECRET` 和 `npx wrangler secret put PUBLIC_ORIGIN`。按提示输入值，`PUBLIC_ORIGIN` 填公开 HTTPS 地址，不含路径或结尾斜杠。
6. 验证匿名查询、首次截稿同步、真实 GitHub 登录、收藏和退出。打开两个会话验证收藏同步，使用另一账号验证收藏隔离。

GitHub 登录只获取用户 ID 和登录名。服务端在识别用户后丢弃 GitHub 令牌；收藏使用 GitHub 用户 ID 关联。D1 会话只保存会话令牌的哈希。在生产环境使用 HTTPS。

## 许可

本站源码按 [GPL-3.0](LICENSE) 发布。CCFDDL 数据与相关上游内容保留其 [MIT 许可声明](CCFDDL-LICENSE)。

- [ShowJCR 桌面项目](https://github.com/hitfyd/ShowJCR)
- [CCFDDL 项目](https://github.com/ccfddl/ccf-deadlines)
