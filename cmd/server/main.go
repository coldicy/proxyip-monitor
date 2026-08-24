package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"proxy-monitor/internal/config"
	"proxy-monitor/internal/handler"
	"proxy-monitor/internal/service"
	"proxy-monitor/internal/store"
)

const VERSION = "2.0.0"

func main() {
	log.Printf("Proxy Monitor v%s starting...", VERSION)

	cfg := config.GetConfig()
	
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = cfg.GetDataDir()
	}
	
	port := os.Getenv("PORT")
	if port == "" {
		port = fmt.Sprintf("%d", cfg.GetPort())
	}

	interval := os.Getenv("INTERVAL_SEC")
	if interval != "" {
		var i int
		fmt.Sscanf(interval, "%d", &i)
		if i > 0 {
			cfg.Update(cfg.GetPort(), i, cfg.GitHubToken, cfg.GitHubRepo, cfg.GitHubBranch)
		}
	}

	store := store.NewStore(dataDir)
	monitorSvc := service.NewMonitorService(cfg, store)
	h := handler.NewHandler(monitorSvc, cfg)

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	api := r.Group("/api")
	{
		api.GET("/state", h.GetState)
		api.GET("/nodes", h.GetNodes)
		api.POST("/control/start", h.StartMonitor)
		api.POST("/control/stop", h.StopMonitor)
		api.POST("/node", h.AddNode)
		api.DELETE("/node/:id", h.DeleteNode)
		api.POST("/node/:id/speedtest", h.SpeedTest)
		api.PUT("/config", h.UpdateConfig)
		api.GET("/config", h.GetConfig)
	}
	
	r.GET("/health", h.HealthCheck)
	r.StaticFile("/", "./web/dist/index.html")
	r.Static("/assets", "./web/dist/assets")
	r.Static("/public", "./web/public")

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("Starting HTTP server on port %s", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	monitorSvc.Start()
	log.Println("Monitor service started")

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")
	monitorSvc.Stop()
	
	if err := store.Save(); err != nil {
		log.Printf("Error saving state: %v", err)
	}

	log.Println("Proxy Monitor stopped")
}
