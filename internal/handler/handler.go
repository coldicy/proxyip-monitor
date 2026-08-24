package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"proxy-monitor/internal/config"
	"proxy-monitor/internal/service"
)

type Handler struct {
	monitorSvc *service.MonitorService
	config     *config.Config
}

func NewHandler(monitorSvc *service.MonitorService, cfg *config.Config) *Handler {
	return &Handler{
		monitorSvc: monitorSvc,
		config:     cfg,
	}
}

func (h *Handler) GetState(c *gin.Context) {
	state := h.monitorSvc.GetState()
	c.JSON(http.StatusOK, state)
}

func (h *Handler) GetNodes(c *gin.Context) {
	nodes := h.monitorSvc.GetAllNodes()
	c.JSON(http.StatusOK, nodes)
}

func (h *Handler) StartMonitor(c *gin.Context) {
	h.monitorSvc.Start()
	c.JSON(http.StatusOK, gin.H{"status": "started"})
}

func (h *Handler) StopMonitor(c *gin.Context) {
	h.monitorSvc.Stop()
	c.JSON(http.StatusOK, gin.H{"status": "stopped"})
}

func (h *Handler) AddNode(c *gin.Context) {
	var req struct {
		URL string `json:"url" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	nodeID := h.monitorSvc.AddManualNode(req.URL)
	c.JSON(http.StatusOK, gin.H{"id": nodeID})
}

func (h *Handler) DeleteNode(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "node id required"})
		return
	}

	h.monitorSvc.RemoveNode(id)
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

func (h *Handler) SpeedTest(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "node id required"})
		return
	}

	result, err := h.monitorSvc.TriggerSpeedTest(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

func (h *Handler) UpdateConfig(c *gin.Context) {
	var req struct {
		Port       int    `json:"port"`
		Interval   int    `json:"interval_sec"`
		GitHubToken string `json:"github_token"`
		GitHubRepo string `json:"github_repo"`
		GitHubBranch string `json:"github_branch"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Interval > 0 {
		req.Port = h.config.GetPort()
	}
	
	h.config.Update(req.Port, req.Interval, req.GitHubToken, req.GitHubRepo, req.GitHubBranch)
	if err := h.config.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "updated"})
}

func (h *Handler) GetConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"port":            h.config.GetPort(),
		"interval_sec":    h.config.GetInterval().Seconds(),
		"github_repo":     h.config.GitHubRepo,
		"github_branch":   h.config.GitHubBranch,
	})
}

func (h *Handler) HealthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status": "healthy",
		"version": "2.0.0",
	})
}
