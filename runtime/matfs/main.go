// designx-matfs: a read-only, verify-on-open view of an authorized library (docs/architecture/19 §16).
//
// Runs as root inside the Attempt sandbox. The namespace comes only from the trusted manifest; each file's
// bytes are fetched from the space's content pool on first open and served only after they match the
// manifest's size and SHA-256. Temporary, prefix-scoped, read-only credentials arrive in this process's
// environment and never reach the agent.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type poolSource struct {
	client *minio.Client
	bucket string
	prefix string
}

func (p *poolSource) Get(ctx context.Context, sha string) (io.ReadCloser, error) {
	return p.client.GetObject(ctx, p.bucket, p.prefix+sha, minio.GetObjectOptions{})
}

func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func main() {
	manifestPath := flag.String("manifest", "", "gzip JSON manifest written by the control plane")
	mountpoint := flag.String("mount", "", "empty directory to mount on")
	cacheDir := flag.String("cache", "", "root-private directory for verified copies")
	endpoint := flag.String("endpoint", "", "object storage host (https)")
	bucket := flag.String("bucket", "", "bucket")
	prefix := flag.String("prefix", "", "content pool prefix, ending with /")
	budget := flag.Int64("budget-bytes", 2<<30, "maximum bytes fetched in this attempt")
	ready := flag.String("ready", "", "file to create once mounted")
	flag.Parse()
	if *manifestPath == "" || *mountpoint == "" || *cacheDir == "" || *endpoint == "" || *bucket == "" || !strings.HasSuffix(*prefix, "/") {
		log.Fatal("manifest, mount, cache, endpoint, bucket and a prefix ending in / are required")
	}
	manifest, err := LoadManifest(*manifestPath)
	if err != nil {
		log.Fatalf("manifest rejected: %v", err)
	}
	client, err := minio.New(strings.TrimPrefix(*endpoint, "https://"), &minio.Options{
		Creds: credentials.NewStaticV4(
			required("DESIGNX_MATFS_ACCESS_KEY_ID"), required("DESIGNX_MATFS_SECRET_ACCESS_KEY"), os.Getenv("DESIGNX_MATFS_SESSION_TOKEN"),
		),
		Secure: true,
		Region: "auto",
	})
	if err != nil {
		log.Fatalf("storage client: %v", err)
	}
	// Credentials are not needed in the environment after the client holds them.
	for _, name := range []string{"DESIGNX_MATFS_ACCESS_KEY_ID", "DESIGNX_MATFS_SECRET_ACCESS_KEY", "DESIGNX_MATFS_SESSION_TOKEN"} {
		os.Unsetenv(name)
	}
	store, err := NewStore(*cacheDir, &poolSource{client: client, bucket: *bucket, prefix: *prefix}, *budget, 16)
	if err != nil {
		log.Fatalf("cache: %v", err)
	}
	long := 24 * time.Hour
	root := &rootNode{manifest: manifest, store: store, mtime: time.Now()}
	server, err := fs.Mount(*mountpoint, root, &fs.Options{
		AttrTimeout:  &long,
		EntryTimeout: &long,
		MountOptions: fuse.MountOptions{
			AllowOther:   true,
			DirectMount:  true,
			FsName:       "designx-matfs",
			Name:         "designx-matfs",
			Options:      []string{"ro", "default_permissions"},
			MaxReadAhead: 1 << 20,
		},
	})
	if err != nil {
		log.Fatalf("mount: %v", err)
	}
	if *ready != "" {
		if err := os.WriteFile(*ready, []byte(fmt.Sprintf("%d\n", len(manifest.Entries))), 0o600); err != nil {
			server.Unmount()
			log.Fatalf("ready file: %v", err)
		}
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() { <-signals; server.Unmount() }()
	server.Wait()
}
