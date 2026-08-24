package model

import (
	"net"
	"strconv"
	"strings"
)

// Node 节点信息
type Node struct {
	ID           string       `json:"id"`
	IP           string       `json:"ip"`
	Port         int          `json:"port"`
	FirstSeen    int64        `json:"firstSeen"`
	LastOnlineAt int64        `json:"lastOnlineAt,omitempty"`
	FirstSource  SourceInfo   `json:"firstSource"`
	Kind         string       `json:"kind"` // cf, proxy, unknown
	Speed        *SpeedResult `json:"speed,omitempty"`
}

// SourceInfo 节点来源信息
type SourceInfo struct {
	Kind string `json:"kind"` // pure, dom, url
	Name string `json:"name"`
}

// ProbeResult 探针结果
type ProbeResult struct {
	T          int64         `json:"t"`
	OK         bool          `json:"ok"`
	Off        *LatencySegs  `json:"off,omitempty"`
	Cus        *LatencySegs  `json:"cus,omitempty"`
	Total      *int          `json:"total,omitempty"`
	AvgTCP     *int          `json:"avgTcp,omitempty"`
	AvgTLS     *int          `json:"avgTls,omitempty"`
	AvgHTTP    *int          `json:"avgHttp,omitempty"`
	Colo       string        `json:"colo,omitempty"`
	Loc        string        `json:"loc,omitempty"`
	ExitIP     string        `json:"exitIp,omitempty"`
	FailReason string        `json:"failReason,omitempty"`
	Probes     []ProbeDetail `json:"probes,omitempty"`
}

// LatencySegs 延迟分段
type LatencySegs struct {
	TCP   int `json:"tcp"`
	TLS   int `json:"tls"`
	Total int `json:"total"`
	Src   int `json:"src"`
}

// ProbeDetail 探针详情
type ProbeDetail struct {
	Name  string `json:"name"`
	TCP   int    `json:"tcp"`
	TLS   int    `json:"tls"`
	Total int    `json:"total"`
	Src   int    `json:"src"`
}

// SpeedResult 测速结果
type SpeedResult struct {
	T          int64   `json:"t"`
	OK         bool    `json:"ok"`
	Mbps       float64 `json:"mbps,omitempty"`
	Size       int     `json:"size,omitempty"`
	FailReason string  `json:"failReason,omitempty"`
}

// QualityResult 质量评估结果
type QualityResult struct {
	Quality   bool    `json:"quality"`
	Rate      float64 `json:"rate"`
	QualRate  float64 `json:"qualRate"`
	AvgTotal  *int    `json:"avgTotal,omitempty"`
	AvgTCP    *int    `json:"avgTcp,omitempty"`
	AvgTLS    *int    `json:"avgTls,omitempty"`
	AvgHTTP   *int    `json:"avgHttp,omitempty"`
	Samples   int     `json:"samples"`
	SpeedPass bool    `json:"speedPass"`
}

// GraveyardEntry 墓碑记录
type GraveyardEntry struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	RemovedAt    int64  `json:"removedAt"`
	LastOnlineAt int64  `json:"lastOnlineAt"`
	Mode         string `json:"mode"` // auto, manual
	Reason       string `json:"reason"`
}

// Graveyard 墓碑管理
type Graveyard struct {
	List    []GraveyardEntry `json:"list"`
	Blocked map[string]int64 `json:"blocked"`
}

// ParseLine 解析 IP 文件行，返回 host, port, isDomain, ok
func ParseLine(raw string) (host string, port int, isDomain bool, ok bool) {
	line := strings.TrimSpace(strings.Split(raw, "#")[0])
	if line == "" {
		return "", 0, false, false
	}

	host = line
	port = 443

	if strings.HasPrefix(line, "[") {
		return "", 0, false, false // 不支持 IPv6
	}

	if idx := strings.LastIndex(line, ":"); idx > 0 {
		if p, err := strconv.Atoi(line[idx+1:]); err == nil {
			host = line[:idx]
			port = p
		}
	}

	// 验证是否为有效 IPv4
	if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
		return host, port, false, true
	}

	// 可能是域名
	return host, port, true, true
}
