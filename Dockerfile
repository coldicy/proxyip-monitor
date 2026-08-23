FROM golang:1.19-alpine AS builder

RUN apk add --no-cache curl

WORKDIR /app

COPY go.mod ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY web/ ./web/

RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o server ./cmd/server

FROM alpine:latest

RUN apk add --no-cache curl ca-certificates

WORKDIR /app

COPY --from=builder /app/server .
COPY --from=builder /app/web/dist/index.html ./public/index.html

RUN mkdir -p /app/config /app/data

EXPOSE 8787

CMD ["./server"]