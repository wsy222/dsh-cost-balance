# dsh-cost-balance

DeepSeek Harness（DSH）Web UI 插件：在输入框下方显示一条 iOS 风格的小黑条，点击展开轻盈的半透明多行面板，查看**会话花费、账户余额、缓存命中、Token 用量**等统计。

默认折叠为一条居中的小黑条（类似 iOS 底部横条），点击展开毛玻璃面板：

| 行 | 内容 |
|---|---|
| 轮次 · 步数 | 3 轮 · 12 步 |
| LLM 耗时 / 工具调用 | 45.2s / 12.3s |
| 首 token 平均 / 吞吐 | 1.4s / 25.4 tok/s |
| 缓存命中 | 87% |
| Token | 输入 12.2K · 输出 517 |
| 花费 | $0.0123（本会话，按官方定价） |
| 余额 | ¥9.00（DeepSeek 账户实时余额，60s 自动刷新） |

## 安装

```sh
dsh plugin --profile web add dsh-cost-balance
```

然后重启（或刷新）DSH Web UI。卸载：`dsh plugin --profile web remove dsh-cost-balance`。

## 工作原理

- **Client 半**（`lib/client.js`）：注册在 `conversation.composer.dock` 槽位（接管 shipped 的 `stats` 单元格，与产品自带统计行同源同数据），展示折叠/展开 UI；通过同源 `GET /api/cost-balance` 读取数据，每 60 秒自动刷新，token 用量变化时即时重算。
- **Host 半**（`lib/index.js`）：经 `webServer` 注册 `/api/cost-balance` 路由——花费按会话累计 token（未命中输入 / 缓存命中 / 缓存写入 / 输出）× 模型单价计算；余额经 `credentials` 服务解析 `DEEPSEEK_API_KEY` 后调用 DeepSeek 官方 `GET /user/balance`（60s 缓存、失败 30s 抑制）。

余额取自**用户自己的 API Key 账户**，无需任何配置；未配置或抓取失败时面板显示 `余额 --`。

## 定价与覆盖

内置 DeepSeek 官方定价（USD / 1M tokens）：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| deepseek-v4-flash | $0.0028 | $0.14 | $0.28 |
| deepseek-v4-pro | $0.003625 | $0.435 | $0.87 |

> DeepSeek 将于 2026-08-16 16:00 UTC 起切换峰谷计费（off-peak 为 peak 的一半）。价格变更时无需等插件更新——在 profile 的 `cordis.patch.yml` 里覆盖即可：

```yaml
# ~/.dsh/profiles/<你的profile>/cordis.patch.yml
- id: cost-balance
  config:
    prices:
      deepseek-v4-flash:
        cacheHit: 0.014
        cacheMiss: 0.44
        output: 1.32
```

（覆盖是整行替换，务必保留 `id: cost-balance`。）

## 从源码安装（开发）

```sh
git clone https://github.com/zoumutou/dsh-cost-balance.git
cd dsh-cost-balance
dsh plugin --profile web add .
```

## 许可

MIT
