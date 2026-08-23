# Proxy Monitor 📡 (Go 重构版)

Proxy Monitor 是一款基于 **Go 语言** 的代理 IP 质量监控工具。它周期性探测节点列表中的 IP/域名，计算 **TCP/TLS/HTTP 分段延迟**，结合 **成功率** 与 **达标率**（延迟上限），并配合 **一次性下载测速**，最终筛选出 **优质节点**，可自动上传至 GitHub 供订阅使用。

---

## 1. 概述

**主要特性**：
- 🚀 **Go 语言重构**：零外部依赖，仅用标准库，静态编译，内存占用低，并发性能强
- 多源节点发现（纯 IP、域名、URL 列表）
- 官方 Cloudflare Trace 探针（验证反代能力，读取 colo/loc/出口 IP）
- 自定义源站探针（验证真实回源）
- 高并发智能探测：
  - 延迟阶段：Goroutine 并发执行小请求，计算 TCP/TLS/HTTP 平均延迟
  - 测速阶段：独立低并发执行真实下载，避免本地带宽争抢
- 多维优质判定，综合「样本充足度 + 成功率 + 达标率（延迟上限）+ 下载速度下限」进行四维严格筛选
- 长期离线节点自动清理
- 完整的 Web UI 与 REST API
- GitHub 同步（全部节点 + 按地区拆分）
- 开箱即用的面板：单文件 HTML 前端，提供延迟统计图、失败原因回溯、手动复测等丰富交互
- 🐳 **Docker 优化**：多阶段构建，distroless 基础镜像，最终镜像 <20MB

---

## 2. 快速开始

### 2.1 Docker Compose 部署（推荐）

推荐使用 Docker Compose 进行部署，数据完全持久化，升级无缝衔接。

```yaml
services:
  proxy-monitor:
    image: coldicy7/proxyip-monitor
    container_name: proxy-monitor
    restart: unless-stopped
    ports:
      - "8787:8787"
    volumes:
      - ./proxy-monitor/config:/app/config # 配置文件目录
      - ./proxy-monitor/data:/app/data # 数据目录
      - ./ips.txt:/app/ips.txt:ro # IP 列表文件（只读）
    environment:
      - GITHUB_TOKEN=${GITHUB_TOKEN:-} # 可选：通过环境变量传入 GitHub Token
```

启动服务：
```bash
docker-compose up -d
```

访问 `http://你的服务器IP:8787` 即可打开监控面板。

### 2.2 自行构建 Docker 镜像

```bash
# 构建镜像
docker build -t proxy-monitor .

# 运行容器
docker run -d \
  --name proxy-monitor \
  --restart unless-stopped \
  -p 8787:8787 \
  -v $(pwd)/proxy-monitor/config:/app/config \
  -v $(pwd)/proxy-monitor/data:/app/data \
  -v $(pwd)/ips.txt:/app/ips.txt:ro \
  proxy-monitor
```

### 2.3 直接运行二进制文件

```bash
# 编译
go build -o cf-speed-test ./cmd/server

# 运行
./cf-speed-test
```

**默认配置**：
- 监听端口：`8787`（可通过 `PORT` 环境变量修改）
- 数据目录：`/app/data`（可通过 `DATA_DIR` 修改）
- 节点列表：`/app/config/ip.txt`（可通过 `IP_FILE` 修改）

首次启动自动创建必要文件和目录。

---

## 3. 节点列表格式 (`ip.txt`)

每行一个节点来源，支持 `#` 注释，空行忽略。

- **纯 IP**（默认端口 443）  
  ```
  1.2.3.4
  ```
- **IP:端口**  
  ```
  1.2.3.4:8443
  ```
- **域名**（默认端口 443）  
  ```
  example.com
  ```
- **域名:端口**  
  ```
  example.com:8443
  ```
- **HTTP/HTTPS 列表源**（拉取纯文本列表，每行一个 IP 或 IP:端口）  
  ```
  https://example.com/proxy-list.txt
  ```

**解析机制**：
- 每轮检测前都会重新读取 `ip.txt`，对域名重新 DNS 解析，对 URL 列表重新拉取。
- **只增不减**：历史解析出的 IP 会一直保留，除非手动删除或自动清理触发。因此，即使域名解析结果变化，旧 IP 仍会被继续监控。

---

## 4. 核心指标

| 指标 | 说明 |
|------|------|
| **平均总延迟** | 窗口内所有在线样本的总延迟平均值（含 TCP + TLS + HTTP 回源） |
| **平均 TCP** | 平均 TCP 连接时间 |
| **平均 TLS** | 平均 TLS 握手时间 |
| **平均 HTTP** | 平均 HTTP 回源时间（总延迟 - TCP - TLS） |
| **成功率** | 窗口内在线次数 / 窗口大小 |
| **达标率** | 窗口内"在线且总延迟 ≤ 上限"的次数 / 窗口大小（若上限=0，则等于成功率） |
| **下载速度** | 一次性测速结果（MB/s），见第 5 节 |
| **优质** | 同时满足：样本充足（窗口大小次样本） + 成功率 ≥ 阈值 + 达标率 ≥ 阈值 + 速度 ≥ 下限（若启用测速） |

