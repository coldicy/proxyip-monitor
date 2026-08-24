# 多阶段构建 - 减小镜像体积
FROM node:20-alpine AS builder

# 安装 curl 用于网络探测
RUN apk add --no-cache curl

WORKDIR /app
COPY server.js ./server.js
COPY public ./public

# 验证代码语法
RUN node --check server.js

# 生产镜像
FROM node:20-alpine

# 安装必要的系统工具
RUN apk add --no-cache curl dumb-init

# 创建非 root 用户运行应用
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# 复制文件
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/public ./public

# 创建数据目录并设置权限
RUN mkdir -p /app/config /app/data && \
    chown -R appuser:appgroup /app

# 切换到非 root 用户
USER appuser

# 暴露端口
EXPOSE 8787

# 使用 dumb-init 作为 init 系统处理信号
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# 启动应用
CMD ["node", "server.js"]