package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"proxy-monitor/internal/model"
	"proxy-monitor/internal/store"
)

type ProbeService struct {
	store      *store.Store
	httpClient *http.Client
	semaphore  chan struct{}
}

func NewProbeService(store *store.Store, maxConcurrency int) *ProbeService {
	return &ProbeService{
		store: store,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		semaphore: make(chan struct{}, maxConcurrency),
	}
}

func (p *ProbeService) CheckNode(ctx context.Context, nodeID string) error {
	p.semaphore <- struct{}{}
	defer func() { <-p.semaphore }()

	node := p.store.GetNode(nodeID)
	if node == nil {
		return fmt.Errorf("node not found: %s", nodeID)
	}

	start := time.Now()
	
	req, err := http.NewRequestWithContext(ctx, "GET", node.URL, nil)
	if err != nil {
		p.updateNodeStatus(nodeID, model.StatusError, 0, err.Error())
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ProxyMonitor/2.0)")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		p.updateNodeStatus(nodeID, model.StatusInactive, 0, err.Error())
		return err
	}
	defer resp.Body.Close()

	_, err = io.Copy(io.Discard, resp.Body)
	latency := time.Since(start).Milliseconds()

	if err != nil {
		p.updateNodeStatus(nodeID, model.StatusInactive, latency, err.Error())
		return err
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		p.updateNodeStatus(nodeID, model.StatusActive, latency, "")
	} else {
		p.updateNodeStatus(nodeID, model.StatusInactive, latency, fmt.Sprintf("HTTP %d", resp.StatusCode))
	}

	return nil
}

func (p *ProbeService) SpeedTest(ctx context.Context, nodeID string) (*model.SpeedTestResult, error) {
	node := p.store.GetNode(nodeID)
	if node == nil {
		return nil, fmt.Errorf("node not found: %s", nodeID)
	}

	result := &model.SpeedTestResult{
		NodeID:    nodeID,
		Timestamp: time.Now(),
	}

	start := time.Now()
	
	req, err := http.NewRequestWithContext(ctx, "GET", node.URL+"/speedtest", nil)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return result, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ProxyMonitor/2.0)")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		result.Latency = time.Since(start).Milliseconds()
		return result, err
	}
	defer resp.Body.Close()

	_, err = io.Copy(io.Discard, resp.Body)
	duration := time.Since(start)

	result.Latency = duration.Milliseconds()
	result.Success = err == nil
	
	if err != nil {
		result.Error = err.Error()
	} else {
		result.Speed = float64(resp.ContentLength*8) / duration.Seconds() / 1e6
	}

	return result, nil
}

func (p *ProbeService) updateNodeStatus(id string, status model.NodeStatus, speed int64, errMsg string) {
	p.store.UpdateNode(id, func(node *model.NodeInfo) {
		node.Status = status
		node.Speed = speed
		node.LastCheck = time.Now()
		if errMsg != "" && node.Protocol == "" {
			node.Protocol = "error"
		}
	})
}

func (p *ProbeService) CheckAllNodes(ctx context.Context, nodes []*model.NodeInfo) {
	var wg sync.WaitGroup
	
	for _, node := range nodes {
		wg.Add(1)
		go func(n *model.NodeInfo) {
			defer wg.Done()
			p.CheckNode(ctx, n.ID)
		}(node)
	}
	
	wg.Wait()
}
