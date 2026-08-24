package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"proxy-monitor/internal/config"
	"proxy-monitor/internal/model"
	"strings"
	"sync"
	"time"
)

// Service 核心服务
type Service struct {
	cfg        *config.Config
	nodes      map[string]*model.Node
	history    map[string][]*model.ProbeResult
	graveyard  *model.Graveyard
	cfCidrs    []string
	cfCidrsAt  int64
	mu         sync.RWMutex
	checking   bool
	abort      bool
	progress   Progress
	logs       []LogEntry
	lastCycle  int64
	httpClient *http.Client
	ctx        context.Context
	cancel     context.CancelFunc
}

// Progress 检测进度
type Progress struct {
	Tested int `json:"tested"`
	Total  int `json:"total"`
}

// LogEntry 日志条目
type LogEntry struct {
	T int64  `json:"t"`
	M string `json:"m"`
}

// NewService 创建新服务
func NewService(cfg *config.Config) (*Service, error) {
	svc := &Service{
		cfg:       cfg,
		nodes:     make(map[string]*model.Node),
		history:   make(map[string][]*model.ProbeResult),
		graveyard: &model.Graveyard{List: []model.GraveyardEntry{}, Blocked: make(map[string]int64)},
		logs:      []LogEntry{},
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 20,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}

	svc.ctx, svc.cancel = context.WithCancel(context.Background())

	// 确保数据目录存在
	if err := os.MkdirAll(cfg.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败：%w", err)
	}
	if err := os.MkdirAll(filepath.Dir(cfg.IPFile), 0755); err != nil {
		return nil, fmt.Errorf("创建配置目录失败：%w", err)
	}

	// 加载历史数据
	svc.loadData()
	svc.loadGraveyard()

	// 初始化 CF CIDR
	go svc.refreshCfCidrs(false)

	// 启动定时任务
	go svc.runScheduler()

	return svc, nil
}

func (s *Service) log(msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := LogEntry{T: time.Now().UnixMilli(), M: msg}
	s.logs = append(s.logs, entry)
	if len(s.logs) > 400 {
		s.logs = s.logs[len(s.logs)-400:]
	}
	fmt.Println(msg)
}

func (s *Service) loadData() {
	data, err := os.ReadFile(s.cfg.DataFile)
	if err != nil {
		s.log("📂 未找到历史数据文件，将创建新数据")
		return
	}

	var dataStore struct {
		History map[string][]*model.ProbeResult `json:"history"`
		Nodes   map[string]*model.Node          `json:"nodes"`
	}
	if err := json.Unmarshal(data, &dataStore); err != nil {
		s.log("⚠️ 解析历史数据失败：" + err.Error())
		return
	}

	s.history = dataStore.History
	if dataStore.Nodes != nil {
		s.nodes = dataStore.Nodes
	}
	s.log(fmt.Sprintf("📂 已加载 %d 个节点的历史数据", len(s.nodes)))
}

func (s *Service) saveData() {
	s.mu.Lock()
	defer s.mu.Unlock()

	dataStore := map[string]interface{}{
		"history": s.history,
		"nodes":   s.nodes,
	}

	data, err := json.Marshal(dataStore)
	if err != nil {
		s.log("⚠️ 序列化数据失败：" + err.Error())
		return
	}

	tmpFile := s.cfg.DataFile + ".tmp"
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		s.log("⚠️ 写入临时文件失败：" + err.Error())
		return
	}

	if err := os.Rename(tmpFile, s.cfg.DataFile); err != nil {
		s.log("⚠️ 重命名数据文件失败：" + err.Error())
	}
}

func (s *Service) loadGraveyard() {
	data, err := os.ReadFile(s.cfg.GraveyardFile)
	if err != nil {
		return
	}

	var g model.Graveyard
	if err := json.Unmarshal(data, &g); err != nil {
		return
	}

	s.graveyard = &g
	if s.graveyard.Blocked == nil {
		s.graveyard.Blocked = make(map[string]int64)
	}
}

