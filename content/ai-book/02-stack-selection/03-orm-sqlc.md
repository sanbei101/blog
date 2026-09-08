---
title: 用 sqlc 干掉 orm
description: 没有性能损耗, 没有理解损耗
weight: 30
---

众所周知,`GORM` 是有反射造成的性能损耗的,但是通过手写 SQL 又不安全(字符串拼接容易出注入漏洞、字段改了难以察觉、手写 `Scan` 极其繁琐)。有什么办法既能享受到原生的性能收益,又可以获得 `ORM` 的友好类型呢?

第一章埋了个坑,当时说:在 `Go` 里会选一个很厉害的工具 `sqlc`,它完全可以代替整个 `repo` 层,还对 `Agent` 的上下文更友好。

> 能在编译期解决的问题,绝不留到运行期。
> 告别反射与抽象税,用纯 SQL 驱动类型安全的 Go 代码。

## 为什么我们要把 ORM 换掉?

在传统的 Go 项目开发里,起手就是一个 `GORM`,写简单的增删改查时是很爽:

```go
db.Where("status = ?", "active").Order("created_at desc").Find(&users)
```

但这种"爽快"是有沉重代价的:

1. **反射造成的性能损耗**:为了把数据库里的二维数据映射到你的结构体上,底层动用了大量的 `reflect`,不停地检查字段类型、做内存开辟和类型断言。
2. **隐藏在字符串里的暗雷**:你的表结构改了一个字段名,代码里的 `"status = ?"` 还是旧的。编译器根本发现不了,直到线上运行到这行代码才会抛错。
3. **沉重的抽象税**:ORM 在底层驱动之上包了一层又一层的抽象、中间件、Plugin、Callback。为了兼顾跨数据库的方言,它把底层驱动最极致的特性全都磨平了。

很多同学可能会说:"主播主播,我业务简单,不在乎这几毫秒的损耗,我就图它写着方便不行吗?"

行,那我们来看看当业务变复杂之后会发生什么。

## 逃不掉的宿命:复杂的查询终成 `db.Raw()`

使用 ORM 的团队,无论前期口号喊得多响亮,项目写到后面都会遇到同一个死局:**只要业务逻辑稍微复杂一点,ORM 的链式 API 就会变成灾难**。

假设我们做一个真实的 SaaS 场景:统计某个租户下,近 30 天内每个用户的订单总额、平均客单价,并联表筛选出最近活跃的用户。

在 GORM 里,你为了用它的链式语法,通常得写成这样:

```go
type UserStat struct {
    UserID       int64   `gorm:"column:user_id"`
    Username     string  `gorm:"column:username"`
    TotalAmount  float64 `gorm:"column:total_amount"`
    AvgAmount    float64 `gorm:"column:avg_amount"`
}

var stats []UserStat
err := db.Table("users").
    Select("users.id as user_id, users.username, COALESCE(SUM(orders.amount), 0) as total_amount, COALESCE(AVG(orders.amount), 0) as avg_amount").
    Joins("LEFT JOIN orders ON orders.user_id = users.id AND orders.created_at >= ?", thirtyDaysAgo).
    Where("users.tenant_id = ? AND users.status = ?", tenantID, "active").
    Group("users.id, users.username").
    Having("SUM(orders.amount) > ?", minTotalAmount).
    Order("total_amount DESC").
    Limit(10).
    Scan(&stats).Error
```

1. **所有的字段、别名、计算表达式全是在字符串里硬编码拼接**。
2. **无重构安全性**:如果 `orders.amount` 改名叫 `orders.total_price`,编译器连一个警告都不会给,IDE 也搜不到代码引用。
3. **ORM 自身的链式调用规则极度反直觉**:比如 `Group` 和 `Select` 里的字段到底该怎么对齐?为什么有时候加了 `Joins` 后分页计算的 `Count` 会算出天文数字?

于是,可能最后会破罐子破摔,直接祭出: **`db.Raw()`**。

```go
err := db.Raw(`
    SELECT 
        u.id AS user_id,
        u.username,
        COALESCE(SUM(o.amount), 0) AS total_amount,
        COALESCE(AVG(o.amount), 0) AS avg_amount
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id AND o.created_at >= ?
    WHERE u.tenant_id = ? AND u.status = ?
    GROUP BY u.id, u.username
    HAVING SUM(o.amount) > ?
    ORDER BY total_amount DESC
    LIMIT 10
`, thirtyDaysAgo, tenantID, "active", minTotalAmount).Scan(&stats).Error

```

