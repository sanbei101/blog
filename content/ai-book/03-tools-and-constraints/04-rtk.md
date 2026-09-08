---
title: rtk, 守住 Agent 的智商高地
description: 砍掉 90% 终端噪音,让 AI 留在黄金上下文
weight: 50
---

当我们让 Agent 接管一个典型的 Go 后端微服务重构任务:

> *"检查 `internal/payment` 模块中所有的退款与流水状态机单测,修复由于通道竞争导致的超时报错,确保所有测试通过并准备提交。"*

敲下回车后,终端口吐白沫般地滚动起来:
- Agent 首先执行了 `go test -v ./...`,几十个通过用例的 `=== RUN` 和 `--- PASS` 铺满了屏幕,夹杂着服务启动日志、包路径与耗时统计;
- 为了确认代码目录和包引用,它连续执行了 `ls -la internal/payment` 和全局 `grep`;
- 测完之后敲下 `golangci-lint run`,输出又夹杂了大量的环境扫描与进度提示;
- 准备提交时,连环执行 `git status`、`git diff`、`git push`,输出中充斥着冗长的未暂存文件清单与对象打包进度……

几轮交互下来,Bug 还没完全定位,会话的上下文窗口就已经被推高到了数十万甚至百万 Token。

紧接着,诡异的现象发生了:**原本思维严密的 Agent 突然变得“迟钝”甚至“智障”了**——它开始漏掉之前明确约定过的边界条件,修改函数时少传了上下文 `ctx`,甚至陷入了在终端里反复运行相同失败命令的死循环。

很多开发者以为这是底层大模型的不稳定,但翻看完整的 Prompt 历史就会发现残酷的真相:

**在 Agent 的交互生命周期中,工具调用是上下文中体积最庞大、膨胀最凶猛的元凶。**

动辄成千上万行未经提炼的原始终端输出,瞬间把宝贵的上下文窗口塞满。当会话被海量噪音挤出**“黄金上下文”**区段后,大模型的注意力被极度稀释,推理能力发生断崖式下跌。

