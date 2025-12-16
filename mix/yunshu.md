---
title: "制裁流氓软件云枢"
description: "在Mac平台下禁止云枢后台启动和窃取浏览器数据"
---

# 制裁流氓软件云枢

## 禁止云枢安装浏览器监控插件

云枢这个流氓软件会在启动的时候往浏览器里塞一条强制安装浏览器拓展的策略`ExtensionInstallForcelist`,从而让你删都删不掉他的浏览器拓展

天知道这个浏览器拓展到底干了些什么,说不准就能看到咱们**浏览记录**,那我也是研究了好一会,终于找到了解决办法

### 思路

首先使用`find`命令查找`Google Chrome`的策略文件,看看云枢是怎么作妖的

```
mac@user~> sudo fd -i "com.google.Chrome.plist" / 2>/dev/null

查询结果:

/Library/Managed Preferences/agiuser/com.google.Chrome.plist
/System/Volumes/Data/Library/Managed Preferences/agiuser/com.google.Chrome.plist
/System/Volumes/Data/Users/agiuser/Library/Preferences/com.google.Chrome.plist
/Users/user/Library/Preferences/com.google.Chrome.plist
```

其中以`/System/Volumes`开头的文件我们不用管,因为那是`Mac`文件系统的特性,是文件的实际存储位置

`/Users/user/Library/Preferences/com.google.Chrome.plist`是用户级别的,记录了一些浏览器的窗口大小等信息,与策略无关

其中真正起作用的实际上是这个`/Library/ManagedPreferences/agiuser/com.google.Chrome.plist`文件
他的内容应该为

```xml
ExtensionInstallForcelist = (
    afiecjcblhjecgchlpknmdigpxxxxx # 这是云枢的浏览器拓展ID
);
```

但很恶心的一点就在于,你删除这个文件**没用**,因为云枢检测到策略缺失之后,会自动重新创建这个文件,然后继续强制安装浏览器拓展

### 解决办法

核心思路是**占位并锁定**

既然系统非要往那个位置写文件,我们就放一个**空的、不可修改**的假文件在那儿,
系统想覆盖它时会发现权限被锁死,从而写入失败。

具体步骤如下:

1. 删除策略文件

```shell
sudo rm -f "/Library/Managed Preferences/agiuser/com.google.Chrome.plist" #注意这里有个空格,必须用引号括起来
```

2. 立刻创建一个空的假文件

```shell
sudo touch "/Library/Managed Preferences/agiuser/com.google.Chrome.plist"
```

3. 给文件加上"无敌"锁

```shell
sudo chflags uchg "/Library/Managed Preferences/agiuser/com.google.Chrome.plist"
```

这样一来,连`root`权限也无法直接(可以先解锁再写)写这个文件了,也就是说云枢就没法再往里面写东西了,从而达到了禁止安装浏览器拓展的目的

4. 杀掉缓存进程,让系统重新读取这个空文件

```shell
sudo killall cfprefsd
```

5. 验证是否成功

```shell
defaults read "/Library/Managed Preferences/agiuser/com.google.Chrome"
```

应该为空

## 终结云枢后台程序

云枢这个流氓软件点击退出之后,还会在后台一直运行他的守护进程`YunShuManger`和`Helper`,偷偷监控用户行为

### 解决办法

1. 查找守护进程的配置文件

```shell
# 进入系统守护进程目录
cd /Library/LaunchDaemons

# 查找相关的配置文件
ls | grep -i eagleyun
ls | grep -i yunshu

# 输出结果:
com.eagleyun.sase.helper.plist
com.eagleyun.sase.servicemanager.plist
```

2. 卸载守护进程

```shell
sudo launchctl unload com.eagleyun.sase.helper.plist
sudo launchctl unload com.eagleyun.sase.servicemanager.plist
```

3. `kill`进程

```shell
sudo pkill -f -i yunshu
```
