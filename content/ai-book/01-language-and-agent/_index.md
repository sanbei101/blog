---
title: 第一章 语言和 Agent
description: AI 时代后端语言与 Agent 的选型
weight: 10
---

# 语言的选择

在非ai时代,golang就已经是因为语法简单,性能优异,打包二进制正在逐步占领服务端的份额,那么在ai时代,golang是否和我们手上的`ai agent`相适配呢,我认为 **是的**

## 短一点,别占满我的上下文!

`agent`的上下文是极其宝贵的,虽然目前较高级的模型具备`1 M`的上下文长度,但是大家的共识基本上是在`100k-300k`这个区间端,模型既能拥有充分的上下文储备,又能不被过多的信息干扰,是写出优质代码的黄金区段

这也引出了我的第一个观点: 强大的基座模型是一个极品幼年宠兽,想要让它快速成长,为我们征战代码仓库,就必须要给他喂**优质营养**(指的就是精炼,信息熵低的代码上下文)

这里点名批评`java`,写个简单的接口,往往要拖家带口塞进 `Controller`、`Service`、`ServiceImpl`、`Mapper`、`DTO`、`VO` 这些类中,以及一大堆 `@Autowired`、`@Transactional` 等黑盒注解,这种代码在非ai时代可能还能说在大规模协作中能保持规范(其实古法编程也不愿意去写这么啰嗦的代码)

但是在ai时代,就是上下文毒药,大量的上下文被无意义的模板占据,要写一个接口,从`handler...repo`,连古法编程都需要在`ide`中点来点去不胜其烦,而且文件夹嵌套严重,动辄7,8层,导致ai阅读代码库,需要调用大量的`grep`,`read`工具理解冗长的处理链路,很快上下文就被塞的满满当当,带来了更高的费用和更低的智商

本人习惯只分为`handler`,`service`两层,ai只需要拿`gopls mcp`进行`1`次`GO to definition`就可以跳转到处理链路,或者拿`grep`搜索一下函数名就能进行对应,ai写新逻辑的时候也不用到处新建文件,这也带来了一个好处: 如果让ai在多个文件输出过多的token,那么到尾端他的犯错几率会大幅增加(本人的经验,还不太清楚原理),相反如果让ai专注的去撰写一个函数的实现,那么他的思考链将更专注于这个函数的性能优化,往往就能写出可读性,可维护性更好的代码

这个时候可能有读者就会问了,主播主播,你只写两层,那`repo`层复用怎么办? 根据我的经验,一般`service`都会`1:1`对应一个`repo`层,也就是说大部分`service`层用到的`repo`都是独立的,甚至后期还会出现ai只写不删,在`repo`层出现很多没用的`findbyname/findbyid/findbyxxx`等的情况,逐渐变成`屎山`

而且在`go`语言中,主播会选用一个很厉害的工具:`sqlc`(后面会详细的说),他就完全可以代替整个`repo`层而且还对ai上下文更友好

## 不要黑魔法,不要抽象!

在古法编程时代,大家最崇尚的叫什么?叫约定大于配置,叫黑魔法,叫优雅的抽象。

依赖注入?搞个`@Autowired`,容器在运行时帮你偷偷把实例塞进来;

事务管理?套一个 `@Transactional` 注解,背地里 AOP 动态代理帮你切面;

当你在代码里搞了一大堆隐式逻辑,Agent 根本看不见幕后的调度者(虽然可能现代ai针对常用框架进行了训练,有一定改善),但他遇到没有在语意库中的新语法,他就只能去依赖源码中大量的使用grep去查询他的用法

举个例子:
```java
@Service
public class OrderService {
    @Autowired
    private OrderMapper orderMapper;
    @Autowired
    private AccountMapper accountMapper;

    @Transactional
    public void createOrder(Order order) {
        orderMapper.insert(order);
        accountMapper.deductBalance(order.getUserId(), order.getAmount());
    }
}
```
核心业务逻辑就两三行,外头套一个 `@Transactional`,事务开箱即用,代码多"简洁"啊
但Agent面对的是什么? 黑盒操作!

