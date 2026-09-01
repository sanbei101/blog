---
title: AI 使用经验
description: 记录 Golang 开发(顺便带有一点前端)的AI使用心得
type: book
book_kind: book
sidebar_root_for: self
sidebar_root_link_self: true
outputs: [HTML, markdown]
icon: fa-solid fa-robot
weight: 20
menus:
  main:
    identifier: ai-book
    weight: 20
    params:
      icon: fa-solid fa-robot
cascade:
  type: book
  footer_style: slim
  sidebar_headings: 3
---

# 总章

目前的 AI Coding 时代,靠人力**古法编程**的需求是越来越少了,本人从2025年开始进入 Golang 开发的实习岗位,25下半年的时候我遇到的公司的开发流程基本上是 人工写 20-30% 的代码: 例如`interface.go`,`schema.sql`等关键地方的决策依靠人工完成, 剩下的`service`,`repository`层就依赖`AI`搭配`GORM`等`ORM`框架快速编写增删改查的逻辑,然后`review`这个流程基本上还依靠我的`mentor`进行`古法校对`,当时的`BOSS直聘`上面的岗位描述还是`后端开发`,`服务端开发`等

但是到了 2026 年,这一切似乎都不一样了,`AI`的智商似乎呈现指数型爆炸增长,从刚开年的`Deepseek R1`到后续越来越强的`Claude Opus 4.5, 4.7, 4.8, 5.0`,他们的进化速度远超想象, 随手就能完成以前 资深前端 挠破脑袋才能写出来的炫酷界面, 随便写出千行逻辑完整,风格规范的服务端代码, `Boss直聘`上面的岗位描述也变成了`AI 软件开发`, `AI Agent`开发, 笔试开始出现`vibe codeing`的环节, 我经历的面试 全部问到了 "你平时使用什么ai工具`, "能介绍一下你平时的ai工作流程?" 这类问题

> 大部分岗位的描述字里行间都是一句话: "用AI快速的完成你的工作"

> 至此, 编程开始转化为小说中的**御兽流派**, 开局一个`Agent`, 剩下全靠吞(bushi)

## 楔子

本人突发奇想, 面试官这么喜欢问我平时的`AI 工作流`, 但是纯口述却总是无法很好的表达我的经验, 那么是不是可以写一本书来说明这一切, 捋一遍我自己的知识库的同时, 还能直接把链接分享给面试官来说明我的ai经验

当前有许多的博客也分享他们的ai经验,但私以为他们的分享大多不够具体,可能就是介绍一下哪个 `skills/mcp` 好用,或者缺乏真实的运用案例,所以本书希望不说宏观的话,能把 ai的运用在 代码项目/片段 中进行说明,尽可能让你身临其境,就像在看番茄小说

由于本人的技术栈为 `golang`+ 任意前端框架(我觉得都大差不差), 所以本文的案例都将以`golang` + `typescript` 为主, 可能涉及到一些语言特有的特性和最佳实践,技术栈为`python`,`java`等的读者可以取其精华去其糟粕
