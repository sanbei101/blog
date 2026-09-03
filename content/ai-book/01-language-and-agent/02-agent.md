---
title: 寻找最舒服的Agent
description: 千人千面,寻你所好
weight: 20
---

目前市面上的`Agent`百花齐放,目前最主流的有:
1. `CLAUDE Code`
2. `Codex`
3. `Opencode`
4. `Pi`和`deepseek harness`这种定制性极强的`Agent`

我觉得不同的`Agent`差异都不大,大家可以找一个体感最舒服的,当然你如果有购买`code plan`的订阅的话,那就无脑选择对应的厂家出品`Agent`

我个人不太喜欢前两个,原因有几个:

1. `Codex`写代码的时候特别喜欢使用`python xxx`来覆盖我的文件,而不是对片段进行`patch`修改,这导致他修改的又慢又不好(不知道现在修复了没有), 相关的`github issue`:
[31243](https://github.com/openai/codex/issues/31243)
[9914](https://github.com/openai/codex/issues/9914)

2. `Codex`会启动一个因为莫名其妙原因失败(可能是缺少xx环境)的沙盒`Sandbox`,然后就连读取文件,发出网络请求这种操作都会被拦截,这个有利有弊,但对我来说绝大部分时候用不到这么极致的安全,我更希望模型能自由使用各种工具(除了`rm`和`drop database`,但是现代ai已经进化到了就算你让他这么干,他很可能都会拒绝你的程度,所以我觉得我其实不太需要`agent`再来限制我),尽量少打断我,我不想上厕所回来发现卡在了是否`continue`

3. `Claude Code`的安装包是几乎所有`Agent`中最大的,现在似乎膨胀到了`300MB`以上,而且很恶心人的是他不仅模型屏蔽了大陆,就连安装包的下载地址都屏蔽了,而且有些🪜梯子的节点不够干净都不行,我经常需要为了下载/更新切换到美国节点,并且他最近还闹出了一些偷偷上传数据的风波,有些大厂已经禁用了

4. 这两个都绑定了特定的厂商的`api`格式,如`codex`<->`openai`的`OpenAI API` 格式,`claude code`<->`Anthropic` 的 `Messages API`,有些中转站或者国产模型的`code plan`只支持其中一种,那么就必须要切换工具了,还要重新配置`skills`、`mcp`,有点烦人

我比较喜欢`Opencode`, 有几个原因:

1. `Opencode`能通过各种 [Provider](https://ai-sdk.dev/providers/ai-sdk-providers) 接入所有的中转站和各种api格式的ai模型),只要熟悉了它就可以不用切换来切换去的了

2. `Opencode`有一个我特别喜欢的功能就是`web`模式,它可以开启一个后台服务然后一直挂在`tmux`后台,这样我还可以用手机遥控它下达指令,也不用担心因为息屏他就停下来了

anyway,这部分其实没有太多好说的啦,快进到下一章吧~
