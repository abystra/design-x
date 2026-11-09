package main

import (
	"context"
	"log"
	"strings"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

// The tree is built once from the manifest. Listing and stat never touch the network, so mounting is
// independent of how many files the library has; only opening a file fetches (and verifies) its content.
type rootNode struct {
	fs.Inode
	manifest *Manifest
	store    *Store
	mtime    time.Time
}

type dirNode struct {
	fs.Inode
	mtime time.Time
}

type fileNode struct {
	fs.Inode
	entry Entry
	store *Store
	mtime time.Time
}

var (
	_ fs.NodeOnAdder   = (*rootNode)(nil)
	_ fs.NodeGetattrer = (*rootNode)(nil)
	_ fs.NodeGetattrer = (*dirNode)(nil)
	_ fs.NodeGetattrer = (*fileNode)(nil)
	_ fs.NodeOpener    = (*fileNode)(nil)
)

func (r *rootNode) OnAdd(ctx context.Context) {
	dirs := map[string]*fs.Inode{"": &r.Inode}
	var dirOf func(path string) *fs.Inode
	dirOf = func(path string) *fs.Inode {
		if node, ok := dirs[path]; ok {
			return node
		}
		parent, name := "", path
		if i := strings.LastIndex(path, "/"); i >= 0 {
			parent, name = path[:i], path[i+1:]
		}
		p := dirOf(parent)
		child := p.NewPersistentInode(ctx, &dirNode{mtime: r.mtime}, fs.StableAttr{Mode: syscall.S_IFDIR})
		p.AddChild(name, child, false)
		dirs[path] = child
		return child
	}
	for _, e := range r.manifest.Entries {
		parent, name := "", e.Path
		if i := strings.LastIndex(e.Path, "/"); i >= 0 {
			parent, name = e.Path[:i], e.Path[i+1:]
		}
		p := dirOf(parent)
		child := p.NewPersistentInode(ctx, &fileNode{entry: e, store: r.store, mtime: r.mtime}, fs.StableAttr{Mode: syscall.S_IFREG})
		p.AddChild(name, child, false)
	}
}

func dirAttr(out *fuse.AttrOut, mtime time.Time) {
	out.Mode = syscall.S_IFDIR | 0o555
	out.SetTimes(nil, &mtime, &mtime)
}

func (r *rootNode) Getattr(_ context.Context, _ fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	dirAttr(out, r.mtime)
	return 0
}

func (d *dirNode) Getattr(_ context.Context, _ fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	dirAttr(out, d.mtime)
	return 0
}

func (f *fileNode) Getattr(_ context.Context, _ fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = syscall.S_IFREG | 0o444
	out.Size = uint64(f.entry.Size)
	out.SetTimes(nil, &f.mtime, &f.mtime)
	return 0
}

// Open serves only a verified local copy. Any mismatch, fetch failure or exhausted budget is EIO / EFBIG.
func (f *fileNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&(syscall.O_WRONLY|syscall.O_RDWR|syscall.O_TRUNC|syscall.O_APPEND) != 0 {
		return nil, 0, syscall.EROFS
	}
	path, err := f.store.Ensure(ctx, f.entry)
	if err == ErrBudget {
		return nil, 0, syscall.EFBIG
	}
	if err != nil {
		log.Printf("open %q failed: %v", f.entry.Path, err)
		return nil, 0, syscall.EIO
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY, 0)
	if err != nil {
		return nil, 0, syscall.EIO
	}
	return fs.NewLoopbackFile(fd), fuse.FOPEN_KEEP_CACHE, 0
}
