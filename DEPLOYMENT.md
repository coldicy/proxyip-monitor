# Proxy Monitor 部署指南

本文档提供详细的 Docker 打包和部署流程。

## 📋 前置要求

- Docker 20.10+ 
- Docker Compose 2.0+
- Node.js 18+ (仅源码部署需要)
- 至少 512MB 可用内存
- 100MB 可用磁盘空间

## 🚀 快速部署 (推荐)

### 方式一：Docker Compose

这是最简单推荐的部署方式。

```bash
# 1. 克隆仓库
git clone <repository-url>
cd proxy-monitor

# 2. 配置环境变量 (可选)
cp .env.example .env
# 编辑 .env 文件自定义配置

# 3. 启动服务
docker-compose up -d

# 4. 查看日志
docker-compose logs -f

# 5. 访问服务
# 浏览器打开 http://localhost:8787
```

### 方式二：单独 Docker 容器

```bash
# 1. 构建镜像
docker build -t proxy-monitor:latest .

# 2. 创建数据目录
mkdir -p ./data ./config

# 3. 运行容器
docker run -d \
  --name proxy-monitor \
  -p 8787:8787 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  -e NODE_ENV=production \
  -e INTERVAL_SEC=60 \
  -e CONCURRENCY=50 \
  --restart unless-stopped \
  proxy-monitor:latest

# 4. 查看日志
docker logs -f proxy-monitor

# 5. 访问服务
# 浏览器打开 http://localhost:8787
```

## 🔧 高级部署

### 生产环境配置

#### 1. 使用 Docker Swarm

```yaml
# docker-swarm.yml
version: '3.8'

services:
  proxy-monitor:
    image: proxy-monitor:latest
    ports:
      - "8787:8787"
    volumes:
      - proxy-data:/app/data
      - proxy-config:/app/config
    environment:
      - NODE_ENV=production
      - INTERVAL_SEC=60
      - CONCURRENCY=100
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
      resources:
        limits:
          cpus: '1'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M

volumes:
  proxy-data:
  proxy-config:
```

部署命令:
```bash
docker stack deploy -c docker-swarm.yml proxy-monitor
```

#### 2. Kubernetes 部署

```yaml
# k8s-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: proxy-monitor
  labels:
    app: proxy-monitor
spec:
  replicas: 1
  selector:
    matchLabels:
      app: proxy-monitor
  template:
    metadata:
      labels:
        app: proxy-monitor
    spec:
      containers:
      - name: proxy-monitor
        image: proxy-monitor:latest
        ports:
        - containerPort: 8787
        env:
        - name: NODE_ENV
          value: "production"
        - name: INTERVAL_SEC
          value: "60"
        - name: CONCURRENCY
          value: "100"
        volumeMounts:
        - name: data
          mountPath: /app/data
        - name: config
          mountPath: /app/config
        livenessProbe:
          httpGet:
            path: /health
            port: 8787
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 8787
          initialDelaySeconds: 5
          periodSeconds: 10
        resources:
          limits:
            cpu: "1"
            memory: "512Mi"
          requests:
            cpu: "500m"
            memory: "256Mi"
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: proxy-data-pvc
      - name: config
        persistentVolumeClaim:
          claimName: proxy-config-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: proxy-monitor-service
spec:
  selector:
    app: proxy-monitor
  ports:
  - protocol: TCP
    port: 8787
    targetPort: 8787
  type: ClusterIP
```

部署命令:
```bash
kubectl apply -f k8s-deployment.yaml
```

### 源码部署

适合开发和自定义场景。

```bash
# 1. 克隆仓库
git clone <repository-url>
cd proxy-monitor

# 2. 进入后端目录
cd backend

# 3. 安装依赖
npm install

# 4. 编译 TypeScript
npm run build

# 5. 启动服务
npm start

# 或使用开发模式 (自动重载)
npm run dev
```

## ⚙️ 配置说明

