package detector

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"proxy-monitor/internal/config"
	"proxy-monitor/internal/models"
)

// Detector 探测器
type Detector struct {
	cfg       *config.Config
	cfCidrs   []string
	cfCidrsAt time.Time
	mu        sync.RWMutex
	httpClient *http.Client
}

// CurlResult curl 结果
type CurlResult struct {
	TCP   float64 `json:"tcp"`
	TLS   float64 `json:"tls"`
	TTFB  float64 `json:"ttfb"`
	HTTP  int     `json:"http"`
	Speed float64 `json:"speed"`
	Size  int     `json:"size"`
	Time  float64 `json:"time"`
}

// NewDetector 创建探测器
func NewDetector(cfg *config.Config) *Detector {
	return &Detector{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 20 * time.Second,
			Transport: &http.Transport{
				DialContext: (&net.Dialer{
					Timeout: 10 * time.Second,
				}).DialContext,
				TLSHandshakeTimeout: 10 * time.Second,
			},
		},
	}
}

// RefreshCfCidrs 刷新 Cloudflare CIDR 列表
func (d *Detector) RefreshCfCidrs(force bool) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	now := time.Now()
	if !force && len(d.cfCidrs) > 0 && now.Sub(d.cfCidrsAt) < 12*time.Hour {
		return nil
	}

	live := []string{}
	resp, err := d.httpClient.Get("https://www.cloudflare.com/ips-v4")
	if err == nil && resp.StatusCode == 200 {
		defer resp.Body.Close()
		scanner := bufio.NewScanner(resp.Body)
		cidrRegex := regexp.MustCompile(`^\d+\.\d+\.\d+\.\d+/\d+$`)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if cidrRegex.MatchString(line) {
				live = append(live, line)
			}
		}
	} else if err != nil {
		fmt.Printf("⚠️ 获取 CF IP 段失败：%v\n", err)
	}

	// 合并内置超网和在线获取的
	allCidrs := append(CF_SUPERNETS, live...)
	seen := make(map[string]bool)
	unique := []string{}
	for _, c := range allCidrs {
		if !seen[c] {
			seen[c] = true
			unique = append(unique, c)
		}
	}

	d.cfCidrs = unique
	d.cfCidrsAt = now
	fmt.Printf("🌐 CF IP 分类集合已更新：%d 条\n", len(d.cfCidrs))
	return nil
}

// ClassifyIP 分类 IP
func (d *Detector) ClassifyIP(ip string) string {
	d.mu.RLock()
	defer d.mu.RUnlock()

	if ip == "" || net.ParseIP(ip) == nil || !strings.Contains(ip, ".") {
		return "unknown"
	}
	if len(d.cfCidrs) == 0 {
		return "unknown"
	}

	ipObj := net.ParseIP(ip)
	for _, cidr := range d.cfCidrs {
		_, cidrNet, err := net.ParseCIDR(cidr)
		if err == nil && cidrNet.Contains(ipObj) {
			return "cf"
		}
	}
	return "proxy"
}

