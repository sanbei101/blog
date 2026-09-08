---
title: 用日志搭建可观测性
description: 先把每次失败记录清楚
weight: 40
---

前面我们用 `pprof` 解决了“系统到底慢在哪里”,用测试解决了“这次修改有没有把业务改坏”。

但系统上线以后,还有一个更现实的问题:

> *“昨天晚上接口偶发返回 500,现在已经恢复了,你能帮我查一下原因吗?”*

如果服务只在终端里打印一句:

```text
something went wrong
```

那这件事基本只能靠猜。你不知道是哪一个接口、哪一个用户、哪一条数据、哪一个下游依赖出了问题,也不知道这个错误究竟发生了十次还是十万次。

**没有日志的系统,不是没有错误,而是错误发生以后没有留下证据。**

日志是可观测性的入口。可观测性通常包含三类信号:

```text
Logs    -> 这一件具体的事情发生了什么
Metrics -> 这类事情发生了多少次,趋势如何
Traces  -> 一次请求经过了哪些服务和函数
```

日志不能替代指标和链路追踪,但它是最容易先接入、也最适合解释单次失败原因的信号。我们先把日志打好,再把它送进 `Loki`,最后使用 `Grafana` 查询、聚合和告警:

```text
Go 服务 -> stdout JSON 日志 -> Grafana Alloy -> Loki -> Grafana
```

这条链路足够支撑一个小型服务从本地开发走到生产排错,也足够让 `Agent` 根据真实现场继续迭代,而不是对着一句 `internal error` 猜测。

---

## 日志不是 `fmt.Println`

很多项目最开始都是这样记录错误的:

```go
if err := service.Publish(ctx, userID, postID); err != nil {
    fmt.Println("publish failed", err)
    http.Error(w, "internal error", http.StatusInternalServerError)
    return
}
```

这段代码只能说明“某个地方失败了”。当日志进入集中式系统后,你还需要人工从一段文本里猜测字段,这会让检索、聚合和告警都变得很困难。

更好的日志应该是一条**结构化事件**:

```json
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

人类可以直接读 `msg` 和 `error`,Grafana 可以根据 `service`、`operation`、`level` 和 `error_type` 进行过滤与统计,`Agent` 也可以根据 `request_id` 把同一条请求的多条日志串起来。

这里有一个需要特别强调的原则:

> **一定要多打日志,尤其是可能出错的地方,一定要把多个有诊断价值的字段详细地打出来。**

“多打”不是在每一行代码后面都加一句 `log.Info`,而是在每个重要事件和每个失败边界留下足够的上下文。错误发生以后,我们应该能仅凭日志回答下面这些问题:

| 问题 | 建议字段 |
| --- | --- |
| 哪个服务出错 | `service`、`env`、`version`、`host` |
| 哪个请求出错 | `request_id`、`trace_id`、`method`、`route` |
| 哪个业务动作出错 | `operation`、`user_id`、`resource_id` |
| 依赖哪里出错 | `dependency`、`sql_operation`、`upstream_status` |
| 错误是什么 | `error_type`、`error`、`retryable` |
| 影响有多大 | `status`、`duration_ms`、`attempt` |

字段名称要稳定。今天叫 `user_id`,明天叫 `uid`,后天叫 `account`,Grafana 面板和告警规则就会逐渐变成一堆无法复用的特例。

---

## 可能出错的地方,把细节打全

日志最有价值的地方不是成功路径,而是失败路径。成功日志一般只需要说明操作完成;失败日志则需要说明失败发生在什么阶段、带着什么输入、依赖返回了什么结果。

比如发布帖子会经过参数校验、内容审核、数据库写入三个阶段。下面这条日志几乎没有排错价值:

```go
log.Error().Err(err).Msg("publish failed")
```

至少应该补充业务操作和关键对象:

```go
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

这样当用户说“我的帖子发布失败”时,我们可以先按 `request_id` 查一次完整链路,也可以按 `operation="post.publish"` 和 `error_type="unique_violation"` 聚合出受影响的数量。

### 输入也要记录,但不要把秘密记下来

“详细”不等于把整个请求体、请求头和数据库结果全部打出来。日志里绝对不能出现:

* 密码、短信验证码、银行卡号和完整身份证号;
* `access_token`、`refresh_token`、Cookie 和签名密钥;
* 未脱敏的邮箱、手机号、地址等个人信息;
* 大段正文、图片内容和文件二进制;
* 完整 SQL 参数,尤其是其中可能包含用户输入和敏感数据的参数。

需要关联对象时,记录数据库主键、业务编号或脱敏后的摘要即可。比如记录 `user_id=1001` 通常比记录完整用户资料更适合排错;需要关联一个很长的请求体时,可以记录 `body_size`、`content_type` 和经过脱敏的字段。

这是日志系统的第一个边界:

```text
能帮助定位问题的字段 -> 记录
可能泄露秘密或隐私的内容 -> 脱敏、摘要或不记录
```