func (s *Service) persistGraveyard() {
	data, err := json.Marshal(s.graveyard)
	if err != nil {
		return
	}
	os.WriteFile(s.cfg.GraveyardFile, data, 0644)
}

// refreshCfCidrs 刷新 Cloudflare CIDR 列表
func (s *Service) refreshCfCidrs(force bool) error {
	s.mu.Lock()
	if !force && len(s.cfCidrs) > 0 && time.Now().Unix()-s.cfCidrsAt < 12*3600 {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	builtins := []string{
		"103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "104.16.0.0/12",
		"108.162.192.0/18", "131.0.72.0/22", "141.101.64.0/18", "162.158.0.0/15",
		"172.64.0.0/13", "173.245.48.0/20", "188.114.96.0/20", "190.93.240.0/20",
		"197.234.240.0/22", "198.41.128.0/17",
	}

	resp, err := s.httpClient.Get("https://www.cloudflare.com/ips-v4")
	live := builtins
	if err == nil && resp.StatusCode == 200 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		lines := strings.Split(string(body), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if strings.Contains(line, "/") {
				live = append(live, line)
			}
		}
		s.log(fmt.Sprintf("🌐 CF IP 分类集合已更新：%d 条", len(live)))
	} else {
		s.log("⚠️ 获取 CF IP 段失败，使用内置超网")
	}

	s.mu.Lock()
	s.cfCidrs = live
	s.cfCidrsAt = time.Now().Unix()
	s.mu.Unlock()

	return nil
}

func (s *Service) classifyIP(ip string) string {
	if ip == "" || net.ParseIP(ip) == nil || net.ParseIP(ip).To4() == nil {
		return "unknown"
	}
	if len(s.cfCidrs) == 0 {
		return "unknown"
	}

	ipInt := ipToUint32(ip)
	for _, cidr := range s.cfCidrs {
		if cidrMatch(ipInt, cidr) {
			return "cf"
		}
	}
	return "proxy"
}

func ipToUint32(ip string) uint32 {
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return 0
	}
	var result uint32
	for i, part := range parts {
		var n int
		fmt.Sscanf(part, "%d", &n)
		result |= uint32(n) << (24 - uint(i)*8)
	}
	return result
}

func cidrMatch(ip uint32, cidr string) bool {
	parts := strings.Split(cidr, "/")
	if len(parts) != 2 {
		return false
	}
	var base uint32
	var bits int
	fmt.Sscanf(parts[0], "%d.%d.%d.%d", &base)
	base = ipToUint32(parts[0])
	fmt.Sscanf(parts[1], "%d", &bits)

	mask := uint32(0xFFFFFFFF) << (32 - bits)
	return (ip & mask) == (base & mask)
}

// runScheduler 运行定时调度器
func (s *Service) runScheduler() {
	// 等待网络就绪
	s.waitForNetworkReady()

	// 初始发现
	s.discover()

	// 首轮检测
	go s.runCycle()

	// 定时任务
	ticker := time.NewTicker(time.Duration(s.cfg.IntervalSec) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			go s.runCycle()
		}
	}
}

func (s *Service) waitForNetworkReady() {
	maxMs := 45000
	stepMs := 5000
	started := time.Now()
	tried := 0

	for time.Since(started) < time.Duration(maxMs)*time.Millisecond {
		tried++
		cmd := exec.CommandContext(s.ctx, "curl", "-4", "-k", "-s", "--noproxy", "*",
			"-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "3", "--max-time", "6",
			"https://www.cloudflare.com/cdn-cgi/trace")
		output, err := cmd.Output()
		if err == nil && string(output) != "000" {
			if tried > 1 {
				s.log(fmt.Sprintf("🌐 网络已就绪（第 %d 次尝试）", tried))
			}
			return
		}
		time.Sleep(time.Duration(stepMs) * time.Millisecond)
	}
	s.log("⚠️ 启动后等待 45 秒网络仍未就绪")
}

