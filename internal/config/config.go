package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/spf13/viper"
)

type Config struct {
	Port       int    `json:"port"`
	DataDir    string `json:"data_dir"`
	Interval   int    `json:"interval_sec"`
	GitHubToken string `json:"github_token,omitempty"`
	GitHubRepo string `json:"github_repo,omitempty"`
	GitHubBranch string `json:"github_branch,omitempty"`
	mu         sync.RWMutex
}

var (
	instance *Config
	once     sync.Once
)

func GetConfig() *Config {
	once.Do(func() {
		instance = &Config{
			Port:       8787,
			DataDir:    "./data",
			Interval:   60,
			GitHubToken: "",
			GitHubRepo: "",
			GitHubBranch: "main",
		}
		instance.load()
	})
	return instance
}

func (c *Config) load() {
	viper.SetConfigName("config")
	viper.SetConfigType("json")
	viper.AddConfigPath(c.DataDir)
	viper.AddConfigPath(".")
	
	if err := viper.ReadInConfig(); err == nil {
		c.mu.Lock()
		defer c.mu.Unlock()
		viper.Unmarshal(c)
	}
}

func (c *Config) Save() error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	
	if err := os.MkdirAll(c.DataDir, 0755); err != nil {
		return err
	}
	
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	
	configPath := filepath.Join(c.DataDir, "config.json")
	return os.WriteFile(configPath, data, 0644)
}

func (c *Config) Update(port int, interval int, token, repo, branch string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	c.Port = port
	c.Interval = interval
	c.GitHubToken = token
	c.GitHubRepo = repo
	c.GitHubBranch = branch
}

func (c *Config) GetPort() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.Port
}

func (c *Config) GetInterval() time.Duration {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return time.Duration(c.Interval) * time.Second
}

func (c *Config) GetDataDir() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.DataDir
}
