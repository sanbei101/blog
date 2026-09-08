---
title: Go 全面测试指南
description: 无状态逻辑用单测,业务流程用真实环境,并发代码交给 synctest
weight: 30
---

在 AI 接管大量编码工作以后,开发中最危险的一句话已经变成了:

> *"代码写完了,测试也通过了。"*

听起来很稳,但点开测试文件一看,经常会发现另一番景象:

* `Service` 依赖数据库,Agent 顺手写了一个 `FakeRepository`,让每个方法都返回 `nil`;
* 测试只断言"没有报错",却没有检查数据到底有没有落库、事务有没有回滚;
* 并发代码里塞一个 `time.Sleep(100 * time.Millisecond)`,在本地偶尔成功,放进 CI 就开始抽风。

这类测试最大的危害不是覆盖率低,而是会亮起一盏**错误的绿灯**。Agent 看到 `go test ./...` 全部通过,就会更加确信自己编写的 SQL、事务和并发逻辑没有问题,实际上它只是用自己生成的 `Fake` 证明了自己生成的代码。

测试不应该替代码作证,测试应该拿出代码无法伪造的事实。

我的划分方式很简单:

```
无状态纯逻辑 --> 单元测试: 输入确定,输出就必须确定
业务状态流转 --> 集成测试: 连接真实数据库,执行真实 migration
并发与时间   --> testing/synctest: 虚拟时间 + 可观测的 goroutine 调度
```

这不是要把每个函数都测一遍,更不是追求好看的 `100% coverage`。所谓全面测试,是让每种风险都撞上它真正的边界:算法错误交给单测,业务与基础设施错位交给集成测试,并发时序错误交给 `synctest` 和 `race detector`。

---

## 无状态逻辑: 单元测试

如果一个函数没有数据库、网络、文件、全局变量和当前时间,返回值只取决于输入,它就是单元测试最喜欢的形状。

例如帖子热度计算:

```go
func Score(likes, comments int, age time.Duration) int {
	penalty := int(age.Hours() / 24)
	return max(likes+comments*2-penalty, 0)
}
```

这种函数一个表驱动测试就足够把边界锁死:

```go
func TestScore(t *testing.T) {
	tests := []struct {
		name              string
		likes, comments   int
		age               time.Duration
		want              int
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

单元测试的优势就是快。几十、几百个 case 可以在毫秒内跑完,Agent 每改一行代码都能立刻得到反馈。

判断标准也很直接:

* 字符串解析、参数校验、排序、金额计算、状态判断等纯函数,优先写单元测试;

---

## 业务逻辑: Fake 最容易制造幻觉

假设我们正在实现"重复点赞只能计数一次"。Agent 很容易生成下面这种测试:

```go
type fakeLikeRepository struct{}

func (fakeLikeRepository) Add(ctx context.Context, userID, postID int64) error {
	return nil
}

func TestLikePost(t *testing.T) {
	service := NewLikeService(fakeLikeRepository{})

	if err := service.Like(t.Context(), 1, 100); err != nil {
		t.Fatal(err)
	}
}
```

测试当然会通过,因为 `fakeLikeRepository.Add` 被写死成了成功。

但真正上线时决定这个功能能不能工作的东西,它一件也没有验证:

* migration 里到底有没有 `UNIQUE(user_id, post_id)`;
* SQL 使用的是 `post_likes` 还是 Agent 幻想出来的 `likes`;
* 重复插入会被幂等处理,还是直接抛出唯一键冲突;
* 点赞记录和 `posts.like_count` 是否处于同一个事务;
* 用户或帖子不存在时,外键与业务错误能否正确返回。

`Fake` 只会回答测试作者预先写进去的答案。更要命的是,实现代码、接口、Fake 和测试经常由同一个 Agent 在同一轮对话里生成:只要它在第一步理解错了业务,后面所有文件就会整整齐齐地一起错下去。

```
[ Fake 闭环 ] AI 猜测接口 --> AI 实现 Fake --> AI 按同一猜测写断言 --> 全绿,实际数据库一跑就炸
[ 真实闭环 ] AI 启动容器 --> 执行真实 migration --> 调用真实 Repository --> 数据库直接裁决
```

因此,只要测试目标涉及 `Handler`、`Service`、`Repository`、事务或数据状态流转,我会直接写集成测试。不要拿一个会说"好的"的 `FakeXX` 来冒充业务验证。

当然,`Fake` 并非永远不能出现。它适合注入"支付网关超时"、"对象存储返回 500"这类很难稳定制造的错误分支;但它只能证明失败处理逻辑,不能替真实数据库、真实协议或第三方沙箱证明主流程正确。

---

## 一个全局 `helper.go`,造出最小真实环境

集成测试最常见的反对意见是环境太难搭:每个测试文件都要连接数据库、执行 migration、清理数据,Agent 最后又会复制出几百行初始化代码。

解决办法并不复杂,在 `internal/testutil/helper.go` 放一个全项目共用的环境入口,使用 [`testcontainers-go`](https://golang.testcontainers.org/) 启动和生产相同大版本的数据库:

```sh
go get github.com/testcontainers/testcontainers-go/modules/postgres
```

```go
// internal/testutil/helper.go
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