### 环境变量详解

| 变量名 | 默认值 | 说明 | 建议值 |
|--------|--------|------|--------|
| `NODE_ENV` | development | 运行环境 | production |
| `PORT` | 8787 | 服务端口 | 根据实际调整 |
| `DATA_DIR` | /app/data | 数据目录 | 保持默认 |
| `INTERVAL_SEC` | 60 | 检测间隔 (秒) | 30-300 |
| `CONCURRENCY` | 50 | 并发检测数 | 根据网络调整 |
| `TIMEOUT_SEC` | 5 | 超时时间 (秒) | 3-10 |
| `SPEED_ENABLED` | true | 启用测速 | true/false |
| `SPEED_URL` | Cloudflare | 测速地址 | 可自定义 |
| `GITHUB_TOKEN` | - | GitHub Token | 可选 |
| `GITHUB_REPO` | - | GitHub 仓库 | 可选 |

### 性能调优建议

#### 低配环境 (< 512MB 内存)
```bash
CONCURRENCY=20
INTERVAL_SEC=120
SPEED_CONCURRENCY=1
```

#### 中配环境 (512MB - 1GB 内存)
```bash
CONCURRENCY=50
INTERVAL_SEC=60
SPEED_CONCURRENCY=2
```

#### 高配环境 (> 1GB 内存)
```bash
CONCURRENCY=100
INTERVAL_SEC=30
SPEED_CONCURRENCY=3
```

## 📊 监控和维护

### 健康检查

```bash
# 检查服务状态
curl http://localhost:8787/health

# 查看当前状态
curl http://localhost:8787/api/state

# 查看日志
curl http://localhost:8787/api/logs
```

### 数据备份

```bash
# 备份数据目录
tar -czf proxy-monitor-backup-$(date +%Y%m%d).tar.gz ./data

# 恢复数据
tar -xzf proxy-monitor-backup-*.tar.gz -C ./
```

### 日志管理

```bash
# Docker Compose 查看日志
docker-compose logs -f

# 限制日志大小 (docker-compose.yml)
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

### 更新升级

```bash
# Docker Compose 更新
docker-compose pull
docker-compose up -d --force-recreate

# 单独容器更新
docker stop proxy-monitor
docker rm proxy-monitor
docker run [原参数] proxy-monitor:latest
```

## 🐛 故障排查

### 常见问题

#### 1. 容器无法启动
```bash
# 查看详细错误
docker-compose logs

# 检查端口占用
netstat -tlnp | grep 8787

# 检查权限
ls -la ./data ./config
```

#### 2. 节点检测失败
- 检查网络连接
- 增加超时时间 `TIMEOUT_SEC=10`
- 降低并发数 `CONCURRENCY=20`
- 确认 DNS 解析正常

#### 3. 内存占用过高
- 降低并发数
- 缩短历史记录窗口 `QUALITY_WINDOW=5`
- 定期清理数据

#### 4. 数据丢失
确保正确挂载卷:
```yaml
volumes:
  - ./data:/app/data
```

### 获取帮助

```bash
# 查看容器信息
docker inspect proxy-monitor

# 进入容器调试
docker exec -it proxy-monitor sh

# 重启服务
docker-compose restart
```

## 📈 性能基准

在标准测试环境下 (4 核 2GB):

- 并发 50: 检测 1000 个 IP 约 2-3 分钟
- 并发 100: 检测 1000 个 IP 约 1-2 分钟
- 内存占用: 约 200-300MB
- CPU 占用: 检测时 20-40%, 空闲时 <5%

## 🔒 安全建议

1. **不要暴露到公网**: 除非必要，建议使用内网访问
2. **使用反向代理**: 通过 Nginx 等提供 HTTPS
3. **限制并发数**: 避免被误认为 DDoS 攻击
4. **定期更新**: 保持最新版本获取安全修复

## 📝 许可证

MIT License
