---
title: 选几个优质的第三方库
description: 无依赖库能让 Agent 少走一点弯路
weight: 20
---

上一节一直在强调标准库,搞得好像第三方库都是洪水猛兽一样

> 当然不是。

标准库能解决大部分问题,但是并不代表所有问题都值得我们自己实现。比如日志、参数校验、JWT 这些功能,标准库要么没有,要么需要自己补很多代码。这个时候找一个成熟、简单、无依赖的第三方库,反而比我们自己手搓一份更加靠谱。

我这里说的"无依赖",指的是这个库本身不再依赖一大串其他第三方库,而不是说项目的 `go.mod` 里面从此一个 `require` 都没有。

我目前比较喜欢下面几个库:

1. `phuslu/log`代替 `zap`、`slog`
2. `go-argus`代替 `validator`
3. `cristalhq/jwt`代替 `golang-jwt/jwt`
4. `chi`代替 `gin`

它们的共同特点是:API 比较直白,核心代码比较容易读,而且不会为了实现一个小功能把整个生态搬进项目里。

## 日志: `phuslu/log` 代替 `zap`、`slog`

先说日志。

`log`、`slog`、`zap`、`zerolog` 这些名字我相信大家都听说过。它们都能打印日志,都能输出 JSON,也都能传一些结构化字段。
那么为什么我会选择 [`phuslu/log`](https://github.com/phuslu/log) 呢?

大家可以先去看看这个库的中文 `README` (英文README很正经): [phuslu/log 中文 README](https://github.com/phuslu/log/blob/master/README_zh.md), 我觉得写的很好, 在此再做一些例子的说明

1. **无依赖**

让我们先看看最出名的日志库`zap`的 [`go.mod`](https://github.com/uber-go/zap/blob/master/go.mod)

```
require (
	github.com/stretchr/testify v1.12.1 <- 为了方便测试引入了一个assert库,还算能理解,但我感觉 t.Fatalf 也很好用
	go.uber.org/goleak v1.3.0 <- 也是一个测试库,用于检测 goroutine 泄漏,可使用标准库中 synctest 替代
	go.uber.org/multierr v1.10.0 <- err 聚合,可以使用标准库中 errors.Join 替代
	go.yaml.in/yaml/v3 v3.0.5 <- 纯纯不理解,为什么打个日志还要引入一个yaml解析库,我自己要想做配置自己会搞呀,你越界了!
)
```

当我们只是想要打个日志,我们会惊奇的发现,竟然引入了 `4` 个没有其他作用的间接依赖,有些是为了兼容老版本还没有跟进`go`的最新特性,有些是为了满足个别用户的小众需求

这还不止,为了要让日志文件自动轮转,还需要引入额外的库 (而`phuslu/log`什么都不需要)

这也就是为什么上一节为什么说要尽可能挑那些字依赖少的库了,不仅会让我们的`go.mod`变得很臃肿,也会让打包的二进制文件变大,还会让`Agent`增加理解负担

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
每个字段的类型都直接写在了方法名上,`Int` 就是整数,`Str` 就是字符串,`Bool` 就是布尔值, `Err` 就是错误, 语法十分的精炼

我个人还觉得有一点做得很好: 默认即最优,也不用去创建一个`logger`对象,这也就是说,不管是`handler`,`service`,我们不需要也不推荐在参数中加入一个`logger *logger.Logger`,
直接使用全局的就好了 (一个日志还传来传去干啥,难道日志在不同的方法还会有配置变化的需求吗?)

ps: 这个库也是主播少有的在关键能力上用第三方库替换标准库的选择:

标准库`slog`虽然在`go`官方几经优化之后已经好了不少,但是他还是缺乏类型,文件写入等功能

```go
这种键值对的方式总感觉没有上面的链式要来的直观,而且也缺少了类型
slog.Info("user created", "user_id", userID, "action", "create")
```

## 参数校验: `go-argus` 代替 `validator`

参数校验往往是 `http` 请求体进入服务端的第一步,非常的关键,如果没有这个,一些乱七八糟的用户输入就会进入服务端,在业务层就需要做很多 `fallback` 处理(这也是很多 `AI` 最喜欢做的,会平添很多的无用代码,下章再细讲),更有甚一些非法值会触发致命的 `panic` 崩溃,所以这里一定要做好拦截

```go
type CreateUserRequest struct {
    Name  string `json:"name" validate:"required,min=2,max=50"`
    Email string `json:"email" validate:"required,email"`
    Age   int    `json:"age" validate:"gte=0,lte=150"`
}
```

`go-playground/validator` 是大家用的最广泛的一个参数校验库,但他也有一些缺点:

+ 有些无关依赖,上文已经对日志库的无关依赖做出了点评,大家可以使用ai分析一下这个库又有哪些无关的依赖

+ 对校验错误返回的 message 支持的不好,还需要引入一个翻译器,写出来的代码丑丑的,大致如下:

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

我选择的替代库是 [go-argus](https://github.com/kamalyes/go-argus) 个人认为可能是因为这个名字不怎么直观没多少人知道他,建议作者可以改个名字

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

对 `Agent` 来说,这条链路非常清楚:结构体标签定义规则,`Struct` 执行规则,`TranslateValidationErrors` 负责展示, 又学到了一个好用的库啦!

## JWT: `cristalhq/jwt` 代替 `golang-jwt/jwt`

`jwt` 是派发用户签名的核心功能,几乎必备这个类型的库

`golang-jwt/jwt` 是大家用的最广泛的一个 `JWT` 库,他本身也没有什么依赖问题,但是他的 API 对 `Agent` 来说不算特别友好(对我也不友好,刚看文档的时候看了好一会才明白这个回调是在干什么):

+ `Claims` 可以直接使用 `MapClaims`,所有字段都变成了 `map[string]any`,类型需要自己断言
+ 解析 Token、验签和校验 Claims 都挤在回调里面,代码风格很丑陋

```go
token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
    "user_id": userID,
    "role":    "admin",
    "exp":     time.Now().Add(24 * time.Hour).Unix(),
})

raw, err := token.SignedString(secret)
```

解析时再从 `map[string]any` 里面把字段取出来:

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

我选择的替代库是 [cristalhq/jwt](https://github.com/cristalhq/jwt),他把这几个动作拆得很清楚:

1. `Signer` 负责签名
2. `Verifier` 负责验签
3. `Builder` 负责构造 Token
4. `ParseClaims` 负责解析并验证签名

以 HMAC 为例,我们可以直接把业务中的 Claims 定义成结构体:

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

解析的时候,验签和解析 Claims 也摆在明面上:

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

我觉得这个库做得最好的地方就是:他没有把所有事情都塞进一个万能的 `Token` 里,而是把签名和验签拆开了。`Agent` 看到 `NewVerifierHS(jwt.HS256, secret)` 就知道这里固定使用 `HS256` 和这个密钥验签,再也不用写丑陋的 `func(token *jwt.Token) (any, error)` 的回调啦

又学到了一个好用的库啦!

## HTTP 路由: `chi` 代替 `gin`

最后是 Web 框架。

`gin` 是大家使用非常广泛的 Web 框架,他的路由、中间件、参数绑定、JSON 返回值都给你封装好了,用起来确实很爽,但是他也有一些缺点:

+ 依赖实在太多,一个 HTTP 框架的 `go.mod` 里面出现了 `mongo-driver`、`quic-go`、`protobuf` 这种和普通 HTTP 路由关系不大的依赖
+ 自带了参数绑定、JSON 序列化、表单处理等一大堆功能,为了省几行代码,把很多自己的抽象和依赖带进了项目
+ 使用 `gin.Context` 贯穿整个请求生命周期,Handler、中间件、参数绑定、返回 JSON 全部是 Gin 自己的 API,和标准库的 `http.Handler` 不是一套东西

```
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

由此看来 0 依赖的 `chi` 包既能让我们享受到框架库的便携性,也能在关键性能处插入我们基于最新`go`版本的高性能实现,更关键的是`Agent`看到的是没有任何黑魔法的函数性编程,开发排错能力upup!
