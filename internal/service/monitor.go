package service

import (
	"context"
	"sync"
	"time"

	"proxy-monitor/internal/config"
	"proxy-monitor/internal/model"
	"proxy-monitor/internal/store"
)

type MonitorService struct {
	config     *config.Config
	store      *store.Store
	probeSvc   *ProbeService
	running    bool
	mu         sync.RWMutex
	startTime  time.Time
	cancelFunc context.CancelFunc
}

func NewMonitorService(cfg *config.Config, store *store.Store) *MonitorService {
	probeSvc := NewProbeService(store, 10)
	
	return &MonitorService{
		config:   cfg,
		store:    store,
		probeSvc: probeSvc,
	}
}

func (m *MonitorService) Start() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.running {
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.cancelFunc = cancel
	m.running = true
	m.startTime = time.Now()

	go m.runLoop(ctx)
}

func (m *MonitorService) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.running {
		return
	}

	if m.cancelFunc != nil {
		m.cancelFunc()
	}
	m.running = false
}

func (m *MonitorService) IsRunning() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.running
}

func (m *MonitorService) GetState() *model.AppState {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var uptime int64
	if m.running {
		uptime = int64(time.Since(m.startTime).Seconds())
	}

	return &model.AppState{
		Running:     m.running,
		NodeCount:   m.store.Count(),
		ActiveCount: m.store.ActiveCount(),
		LastUpdate:  time.Now(),
		Uptime:      uptime,
		Version:     "2.0.0",
	}
}

func (m *MonitorService) runLoop(ctx context.Context) {
	ticker := time.NewTicker(m.config.GetInterval())
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.runCheckCycle(ctx)
		}
	}
}

func (m *MonitorService) runCheckCycle(ctx context.Context) {
	nodes := m.store.GetAllNodes()
	if len(nodes) == 0 {
		return
	}

	m.probeSvc.CheckAllNodes(ctx, nodes)
	
	if err := m.store.Save(); err != nil {
		return
	}

	m.store.RemoveOldNodes(7 * 24 * time.Hour)
}

func (m *MonitorService) AddManualNode(url string) string {
	id := generateNodeID(url)
	
	node := &model.NodeInfo{
		ID:        id,
		URL:       url,
		Status:    model.StatusUnknown,
		LastCheck: time.Now(),
		Manual:    true,
		Kind:      "manual",
	}
	
	m.store.AddNode(node)
	m.store.Save()
	
	return id
}

func (m *MonitorService) RemoveNode(id string) {
	m.store.DeleteNode(id)
	m.store.Save()
}

func (m *MonitorService) GetAllNodes() []*model.NodeInfo {
	return m.store.GetAllNodes()
}

func (m *MonitorService) TriggerSpeedTest(ctx context.Context, nodeID string) (*model.SpeedTestResult, error) {
	return m.probeSvc.SpeedTest(ctx, nodeID)
}

func generateNodeID(url string) string {
	return url
}