---

## 5. 一次性测速机制

- **触发时机**：节点在延迟检测中首次变为**在线**时自动触发（若未测速过或先前失败且间隔超过 10 分钟）。
- **原理**：使用 `curl --resolve` 强制通过被测 IP 访问测速 URL（默认 `speed.cloudflare.com/__down?bytes=20000000`），下载 20 MB 文件，计算 `已下载字节 / 耗时`，得到平均速度（MB/s）。
- **超时截断**：若下载达到 `--max-time`（默认 10s），curl 会终止，但仍能输出已下载字节数，因此超时节点也能获得有效速度（可能偏低，但真实反映了在该时间窗口内的下行能力）。
- **结果持久化**：测速结果保存在节点数据中，重启不丢失。
- **重试策略**：
  - 成功记录 → 永不自动复测（除非手动触发）。
  - 失败记录 → 仅当节点再次在线且距上次失败超过 10 分钟时才重试。
  - 离线节点完全不测，节省资源。
- **并发与配额**：
  - 测速阶段使用独立并发（默认 1，可配 1~3），避免与延迟并发争抢带宽。
  - 每周期有配额（默认 20 个节点），超出配额的待测节点顺延至下一周期。
- **手动复测**：表格每行有 ⚡ 按钮，用户可随时对单个节点发起手动测速，不受自动重试限制。

**注意**：测速结果受监控机本地带宽影响，速度下限的设定请结合监控机实际可用带宽。

---

## 6. 探针分工

### 6.1 官方探针
- 请求 `https://www.cloudflare.com/cdn-cgi/trace`，通过被测 IP 发起。
- 验证返回内容包含 `colo`、`fl` 等 CF 特征，且回显了本次请求的随机 `User-Agent`（防伪造）。
- 成功后提取 `colo`（数据中心）、`loc`（地区）、`ip`（出口 IP）等元数据。

### 6.2 自定义源站探针
- 在设置中可添加任意 HTTPS URL（例如 `https://your-origin.example.com/health`）。
- 可指定预期 HTTP 状态码（默认 `200`）。
- 在官方探针通过后，**依次**请求所有自定义探针；若任一失败，该次检测整体记为离线，并记录失败原因（如预期 200 实际 502）。
- 多探针的平均延迟 = 官方 + 全部自定义探针延迟的平均值。

---

## 7. 墓地机制（Graveyard）

- **作用**：临时屏蔽持续失败的节点，避免无效探测浪费资源。
- **触发条件**：
  - 连续失败次数 ≥ 配置阈值（默认 5 次）。
  - 失败原因包括：非 CF 反代、UA 未回显、连接超时、TLS 错误、HTTP 非预期等。
- **解封条件**：
  - 自动：被屏蔽后超过 24 小时自动移出墓地。
  - 手动：在 Web UI 点击「🗑️ 墓地」→ 找到对应节点 → 点击「🔓 解封」。
- **墓碑字段**：记录 `removedAt`（移除时间）、`lastOnlineAt`（最后在线时间）、`reason`（失败原因）。

---

## 8. 配置参数详解

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `intervalSec` | 180 | 检测周期间隔（秒） |
| `concurrency` | 30 | 延迟阶段并发数 |
| `speedConcurrency` | 1 | 测速阶段并发数（建议 1~3） |
| `timeoutSec` | 6 | 单次探测超时（秒） |
| `speedTimeoutSec` | 10 | 测速超时（秒） |
| `qualityTotalMs` | 0 | 优质总延迟上限（0=不限） |
| `qualityRate` | 1.0 | 优质成功率阈值（0~1） |
| `qualityQualRate` | 1.0 | 优质达标率阈值（0~1） |
| `qualitySpeedMbps` | 0 | 优质速度下限（MB/s，0=不限） |
| `graveyardThreshold` | 5 | 墓地触发失败次数 |
| `graveyardAutoReleaseHours` | 24 | 墓地自动解封时间（小时） |
| `maxHistory` | 50 | 单节点最大历史记录数 |
| `autoCleanOfflineDays` | 7 | 自动清理离线节点天数（0=禁用） |
| `port` | 8787 | Web 服务监听端口 |
| `dataDir` | /app/data | 数据目录路径 |
| `ipFile` | /app/config/ip.txt | 节点列表文件路径 |
| `probeUrl` | https://www.cloudflare.com/cdn-cgi/trace | 官方探针 URL |
| `speedUrl` | https://speed.cloudflare.com/__down?bytes=20000000 | 测速 URL |

