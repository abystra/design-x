package main

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"unicode"
)

// Limits for one Attempt's view. The view's size never depends on what is read: entries are metadata only.
const (
	MaxEntries     = 200000
	MaxFileBytes   = 100 << 20
	MaxPathBytes   = 1024
	MaxManifestRaw = 256 << 20
)

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Entry is one authorized file: its visible path and the exact content it must have.
type Entry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest is the authorized namespace. Nothing outside it can be listed, opened or fetched.
type Manifest struct {
	Version int     `json:"version"`
	Entries []Entry `json:"entries"`
}

// LoadManifest reads a gzip JSON manifest written by the trusted control plane and validates every entry.
func LoadManifest(path string) (*Manifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	zipped, err := gzip.NewReader(file)
	if err != nil {
		return nil, fmt.Errorf("manifest is not gzip: %w", err)
	}
	raw, err := io.ReadAll(io.LimitReader(zipped, MaxManifestRaw+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > MaxManifestRaw {
		return nil, errors.New("manifest exceeds its size limit")
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("manifest is not valid JSON: %w", err)
	}
	return &manifest, manifest.Validate()
}

// Validate rejects anything that could escape the view, collide, or exceed the limits. Fail closed.
func (m *Manifest) Validate() error {
	if m.Version != 1 {
		return errors.New("unsupported manifest version")
	}
	if len(m.Entries) > MaxEntries {
		return errors.New("manifest has too many entries")
	}
	files := make(map[string]bool, len(m.Entries))
	dirs := map[string]bool{}
	for _, e := range m.Entries {
		if err := validPath(e.Path); err != nil {
			return fmt.Errorf("entry %q: %w", e.Path, err)
		}
		if e.Size < 0 || e.Size > MaxFileBytes {
			return fmt.Errorf("entry %q: invalid size", e.Path)
		}
		if !sha256Hex.MatchString(e.SHA256) {
			return fmt.Errorf("entry %q: invalid sha256", e.Path)
		}
		if files[e.Path] {
			return fmt.Errorf("entry %q: duplicate path", e.Path)
		}
		files[e.Path] = true
		parts := strings.Split(e.Path, "/")
		for i := 1; i < len(parts); i++ {
			dirs[strings.Join(parts[:i], "/")] = true
		}
	}
	for dir := range dirs {
		if files[dir] {
			return fmt.Errorf("path %q is both a file and a directory", dir)
		}
	}
	return nil
}

func validPath(path string) error {
	if path == "" || len(path) > MaxPathBytes {
		return errors.New("empty or too long")
	}
	if strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") || strings.Contains(path, "\\") {
		return errors.New("not a relative POSIX path")
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return errors.New("contains an empty, . or .. component")
		}
	}
	for _, r := range path {
		if r == unicode.ReplacementChar || unicode.IsControl(r) {
			return errors.New("contains a control or invalid character")
		}
	}
	return nil
}
