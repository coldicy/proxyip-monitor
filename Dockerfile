FROM node:20-alpine AS builder

WORKDIR /app

# 安装必要的依赖
RUN apk add --no-cache curl

# 复制应用文件
COPY server.js ./server.js
COPY public ./public

# 创建数据目录
RUN mkdir -p /app/config /app/data

# 暴露端口
EXPOSE 8787

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8787/api/state || exit 1

# 启动应用
CMD ["node", "server.js"]
