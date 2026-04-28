---
title: 动态规划背包问题总结
description: 动态规划背包问题的常见题型的解题思路和代码实现
---

# 背包问题总结

- 一共有2种背包:
  - 01背包
  - 完全背包
- 一共有3种求解目标:
  - 求最大价值
  - 求组合数
  - 求排列数

`01背包`排列问题几乎不考,而且很难,所以不总结了。


## 题型1:01背包(最大价值)
```py
def knap01(weights, values, capacity):
    dp = [0] * (capacity + 1)
    for w, v in zip(weights, values):              # 物品外循环
        for j in range(capacity, w - 1, -1):       # 背包倒序
            dp[j] = max(dp[j], dp[j - w] + v)
    return dp[capacity]
```
[416. 分割等和子集](https://leetcode.cn/problems/partition-equal-subset-sum)
```py
class Solution:
    def canPartition(self, nums: List[int]) -> bool:
        total = sum(nums)
        if total % 2: return False
        target = total // 2
        dp = [0] * (target + 1)
        for num in nums:                          # 物品
            for j in range(target, num - 1, -1):  # 背包倒序
                dp[j] = max(dp[j], dp[j - num] + num)
        return dp[target] == target
```

## 题型2:完全背包(最大/小价值)
```py
def knapComplete(weights, values, capacity):
    dp = [0] * (capacity + 1)
    for w, v in zip(weights, values):           # 物品外循环
        for j in range(w, capacity + 1):        # 背包正序
            dp[j] = max(dp[j], dp[j - w] + v)
    return dp[capacity]
```
[322. 零钱兑换](https://leetcode.cn/problems/coin-change)
```py
class Solution:
    def coinChange(self, coins: List[int], amount: int) -> int:
        dp = [float('inf')] * (amount + 1)
        dp[0] = 0
        for coin in coins:                       # 物品
            for j in range(coin, amount + 1):    # 背包正序
                dp[j] = min(dp[j], dp[j - coin] + 1)
        return dp[amount] if dp[amount] != float('inf') else -1
```
## 题型3:01背包 + 组合数
```py
# 速查模板
def knap01_comb(nums, target):
    dp = [0] * (target + 1)
    dp[0] = 1
    for num in nums:                             # 物品外循环
        for j in range(target, num - 1, -1):     # 背包倒序
            dp[j] += dp[j - num]
    return dp[target]
```

[494. 目标和](https://leetcode.cn/problems/target-sum)
```py
class Solution:
    def findTargetSumWays(self, nums: List[int], target: int) -> int:
        total = sum(nums)
        if abs(target) > total or (total + target) % 2: return 0
        bag = (total + target) // 2
        dp = [0] * (bag + 1)
        dp[0] = 1
        for num in nums:                         # 物品
            for j in range(bag, num - 1, -1):    # 背包倒序
                dp[j] += dp[j - num]
        return dp[bag]
```

## 题型4:完全背包 + 组合数
```py
# 速查模板
def complete_comb(coins, amount):
    dp = [0] * (amount + 1)
    dp[0] = 1
    for coin in coins:                          # 物品外循环
        for j in range(coin, amount + 1):       # 背包正序
            dp[j] += dp[j - coin]
    return dp[amount]
```
[518. 零钱兑换 II](https://leetcode.cn/problems/coin-change-2)
```py
class Solution:
    def change(self, amount: int, coins: List[int]) -> int:
        dp = [0] * (amount + 1)
        dp[0] = 1
        for coin in coins:                      # 物品
            for j in range(coin, amount + 1):   # 背包正序
                dp[j] += dp[j - coin]
        return dp[amount]
```

## 题型5:完全背包 + 排列数
```py
# 速查模板
def complete_perm(nums, target):
    dp = [0] * (target + 1)
    dp[0] = 1
    for j in range(1, target + 1):              # 背包外循环
        for num in nums:                        # 物品内循环
            if j >= num:
                dp[j] += dp[j - num]
    return dp[target]
```
[377. 组合总和 Ⅳ](https://leetcode.cn/problems/combination-sum-iv)
```py
class Solution:
    def combinationSum4(self, nums: List[int], target: int) -> int:
        dp = [0] * (target + 1)
        dp[0] = 1
        for j in range(1, target + 1):          # 背包外循环
            for num in nums:                    # 物品内循环
                if j >= num:
                    dp[j] += dp[j - num]
        return dp[target]
```