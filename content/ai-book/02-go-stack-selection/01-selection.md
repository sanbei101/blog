---
title: 能用标准库就别引入依赖
description: 我的 Go 技术栈选型原则
weight: 10
---

`Go`的标准库很强大, 90%的场景都可以直接使用标准库写出完备优质的代码

> 能用标准库就用标准库。
> 标准库实现起来较为麻烦,能用无依赖的库就用无依赖的库。

## 为什么要使用标准库?

这不是因为我对第三方库有什么偏见,也不是觉得自己写的代码一定比别人写的库更好。主要是因为现在写代码的人不只有我,还有一个每天都要阅读这些代码的 `Agent`。

## 依赖越多,Agent 越容易迷路

古法编程的时候,引入一个库的成本主要是下载一下,然后照着文档调用。只要这个库足够稳定,大家一般不会太关心它背后又依赖了什么。

但到了 AI Coding 时代,事情稍微变得有些不一样。

当我让 `Agent` 接手一个项目时,它不仅要理解我的业务代码,还要理解项目里面引入的各种框架、插件和中间件。一个看起来只有几行的函数,背后可能套着一整个生态:

```text
handler
  -> service
    -> orm
      -> plugin
        -> callback
          -> magic
```

人类程序员可能已经用惯了这套东西,知道某个配置放在哪里,知道某个方法什么时候会被调用。但 `Agent` 不一定知道。

它遇到不熟悉的库,通常只有两种选择:

1. 在当前上下文里猜一个看起来合理的用法
2. 调用 `grep`、读取源码、搜索文档,把上下文继续吃掉

猜错了,代码就会出问题。继续检索,上下文和时间就会开始燃烧。

所以我现在选择库的时候,除了看功能是否满足,还会额外看几个东西:

1. 这个功能标准库能不能完成
2. 这个库有没有传递依赖
3. 核心行为是不是能在几分钟内读懂
4. 出错时能不能直接从调用处看出原因
5. `Agent` 能不能根据函数签名和少量示例正确使用它

## HTTP: 先用 `net/http`

`Go`内置了一套很好用的

```go
mux := http.NewServeMux()

mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    w.Write([]byte("user: " + id))
})

server := &http.Server{
    Addr:    ":8080",
    Handler: mux,
}
```

这段代码没有任何隐藏的路由注册,也没有额外的上下文对象。`Agent` 从上到下读一遍,就能知道请求从哪里进来,路径参数从哪里取出来,最后交给谁处理。

如果项目只有十几个接口,标准库完全够用。等到项目真的需要比较复杂的路由分组,再考虑引入 `chi` 这种本身很轻量、没有传递依赖的路由库。

## JSON: `encoding/json/v2`

在 Go 过去的历史里,很多人对标准库的 `encoding/json` 颇有微词,主要嫌弃它底层依赖反射、性能不够极致、结构体零值处理(omitempty)不够优雅。

于是各种第三方库野蛮生长:`json-iterator`、`sonic`, 但是这一切都在`v2`版本中得到了改善


### 去除内存分配

在 v2 的设计中,官方提供了两个关键的高性能核心函数:
```
json.UnmarshalRead(io.Reader, any)
json.MarshalWrite(io.Writer, any)
```

这两个函数的核心精髓就在于:直接对接底层的 `IO` 流,省去了所有中间态 `[]byte` 的内存开辟
当请求进来时,`UnmarshalRead` 直接顺着 r.Body 的网络流边读边解码,不需要你在内存里开辟任何一个额外的 byte 切片去装整个 Body
当响应返回时,`MarshalWrite` 直接把序列化好的二进制流无缝冲进 http.ResponseWriter,连一个临时字节缓冲都不用申请

