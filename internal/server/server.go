package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"proxy-monitor/internal/config"
	"proxy-monitor/internal/detector"
	"proxy-monitor/internal/models"
	"proxy-monitor/internal/storage"
)

// Server HTTP 服务器
type Server struct {
	mu        sync.RWMutex
	cfg       *config.Config
	detector  *detector.Detector
	storage   *storage.Storage
	checking  bool
	abort     bool
	progress  Progress
	lastCycle *time.Time
	logs      []LogEntry
	github    GitHubState
	httpSrv   *http.Server
}

type Progress struct {
	Tested int `json:"tested"`
	Total  int `json:"total"`
}

type LogEntry struct {
	T int64  `json:"t"`
	M string `json:"m"`
}

type GitHubState struct {
	LastUpload *time.Time `json:"lastUpload,omitempty"`
	LastError  *string    `json:"lastError,omitempty"`
}

// NewServer 创建服务器
func NewServer(cfg *config.Config) *Server {
	det := detector.NewDetector(cfg)
	stor := storage.NewStorage(cfg.DataFile, cfg.GraveyardFile, cfg.MaxHistory)

	s := &Server{
		cfg:      cfg,
		detector: det,
		storage:  stor,
		logs:     []LogEntry{},
		github:   GitHubState{},
	}

	return s
}

// Initialize 初始化服务器
func (s *Server) Initialize() error {
	// 加载存储数据
	if err := s.storage.Load(); err != nil {
		log.Printf("⚠️ 加载历史数据失败：%v", err)
	}

	// 回填最后在线时间
	s.storage.BackfillLastOnline()

	// 确保 IP 文件存在
	if err := s.cfg.EnsureIPFile(); err != nil {
		return fmt.Errorf("创建 IP 文件失败：%w", err)
	}

	// 初始发现节点
	if err := s.detector.RefreshCfCidrs(true); err != nil {
		log.Printf("⚠️ 更新 CF CIDR 失败：%v", err)
	}

	added, err := s.detector.Discover(s.storage.GetUnits(), nil, func() map[string]int64 {
		all := s.storage.GetUnits()
		blocked := make(map[string]int64)
		for id := range all {
			if s.storage.IsBlocked(id) {
				blocked[id] = time.Now().UnixMilli()
			}
		}
		return blocked
	}())

	if err != nil {
		log.Printf("⚠️ 发现节点失败：%v", err)
	} else if added > 0 {
		log.Printf("🆕 发现 %d 个新节点", added)
	}

	// 网络就绪检查
	if ready := waitNetworkReady(s.cfg, 45000, 5000); !ready {
		log.Println("⚠️ 启动后等待 45 秒网络仍未就绪，开启无效轮保护进行首轮检测")
	} else {
		log.Println("🌐 启动网络检查通过")
	}

	return nil
}

// Start 启动服务器
func (s *Server) Start() error {
	// 启动检测周期
	go s.startDetectionLoop()

	// 启动定时上传
	if s.cfg.GitHub.Auto && s.cfg.GitHub.Token != "" && s.cfg.GitHub.Repo != "" {
		interval := s.cfg.GitHub.UploadIntervalMin
		if interval > 0 {
			go s.startUploadLoop(interval)
		}
	}

	// 设置 HTTP 路由
	http.HandleFunc("/", s.handleRequest)

	addr := fmt.Sprintf(":%d", s.cfg.Port)
	s.httpSrv = &http.Server{Addr: addr, Handler: http.DefaultServeMux}

	// 优雅关闭
	go func() {
		sigChan := make(chan os.Signal, 1)
		// signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		log.Println("🛑 收到退出信号，优雅关闭...")
		s.httpSrv.Close()
	}()

	log.Printf("🚀 Proxy Monitor on http://0.0.0.0%s", addr)
	s.addLog(fmt.Sprintf("🚀 服务启动 (v36-window-go)"))

	return s.httpSrv.ListenAndServe()
}

func (s *Server) startDetectionLoop() {
	// 立即执行一次
	s.runCycle()

	ticker := time.NewTicker(time.Duration(s.cfg.IntervalSec) * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		s.runCycle()
	}
}

func (s *Server) startUploadLoop(intervalMin int) {
	ticker := time.NewTicker(time.Duration(intervalMin) * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		log.Println("⏰ 定时触发 GitHub 上传")
		if err := s.uploadGithub(); err != nil {
			errStr := err.Error()
			s.github.LastError = &errStr
			log.Printf("⚠️ 定时上传失败：%v", err)
		}
	}
}

