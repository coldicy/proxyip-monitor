# Proxy Monitor v2.0

高性能代理服务器监控和测试系统，支持批量 IP 检测、速度测试和质量评估。采用 TypeScript 重构，具有更好的性能、稳定性和可维护性。

## 🚀 功能特性

- **实时代理检测**: 自动检测代理节点的可用性和延迟
- **多维度性能评估**: TCP/TLS/HTTP 分段计时，精准定位性能瓶颈
- **速度测试**: 自动测速并记录历史数据
- **可视化界面**: 现代化的 Web 管理界面
- **GitHub 自动上传**: 将优质节点自动上传到 GitHub 仓库
- **数据持久化**: SQLite + JSON 双重存储，确保数据安全
- **自定义探针**: 支持配置多个自定义检测目标
- **并发控制**: 可配置的并发检测数量
- **自动清理**: 定期清理过期数据，保持系统轻量

## 📦 快速开始

### 方式一：Docker Compose (推荐)

```bash
# 克隆仓库
git clone <repository-url>
cd proxy-monitor

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
  -v $(pwd)/config:/app/config \
  -e INTERVAL_SEC=60 \
  -e CONCURRENCY=50 \
  proxy-monitor:latest
```

### 方式三：源码运行

```bash
# 进入后端目录
cd backend

# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 启动服务
npm start
```

## ⚙️ 环境配置

所有配置通过环境变量进行设置：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | 8787 | 服务端口 |
| `DATA_DIR` | /app/data | 数据目录 |
| `INTERVAL_SEC` | 60 | 检测间隔 (秒) |
| `CONCURRENCY` | 50 | 并发检测数 |
| `TIMEOUT_SEC` | 5 | 超时时间 (秒) |
| `SPEED_ENABLED` | true | 是否启用测速 |
| `SPEED_URL` | https://speed.cloudflare.com/__down?bytes=20000000 | 测速地址 |
| `PROBE_URL` | https://www.cloudflare.com/cdn-cgi/trace | 探针地址 |
| `GITHUB_TOKEN` | - | GitHub Token (可选) |
| `GITHUB_REPO` | - | GitHub 仓库 (可选) |
| `GITHUB_BRANCH` | main | GitHub 分支 |

### Docker Compose 配置示例

```yaml
environment:
  - NODE_ENV=production
  - PORT=8787
  - DATA_DIR=/app/data
  - INTERVAL_SEC=60
  - CONCURRENCY=50
  - TIMEOUT_SEC=5
  - SPEED_ENABLED=true
  - GITHUB_TOKEN=ghp_xxx
  - GITHUB_REPO=username/proxy-ips
  - GITHUB_BRANCH=main
```

## 📊 API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/state` | GET | 获取当前状态 |
| `/api/logs` | GET | 获取日志 |
| `/api/config` | GET | 获取配置 |
| `/api/config` | POST | 更新配置 |
| `/api/check` | POST | 立即检测 |
| `/api/abort` | POST | 中断检测 |
| `/api/upload` | POST | 上传到 GitHub |
| `/api/graveyard` | GET | 获取墓地列表 |
| `/api/graveyard/clear` | POST | 清空墓地 |
| `/api/graveyard/unblock` | POST | 解封节点 |
| `/api/remove` | POST | 删除节点 |
| `/api/speedtest` | POST | 手动测速 |
| `/health` | GET | 健康检查 |

## 📁 项目结构

```
proxy-monitor/
├── backend/
│   ├── src/
│   │   ├── config/          # 配置管理
│   │   ├── controllers/     # API 控制器
│   │   ├── services/        # 业务服务
│   │   ├── types/           # TypeScript 类型定义
│   │   ├── utils/           # 工具函数
│   │   └── index.ts         # 入口文件
│   ├── public/              # 静态文件
│   ├── package.json
│   └── tsconfig.json
├── data/                    # 数据目录 (运行时创建)
├── config/                  # 配置目录 (运行时创建)
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## 🔧 高级用法

### 自定义探针

可以通过环境变量配置多个自定义探针：

```bash
CUSTOM_PROBES='[{"url":"https://www.google.com","expect":"200"},{"url":"https://www.github.com","expect":"200"}]'
```

### 数据持久化

数据存储在 `/app/data` 目录，包括：
- `history.json`: 节点历史记录
- `graveyard.json`: 失效节点记录
- `proxy.db`: SQLite 数据库
- `config.json`: 运行时配置
- `iplist.txt`: IP 列表文件

### GitHub 自动上传

配置后会自动将优质节点上传到指定仓库：

```bash
docker run -d \
  -e GITHUB_TOKEN=ghp_xxx \
  -e GITHUB_REPO=username/proxy-ips \
  -e GITHUB_BRANCH=main \
  proxy-monitor:latest
```

## 🛠️ 开发指南

### 本地开发

```bash
cd backend
npm install
npm run dev
```

### 构建 Docker 镜像

```bash
docker build -t proxy-monitor:latest .
```

### 运行测试

```bash
npm test
```

## 📈 性能优化

v2.0 版本相比原始版本有以下优化：

1. **TypeScript 类型安全**: 完整的类型定义，减少运行时错误
2. **模块化架构**: 清晰的服务分层，便于维护和扩展
3. **内存管理**: 优化的数据结构，减少内存占用
4. **并发控制**: 批次处理节点检测，避免资源耗尽
5. **数据缓存**: SQLite + JSON 双重存储策略
6. **优雅关闭**: 支持 SIGTERM/SIGINT 信号处理

## 🐛 故障排查

### 容器无法启动

```bash
# 查看日志
docker-compose logs

# 检查端口占用
netstat -tlnp | grep 8787
```

### 节点检测失败

1. 检查网络连接
2. 确认 curl 已安装
3. 调整超时时间 `TIMEOUT_SEC`
4. 降低并发数 `CONCURRENCY`

### 数据丢失

确保正确挂载了数据卷：
```yaml
volumes:
  - ./data:/app/data
```

## 📝 更新日志

### v2.0.0
- ✨ 使用 TypeScript 重构全部代码
- ✨ 新增模块化服务架构
- ✨ 新增 SQLite 数据持久化
- ✨ 新增优雅的关闭处理
- 🐛 修复内存泄漏问题
- 🐛 修复并发控制问题
- ⚡ 提升整体性能 30%+

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！
