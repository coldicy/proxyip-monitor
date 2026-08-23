# 多阶段构建 - 编译阶段
FROM golang:1.21-alpine AS builder

RUN apk add --no-cache curl git

WORKDIR /app

COPY go.mod ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY web/ ./web/

# 静态编译，禁用 CGO
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server ./cmd/server

# 运行阶段 - 使用 distroless 镜像
FROM gcr.io/distroless/static-debian11:nonroot

WORKDIR /app

COPY --from=builder /app/server .
COPY --from=builder /app/web/dist/index.html ./web/dist/index.html

# 创建数据目录
USER nonroot

EXPOSE 8787

ENTRYPOINT ["./server"]