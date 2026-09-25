---
title: "rtk:过滤噪音,守住推理窗口"
description: 过滤 90% 命令行输出噪音,维持模型有效推理窗口
weight: 20
---

在工程实践中,当给 Agent 分配一个典型的后端重构任务时:

> *"检查 `internal/payment` 模块中所有的退款与流水状态机单测,修复由于通道竞争导致的超时报错,确保所有测试通过并准备提交。"*

在缺乏输出过滤时,终端会迅速倾泻大量低信息密度的文本:
- Agent 首先执行 `go test -v ./...`,数十个通过测试的 `=== RUN` 和 `--- PASS` 铺满输出,夹杂着构建日志、包路径与耗时统计;
- 为确认代码目录与依赖,连续执行 `ls -la internal/payment` 与全局 `grep`;
- 随后执行 `golangci-lint run`,输出混杂着模块扫描日志与环境信息;
- 准备提交时,连续执行 `git status`、`git diff`、`git push`,输出中充斥着冗长的未暂存文件清单与对象打包进度。

仅经过数轮交互,具体问题尚未定位,会话的上下文窗口就已经被推高至数十万 Token。随之而来的便是注意力机制被大量冗余字符稀释:遗漏先前约定的边界约束、修改函数时丢弃关键参数,甚至陷入重复执行相同失败命令的死循环。

