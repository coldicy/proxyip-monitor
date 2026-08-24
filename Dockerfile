# Build stage
FROM golang:1.19-alpine AS builder

RUN apk add --no-cache git gcc musl-dev

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o proxy-monitor ./cmd/server

# Runtime stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

COPY --from=builder /build/proxy-monitor .
COPY --from=builder /build/web/dist ./web/dist
COPY --from=builder /build/web/public ./web/public

EXPOSE 8787

ENV PORT=8787
ENV DATA_DIR=/app/data
ENV INTERVAL_SEC=60

VOLUME ["/app/data"]

ENTRYPOINT ["./proxy-monitor"]
