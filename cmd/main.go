package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"proxy-monitor/internal/config"
	"proxy-monitor/internal/handler"
	"proxy-monitor/internal/service"
	"syscall"
)

func main() {
	// 解析命令行参数
	configPath := flag.String("config", "", "配置文件路径")
	flag.Parse()

	// 初始化配置
	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("加载配置失败：%v", err)
	}

	// 初始化服务
	svc, err := service.NewService(cfg)
	if err != nil {
		log.Fatalf("初始化服务失败：%v", err)
	}

	// 启动 HTTP 服务器
	server := handler.NewServer(cfg, svc)

	// 优雅关闭
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		addr := fmt.Sprintf(":%d", cfg.Port)
		log.Printf("🚀 Proxy Monitor %s on http://0.0.0.0%s", config.Version, addr)
		if err := server.ListenAndServe(); err != nil {
			log.Printf("HTTP 服务器错误：%v", err)
		}
	}()

	// 等待退出信号
	sig := <-sigChan
	log.Printf("收到信号 %v，正在关闭...", sig)
	svc.Shutdown()
	log.Println("服务已关闭")
}