---

## 9. GitHub 同步

### 9.1 配置方式

在 Web UI → 设置 → GitHub 同步 中填写：
- **Token**：具有 `repo` 权限的 Personal Access Token。
- **仓库**：格式 `username/repo`。
- **分支**：目标分支（默认 `main`）。
- **文件路径**：上传的文件名（默认 `proxies.json`）。
- **自动上传**：开启后，每轮检测完成且优质节点列表发生变化时自动推送。
- **上传间隔**：定时上传间隔（分钟），0=禁用。

### 9.2 上传内容

- **全量模式**：所有在线节点（含延迟、速度、地区等元数据）。
- **拆分模式**（未来版本）：按 `colo` 或 `loc` 拆分为多个文件。

### 9.3 安全提示

- Token 会以加密形式存储在配置文件中。
- 建议使用最小权限的 Token（仅需 `repo` 范围）。
- 可通过环境变量 `GITHUB_TOKEN` 注入，避免明文写入配置。

---

## 10. REST API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 返回 Web UI 页面 |
| `/api/state` | GET | 获取完整状态（节点列表、历史记录、进度、配置等） |
| `/api/logs` | GET | 获取最近 400 条日志 |
| `/api/abort` | POST | 中断当前检测周期 |
| `/api/graveyard` | GET | 获取墓地列表 |
| `/api/graveyard/clear` | POST | 清空墓地 |

---

## 11. 性能优化（Go 重构版）

### 11.1 内存优化
- **值类型优先**：减少指针分配，降低 GC 压力。
- **对象池**：复用 `CurlResult`、`Segments` 等频繁创建的结构体。
- **历史记录窗口**：限制每个节点最多保留 N 条记录（默认 50），超出自动丢弃最旧记录。
- **日志环形缓冲**：固定容量 400 条，超出自动截断头部。

### 11.2 并发模型
- **Goroutine + Channel**：替代 Node.js 事件循环，充分利用多核 CPU。
- **信号量控制并发**：延迟阶段、测速阶段分别使用独立信号量，避免资源争抢。
- **优雅关闭**：监听 SIGINT/SIGTERM，等待当前周期完成后退出。

### 11.3 零外部依赖
- 仅使用 Go 标准库（`net/http`、`os/exec`、`encoding/json` 等）。
- 无需 `go mod download`，编译速度快，镜像体积小。

### 11.4 Docker 优化
- **多阶段构建**：编译阶段使用 `golang:1.21-alpine`，运行阶段使用 `distroless/static-debian11`。
- **静态编译**：`CGO_ENABLED=0`，生成完全静态的二进制文件。
- **精简镜像**：最终镜像仅包含二进制文件和前端 HTML，体积 <20MB。
- **非 root 用户**：运行阶段切换为 `nonroot` 用户，提升安全性。

---

## 12. 项目结构

```
.
├── cmd/
│   └── server/
│       ├── main.go           # 主程序入口
│       └── web/dist/         # 前端静态文件
│           └── index.html
├── internal/
│   ├── config/
│   │   └── config.go         # 配置管理
│   ├── detector/
│   │   └── detector.go       # 探测逻辑（CF CIDR、延迟、测速）
│   ├── models/
│   │   └── models.go         # 数据模型（Unit、ProbeResult、HistoryEntry 等）
│   ├── storage/
│   │   └── storage.go        # 存储层（历史数据、墓地管理）
│   └── server/
│       └── server.go         # HTTP 服务器（API 路由、检测周期）
├── Dockerfile                # 多阶段 Docker 构建
├── docker-compose.yml        # Docker Compose 配置
├── go.mod                    # Go 模块定义
└── README.md                 # 本文档
```

---

## 13. 常见问题

### Q: 为什么有些节点一直显示"不具备反代 CF 能力"？
A: 官方探针返回的内容中缺少 `colo` 或 `fl` 字段，说明该 IP 不是 Cloudflare 的反代节点，可能是源站或其他 CDN。

### Q: 测速结果为什么是 0 或失败？
A: 可能原因：
- 监控机带宽不足，无法在超时时间内下载足够数据。
- 节点限制了下载速度或禁止大文件下载。
- 网络波动导致连接中断。

### Q: 如何手动触发节点复测？
A: 在 Web UI 的节点表格中，点击每行右侧的 ⚡ 按钮即可对该节点发起一次完整探测（含测速）。

### Q: 迁移自 Node.js 版本，数据是否兼容？
A: 完全兼容。配置文件（JSON）、历史数据（history.json）、墓地数据（graveyard.json）格式保持一致，可直接覆盖使用。

---

## 14. 许可证

MIT License

---

**作者**：Coldicy  
**Go 重构**：2025  
**原始版本**：Node.js v36-window
