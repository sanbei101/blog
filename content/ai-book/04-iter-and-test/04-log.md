---
title: 结构化日志与可观测性闭环
description: 基于结构化事件与上下文追踪构建生产排错证据链
weight: 40
---

在工程演进中,系统上线后通常面临如下场景:

> *"生产环境接口在夜间偶发 500 错误,随后自动恢复,需要定位根本原因。"*

若服务在标准输出中仅打印非结构化文本:

```text
something went wrong
```

排查将缺乏必要的事实支撑:无法定位具体接口、用户 ID、数据载荷或下游依赖状态,亦无法量化故障的影响范围与发生频次。系统并非没有缺陷,而是缺陷发生时未保留现场证据。

> [!TIP] 结构化日志与生产排错证据链
> 在真实分布式系统中,缺陷发生时若无现场证据,任何排查都沦为推测。将每条日志视为具备结构化字段(`request_id`、`operation`、`duration_ms`)的离散事件,由顶层统一记录单次错误,杜绝多层重复打印。

可观测性体系通常涵盖三类核心信号:

- **Logs**:记录特定业务事件发生的具体上下文与异常现场;
- **Metrics**:统计同类事件的发生频次、速率与聚合趋势;
- **Traces**:串联单次请求跨服务与跨函数的完整调用链路。

工程中统一的标准采集链路:

```text
Go 服务进程 ──(stdout 结构化 JSON)──→ 日志采集 Agent (Grafana Alloy) ──→ Loki ──→ Grafana
```

这套链路能够支撑服务从本地调试平滑过渡至生产排错,使模型与开发人员能够依据真实的错误上下文进行根因分析与代码重构,消除对模糊报错的推测。

---

## 结构化事件与非结构化文本

对比早期非结构化输出与生产级结构化事件:

```go {tab="传统非结构化输出 (无法检索与聚合)" group="log_format" value="fmt"}
if err := service.Publish(ctx, userID, postID); err != nil {
    fmt.Println("publish failed", err)
    http.Error(w, "internal error", http.StatusInternalServerError)
    return
}
```
```json {tab="生产级结构化事件 (字段化与链路分析)" value="json"}
{
  "time": "2026-09-08T14:20:31.120+08:00",
  "level": "error",
  "service": "api",
  "env": "production",
  "operation": "post.publish",
  "request_id": "5c6a9d7f8b1e4c20",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "user_id": 1001,
  "post_id": 9001,
  "dependency": "postgres",
  "duration_ms": 82,
  "error_type": "unique_violation",
  "error": "insert post: duplicate key value violates unique constraint",
  "msg": "publish post failed"
}
```

通过结构化 JSON,人类可直观阅读 `msg` 与 `error`,监控系统可针对 `service`、`operation`、`level` 与 `error_type` 进行过滤和聚合告警,模型亦可依据 `request_id` 自动串联请求全生命周期的上下文。

工程记录维度与标准字段规范:

| 维度 | 建议字段 | 作用说明 |
| :--- | :--- | :--- |
| 故障服务 | `service`、`env`、`version`、`host` | 确认系统拓扑与发布版本 |
| 关联请求 | `request_id`、`trace_id`、`method`、`route` | 串联分布式上下文 |
| 业务动作 | `operation`、`user_id`、`resource_id` | 锁定受影响的具体实体 |
| 外部依赖 | `dependency`、`sql_operation`、`upstream_status` | 识别数据库、缓存或下游服务瓶颈 |
| 异常属性 | `error_type`、`error`、`retryable` | 确定错误类别与重试策略 |
| 影响评估 | `status`、`duration_ms`、`attempt` | 量化请求耗时与重试轮次 |

---

## 异常路径的上下文完整性

日志的核心价值主要体现在异常分支上。成功日志仅需标识流程正常终结;失败日志则需明确记录失败阶段、核心入参及依赖调用的反馈:

```go title="internal/service/publish.go"
log.Error().
    Err(err).
    Str("service", "api").
    Str("operation", "post.publish").
    Str("request_id", requestIDFrom(ctx)).
    Int64("user_id", userID).
    Int64("post_id", postID).
    Str("stage", "database.insert").
    Str("dependency", "postgres").
    Int64("duration_ms", time.Since(start).Milliseconds()).
    Str("error_type", "unique_violation").
    Msg("publish post failed")
```

