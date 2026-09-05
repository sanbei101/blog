---
title: golangci-lint, 给 Agent 套上缰绳
description: AI 的小动作当场抓获
weight: 30
---

当我们让 Agent 接管一个日常的后端业务需求:

> *"在结算模块新增一个同步第三方支付凭证的 HTTP 接口,解析回调参数并更新订单流水。"*

写完代码之后,`AGENT` 执行了 `go build ./...` ,Agent 信心满满地向你汇报:

> *"我已完成支付凭证同步接口的编写,编译完全通过,所有测试用例均已就绪。"*

如果是在过去,你可能就直接 `git commit` 并入主分支了。但只要拉开这次修改的 Diff,你很有可能会倒吸一口凉气:

- `resp, _ := client.Do(req)`,HTTP 响应体的 `Body` 根本没有 `Close()`,服务跑上两小时就会因为文件描述符耗尽而静默宕机;
- 接收到未定义类型的 `any` 时,直接来了一句 `token := claims["token"].(string)`,遇到空指针或类型不匹配立刻在运行时引发 Panic;
- 错误比较依然使用 `err == io.EOF`,在多层包装的 Go 1.13+ 体系下直接让逻辑短路;
- 大量的 `fmt.Sprintf("%d", orderID)` 和 `fmt.Sprintf("%s", key)` 充斥其中,垃圾回收(GC)压力成倍增加;
- 还有挤在一团、未按规范分组的 Import 依赖,以及单行长达 160 个字符的超长函数签名。

**在没有静态分析工具约束时,AI 就像一匹脱缰野马。** `go build` 只能保证语法没有致命语法错误,却对代码异味、资源泄露和现代代码规范视而不见。

---

## 核心机理:软性约束与硬性防线

当我们试图在 `AGENTS.md` 写规则:

```markdown
<!-- Prompt 叮嘱 -->
- 请务必注意关闭 HTTP Response Body!
- 不要忽略任何一个 error!
- 类型断言一定要判断 comma-ok!
- 严格遵循 Go 代码规范,注意性能!
```

当上下文窗口膨胀到数万 Token 时,注意力机制的上下文稀释必然发生。大模型往往"按下葫芦起了瓢",记住了关闭 Body,又忘了校验类型断言。

`golangci-lint` 的价值在于建立确定性的物理隔离:

```
[ 传统 Prompt 叮嘱 ] ---> 上下文稀释 ---> 概率性遵守、隐蔽 Bug 随缘漏网
[ golangci-lint 约束 ] ---> AST/SSA 深度静态分析 ---> 编译期硬性拦截、0 容忍反馈闭环

```

以下结合我们实际的 `.golangci.yaml` 配置,举几个栗子看看它是如何将 AI 的各种"暗坑"扼杀在提交之前的。

---

## 不要忽略错误!
前面说错误显示处理是`go`诊断bug的优势,但耐不住有些 人/AI 压根不处理错误,满屏幕的`_ = xx`导致在真正发生错误的时候,日志里面压根没有任何反馈,既然如此,写个 `Rule` 让这种垃圾代码被彻底暴露消灭!

```yaml
linters:
  enable:
    - bodyclose
    - errcheck
    - errorlint
  settings:
    errcheck:
      check-type-assertions: true
      check-blank: true
```

Agent 编写了一段调用外部支付网关校验凭证的代码:

```go
// internal/payment/verifier.go
package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type GatewayVerifier struct {
	client *http.Client
}

func (g *GatewayVerifier) Verify(ctx context.Context, rawPayload any) (*VerifyResult, error) {
	// ❌ 风险 1: 裸类型断言,容易引发 Panic
	payloadMap := rawPayload.(map[string]any)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "[https://pay.example.com/verify](https://pay.example.com/verify)", nil)
	if err != nil {
		return nil, fmt.Errorf("build request failed: %w", err)
	}

	resp, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	// ❌ 风险 2: 未调用 resp.Body.Close(),连接无法复用且引发 FD 泄露

	var res VerifyResult
	// ❌ 风险 3: 忽略返回值中的 error
	_ = json.NewDecoder(resp.Body).Decode(&res)

	return &res, nil
}

```

### ❌ 没有装上 golangci-lint 的灾难现场

