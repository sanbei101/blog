---
title: "Postgres 安装指南"
description: "在国内网络环境下安装Postgres数据库的详细步骤"
---

# 国内网络环境下安装 Postgres 数据库

## APT 安装

### 添加清华源仓库签名

```shell
sudo wget -q -O /etc/apt/keyrings/postgresql.asc \
  https://mirrors.tuna.tsinghua.edu.cn/postgresql/repos/apt/ACCC4CF8.asc
```

### 添加清华源仓库

```shell
sudo bash -c 'echo "Types: deb
URIs: https://mirrors.tuna.tsinghua.edu.cn/postgresql/repos/apt
Suites: $(lsb_release -cs)-pgdg
Components: main
Signed-By: /etc/apt/keyrings/postgresql.asc" > /etc/apt/sources.list.d/postgresql.sources'
```

### 更新源并安装

```shell
sudo apt update
sudo apt install postgresql-18 # 替换为版本号
```

### 启动

```shell
sudo systemctl start postgresql
```

### 验证

```shell
sudo systemctl status postgresql@18-main.service # 替换为版本号
```

### 连接

```shell
sudo -u postgres psql
```
