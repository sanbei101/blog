# Sanbei的博客

基于 [OINK](https://oink.pgsty.com/) + Hugo 的个人博客,仅简体中文。

## 栏目

```text
content/blog/
├── algorithm/    算法:刷leetcode的算法总结
├── china-wall/   长城突破:网络受限环境下的解决办法
└── mix/          杂七杂八:暂时没有分类的文章
```

首页文案在 `data/home.yaml`,站点配置(标题、域名、评论、统计)在 `hugo.yaml`。

## 写作

新建 `content/blog/<栏目>/<文章名>.md`:

```markdown
---
title: 文章标题
description: 一句话摘要
date: 2026-09-01
---

正文……
```

## 本地预览

```bash
hugo server
```

首次运行会下载 OINK Hugo Module,需要 Git、Go 1.27+ 和 Hugo Extended 0.165+。

## 发布

正式构建:

```bash
hugo --cleanDestinationDir --gc --minify --environment production \
  --printPathWarnings --panicOnWarning
```

部署走 `.github/workflows/` 下的 GitHub Pages 或 Cloudflare Pages 工作流。注意先把 `hugo.yaml` 里的 `baseURL` 改成正式地址。