在排查特定故障时,不仅可依据 `request_id` 串联请求链路,亦可通过 `operation="post.publish"` 与 `error_type="unique_violation"` 统计故障影响面。

### 敏感凭据过滤与数据脱敏

详尽记录不等于全量转储原始报文。日志采集需严格执行数据安全合规边界:

- 严禁记录用户密码、短信验证码、银行卡号及身份证件号码;
- 严禁记录 `access_token`、`refresh_token`、Cookie 会话标识与 API 签名私钥;
- 个人联系方式(邮箱、手机号、地址)必须经过掩码脱敏;
- 避免打印大型请求载荷正文与二进制文件流;
- 打印 SQL 时避免包含未经参数化过滤的敏感明文。

关联数据时,记录业务主键或加密散列值即可满足排查需要。

```text
有诊断价值的结构化字段 -> 显式记录
涉及敏感凭据与隐私数据 -> 脱敏、摘要或禁止记录
```

---

## 单点记录原则:避免多层重复输出

如果在调用栈的每一层都捕获并打印日志,一个底层的数据库错误会被放大为多条冗余记录:

```text
repository: query post failed
service: load post failed
handler: publish failed
middleware: request returned 500
```

多层重复打印会导致监控告警被重复触发,放大存储开销,且增加了在海量日志中定位根本原因的心智负担。

遵循单点记录原则:

> **底层调用仅负责错误传播与 `%w` 上下文包装,由最终决定错误处理策略的上层统一记录单次日志。**

具体职责划分如下:

```text
Repository 返回至 Service -> Repository 不打印日志,使用 %w 补充上下文
Service 返回至 Handler     -> Handler 记录一次结构化错误,并转换为 HTTP 响应
Worker 消费任务失败       -> 由 Worker 消费边界记录一次失败事件
定时任务执行失败          -> 由调度入口统一记录一次失败事件
```

### 底层包装错误

```go title="internal/repository/post.go"
var ErrPostNotFound = errors.New("post not found")

type PostRepository struct {
    db *sql.DB
}

func (r *PostRepository) Find(ctx context.Context, postID int64) (Post, error) {
    var post Post
    err := r.db.QueryRowContext(ctx,
        `SELECT id, user_id, content FROM posts WHERE id = $1`,
        postID,
    ).Scan(&post.ID, &post.UserID, &post.Content)
    if errors.Is(err, sql.ErrNoRows) {
        return Post{}, fmt.Errorf("find post %d: %w", postID, ErrPostNotFound)
    }
    if err != nil {
        return Post{}, fmt.Errorf("query post %d: %w", postID, err)
    }
    return post, nil
}
```

`Repository` 层负责执行 SQL,并不决定错误应映射为 404 响应、重试还是告警,因此不应在底层输出缺乏业务全貌的日志。

通过 `%w` 包装错误,既保留原始根因,又在调用栈中追加节点信息,便于上层使用 `errors.Is` 实施分支判断。

### 上层统一收口与记录

```go title="internal/service/post.go"
func (s *PostService) Publish(ctx context.Context, userID, postID int64) error {
    post, err := s.posts.Find(ctx, postID)
    if err != nil {
        return fmt.Errorf("load post for publish: %w", err)
    }
    if post.UserID != userID {
        return ErrForbidden
    }
    if err := s.posts.MarkPublished(ctx, postID); err != nil {
        return fmt.Errorf("mark post published: %w", err)
    }
    return nil
}
```

```go title="internal/handler/post.go"
func (h *PostHandler) Publish(w http.ResponseWriter, r *http.Request) {
    start := time.Now()
    userID := currentUserID(r.Context())
    postID := parsePostID(r)

    if err := h.service.Publish(r.Context(), userID, postID); err != nil {
        errorType := "internal"
        if errors.Is(err, ErrPostNotFound) {
            errorType = "post_not_found"
        } else if errors.Is(err, ErrForbidden) {
            errorType = "forbidden"
        }

        log.Error().
            Err(err).
            Str("service", "api").
            Str("operation", "post.publish").
            Str("request_id", requestIDFrom(r.Context())).
            Int64("user_id", userID).
            Int64("post_id", postID).
            Int64("duration_ms", time.Since(start).Milliseconds()).
            Str("error_type", errorType).
            Bool("retryable", errorType == "internal").
            Msg("publish post failed")

        switch {
        case errors.Is(err, ErrPostNotFound):
            render.Error(w, http.StatusNotFound, "帖子不存在")
        case errors.Is(err, ErrForbidden):
            render.Error(w, http.StatusForbidden, "没有操作权限")
        default:
            render.Error(w, http.StatusInternalServerError, "服务暂时不可用")
        }
        return
    }

    render.Success(w, http.StatusNoContent, "发布成功", nil)
}
```