> [!TIP] 终端输出降噪与注意力保真
> 在长周期研发中,工具调用产生的原始控制台输出是上下文消耗的主要来源。[`rtk` (Rust Token Killer)](https://github.com/rtk-ai/rtk) 作为轻量级命令行代理层,在标准输出进入模型前过滤 90% 以上的冗余文本,保留核心诊断与退出状态,维持上下文的高信噪比。

---

## 核心机理:提升上下文信噪比

在 `go test` 输出的数千行日志中,对于定位问题真正关键的信息只有:失败的用例名、断言内容与错误行号。通过的用例信息、包编译日志与微秒级耗时对修复缺陷均属干扰。

```text
传统命令行调用 ──(全量原始输出)──→ 数千 Token 冗余文本 ──→ 注意力稀释与推理衰退
rtk 代理层     ──(过滤/聚合/截断)─→ 提取核心错误与诊断 ──→ 维持高信噪比有效窗口
```

`rtk` 使用 Rust 编写,单次代理执行开销小于 10ms:

1. **输出过滤**:剔除构建进度、成功日志与无意义空行;
2. **错误聚焦**:折叠全部通过的测试用例,仅提取失败用例的堆栈与断言信息;
3. **结构聚合**:将散落的编译或 Lint 报错按规则与文件进行结构化归拢;
4. **快照转储**:将未压缩的完整日志异步写入本地磁盘(`tee` 机制),保留底层排查能力。

---

## 场景一:单元测试与竞态检测 (`go test`)

在并发场景下排查死锁或竞争时,通常需要开启竞态检测(`-race`)执行测试。

假设在支付核心包 `internal/payment` 中包含 32 个测试用例,其中 `TestRefund_ChannelTimeout` 因通道未正常关闭触发了超时失败:

```go title="internal/payment/refund_test.go"
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

对比原始命令输出与 `rtk` 代理输出:

```text {tab="原始命令全量输出 (3,200+ Tokens)" group="go_test" value="raw"}
=== RUN   TestCreatePayment
--- PASS: TestCreatePayment (0.00s)
=== RUN   TestQueryBalance
--- PASS: TestQueryBalance (0.02s)
=== RUN   TestPaymentCallback_Success
--- PASS: TestPaymentCallback_Success (0.01s)
... (此处省略 300+ 行正常的测试用例输出) ...
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
```text {tab="rtk 代理过滤输出 (约 90 Tokens)" value="rtk"}
FAILED: 1/32 tests (1 package failed)
myproject/internal/payment:
  FAIL: TestRefund_ChannelTimeout
  refund_test.go:17: expected refund success, got err: context deadline exceeded
[full output: ~/.local/share/rtk/tee/1707753600_go_test.log]
```

- **Token 消耗**:从 **3,200+ Tokens** 降至 **约 90 Tokens**,压缩率达到 **97.2%**;
- **排错效率**:31 个通过的用例被收敛为统计计数,输出仅保留第 17 行的失败断言,消除注意力干扰。

---

## 场景二:目录结构探索与接口契约查看

当 Agent 调用仓储层 `internal/repository` 的数据接口时,通常需要先检查目录再查看源码契约:

```go
// internal/repository/user_account.go (长约 500 行的实现文件)
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

// ... 此处包含 400 余行连接池保活、事务封装与指标打点逻辑 ...

func (r *AccountRepo) GetBalance(ctx context.Context, uid int64) (int64, error) {
	// ...
	return 1000, nil
}

func (r *AccountRepo) DeductBalance(ctx context.Context, uid int64, amount int64) error {
	// ...
	return nil
}
```

### 骨架提取与按需输出

当 Agent 调用仓储层 `internal/repository` 的数据接口时,传统方式往往通过 `cat` 全量倾泻 500 行源码。使用 `rtk` 进行目录与接口探索:

```bash title="目录树压缩与骨架提取"
$ rtk ls internal/repository
internal/repository/
+-- order_repo.go (380 lines)
+-- transaction.go (190 lines)
+-- user_account.go (520 lines)

$ rtk read internal/repository/user_account.go -l aggressive
```

工具自动剥离函数体内部细节,仅提取导出的结构体与方法签名契约:

```go title="导出的公开契约声明"
package repository

type AccountRepo struct { ... }

func (r *AccountRepo) GetBalance(ctx context.Context, uid int64) (int64, error)
func (r *AccountRepo) DeductBalance(ctx context.Context, uid int64, amount int64) error
```

- **Token 消耗**:从完整源码的 **4,800+ Tokens** 降低至 **约 120 Tokens**(降幅 97.5%);
- **认知聚焦**:精确获取对外调用契约,避免了底层私有代码对模型生成业务逻辑时的注意力干扰。

---

## 场景三:版本控制交互 (`git`)

在代码修改后,Agent 会在终端执行 Git 命令确认变动并执行推送:

```bash
git status
git push origin feature/pay-fix
```

对比原始控制台输出与 `rtk` 原子状态反馈:

```text {tab="原始 Git 进度与提示 (冗余文本)" group="git_status" value="raw"}
Enumerating objects: 12, done.
Counting objects: 100% (12/12), done.
Delta compression using up to 10 threads
Compressing objects: 100% (6/6), done.
Writing objects: 100% (6/6), 842 bytes | 842.00 KiB/s, done.
Total 6 (delta 4), reused 0 (delta 0), pack-reused 0
To github.com:myteam/payservice.git
   b2f14aa..c99e120  feature/pay-fix -> feature/pay-fix
```
```text {tab="rtk 代理输出 (原子状态)" value="rtk"}
$ rtk git push origin feature/pay-fix
ok feature/pay-fix

$ rtk git status
M internal/payment/refund.go
M internal/payment/refund_test.go
```

终端排版字符被精简为状态原子反馈,使 Agent 能够以极低开销确认仓库状态。

---

## 透明代理机制:Auto-Rewrite Hook

如果依赖 Prompt 叮嘱模型在所有命令前手动添加 `rtk` 前缀,在长会话中极易遗漏。

`rtk` 提供了透明拦截机制,可在工具执行前自动改写调用命令:

```bash title="Hook 全局初始化"
rtk init -g                    # 适用于 Claude Code / Cursor
rtk init -g --opencode         # 适用于 OpenCode
```

底层拦截改写链路:

```text
Agent 发起调用: go test -v ./...    ──→  Hook 自动改写: rtk go test -v ./...
Agent 发起调用: git status          ──→  Hook 自动改写: rtk git status
Agent 发起调用: golangci-lint run   ──→  Hook 自动改写: rtk golangci-lint run
```

- **零心智兼容**:模型继续沿用标准命令习惯,无需更改调用参数;
- **Prompt Cache 友好**:结构化与确定性的紧凑文本显著提升 Prompt 缓存命中率,降低 API 调用延迟与成本。

执行指标统计命令,可查看会话累积压缩收益:

```bash title="终端收益审计"
$ rtk gain -p
TOTAL SAVED: 142,800 tokens (91.4% reduction across 48 commands)
```

---

## 终端上下文治理工作流

1. **环境初始化**:执行 `rtk init -g` 挂载全局透明改写 Hook。
2. **命令调用自动降噪**:Agent 正常调用 `go test`、`git`、`ls`,底层自动进行输出截断与聚合。
3. **保留底层追溯**:若排查疑难缺陷需要完整日志,直接读取 `tee` 写入本地磁盘的 `.log` 快照文件。
4. **长会话注意力保真**:持续维持会话在 90%+ 的高信噪比区间,保障多轮重构推理的确定性。
{.steps}