基于 `encoding/json/v2` 的这两个零拷贝特性,搭配 Go 的泛型,我们可以写出一个极简、对 Agent 极其友好的统一接入包
```go
package render

type BaseResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
}
type Response[T any] struct {
	BaseResponse
	Data T `json:"data"`
}
func Success[T any](w http.ResponseWriter, code int, msg string, data T) {
	writeJSON(w, code, Response[T]{
		Code: code,
		Msg:  msg,
		Data: data,
	})
}
func Error(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, BaseResponse{
		Code: code,
		Msg:  msg,
	})
}
func writeJSON[T any](w http.ResponseWriter, code int, response T) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if code == http.StatusNoContent {
		return
	}
	if err := json.MarshalWrite(w, response); err != nil {
		log.Error().Err(err).Msg("Failed to write response")
	}
}
func ReadBody[T any](w http.ResponseWriter, r *http.Request, optional bool) (T, error) {
	var body T
	if optional && r.ContentLength == 0 {
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
	return body, nil
}
```

这样一来,`Handler` 层的代码就可以非常简洁地处理请求了
```go
func (h *UserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
    req, err := render.ReadBody[CreateUserReq](w, r)
    if err != nil {
        return
    }
    user, err := h.userService.Create(r.Context(), req)
    if err != nil {
        render.Error(w, http.StatusInternalServerError, "创建用户失败")
        return
    }
    render.Success(w, "创建成功", user)
}
```

那么有人会问主播了,主播主播,这个东西是个web框架都带有呀,`gin`也有类似的`ShouldBindJSON`,你这不是重复造轮子吗?

有两个因素:
1. `gin`因为要考虑到历史兼容性,他不会去引入`go1.27`这种比较新的版本中才出现的新的标准库实现,也就是我们付出了所谓的`抽象税`
2. 我们没有办法他在的结构体(`c *gin.Context`)方法中去做拓展,这个下一节会讲到

### 绕过反射

在有些场景下,某些接口要求超高的`qps`,就连`marshal`,`unmarshal`这两个函数我们都想优化一下,这个时候怎么办呢? 在以往就需要引入上面说的一些第三方 `json` 库
但 `encoding/json/v2` + `jsonvalue/text` 给予了在关键节点直接手写超高性能序列化和反序列化的能力

```go
package main

import (
	"encoding/json/v2"
	"encoding/json/v2/jsontext"
	"fmt"
	"log"
)

type User struct {
	Username string  `json:"username"`
	Age      int     `json:"age"`
	Money    float64 `json:"money"`
}

func (u User) MarshalToJSON(enc *jsontext.Encoder) error {
	if err := enc.WriteToken(jsontext.BeginObject); err != nil {
		return err
	}
	if err := enc.WriteToken(jsontext.String("username")); err != nil {
		return err
	}
	if err := enc.WriteToken(jsontext.String(u.Username)); err != nil {
		return err
	}
	if err := enc.WriteToken(jsontext.String("age")); err != nil {
		return err
	}
	if err := enc.WriteToken(jsontext.Int(int64(u.Age))); err != nil {
		return err
	}
	if err := enc.WriteToken(jsontext.String("money")); err != nil {
		return err
	}
	if err := enc.WriteToken(jsontext.Float(u.Money)); err != nil {
		return err
	}
	return enc.WriteToken(jsontext.EndObject)
}

func (u *User) UnmarshalFromJSON(dec *jsontext.Decoder) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	if tok.Kind() != '{' {
		return fmt.Errorf("expected '{', got %v", tok.Kind())
	}
	for {
		tok, err := dec.ReadToken()
		if err != nil {
			return err
		}
		if tok.Kind() == '}' {
			break
		}
		key := tok.String()
		switch key {
		case "username":
			valTok, err := dec.ReadToken()
			if err != nil {
				return err
			}
			u.Username = valTok.String()
		case "age":
			valTok, err := dec.ReadToken()
			if err != nil {
				return err
			}
			u.Age = int(valTok.Int())
		case "money":
			valTok, err := dec.ReadToken()
			if err != nil {
				return err
			}
			u.Money = valTok.Float()
		default:
			if err := dec.SkipValue(); err != nil {
				return err
			}
		}
	}
	return nil
}
```