// Discover 发现新节点
func (d *Detector) Discover(nodes map[string]*models.Unit, history map[string][]*models.HistoryEntry, blocked map[string]int64) (int, error) {
	if err := d.RefreshCfCidrs(false); err != nil {
		return 0, err
	}

	now := time.Now()
	lines, err := d.readIPFile()
	if err != nil {
		lines = []string{}
	}

	present := make(map[string]bool)
	var domJobs []domJob
	var urlJobs []urlJob
	var adds []addEntry

	for _, raw := range lines {
		commentIdx := strings.Index(raw, "#")
		if commentIdx >= 0 {
			raw = raw[:commentIdx]
		}
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}

		key := d.sourceKeyForLine(line)
		if key == "" || present[key] {
			continue
		}
		present[key] = true

		if strings.HasPrefix(key, "pure:") {
			id := key[5:]
			adds = append(adds, addEntry{id: id, kind: "pure", name: id})
		} else if strings.HasPrefix(key, "dom:") {
			hp := key[4:]
			lastColon := strings.LastIndex(hp, ":")
			host := hp[:lastColon]
			port, _ := strconv.Atoi(hp[lastColon+1:])
			domJobs = append(domJobs, domJob{host: host, port: port, kind: "dom", name: host})
		} else if strings.HasPrefix(key, "url:") {
			urlJobs = append(urlJobs, urlJob{url: key[4:], kind: "url", name: key[4:]})
		}
	}

	// 并发解析域名
	var domMu sync.Mutex
	sem := make(chan struct{}, 20)
	var wg sync.WaitGroup
	for _, j := range domJobs {
		wg.Add(1)
		go func(job domJob) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			
			resolver := &net.Resolver{}
			ips, err := resolver.LookupIP(ctx, "ip4", job.host)
			if err != nil {
				return
			}

			domMu.Lock()
			defer domMu.Unlock()
			for _, ip := range ips {
				ipStr := ip.String()
				if net.ParseIP(ipStr) != nil && strings.Contains(ipStr, ".") {
					adds = append(adds, addEntry{
						id:   fmt.Sprintf("%s:%d", ipStr, job.port),
						kind: job.kind,
						name: job.name,
					})
				}
			}
		}(j)
	}
	wg.Wait()

	// 并发获取 URL 列表
	urlSem := make(chan struct{}, 8)
	var urlWg sync.WaitGroup
	for _, j := range urlJobs {
		urlWg.Add(1)
		go func(job urlJob) {
			defer urlWg.Done()
			urlSem <- struct{}{}
			defer func() { <-urlSem }()

			content, err := d.fetchList(job.url)
			if err != nil {
				return
			}

			scanner := bufio.NewScanner(strings.NewReader(content))
			for scanner.Scan() {
				l := scanner.Text()
				commentIdx := strings.Index(l, "#")
				if commentIdx >= 0 {
					l = l[:commentIdx]
				}
				l = strings.TrimSpace(l)
				if l == "" || strings.HasPrefix(l, "http") {
					continue
				}

				host, port, ok := models.ParseLine(l)
				if !ok || net.ParseIP(host) == nil || !strings.Contains(host, ".") {
					continue
				}

				domMu.Lock()
				adds = append(adds, addEntry{
					id:   fmt.Sprintf("%s:%d", host, port),
					kind: job.kind,
					name: job.name,
				})
				domMu.Unlock()
			}
		}(j)
	}
	urlWg.Wait()

	// 添加新节点
	added := 0
	for _, a := range adds {
		if _, exists := blocked[a.id]; exists {
			continue
		}
		if _, exists := nodes[a.id]; exists {
			continue
		}

		ip, port := models.SplitID(a.id)
		nodes[a.id] = &models.Unit{
			ID:        a.id,
			IP:        ip,
			Port:      port,
			FirstSeen: now,
			FirstSource: &models.Source{
				Kind: a.kind,
				Name: a.name,
			},
			Kind: d.ClassifyIP(ip),
		}
		added++
	}

	return added, nil
}

type domJob struct {
	host string
	port int
	kind string
	name string
}

type urlJob struct {
	url  string
	kind string
	name string
}

type addEntry struct {
	id   string
	kind string
	name string
}

func (d *Detector) readIPFile() ([]string, error) {
	data, err := os.ReadFile(d.cfg.IPFile)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(data), "\n")
	return lines, nil
}

func (d *Detector) sourceKeyForLine(line string) string {
	if strings.HasPrefix(line, "http://") || strings.HasPrefix(line, "https://") {
		return "url:" + line
	}

	host, port, ok := models.ParseLine(line)
	if !ok {
		return ""
	}

	ip := net.ParseIP(host)
	if ip == nil {
		// 域名
		return "dom:" + host + ":" + strconv.Itoa(port)
	}

	if strings.Contains(host, ":") {
		// IPv6，暂不处理
		return ""
	}

	return "pure:" + host + ":" + strconv.Itoa(port)
}

