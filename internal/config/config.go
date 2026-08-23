package config

import (
"encoding/json"
"fmt"
"os"
"path/filepath"
"strconv"
"strings"
)

// Config 配置结构体
type Config struct {
Port              int            `json:"-"`
IPFile            string         `json:"-"`
DataDir           string         `json:"-"`
IntervalSec       int            `json:"intervalSec"`
ProbeURL          string         `json:"probeUrl"`
CustomProbes      []CustomProbe  `json:"customProbes"`
TimeoutSec        int            `json:"timeoutSec"`
Concurrency       int            `json:"concurrency"`
AutoCleanDays     float64        `json:"autoCleanDays"`
MaxTotalMs        float64        `json:"maxTotalMs"`
QualityWindow     int            `json:"qualityWindow"`
SuccessThreshold  float64        `json:"successThreshold"`
QualThreshold     float64        `json:"qualThreshold"`
SpeedEnabled      bool           `json:"speedEnabled"`
SpeedURL          string         `json:"speedUrl"`
SpeedTimeoutSec   int            `json:"speedTimeoutSec"`
SpeedMinMBps      float64        `json:"speedMinMBps"`
SpeedConcurrency  int            `json:"speedConcurrency"`
SpeedPerCycle     int            `json:"speedPerCycle"`
GitHub            GitHubConfig   `json:"github"`
DataFile          string         `json:"-"`
ConfigFile        string         `json:"-"`
GraveyardFile     string         `json:"-"`
SecretFile        string         `json:"-"`
}

// CustomProbe 自定义探针
type CustomProbe struct {
URL    string `json:"url"`
Expect string `json:"expect"`
}

// GitHubConfig GitHub 配置
type GitHubConfig struct {
	Token             string `json:"-"`
	TokenMasked       string `json:"tokenMasked,omitempty"`
	TokenSet          bool   `json:"tokenSet"`
	Repo              string `json:"repo"`
	Path              string `json:"path"`
	FilePath          string `json:"-"` // 用于上传的文件路径
	Branch            string `json:"branch"`
	Auto              bool   `json:"auto"`
	UploadIntervalMin int    `json:"uploadIntervalMin"`
}

