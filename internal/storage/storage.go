package storage

import (
	"encoding/json"
	"os"
	"sync"
	"time"

	"proxy-monitor/internal/models"
)

// Storage 线程安全的存储层
type Storage struct {
	mu        sync.RWMutex
	units     map[string]*models.Unit
	history   map[string][]*models.HistoryEntry
	graveyard *models.Graveyard
	blocked   map[string]int64
	dataFile  string
	graveFile string
	maxHist   int
}

// NewStorage 创建存储实例
func NewStorage(dataFile, graveFile string, maxHistory int) *Storage {
	return &Storage{
		units:     make(map[string]*models.Unit),
		history:   make(map[string][]*models.HistoryEntry),
		graveyard: &models.Graveyard{List: []models.GraveyardEntry{}, Blocked: make(map[string]int64)},
		blocked:   make(map[string]int64),
		dataFile:  dataFile,
		graveFile: graveFile,
		maxHist:   maxHistory,
	}
}

// Load 从磁盘加载数据
func (s *Storage) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 加载历史数据
	if data, err := os.ReadFile(s.dataFile); err == nil {
		var saved struct {
			History map[string][]*models.HistoryEntry `json:"history"`
			Nodes   map[string]*models.Unit           `json:"nodes"`
		}
		if json.Unmarshal(data, &saved) == nil {
			if saved.History != nil {
				s.history = saved.History
			}
			if saved.Nodes != nil && len(saved.Nodes) > 0 {
				s.units = saved.Nodes
			}
		}
	}

	// 加载墓地数据
	if data, err := os.ReadFile(s.graveFile); err == nil {
		var g models.Graveyard
		if json.Unmarshal(data, &g) == nil {
			s.graveyard = &g
			if g.Blocked != nil {
				s.blocked = g.Blocked
			}
		}
	}

	return nil
}

// Save 持久化数据到磁盘
func (s *Storage) Save() error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	data := map[string]interface{}{
		"history": s.history,
		"nodes":   s.units,
	}
	jsonData, _ := json.Marshal(data)
	os.WriteFile(s.dataFile, jsonData, 0644)

	graveData, _ := json.Marshal(s.graveyard)
	os.WriteFile(s.graveFile, graveData, 0644)

	return nil
}

// GetUnits 获取所有节点
func (s *Storage) GetUnits() map[string]*models.Unit {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make(map[string]*models.Unit, len(s.units))
	for k, v := range s.units {
		result[k] = v
	}
	return result
}

// GetUnit 获取单个节点
func (s *Storage) GetUnit(id string) (*models.Unit, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.units[id]
	return u, ok
}

// AddUnit 添加节点
func (s *Storage) AddUnit(id string, unit *models.Unit) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.units[id] = unit
}

// RemoveUnit 移除节点
func (s *Storage) RemoveUnit(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.units, id)
}

// GetHistory 获取历史记录
func (s *Storage) GetHistory(id string) []*models.HistoryEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if hist, ok := s.history[id]; ok {
		return hist
	}
	return nil
}

// AddHistory 添加历史记录
func (s *Storage) AddHistory(id string, entry *models.HistoryEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.history[id] == nil {
		s.history[id] = []*models.HistoryEntry{}
	}

	s.history[id] = append(s.history[id], entry)

	// 限制历史记录窗口大小
	if len(s.history[id]) > s.maxHist {
		s.history[id] = s.history[id][len(s.history[id])-s.maxHist:]
	}
}

// IsBlocked 检查是否在墓地中
func (s *Storage) IsBlocked(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, blocked := s.blocked[id]
	return blocked
}

// BlockNode 将节点加入墓地
func (s *Storage) BlockNode(id string, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UnixMilli()
	s.blocked[id] = now

	entry := models.GraveyardEntry{
		ID:           id,
		RemovedAt:    now,
		LastOnlineAt: now,
		Mode:         "auto",
		Reason:       reason,
	}

	s.graveyard.List = append(s.graveyard.List, entry)

	// 限制墓地大小
	if len(s.graveyard.List) > 1000 {
		s.graveyard.List = s.graveyard.List[len(s.graveyard.List)-1000:]
	}
}

// ClearGraveyard 清空墓地
func (s *Storage) ClearGraveyard() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.graveyard.List = []models.GraveyardEntry{}
	s.blocked = make(map[string]int64)
}

// GetGraveyard 获取墓地列表
func (s *Storage) GetGraveyard() []models.GraveyardEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.graveyard.List
}

// BackfillLastOnline 回填最后在线时间
func (s *Storage) BackfillLastOnline() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for id, unit := range s.units {
		if unit.LastOnlineAt != nil {
			continue
		}
		if hist, ok := s.history[id]; ok && len(hist) > 0 {
			for i := len(hist) - 1; i >= 0; i-- {
				if hist[i].OK {
					unit.LastOnlineAt = &hist[i].T
					break
				}
			}
		}
	}
}

// Count 返回节点数量
func (s *Storage) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.units)
}

// HistoryCount 返回有历史记录的节点数
func (s *Storage) HistoryCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.history)
}
