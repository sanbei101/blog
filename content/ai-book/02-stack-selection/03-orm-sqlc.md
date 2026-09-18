---
title: 用 sqlc 替代 ORM
description: 编译期类型检查与零反射数据访问层的工程实践
weight: 30
---

在 Go 语言开发中,ORM 常常因为反射带来一定的性能与内存开销,但手写原生 SQL 又容易因为字符串拼接出现注入漏洞、字段变更难以静态感知、手写 `Scan` 繁琐等问题。是否存在一种方式,既能享受原生的执行性能,又能获得强类型约束的安全感?

在前文中提到过,在 Go 中可以采用 [`sqlc`](https://sqlc.dev/) 来组织数据访问层,它不仅能替代繁琐的持久层样板代码,也对模型的上下文维护更为友好。

> 能在编译期解决的问题,绝不留到运行期。
> 告别反射与抽象税,用纯 SQL 驱动类型安全的 Go 代码。

## 为什么我们要考虑把 ORM 换掉?

在传统的 Go 项目开发里,很多团队习惯直接引入 GORM,在处理简单的增删改查时确实省心:

```go
db.Where("status = ?", "active").Order("created_at desc").Find(&users)
```

但随着业务复杂度增加,这种抽象会暴露出一些隐患:

1. **反射造成的开销**:为了将数据库的二维结果集动态映射到结构体,底层依赖较多 `reflect` 调用,反复解析字段标签、执行内存搬运与类型断言。
2. **隐藏在字符串里的静态盲区**:表结构重命名字段后,代码中的 `"status = ?"` 字符串若未同步修改,编译器无法发出警告,直到运行时执行该代码才会暴露。
3. **沉重的抽象税**:ORM 在底层驱动之上包裹了中间件、插件与回调机制,为了兼顾不同数据库的方言,往往难以直接发挥底层驱动的原生高级特性。

在业务体量扩大、查询逻辑变得更加多维之后,这些问题会更加明显。

## 复杂的查询终成 `db.Raw()`

使用 ORM 的项目,随着业务深化往往会遇到同一个瓶颈:**只要业务逻辑涉及多表聚合或深层联表,ORM 的链式 API 就会变得非常繁琐**。

假设实现一个常见的管理统计需求:统计某个租户下,近 30 天内每个用户的订单总额、平均客单价,并联表筛选出满足最低消费额的活跃用户。

在 GORM 中,若强行使用链式语法,通常需要写成如下形式:

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

这种写法存在几个明显的弊端:
1. **字段与表达式全在字符串中硬编码**:缺乏语法高亮与编译期检查;
2. **重构安全性较弱**:若 `orders.amount` 改名为 `orders.total_price`,编译器无法提供引用警告;
3. **链式调用语义容易产生歧义**:例如 `Group` 与 `Select` 字段的对齐顺序,或带 `Joins` 时分页 `Count` 的推导容易偏离预期。

因此,很多团队在面对这类查询时,最终选择直接使用 `db.Raw()`:

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

当业务查询不得不回退到 `db.Raw()` 时,原本引入 ORM 的优势便被大幅削弱:
* **静态类型检查缺失**:SQL 语法错误或问号占位符数量错配只能在运行时暴露;
* **静默赋值风险**:若结构体 Tag 中的字段名手抖拼写错误,部分框架在 `.Scan()` 时不会报错,而是直接赋予该字段零值;
* **依旧存在反射开销**:手写了纯 SQL,但在映射至 Go 结构体时依然要经过运行时的动态反射处理。

既然复杂查询终究需要编写 SQL,更合理的思路是:**以 SQL 作为第一公民,让工具在编译阶段直接生成强类型的 Go 代码。**

这就是 `sqlc` 的核心切入点。

同样是上述统计需求,在 `sqlc` 的工作流中,只需要将该条 SQL 写入 `query.sql` 并赋予函数名:

```sql
-- name: GetUserOrderStats :many
SELECT
    u.id AS user_id,
    u.username,
    COALESCE(SUM(o.amount), 0) AS total_amount,
    COALESCE(AVG(o.amount), 0) AS avg_amount
FROM users u
LEFT JOIN orders o ON o.user_id = u.id AND o.created_at >= sqlc.arg('thirty_days_ago')
WHERE u.tenant_id = sqlc.arg('tenant_id') AND u.status = sqlc.arg('status')
GROUP BY u.id, u.username
HAVING SUM(o.amount) > sqlc.arg('min_total_amount')
ORDER BY total_amount DESC
LIMIT 10;
```

执行 `sqlc generate` 后,工具自动产出类型精确的参数与结果结构体:

```go
type GetUserOrderStatsParams struct {
    ThirtyDaysAgo  pgtype.Timestamptz `json:"thirty_days_ago"`
    TenantID       string             `json:"tenant_id"`
    Status         string             `json:"status"`
    MinTotalAmount float64            `json:"min_total_amount"`
}

type GetUserOrderStatsRow struct {
    UserID      int64   `json:"user_id"`
    Username    string  `json:"username"`
    TotalAmount float64 `json:"total_amount"`
    AvgAmount   float64 `json:"avg_amount"`
}
```

在服务层调用时:

```go
rows, err := s.q.GetUserOrderStats(ctx, db.GetUserOrderStatsParams{
    ThirtyDaysAgo:  pgtype.Timestamptz{Time: thirtyDaysAgo, Valid: true},
    TenantID:       tenantID,
    Status:         "active",
    MinTotalAmount: minTotalAmount,
})
```

对比前面的痛点:
* **重构安全性大幅提升**:表结构中字段重命名后,`sqlc generate` 校验 `schema.sql` 时能精确定位到行列报错;
* **消除 Scan 静默赋值**:结构体字段由查询列精确对应产出,避免列名映射偏差;
* **参数意图显式化**:位置参数被收敛为具名结构体,调用处传参清晰明了。

---

## `sqlc` 的设计哲学:SQL 是第一公民

`sqlc` 的核心理念是:**SQL 是源文件,Go 代码只是它的编译构建产物**。

开发工作流保持三步:
1. 维护数据库建表语句文件(`schema.sql`);
2. 维护业务 SQL 语句文件(`query.sql`,可按业务模块拆分);
3. 执行命令行工具:`sqlc generate`。

`sqlc` 在本地直接调用真实的数据库 AST 解析器,把 SQL 解析完成,自动生成基于 `pgx/v5` 或标准库的**零反射、强类型** Go 代码。

---

## 实战:AI 知识库切片检索场景

以一个包含租户隔离、JSONB 元数据过滤与向量相似度检索的真实场景为例,验证这套方案在现代数据库扩展特性下的表现。

### 1. 定义 DDL (`schema.sql`)

在数据库中建两张表,启用 PostgreSQL 的 `vector` 扩展支持:

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

### 2. 编写业务 SQL (`query.sql`)

针对 RAG 检索场景:给入租户标识、检索向量、相似度阈值以及限制条数,联表查出切片内容、文档标题和计算后的余弦相似度:

```sql
-- name: SearchDocumentChunks :many
SELECT
    c.id AS chunk_id,
    c.document_id,
    d.title AS document_title,
    c.content,
    c.metadata,
    1 - (c.embedding <=> sqlc.arg('embedding')) AS similarity_score
FROM document_chunks c
INNER JOIN documents d ON d.id = c.document_id
WHERE c.tenant_id = sqlc.arg('tenant_id')
  AND d.status = 'published'
  AND (1 - (c.embedding <=> sqlc.arg('embedding'))) >= sqlc.arg('min_similarity')
ORDER BY similarity_score DESC
LIMIT sqlc.arg('result_limit');
```

这里使用 `sqlc.arg(...)` 具名参数,即便同一个 `embedding` 在 SQL 表达式中出现两次,生成的结构体也只包含一个 `Embedding` 字段。

### 3. 配置与生成 (`sqlc.yaml`)

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

执行 `sqlc generate`,自动产出底层数据访问代码:

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
    1 - (c.embedding <=> sqlc.arg('embedding')) AS similarity_score
FROM document_chunks c
INNER JOIN documents d ON d.id = c.document_id
WHERE c.tenant_id = sqlc.arg('tenant_id')
  AND d.status = 'published'
  AND (1 - (c.embedding <=> sqlc.arg('embedding'))) >= sqlc.arg('min_similarity')
ORDER BY similarity_score DESC
LIMIT sqlc.arg('result_limit')
`

type SearchDocumentChunksParams struct {
	Embedding     pgvector.Vector `json:"embedding"`
	TenantID      string          `json:"tenant_id"`
	MinSimilarity float64         `json:"min_similarity"`
	ResultLimit   int32           `json:"result_limit"`
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
		arg.MinSimilarity,
		arg.ResultLimit,
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

其结构特点十分直观:
1. 入参和出参均为明确的强类型结构体;
2. 赋值通过 `rows.Scan` 精准对应目标指针,无运行时反射开销;
3. 只依赖原生的 `pgx/v5` 驱动。

---

## 静态检查与快速排错

在 ORM 体系中,SQL 语法或拼接错误往往只能在运行时捕获。而在 `sqlc` 体系下,`sqlc` 内嵌了数据库语法解析内核,SQL 语句同样享有静态类型检查:

### 字段拼写错误
若在 `query.sql` 中将 `d.title` 误写为 `d.titile`:

```text
$ sqlc generate
query.sql:6:5: column "titile" does not exist in table "documents"
```
工具直接精确定位到行号与列号。

### 类型不匹配
若在 SQL 比较中给 `token_count` 传入了不兼容的类型:

```text
$ sqlc generate
query.sql:10:11: operator does not exist: integer = text
```
在编译构建阶段即可提前拦截类型错误。

---

## 零抽象税:发挥底层驱动的高性能

在 Go 语言中访问 PostgreSQL,`jackc/pgx` 具备突出的性能表现:
* 支持 PostgreSQL 原生二进制数据传输格式,内存开销低;
* 内置高效的连接池(`pgxpool`);
* 原生支持批量写入 `CopyFrom`、`Listen`/`Notify` 等高级特性。

传统 ORM 使用 `pgx` 时,通常需要经过通用驱动桥接层以及自身的中间件拦截,而 `sqlc` 直接生成针对 `pgx/v5` 的原生调用:

```text
调用链路对比:

ORM 方案:
业务服务 -> ORM API -> 结构体反射分析 -> 构建 AST -> 执行 SQL -> database/sql 驱动适配 -> pgx -> 数据库

sqlc 方案:
业务服务 -> 生成的类型函数 -> pgx/v5 二进制调用 -> 数据库
```

减少了中间抽象层与对象分配,使性能分析火焰图保持整洁,减少由反射映射引起的 GC 停顿。

---

## 原生支持复杂数据库扩展

在现代应用中,向量检索(`pgvector`)、全文检索(`tsvector`)与公共表表达式 CTE 已是常见需求。

传统 ORM 对 `<=>`(余弦距离)等专用操作符的支持相对繁琐,复杂的向量类型映射和窗口函数常常需要绕道执行。而在 `sqlc` 体系中,只要 PostgreSQL 原生支持的语法,均可在 `query.sql` 中直接编写。配合 `sqlc.yaml` 中的类型映射规则,自动生成的 Go 函数即可接收与返回正确的强类型参数。

---

## 与 Vibe Coding 协同模式的高度契合

在人机协同开发中,一个关键考量是:**大模型在不同抽象层级上的生成能力存在差异**。

### 1. 语料规模与生成精度的天然优势
在开源世界中,标准 SQL 的语料储备远大于任何单一 ORM 框架的代码量。

当要求模型使用特定 ORM 编写复杂的多表条件更新或深层关联时,模型容易在预加载层级、零值更新忽略机制等框架特有约定上产生理解偏差;而面对标准 SQL 时,模型通常能稳定输出高质量的结构化查询与递归 CTE。

### 2. 上下文消耗的精简
模型在理解基于 `sqlc` 的数据层时,只需要阅读两个无状态文件:
1. `schema.sql`:掌握数据表结构、外键与约束;
2. `query.sql`:掌握系统对外暴露的数据访问接口。

无需向会话注入数千行带有框架生命周期 Hook 与混合 Tag 的业务实体定义,显著降低了上下文占用。

### 3. 短闭环的编译期反馈
在自动化开发流程中,最理想的状态是**错误在编译期被精确捕获并提供明确坐标**。

当模型在 `query.sql` 中新增一条 SQL 并运行 `sqlc generate` 时,若字段名有误,工具会输出具体报错:
```text
query.sql:12:4: column "user_name" does not exist in table "users"
```
模型依据此反馈可在单轮迭代中快速修正。

生成的 `Querier` 接口为服务层提供了统一的抽象标准:

```go
type Querier interface {
	SearchDocumentChunks(ctx context.Context, arg SearchDocumentChunksParams) ([]SearchDocumentChunksRow, error)
	GetUserOrderStats(ctx context.Context, arg GetUserOrderStatsParams) ([]GetUserOrderStatsRow, error)
}
```

服务层面向该接口编程,在单元测试中可以通过简单的实现进行隔离测试,保持了架构的清晰与解耦。