1. `go build` 和 `go vet` 均不报错,Agent 自信宣布任务完成。
2. 单元测试在 Mock 场景下顺利通过,代码合入主干。
3. 上线后遇到非法输入,第 16 行直接引发生产环境进程 Crash。
4. 即使输入合法,高并发下由于连接未释放,数分钟后服务报 `socket: too many open files`。

### ✅ 装上 golangci-lint 的优雅流程

Agent 运行 `golangci-lint run`,工具捕获这三处缺陷:

```text
internal/payment/verifier.go:16:16: unchecked-type-assertion: unchecked type assertion: rawPayload.(map[string]any) (errcheck)
internal/payment/verifier.go:23:2: response body must be closed (bodyclose)
internal/payment/verifier.go:30:2: Error return value is not checked (errcheck)
```

看到这些带有明确行号与规则名称的终端报错,Agent 不需要人教,直接在下一次迭代中修改为防御性代码:

```go
func (g *GatewayVerifier) Verify(ctx context.Context, rawPayload any) (*VerifyResult, error) {
	payloadMap, ok := rawPayload.(map[string]any)
	if !ok {
		return nil, errors.New("invalid payload structure")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "[https://pay.example.com/verify](https://pay.example.com/verify)", nil)
	if err != nil {
		return nil, fmt.Errorf("build request failed: %w", err)
	}

	resp, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() // bodyclose 验证通过

	var res VerifyResult
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil { // errcheck 验证通过
		return nil, fmt.Errorf("decode verify response failed: %w", err)
	}

	return &res, nil
}

```

---

## 性能劣化与过时语法消除

大模型从海量开源代码中学习,往往容易"继承"很多十年前的过时语法或随手的性能劣质写法。我们在配置中启用了以下规则:

```yaml
linters:
  enable:
    - perfsprint
    - modernize
    - usestdlibvars
```

看一段典型的代码:

```go
// internal/notify/dispatcher.go
package notify

import (
	"fmt"
	"net/http"
	"strings"
)

func BuildWebhookURL(host string, tenantID int64, eventType string) string {
	// ❌ 性能恶化: 低效的 fmt.Sprintf
	idStr := fmt.Sprintf("%d", tenantID)
	
	// ❌ 魔法字符串: 未使用标准库常量
	method := "GET"
	_ = method

	parts := []string{host, "api", "v1", idStr, eventType}
	return strings.Join(parts, "/")
}
```

### ❌ 没有装上 golangci-lint 的灾难现场

代码能正常跑通,但充满低效实现:

* `fmt.Sprintf("%d", tenantID)` 会触发反射解析,在堆上逃逸并产生不必要的内存分配;
* 使用裸字符串 `"GET"` 而不是 `http.MethodGet`,容易手滑拼错且缺乏规范约束。

### ✅ 装上 golangci-lint 的优雅流程

执行扫描后,Linter 给出清晰建议:

```text
internal/notify/dispatcher.go:12:11: fmt.Sprintf can be replaced with faster strconv.FormatInt (perfsprint)
internal/notify/dispatcher.go:15:12: "GET" can be replaced by `http.MethodGet` (usestdlibvars)
```

Agent 根据提示秒级重构:

```go
package notify

import (
	"net/http"
	"strconv"
	"strings"
)

func BuildWebhookURL(host string, tenantID int64, eventType string) string {
	idStr := strconv.FormatInt(tenantID, 10) // 零反射,极低分配
	method := http.MethodGet                 // 标准库规范
	_ = method

	parts := []string{host, "api", "v1", idStr, eventType}
	return strings.Join(parts, "/")
}

```

## Agent Prompt 调优

```Markdown
### 代码质量与提交门禁
1. **强制执行静态检查**: 任何 Go 代码修改或新增完成后,必须在终端执行 `golangci-lint run`。
2. **零容忍报错**: 终端输出的任何 Lint 警告或错误均等同于编译失败,严禁提交存在 Lint 报错的代码。
3. **禁止掩耳盗铃**: 严禁在未经用户允许的情况下添加 `//nolint` 注释跳过检查。
```
---

当 Agent 拥有了这套反馈回路:

1. Agent 编写代码;
2. 触发 `make lint`;
3. 检查器指出具体问题(第几行、什么规则、为什么错);
4. Agent 基于结构化诊断直接修复;

不需要额外的人工催促,也不依赖飘忽不定的大模型记忆力。**工具是最好的缰绳,它让 AI 在自由奔跑的同时,永远不会踩出工程规范的边界。**
