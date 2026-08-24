package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

const Version = "v36-window-go"

// GitHubConfig GitHub 配置
type GitHubConfig struct {
	Token             string `json:"token,omitempty"`
	Repo              string `json:"repo"`
	Path              string `json:"path"`
	Branch            string `json:"branch"`
	Auto              bool   `json:"auto"`
	UploadIntervalMin int    `json:"uploadIntervalMin"`
}

// Config 应用配置
type Config struct {
	Port             int           `json:"port"`
	IPFile           string        `json:"ipFile"`
	DataDir          string        `json:"dataDir"`
	IntervalSec      int           `json:"intervalSec"`
	ProbeURL         string        `json:"probeUrl"`
	CustomProbes     []CustomProbe `json:"customProbes"`
	TimeoutSec       int           `json:"timeoutSec"`
	Concurrency      int           `json:"concurrency"`
	AutoCleanDays    float64       `json:"autoCleanDays"`
	MaxTotalMs       float64       `json:"maxTotalMs"`
	QualityWindow    int           `json:"qualityWindow"`
	SuccessThreshold float64       `json:"successThreshold"`
	QualThreshold    float64       `json:"qualThreshold"`
	SpeedEnabled     bool          `json:"speedEnabled"`
	SpeedURL         string        `json:"speedUrl"`
	SpeedTimeoutSec  int           `json:"speedTimeoutSec"`
	SpeedMinMBps     float64       `json:"speedMinMBps"`
	SpeedConcurrency int           `json:"speedConcurrency"`
	SpeedPerCycle    int           `json:"speedPerCycle"`
	GitHub           GitHubConfig  `json:"github"`
	ConfigFile       string        `json:"-"`
	DataFile         string        `json:"-"`
	GraveyardFile    string        `json:"-"`
	SecretFile       string        `json:"-"`
}

// CustomProbe 自定义探针
type CustomProbe struct {
	URL    string `json:"url"`
	Expect string `json:"expect"`
}

// LoadConfig 从环境变量和文件加载配置
func LoadConfig(configFilePath string) (*Config, error) {
	cfg := &Config{
		Port:             getEnvInt("PORT", 8787),
		IPFile:           getEnv("IP_FILE", "/app/config/ip.txt"),
		DataDir:          getEnv("DATA_DIR", "/app/data"),
		IntervalSec:      getEnvInt("INTERVAL_SEC", 60),
		ProbeURL:         getEnv("PROBE_URL", "https://www.cloudflare.com/cdn-cgi/trace"),
		CustomProbes:     []CustomProbe{},
		TimeoutSec:       getEnvInt("TIMEOUT_SEC", 5),
		Concurrency:      getEnvInt("CONCURRENCY", 50),
		AutoCleanDays:    getEnvFloat("AUTO_CLEAN_DAYS", 7),
		MaxTotalMs:       getEnvFloat("MAX_TOTAL_MS", 0),
		QualityWindow:    getEnvInt("QUALITY_WINDOW", 10),
		SuccessThreshold: getEnvFloat("SUCCESS_THRESHOLD", 1),
		QualThreshold:    getEnvFloat("QUAL_THRESHOLD", 1),
		SpeedEnabled:     getEnvBool("SPEED_ENABLED", true),
		SpeedURL:         getEnv("SPEED_URL", "https://speed.cloudflare.com/__down?bytes=20000000"),
		SpeedTimeoutSec:  getEnvInt("SPEED_TIMEOUT_SEC", 10),
		SpeedMinMBps:     getEnvFloat("SPEED_MIN_MBPS", 0),
		SpeedConcurrency: min(3, max(1, getEnvInt("SPEED_CONCURRENCY", 1))),
		SpeedPerCycle:    max(1, getEnvInt("SPEED_PER_CYCLE", 20)),
		GitHub: GitHubConfig{
			Token:             getEnv("GITHUB_TOKEN", ""),
			Repo:              getEnv("GITHUB_REPO", ""),
			Path:              getEnv("GITHUB_PATH", "proxyip"),
			Branch:            getEnv("GITHUB_BRANCH", "main"),
			Auto:              getEnvBool("GITHUB_AUTO_UPLOAD", false),
			UploadIntervalMin: getEnvInt("GITHUB_UPLOAD_INTERVAL_MIN", 0),
		},
	}

	// 设置派生路径
	cfg.ConfigFile = filepath.Join(cfg.DataDir, "config.json")
	cfg.DataFile = filepath.Join(cfg.DataDir, "history.json")
	cfg.GraveyardFile = filepath.Join(cfg.DataDir, "graveyard.json")
	cfg.SecretFile = filepath.Join(cfg.DataDir, "github.secret")

	// 如果提供了配置文件路径，从中读取
	if configFilePath != "" {
		data, err := os.ReadFile(configFilePath)
		if err == nil {
			var fileCfg Config
			if err := json.Unmarshal(data, &fileCfg); err == nil {
				// 环境变量优先于配置文件
				mergeConfig(cfg, &fileCfg)
			}
		}
	}

	// 尝试从默认配置文件路径读取
	if data, err := os.ReadFile(cfg.ConfigFile); err == nil {
		var fileCfg Config
		if err := json.Unmarshal(data, &fileCfg); err == nil {
			mergeConfig(cfg, &fileCfg)
		}
	}

	// 从 secret 文件读取 Token
	if token := readSecret(cfg.SecretFile); token != "" && cfg.GitHub.Token == "" {
		cfg.GitHub.Token = token
	}

	// 确保质量窗口在有效范围内
	cfg.QualityWindow = max(1, min(50, cfg.QualityWindow))

	return cfg, nil
}

