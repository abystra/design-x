package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

type fakeSource struct {
	objects map[string][]byte
	gets    atomic.Int64
}

func (f *fakeSource) Get(_ context.Context, sha string) (io.ReadCloser, error) {
	f.gets.Add(1)
	data, ok := f.objects[sha]
	if !ok {
		return nil, errors.New("missing")
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func TestManifestRejectsEscapesCollisionsAndBadDigests(t *testing.T) {
	good := digest([]byte("x"))
	cases := map[string][]Entry{
		"absolute":   {{Path: "/etc/passwd", Size: 1, SHA256: good}},
		"dotdot":     {{Path: "a/../b", Size: 1, SHA256: good}},
		"control":    {{Path: "a\nb", Size: 1, SHA256: good}},
		"duplicate":  {{Path: "a", Size: 1, SHA256: good}, {Path: "a", Size: 1, SHA256: good}},
		"collision":  {{Path: "a", Size: 1, SHA256: good}, {Path: "a/b", Size: 1, SHA256: good}},
		"bad digest": {{Path: "a", Size: 1, SHA256: "nope"}},
		"too large":  {{Path: "a", Size: MaxFileBytes + 1, SHA256: good}},
	}
	for name, entries := range cases {
		if err := (&Manifest{Version: 1, Entries: entries}).Validate(); err == nil {
			t.Errorf("%s: expected rejection", name)
		}
	}
	if err := (&Manifest{Version: 1, Entries: []Entry{{Path: "个人资料库/报告.md", Size: 1, SHA256: good}}}).Validate(); err != nil {
		t.Fatalf("valid CJK path rejected: %v", err)
	}
}

func TestLoadManifestFromGzip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "m.json.gz")
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	json.NewEncoder(zw).Encode(Manifest{Version: 1, Entries: []Entry{{Path: "a.txt", Size: 1, SHA256: digest([]byte("x"))}}})
	zw.Close()
	os.WriteFile(path, buf.Bytes(), 0o600)
	m, err := LoadManifest(path)
	if err != nil || len(m.Entries) != 1 {
		t.Fatalf("load: %v %v", m, err)
	}
}

func TestStoreServesOnlyVerifiedContentAndFetchesOncePerDigest(t *testing.T) {
	data := []byte("verified content")
	src := &fakeSource{objects: map[string][]byte{digest(data): data}}
	store, _ := NewStore(t.TempDir(), src, 1<<20, 4)
	entry := Entry{Path: "a.txt", Size: int64(len(data)), SHA256: digest(data)}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			path, err := store.Ensure(context.Background(), entry)
			if err != nil {
				t.Error(err)
				return
			}
			if got, _ := os.ReadFile(path); !bytes.Equal(got, data) {
				t.Error("served content differs")
			}
		}()
	}
	wg.Wait()
	if src.gets.Load() != 1 {
		t.Fatalf("expected one fetch for concurrent opens, got %d", src.gets.Load())
	}
}

func TestTamperedOrWrongSizeContentFailsClosedAndLeavesNoCache(t *testing.T) {
	good := []byte("original")
	dir := t.TempDir()
	src := &fakeSource{objects: map[string][]byte{digest(good): []byte("tampered")}}
	store, _ := NewStore(dir, src, 1<<20, 1)
	if _, err := store.Ensure(context.Background(), Entry{Path: "a", Size: int64(len(good)), SHA256: digest(good)}); err == nil {
		t.Fatal("tampered content was accepted")
	}
	src.objects[digest(good)] = append(append([]byte{}, good...), 'x')
	if _, err := store.Ensure(context.Background(), Entry{Path: "a", Size: int64(len(good)), SHA256: digest(good)}); err == nil {
		t.Fatal("oversized content was accepted")
	}
	left, _ := os.ReadDir(dir)
	if len(left) != 0 {
		t.Fatalf("unverified bytes left in cache: %v", left)
	}
}

func TestReadBudgetIsEnforced(t *testing.T) {
	data := []byte("0123456789")
	src := &fakeSource{objects: map[string][]byte{digest(data): data}}
	store, _ := NewStore(t.TempDir(), src, 5, 1)
	if _, err := store.Ensure(context.Background(), Entry{Path: "a", Size: 10, SHA256: digest(data)}); !errors.Is(err, ErrBudget) {
		t.Fatalf("expected budget error, got %v", err)
	}
}

func TestFailedIntegrityReadsRemainCharged(t *testing.T) {
	good := []byte("original!")
	src := &fakeSource{objects: map[string][]byte{digest(good): []byte("tampered!")}}
	store, _ := NewStore(t.TempDir(), src, int64(2*(len(good)+1)), 1)
	entry := Entry{Path: "a", Size: int64(len(good)), SHA256: digest(good)}
	for i := 0; i < 2; i++ {
		if _, err := store.Ensure(context.Background(), entry); err == nil || errors.Is(err, ErrBudget) {
			t.Fatalf("expected integrity rejection, got %v", err)
		}
	}
	if _, err := store.Ensure(context.Background(), entry); !errors.Is(err, ErrBudget) {
		t.Fatalf("repeated failed reads bypassed the budget: %v", err)
	}
	if src.gets.Load() != 2 || store.used.Load() != int64(2*len(good)) {
		t.Fatalf("failed bytes must remain charged; gets=%d used=%d", src.gets.Load(), store.used.Load())
	}
}

func TestOversizeVerificationByteIsCharged(t *testing.T) {
	good := []byte("valid")
	src := &fakeSource{objects: map[string][]byte{digest(good): []byte("valid-extra-bytes")}}
	store, _ := NewStore(t.TempDir(), src, int64(len(good)+1), 1)
	entry := Entry{Path: "a", Size: int64(len(good)), SHA256: digest(good)}
	if _, err := store.Ensure(context.Background(), entry); err == nil {
		t.Fatal("oversized object passed verification")
	}
	if store.used.Load() != int64(len(good)+1) {
		t.Fatalf("oversize verification byte was not charged: %d", store.used.Load())
	}
	if _, err := store.Ensure(context.Background(), entry); !errors.Is(err, ErrBudget) {
		t.Fatalf("expected exhausted budget, got %v", err)
	}
}

type interruptedReadSource struct{}

func (interruptedReadSource) Get(_ context.Context, _ string) (io.ReadCloser, error) {
	return io.NopCloser(interruptedReader{}), nil
}

type interruptedReader struct{}

func (interruptedReader) Read(buffer []byte) (int, error) {
	buffer[0] = 'x'
	return 1, io.ErrUnexpectedEOF
}

func TestInterruptedCopyKeepsItsBoundedReservation(t *testing.T) {
	store, _ := NewStore(t.TempDir(), interruptedReadSource{}, 11, 1)
	entry := Entry{Path: "a", Size: 10, SHA256: digest([]byte("0123456789"))}
	if _, err := store.Ensure(context.Background(), entry); err == nil {
		t.Fatal("interrupted read unexpectedly succeeded")
	}
	if store.used.Load() != 11 {
		t.Fatalf("uncertain transfer must retain its bounded reservation: %d", store.used.Load())
	}
	if _, err := store.Ensure(context.Background(), entry); !errors.Is(err, ErrBudget) {
		t.Fatalf("interrupted read was repeated without remaining budget: %v", err)
	}
}
