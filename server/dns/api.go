package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// API is the HTTPS results endpoint on :2053 (CORS open, nothing cached, nothing logged).
//
//	GET https://api.l.1ms.dog:2053/t/<token>[?wait=ms]    the token's hits
//	GET https://<token>[-<tag>].l.1ms.dog:2053/            the same, one request: the browser's own lookup of that name
//	                                                       went through its system resolver on the way here
//
// When nothing has arrived yet it waits up to wait ms (default 1500, max 5000) for the first query, then until settle
// after the first query, so the A and AAAA queries a resolver sends together are both in.
type API struct {
	store  *Store
	geo    *Geo
	apex   string // "l.1ms.dog"
	settle time.Duration
}

type Result struct {
	Token string `json:"token"`
	Hits  []Hit  `json:"hits"`
	Geo   string `json:"geo"`
}

const geoCredit = "IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0"

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Timing-Allow-Origin", "*")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	switch r.Method {
	case http.MethodOptions:
		h.Set("Access-Control-Allow-Methods", "GET")
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodGet, http.MethodHead:
	default:
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/health" {
		w.Write([]byte("ok\n"))
		return
	}
	label := ""
	if p, ok := strings.CutPrefix(r.URL.Path, "/t/"); ok {
		label = p
	} else if r.URL.Path == "/" {
		host := strings.ToLower(r.Host)
		if i := strings.LastIndexByte(host, ':'); i > strings.LastIndexByte(host, ']') {
			host = host[:i]
		}
		label, _ = strings.CutSuffix(host, "."+a.apex)
	}
	token, _, ok := ParseLabel(label)
	if !ok {
		http.Error(w, "usage: GET /t/<token>, token = 8-32 of [a-z0-9]; see https://github.com/yt1988/dns-test/tree/main/server", http.StatusBadRequest)
		return
	}
	wait := 1500 * time.Millisecond
	if v := r.URL.Query().Get("wait"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			wait = time.Duration(min(n, 5000)) * time.Millisecond
		}
	}
	deadline := time.Now().Add(wait)
	var hits []Hit
	for {
		hs, age := a.store.Get(token, time.Now())
		var sleep time.Duration
		if len(hs) > 0 {
			if age >= a.settle {
				hits = hs
				break
			}
			sleep = a.settle - age
		} else {
			if !time.Now().Before(deadline) {
				break
			}
			sleep = min(50*time.Millisecond, time.Until(deadline))
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(sleep):
		}
	}
	if hits == nil {
		hits = []Hit{}
	}
	for i := range hits {
		hits[i].ASN, hits[i].Org, hits[i].CC = a.geo.Lookup(hits[i].IP)
	}
	h.Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Result{Token: token, Hits: hits, Geo: geoCredit})
}