这里最关键的不是容器,而是**继续运行项目自己的 migration**。千万不要为了测试重新手写一份 `CREATE TABLE`,否则生产 schema 和测试 schema 很快又会分裂成两个世界。

有了这一个 Helper,业务测试只关心业务本身:

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

这一个测试会同时碰撞 migration、SQL、唯一约束、Repository 和 Service。任何一层出现字段漂移或事务错误,数据库都会立刻把错误甩回终端,Agent 再也无法靠脑补宣布成功。

注意,全局复用的是 `helper.go` 里的**创建方式**,不是一份永久共享的脏数据库。默认让每个测试获得隔离环境最省心;只有容器启动时间真的成为瓶颈以后,再考虑每个 package 共用容器并通过独立 database、schema 或 snapshot 重置数据。

所谓"最小环境",也不是一口气启动 `Postgres + Redis + Kafka + MinIO` 全家桶。这个业务路径只依赖 `PostgreSQL`,那就只启动 `PostgreSQL`;测试真正走到缓存或消息队列时,再把对应容器加进来。

---

## `testing/synctest`:把并发时间关进实验室

数据库可以装进容器,但并发与时间一直是 Go 测试里更难控制的部分。

过去测试一个每小时执行一次的后台任务,常见写法是把间隔改成 `10ms`,然后在测试里 `time.Sleep(20ms)`。这种做法既慢又不可靠:CI 机器一忙,20ms 内 Goroutine 没抢到调度,测试就会随机失败;把 Sleep 加到一秒,套件又会越来越慢。