// discover 发现新节点
func (s *Service) discover() int {
	s.refreshCfCidrs(false)
	now := time.Now().UnixMilli()

	data, err := os.ReadFile(s.cfg.IPFile)
	if err != nil {
		return 0
	}

	lines := strings.Split(string(data), "\n")
	added := 0
	present := make(map[string]bool)

	for _, raw := range lines {
		host, port, isDomain, ok := model.ParseLine(raw)
		if !ok {
			continue
		}

		var key string
		if isDomain {
			key = "dom:" + host + ":" + fmt.Sprint(port)
			// DNS 解析
			ips, err := net.LookupHost(host)
			if err != nil {
				continue
			}
			for _, ip := range ips {
				if net.ParseIP(ip).To4() == nil {
					continue
				}
				id := ip + ":" + fmt.Sprint(port)
				if present[id] || s.nodes[id] != nil || s.graveyard.Blocked[id] != 0 {
					continue
				}
				present[id] = true
				s.addNode(id, ip, port, now, "dom", host)
				added++
			}
		} else {
			key = "pure:" + host + ":" + fmt.Sprint(port)
			if present[key] || s.nodes[key] != nil || s.graveyard.Blocked[key] != 0 {
				continue
			}
			present[key] = true
			s.addNode(key, host, port, now, "pure", key)
			added++
		}
	}

	if added > 0 {
		s.log(fmt.Sprintf("🆕 发现 %d 个新节点", added))
		s.saveData()
	}

	return added
}

func (s *Service) addNode(id, ip string, port int, firstSeen int64, kind, name string) {
	s.nodes[id] = &model.Node{
		ID:        id,
		IP:        ip,
		Port:      port,
		FirstSeen: firstSeen,
		FirstSource: model.SourceInfo{
			Kind: kind,
			Name: name,
		},
		Kind: s.classifyIP(ip),
	}
}

// runCycle 执行一轮检测
func (s *Service) runCycle() {
	s.mu.Lock()
	if s.checking {
		s.mu.Unlock()
		return
	}
	s.checking = true
	s.abort = false
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.checking = false
		s.lastCycle = time.Now().UnixMilli()
		s.mu.Unlock()
	}()

	total := len(s.nodes)
	s.mu.Lock()
	s.progress = Progress{Tested: 0, Total: total}
	s.mu.Unlock()

	s.log(fmt.Sprintf("🔄 开始检测 %d 个节点（并发 %d）", total, s.cfg.Concurrency))

	// 简单串行检测（实际生产环境应使用 goroutine 池）
	for id, node := range s.nodes {
		if s.abort {
			break
		}

		result := s.probeNode(node)
		s.pushHistory(id, result)
		s.progress.Tested++

		if result.OK {
			s.log(fmt.Sprintf("✅ %s 总=%dms", id, *result.Total))
		} else {
			s.log(fmt.Sprintf("❌ %s 失败：%s", id, result.FailReason))
		}
	}

	s.log(fmt.Sprintf("🏁 检测完成：在线 %d / 总数 %d", s.countOnline(), total))
	s.saveData()
}

