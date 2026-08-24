package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"proxy-monitor/internal/model"
)

type Store struct {
	dataDir string
	nodes   map[string]*model.NodeInfo
	mu      sync.RWMutex
}

func NewStore(dataDir string) *Store {
	s := &Store{
		dataDir: dataDir,
		nodes:   make(map[string]*model.NodeInfo),
	}
	s.load()
	return s
}

func (s *Store) load() {
	s.mu.Lock()
	defer s.mu.Unlock()

	filePath := filepath.Join(s.dataDir, "nodes.json")
	data, err := os.ReadFile(filePath)
	if err != nil {
		return
	}

	var nodes map[string]*model.NodeInfo
	if err := json.Unmarshal(data, &nodes); err == nil {
		s.nodes = nodes
	}
}

func (s *Store) Save() error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if err := os.MkdirAll(s.dataDir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(s.nodes, "", "  ")
	if err != nil {
		return err
	}

	filePath := filepath.Join(s.dataDir, "nodes.json")
	return os.WriteFile(filePath, data, 0644)
}

func (s *Store) AddNode(node *model.NodeInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nodes[node.ID] = node
}

func (s *Store) UpdateNode(id string, updater func(*model.NodeInfo)) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if node, ok := s.nodes[id]; ok {
		updater(node)
	}
}

func (s *Store) GetNode(id string) *model.NodeInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.nodes[id]
}

func (s *Store) GetAllNodes() []*model.NodeInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	nodes := make([]*model.NodeInfo, 0, len(s.nodes))
	for _, node := range s.nodes {
		nodes = append(nodes, node)
	}
	return nodes
}

func (s *Store) DeleteNode(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.nodes, id)
}

func (s *Store) GetActiveNodes() []*model.NodeInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var active []*model.NodeInfo
	for _, node := range s.nodes {
		if node.Status == model.StatusActive {
			active = append(active, node)
		}
	}
	return active
}

func (s *Store) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.nodes)
}

func (s *Store) ActiveCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	count := 0
	for _, node := range s.nodes {
		if node.Status == model.StatusActive {
			count++
		}
	}
	return count
}

func (s *Store) RemoveOldNodes(maxAge time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	for id, node := range s.nodes {
		if now.Sub(node.LastCheck) > maxAge && !node.Manual {
			delete(s.nodes, id)
		}
	}
}