// DefaultConfig 返回默认配置
func DefaultConfig() *Config {
port := 8787
if p := os.Getenv("PORT"); p != "" {
port, _ = strconv.Atoi(p)
}

ipFile := "/app/config/ip.txt"
if f := os.Getenv("IP_FILE"); f != "" {
ipFile = f
}

dataDir := "/app/data"
if d := os.Getenv("DATA_DIR"); d != "" {
dataDir = d
}

intervalSec := 60
if v := os.Getenv("INTERVAL_SEC"); v != "" {
intervalSec, _ = strconv.Atoi(v)
if intervalSec < 5 {
intervalSec = 5
}
}

timeoutSec := 5
if v := os.Getenv("TIMEOUT_SEC"); v != "" {
timeoutSec, _ = strconv.Atoi(v)
if timeoutSec < 1 {
timeoutSec = 1
}
}

concurrency := 50
if v := os.Getenv("CONCURRENCY"); v != "" {
concurrency, _ = strconv.Atoi(v)
if concurrency < 1 {
concurrency = 1
}
}

autoCleanDays := 7.0
if v := os.Getenv("AUTO_CLEAN_DAYS"); v != "" {
autoCleanDays, _ = strconv.ParseFloat(v, 64)
if autoCleanDays < 0 {
autoCleanDays = 0
}
}

maxTotalMs := 0.0
if v := os.Getenv("MAX_TOTAL_MS"); v != "" {
maxTotalMs, _ = strconv.ParseFloat(v, 64)
}

qualityWindow := 10
if v := os.Getenv("QUALITY_WINDOW"); v != "" {
qualityWindow, _ = strconv.Atoi(v)
if qualityWindow < 1 {
qualityWindow = 1
}
if qualityWindow > 50 {
qualityWindow = 50
}
}

successThreshold := 1.0
if v := os.Getenv("SUCCESS_THRESHOLD"); v != "" {
successThreshold, _ = strconv.ParseFloat(v, 64)
if successThreshold < 0 {
successThreshold = 0
}
if successThreshold > 1 {
successThreshold = 1
}
}

qualThreshold := successThreshold
if v := os.Getenv("QUAL_THRESHOLD"); v != "" {
qualThreshold, _ = strconv.ParseFloat(v, 64)
if qualThreshold < 0 {
qualThreshold = 0
}
if qualThreshold > 1 {
qualThreshold = 1
}
}
if qualThreshold > successThreshold {
qualThreshold = successThreshold
}

speedEnabled := true
if v := os.Getenv("SPEED_ENABLED"); v == "false" {
speedEnabled = false
}

speedMinMBps := 0.0
if v := os.Getenv("SPEED_MIN_MBPS"); v != "" {
speedMinMBps, _ = strconv.ParseFloat(v, 64)
if speedMinMBps < 0 {
speedMinMBps = 0
}
}

speedConcurrency := 1
if v := os.Getenv("SPEED_CONCURRENCY"); v != "" {
speedConcurrency, _ = strconv.Atoi(v)
if speedConcurrency < 1 {
speedConcurrency = 1
}
if speedConcurrency > 3 {
speedConcurrency = 3
}
}

speedPerCycle := 20
if v := os.Getenv("SPEED_PER_CYCLE"); v != "" {
speedPerCycle, _ = strconv.Atoi(v)
if speedPerCycle < 1 {
speedPerCycle = 1
}
}

githubRepo := os.Getenv("GITHUB_REPO")
githubPath := os.Getenv("GITHUB_PATH")
if githubPath == "" {
githubPath = "proxyip"
}
githubBranch := os.Getenv("GITHUB_BRANCH")
if githubBranch == "" {
githubBranch = "main"
}
githubAuto := os.Getenv("GITHUB_AUTO_UPLOAD") == "true"
githubInterval := 0
if v := os.Getenv("GITHUB_UPLOAD_INTERVAL_MIN"); v != "" {
githubInterval, _ = strconv.Atoi(v)
if githubInterval < 0 {
githubInterval = 0
}
}

return &Config{
Port:              port,
IPFile:            ipFile,
DataDir:           dataDir,
IntervalSec:       intervalSec,
ProbeURL:          getEnv("PROBE_URL", "https://www.cloudflare.com/cdn-cgi/trace"),
CustomProbes:      []CustomProbe{},
TimeoutSec:        timeoutSec,
Concurrency:       concurrency,
AutoCleanDays:     autoCleanDays,
MaxTotalMs:        maxTotalMs,
QualityWindow:     qualityWindow,
SuccessThreshold:  successThreshold,
QualThreshold:     qualThreshold,
SpeedEnabled:      speedEnabled,
SpeedURL:          getEnv("SPEED_URL", "https://speed.cloudflare.com/__down?bytes=20000000"),
SpeedTimeoutSec:   10,
SpeedMinMBps:      speedMinMBps,
SpeedConcurrency:  speedConcurrency,
SpeedPerCycle:     speedPerCycle,
	GitHub: GitHubConfig{
		Token:             os.Getenv("GITHUB_TOKEN"),
		Repo:              githubRepo,
		Path:              githubPath,
		FilePath:          githubPath,
		Branch:            githubBranch,
		Auto:              githubAuto,
		UploadIntervalMin: githubInterval,
	},
DataFile:      filepath.Join(dataDir, "history.json"),
ConfigFile:    filepath.Join(dataDir, "config.json"),
GraveyardFile: filepath.Join(dataDir, "graveyard.json"),
SecretFile:    filepath.Join(dataDir, "github.secret"),
}
}

func getEnv(key, defaultVal string) string {
if v := os.Getenv(key); v != "" {
return v
}
return defaultVal
}