当你敲下 `db.Raw()` 的那一刻,**ORM 最后的遮羞布就被扯掉了**。

你为了"方便"引入了一个庞大的 ORM,结果面对稍微复杂点的业务查询,你依然在手动写纯 SQL。而且你还吞下了 `db.Raw` 带来的所有缺点:

* **静态检查彻底归零**:SQL 语法写错、问号占位符传少了一个,全得在运行时报错。
* **静默填充 Bug**:你在 SQL 别名里写了 `user_id`,但结构体 Tag 写错了一个字母成 `gorm:"column:userid"`,GORM 在 `.Scan()` 时**不会报错**,而是悄无声息地给 `UserID` 赋零值 `0`!这种 Bug 线上查起来足以让人崩溃。
* **白白交税**:你手写了纯 SQL,却依然要在运行时走一遍 GORM 的反射机制来填充结构体,白白浪费 CPU 和内存。

既然复杂查询终究要写 SQL,为什么不换一个思维:**直接以 SQL 为核心,让工具在编译阶段帮我们把所有 Go 代码自动生成好?**

这就是 [sqlc](https://sqlc.dev/)。

---

## `sqlc` 的设计哲学: `SQL` 是第一公民

`sqlc` 的工作逻辑跟传统 ORM 完全反过来: **SQL 是你的源码,Go 代码只是它的编译产物**。

你不用去学那些稀奇古怪的链式方法,也不用给 Go 结构体打几十个复杂的 Tag。你的工作流只有三步:

1. 写好你的数据库 DDL 建表语句(`schema.sql`)。
2. 写好你的业务 SQL(`query.sql`)。
3. 终端敲一行命令:`sqlc generate`。

`sqlc` 会在本地直接调用真实的数据库 AST 解析器,把你的 SQL 解析完,自动生成**纯标准库/纯 pgx、无反射、强类型**的 Go 代码。

---

## 实战:一个真实的 AI 知识库检索场景

口说无凭,我们用一个当下最常见的真实业务场景来跑一遍:**带租户隔离、JSONB 元数据过滤、以及向量相似度检索的 AI 知识库切片查询**。

**1. 定义 DDL (`schema.sql`)**

我们在数据库中建两张表,支持 PostgreSQL 的 `uuid`、`jsonb` 以及 `vector` 扩展:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(64) NOT NULL,
    title TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(32) NOT NULL DEFAULT 'published',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tenant_id VARCHAR(64) NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1536) NOT NULL,
    token_count INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chunks_embedding ON document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_chunks_tenant ON document_chunks(tenant_id);

```

**2. 写业务 SQL (`query.sql`)**

我们希望做一次 RAG 检索:给入租户 ID、用户的检索向量、相似度阈值以及分页数量,联表查出切片内容、文档标题和计算后的余弦相似度:

```sql
-- name: SearchDocumentChunks :many
SELECT 
    c.id AS chunk_id,
    c.document_id,
    d.title AS document_title,
    c.content,
    c.metadata,
    1 - (c.embedding <=> $1) AS similarity_score
FROM document_chunks c
INNER JOIN documents d ON d.id = c.document_id
WHERE c.tenant_id = $2
  AND d.status = 'published'
  AND (1 - (c.embedding <=> $1)) >= $3
ORDER BY similarity_score DESC
LIMIT $4;

```

看,这就是所有人一眼就能看懂的纯粹 SQL。

**3. 配置与生成 (`sqlc.yaml`)**

```yaml
version: "2"
sql:
  - engine: "postgresql"
    schema: "schema.sql"
    queries: "query.sql"
    gen:
      go:
        package: "db"
        out: "internal/db"
        sql_package: "pgx/v5"
        overrides:
          - db_type: "vector"
            go_type:
              import: "github.com/pgvector/pgvector-go"
              type: "Vector"
```

敲下 `sqlc generate`,看看它给我们吐出了什么代码:

```go
// Code generated by sqlc. DO NOT EDIT.

package db

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	pgvector "github.com/pgvector/pgvector-go"
)

const searchDocumentChunks = `-- name: SearchDocumentChunks :many
SELECT 
    c.id AS chunk_id,
    c.document_id,
    d.title AS document_title,
    c.content,
    c.metadata,
    1 - (c.embedding <=> $1) AS similarity_score
FROM document_chunks c
INNER JOIN documents d ON d.id = c.document_id
WHERE c.tenant_id = $2
  AND d.status = 'published'
  AND (1 - (c.embedding <=> $1)) >= $3
ORDER BY similarity_score DESC
LIMIT $4
`