[`rtk` (Rust Token Killer)](https://github.com/rtk-ai/rtk),就是专为斩断这根毒瘤而生的高性能 CLI 代理——**它拦截并压缩那些输出冗余的 Shell 命令,在进入模型视线之前剔除高达 90% 的终端噪音,让 Agent 始终留在推理能力最充沛的智商高点。**

---

## 核心机理:把终端噪音扼杀在输入之前

大模型的推理智商和它眼前的上下文信噪比直接挂钩。

当一条 `go test` 命令喷出数千行文本时,真正对修复有价值的信息可能只有**挂掉的函数名**与**断言失败的代码行**。其余的几百个 `PASS`、依赖下载日志、CPU 耗时,全都是稀释注意力的废话。


```

[ 传统 Bash 调用 ] ---> 原始命令原始输出 ---> 数千 Token 噪音吞没 ---> 逃离黄金上下文, 智商断崖下跌
[ rtk 智能代理    ] ---> 过滤/聚合/截断/去重 ---> 毫秒级提取有效信息 ---> 维持高信噪比, 守住智商高点

```

`rtk` 是一个体积轻盈的单二进制 CLI 工具,内部执行耗时小于 10ms。针对 Go 开发的常见命令,它通过 NDJSON 解析、错误聚合与状态去重,精准执行四道工序:

1. **智能过滤 (Smart Filtering)**:剔除所有的无用构建进度、成功日志与格式空行;
2. **错误聚焦 (Focus on Failures)**:折叠成百上千个通过的测试,只保留抛出错误的堆栈与断言;
3. **结构聚合 (Grouping)**:把跨包散落的编译或 Lint 报错按规则和文件归拢;
4. **轻量快照 (Tee Recovery)**:把未压缩的完整日志异步落盘,保留兜底追踪能力。

以下结合真实的 Go 项目开发场景,看看它是如何帮 Agent 守住上下文的。

---

## 场景一:单元测试与竞态检测 (`go test`)

在 Go 项目中排查并发 Bug,最标准的操作就是开启竞态检测跑测试。

在我们的支付核心包 `internal/payment` 中,包含 30 多个单测用例。其中 `TestRefund_ChannelTimeout` 因为 channel 没有正常关闭,偶发性触发了死锁崩溃:

```go
// internal/payment/refund_test.go
package payment

import (
	"context"
	"testing"
	"time"
)

func TestRefund_ChannelTimeout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	svc := NewRefundService()
	_, err := svc.ProcessRefund(ctx, "ord_1001", 500)
	if err != nil {
		t.Fatalf("expected refund success, got err: %v", err)
	}
}

```

### ❌ 没有 rtk

Agent 在终端执行:

```bash
go test -v -race ./internal/payment/...
```

终端立刻像瀑布一样刷屏:

* 30 个通过用例逐行打印 `=== RUN   TestCreatePayment`、`--- PASS: TestCreatePayment (0.01s)`、`=== RUN   TestVerifySignature`……整整占据数百行;
* `go test` 附带的基础构建、包编译、内存同步信息混合其中;

```text
=== RUN   TestCreatePayment
--- PASS: TestCreatePayment (0.00s)
=== RUN   TestQueryBalance
--- PASS: TestQueryBalance (0.02s)
=== RUN   TestPaymentCallback_Success
--- PASS: TestPaymentCallback_Success (0.01s)
... (此处省略 300+ 行正常的测试日志) ...
=== RUN   TestRefund_ChannelTimeout
    refund_test.go:17: expected refund success, got err: context deadline exceeded
--- FAIL: TestRefund_ChannelTimeout (0.01s)
=== RUN   TestRefund_InvalidAmount
--- PASS: TestRefund_InvalidAmount (0.00s)
FAIL
coverage: 82.4% of statements
FAIL    myproject/internal/payment  0.182s
FAIL

```

* **Token 消耗**: 这一次命令调用吞掉了 **3,200+ Tokens**。
* **智商衰退后果**: 如果 Agent 连续调试、修复并重跑了三次单测,仅仅终端输出就累积了近 **10,000 Tokens** 的纯废话。大模型的注意力被分散在海量的无害日志中,很容易误判上下文,改动代码时甚至会产生幻觉,把其他通过的单测接口也“顺手改崩”。

### ✅ 装上 rtk 的优雅流程

通过 `rtk go test` 代理调用:

```bash
$ rtk go test -v -race ./internal/payment/...
FAILED: 1/32 tests (1 package failed)
myproject/internal/payment:
  FAIL: TestRefund_ChannelTimeout
  refund_test.go:17: expected refund success, got err: context deadline exceeded
[full output: ~/.local/share/rtk/tee/1707753600_go_test.log]
```

* **Token 消耗**: 从 **3,200+ Tokens** 锐减到轻巧的 **不到 90 Tokens**,压缩率超过 **97%**!
* **效果**: 31 个通过的测试被折叠为统计数值,输出只留下唯一的失败断言、文件名与第 17 行报错。
---

## 场景二:项目代码嗅探与接口契约查看

当 Agent 需要调用下游仓储层 `internal/repository` 的数据接口时,由于不熟悉包结构,它往往先探索目录,再阅读相关源码。

```go
// internal/repository/user_account.go (长达 500 行的实现文件)
package repository

import (
	"context"
	"database/sql"
	"sync"
	"time"
)

type AccountRepo struct {
	db *sql.DB
	mu sync.RWMutex
}

// ... 此处包含 400 行复杂的连接池保活、SQL 事务包装、指标打点等底层内部私有逻辑 ...

func (r *AccountRepo) GetBalance(ctx context.Context, uid int64) (int64, error) {
	// ...
	return 1000, nil
}

func (r *AccountRepo) DeductBalance(ctx context.Context, uid int64, amount int64) error {
	// ...
	return nil
}

```

### ❌ 没有 rtk 的灾难现场

1. **文件目录噪音**: Agent 执行 `ls -la internal/repository`,终端输出了权限、用户组、文件大小和修改日期,这些无用元数据在每个文件中重复出现。
2. **源码长篇灌入**: Agent 执行 `cat internal/repository/user_account.go`,整整 500 行复杂的事务控制与底层 SQL 拼装全量倒进了上下文。
3. **注意力被带偏**: 外部业务调用其实只关心 `GetBalance` 与 `DeductBalance` 的函数签名,但这 500 行实现代码彻底污染了上下文。在后续写业务逻辑时,Agent 甚至开始过度设计,试图直接调用未导出的私有成员。

### ✅ 装上 rtk 的优雅流程

Agent 通过 `rtk` 体系进行探索:

```bash
$ rtk ls internal/repository
internal/repository/
+-- order_repo.go (380 lines)
+-- transaction.go (190 lines)
+-- user_account.go (520 lines)
```

目录结构一目了然,紧凑清爽。接着使用 `rtk read` 嗅探 Go 源码:

```bash
$ rtk read internal/repository/user_account.go -l aggressive
```

`rtk` 自动剥离函数体内部实现,仅保留导出的类型与方法声明骨架:

```go
package repository

type AccountRepo struct { ... }

func (r *AccountRepo) GetBalance(ctx context.Context, uid int64) (int64, error)
func (r *AccountRepo) DeductBalance(ctx context.Context, uid int64, amount int64) error
```

* **Token 消耗**: 从阅读全文件的 **4,800+ Tokens** 压缩到 **不到 120 Tokens**。
* **效果**: Agent 干净利落地拿到了外部调用契约,注意力完全聚焦在接口本身,杜绝了被底层私有代码干扰的风险。

---

## 场景三:代码修改后的 Git 巡检

修改完 Go 代码后,Agent 会在终端频繁执行 Git 命令确认修改面并准备提交。

```bash
git status
git push origin feature/pay-fix
```

### ❌ 没有 rtk 的灾难现场

Agent 执行 `git push origin feature/pay-fix`:

```text
Enumerating objects: 12, done.
Counting objects: 100% (12/12), done.
Delta compression using up to 10 threads
Compressing objects: 100% (6/6), done.
Writing objects: 100% (6/6), 842 bytes | 842.00 KiB/s, done.
Total 6 (delta 4), reused 0 (delta 0), pack-reused 0
To github.com:myteam/payservice.git
   b2f14aa..c99e120  feature/pay-fix -> feature/pay-fix
```

紧接着敲个 `git status`,又是十几行的修改提示、暂存指引与分支状态建议。

这几百行毫无意义的进度条和指引语句,不仅无法提供任何代码层面的辅助,还每时每刻都在侵蚀模型的上下文配额。

### ✅ 装上 rtk 的优雅流程

经过 `rtk` 拦截后:

```bash
$ rtk git push origin feature/pay-fix
ok feature/pay-fix

$ rtk git status
M internal/payment/refund.go
M internal/payment/refund_test.go
```

原先几十行、上百 Token 的控制台排版废话,直接被凝练为原子级的状态反馈。Agent 能够以极快速度确认状态,将上下文资源全部省下来处理接下来的逻辑。

---

## 全局无感注入:Auto-Rewrite Hook

如果需要我们在提示词里反复要求 Agent “在所有命令前加上 rtk”,大模型很容易在对话变长后遗忘这条规则。

`rtk` 最强大的特性在于其**透明拦截机制**。通过预设的钩子,直接在命令执行前自动将其替换为 `rtk` 包装版本:

```bash
# 全局无感注入
rtk init -g                    # 适用于 Claude Code / Copilot
rtk init -g --opencode         # 适用于 OpenCode
```

### 底层拦截流程

在 Agent 发起 Bash 工具调用时,Hook 会在底层静默将命令无缝改写:

```
Agent 发起调用:  go test -v ./...    ----->   Hook 静默改写:   rtk go test -v ./...
Agent 发起调用:  git status          ----->   Hook 静默改写:   rtk git status
Agent 发起调用:  golangci-lint run   ----->   Hook 静默改写:   rtk golangci-lint run
```

* **Agent 零感知**: Agent 依旧按照标准 Go 习惯书写命令,完全不需要学习新的语法;
* **Prompt Cache 友好**: `rtk` 仅在命令执行完毕向模型回传结果前完成单次压缩。返回给大模型的纯净文本同样遵循标准缓存机制,且由于输出体积锐减,写入与命中 Cache 的成本同步大幅下降。

随时在终端运行统计命令,即可直观查看它为你守住了多少上下文:

```bash
rtk gain -p
```

终端会输出一份清晰的统计看板:命令调用次数、原始字节大小、压缩字节大小、为你守住的 Token 估算量。

---

## 留住“黄金上下文”,就是留住 Agent 的智商

在复杂代码工程中,**省钱只是副产物,守护 Agent 的推理智商才是核心目的。**

大语言模型不是无限容量的存储器。随着上下文中工具调用产生的大量无序日志不断累积:

* **注意力机制被严重稀释**: 模型在长文本中定位关键变量的能力急速下滑;
* **推理噪音急剧放大**: 测试通过日志、进度输出等干扰项增加了生成幻觉的概率;

**把占用上下文最多的工具调用噪音挤干,Agent 才能永远驻留在清爽、敏锐的“黄金上下文”中,持续维持住它的最高智商。**
