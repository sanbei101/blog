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