func (d *Detector) fetchList(urlStr string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", urlStr, nil)
	if err != nil {
		return "", err
	}

	resp, err := d.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	limitReader := io.LimitReader(resp.Body, 2*1024*1024)
	data, err := io.ReadAll(limitReader)
	if err != nil {
		return "", err
	}

	return string(data), nil
}

// ProbeLatency 官方探针延迟测试
func (d *Detector) ProbeLatency(u *models.Unit) *models.ProbeResult {
	result := &models.ProbeResult{
		T:          time.Now(),
		OK:         false,
		FailReason: strPtr("无有效 IP"),
	}

	if u.IP == "" {
		return result
	}

	probeURL, err := url.Parse(d.cfg.ProbeURL)
	if err != nil {
		result.FailReason = strPtr("探针 URL 解析失败")
		return result
	}

	ms := d.cfg.TimeoutSec * 1000
	ua := fmt.Sprintf("PM-%s", randomString(8))

	// 构建 curl 命令
	resolveArg := fmt.Sprintf("%s:%d:%s", probeURL.Hostname(), u.Port, u.IP)
	curlCmd := fmt.Sprintf(
		`curl -4 -k -s --noproxy '*' --retry 0 -A '%s' -w '\n{"tcp":%%{time_connect},"tls":%%{time_appconnect},"ttfb":%%{time_starttransfer},"http":%%{http_code}}' --resolve "%s" --connect-timeout 3 --max-time %d 'https://%s:%d%s'`,
		ua, resolveArg, d.cfg.TimeoutSec+2, probeURL.Hostname(), u.Port, probeURL.Path,
	)
	if probeURL.RawQuery != "" {
		curlCmd = fmt.Sprintf(
			`curl -4 -k -s --noproxy '*' --retry 0 -A '%s' -w '\n{"tcp":%%{time_connect},"tls":%%{time_appconnect},"ttfb":%%{time_starttransfer},"http":%%{http_code}}' --resolve "%s" --connect-timeout 3 --max-time %d 'https://%s:%d%s?%s'`,
			ua, resolveArg, d.cfg.TimeoutSec+2, probeURL.Hostname(), u.Port, probeURL.Path, probeURL.RawQuery,
		)
	}

	var lastOut string
	var lastCode int
	var lat *CurlResult
	for attempt := 0; attempt < 2; attempt++ {
		out, code := d.runCurl(curlCmd, ms+2500)
		lastOut = out
		lastCode = code
		if code == 0 || code == 28 {
			lat = parseCurlJSON(out)
			if lat != nil && lat.HTTP != 0 && lat.HTTP != 0 {
				break
			}
		}
	}

	if lat != nil && lat.HTTP == 200 {
		// 解析 trace 输出
		traceLines := strings.Split(strings.TrimSpace(lastOut), "\n")
		if len(traceLines) > 1 {
			traceContent := strings.Join(traceLines[:len(traceLines)-1], "\n")
			traceMap := parseTrace(traceContent)
			
			// 检查是否为 CF 内容
			if traceMap["colo"] == "" && traceMap["fl"] == "" {
				result.FailReason = strPtr("官方探针返回非 CF 内容 (不具备反代能力)")
				return result
			}

			// 检查 UA 回显
			if !strings.Contains(lastOut, "uag="+ua) {
				result.FailReason = strPtr("官方探针 UA 未回显 (疑似伪造 trace)")
				return result
			}

			result.OK = true
			result.Off = models.BuildSegments(lat.TCP, lat.TLS, lat.TTFB)
			if traceMap["colo"] != "" {
				result.Colo = strPtr(traceMap["colo"])
			}
			if traceMap["loc"] != "" {
				result.Loc = strPtr(traceMap["loc"])
			}
			if traceMap["ip"] != "" {
				result.ExitIP = strPtr(traceMap["ip"])
			}
		} else {
			result.FailReason = strPtr("无法解析探针响应")
		}
	} else {
		failReason := curlFailText(lastCode)
		if failReason == "" {
			failReason = fmt.Sprintf("不具备反代 CF 能力 (HTTP %d)", lat.HTTP)
		}
		result.FailReason = strPtr(failReason)
	}

	return result
}