func (s *Service) probeNode(node *model.Node) *model.ProbeResult {
	result := &model.ProbeResult{
		T:  time.Now().UnixMilli(),
		OK: false,
	}

	// 使用 curl 进行探测
	timeout := s.cfg.TimeoutSec + 2
	cmd := exec.CommandContext(s.ctx, "curl", "-4", "-k", "-s", "--noproxy", "*",
		"--retry", "0", "-A", "PM-probe",
		"-w", "\n{\"tcp\":%{time_connect},\"tls\":%{time_appconnect},\"ttfb\":%{time_starttransfer},\"http\":%{http_code}}",
		"--resolve", fmt.Sprintf("%s:%d:%s", "www.cloudflare.com", node.Port, node.IP),
		"--connect-timeout", "3", "--max-time", fmt.Sprint(timeout),
		"https://www.cloudflare.com/cdn-cgi/trace")

	output, err := cmd.Output()
	if err != nil {
		result.FailReason = "连接失败"
		return result
	}

	lines := strings.Split(string(output), "\n")
	if len(lines) < 2 {
		result.FailReason = "响应格式错误"
		return result
	}

	// 解析最后一行 JSON
	var stats struct {
		TCP  float64 `json:"tcp"`
		TLS  float64 `json:"tls"`
		TTFB float64 `json:"ttfb"`
		HTTP int     `json:"http"`
	}
	jsonStr := lines[len(lines)-1]
	if err := json.Unmarshal([]byte(jsonStr), &stats); err != nil {
		result.FailReason = "解析统计失败"
		return result
	}

	if stats.HTTP != 200 {
		result.FailReason = fmt.Sprintf("HTTP %d", stats.HTTP)
		return result
	}

	// 检查是否为 CF 内容
	traceContent := strings.Join(lines[:len(lines)-1], "\n")
	if !strings.Contains(traceContent, "colo=") {
		result.FailReason = "非 CF 内容"
		return result
	}

	// 提取 colo 和 loc
	for _, line := range strings.Split(traceContent, "\n") {
		if strings.HasPrefix(line, "colo=") {
			result.Colo = strings.TrimPrefix(line, "colo=")
		}
		if strings.HasPrefix(line, "loc=") {
			result.Loc = strings.TrimPrefix(line, "loc=")
		}
		if strings.HasPrefix(line, "ip=") {
			result.ExitIP = strings.TrimPrefix(line, "ip=")
		}
	}

	tcp := int(stats.TCP * 1000)
	tls := int((stats.TLS - stats.TCP) * 1000)
	src := int(stats.TTFB*1000 - float64(tcp) - float64(tls))
	if src < 0 {
		src = 0
	}

	result.OK = true
	result.Off = &model.LatencySegs{
		TCP:   tcp,
		TLS:   tls,
		Total: tcp + tls + src,
		Src:   src,
	}
	total := tcp + tls + src
	result.Total = &total
	result.AvgTCP = &tcp
	result.AvgTLS = &tls
	result.AvgHTTP = &src

	return result
}

func (s *Service) pushHistory(id string, result *model.ProbeResult) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.history[id] == nil {
		s.history[id] = []*model.ProbeResult{}
	}

	s.history[id] = append(s.history[id], result)

	// 限制历史记录大小
	cap := s.cfg.QualityWindow
	if cap < 1 {
		cap = 10
	}
	if cap > 50 {
		cap = 50
	}
	if len(s.history[id]) > cap {
		s.history[id] = s.history[id][len(s.history[id])-cap:]
	}

	// 更新最后在线时间
	if result.OK {
		if node, ok := s.nodes[id]; ok {
			node.LastOnlineAt = result.T
		}
	}
}

func (s *Service) countOnline() int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	count := 0
	for id := range s.nodes {
		if hist, ok := s.history[id]; ok && len(hist) > 0 {
			if hist[len(hist)-1].OK {
				count++
			}
		}
	}
	return count
}

