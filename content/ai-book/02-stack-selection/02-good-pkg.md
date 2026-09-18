---
title: 选几个优质的第三方库
description: 无依赖库能让 Agent 少走一点弯路
weight: 20
---

上一节强调了标准库的价值,但这并不意味着第三方库应当被一概排斥。

标准库能够覆盖大多数通用场景,但在日志记录、复杂参数校验、JWT 签发与验证等领域,标准库要么缺少开箱即用的支持,要么需要自行编写较多胶水代码。此时选择成熟、单一职责且无额外传递依赖的第三方库,往往比手工维护一套脚手架更加稳健。

这里所说的"无依赖",指的是该库本身不再依赖庞大的第三方依赖树,保持自身实现的纯粹。在实际项目中,我较为常用的几个轻量库包括:

1. `phuslu/log` 代替 `zap`、`slog`
2. `go-argus` 代替 `validator`
3. `cristalhq/jwt` 代替 `golang-jwt/jwt`
4. `chi` 代替 `gin`

它们的共同特征是:API 显式直接,源码结构清晰易读,且不会为了单一功能将庞大的生态引入项目。

## 日志:`phuslu/log` 代替 `zap`、`slog`

在日志选型上,`log`、`slog`、`zap`、`zerolog` 均能输出带结构化字段的 JSON 日志。我倾向于使用 [`phuslu/log`](https://github.com/phuslu/log),其设计考量主要有两点:

1. **零第三方依赖**

查看知名日志库 `zap` 的 [`go.mod`](https://github.com/uber-go/zap/blob/master/go.mod):

```text
require (
	github.com/stretchr/testify v1.12.1 // 测试断言库
	go.uber.org/goleak v1.3.0          // Goroutine 泄露检测
	go.uber.org/multierr v1.10.0       // 错误聚合
	go.yaml.in/yaml/v3 v3.0.5          // YAML 解析库
)
```

作为一个基础日志组件,间接引入了 4 个非核心运行时的依赖项,且日志文件自动轮转切分通常还需要额外引入外部滚动组件。

这正是优先选择无额外依赖库的原因:不仅保持 `go.mod` 与二进制产物的精简,也能显著降低模型在分析项目依赖树时的检索噪音。`phuslu/log` 保持了零第三方依赖,且内置了日志文件的滚动切分与压缩支持。

2. **语法简单,开箱即用**

```go
func main() {
    userID := 1001
    err := errors.New("this is an error")
    log.Info().
        Int("user_id", userID).
        Str("action", "create").
        Msg("user created")
    log.Error().
        Err(err).
        Int("user_id", userID).
        Msg("create user failed")
}
```
每个字段的类型都直接体现在方法名上:`Int` 即整型,`Str` 即字符串,`Bool` 即布尔值,`Err` 即错误对象,调用语法清晰无歧义。

另一个工程优势在于其默认实例的轻量化:开箱即用,大多数场景下无需在 `handler` 或 `service` 之间通过参数层层传递 `logger *log.Logger` 实例,直接调用全局 Logger 即可满足统一配置与格式化输出。

在核心基础能力上,这也是少数我倾向于用轻量三方库替换标准库的场景:标准库 `slog` 虽然在近几个 Go 版本中持续优化,但在方法链的强类型约束与开箱即用的文件滚动切分上,依然需要自行补充不少胶水代码:

```go
// slog 采用键值对参数,类型约束相对较弱
slog.Info("user created", "user_id", userID, "action", "create")
```

## 参数校验:`go-argus` 代替 `validator`

参数校验是 HTTP 请求进入服务端的第一道防线。缺少前置校验会导致非预期的空值或非法边界进入业务服务层,迫使业务层编写大量防御性判空代码,极端情况下非法输入还可能触发运行时的空指针异常。

```go
type CreateUserRequest struct {
    Name  string `json:"name" validate:"required,min=2,max=50"`
    Email string `json:"email" validate:"required,email"`
    Age   int    `json:"age" validate:"gte=0,lte=150"`
}
```

`go-playground/validator` 是业界广泛使用的校验库,但在轻量项目中主要存在两点不便:
1. 存在一些非必要的间接依赖;
2. 错误信息的本地化翻译相对繁琐,需要引入额外的翻译器并做运行时类型断言,代码样板较多:

```go
validate := validator.New()
uni := ut.New(translator, translator)
trans, _ := uni.GetTranslator("zh")

if err := validate.Struct(req); err != nil {
    validationErrors := err.(validator.ValidationErrors)
    for _, fieldErr := range validationErrors {
        message := fieldErr.Translate(trans)
        fmt.Println(message)
    }
}
```

我选择的轻量替代方案是 [go-argus](https://github.com/kamalyes/go-argus):

```go
import validator "github.com/kamalyes/go-argus"

var validate = validator.New()

func validateCreateUserRequest(req CreateUserRequest) error {
    return validate.Struct(req)
}
```

它还提供了很多常用规则,包括 `required`、`email`、`uuid`、`ip`、`url`、`datetime` 等。对字符串单值校验时,还可以使用 `VarString`:

```go
if err := validate.VarString(email, "required,email"); err != nil {
    return fmt.Errorf("invalid email: %w", err)
}
```

这个接口不需要把字符串先装进 `any` 再走反射,对于大量简单字段校验来说会更直接。

`go-argus` 自带多语言翻译,可以直接把校验结果转成结构化消息:

```go
if err := validate.Struct(req); err != nil {
    messages := validator.TranslateValidationErrors(err, "zh")
    for _, message := range messages {
        log.Info().
            Str("field", message.Field).
            Str("message", message.Message).
            Msg("request validation failed")
    }
}
```

可以完美的和我们之前的`render`包进行适配:

```go
func ReadBody[T any](w http.ResponseWriter, r *http.Request) (T, error) {
	var body T
	if r.ContentLength == 0 {
		return body, nil
	}
	if err := json.UnmarshalRead(r.Body, &body); err != nil {
		if optional && errors.Is(err, io.EOF) {
			return body, nil
		}
		log.Error().Err(err).Msg("Failed to read/decode request body")
		Error(w, http.StatusBadRequest, "JSON 格式非法")
		return body, err
	}
	if err := validate.Struct(body); err != nil {
		errs := validator.TranslateValidationErrors(err, "zh")
		errorMsgs := make([]string, 0, len(errs))
		for i := range errs {
			errorMsgs = append(errorMsgs, errs[i].Field+": "+errs[i].Message)
		}
		fullErrorMsg := strings.Join(errorMsgs, "; ")
		Error(w, http.StatusBadRequest, fullErrorMsg)
		return body, err
	}
	return body, nil
}
```
这样一来,我们就在反序列化前端传递的 `request` 时顺便进行了错误处理,并且能返回给前端极其清晰的 `err message`:
```go
邮箱格式非法; 年龄不能大于150
```

对模型而言,这条调用链十分清晰:结构体标签定义规则,`Struct` 执行校验,`TranslateValidationErrors` 负责格式化输出,整套流程完全由强类型与明确函数驱动。

## JWT:`cristalhq/jwt` 代替 `golang-jwt/jwt`

JWT 是无状态认证与签名签发的核心组件。

`golang-jwt/jwt` 是社区广泛使用的库,但其接口设计在类型安全与可读性上有一定折衷:
1. 声明默认使用 `MapClaims`,内部数据为 `map[string]any`,提取字段时需要反复手动执行类型断言;
2. 解析 Token、验签密钥与校验 Claims 耦合在回调函数内部:

```go
token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
    "user_id": userID,
    "role":    "admin",
    "exp":     time.Now().Add(24 * time.Hour).Unix(),
})

raw, err := token.SignedString(secret)
```

解析时需再次断言:

```go
token, err := jwt.ParseWithClaims(raw, jwt.MapClaims{}, func(token *jwt.Token) (any, error) {
    return secret, nil
})
if err != nil {
    return err
}

claims := token.Claims.(jwt.MapClaims)
userID, ok := claims["user_id"].(string)
if !ok {
    return errors.New("invalid user_id")
}
```

我选择的替代库是 [cristalhq/jwt](https://github.com/cristalhq/jwt),其核心设计将职责拆分得非常清晰:
1. `Signer`:明确指定的签名算法与私钥;
2. `Verifier`:明确指定的验签算法与公钥;
3. `Builder`:负责构造 Token 字符串;
4. `ParseClaims`:将校验通过的数据直接反序列化至具体业务结构体。

以 HMAC-SHA256 为例,可以直接将业务 Claims 定义为强类型结构体:

```go
type UserClaims struct {
    jwt.RegisteredClaims
    Role string `json:"role"`
}

func issueToken(userID, role string, secret []byte) (string, error) {
    signer, err := jwt.NewSignerHS(jwt.HS256, secret)
    if err != nil {
        return "", fmt.Errorf("create jwt signer failed: %w", err)
    }
    builder := jwt.NewBuilder(signer)
    token, err := builder.Build(&UserClaims{
        RegisteredClaims: jwt.RegisteredClaims{
            Subject:   userID,
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
        },
        Role: role,
    })
    if err != nil {
        return "", fmt.Errorf("build jwt failed: %w", err)
    }
    return token.String(), nil
}
```

解析时,验签与字段解构同样摆在明面上:

```go
func parseToken(raw string, secret []byte) (UserClaims, error) {
    verifier, err := jwt.NewVerifierHS(jwt.HS256, secret)
    if err != nil {
        return UserClaims{}, fmt.Errorf("create jwt verifier failed: %w", err)
    }

    var claims UserClaims
    if err := jwt.ParseClaims([]byte(raw), verifier, &claims); err != nil {
        return UserClaims{}, fmt.Errorf("parse jwt failed: %w", err)
    }
    if !claims.IsValidAt(time.Now()) {
        return UserClaims{}, errors.New("jwt is expired or not active")
    }
    return claims, nil
}
```

该库最大的优势在于签名与验签职责分离,模型看到 `NewVerifierHS(jwt.HS256, secret)` 即可明确算法与密钥,避免了不透明的类型断言与回调函数。

## HTTP 路由:`chi` 代替 `gin`

最后是 Web 路由框架。

`gin` 作为老牌框架封装了丰富的中间件、参数绑定与统一响应,但其依赖树相对庞大:
1. 包含较多与基础 HTTP 路由无关的三方依赖,例如在 `go.mod` 中引入了 MongoDB 驱动、QUIC 协议与 Protobuf 依赖:

```text
require (
    github.com/bytedance/sonic
    github.com/go-playground/validator/v10
    github.com/goccy/go-json
    github.com/goccy/go-yaml
    github.com/json-iterator/go
    github.com/quic-go/quic-go
    go.mongodb.org/mongo-driver/v2
    google.golang.org/protobuf
)
```

这个依赖数量对于一个 Web 框架来说确实有点夸张了,而且很多功能其实我并不需要。比如我只是想注册两个 HTTP 路由,结果还要顺便把各种 JSON、YAML、校验器、QUIC、MongoDB 相关的代码带进来。

再看一下 Gin 的日常用法:

```go
router := gin.Default()
router.POST("/users", func(ctx *gin.Context) {
    var req CreateUserRequest
    if err := ctx.ShouldBindJSON(&req); err != nil {
        ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }
    ctx.JSON(http.StatusOK, gin.H{"name": req.Name})
})
```

看起来非常爽,但是这里从头到尾都是 Gin 自己的世界:

+ 路由器是 `*gin.Engine`
+ 处理器参数是 `*gin.Context`
+ 参数绑定使用 `ShouldBindJSON`
+ 返回 JSON 使用 `ctx.JSON`
+ 中间件也需要适配 `gin.HandlerFunc`

我选择的替代库是 [chi](https://github.com/go-chi/chi),他的核心特点就是:他本身几乎就是 `net/http` 的增强版,而且没有额外的第三方依赖。

```go
router := chi.NewRouter()
router.Route("/users", func(router chi.Router) {
    router.Get("/{id}", getUser)
    router.Post("/", createUser)
})
server := &http.Server{
    Addr:    ":8080",
    Handler: router,
}
```

Handler 仍然是标准库的样子:

```go
func getUser(w http.ResponseWriter, r *http.Request) {
    userID := chi.URLParam(r, "id")
    response := map[string]string{"user_id": userID}
    # 使用上节提到的高性能 render 函数
    render.Success(w, http.StatusOK, "success", response)
}
```

`chi` 的中间件也是标准库的 `func(http.Handler) http.Handler`,路由器自己还是一个 `http.Handler`,所以原本的标准库代码可以直接拿过来用。

这件事在需要优化性能时尤其重要。上一节我们自己写的 `render` 包,接收的就是标准库的 `http.ResponseWriter` 和 `*http.Request`,所以可以直接放进 `chi` 的 Handler 里:

```go
import validator "github.com/kamalyes/go-argus"

var validate = validator.New()

func createUser(w http.ResponseWriter, r *http.Request) {
    req, err := render.ReadBody[CreateUserRequest](w, r)
    if err != nil {
        return
    }
    if err := validate.Struct(req); err != nil {
        render.Error(w, http.StatusBadRequest, "请求参数校验失败")
        return
    }
    render.Success(w, http.StatusCreated, "创建成功", map[string]string{
        "name": req.Name,
    })
}
```

零第三方依赖的 `chi` 既提供了路由分组与中间件的便利,又完整兼容标准库的 `http.Handler` 接口,使我们在前文实现的高性能渲染工具能够直接复用。没有框架特有的黑魔法,模型面对的是完全透明的函数组合,排查与修改的确定性显著提升。
