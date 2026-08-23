package main

import (
"bytes"
"context"
"embed"
"encoding/json"
"fmt"
"log"
"net/http"
"os"
"os/exec"
"os/signal"
"strings"
"sync"
"syscall"
"time"

"proxy-monitor/internal/config"
"proxy-monitor/internal/detector"
"proxy-monitor/internal/models"
)

//go:embed web/dist/index.html
var indexHTML []byte

const version = "v36-window-go"

type AppState struct {
mu          sync.RWMutex
cfg         *config.Config
detector    *detector.Detector
units       map[string]*models.Unit
history     map[string][]*models.HistoryEntry
graveyard   *models.Graveyard
blocked     map[string]int64
checking    bool
abort       bool
progress    Progress
lastCycle   *time.Time
logs        []LogEntry
githubState GitHubState
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

func main() {
cfg := config.DefaultConfig()

if _, err := os.Stat(cfg.ConfigFile); err == nil {
if err := cfg.LoadFromFile(cfg.ConfigFile); err != nil {
log.Printf("⚠️ 加载配置文件失败：%v", err)
}
}

if token := cfg.LoadSecret(); token != "" {
cfg.GitHub.Token = token
} else if ghToken := os.Getenv("GITHUB_TOKEN"); ghToken != "" {
cfg.GitHub.Token = ghToken
}

det := detector.NewDetector(cfg)

state := &AppState{
cfg:         cfg,
detector:    det,
units:       make(map[string]*models.Unit),
history:     make(map[string][]*models.HistoryEntry),
graveyard:   &models.Graveyard{List: []models.GraveyardEntry{}, Blocked: make(map[string]int64)},
blocked:     make(map[string]int64),
logs:        []LogEntry{},
githubState: GitHubState{},
}

if err := loadData(state); err != nil {
log.Printf("⚠️ 加载历史数据失败：%v", err)
}

backfillLastOnline(state)
loadGraveyard(state)

if err := cfg.EnsureIPFile(); err != nil {
log.Printf("⚠️ 创建 IP 文件失败：%v", err)
}

go func() {
if err := det.RefreshCfCidrs(true); err != nil {
log.Printf("⚠️ 更新 CF CIDR 失败：%v", err)
}
if added, err := det.Discover(state.units, state.history, state.blocked); err != nil {
log.Printf("⚠️ 发现节点失败：%v", err)
} else if added > 0 {
log.Printf("🆕 发现 %d 个新节点", added)
}

if ready := waitNetworkReady(state.cfg, 45000, 5000); !ready {
log.Println("⚠️ 启动后等待 45 秒网络仍未就绪，开启无效轮保护进行首轮检测")
} else {
log.Println("🌐 启动网络检查通过")
}

runCycle(state)

ticker := time.NewTicker(time.Duration(state.cfg.IntervalSec) * time.Second)
defer ticker.Stop()
for range ticker.C {
runCycle(state)
}
}()

if state.cfg.GitHub.Auto && state.cfg.GitHub.Token != "" && state.cfg.GitHub.Repo != "" {
interval := state.cfg.GitHub.UploadIntervalMin
if interval > 0 {
go func() {
ticker := time.NewTicker(time.Duration(interval) * time.Minute)
defer ticker.Stop()
for range ticker.C {
log.Println("⏰ 定时触发 GitHub 上传")
if err := uploadGithub(state); err != nil {
errStr := err.Error()
state.githubState.LastError = &errStr
log.Printf("⚠️ 定时上传失败：%v", err)
}
}
}()
}
}

http.HandleFunc("/", handleRequest(state))

addr := fmt.Sprintf(":%d", state.cfg.Port)
server := &http.Server{Addr: addr, Handler: http.DefaultServeMux}

go func() {
sigChan := make(chan os.Signal, 1)
signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
<-sigChan
log.Println("🛑 收到退出信号，优雅关闭...")
server.Close()
}()

log.Printf("🚀 Proxy Monitor %s on http://0.0.0.0%s", version, addr)
addLog(state, fmt.Sprintf("🚀 服务启动 (%s)", version))

if err := server.ListenAndServe(); err != http.ErrServerClosed {
log.Fatalf("💥 HTTP server 错误：%v", err)
}
}

func handleRequest(state *AppState) http.HandlerFunc {
return func(w http.ResponseWriter, r *http.Request) {
path := r.URL.Path

jsonResp := func(data interface{}, status int) {
w.Header().Set("Content-Type", "application/json; charset=utf-8")
w.WriteHeader(status)
enc := json.NewEncoder(w)
enc.Encode(data)
}

switch {
case path == "/" || path == "/index.html":
serveIndex(w)
case path == "/api/state" && r.Method == "GET":
jsonResp(buildState(state), 200)
case path == "/api/logs" && r.Method == "GET":
jsonResp(map[string]interface{}{"logs": state.logs}, 200)
case path == "/api/abort" && r.Method == "POST":
if state.checking {
state.abort = true
addLog(state, "⏹ 收到中断请求")
}
jsonResp(map[string]interface{}{"ok": true}, 200)
case path == "/api/graveyard" && r.Method == "GET":
jsonResp(map[string]interface{}{"graveyard": state.graveyard.List}, 200)
case path == "/api/graveyard/clear" && r.Method == "POST":
state.graveyard.List = []models.GraveyardEntry{}
state.blocked = make(map[string]int64)
persistGraveyard(state)
jsonResp(map[string]interface{}{"ok": true}, 200)
default:
jsonResp(map[string]string{"error": "not found"}, 404)
}
}
}

func serveIndex(w http.ResponseWriter) {
w.Header().Set("Content-Type", "text/html; charset=utf-8")
w.Write(indexHTML)
}

func addLog(state *AppState, msg string) {
state.mu.Lock()
defer state.mu.Unlock()
state.logs = append(state.logs, LogEntry{T: time.Now().UnixMilli(), M: msg})
if len(state.logs) > 400 {
state.logs = state.logs[len(state.logs)-400:]
}
}

func loadData(state *AppState) error {
data, err := os.ReadFile(state.cfg.DataFile)
if err != nil {
return err
}

var savedData struct {
History map[string][]*models.HistoryEntry `json:"history"`
Nodes   map[string]*models.Unit           `json:"nodes"`
}

if err := json.Unmarshal(data, &savedData); err != nil {
return err
}

if savedData.History != nil {
state.history = savedData.History
}
if savedData.Nodes != nil && len(savedData.Nodes) > 0 {
state.units = savedData.Nodes
}

return nil
}

func persistGraveyard(state *AppState) {
data := map[string]interface{}{
"list":    state.graveyard.List,
"blocked": state.blocked,
}
os.WriteFile(state.cfg.GraveyardFile, mustJson(data), 0644)
}

func loadGraveyard(state *AppState) {
data, err := os.ReadFile(state.cfg.GraveyardFile)
if err != nil {
state.graveyard = &models.Graveyard{List: []models.GraveyardEntry{}, Blocked: make(map[string]int64)}
state.blocked = make(map[string]int64)
return
}

var g models.Graveyard
if err := json.Unmarshal(data, &g); err != nil {
return
}

state.graveyard = &g
if g.Blocked != nil {
state.blocked = g.Blocked
}
}

func backfillLastOnline(state *AppState) {
for id, unit := range state.units {
if unit.LastOnlineAt != nil {
continue
}
if hist, ok := state.history[id]; ok && len(hist) > 0 {
for i := len(hist) - 1; i >= 0; i-- {
if hist[i].OK {
unit.LastOnlineAt = &hist[i].T
break
}
}
}
}
}

func mustJson(v interface{}) []byte {
data, _ := json.Marshal(v)
return data
}

func waitNetworkReady(cfg *config.Config, maxMs, stepMs int) bool {
maxMs = maxMs || 45000
stepMs = stepMs || 5000

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

func buildState(state *AppState) interface{} {
state.mu.RLock()
defer state.mu.RUnlock()

units := make([]*models.Unit, 0, len(state.units))
for _, u := range state.units {
units = append(units, u)
}

return map[string]interface{}{
"units":     units,
"history":   state.history,
"progress":  state.progress,
"checking":  state.checking,
"lastCycle": state.lastCycle,
"github":    state.githubState,
"graveyard": state.graveyard.List,
"cfg":       state.cfg.PublicConfig(),
}
}

func runCycle(state *AppState) {
log.Println("🔄 检测周期开始")
// TODO: 实现核心检测周期逻辑
}

func uploadGithub(state *AppState) error {
// TODO: 实现 GitHub 上传逻辑
return nil
}