func (s *Server) handleRequest(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	jsonResp := func(data interface{}, status int) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		enc := json.NewEncoder(w)
		enc.Encode(data)
	}

	switch {
	case path == "/" || path == "/index.html":
		s.serveIndex(w)
	case path == "/api/state" && r.Method == "GET":
		jsonResp(s.buildState(), 200)
	case path == "/api/logs" && r.Method == "GET":
		jsonResp(map[string]interface{}{"logs": s.logs}, 200)
	case path == "/api/abort" && r.Method == "POST":
		if s.checking {
			s.abort = true
			s.addLog("⏹ 收到中断请求")
		}
		jsonResp(map[string]interface{}{"ok": true}, 200)
	case path == "/api/graveyard" && r.Method == "GET":
		jsonResp(map[string]interface{}{"graveyard": s.storage.GetGraveyard()}, 200)
	case path == "/api/graveyard/clear" && r.Method == "POST":
		s.storage.ClearGraveyard()
		jsonResp(map[string]interface{}{"ok": true}, 200)
	default:
		jsonResp(map[string]string{"error": "not found"}, 404)
	}
}

func (s *Server) serveIndex(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	html, err := os.ReadFile("web/dist/index.html")
	if err != nil {
		html = []byte(`<!DOCTYPE html><html><head><title>Loading...</title></head><body><h1>Loading...</h1></body></html>`)
	}
	w.Write(html)
}

func (s *Server) addLog(msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs = append(s.logs, LogEntry{T: time.Now().UnixMilli(), M: msg})
	if len(s.logs) > 400 {
		s.logs = s.logs[len(s.logs)-400:]
	}
}

func (s *Server) buildState() interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	units := s.storage.GetUnits()
	unitList := make([]*models.Unit, 0, len(units))
	for _, u := range units {
		unitList = append(unitList, u)
	}

	return map[string]interface{}{
		"units":     unitList,
		"history":   func() map[string][]*models.HistoryEntry {
			all := s.storage.GetUnits()
			hist := make(map[string][]*models.HistoryEntry)
			for id := range all {
				hist[id] = s.storage.GetHistory(id)
			}
			return hist
		}(),
		"progress":  s.progress,
		"checking":  s.checking,
		"lastCycle": s.lastCycle,
		"github":    s.github,
		"graveyard": s.storage.GetGraveyard(),
		"cfg":       s.cfg.PublicConfig(),
	}
}

func (s *Server) runCycle() {
	s.mu.Lock()
	if s.checking {
		s.mu.Unlock()
		log.Println("⚠️ 上一轮检测尚未完成，跳过本轮")
		return
	}
	s.checking = true
	s.abort = false
	s.progress = Progress{Tested: 0, Total: 0}
	s.lastCycle = func() *time.Time { t := time.Now(); return &t }()
	s.mu.Unlock()

	log.Println("🔄 检测周期开始")
	defer func() {
		s.mu.Lock()
		s.checking = false
		s.mu.Unlock()
		log.Println("✅ 检测周期完成")
	}()

	units := s.storage.GetUnits()
	total := len(units)
	s.mu.Lock()
	s.progress.Total = total
	s.mu.Unlock()

	if total == 0 {
		log.Println("ℹ️ 没有节点需要检测")
		return
	}

	// 并发探测
	concurrency := s.cfg.Concurrency
	if concurrency < 1 {
		concurrency = 10
	}

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for id, unit := range units {
		if s.storage.IsBlocked(id) {
			continue
		}

		wg.Add(1)
		go func(uid string, u *models.Unit) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			if s.abort {
				return
			}

			// 官方探针测试
			probeResult := s.detector.ProbeLatency(u)

			// 自定义探针测试
			var customResults []detector.ProbeCustomResult
			if len(s.cfg.CustomProbes) > 0 {
				customResults = s.detector.ProbeCustoms(u)
			}

			// 测速
			var speedResult *models.SpeedResult
			if probeResult.OK {
				speedResult = s.detector.ProbeSpeed(u)
			}

			// 构建历史记录
			entry := &models.HistoryEntry{
				T:       time.Now(),
				OK:      probeResult.OK,
				Latency: probeResult.Off,
			}

			if probeResult.OK {
				if speedResult != nil && speedResult.OK && speedResult.Mbps != nil {
					entry.SpeedMbps = speedResult.Mbps
				}
				if len(customResults) > 0 {
					allOk := true
					for _, cr := range customResults {
						if !cr.OK {
							allOk = false
							break
						}
					}
					if !allOk {
						entry.OK = false
					}
				}

				// 更新最后在线时间
				now := time.Now()
				u.LastOnlineAt = &now
			}

			s.storage.AddHistory(uid, entry)

			// 判定是否加入墓地
			if !probeResult.OK {
				failReason := "unknown"
				if probeResult.FailReason != nil {
					failReason = *probeResult.FailReason
				}
				s.storage.BlockNode(uid, failReason)
			}

			s.mu.Lock()
			s.progress.Tested++
			s.mu.Unlock()
		}(id, unit)
	}

	wg.Wait()

	// 保存数据
	s.storage.Save()

	// 计算质量并上传
	s.computeQuality()

	// 自动上传
	if s.cfg.GitHub.Auto && s.cfg.GitHub.Token != "" && s.cfg.GitHub.Repo != "" {
		if err := s.uploadGithub(); err != nil {
			errStr := err.Error()
			s.github.LastError = &errStr
			log.Printf("⚠️ 上传失败：%v", err)
		} else {
			now := time.Now()
			s.github.LastUpload = &now
			s.github.LastError = nil
		}
	}
}

