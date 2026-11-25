package main

// Token check for the results API (tool-contract.md, "端点鉴权", 2026-11-25).
//
// The shell mints a short-lived token into every tool page: v1.<exp>.<nonce>.<hmac>, HMAC-SHA256 over
// "v1|exp|nonce|scope", where scope is a comma-separated list of capabilities in the order the contract lists them
// (probe,reach,ping,rtc,ipv6,seg,dns,data). A token does not carry its own scope, and the signer may mint it for the
// page's whole set, so this service tries every list that contains "dns" (and the service token's "*") and accepts the
// token if one matches. The HMAC may be hex or base64 (URL or standard, padded or not).
//
// Empty MS_AUTH_SECRET means no check: the self-hosting default and the rollout switch. Requests the page makes to
// <token>[-<tag>].l.1ms.dog are the measurement itself (one browser fetch that also performs the DNS lookup), so they
// are never checked; only api.<apex> and the /t/ and /health routes are. The loopback self-check is exempt too.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// the capabilities in the contract's order; a page token may name any subset of them
var capabilities = []string{"probe", "reach", "ping", "rtc", "ipv6", "seg", "dns", "data"}

type Auth struct {
	secret  string
	apiHost string
	scopes  []string
	now     func() time.Time
}

func NewAuth(secret, apiHost string) *Auth {
	a := &Auth{secret: secret, apiHost: strings.ToLower(apiHost), now: time.Now}
	if secret != "" {
		a.scopes = scopeCandidates()
	}
	return a
}

// scopeCandidates is every comma-separated list of capabilities that contains "dns", plus the service token's "*".
func scopeCandidates() []string {
	var out []string
	for mask := 1; mask < 1<<len(capabilities); mask++ {
		var parts []string
		hasDNS := false
		for i, c := range capabilities {
			if mask&(1<<i) == 0 {
				continue
			}
			parts = append(parts, c)
			if c == "dns" {
				hasDNS = true
			}
		}
		if hasDNS {
			out = append(out, strings.Join(parts, ","))
		}
	}
	return append(out, "*")
}

// authSecret reads the key from MS_AUTH_SECRET or, under systemd, from LoadCredential=ms-auth-secret.
func authSecret() string {
	if s := strings.TrimSpace(os.Getenv("MS_AUTH_SECRET")); s != "" {
		return s
	}
	if dir := os.Getenv("CREDENTIALS_DIRECTORY"); dir != "" {
		if b, err := os.ReadFile(filepath.Join(dir, "ms-auth-secret")); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}

func (a *Auth) Wrap(next http.Handler) http.Handler {
	if a.secret == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// a CORS preflight cannot carry Authorization; the handler answers it with the headers the real request needs
		if r.Method == http.MethodOptions || !a.guarded(r) {
			next.ServeHTTP(w, r)
			return
		}
		tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || strings.TrimSpace(tok) == "" {
			http.Error(w, "no_token", http.StatusUnauthorized)
			return
		}
		if !a.valid(strings.TrimSpace(tok)) {
			http.Error(w, "bad_token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// guarded: the API host, and the /t/ and /health routes under any other name, which are the same API. The random-name
// lookups (path "/" on <token>.l.1ms.dog) and the loopback self-check are not.
func (a *Auth) guarded(r *http.Request) bool {
	h := hostOnly(r.Host)
	if h == "127.0.0.1" || h == "localhost" || h == "[::1]" || h == "::1" {
		return false
	}
	return h == a.apiHost || strings.HasPrefix(r.URL.Path, "/t/") || r.URL.Path == "/health"
}

func hostOnly(host string) string {
	h := strings.ToLower(host)
	if i := strings.LastIndexByte(h, ':'); i > strings.LastIndexByte(h, ']') {
		h = h[:i]
	}
	return h
}

func (a *Auth) valid(tok string) bool {
	if len(tok) > 512 {
		return false
	}
	p := strings.Split(tok, ".")
	if len(p) != 4 || p[0] != "v1" || p[2] == "" {
		return false
	}
	exp, err := strconv.ParseInt(p[1], 10, 64)
	if err != nil || exp <= a.now().Unix() {
		return false
	}
	sig, ok := decodeSig(p[3])
	if !ok {
		return false
	}
	msg := "v1|" + p[1] + "|" + p[2] + "|"
	for _, scope := range a.scopes {
		mac := hmac.New(sha256.New, []byte(a.secret))
		mac.Write([]byte(msg + scope))
		if subtle.ConstantTimeCompare(mac.Sum(nil), sig) == 1 {
			return true
		}
	}
	return false
}

func decodeSig(s string) ([]byte, bool) {
	if b, err := hex.DecodeString(s); err == nil && len(b) == sha256.Size {
		return b, true
	}
	for _, enc := range []*base64.Encoding{base64.RawURLEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.StdEncoding} {
		if b, err := enc.DecodeString(s); err == nil && len(b) == sha256.Size {
			return b, true
		}
	}
	return nil, false
}
