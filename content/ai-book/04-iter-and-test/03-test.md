---
title: Go 全面测试:单元测试、容器化集成测试与 synctest 虚拟时间
description: 划分测试边界,消除伪造 Mock 的逻辑幻觉
weight: 30
---

在人机协同开发中,最需要警惕的汇报之一是:

> *"代码已完成,测试已通过。"*

审查测试代码时,常会发现明显的工程隐患:
- 当 `Service` 依赖数据库时,模型生成了一个返回 `nil` 的 `FakeRepository`,使每个调用都直接跳过底层读写;
- 测试仅断言无错误返回,未验证数据是否真实持久化或事务是否正确回滚;
- 并发逻辑中硬编码 `time.Sleep(100 * time.Millisecond)`,在本地容易通过,而在持续集成流水线中因调度延迟产生随机 Flaky 报错。

这类测试的风险在于提供虚假的通过信号:模型基于自创的 Mock 验证了自身生成的逻辑,而真实的 SQL 语法、约束与并发竞争从未被运行时检验。

> [!WARNING] 谨防 Fake Mock 构筑的虚假安全感
> 测试的核心目标不是为代码提供形式上的通过背书,而是提供不可伪造的运行时事实。纯算法缺陷交由单测捕获,数据持久化缺陷由真实容器拦截,并发时序缺陷由 `synctest` 与竞态检测器共同收敛。

```text
无状态纯计算 ──→ 表驱动单元测试: 确定性输入映射确定性输出 (毫秒级响应)
业务状态流转 ──→ 真实容器集成测试: 加载真实数据库引擎, 执行原生迁移文件 (引擎直接裁决)
并发与时钟   ──→ testing/synctest: 虚拟时钟 bubble 与受控协程调度 (消除 Flaky)
```

---

## 无状态逻辑:表驱动单元测试

若目标函数无外部 I/O 依赖(无数据库、网络交互、全局状态及系统时钟变更),输出严格取决于入参,则最适合采用表驱动单测。

例如帖子热度评分计算:

```go title="internal/domain/score.go"
func Score(likes, comments int, age time.Duration) int {
	penalty := int(age.Hours() / 24)
	return max(likes+comments*2-penalty, 0)
}
```

使用表驱动测试全面覆盖边界状态:

```go title="internal/domain/score_test.go"
func TestScore(t *testing.T) {
	tests := []struct {
		name            string
		likes, comments int
		age             time.Duration
		want            int
	}{
		{name: "新帖子", likes: 10, comments: 3, want: 16},
		{name: "一天后衰减", likes: 10, comments: 3, age: 24 * time.Hour, want: 15},
		{name: "最低为零", age: 30 * 24 * time.Hour, want: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Score(tt.likes, tt.comments, tt.age); got != tt.want {
				t.Fatalf("Score() = %d, want %d", got, tt.want)
			}
		})
	}
}
```

单测执行耗时在毫秒级,模型可在单轮内快速确认逻辑完备性。

---

## 业务状态流转:拒绝过度使用 Fake

假设实现"重复点赞具备幂等性"的业务逻辑。模型极易生成伪通过的 Fake 测试:

```go {tab="虚假 Mock 测试 (隐藏真实隐患)" group="test_paradigm" value="fake"}
type fakeLikeRepository struct{}

func (fakeLikeRepository) Add(ctx context.Context, userID, postID int64) error {
	return nil // 盲目返回 nil, 无法验证数据库唯一约束与事务
}

func TestLikePost(t *testing.T) {
	service := NewLikeService(fakeLikeRepository{})
	if err := service.Like(t.Context(), 1, 100); err != nil {
		t.Fatal(err)
	}
}
```
```go {tab="真实容器集成测试 (引擎直接裁决)" group="test_paradigm" value="real"}
func TestLikePostIsIdempotent(t *testing.T) {
	db := testutil.Postgres(t)
	ctx := t.Context()

	// 真实插入前置种子数据
	db.Exec(ctx, `INSERT INTO users (id, name) VALUES ($1, $2)`, 1, "sanbei")
	db.Exec(ctx, `INSERT INTO posts (id, user_id, content) VALUES ($1, $2, $3)`, 100, 1, "hello")

	service := NewLikeService(NewPostgresLikeRepository(db))
	// 验证首次点赞成功,二次点赞幂等消化,数据库唯一索引真实生效
	if err := service.Like(ctx, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := service.Like(ctx, 1, 100); err != nil {
		t.Fatalf("second Like() should be idempotent: %v", err)
	}
}
```

