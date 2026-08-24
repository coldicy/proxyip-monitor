# Proxy Monitor (Go 重构版)

📡 高性能代理 IP 监控与筛选工具 - Go 语言重构版

## 特性

- **高性能**: 基于 Go 语言重构，内存占用更低，并发性能更强
- **单二进制**: 编译后为单一静态文件，部署简单
- **Docker 优化**: 多阶段构建，镜像体积小（<20MB）
- **功能完整**: 保持与原 Node.js 版本完全一致的功能
- **优雅关闭**: 支持信号处理和数据持久化
- **健康检查**: 内置健康检查端点

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
cd go-backend

# 创建必要的目录和配置文件
mkdir -p data config
cp config/ip.txt.example config/ip.txt

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

访问 http://localhost:8787 即可使用。

### 方式二：Docker 直接运行

```bash
# 构建镜像
docker build -t proxy-monitor:latest .

# 运行容器
docker run -d \
  --name proxy-monitor \
  -p 8787:8787 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config/ip.txt:/app/config/ip.txt \
  --restart unless-stopped \
  proxy-monitor:latest
```

### 方式三：直接运行二进制

```bash
# 安装 Go 1.19+
# 编译
cd go-backend
go build -o proxy-monitor ./cmd/

# 创建配置目录
mkdir -p data config
cp config/ip.txt.example config/ip.txt

# 运行
./proxy-monitor
```

## 环境变量配置

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| PORT | 8787 | 服务端口 |
| IP_FILE | /app/config/ip.txt | IP 配置文件路径 |
| DATA_DIR | /app/data | 数据目录 |
| INTERVAL_SEC | 60 | 检测间隔（秒） |
| TIMEOUT_SEC | 5 | 请求超时（秒） |
| CONCURRENCY | 50 | 并发数 |
| MAX_TOTAL_MS | 0 | 最大总延迟限制（0=不限制） |
| QUALITY_WINDOW | 10 | 质量评估窗口大小 |
| SUCCESS_THRESHOLD | 1 | 成功率阈值（0-1） |
| QUAL_THRESHOLD | 1 | 质量阈值（0-1） |
| SPEED_ENABLED | true | 是否启用测速 |
| SPEED_URL | https://speed.cloudflare.com/__down?bytes=20000000 | 测速 URL |
| SPEED_TIMEOUT_SEC | 10 | 测速超时（秒） |
| SPEED_MIN_MBPS | 0 | 最小速度要求（MBps，0=不限制） |
| GITHUB_TOKEN | - | GitHub Token（可选） |
| GITHUB_REPO | - | GitHub 仓库（user/repo 格式） |
| GITHUB_PATH | proxyip | GitHub 文件路径 |
| GITHUB_BRANCH | main | GitHub 分支 |
| GITHUB_AUTO_UPLOAD | false | 是否自动上传 |
| GITHUB_UPLOAD_INTERVAL_MIN | 0 | 上传间隔（分钟） |

## API 接口

- `GET /api/state` - 获取当前状态
- `GET /api/config` - 获取配置
- `POST /api/config` - 更新配置
- `GET /api/ipfile` - 获取 IP 文件内容
- `POST /api/ipfile` - 保存 IP 文件
- `GET /api/graveyard` - 获取墓碑记录
- `DELETE /api/graveyard` - 清空墓碑记录
- `POST /api/nodes/remove` - 删除节点
- `POST /api/check/trigger` - 手动触发检测
- `POST /api/check/abort` - 中断检测

## 项目结构

```
go-backend/
├── cmd/
│   └── main.go          # 程序入口
├── internal/
│   ├── config/
│   │   └── config.go    # 配置管理
│   ├── handler/
│   │   ├── handler.go   # HTTP 处理器
│   │   └── static/
│   │       └── index.html # 前端页面
│   ├── model/
│   │   └── model.go     # 数据模型
│   └── service/
│       └── service.go   # 业务逻辑
├── config/
│   └── ip.txt.example   # IP 配置示例
├── Dockerfile           # Docker 构建文件
├── docker-compose.yml   # Docker Compose 配置
├── go.mod               # Go 模块定义
└── README.md            # 本文档
```

## 性能对比

| 指标 | Node.js 版 | Go 版 |
|------|-----------|-------|
| 内存占用 | ~80MB | ~15MB |
| 启动时间 | ~2s | ~0.1s |
| Docker 镜像 | ~180MB | ~18MB |
| 并发能力 | 中等 | 高 |

## 开发指南

### 本地开发

```bash
# 安装依赖
go mod download

# 运行
go run ./cmd/

# 测试
go test ./...

# 编译
go build -o proxy-monitor ./cmd/
```

### 添加新功能

1. 在 `internal/model` 中定义数据模型
2. 在 `internal/service` 中实现业务逻辑
3. 在 `internal/handler` 中添加 API 路由
4. 更新前端页面（如需要）

## 常见问题

### Q: 如何修改检测的 IP 列表？
A: 编辑 `config/ip.txt` 文件，每行一个 IP 或域名，保存后会自动重新加载。

### Q: 如何启用 GitHub 自动上传？
A: 设置环境变量 `GITHUB_TOKEN`、`GITHUB_REPO` 和 `GITHUB_AUTO_UPLOAD=true`。

### Q: 数据存储在何处？
A: 默认存储在 `/app/data` 目录（Docker）或 `./data` 目录（本地运行）。

### Q: 如何查看日志？
A: Docker: `docker-compose logs -f`；本地：直接在终端查看。

## License

MIT