// GetState 获取当前状态
func (s *Service) GetState() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	items := make([]map[string]interface{}, 0, len(s.nodes))
	online := 0
	quality := 0

	for id, node := range s.nodes {
		hist := s.history[id]
		latest := (*model.ProbeResult)(nil)
		if len(hist) > 0 {
			latest = hist[len(hist)-1]
		}

		q := s.computeQuality(hist, node.Speed)
		if latest != nil && latest.OK {
			online++
		}
		if q.Quality {
			quality++
		}

		recent := hist
		if len(recent) > s.cfg.QualityWindow {
			recent = recent[len(recent)-s.cfg.QualityWindow:]
		}

		items = append(items, map[string]interface{}{
			"id":        id,
			"label":     id,
			"ip":        node.IP,
			"port":      node.Port,
			"ipKind":    node.Kind,
			"srcKind":   node.FirstSource.Kind,
			"srcName":   node.FirstSource.Name,
			"firstSeen": node.FirstSeen,
			"colo":      latest.Colo,
			"loc":       latest.Loc,
			"exitIp":    latest.ExitIP,
			"speed":     node.Speed,
			"latest":    latest,
			"quality":   q,
			"recent":    recent,
		})
	}

	return map[string]interface{}{
		"version":     config.Version,
		"checking":    s.checking,
		"progress":    s.progress,
		"lastCycle":   s.lastCycle,
		"intervalSec": s.cfg.IntervalSec,
		"config": map[string]interface{}{
			"maxTotalMs":       s.cfg.MaxTotalMs,
			"qualityWindow":    s.cfg.QualityWindow,
			"successThreshold": s.cfg.SuccessThreshold,
			"qualThreshold":    s.cfg.QualThreshold,
			"autoCleanDays":    s.cfg.AutoCleanDays,
			"customProbes":     s.cfg.CustomProbes,
			"concurrency":      s.cfg.Concurrency,
			"speedEnabled":     s.cfg.SpeedEnabled,
			"speedMinMBps":     s.cfg.SpeedMinMBps,
			"speedUrl":         s.cfg.SpeedURL,
			"speedTimeoutSec":  s.cfg.SpeedTimeoutSec,
			"speedConcurrency": s.cfg.SpeedConcurrency,
			"speedPerCycle":    s.cfg.SpeedPerCycle,
		},
		"github": map[string]interface{}{
			"configured":        s.cfg.GitHub.Token != "" && s.cfg.GitHub.Repo != "",
			"auto":              s.cfg.GitHub.Auto,
			"lastUpload":        nil,
			"lastError":         nil,
			"uploadIntervalMin": s.cfg.GitHub.UploadIntervalMin,
		},
		"summary": map[string]interface{}{
			"total":   len(s.nodes),
			"online":  online,
			"quality": quality,
			"offline": len(s.nodes) - online,
		},
		"items": items,
	}
}

func (s *Service) computeQuality(points []*model.ProbeResult, speed *model.SpeedResult) *model.QualityResult {
	if len(points) == 0 {
		return &model.QualityResult{Quality: false, Rate: 0, QualRate: 0, Samples: 0, SpeedPass: true}
	}

	window := s.cfg.QualityWindow
	if window > len(points) {
		window = len(points)
	}
	recent := points[len(points)-window:]

	okCount := 0
	for _, p := range recent {
		if p.OK {
			okCount++
		}
	}

	rate := float64(okCount) / float64(len(recent))
	qualRate := rate

	if s.cfg.MaxTotalMs > 0 {
		qualified := 0
		for _, p := range recent {
			if p.OK && p.Total != nil && float64(*p.Total) <= s.cfg.MaxTotalMs {
				qualified++
			}
		}
		qualRate = float64(qualified) / float64(len(recent))
	}

	speedPass := true
	if s.cfg.SpeedEnabled && s.cfg.SpeedMinMBps > 0 {
		speedPass = speed != nil && speed.OK && speed.Mbps >= s.cfg.SpeedMinMBps
	}

	enough := len(recent) >= s.cfg.QualityWindow
	quality := enough && rate >= s.cfg.SuccessThreshold && qualRate >= s.cfg.QualThreshold && speedPass

	return &model.QualityResult{
		Quality:   quality,
		Rate:      rate,
		QualRate:  qualRate,
		Samples:   len(recent),
		SpeedPass: speedPass,
	}
}

// GetLogs 获取日志
func (s *Service) GetLogs() []LogEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]LogEntry(nil), s.logs...)
}