// LoadFromFile 从文件加载配置
func (c *Config) LoadFromFile(path string) error {
data, err := os.ReadFile(path)
if err != nil {
return err
}

var diskCfg map[string]interface{}
if err := json.Unmarshal(data, &diskCfg); err != nil {
return err
}

// 应用磁盘配置
if v, ok := diskCfg["intervalSec"].(float64); ok {
c.IntervalSec = int(v)
if c.IntervalSec < 5 {
c.IntervalSec = 5
}
}
if v, ok := diskCfg["timeoutSec"].(float64); ok {
c.TimeoutSec = int(v)
if c.TimeoutSec < 1 {
c.TimeoutSec = 1
}
}
if v, ok := diskCfg["concurrency"].(float64); ok {
c.Concurrency = int(v)
if c.Concurrency < 1 {
c.Concurrency = 1
}
}
if v, ok := diskCfg["autoCleanDays"].(float64); ok {
c.AutoCleanDays = v
if c.AutoCleanDays < 0 {
c.AutoCleanDays = 0
}
}
if v, ok := diskCfg["maxTotalMs"].(float64); ok {
c.MaxTotalMs = v
}
if v, ok := diskCfg["probeUrl"].(string); ok && v != "" {
c.ProbeURL = sanitizeURL(v)
}
if v, ok := diskCfg["qualityWindow"].(float64); ok {
c.QualityWindow = int(v)
if c.QualityWindow < 1 {
c.QualityWindow = 1
}
if c.QualityWindow > 50 {
c.QualityWindow = 50
}
}
if v, ok := diskCfg["successThreshold"].(float64); ok {
c.SuccessThreshold = v
if c.SuccessThreshold < 0 {
c.SuccessThreshold = 0
}
if c.SuccessThreshold > 1 {
c.SuccessThreshold = 1
}
c.QualThreshold = c.SuccessThreshold
}
if v, ok := diskCfg["qualThreshold"].(float64); ok {
c.QualThreshold = v
if c.QualThreshold < 0 {
c.QualThreshold = 0
}
if c.QualThreshold > 1 {
c.QualThreshold = 1
}
}
if c.QualThreshold > c.SuccessThreshold {
c.QualThreshold = c.SuccessThreshold
}
if v, ok := diskCfg["speedEnabled"].(bool); ok {
c.SpeedEnabled = v
}
if v, ok := diskCfg["speedUrl"].(string); ok && v != "" {
c.SpeedURL = sanitizeURL(v)
}
if v, ok := diskCfg["speedTimeoutSec"].(float64); ok {
c.SpeedTimeoutSec = int(v)
if c.SpeedTimeoutSec < 3 {
c.SpeedTimeoutSec = 3
}
}
if v, ok := diskCfg["speedMinMBps"].(float64); ok {
c.SpeedMinMBps = v
if c.SpeedMinMBps < 0 {
c.SpeedMinMBps = 0
}
}
if v, ok := diskCfg["speedConcurrency"].(float64); ok {
c.SpeedConcurrency = int(v)
if c.SpeedConcurrency < 1 {
c.SpeedConcurrency = 1
}
if c.SpeedConcurrency > 3 {
c.SpeedConcurrency = 3
}
}
if v, ok := diskCfg["speedPerCycle"].(float64); ok {
c.SpeedPerCycle = int(v)
if c.SpeedPerCycle < 1 {
c.SpeedPerCycle = 1
}
}

if gh, ok := diskCfg["github"].(map[string]interface{}); ok {
if v, ok := gh["repo"].(string); ok {
c.GitHub.Repo = v
}
if v, ok := gh["path"].(string); ok {
c.GitHub.Path = v
}
if v, ok := gh["branch"].(string); ok {
c.GitHub.Branch = v
}
if v, ok := gh["auto"].(bool); ok {
c.GitHub.Auto = v
}
if v, ok := gh["uploadIntervalMin"].(float64); ok {
c.GitHub.UploadIntervalMin = int(v)
if c.GitHub.UploadIntervalMin < 0 {
c.GitHub.UploadIntervalMin = 0
}
}
}

if probes, ok := diskCfg["customProbes"].([]interface{}); ok {
c.CustomProbes = []CustomProbe{}
for _, p := range probes {
if pm, ok := p.(map[string]interface{}); ok {
if url, ok := pm["url"].(string); ok && url != "" {
expect := "200"
if e, ok := pm["expect"].(string); ok {
expect = e
}
c.CustomProbes = append(c.CustomProbes, CustomProbe{
URL:    sanitizeURL(url),
Expect: expect,
})
}
}
}
}

return nil
}

// SaveToFile 保存配置到文件
func (c *Config) SaveToFile(path string) error {
publicCfg := c.PublicConfig()
data, err := json.MarshalIndent(publicCfg, "", "  ")
if err != nil {
return err
}

if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
return err
}

