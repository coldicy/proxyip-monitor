package model

import "time"

type NodeStatus string

const (
	StatusUnknown   NodeStatus = "unknown"
	StatusActive    NodeStatus = "active"
	StatusInactive  NodeStatus = "inactive"
	StatusError     NodeStatus = "error"
)

type NodeInfo struct {
	ID         string     `json:"id"`
	URL        string     `json:"url"`
	Country    string     `json:"country,omitempty"`
	Anonymity  string     `json:"anonymity,omitempty"`
	Protocol   string     `json:"protocol,omitempty"`
	Speed      int64      `json:"speed_ms"`
	LastCheck  time.Time  `json:"last_check"`
	Status     NodeStatus `json:"status"`
	Kind       string     `json:"kind,omitempty"`
	Source     string     `json:"source,omitempty"`
	Manual     bool       `json:"manual"`
}

type AppState struct {
	Running      bool       `json:"running"`
	NodeCount    int        `json:"node_count"`
	ActiveCount  int        `json:"active_count"`
	LastUpdate   time.Time  `json:"last_update"`
	Uptime       int64      `json:"uptime_sec"`
	Version      string     `json:"version"`
}

type SpeedTestResult struct {
	NodeID     string  `json:"node_id"`
	Speed      float64 `json:"speed_mbps"`
	Latency    int64   `json:"latency_ms"`
	Success    bool    `json:"success"`
	Error      string  `json:"error,omitempty"`
	Timestamp  time.Time `json:"timestamp"`
}