Fake 只能反映编写者预设的乐观行为。一旦模型在第一轮对业务模型的理解产生偏差,后续生成的 Fake 和断言将沿袭该偏差,造成"单测全绿但上线崩溃"的局面。

真实业务集成测试通过 Testcontainers 启动与生产版本一致的临时数据库,由数据库引擎直接裁决约束。

---

## 基于 testcontainers-go 构建真实数据库环境

在 `internal/testutil/helper.go` 中建立统一的环境入口:

```go title="internal/testutil/helper.go"
package testutil

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"your/project/internal/migrations"
)

func Postgres(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := t.Context()
	container, err := postgres.Run(ctx,
		"postgres:18-alpine",
		postgres.WithDatabase("app_test"),
		postgres.WithUsername("app"),
		postgres.WithPassword("app"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	testcontainers.CleanupContainer(t, container)

	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("postgres connection string: %v", err)
	}

	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	t.Cleanup(db.Close)

	if err := migrations.Up(ctx, db); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	return db
}
```

这里关键在于**直接执行项目原生的 migration 脚本**,避免在测试中单独维护一份建表语句导致与生产环境偏离。

通过该工具函数,业务测试可专注于状态验证:

```go
func TestLikePostIsIdempotent(t *testing.T) {
	db := testutil.Postgres(t)
	ctx := t.Context()

	if _, err := db.Exec(ctx,
		`INSERT INTO users (id, name) VALUES ($1, $2)`, 1, "sanbei",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx,
		`INSERT INTO posts (id, user_id, content) VALUES ($1, $2, $3)`, 100, 1, "hello",
	); err != nil {
		t.Fatal(err)
	}

	service := NewLikeService(NewPostgresLikeRepository(db))
	if err := service.Like(ctx, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := service.Like(ctx, 1, 100); err != nil {
		t.Fatalf("second Like() should be idempotent: %v", err)
	}

	var likes int
	if err := db.QueryRow(ctx,
		`SELECT count(*) FROM post_likes WHERE user_id = $1 AND post_id = $2`, 1, 100,
	).Scan(&likes); err != nil {
		t.Fatal(err)
	}
	if likes != 1 {
		t.Fatalf("like rows = %d, want 1", likes)
	}
}
```

该测试覆盖了数据迁移、SQL 执行、唯一约束冲突处理与数据层映射。出现任何字段不匹配或事务异常,数据库引擎将直接抛出明确错误。

环境遵循按需引入原则:仅依赖 PostgreSQL 的模块只启动对应容器;涉及缓存或流式消息时再按需扩充对应组件。

---

## `testing/synctest`:纳秒级虚拟时间与并发确定性调度

在测试并发与定时任务时,传统方案常通过调整时间间隔并配合 `time.Sleep` 验证。这种方式测试执行缓慢,且极易受 CI 调度抖动影响产生随机 Flaky 失败。

