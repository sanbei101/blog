---
title: "APT 镜像源"
date: "2025-12-10"
description: "为 Ubuntu 配置 APT 镜像源"
---

# 为 Ubuntu 配置 APT 镜像源

`ubuntu`配置文件从旧版的`/etc/apt/sources.list`

变更为`/etc/apt/sources.list.d/ubuntu.sources`

## [清华镜像源](https://mirrors.tuna.tsinghua.edu.cn/help/ubuntu/)
```shell
Types: deb
URIs: https://mirrors.tuna.tsinghua.edu.cn/ubuntu
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://mirrors.tuna.tsinghua.edu.cn/ubuntu
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
```

## [中科大镜像源](https://mirrors.ustc.edu.cn/help/ubuntu.html)
```shell
Types: deb
URIs: https://mirrors.ustc.edu.cn/ubuntu
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://mirrors.ustc.edu.cn/ubuntu
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
```