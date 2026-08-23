package models

import (
"net"
"regexp"
"strconv"
"strings"
"time"
)

// Unit 表示一个待检测的节点
type Unit struct {
ID           string        `json:"id"`
IP           string        `json:"ip"`
Port         int           `json:"port"`
FirstSeen    time.Time     `json:"firstSeen,omitempty"`
LastOnlineAt *time.Time    `json:"lastOnlineAt,omitempty"`
Kind         string        `json:"kind,omitempty"`
FirstSource  *Source       `json:"firstSource,omitempty"`
Speed        *SpeedResult  `json:"speed,omitempty"`
}

// Source 表示节点来源
type Source struct {
Kind string `json:"kind"`
Name string `json:"name"`
}

// ProbeResult 探针检测结果
type ProbeResult struct {
T          time.Time     `json:"t"`
OK         bool          `json:"ok"`
Off        *Segments     `json:"off,omitempty"`
Cus        *Segments     `json:"cus,omitempty"`
Total      *int          `json:"total,omitempty"`
AvgTCP     *int          `json:"avgTcp,omitempty"`
AvgTLS     *int          `json:"avgTls,omitempty"`
AvgHTTP    *int          `json:"avgHttp,omitempty"`
Colo       *string       `json:"colo,omitempty"`
Loc        *string       `json:"loc,omitempty"`
ExitIP     *string       `json:"exitIp,omitempty"`
FailReason *string       `json:"failReason,omitempty"`
Probes     []ProbeDetail `json:"probes,omitempty"`
}

// ProbeDetail 单个探针详情
type ProbeDetail struct {
Name  string `json:"name"`
TCP   int    `json:"tcp"`
TLS   int    `json:"tls"`
Total int    `json:"total"`
Src   int    `json:"src"`
}

// Segments 延迟分段
type Segments struct {
TCP   int `json:"tcp"`
TLS   int `json:"tls"`
Total int `json:"total"`
Src   int `json:"src"`
}

// SpeedResult 测速结果
type SpeedResult struct {
T          time.Time `json:"t"`
OK         bool      `json:"ok"`
Mbps       *float64  `json:"mbps,omitempty"`
Size       *int      `json:"size,omitempty"`
FailReason *string   `json:"failReason,omitempty"`
}

// HistoryEntry 历史记录条目
type HistoryEntry struct {
	T          time.Time     `json:"t"`
	OK         bool          `json:"ok"`
	Off        *Segments     `json:"off,omitempty"`
	Cus        *Segments     `json:"cus,omitempty"`
	Total      *int          `json:"total,omitempty"`
	AvgTCP     *int          `json:"avgTcp,omitempty"`
	AvgTLS     *int          `json:"avgTls,omitempty"`
	AvgHTTP    *int          `json:"avgHttp,omitempty"`
	Colo       *string       `json:"colo,omitempty"`
	Loc        *string       `json:"loc,omitempty"`
	ExitIP     *string       `json:"exitIp,omitempty"`
	FailReason *string       `json:"failReason,omitempty"`
	Probes     []ProbeDetail `json:"probes,omitempty"`
	SpeedMbps  *float64      `json:"mbps,omitempty"`
}

// QualityResult 质量判定结果
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

// GraveyardEntry 墓地条目
type GraveyardEntry struct {
ID           string `json:"id"`
Label        string `json:"label"`
RemovedAt    int64  `json:"removedAt"`
LastOnlineAt int64  `json:"lastOnlineAt"`
Mode         string `json:"mode"`
Reason       string `json:"reason"`
}

// Graveyard 墓地数据结构
type Graveyard struct {
List    []GraveyardEntry `json:"list"`
Blocked map[string]int64 `json:"blocked,omitempty"`
}

var ipv6Regex = regexp.MustCompile(`^\[([^\]]+)\](?::(\d+))?$`)

func isNumeric(s string) bool {
if s == "" {
return false
}
for _, c := range s {
if c < '0' || c > '9' {
return false
}
}
return true
}

// ParseLine 解析 IP:Port 行
func ParseLine(raw string) (host string, port int, ok bool) {
raw = strings.TrimSpace(raw)
if raw == "" {
return "", 0, false
}
if strings.HasPrefix(raw, "[") {
matches := ipv6Regex.FindStringSubmatch(raw)
if matches == nil {
return "", 0, false
}
host = matches[1]
port = 443
if matches[2] != "" {
port, _ = strconv.Atoi(matches[2])
}
return host, port, true
}
parts := strings.Split(raw, ":")
if len(parts) == 2 && isNumeric(parts[1]) {
host = parts[0]
port, _ = strconv.Atoi(parts[1])
return host, port, true
}
host = raw
port = 443
return host, port, true
}

// IsIPv4 检查是否为 IPv4
func IsIPv4(ip string) bool {
ipObj := net.ParseIP(ip)
return ipObj != nil && strings.Contains(ip, ".")
}

// IsIPv6 检查是否为 IPv6
func IsIPv6(ip string) bool {
ipObj := net.ParseIP(ip)
return ipObj != nil && strings.Contains(ip, ":") && !strings.HasPrefix(ip, "[")
}

// SplitID 分割 ID 为 IP 和 Port
func SplitID(id string) (ip string, port int) {
lastColon := strings.LastIndex(id, ":")
if lastColon == -1 {
return id, 443
}
ip = id[:lastColon]
port, _ = strconv.Atoi(id[lastColon+1:])
if port == 0 {
port = 443
}
return ip, port
}

// BuildSegments 从 curl 时间构建延迟分段
func BuildSegments(tcp, tls, ttfb float64) *Segments {
tcpMs := int(tcp * 1000)
tlsMs := int((tls - tcp) * 1000)
totalMs := int(ttfb * 1000)
src := totalMs - tcpMs - tlsMs
if src < 0 {
src = 0
}
return &Segments{
TCP:   tcpMs,
TLS:   tlsMs,
Total: tcpMs + tlsMs + src,
Src:   src,
}
}
