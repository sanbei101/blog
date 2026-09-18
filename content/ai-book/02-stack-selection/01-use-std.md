---
title: 优先使用标准库的工程考量
description: 控制第三方传递依赖，降低代码理解与上下文维护成本
weight: 10
---

在 Go 语言中，标准库的设计完备度非常高，多数基础服务端场景均可直接基于标准库构建。

在结合模型开发代码时，选型原则通常遵循两条：
1. 能用标准库实现的功能，优先使用标准库；
2. 标准库缺少开箱即用支持的功能，优先选择零传递依赖、接口透明的三方库。

## 1. 为什么控制依赖层级？

引入第三方库的显性成本是引入依赖，而隐性成本是代码的认知与维护负担。

当模型接手一个工程时，除了业务逻辑本身，还必须理解框架内部的调度顺序、插件生命周期与上下文包装：

```text
handler
  └── service
        └── orm
              └── plugin
                    └── callback
                          └── runtime magic
```

在调用链路深且隐式约定较多的框架中，模型如果缺少特定版本的先验知识，通常只能采取两种策略：
1. 依据常见语法猜测调用方式，容易在隐式回调与默认配置上出现偏差；
2. 反复调用检索工具读取框架内部源码或文档，大量消耗会话上下文。

因此，在评估第三方库时，我通常重点关注五个指标：
* 目标功能是否能由现代 Go 标准库直接实现；
* 该库是否引入了大量无关的间接依赖；
* 核心调用链能否在几分钟内通过函数签名直接理清；
* 出错时能否直接从返回值中定位原因；
* 模型是否仅依据函数签名即可准确调用。

## 2. HTTP 路由：优先 `net/http`

从 Go 1.22 开始，标准库的 `http.ServeMux` 已经支持了基于方法名与路径参数的路由匹配：

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

这段代码没有隐式的全局状态与重度封装的上下文。执行流程从网络请求进入、提取路径参数到输出响应，全部基于标准库的标准签名。无论是人工排查还是模型理解，都一目了然。

当项目规模扩大、需要更精细的中间件流水线与路由分组时，再引入像 `chi` 这样兼容标准库 `http.Handler` 接口且零额外依赖的轻量路由器即可。

## 3. 序列化：`encoding/json/v2`

在以往的实践中，标准库的 `encoding/json` 常因反射开销、内存分配较多而受到讨论，很多项目为此引入了各类第三方加速库。随着 `encoding/json/v2` 的推进，标准库提供了更贴合底层 I/O 的流式处理接口：

```go
json.UnmarshalRead(io.Reader, any)
json.MarshalWrite(io.Writer, any)
```

这两个函数的核心在于直接对接底层的 `io.Reader` 与 `io.Writer`：
* 请求到达时，`UnmarshalRead` 直接从 `r.Body` 的网络流中解码，省去了在堆上分配中间临时 `[]byte` 切片的开销；
* 响应返回时，`MarshalWrite` 直接将二进制字节流写入 `http.ResponseWriter`，减少了一次性缓冲区的构建。

配合泛型，可以封装出一套简单通用的响应与反序列化工具：

```go
package render

import (
	"encoding/json/v2"
	"errors"
	"io"
	"log/slog"
	"net/http"
)

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

func ReadBody[T any](w http.ResponseWriter, r *http.Request) (T, error) {
	var body T
	if r.ContentLength == 0 {
		return body, nil
	}
	if err := json.UnmarshalRead(r.Body, &body); err != nil {
		if errors.Is(err, io.EOF) {
			return body, nil
		}
		log.Error().Err(err).Msg("Failed to read/decode request body")
		Error(w, http.StatusBadRequest, "JSON 格式非法")
		return body, err
	}
	return body, nil
}
```

在控制器中使用该工具解析数据，逻辑清晰且无隐藏状态：

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
    render.Success(w, http.StatusCreated, "创建成功", user)
}
```

## 4. 极致热点下的零反射处理

在少数对吞吐量要求极高的核心接口中，如果需要彻底消除反射开销，`encoding/json/v2` 配合 `jsontext` 提供了按 Token 逐个字段流式编解码的能力：

```go
package main

import (
	"encoding/json/v2/jsontext"
	"fmt"
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

这种写法将结构体各字段的编解码完全静态化，在运行时无须执行任何动态类型反射和结构体标签解析。代码逻辑直接映射到底层的状态转移，也便于模型针对特定高频数据结构进行精确推导与修改。
