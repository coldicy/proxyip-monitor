package handler

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"proxy-monitor/internal/config"
	"proxy-monitor/internal/service"
	"strings"
	"time"
)

//go:embed static/*
var staticFS embed.FS

// Server HTTP 服务器
type Server struct {
	cfg     *config.Config
	svc     *service.Service
	mux     *http.ServeMux
	httpSrv *http.Server
}

// NewServer 创建新服务器
func NewServer(cfg *config.Config, svc *service.Service) *Server {
	s := &Server{
		cfg: cfg,
		svc: svc,
		mux: http.NewServeMux(),
	}
	s.setupRoutes()

	addr := fmt.Sprintf(":%d", cfg.Port)
	s.httpSrv = &http.Server{
		Addr:         addr,
		Handler:      s.mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	return s
}

// ListenAndServe 启动 HTTP 服务器
func (s *Server) ListenAndServe() error {
	return s.httpSrv.ListenAndServe()
}

// Shutdown 优雅关闭服务器
func (s *Server) Shutdown(ctx context.Context) error {
	return s.httpSrv.Shutdown(ctx)
}

func (s *Server) setupRoutes() {
	// API 路由
	s.mux.HandleFunc("/api/state", s.handleState)
	s.mux.HandleFunc("/api/config", s.handleConfig)
	s.mux.HandleFunc("/api/ipfile", s.handleIPFile)
	s.mux.HandleFunc("/api/graveyard", s.handleGraveyard)
	s.mux.HandleFunc("/api/nodes/remove", s.handleRemoveNodes)
	s.mux.HandleFunc("/api/check/trigger", s.handleTriggerCheck)
	s.mux.HandleFunc("/api/check/abort", s.handleAbortCheck)

	// 静态文件服务（前端）
	s.mux.HandleFunc("/", s.handleStatic)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	state := s.svc.GetState()
	s.writeJSON(w, state)
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg := s.svc.GetConfig()
		s.writeJSON(w, cfg)
	case http.MethodPost:
		var data map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
			s.writeError(w, "解析配置失败："+err.Error(), http.StatusBadRequest)
			return
		}
		if err := s.svc.UpdateConfig(data); err != nil {
			s.writeError(w, "更新配置失败："+err.Error(), http.StatusInternalServerError)
			return
		}
		s.writeJSON(w, map[string]string{"status": "ok"})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleIPFile(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		content, err := s.svc.GetIPFile()
		if err != nil {
			s.writeError(w, "读取 IP 文件失败："+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte(content))
	case http.MethodPost:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			s.writeError(w, "读取请求体失败："+err.Error(), http.StatusBadRequest)
			return
		}
		if err := s.svc.SaveIPFile(string(body)); err != nil {
			s.writeError(w, "保存 IP 文件失败："+err.Error(), http.StatusInternalServerError)
			return
		}
		s.writeJSON(w, map[string]string{"status": "ok"})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleGraveyard(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		g := s.svc.GetGraveyard()
		s.writeJSON(w, g)
	case http.MethodDelete:
		s.svc.ClearGraveyard()
		s.writeJSON(w, map[string]string{"status": "ok"})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleRemoveNodes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, "解析请求失败："+err.Error(), http.StatusBadRequest)
		return
	}

	removed := s.svc.RemoveNodes(req.IDs)
	s.writeJSON(w, map[string]int{"removed": removed})
}

func (s *Server) handleTriggerCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	s.svc.TriggerCheck()
	s.writeJSON(w, map[string]string{"status": "checking"})
}

func (s *Server) handleAbortCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	s.svc.AbortCheck()
	s.writeJSON(w, map[string]string{"status": "aborted"})
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	// 如果不是 API 路径，则提供静态文件
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}

	// 从嵌入的文件系统中读取 index.html
	f, err := staticFS.Open("static/index.html")
	if err != nil {
		http.Error(w, "Frontend not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	data, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "Error reading frontend", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(data)
}

func (s *Server) writeJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func (s *Server) writeError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// GetStaticFS 获取静态文件系统用于外部访问
func GetStaticFS() (fs.FS, error) {
	return fs.Sub(staticFS, "static")
}
