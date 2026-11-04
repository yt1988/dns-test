package main

import (
	"regexp"
	"strings"
	"sync"
	"time"
)

// A Hit is one query that reached this server for a token's name: which resolver sent it, how, and with what ECS.
// Hits live in memory only, for keep (2 minutes) after the token's first query; nothing is written to disk or logs.
type Hit struct {
	Tag    string `json:"tag"`           // the part after "-" in "<token>-<tag>", "" for none
	Zone   string `json:"zone"`          // "l" (any family), "v4" (IPv4-only servers), "v6" (IPv6-only servers)
	IP     string `json:"ip"`            // the resolver's egress address that asked us
	Family int    `json:"family"`        // 4 or 6
	Proto  string `json:"proto"`         // "udp" or "tcp"
	QType  string `json:"qtype"`         // A, AAAA, TXT, NS, ...
	ECS    string `json:"ecs,omitempty"` // EDNS Client Subnet as sent, e.g. "203.0.113.0/24"; absent when the resolver sent none
	N      int    `json:"n"`             // how many identical queries
	Ms     int64  `json:"ms"`            // milliseconds after the token's first query
	ASN    uint   `json:"asn,omitempty"` // filled when read (DB-IP lite)
	Org    string `json:"org,omitempty"`
	CC     string `json:"cc,omitempty"` // where the address is (geolocation, ISO 3166 alpha-2)
}

type entry struct {
	first time.Time
	hits  []Hit
}

type Store struct {
	mu        sync.Mutex
	m         map[string]*entry
	keep      time.Duration
	maxTokens int
	maxHits   int
}

func NewStore(keep time.Duration) *Store {
	return &Store{m: map[string]*entry{}, keep: keep, maxTokens: 50000, maxHits: 32}
}

// tokenRe: a token is 8 to 32 of [a-z0-9]; an optional tag after one "-" says which query this was (e.g. which DoH
// resolver the page sent it through). One label, so QNAME minimisation can't split it.
var tokenRe = regexp.MustCompile(`^([a-z0-9]{8,32})(?:-([a-z0-9]{1,16}))?$`)

func ParseLabel(label string) (token, tag string, ok bool) {
	m := tokenRe.FindStringSubmatch(strings.ToLower(label))
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

func (s *Store) Add(token string, h Hit, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.m[token]
	if e == nil || now.Sub(e.first) > s.keep {
		if e == nil && len(s.m) >= s.maxTokens {
			return
		}
		e = &entry{first: now}
		s.m[token] = e
	}
	h.Ms = now.Sub(e.first).Milliseconds()
	for i := range e.hits {
		o := &e.hits[i]
		if o.Tag == h.Tag && o.Zone == h.Zone && o.IP == h.IP && o.Proto == h.Proto && o.QType == h.QType && o.ECS == h.ECS {
			o.N++
			return
		}
	}
	if len(e.hits) < s.maxHits {
		h.N = 1
		e.hits = append(e.hits, h)
	}
}

// Get returns a copy of the token's hits (nil if none or expired) and how long ago its first query came.
func (s *Store) Get(token string, now time.Time) ([]Hit, time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.m[token]
	if e == nil || now.Sub(e.first) > s.keep {
		return nil, 0
	}
	return append([]Hit(nil), e.hits...), now.Sub(e.first)
}

func (s *Store) Sweep(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, e := range s.m {
		if now.Sub(e.first) > s.keep {
			delete(s.m, k)
		}
	}
}

func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}