tmpPath := path + ".tmp"
if err := os.WriteFile(tmpPath, data, 0644); err != nil {
return err
}

return os.Rename(tmpPath, path)
}

// PublicConfig 返回公开配置（不含敏感信息）
func (c *Config) PublicConfig() map[string]interface{} {
result := map[string]interface{}{
"intervalSec":       c.IntervalSec,
"timeoutSec":        c.TimeoutSec,
"concurrency":       c.Concurrency,
"autoCleanDays":     c.AutoCleanDays,
"maxTotalMs":        c.MaxTotalMs,
"probeUrl":          c.ProbeURL,
"customProbes":      c.CustomProbes,
"qualityWindow":     c.QualityWindow,
"successThreshold":  c.SuccessThreshold,
"qualThreshold":     c.QualThreshold,
"speedEnabled":      c.SpeedEnabled,
"speedUrl":          c.SpeedURL,
"speedTimeoutSec":   c.SpeedTimeoutSec,
"speedMinMBps":      c.SpeedMinMBps,
"speedConcurrency":  c.SpeedConcurrency,
"speedPerCycle":     c.SpeedPerCycle,
"github": map[string]interface{}{
"tokenSet":          c.GitHub.Token != "",
"tokenMasked":       c.maskToken(c.GitHub.Token),
"repo":              c.GitHub.Repo,
"path":              c.GitHub.Path,
"branch":            c.GitHub.Branch,
"auto":              c.GitHub.Auto,
"uploadIntervalMin": c.GitHub.UploadIntervalMin,
},
}
return result
}

func (c *Config) maskToken(t string) string {
if t == "" {
return ""
}
if len(t) <= 8 {
return "****"
}
return t[:4] + "****" + t[len(t)-4:]
}

func sanitizeURL(u string) string {
u = strings.TrimSpace(u)
u = strings.ReplaceAll(u, "'", "")
u = strings.ReplaceAll(u, "\"", "")
u = strings.ReplaceAll(u, "`", "")
u = strings.ReplaceAll(u, "\\", "")

for _, r := range []rune{' ', '\t', '\n', '\r'} {
u = strings.Map(func(c rune) rune {
if c == r {
return -1
}
return c
}, u)
}

return u
}

// IsURL 检查是否为有效 URL
func IsURL(s string) bool {
return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

// HistoryCap 获取历史记录容量
func (c *Config) HistoryCap() int {
	cap := c.QualityWindow
	if cap < 1 {
		cap = 1
	}
	if cap > 50 {
		cap = 50
	}
	return cap
}

// MaxHistory 返回最大历史记录数（用于存储层）
func (c *Config) MaxHistory() int {
	return c.HistoryCap()
}

// LoadSecret 从文件加载 GitHub Token
func (c *Config) LoadSecret() string {
data, err := os.ReadFile(c.SecretFile)
if err != nil {
return ""
}
return strings.TrimSpace(string(data))
}

// SaveSecret 保存 GitHub Token 到文件
func (c *Config) SaveSecret(token string) error {
if err := os.MkdirAll(filepath.Dir(c.SecretFile), 0755); err != nil {
return err
}
if err := os.WriteFile(c.SecretFile, []byte(token), 0600); err != nil {
return err
}
return os.Chmod(c.SecretFile, 0600)
}

// EnsureIPFile 确保 IP 文件存在
func (c *Config) EnsureIPFile() error {
dir := filepath.Dir(c.IPFile)
if err := os.MkdirAll(dir, 0755); err != nil {
return err
}

info, err := os.Stat(c.IPFile)
if err == nil && info.IsDir() {
os.Remove(c.IPFile)
}

if !fileExists(c.IPFile) {
content := "# 每行：纯 IP / 域名 / http(s) 列表源\n"
return os.WriteFile(c.IPFile, []byte(content), 0644)
}

return nil
}

func fileExists(path string) bool {
_, err := os.Stat(path)
return err == nil
}

// String 返回配置字符串表示
func (c *Config) String() string {
return fmt.Sprintf("Config{Port:%d, Interval:%ds, Concurrency:%d}", c.Port, c.IntervalSec, c.Concurrency)
}
