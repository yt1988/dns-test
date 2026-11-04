// 1ms-dns-watch: one run of the Tokyo watch over the resolvers dns.1ms.dog tests (started every 10 minutes, at minute
// 2, by 1ms-dns-watch.timer). Each resolver is probed over plain DNS (UDP, IPv4 and IPv6), DoT, DoH and DoQ where it
// offers them, with a query for example.com.
//
// Output, published read-only at https://data.1ms.dog:2083/dns/ for the dns Worker to fetch:
//
//	latest.json        this run: {t, vantage, r: {id: {proto: {ms} | {err}}}}
//	summary.json       for the page: {t, vantage, r: {id: {proto: {last, err, up24h, up7d, up30d, med24h, med7d, n24h}}}}
//	days/<date>.json   history, one value per 10-minute slot (see Day); kept 90 days
//
// Nothing about visitors is involved. Directory and service name as registered in 1ms-shell docs/processes.md
// ("专用服务器"): /srv/1ms-data/dns/, 1ms-dns-watch, user 1ms-dns.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"log"
	"path/filepath"
	"sync"
	"time"
)

//go:embed targets.json
var targetsJSON []byte

const vantage = "Tokyo (AWS Lightsail ap-northeast-1)"

func RunAll(ctx context.Context, targets []Target, parallel int) map[string]map[string]Result {
	out := map[string]map[string]Result{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, parallel)
	for _, t := range targets {
		out[t.ID] = map[string]Result{}
		for _, p := range Protos {
			a := t.addr(p)
			if a == "" {
				continue
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				sem <- struct{}{}
				r := Probe(ctx, p, a)
				<-sem
				mu.Lock()
				out[t.ID][p] = r
				mu.Unlock()
			}()
		}
	}
	wg.Wait()
	return out
}

func main() {
	out := flag.String("out", "/srv/1ms-data/dns", "output directory")
	keep := flag.Int("keep", 90, "days of history to keep")
	flag.Parse()
	log.SetFlags(0)
	var targets []Target
	if err := json.Unmarshal(targetsJSON, &targets); err != nil {
		log.Fatal(err)
	}
	start := time.Now().UTC()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	res := RunAll(ctx, targets, 16)

	slot, date := SlotOf(start), start.Format("2006-01-02")
	day := LoadDay(*out, date)
	for id, ps := range res {
		for p, r := range ps {
			day.Set(id, p, slot, r)
		}
	}
	if err := writeJSON(filepath.Join(*out, "days", date+".json"), day); err != nil {
		log.Fatal(err)
	}
	if err := writeJSON(filepath.Join(*out, "latest.json"), map[string]any{"t": start.Format(time.RFC3339), "vantage": vantage, "r": res}); err != nil {
		log.Fatal(err)
	}
	var days []*Day
	for i := 30; i >= 0; i-- {
		d := start.AddDate(0, 0, -i).Format("2006-01-02")
		if d == date {
			days = append(days, day)
		} else {
			days = append(days, LoadDay(*out, d))
		}
	}
	if err := writeJSON(filepath.Join(*out, "summary.json"), Summarize(time.Now().UTC(), vantage, res, days)); err != nil {
		log.Fatal(err)
	}
	Prune(*out, start, *keep)
	fails := 0
	for _, ps := range res {
		for _, r := range ps {
			if r.Err != "" {
				fails++
			}
		}
	}
	if fails > 0 {
		log.Printf("%d probes failed (see latest.json)", fails)
	}
}