// GetConfig 获取配置
func (s *Service) GetConfig() map[string]interface{} {
	return map[string]interface{}{
		"intervalSec":      s.cfg.IntervalSec,
		"timeoutSec":       s.cfg.TimeoutSec,
		"concurrency":      s.cfg.Concurrency,
		"autoCleanDays":    s.cfg.AutoCleanDays,
		"maxTotalMs":       s.cfg.MaxTotalMs,
		"probeUrl":         s.cfg.ProbeURL,
		"customProbes":     s.cfg.CustomProbes,
		"qualityWindow":    s.cfg.QualityWindow,
		"successThreshold": s.cfg.SuccessThreshold,
		"qualThreshold":    s.cfg.QualThreshold,
		"speedEnabled":     s.cfg.SpeedEnabled,
		"speedUrl":         s.cfg.SpeedURL,
		"speedTimeoutSec":  s.cfg.SpeedTimeoutSec,
		"speedMinMBps":     s.cfg.SpeedMinMBps,
		"speedConcurrency": s.cfg.SpeedConcurrency,
		"speedPerCycle":    s.cfg.SpeedPerCycle,
		"github": map[string]interface{}{
			"tokenSet":          s.cfg.GitHub.Token != "",
			"tokenMasked":       config.MaskToken(s.cfg.GitHub.Token),
			"repo":              s.cfg.GitHub.Repo,
			"path":              s.cfg.GitHub.Path,
			"branch":            s.cfg.GitHub.Branch,
			"auto":              s.cfg.GitHub.Auto,
			"uploadIntervalMin": s.cfg.GitHub.UploadIntervalMin,
		},
	}
}

// UpdateConfig 更新配置
func (s *Service) UpdateConfig(data map[string]interface{}) error {
	// TODO: 实现配置更新逻辑
	return config.SaveConfig(s.cfg)
}

// TriggerCheck 手动触发检测
func (s *Service) TriggerCheck() {
	go s.runCycle()
}

// AbortCheck 中断检测
func (s *Service) AbortCheck() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.checking {
		s.abort = true
		s.log("⏹ 收到中断请求")
	}
}

// GetIPFile 获取 IP 文件内容
func (s *Service) GetIPFile() (string, error) {
	data, err := os.ReadFile(s.cfg.IPFile)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SaveIPFile 保存 IP 文件
func (s *Service) SaveIPFile(content string) error {
	if err := os.WriteFile(s.cfg.IPFile, []byte(content), 0644); err != nil {
		return err
	}
	go s.discover()
	return nil
}

// GetGraveyard 获取墓碑记录
func (s *Service) GetGraveyard() *model.Graveyard {
	return s.graveyard
}

// ClearGraveyard 清空墓碑记录
func (s *Service) ClearGraveyard() {
	s.graveyard.List = []model.GraveyardEntry{}
	s.graveyard.Blocked = make(map[string]int64)
	s.persistGraveyard()
}

// RemoveNodes 删除节点
func (s *Service) RemoveNodes(ids []string) int {
	removed := 0
	now := time.Now().UnixMilli()

	for _, id := range ids {
		if node, ok := s.nodes[id]; ok {
			s.graveyard.List = append(s.graveyard.List, model.GraveyardEntry{
				ID:           id,
				Label:        id,
				RemovedAt:    now,
				LastOnlineAt: node.LastOnlineAt,
				Mode:         "manual",
				Reason:       "手动删除",
			})
			s.graveyard.Blocked[id] = now
			delete(s.nodes, id)
			delete(s.history, id)
			removed++
		}
	}

	if removed > 0 {
		if len(s.graveyard.List) > 1000 {
			s.graveyard.List = s.graveyard.List[len(s.graveyard.List)-1000:]
		}
		s.persistGraveyard()
		s.saveData()
		s.log(fmt.Sprintf("🗑️ 手动删除 %d 个节点（已屏蔽）", removed))
	}

	return removed
}

// Shutdown 关闭服务
func (s *Service) Shutdown() {
	s.cancel()
	s.saveData()
	s.persistGraveyard()
}