type SearchDocumentChunksParams struct {
	Embedding       pgvector.Vector `json:"embedding"`
	TenantID        string          `json:"tenant_id"`
	SimilarityScore float64         `json:"similarity_score"`
	Limit           int32           `json:"limit"`
}

type SearchDocumentChunksRow struct {
	ChunkID         uuid.UUID       `json:"chunk_id"`
	DocumentID      uuid.UUID       `json:"document_id"`
	DocumentTitle   string          `json:"document_title"`
	Content         string          `json:"content"`
	Metadata        json.RawMessage `json:"metadata"`
	SimilarityScore float64         `json:"similarity_score"`
}

func (q *Queries) SearchDocumentChunks(ctx context.Context, arg SearchDocumentChunksParams) ([]SearchDocumentChunksRow, error) {
	rows, err := q.db.Query(ctx, searchDocumentChunks,
		arg.Embedding,
		arg.TenantID,
		arg.SimilarityScore,
		arg.Limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []SearchDocumentChunksRow
	for rows.Next() {
		var i SearchDocumentChunksRow
		if err := rows.Scan(
			&i.ChunkID,
			&i.DocumentID,
			&i.DocumentTitle,
			&i.Content,
			&i.Metadata,
			&i.SimilarityScore,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}
```

1. **参数入参是一个干净的结构体** `SearchDocumentChunksParams`,参数类型一清二楚,没有 `any`,没有 `interface{}`。
2. **返回值是一目了然的行数据结构体** `SearchDocumentChunksRow`。
3. 赋值是极简的 `rows.Scan(...)`,精确对应每一列的指针取址。**零反射开销!**
4. 整段代码没有依赖任何第三方奇奇怪怪的包,只有 `pgx/v5` 驱动。

---

## 静态检查,快速排错

在 ORM 时代,写 SQL 或者拼接条件最痛苦的一点就是:**所有的拼写错误和类型错误,只有在运行时才会爆炸**。

但在 `sqlc` 体系下,`sqlc` 内部直接内嵌了 PostgreSQL 的语法解析器内核。这意味着你的 SQL 享有和 Go 代码一样的**静态类型检查待遇**。

看看下面这些场景:

**1. 场景 1:字段敲错了**

你在 `query.sql` 里面把 `d.title` 手抖打成了 `d.titile`:

```text
$ sqlc generate
query.sql:6:5: column "titile" does not exist in table "documents"
```

它直接给你精确定位到 `query.sql` 第 6 行第 5 列,告诉你这个字段根本不存在。

**2. 场景 2:类型传反了**

表结构里 `c.tenant_id` 是 `VARCHAR(64)`,而你在 SQL 里写了一个 `c.tenant_id = $1`,却在上一句给了个整数比较,或者给 `token_count` 传入了字符串:

```text
$ sqlc generate
query.sql:10:11: operator does not exist: integer = text
```

它会在编译期就告诉你类型不匹配。

你根本不需要启动本地数据库,更不需要把服务跑起来调一遍接口才能知道 SQL 写没写对。**只要 `sqlc generate` 顺利通过,这句 SQL 在语法和类型上就 100% 是正确的**。

---

## 零抽象税:拥抱最快的 `pgx`

在 Go 语言中访问 PostgreSQL,`jackc/pgx` 是毋庸置疑的性能天花板:

* 它支持 PostgreSQL 原生 Binary 二进制传输格式(比基于文本的 `lib/pq` 快得多,内存占用极低)。
* 内置连接池(`pgxpool`),并发性能极其强悍。
* 深度支持 Postgres 的高级功能(批量 `CopyFrom`、`Listen`/`Notify`、复合类型等)。

如果在 GORM 里面用 pgx,你还得套一个 `gorm.io/driver/postgres` 适配层。GORM 必须为了兼容 MySQL、SQLite 等引擎,把它抹平成通用的 `database/sql` 行为,还要在上面套一层 Hook 和 Plugin 机制。
而 `sqlc` 是直接为 `pgx/v5` 生成原生代码的:

```text
调用链对比:

GORM:
业务代码 -> GORM API -> 反射分析结构体 -> 构建 AST -> 执行 SQL -> database/sql 驱动桥接 -> pgx -> Postgres

sqlc:
业务代码 -> 生成的函数 (直接调用 q.db.Query) -> pgx/v5 二进制传输 -> Postgres
```

省掉了中间 5、6 层的抽象开销和对象分配。在高并发接口下,你的 CPU 火焰图干干净净,再也看不到大片由 `reflect.Value.Interface`、`reflect.typedmemmove` 造成的 GC 尖刺。

---

## 拓展支持更好

现在大家做 AI 开发、Agent 架构,向量检索(`pgvector`)、全文检索(`tsvector`)、地理信息(`PostGIS`)是家常便饭。

在传统的 ORM 里面搞这些简直是受罪:

* ORM 根本不认识 `<=>`(余弦距离)或者 `<->`(L2 距离)这种操作符。
* 向量的 `[]float32` 在模型结构体里映射异常别扭,你得实现 `sql.Scanner` 和 `driver.Valuer` 接口,甚至还要处理空值。
* 如果想要用 Postgres 的复杂特性,比如 CTE(公共表表达式)、窗口函数 `ROW_NUMBER() OVER (...)`,ORM 的链式语法直接歇菜,逼得你只能去写前面批判过的 `db.Raw()`。

而在 `sqlc` 面前,这套问题压根不存在:**因为只要 PostgreSQL 本身支持的语法,`sqlc` 就全部支持**。

你只需要在 `sqlc.yaml` 里告诉它,数据库的 `vector` 类型对应哪个 Go 包的哪个结构体:

```yaml
overrides:
  - db_type: "vector"
    go_type: "github.com/pgvector/pgvector-go.Vector"
```

你就可以在 SQL 里面肆无忌惮地写向量计算、写 CTE、写窗口函数、写复杂的 JSONB 提取表达式 `metadata->>'source'`。生成的 Go 方法自然会接收正确的参数,并返回正确的强类型字段。

数据库出了新功能、新插件,你当天就能直接用上,完全不需要等某个 ORM 框架作者发新版本去"支持"它。

---

## 与 `Vibe Coding` 完美契合 

到了现在这个时代,我们写代码的方式已经变成了 **Vibe Coding** -- 我们负责梳理业务与设计,Agent 负责写实现。

选型库的时候,必须考虑一个至关重要的问题:**大模型到底最擅长什么?**

> 大模型写纯 `SQL` 的能力,远超它写某个 `ORM` 框架语法的能力

全人类几十年来沉淀在互联网上的 SQL 代码量,比某个具体 ORM(比如 GORM v2)的代码量多了几个数量级。

你让 Agent 用 GORM 写一个复杂的关联更新带条件排查,它经常会产生幻觉:

* 字段名写错
* 关联预加载(Preload)条件放错了位置
* 搞不清哪些零值会被忽略更新,必须手动加 `.Select("*")`

但如果你让 Agent 写一段标准 SQL,它甚至能一口气写出性能极佳的 CTE 递归查询。**让 Agent 发挥它最擅长的技能,不要用 ORM 的私有黑魔法去折磨它。**

> 下文极度**节约**,零心智负担

当 Agent 接手一个基于 `sqlc` 的项目时,它怎么理解你的数据层?

它不需要把几千行的 Go 模型、`Hooks`、`Plugin` 全部读进 Context 里。它只需要阅读两个文件:

1. `schema.sql`:清楚地知道数据库有哪些表、字段、外键、约束。
2. `query.sql`:清楚地知道系统对外提供了哪些数据读写能力。

这就够了!没有隐藏在结构体标签里的生命周期回调,没有深层嵌套的实体映射。整个数据层对 Agent 来说就像白纸一样透明。

> 闭环极短的反馈回路

在 Vibe Coding 模式下,最理想的协作闭环是:**一旦出错,编译器能立刻给出极度精确的错误信息,引导 Agent 秒速自我修复**。

当 Agent 在开发一个新功能时:

1. 它在 `query.sql` 加上一段新业务 SQL。
2. 运行 `sqlc generate`。
3. 如果 SQL 里的列名写错了,或者表之间关联条件不匹配,`sqlc` 会直接喷出像 `query.sql:12:4: column "user_name" does not exist` 这样精确到行列的报错。
4. Agent 拿到这个错误,根本不需要人去介入,1 秒钟就能自动改好。
5. 生成出来的 `Queries` 接口(`Querier`)本身就是天然的依赖注入接口:

```go
type Querier interface {
	SearchDocumentChunks(ctx context.Context, arg SearchDocumentChunksParams) ([]SearchDocumentChunksRow, error)
	// 其他方法...
}
```

Agent 在编写 `Service` 层的业务代码时,直接面向这个接口编程,单元测试时 mock 起来也是毫无阻力。

---

不用在 ORM 的泥潭里与反射和 `db.Raw` 搏斗了,让 SQL 回归 SQL,让 Go 回归 Go。