Go 1.25 正式引入标准库 [`testing/synctest`](https://pkg.go.dev/testing/synctest):

- `synctest.Test` 构建隔离的并发 bubble,接管其内部启动的全部 Goroutine;
- bubble 内的 `time.Sleep`、`time.Timer` 与 `time.Ticker` 接入虚拟时钟系统。当内部 Goroutine 全部处于阻塞状态时,时钟直接跳跃至下一个就绪事件;
- `synctest.Wait` 等待其他 Goroutine 进入稳定阻塞状态,无需硬编码等待时间;
- 未退出的泄露协程在测试结束时将被明确捕获。

> [!TIP] 虚拟时间 bubble 消除调度抖动
> 在并发超时测试中,严禁用 `time.Sleep(100ms)` 碰运气。`synctest.Test` 在虚拟时钟中纳秒级跳跃调度,在数毫秒内即可完成生产级 3 秒超时边界的严密断言,杜绝 CI 调度延迟引发的偶发报错。

以异步审核超时的时序控制为例:用户发布内容后由异步 Worker 处理,系统设定 3 秒超时限制;超时未完成则拒绝发布:

```go title="internal/service/moderation.go"
var ErrModerationTimeout = errors.New("moderation timeout")

type ModerationResult struct {
	Approved bool
	Reason   string
}

func AwaitModeration(ctx context.Context, result <-chan ModerationResult) (ModerationResult, error) {
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ModerationResult{}, ctx.Err()
	case r := <-result:
		return r, nil
	case <-timer.C:
		return ModerationResult{}, ErrModerationTimeout
	}
}
```

使用 `synctest` 可以在保持生产级 3 秒超时参数的前提下,在数毫秒内完成纳秒级边界断言:

```go title="internal/service/moderation_test.go"
func TestAwaitModerationTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		result := make(chan ModerationResult)
		done := make(chan error, 1)
		go func() {
			_, err := AwaitModeration(t.Context(), result)
			done <- err
		}()

		// 推进至距截止时间仅剩 1ns, 此时不可提前触发超时
		synctest.Sleep(3*time.Second - time.Nanosecond)
		select {
		case err := <-done:
			t.Fatalf("returned before deadline: %v", err)
		default:
		}

		// 再推进 1ns 跨越边界, 此时必须触发超时
		synctest.Sleep(time.Nanosecond)
		if err := <-done; !errors.Is(err, ErrModerationTimeout) {
			t.Fatalf("AwaitModeration() error = %v, want %v", err, ErrModerationTimeout)
		}
	})
}
```

测试在虚拟时间中走过 3 秒,但在宿主机上仅耗费数毫秒,精确验证了 3 秒阈值的前后边界。

测试套件的分层执行命令:

```bash title="多层级测试执行命令"
go test -short ./...          # 快速单元测试 (毫秒级)
go test -count=1 ./...        # 包含容器集成测试的完整套件
go test -race -count=1 ./...  # 并发竞态检测门禁
```

---

## Agent 提示词配置实践

在工程协同规范文件(`AGENTS.md`)中建立契约:

```markdown title="AGENTS.md"
### Go 测试规范
1. 无外部 I/O、输出严格由输入决定的纯计算函数,使用标准库 `testing` 编写表驱动单元测试。
2. 涉及 Handler、Service、Repository、数据库事务或状态变更的业务,必须编写集成测试;通过 `internal/testutil/helper.go` 和 Testcontainers 启动真实依赖并应用项目迁移脚本。
3. 禁止使用空返回的 Fake Repository 替代数据库验证。Fake 仅限于稳定模拟不可控的外部依赖故障。
4. 并发、超时与定时器控制使用 `testing/synctest` 验证,严禁使用任意时长的真实 `time.Sleep` 进行调度猜测。
5. 测试用例之间必须维持数据隔离,避免相互依赖执行顺序或残留数据。
6. 提交前必须执行 `go test -count=1 ./...`;涉及并发逻辑时执行 `go test -race -count=1 ./...`。
```

---

## 全面测试分层工作流

1. **纯计算逻辑表驱动**:针对无状态映射采用表驱动单测,毫秒级快速确认逻辑完备性。
2. **核心业务状态流转**:通过 Testcontainers 启动真实 PostgreSQL 容器并自动执行原生迁移脚本,由真实数据库引擎裁决约束。
3. **时钟与并发状态机**:接入 `testing/synctest` 虚拟时钟 bubble,纳秒级推进时间,消除不确定性等待。
4. **并发竞态门禁**:执行 `go test -race -count=1 ./...` 作为提交最终断言。
{.steps}