func (s *Server) computeQuality() {
	// 优质节点判定逻辑
	units := s.storage.GetUnits()
	qualityResults := make([]*models.QualityResult, 0)

	for id, unit := range units {
		hist := s.storage.GetHistory(id)
		if hist == nil || len(hist) == 0 {
			continue
		}

		qr := models.ComputeQuality(unit, hist, s.cfg)
		if qr != nil {
			qualityResults = append(qualityResults, qr)
		}
	}

	// 可以在此处添加优质节点筛选逻辑
	_ = qualityResults
}

func (s *Server) uploadGithub() error {
	if s.cfg.GitHub.Token == "" || s.cfg.GitHub.Repo == "" {
		return fmt.Errorf("GitHub Token 或 Repo 未配置")
	}

	// 构建上传数据
	data := s.buildUploadData()
	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化失败：%w", err)
	}

	// GitHub API
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/contents/%s",
		s.cfg.GitHub.Repo, s.cfg.GitHub.FilePath)

	reqBody := map[string]interface{}{
		"message": fmt.Sprintf("auto-update %s", time.Now().Format(time.RFC3339)),
		"content": base64.StdEncoding.EncodeToString(jsonData),
		"branch":  s.cfg.GitHub.Branch,
	}

	reqData, _ := json.Marshal(reqBody)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "PUT", apiURL, bytes.NewReader(reqData))
	if err != nil {
		return fmt.Errorf("创建请求失败：%w", err)
	}

	req.Header.Set("Authorization", "token "+s.cfg.GitHub.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/vnd.github.v3+json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("请求失败：%w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitHub API 返回 %d: %s", resp.StatusCode, string(body))
	}

	log.Println("✅ GitHub 上传成功")
	return nil
}

func (s *Server) buildUploadData() interface{} {
	units := s.storage.GetUnits()
	result := make([]map[string]interface{}, 0)

	for id, unit := range units {
		hist := s.storage.GetHistory(id)
		if hist == nil || len(hist) == 0 {
			continue
		}

		// 取最近一条有效记录
		var lastValid *models.HistoryEntry
		for i := len(hist) - 1; i >= 0; i-- {
			if hist[i].OK {
				lastValid = hist[i]
				break
			}
		}

		if lastValid == nil {
			continue
		}

		entry := map[string]interface{}{
			"id":   id,
			"ip":   unit.IP,
			"port": unit.Port,
		}

		if lastValid.Latency != nil {
			if lastValid.Latency.TCP > 0 {
				entry["tcp"] = lastValid.Latency.TCP
			}
			if lastValid.Latency.TLS > 0 {
				entry["tls"] = lastValid.Latency.TLS
			}
			if lastValid.Latency.TTFB > 0 {
				entry["ttfb"] = lastValid.Latency.TTFB
			}
		}

		if lastValid.SpeedMbps != nil {
			entry["mbps"] = *lastValid.SpeedMbps
		}

		result = append(result, entry)
	}

	return result
}

func waitNetworkReady(cfg *config.Config, maxMs, stepMs int) bool {
	if maxMs == 0 {
		maxMs = 45000
	}
	if stepMs == 0 {
		stepMs = 5000
	}

	probeURL := cfg.ProbeURL
	if !strings.HasPrefix(probeURL, "http") {
		probeURL = "https://www.cloudflare.com/cdn-cgi/trace"
	}

	started := time.Now()
	tried := 0
	for time.Since(started) < time.Duration(maxMs)*time.Millisecond {
		tried++
		cmd := fmt.Sprintf(`curl -4 -k -s --noproxy '*' -o /dev/null -w '%%{http_code}' --connect-timeout 3 --max-time 6 '%s'`, probeURL)
		out, code := runCurlCmd(cmd, 8000)
		if code == 0 && strings.TrimSpace(out) != "000" {
			if tried > 1 {
				log.Printf("🌐 网络已就绪（第 %d 次尝试）", tried)
			}
			return true
		}
		time.Sleep(time.Duration(stepMs) * time.Millisecond)
	}
	return false
}

func runCurlCmd(cmd string, timeoutMs int) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	c := exec.CommandContext(ctx, "sh", "-c", cmd)
	var out bytes.Buffer
	c.Stdout = &out

	err := c.Run()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return out.String(), exitCode
}
