package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
)

// Source fetches one content object by its SHA-256 from the space's content pool.
type Source interface {
	Get(ctx context.Context, sha string) (io.ReadCloser, error)
}

// Store keeps verified copies in a root-private cache. A cache file exists only after its bytes matched the
// manifest's size and SHA-256, so serving from the cache is serving verified content.
type Store struct {
	dir      string
	source   Source
	budget   int64
	used     atomic.Int64
	slots    chan struct{}
	mu       sync.Mutex
	inflight map[string]*call
}

type call struct {
	done chan struct{}
	path string
	err  error
}

var ErrBudget = errors.New("read budget for this attempt is exhausted")

func NewStore(dir string, source Source, budget int64, concurrency int) (*Store, error) {
	if budget < 0 {
		return nil, errors.New("read budget must be nonnegative")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if concurrency < 1 {
		concurrency = 1
	}
	return &Store{dir: dir, source: source, budget: budget, slots: make(chan struct{}, concurrency), inflight: map[string]*call{}}, nil
}

// Ensure returns the path of a verified local copy of entry, fetching it once even under concurrent opens.
func (s *Store) Ensure(ctx context.Context, e Entry) (string, error) {
	target := filepath.Join(s.dir, e.SHA256)
	if info, err := os.Stat(target); err == nil && info.Size() == e.Size {
		return target, nil
	}
	s.mu.Lock()
	if c, ok := s.inflight[e.SHA256]; ok {
		s.mu.Unlock()
		select {
		case <-c.done:
			return c.path, c.err
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	c := &call{done: make(chan struct{})}
	s.inflight[e.SHA256] = c
	s.mu.Unlock()
	c.path, c.err = s.fetch(ctx, e, target)
	s.mu.Lock()
	delete(s.inflight, e.SHA256)
	s.mu.Unlock()
	close(c.done)
	return c.path, c.err
}

func (s *Store) fetch(ctx context.Context, e Entry, target string) (string, error) {
	// Reserve the one extra byte needed to detect oversized objects as well.
	// A failed digest or interrupted copy still consumed network bytes; those
	// bytes must remain charged or repeated tampered reads bypass the budget.
	reserved := e.Size + 1
	if reserved <= 0 {
		return "", ErrBudget
	}
	if s.used.Add(reserved) > s.budget {
		s.used.Add(-reserved)
		return "", ErrBudget
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	case <-ctx.Done():
		s.used.Add(-reserved)
		return "", ctx.Err()
	}
	body, err := s.source.Get(ctx, e.SHA256)
	if err != nil {
		s.used.Add(-reserved)
		return "", fmt.Errorf("fetch: %w", err)
	}
	defer body.Close()
	tmp, err := os.CreateTemp(s.dir, ".partial-*")
	if err != nil {
		s.used.Add(-reserved)
		return "", err
	}
	keep := false
	defer func() {
		if !keep {
			os.Remove(tmp.Name())
		}
	}()
	hash := sha256.New()
	// Never read past the declared size: a longer object is rejected without unbounded I/O.
	n, err := io.Copy(io.MultiWriter(tmp, hash), io.LimitReader(body, e.Size+1))
	charged := n
	if err != nil {
		// io.Copy reports bytes written. A failed writer may have consumed a
		// larger source chunk, so retain the bounded reservation on uncertainty.
		charged = reserved
	}
	s.used.Add(charged - reserved)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if n != e.Size || hex.EncodeToString(hash.Sum(nil)) != e.SHA256 {
		return "", errors.New("content does not match the authorized size and SHA-256")
	}
	if err := os.Chmod(tmp.Name(), 0o444); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), target); err != nil {
		return "", err
	}
	keep = true
	return target, nil
}