`Repository` 与 `Service` 均未冗余打印,错误由 `%w` 级联形成调用栈:

```text
mark post published: query post 9001: connection refused
```

`Handler` 在掌握用户、请求与协议上下文的边界统一记录单次日志,确保日志密度与信噪比。

### 访问日志与业务错误日志的分离

HTTP 中间件统一记录请求级别的访问日志:

```json title="访问日志 (中间件输出)"
{
  "level": "info",
  "operation": "http.request",
  "request_id": "5c6a9d7f8b1e4c20",
  "method": "POST",
  "route": "/posts/:id/publish",
  "status": 500,
  "duration_ms": 84,
  "msg": "http request completed"
}
```

- **访问日志**:记录接口的流量特征、状态码分布与耗时表现;
- **业务错误日志**:记录异常根因与受影响的实体上下文。

---

## 链路标识传播:request_id

为串联单次请求涉及的全部日志记录,需要引入跨组件的关联标识:

```go title="internal/middleware/request_id.go"
type requestIDKey struct{}

func withRequestID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        var raw [16]byte
        if _, err := rand.Read(raw[:]); err != nil {
            http.Error(w, "request id unavailable", http.StatusInternalServerError)
            return
        }

        requestID := hex.EncodeToString(raw[:])
        ctx := context.WithValue(r.Context(), requestIDKey{}, requestID)
        w.Header().Set("X-Request-ID", requestID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func requestIDFrom(ctx context.Context) string {
    requestID, _ := ctx.Value(requestIDKey{}).(string)
    return requestID
}
```

---

## 日志级别语义约束

日志级别需准确反映系统的运行状态与干预要求:

- `DEBUG` → 本地开发与联调细节,生产环境默认关闭
- `INFO`  → 关键生命周期节点与正常完成的业务记录
- `WARN`  → 业务正常返回但存在潜在风险的异常偏离(如常规 404 或参数不合法)
- `ERROR` → 操作中断且无法恢复,需要排查或触发即时告警

预期内的业务分支使用 `WARN` 级别记录,避免错误指标虚高影响监控系统的可用性告警:

```go title="业务偏离警告日志"
log.Warn().
    Str("operation", "post.publish").
    Str("request_id", requestIDFrom(ctx)).
    Int64("user_id", userID).
    Int64("post_id", postID).
    Str("error_type", "post_not_found").
    Msg("publish rejected")
```

---

## Agent 提示词配置实践

在工程规范文件(`AGENTS.md`)中建立契约:

```markdown title="AGENTS.md"
### Go 日志规范
1. 所有服务统一以单行结构化 JSON 输出至 stdout/stderr,严禁在业务逻辑中直接使用 `fmt.Println`。
2. 异常处理分支必须记录完备的结构化字段:`service`、`env`、`operation`、`request_id`、`trace_id` 以及业务主键。
3. 底层模块(如 Repository、Service)统一使用 `fmt.Errorf("...: %w", err)` 包装并返回错误,禁止在向上抛出错误时重复打印日志。
4. 依据单点记录原则,由最终处理错误的顶层(如 Handler、Worker 消费入口)统一记录日志。
5. 严禁记录密码、密钥、Token、Cookie 及未脱敏的用户隐私数据。
```

---

## 生产可观测日志闭环

1. **入口唯一标识注入 (`request_id`)**:中间件在入口处生成唯一请求 ID 并注入 Context 与 HTTP Header。
2. **底层错误显式包装**:Repository 与 Service 层严禁打印日志,使用 `%w` 追加上下文。
3. **顶层单点结构化输出**:Handler 或 Worker 消费边界记录一次包含业务主键与耗时的结构化 JSON。
4. **敏感数据严格脱敏**:严禁将密钥、Token 或未脱敏用户隐私写入标准输出。
{.steps}
