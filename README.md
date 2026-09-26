<div align="center">

# Sanbei 的技术博客

<p>
  <strong>人机协同开发下的现代工程实践与系统思考</strong>
</p>

[![Website](https://img.shields.io/badge/在线博客-blog.sanbei101.cn-2563eb?style=flat-square&logo=google-chrome&logoColor=white)](https://blog.sanbei101.cn)
[![Go Version](https://img.shields.io/badge/Go-1.22+-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev)
[![Site Engine](https://img.shields.io/badge/Engine-Hugo_Extended-FF4088?style=flat-square&logo=hugo&logoColor=white)](https://gohugo.io)
[![Theme](https://img.shields.io/badge/Theme-OINK-6366f1?style=flat-square)](https://github.com/pgsty/oink)
[![License](https://img.shields.io/badge/License-MIT-10b981?style=flat-square)](LICENSE)

<br/>

> 很多关于 AI 编程的讨论往往停留在"哪个工具好用"或脱离工程现场的泛泛而谈。但当系统规模变大、业务充满并发与副作用时,真正决定上限的不是让模型自由发挥,而是工程师如何**铺平代码基座、明确接口契约并建立确定性的验证闭环**。
>
> 本博客记录一线后端与全栈开发中的真实经验--把语法样板交给人机协同,把精力聚焦在系统建模、工程约束与性能调优上。

---

## 博客核心思想

专栏围绕研发工作流的演进,系统阐述实习中积累的工程思想:

### 整洁与规范
**代码基座如同叠方块:前序代码越整洁,后续迭代可稳固承托的面积就越宽。**
- **标准库优先**:先穷尽语言内置能力,审慎甄选第三方依赖,杜绝隐式膨胀;
- **SQL 即源码**:用 `sqlc` 替代重量级运行时 ORM,直接编写原生 SQL 并由编译器静态推导类型,消除运行时的隐式黑盒;
- **软规范变硬门禁**:不依赖口头提醒与脆弱的人肉排查,用 Linter 静态分析器形成机器强制拦截。

### 工具与约束
**为模型注入真实的编译器语义,同时严格守住宝贵的上下文视界。**
- **工具赋能(gopls)**:拒绝盲目的正则文本搜索,借助语言服务器为模型接入真实的抽象语法树(AST)与跨包符号分析能力;
- **终端降噪(rtk)**:拦截并过滤测试、构建时倾泻的数千行冗余控制台输出,过滤 90% 以上的无用杂音,守护会话核心上下文。

### 迭代与测试
**真实工程不相信运气,用确凿的测试用例与实测数据驱动代码收敛。**
- **契约对齐**:通过 OpenAPI 与 Orval 实现一份契约、两端静态编译,彻底杜绝前后端字段不一致;
- **不猜性能瓶颈**:拒绝凭空猜测,基于 `pprof` 火焰图与基准测试,用具体的延迟与内存分配数据指导定向性能调优;
- **真实测试与排错证据链**:借助自动化测试与随机边界对拍拦截隐患,用规范的结构化日志保留完整的排错证据。

---

## 实践考量对照

| 维度 | 传统惯性实践 | 本博客践行的工程选择 | 核心收益 |
| :--- | :--- | :--- | :--- |
| **语言与表达** | 依赖动态反射与复杂注解魔法 | 显式强类型、平铺直叙的 Go 语言 | 语义透明,大幅降低机器推导时的理解歧义 |
| **持久层模式** | 庞大 ORM 运行时反射与动态拼装 | 静态编译生成(如 `sqlc` 原生 SQL) | 零隐式黑盒,编译期直接校验 SQL 与类型安全 |
| **上下文交互** | 通用正则盲搜,控制台日志全量倾倒 | 语言服务器(LSP)+ 终端降噪代理(`rtk`) | 注入精确符号感知,过滤 90% 以上冗余终端杂音 |
| **质量门禁** | 依赖口头习惯与人工逐行肉眼排查 | 静态门禁 + 边界对拍 + `pprof` 性能剖析 | 用客观数字与确定性断言驱动代码高质量收敛 |

---

## 关于本站

- **内容形态**:涵盖系统工程专栏、全栈落地实践、算法笔记与环境踩坑记录。
- **构建驱动**:采用 [Hugo](https://gohugo.io) Extended 配合 [OINK](https://github.com/pgsty/oink) 极客主题,全站支持暗色模式与快速离线搜索。
- **在线访问**:[blog.sanbei101.cn](https://blog.sanbei101.cn)
