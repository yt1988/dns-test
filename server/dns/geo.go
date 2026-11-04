package main

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/oschwald/maxminddb-golang"
)

// Geo looks up a resolver address's network (ASN, organisation) and country in the DB-IP lite databases (CC BY 4.0),
// kept in the state directory and refreshed monthly. Lookups are local: no third party sees the addresses.
type Geo struct {
	dir     string
	mu      sync.RWMutex
	country *maxminddb.Reader
	asn     *maxminddb.Reader
}

var geoDBs = []string{"country", "asn"}

func NewGeo(dir string) *Geo {
	g := &Geo{dir: dir}
	for _, n := range geoDBs {
		g.open(n)
	}
	return g
}

func (g *Geo) path(n string) string { return filepath.Join(g.dir, "dbip-"+n+"-lite.mmdb") }

func (g *Geo) open(n string) error {
	r, err := maxminddb.Open(g.path(n))
	if err != nil {
		return err
	}
	g.mu.Lock()
	old := g.country
	if n == "country" {
		g.country = r
	} else {
		old, g.asn = g.asn, r
	}
	g.mu.Unlock()
	if old != nil {
		old.Close()
	}
	return nil
}

func (g *Geo) Lookup(s string) (asn uint, org, cc string) {
	ip := net.ParseIP(s)
	if ip == nil {
		return
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.asn != nil {
		var rec struct {
			ASN uint   `maxminddb:"autonomous_system_number"`
			Org string `maxminddb:"autonomous_system_organization"`
		}
		if g.asn.Lookup(ip, &rec) == nil {
			asn, org = rec.ASN, rec.Org
		}
	}
	if g.country != nil {
		var rec struct {
			Country struct {
				ISO string `maxminddb:"iso_code"`
			} `maxminddb:"country"`
		}
		if g.country.Lookup(ip, &rec) == nil {
			cc = rec.Country.ISO
		}
	}
	return
}

// Run keeps the databases fresh: fetched when missing or older than 30 days, checked daily.
func (g *Geo) Run(ctx context.Context) {
	for {
		for _, n := range geoDBs {
			if fi, err := os.Stat(g.path(n)); err == nil && time.Since(fi.ModTime()) < 30*24*time.Hour {
				continue
			}
			if err := g.fetch(ctx, n); err != nil {
				log.Printf("geo %s: %v", n, err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(24 * time.Hour):
		}
	}
}

// fetch downloads this month's database (or last month's, early in a month before it is out).
func (g *Geo) fetch(ctx context.Context, n string) error {
	var err error
	for _, t := range []time.Time{time.Now().UTC(), time.Now().UTC().AddDate(0, 0, -20)} {
		url := fmt.Sprintf("https://download.db-ip.com/free/dbip-%s-lite-%s.mmdb.gz", n, t.Format("2006-01"))
		if err = g.download(ctx, url, n); err == nil {
			return nil
		}
	}
	return err
}

func (g *Geo) download(ctx context.Context, url, n string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "1ms-dns (https://1ms.dog)")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("%s: %s", url, res.Status)
	}
	zr, err := gzip.NewReader(res.Body)
	if err != nil {
		return err
	}
	tmp := g.path(n) + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(zr, 200<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		var r *maxminddb.Reader
		if r, err = maxminddb.Open(tmp); err == nil {
			r.Close()
			err = os.Rename(tmp, g.path(n))
		}
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return g.open(n)
}