func mergeConfig(target *Config, source *Config) {
	if source.IntervalSec > 0 {
		target.IntervalSec = source.IntervalSec
	}
	if source.TimeoutSec > 0 {
		target.TimeoutSec = source.TimeoutSec
	}
	if source.Concurrency > 0 {
		target.Concurrency = source.Concurrency
	}
	if source.AutoCleanDays > 0 {
		target.AutoCleanDays = source.AutoCleanDays
	}
	if source.MaxTotalMs > 0 {
		target.MaxTotalMs = source.MaxTotalMs
	}
	if source.ProbeURL != "" {
		target.ProbeURL = source.ProbeURL
	}
	if source.QualityWindow > 0 {
		target.QualityWindow = source.QualityWindow
	}
	if source.SuccessThreshold > 0 {
		target.SuccessThreshold = source.SuccessThreshold
	}
	if source.QualThreshold > 0 {
		target.QualThreshold = source.QualThreshold
	}
	if len(source.CustomProbes) > 0 {
		target.CustomProbes = source.CustomProbes
	}
	if source.SpeedURL != "" {
		target.SpeedURL = source.SpeedURL
	}
	if source.GitHub.Repo != "" {
		target.GitHub.Repo = source.GitHub.Repo
	}
	if source.GitHub.Path != "" {
		target.GitHub.Path = source.GitHub.Path
	}
	if source.GitHub.Branch != "" {
		target.GitHub.Branch = source.GitHub.Branch
	}
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if i, err := strconv.Atoi(val); err == nil {
			return i
		}
	}
	return defaultVal
}

func getEnvFloat(key string, defaultVal float64) float64 {
	if val := os.Getenv(key); val != "" {
		if f, err := strconv.ParseFloat(val, 64); err == nil {
			return f
		}
	}
	return defaultVal
}

func getEnvBool(key string, defaultVal bool) bool {
	if val := os.Getenv(key); val != "" {
		return val == "true" || val == "1"
	}
	return defaultVal
}

func readSecret(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// SaveConfig 保存配置到文件
func SaveConfig(cfg *Config) error {
	if err := os.MkdirAll(cfg.DataDir, 0755); err != nil {
		return fmt.Errorf("创建数据目录失败：%w", err)
	}

	// 创建不包含敏感信息的公开配置
	publicCfg := map[string]interface{}{
		"intervalSec":      cfg.IntervalSec,
		"timeoutSec":       cfg.TimeoutSec,
		"concurrency":      cfg.Concurrency,
		"autoCleanDays":    cfg.AutoCleanDays,
		"maxTotalMs":       cfg.MaxTotalMs,
		"probeUrl":         cfg.ProbeURL,
		"customProbes":     cfg.CustomProbes,
		"qualityWindow":    cfg.QualityWindow,
		"successThreshold": cfg.SuccessThreshold,
		"qualThreshold":    cfg.QualThreshold,
		"speedEnabled":     cfg.SpeedEnabled,
		"speedUrl":         cfg.SpeedURL,
		"speedTimeoutSec":  cfg.SpeedTimeoutSec,
		"speedMinMBps":     cfg.SpeedMinMBps,
		"speedConcurrency": cfg.SpeedConcurrency,
		"speedPerCycle":    cfg.SpeedPerCycle,
		"github": map[string]interface{}{
			"tokenSet":          cfg.GitHub.Token != "",
			"tokenMasked":       maskToken(cfg.GitHub.Token),
			"repo":              cfg.GitHub.Repo,
			"path":              cfg.GitHub.Path,
			"branch":            cfg.GitHub.Branch,
			"auto":              cfg.GitHub.Auto,
			"uploadIntervalMin": cfg.GitHub.UploadIntervalMin,
		},
	}

	data, err := json.MarshalIndent(publicCfg, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化配置失败：%w", err)
	}

	if err := os.WriteFile(cfg.ConfigFile, data, 0644); err != nil {
		return fmt.Errorf("写入配置文件失败：%w", err)
	}

	return nil
}

// SaveSecret 保存 GitHub Token 到加密文件
func SaveSecret(cfg *Config, token string) error {
	if err := os.MkdirAll(cfg.DataDir, 0755); err != nil {
		return fmt.Errorf("创建数据目录失败：%w", err)
	}

	if err := os.WriteFile(cfg.SecretFile, []byte(token), 0600); err != nil {
		return fmt.Errorf("写入 Token 文件失败：%w", err)
	}

	// 设置文件权限为 600
	if err := os.Chmod(cfg.SecretFile, 0600); err != nil {
		return fmt.Errorf("设置文件权限失败：%w", err)
	}

	return nil
}

func maskToken(token string) string {
	if token == "" {
		return ""
	}
	if len(token) <= 8 {
		return "****"
	}
	return token[:4] + "****" + token[len(token)-4:]
}

// MaskToken 导出用于 handler 包
func MaskToken(token string) string {
	return maskToken(token)
}
