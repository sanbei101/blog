---
title: "Homebrew 安装指南"
date: "2025-12-10"
description: "在Linux系统上安装Homebrew的详细步骤"
---

# 设置镜像

打开`~/.config/fish/config.fish`

```
nano ~/.config/fish/config.fish
```

### 设置环境变量

```
set -x HOMEBREW_BREW_GIT_REMOTE "https://mirrors.ustc.edu.cn/brew.git"
set -x HOMEBREW_CORE_GIT_REMOTE "https://mirrors.ustc.edu.cn/homebrew-core.git"
set -x HOMEBREW_BOTTLE_DOMAIN "https://mirrors.ustc.edu.cn/homebrew-bottles"
set -x HOMEBREW_API_DOMAIN "https://mirrors.ustc.edu.cn/homebrew-bottles/api"
```

### 一行命令版本

```
echo 'set -x HOMEBREW_BREW_GIT_REMOTE "https://mirrors.ustc.edu.cn/brew.git"' >> ~/.config/fish/config.fish
echo 'set -x HOMEBREW_CORE_GIT_REMOTE "https://mirrors.ustc.edu.cn/homebrew-core.git"' >> ~/.config/fish/config.fish
echo 'set -x HOMEBREW_BOTTLE_DOMAIN "https://mirrors.ustc.edu.cn/homebrew-bottles"' >> ~/.config/fish/config.fish
echo 'set -x HOMEBREW_API_DOMAIN "https://mirrors.ustc.edu.cn/homebrew-bottles/api"' >> ~/.config/fish/config.fish
```

## 使配置生效

`source ~/.config/fish/config.fish`

# 创建`brew`用户

**这是因为`brew`不支持使用`root`用户安装**

```
useradd -m -s $(which fish) brew
echo "brew:123456" | chpasswd
usermod -aG sudo brew
```

## 切换用户

```
su brew
```

# 安装`brew`

```
/bin/bash -c "$(curl -fsSL https://mirrors.ustc.edu.cn/misc/brew-install.sh)"
```

### 设置`brew`路径

```
/home/linuxbrew/.linuxbrew/bin/brew shellenv >> ~/.config/fish/config.fish
```