> Spring 默认只在遇到 `RuntimeException` 和 `Error` 时回滚,如果是受检异常 `Exception`
> 它根本不回滚,需要显式配置 `rollbackFor = Exception.class`, 如果 Agent 的训练语料里稍微漏了一点,他就要去疯狂检索源码才知道还有这回事

那么`go`语言呢?
```go
func (s *OrderService) CreateOrder(ctx context.Context, order Order) error {
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx failed: %w", err)
    }
    defer tx.Rollback()
    if err := s.orderRepo.CreateWithTx(ctx, tx, order); err != nil {
        return fmt.Errorf("create order failed: %w", err)
    }
    if err := s.accountRepo.DeductBalanceWithTx(ctx, tx, order.UserID, order.Amount); err != nil {
        return fmt.Errorf("deduct balance failed: %w", err)
    }
    return tx.Commit()
}
```
所见即所得:Agent 从上到下一行一行往下读,第一步开启事务,中间任何一步报错就返回并触发`tx.Rollback()`,全走通了最后 `tx.Commit()`。整个数据流和控制流像一条笔直的马路,没有任何岔路和暗桩。
Go 的显式流程给 Agent 提供了一条极具确定性的跑道,它不需要在脑子里跑一个 Spring 容器反射运行时,它能把 100% 的智商集中在业务边界处理和错误分支的防御性编程上。

再来一个例子,那就是网上很多人喷的`go`的错误处理: 满屏幕的 `if err != nil`

古法写 Java,我直接一个 `throw new BizException("余额不足")`,甚至根本不用管上层谁接,反正外头有 `@RestControllerAdvice` 或者全局拦截器给兜底,一两行代码就把错误抛出去了,感觉代码清爽得不行。但到了 AI 时代,这套机制直接被反噬成了最恶心的"逻辑迷雾"。

当 AI 在阅读或者编写一段业务逻辑时,它最依赖的是上下文的连续性

```java
userService.deductBalance(userId, amount);
```

从表面上看,它就是个普通的方法调用。但实际上呢?它里面可能会抛出:

1. `InsufficientBalanceException`
2. `AccountFrozenException`
3. `NetworkTimeoutException`
4. 各种奇奇怪怪的`RuntimeException`

这时候 Agent 就懵了:这个方法到底会不会抛异常?它可能抛出哪几种异常?抛出去之后,是在当前的 Controller 被截胡了,还是直接穿透到了全局拦截器?
全局拦截器抓到之后,返回给前端的 HTTP Code 是 200 还是 400 还是 500?返回的 JSON 结构体又长什么样?

这就是典型的"隐式控制断层"
AI Agent 看到一个 throw,它的思考链当场就被斩断了。为了搞清楚这个错误最终怎么被消费,Agent 必须调用工具满项目去 grep 各种全局拦截器、翻找异常继承树。本来珍贵的几十 K 黄金上下文,瞬间被这些跨目录的搜索碎片给稀释成了渣渣。

反过来,我们看 `Go` 是怎么干的:
```go
balance, err := s.accountRepo.DeductBalance(ctx, userID, amount)
if err != nil {
    return fmt.Errorf("deduct balance for user %d failed: %w", userID, err)
}
```
在 `Agent` 眼里简直是天降甘霖

这个函数会不会失败? `Agent` 根本不需要脑补,看函数签名 `(Balance, error)` 就知道得一清二楚

当 Token 吐到调用结束的那一刻,`Agent`的注意力机制立刻就锁定在接下来的 `if err != nil` 分支里。它必须在当下就决定:是该降级重试?是包装错误返回?还是打日志中断? 我觉得人类读起来都很顺畅(可能是因为我晕递归,所以我很讨厌`throw`抛来抛去拦截来拦截去的),就地处理的非常自然

当系统在某一天真的报错时,日志里打出来的不是一段夹杂着各种动态代理框架内部调用的巨型 `StackTrace` 而是极其清晰的一条链路:`create order failed: deduct balance for user 1001 failed: insufficient funds`。
Agent 拿眼一扫这条日志,直接就能定位到是哪一层、调用哪个函数、因为什么参数挂掉的,一轮 Prompt 就能直接把 Bug 给修了。