---

## 错误只在返回给上层的地方打印

“多打日志”很容易被 Agent 理解成“每一层都打印一次”。于是一个数据库错误会变成四条日志:

```text
repository: query post failed
service: load post failed
handler: publish failed
middleware: request returned 500
```

这四条日志看起来都对,但它们其实描述的是同一个失败事件。线上错误量会被放大,告警会被重复触发,人类和 Agent 都要花时间判断哪一条才是根因。

我更喜欢下面这条规则:

> **底层只负责返回和包装错误,最接近最终处理者的上层负责统一打印一次。**

这里的“上层”不是固定指 `Handler`。谁决定了这个错误最终如何处理,谁就是日志所有者:

```text
Repository 返回给 Service -> Repository 不打印,只用 %w 补充上下文
Service 返回给 Handler   -> Handler 记录一次并转换成 HTTP 响应
Worker 处理消息失败       -> Worker 的消费边界记录一次
定时任务执行失败          -> 定时任务入口记录一次
```

### 底层包装,不要底层打印

```go
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

`Repository` 知道 SQL 出错了,但它不知道这个错误最终是要返回 `404`、重试、丢进死信队列,还是直接让任务失败。所以它不应该在这里打印一条没有完整业务上下文的日志。

`%w` 很重要。它既保留了原始错误,又把“在哪一步失败”补进了错误链,上层可以继续使用 `errors.Is` 和 `errors.As` 判断错误类型。

### 上层统一记录和处理

```go
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

这个例子里,`Repository` 和 `Service` 都没有打印日志,但它们返回的错误被 `%w` 串成了完整链路:

```text
mark post published: query post 9001: connection refused
```

`Handler` 在知道 `user_id`、`post_id`、`request_id`、HTTP 结果和业务操作的地方统一记录一次,这条日志才真正具备诊断价值。

### 访问日志和业务错误日志不是重复日志

HTTP 中间件通常还会记录一条访问日志:

```json
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

它和业务错误日志的用途不一样:

* 访问日志回答“哪个接口在什么时间返回了什么状态,耗时多少”;
* 业务错误日志回答“为什么发布失败,哪个用户和帖子受到了影响”。

所以两条日志可以同时存在,但中间件不应该再把同一个 `err` 作为 `error` 级别打印一次。最简单的约定是:中间件记录请求结果,业务边界记录失败原因,每类事件各有一个所有者。

---

## 给每个请求一个 `request_id`

如果一条请求在 Handler、Service、数据库和下游 HTTP 服务中产生了多条日志,我们需要一个共同的关联字段。

最小实现可以只使用 `request_id`:

```go
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

生产环境中也可以接入上游传下来的 `trace_id`,但不要无条件信任客户端传入的超长请求头。无论 `request_id` 由谁生成,都应该限制长度和字符集,避免日志注入和日志膨胀。

如果请求还会跨越多个服务,再使用 OpenTelemetry 生成和传播 `trace_id`、`span_id`。日志中同时记录 `request_id` 和 `trace_id`,就可以从 Grafana 的日志跳到一条完整的调用链。

---

## 日志级别和内容约定

日志级别不应该只是颜色不同的字符串,它应该表达事件的处理语义:

```text
DEBUG -> 开发排查细节,生产环境通常关闭
INFO  -> 正常完成的关键事件和访问记录
WARN  -> 请求可以返回,但出现了需要关注的异常情况
ERROR -> 本次操作失败,需要排查或触发告警
```

`404`、参数校验失败、用户重复点击这类预期内的业务结果,通常不应该全部记成 `ERROR`。否则告警系统会把正常的用户输入错误和数据库宕机混在一起。

例如:

```go
log.Warn().
    Str("operation", "post.publish").
    Str("request_id", requestIDFrom(ctx)).
    Int64("user_id", userID).
    Int64("post_id", postID).
    Str("error_type", "post_not_found").
    Msg("publish rejected")
```

但是“预期内”不等于“不记录”。参数错误、权限错误、重复请求依然应该保留,否则产品或安全同学无法知道某个接口是否正在被大量错误调用。

---

## Agent Prompt 调优

```markdown
### Go 日志规范
1. 所有服务输出一行一个 JSON 日志到 stdout/stderr,禁止在业务层直接使用 fmt.Println 记录生产事件。
2. 可能失败的操作必须记录足够的结构化字段: service、env、operation、request_id、trace_id、业务主键
3. Repository、Service 等底层函数只使用 fmt.Errorf("...: %w", err) 返回和包装错误,禁止在错误继续向上返回时重复打印。
4. 谁决定错误最终如何处理,谁负责记录一次最终日志。HTTP 中间件只记录访问结果,不要再次打印同一个业务错误。
5. 密码、Token、Cookie、验证码、完整个人信息、完整请求体和敏感 SQL 参数禁止写入日志;需要关联时使用主键、脱敏值或摘要。
```