Go 1.25 将实验特性正式升级为标准库 [`testing/synctest`](https://pkg.go.dev/testing/synctest)。

* `synctest.Test` 会创建一个隔离的并发 "bubble",其中启动的 Goroutine 都归这个测试管理;
* bubble 内的 `time.Sleep`、`time.Timer`、`time.Ticker` 使用虚拟时钟,所有 Goroutine 阻塞后,时间会直接跳到下一个事件;
* `synctest.Wait` 会等到其他 Goroutine 全部稳定阻塞,不需要再猜一个 10ms;
* 测试结束时仍未退出的 Goroutine 会暴露死锁或泄漏,而不是悄悄留在下一个测试里。

举个栗子

用户发布帖子后,系统会把正文交给异步审核 Worker。审核结果必须在 3 秒内返回;超过 3 秒仍没有结果,接口就应该拒绝本次发布,避免未经审核的内容直接进入公开时间线:

```go
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

过去为了测试它,要么真的等待 3 秒,要么专门把生产代码改成接收一个 `timeout` 参数,测试时偷偷传入 `10ms`。前者让测试越来越慢,后者则意味着测试与生产根本没有跑在相同的时间配置上。

使用 `synctest` 后,我们可以直接使用生产环境的 3 秒超时,并精确检查它的前后边界:

```go
func TestAwaitModerationTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		result := make(chan ModerationResult)
		done := make(chan error, 1)
		go func() {
			_, err := AwaitModeration(t.Context(), result)
			done <- err
		}()

		// 还差 1ns 才到 3 秒,此时绝不能提前超时。
		synctest.Sleep(3*time.Second - time.Nanosecond)
		select {
		case err := <-done:
			t.Fatalf("returned before deadline: %v", err)
		default:
		}

		// 再前进 1ns,审核等待必须立即结束。
		synctest.Sleep(time.Nanosecond)
		if err := <-done; !errors.Is(err, ErrModerationTimeout) {
			t.Fatalf("AwaitModeration() error = %v, want %v", err, ErrModerationTimeout)
		}
	})
}
```

这段测试会在虚拟时间里完整走过 3 秒,现实中仍然只需要几毫秒。它验证的也不只是"最终返回了超时",而是把业务真正关心的时间边界锁死:**3 秒前不能失败,3 秒后不能继续等待**。

同一个场景还可以验证 Worker 在 2 秒时返回结果,等待方能够立刻收到:

```go
func TestAwaitModerationApproved(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		result := make(chan ModerationResult)
		go func() {
			time.Sleep(2 * time.Second)
			result <- ModerationResult{Approved: true}
		}()

		got, err := AwaitModeration(t.Context(), result)
		if err != nil {
			t.Fatal(err)
		}
		if !got.Approved {
			t.Fatalf("moderation result = %+v, want approved", got)
		}
	})
}
```

Worker 里的 `time.Sleep(2 * time.Second)` 同样走的是虚拟时钟,所以这个成功用例也不会真的阻塞 2 秒。

`synctest` 也有明确边界:不要在 bubble 里访问真实网络、外部进程或 Testcontainers,因为这些 I/O 不受虚拟时钟控制。数据库业务交给集成测试,纯并发状态机交给 `synctest`,各管各的风险。

它也不能替代 Race Detector。`synctest` 让时序可控,`go test -race` 负责发现未同步读写,两者应该一起使用:

```sh
go test -short ./...          # 快速单元测试
go test -count=1 ./...        # 包含 Testcontainers 的完整测试
go test -race -count=1 ./...  # 并发竞争检查
```

---

### ❌ 只有 Fake 的 AI 测试闭环

* Agent 为每个依赖生成一套 `FakeXX`,测试代码比业务代码还长;
* 所有 Fake 都返回预期答案,覆盖率一路上涨,真实 migration 和 SQL 从未运行;
* 并发测试依赖真实 `Sleep`,本地绿、CI 红,最后大家习惯性重跑直到通过;
* Agent 根据错误前提同时生成实现与测试,形成一套逻辑自洽、运行必炸的幻觉系统。

### ✅ 全面测试的验证闭环

* 无状态函数用快速单测锁定输入输出,每次修改都能秒级反馈;
* 业务路径通过统一 `helper.go` 拉起最小真实环境,让数据库约束和 migration 参与裁决;
* 并发代码进入 `synctest` bubble,虚拟时间消灭慢测试与随机 Sleep;
* `go test ./...` 和 `go test -race ./...` 共同成为 Agent 交付前不可跳过的门禁。

全面测试真正节省的不是线上修 Bug 的时间,而是人类反复审查 AI 猜测的时间。测试一旦连接到真实边界,报错就会带着 SQL、约束、竞争位置和具体断言回到终端,Agent 可以继续迭代,而不是等用户上线以后替它发现问题。

---

## Agent Prompt 调优

```markdown
### Go 测试规范
1. 无状态、无 I/O、输出仅由输入决定的函数,使用标准库 `testing` 编写表驱动单元测试。
2. 涉及 Handler、Service、Repository、数据库事务或业务状态流转的功能,必须编写集成测试;通过 `internal/testutil/helper.go` 和 Testcontainers 启动最小真实依赖,并执行项目原有 migration。
3. 禁止使用 `FakeXX`、Mock Repository 或内存 Map 代替真实数据库后宣称业务测试完成。Fake 只允许用于稳定制造第三方服务失败等异常分支,且必须说明它没有覆盖真实协议。
4. 并发、超时、定时器和 Goroutine 生命周期使用 `testing/synctest` 验证,禁止用任意时长的真实 `time.Sleep` 猜测调度完成。
5. 测试之间必须数据隔离,不得依赖执行顺序或共享上一个测试留下的状态。
6. 交付 Go 代码前必须执行 `go test -count=1 ./...`;涉及并发时还必须执行 `go test -race -count=1 ./...`,不得仅汇报某个 Fake 单测通过。
```
