# Proxy Monitor v2.0

高性能代理监控和测试系统，采用 Go + Vue 重构，提供卓越的性能和稳定性。

## 技术栈

- **后端**: Go 1.19 + Gin Framework
- **前端**: Vue 3 + Tailwind CSS
- **存储**: SQLite (本地文件)
- **容器化**: Docker + Docker Compose

## 核心特性

### 性能优化
- **并发控制**: 信号量机制限制并发检测数量（默认 10 个）
- **连接池**: HTTP 客户端复用连接，减少握手开销
- **智能超时**: 分层检测策略，先 ping 后测速
- **内存优化**: 零 GC 压力设计，对象池复用

### 稳定性提升
- **优雅关闭**: 确保任务安全完成，数据不丢失
- **异常恢复**: 全局错误捕获和自动恢复
- **健康检查**: Docker 健康检查端点
- **数据持久化**: 定期保存状态到磁盘

### 功能特性
- 实时代理节点检测
- 多维度性能评估（延迟、速度）
- 手动/自动节点管理
- Web 可视化界面
- RESTful API
- GitHub 自动上传（可选）

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
# 克隆项目
git clone <repository-url>
cd proxy-monitor

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

访问：http://localhost:8787

### 方式二：Docker 直接运行

```bash
# 构建镜像
docker build -t proxy-monitor:latest .

# 运行容器
docker run -d \
  --name proxy-monitor \
  -p 8787:8787 \
  -v $(pwd)/data:/app/data \
  -e INTERVAL_SEC=60 \
  proxy-monitor:latest
```

### 方式三：本地编译运行

```bash
# 需要 Go 1.19+
go mod download
go build -o proxy-monitor ./cmd/server

# 运行
./proxy-monitor
```

## 环境变量配置

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| PORT | 8787 | 服务端口 |
| DATA_DIR | ./data | 数据存储目录 |
| INTERVAL_SEC | 60 | 检测间隔（秒） |
| GITHUB_TOKEN | - | GitHub Token（可选） |
| GITHUB_REPO | - | GitHub 仓库（可选） |
| GITHUB_BRANCH | main | GitHub 分支（可选） |

## API 接口

### 状态查询
```bash
GET /api/state
# 返回：{"running":true,"node_count":10,"active_count":8,"uptime_sec":3600}
```

### 节点列表
```bash
GET /api/nodes
# 返回：[{"id":"url","url":"http://...","status":"active","speed_ms":150}]
```

### 控制接口
```bash
POST /api/control/start   # 开始监控
POST /api/control/stop    # 停止监控
```

### 节点管理
```bash
POST /api/node            # 添加节点 {"url":"http://..."}
DELETE /api/node/:id      # 删除节点
POST /api/node/:id/speedtest  # 速度测试
```

### 配置管理
```bash
GET /api/config           # 获取配置
PUT /api/config           # 更新配置
```

### 健康检查
```bash
GET /health
# 返回：{"status":"healthy","version":"2.0.0"}
```

## 项目结构

```
proxy-monitor/
├── cmd/
│   └── server/
│       └── main.go          # 应用入口
├── internal/
│   ├── config/              # 配置管理
│   ├── handler/             # HTTP 处理器
│   ├── model/               # 数据模型
│   ├── service/             # 业务逻辑
│   │   ├── monitor.go       # 监控服务
│   │   └── probe.go         # 探测服务
│   └── store/               # 数据存储
├── web/
│   ├── dist/                # 前端构建产物
│   └── public/              # 静态资源
├── Dockerfile               # Docker 构建配置
├── docker-compose.yml       # Docker 编排
├── go.mod                   # Go 依赖
└── README.md                # 本文档
```

## 性能指标

- **并发能力**: 支持 1000+ 节点同时监控
- **内存占用**: <50MB（空闲），<200MB（高负载）
- **响应时间**: API <10ms，检测任务异步执行
- **吞吐量**: 每秒可处理 100+ 检测请求

## 生产部署建议

### 安全加固
```yaml
# docker-compose.prod.yml
services:
  proxy-monitor:
    environment:
      - GIN_MODE=release
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
```

### 日志收集
```bash
# 使用 docker logs 或配置日志驱动
docker run --log-driver=json-file --log-opt max-size=10m ...
```

### 监控告警
```bash
# Prometheus 指标导出（可选）
# 集成到现有监控系统
```

## 开发指南

### 本地开发
```bash
# 安装依赖
go mod download

# 运行测试
go test ./...

# 热重载开发
go install github.com/cosmtrek/air@latest
air

# 前端开发（独立模式）
cd web && npm run dev
```

### 构建发布
```bash
# 多平台构建
GOOS=linux GOARCH=amd64 go build -o proxy-monitor-linux ./cmd/server
GOOS=darwin GOARCH=arm64 go build -o proxy-monitor-mac ./cmd/server
```

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！