// ProbeCustoms 自定义探针测试
func (d *Detector) ProbeCustoms(u *models.Unit) []ProbeCustomResult {
	results := []ProbeCustomResult{}
	ms := d.cfg.TimeoutSec * 1000

	for _, p := range d.cfg.CustomProbes {
		result := ProbeCustomResult{
			URL:    p.URL,
			Expect: p.Expect,
			Code:   "000",
			OK:     false,
		}

		probeURL, err := url.Parse(p.URL)
		if err != nil {
			result.FailReason = "配置错误"
			results = append(results, result)
			continue
		}

		resolveArg := fmt.Sprintf("%s:%d:%s", probeURL.Hostname(), u.Port, u.IP)
		curlCmd := fmt.Sprintf(
			`curl -4 -k -s --noproxy '*' --retry 0 -o /dev/null -w '{"tcp":%%{time_connect},"tls":%%{time_appconnect},"ttfb":%%{time_starttransfer},"http":%%{http_code}}' --resolve "%s" --connect-timeout 3 --max-time %d 'https://%s:%d%s'`,
			resolveArg, d.cfg.TimeoutSec+2, probeURL.Hostname(), u.Port, probeURL.Path,
		)
		if probeURL.RawQuery != "" {
			curlCmd = fmt.Sprintf(
				`curl -4 -k -s --noproxy '*' --retry 0 -o /dev/null -w '{"tcp":%%{time_connect},"tls":%%{time_appconnect},"ttfb":%%{time_starttransfer},"http":%%{http_code}}' --resolve "%s" --connect-timeout 3 --max-time %d 'https://%s:%d%s?%s'`,
				resolveArg, d.cfg.TimeoutSec+2, probeURL.Hostname(), u.Port, probeURL.Path, probeURL.RawQuery,
			)
		}

		out, code := d.runCurl(curlCmd, ms+2500)
		res := parseCurlJSON(out)
		
		httpCode := "000"
		if res != nil && res.HTTP != 0 {
			httpCode = strconv.Itoa(res.HTTP)
		}
		result.Code = httpCode

		if code != 0 && res == nil {
			result.FailReason = fmt.Sprintf("连接失败 (%s)", curlFailText(code))
		} else if httpCode != p.Expect {
			result.FailReason = fmt.Sprintf("预期%s实际%s", p.Expect, httpCode)
		} else {
			result.OK = true
			if res != nil {
				result.Segs = models.BuildSegments(res.TCP, res.TLS, res.TTFB)
			}
		}

		result.Host = probeURL.Hostname()
		results = append(results, result)
	}

	return results
}

type ProbeCustomResult struct {
	URL       string         `json:"url"`
	Host      string         `json:"host"`
	Expect    string         `json:"expect"`
	Code      string         `json:"code"`
	Segs      *models.Segments `json:"segs,omitempty"`
	OK        bool           `json:"ok"`
	FailReason string        `json:"failReason,omitempty"`
}

