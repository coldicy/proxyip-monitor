# 构建阶段
FROM golang:1.21-alpine AS builder

WORKDIR /build

# 安装必要的依赖
RUN apk add --no-cache git curl

# 设置 Go 代理（可选，国内用户可取消注释）
# ENV GOPROXY=https://goproxy.cn,direct
ENV GOCACHE=/root/.cache/go-build
ENV GOMODCACHE=/root/go/pkg/mod

# 复制 go.mod 和 go.sum
COPY go.mod go.sum ./
RUN go mod download

# 复制源代码
COPY . .

# 编译优化：使用 CGO_ENABLED=0 获得静态二进制文件
# -ldflags="-s -w" 去除调试信息，减小二进制大小
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o proxy-monitor ./cmd/

# 运行阶段
FROM alpine:3.19

# 安装运行时依赖（curl 用于健康检查）
RUN apk add --no-cache curl ca-certificates && \
    addgroup -g 1000 app && \
    adduser -u 1000 -G app -D app && \
    mkdir -p /app/data /app/config && \
    chown -R app:app /app

WORKDIR /app

# 从构建阶段复制二进制文件
COPY --from=builder /build/proxy-monitor /app/proxy-monitor

# 设置权限
RUN chown app:app /app/proxy-monitor

USER app

# 暴露端口
EXPOSE 8787

# 健康检查（每 30 秒检查一次，超时 10 秒，启动宽限期 5 秒，重试 3 次）
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8787/api/state || exit 1

# 启动应用（支持命令行参数）
ENTRYPOINT ["/app/proxy-monitor"]
CMD []
