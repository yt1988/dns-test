package main

import (
	"net"
	"sync"
	"time"
)

// RRL is response rate limiting for UDP, per source prefix (/24 for IPv4, /56 for IPv6), so the server can't be used to
// flood a spoofed victim. Over the limit, every second response is a truncated empty one (the real resolver retries over
// TCP, which can't be spoofed) and the others are dropped.
type RRL struct {
	mu    sync.Mutex
	rate  float64 // responses per second
	burst float64
	b     map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
	over   int
}

func NewRRL(rate, burst float64) *RRL { return &RRL{rate: rate, burst: burst, b: map[string]*bucket{}} }

func prefixKey(ip net.IP) string {
	if v4 := ip.To4(); v4 != nil {
		return string(v4.Mask(net.CIDRMask(24, 32)))
	}
	return string(ip.Mask(net.CIDRMask(56, 128)))
}

// Allow says what to do with a UDP response to ip: "ok" send it, "slip" send it truncated, "drop" send nothing.
func (r *RRL) Allow(ip net.IP, now time.Time) string {
	k := prefixKey(ip)
	r.mu.Lock()
	defer r.mu.Unlock()
	b := r.b[k]
	if b == nil {
		if len(r.b) > 100000 {
			r.b = map[string]*bucket{}
		}
		b = &bucket{tokens: r.burst, last: now}
		r.b[k] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * r.rate
	if b.tokens > r.burst {
		b.tokens = r.burst
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		b.over = 0
		return "ok"
	}
	b.over++
	if b.over%2 == 1 {
		return "slip"
	}
	return "drop"
}

func (r *RRL) Sweep(now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for k, b := range r.b {
		if now.Sub(b.last) > time.Minute {
			delete(r.b, k)
		}
	}
}
