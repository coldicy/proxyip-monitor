package main

import (
"embed"
"fmt"
"io/fs"
"log"
"net/http"
"os"
"os/signal"
"path/filepath"
"strings"
"sync"
"syscall"
"time"

"proxy-monitor/internal/config"
"proxy-monitor/internal/models"
)

//go:embed web/dist/*
var staticFiles embed.FS

const version = "v36-window-go"

type AppState struct {
mu            sync.RWMutex
cfg           *config.Config
units         map[string]*models.Unit
history       map[string][]*models.HistoryEntry
graveyard     *models.Graveyard
blocked       map[string]int64
checking      bool
abort         bool
progress      Progress
lastCycle     *time.Time
logs          []LogEntry
githubState   GitHubState
lastUploaded  string
cfCidrs       []string
cfCidrsAt     time.Time
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

state := &AppState{
cfg:       cfg,
units:     make(map[string]*models.Unit),
history:   make(map[string][]*models.HistoryEntry),
graveyard: &models.Graveyard{List: []models.GraveyardEntry{}, Blocked: make(map[string]int64)},
blocked:   make(map[string]int64),
logs:      []LogEntry{},
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
if err := refreshCfCidrs(state, true); err != nil {
log.Printf("⚠️ 更新 CF CIDR 失败：%v", err)
}
if err := discover(state); err != nil {
log.Printf("⚠️ 发现节点失败：%v", err)
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
data, err := staticFiles.ReadFile("web/dist/index.html")
if err != nil {
w.WriteHeader(http.StatusInternalServerError)
w.Write([]byte("<h1>index.html 缺失</h1>"))
return
}
w.Header().Set("Content-Type", "text/html; charset=utf-8")
w.Write(data)
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

var json = newJSON()

func newJSON() *json.Encoder {
return nil
}
