package main

// Token check for the results API (tool-contract.md, "端点鉴权", 2026-11-25).
//
// The shell mints a short-lived token into every tool page: v1.<exp>.<nonce>.<scope>.<hmac>, where scope is the
// comma-separated list of capabilities the token was signed for (probe,reach,ping,rtc,ipv6,seg,dns,data) and hmac is
// HMAC-SHA256 over "v1|exp|nonce|scope", base64url without padding. This service recomputes the HMAC with the scope
// exactly as the token carries it and then asks whether "dns" is one of them; the service token's "*" is accepted too.
//
// Empty MS_AUTH_SECRET means no check: the self-hosting default and the rollout switch. Requests the page makes to
// <token>[-<tag>].<zone> are the measurement itself (one browser fetch that also performs the DNS lookup), so they
// are never checked; only api.<apex> and the /t/ and /health routes are. The loopback self-check is exempt too.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Auth struct {
	secret  string
	apiHost string
	now     func() time.Time
}

func NewAuth(secret, apiHost string) *Auth {
	return &Auth{secret: secret, apiHost: strings.ToLower(apiHost), now: time.Now}
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
			deny(w, "no_token")
			return
		}
		if !a.valid(strings.TrimSpace(tok)) {
			deny(w, "bad_token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// deny answers 401 with the same CORS headers as the API: without them a cross-origin fetch sees a network error, not
// a 401, and the page could not tell that its token needs renewing.
func deny(w http.ResponseWriter, code string) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Timing-Allow-Origin", "*")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	http.Error(w, code, http.StatusUnauthorized)
}

// guarded: the API host, and the /t/ and /health routes under any other name, which are the same API. The random-name
// lookups (path "/" on <token>.<zone>) and the loopback self-check are not.
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
	if len(p) != 5 || p[0] != "v1" || p[2] == "" || p[3] == "" {
		return false
	}
	exp, err := strconv.ParseInt(p[1], 10, 64)
	if err != nil || exp <= a.now().Unix() {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(p[4])
	if err != nil || len(sig) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, []byte(a.secret))
	mac.Write([]byte("v1|" + p[1] + "|" + p[2] + "|" + p[3]))
	if subtle.ConstantTimeCompare(mac.Sum(nil), sig) != 1 {
		return false
	}
	return hasScope(p[3], "dns") || strings.TrimSpace(p[3]) == "*"
}

func hasScope(scope, want string) bool {
	for _, s := range strings.Split(scope, ",") {
		if strings.TrimSpace(s) == want {
			return true
		}
	}
	return false
}