// ProbeSpeed 测速
func (d *Detector) ProbeSpeed(u *models.Unit) *models.SpeedResult {
	result := &models.SpeedResult{
		T:          time.Now(),
		OK:         false,
		FailReason: strPtr("无有效 IP"),
	}

	if u.IP == "" {
		return result
	}

	speedURL, err := url.Parse(d.cfg.SpeedURL)
	if err != nil {
		result.FailReason = strPtr("测速 URL 解析失败")
		return result
	}

	timestamp := time.Now().UnixMilli()
	resolveArg := fmt.Sprintf("%s:%d:%s", speedURL.Hostname(), u.Port, u.IP)
	
	querySep := "?"
	if strings.Contains(speedURL.Path, "?") || strings.Contains(speedURL.RawQuery, "=") {
		querySep = "&"
	}
	
	curlCmd := fmt.Sprintf(
		`curl -k -s --retry 0 -o /dev/null -w '{"speed":%%{speed_download},"size":%%{size_download},"time":%%{time_total},"http":%%{http_code}}' --resolve "%s" --connect-timeout 3 --max-time %d 'https://%s:%d%s%s_t=%d'`,
		resolveArg, d.cfg.SpeedTimeoutSec, speedURL.Hostname(), u.Port, speedURL.Path, querySep, timestamp,
	)

	out, code := d.runCurl(curlCmd, d.cfg.SpeedTimeoutSec*1000+2500)
	j := parseCurlJSON(out)

	const speedMinBytes = 64 * 1024
	size := 0
	secs := 0.0
	httpCode := "000"

	if j != nil {
		size = j.Size
		secs = j.Time
		if j.HTTP != 0 {
			httpCode = strconv.Itoa(j.HTTP)
		}
	}

	kb := fmt.Sprintf("%.1f", float64(size)/1024)

	if size >= speedMinBytes && secs > 0 {
		mbps := float64(size) / secs / 1048576
		mbpsRounded := float64(int(mbps*100)) / 100
		
		if mbpsRounded > 0 && (httpCode == "200" || code == 28 || code == 18) {
			result.OK = true
			result.Mbps = &mbpsRounded
			result.Size = &size
			return result
		}
		result.FailReason = strPtr(fmt.Sprintf("测速失败 (HTTP %s, 收到 %sKB/%.1fs, 疑似非下载响应)", httpCode, kb, secs))
		return result
	}

	if j != nil {
		extra := ""
		if code != 0 {
			extra = fmt.Sprintf(", curl %d", code)
		}
		result.FailReason = strPtr(fmt.Sprintf("测速失败 (HTTP %s, 仅收到 %sKB%s%s)", httpCode, kb, func() string {
			if secs > 0 {
				return "/" + fmt.Sprintf("%.1f", secs) + "s"
			}
			return ""
		}(), extra))
	} else {
		result.FailReason = strPtr(fmt.Sprintf("测速失败 (%s)", curlFailText(code)))
	}

	return result
}

func (d *Detector) runCurl(cmd string, timeoutMs int) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	execCmd := exec.CommandContext(ctx, "sh", "-c", cmd)
	var stdout bytes.Buffer
	execCmd.Stdout = &stdout
	execCmd.Stderr = nil
	
	err := execCmd.Run()
	
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}

	return stdout.String(), exitCode
}

func parseCurlJSON(out string) *CurlResult {
	out = strings.TrimSpace(out)
	if out == "" {
		return nil
	}

	lines := strings.Split(out, "\n")
	lastLine := strings.TrimSpace(lines[len(lines)-1])

	var result CurlResult
	if err := json.Unmarshal([]byte(lastLine), &result); err != nil {
		return nil
	}

	return &result
}

func parseTrace(t string) map[string]string {
	result := make(map[string]string)
	lines := strings.ReplaceAll(t, "\r", "")
	for _, line := range strings.Split(lines, "\n") {
		idx := strings.Index(line, "=")
		if idx > 0 {
			key := strings.TrimSpace(line[:idx])
			val := strings.TrimSpace(line[idx+1:])
			result[key] = val
		}
	}
	return result
}

func curlFailText(code int) string {
	switch code {
	case 28:
		return "超时"
	case 7:
		return "连接被拒"
	case 35, 60, 61:
		return "TLS 错误"
	case -1:
		return "进程超时/被杀"
	case 6:
		return "DNS 解析失败"
	default:
		if code != 0 {
			return fmt.Sprintf("curl 错误 %d", code)
		}
		return ""
	}
}

func strPtr(s string) *string {
	return &s
}

func randomString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

// CF_SUPERNETS Cloudflare 内置超网
var CF_SUPERNETS = []string{
	"103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
	"104.16.0.0/13", "104.24.0.0/14", "108.162.192.0/18",
	"131.0.72.0/22", "141.101.64.0/18", "162.158.0.0/15",
	"172.64.0.0/13", "173.245.48.0/20", "188.114.96.0/20",
	"190.93.240.0/20", "197.234.240.0/22", "198.41.128.0/17",
}
