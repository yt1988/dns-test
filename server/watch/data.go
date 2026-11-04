package main

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// SlotMinutes: one run every 10 minutes, so a day has 144 slots.
const SlotMinutes = 10
const Slots = 24 * 60 / SlotMinutes

// Day is one UTC day of results, days/YYYY-MM-DD.json: for each resolver and protocol, one value per slot:
// milliseconds, -1 for a failed probe, null for no run in that slot.
type Day struct {
	Date        string                       `json:"date"`
	SlotMinutes int                          `json:"slot_minutes"`
	R           map[string]map[string][]*int `json:"r"`
}

func NewDay(date string) *Day {
	return &Day{Date: date, SlotMinutes: SlotMinutes, R: map[string]map[string][]*int{}}
}

func (d *Day) Set(id, p string, slot int, r Result) {
	if d.R[id] == nil {
		d.R[id] = map[string][]*int{}
	}
	v := d.R[id][p]
	if len(v) != Slots {
		v = append(v, make([]*int, Slots-len(v))...)[:Slots]
	}
	x := -1
	if r.Ms != nil {
		x = *r.Ms
	}
	v[slot] = &x
	d.R[id][p] = v
}

func SlotOf(t time.Time) int { return (t.Hour()*60 + t.Minute()) / SlotMinutes }

// Stat is what the page shows for one resolver and protocol, seen from Tokyo.
type Stat struct {
	Last  *int    `json:"last"`          // ms of the latest probe, null if it failed
	Err   string  `json:"err,omitempty"` // why the latest probe failed
	Up24h float64 `json:"up24h"`         // share of probes that answered
	Up7d  float64 `json:"up7d"`
	Up30d float64 `json:"up30d"`
	Med24 *int    `json:"med24h"` // median ms of the answers
	Med7d *int    `json:"med7d"`
	N24h  int     `json:"n24h"` // probes counted in up24h
}

type Summary struct {
	T       string                     `json:"t"`
	Vantage string                     `json:"vantage"`
	R       map[string]map[string]Stat `json:"r"`
}

func round4(f float64) float64 { return math.Round(f*1e4) / 1e4 }

func median(v []int) *int {
	if len(v) == 0 {
		return nil
	}
	sort.Ints(v)
	m := v[len(v)/2]
	if len(v)%2 == 0 {
		m = (v[len(v)/2-1] + v[len(v)/2]) / 2
	}
	return &m
}

// Summarize builds the summary from the latest run and up to 30 days of history (oldest first or any order).
func Summarize(now time.Time, vantage string, latest map[string]map[string]Result, days []*Day) Summary {
	type acc struct{ ok, n int; ms []int }
	windows := []time.Duration{24 * time.Hour, 7 * 24 * time.Hour, 30 * 24 * time.Hour}
	accs := map[string]map[string]*[3]acc{}
	for _, d := range days {
		date, err := time.Parse("2006-01-02", d.Date)
		if err != nil {
			continue
		}
		for id, ps := range d.R {
			for p, v := range ps {
				for slot, x := range v {
					if x == nil {
						continue
					}
					age := now.Sub(date.Add(time.Duration(slot*SlotMinutes) * time.Minute))
					if age < 0 {
						continue
					}
					if accs[id] == nil {
						accs[id] = map[string]*[3]acc{}
					}
					if accs[id][p] == nil {
						accs[id][p] = &[3]acc{}
					}
					for w, win := range windows {
						if age >= win {
							continue
						}
						a := &accs[id][p][w]
						a.n++
						if *x >= 0 {
							a.ok++
							if w < 2 {
								a.ms = append(a.ms, *x)
							}
						}
					}
				}
			}
		}
	}
	s := Summary{T: now.UTC().Format(time.RFC3339), Vantage: vantage, R: map[string]map[string]Stat{}}
	for id, ps := range latest {
		s.R[id] = map[string]Stat{}
		for p, r := range ps {
			st := Stat{Last: r.Ms, Err: r.Err}
			if a := accs[id][p]; a != nil {
				up := func(x acc) float64 {
					if x.n == 0 {
						return 0
					}
					return round4(float64(x.ok) / float64(x.n))
				}
				st.Up24h, st.Up7d, st.Up30d = up(a[0]), up(a[1]), up(a[2])
				st.Med24, st.Med7d, st.N24h = median(a[0].ms), median(a[1].ms), a[0].n
			}
			s.R[id][p] = st
		}
	}
	return s
}

// writeJSON writes atomically, readable by the web server (0644).
func writeJSON(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func LoadDay(dir, date string) *Day {
	d := NewDay(date)
	if b, err := os.ReadFile(filepath.Join(dir, "days", date+".json")); err == nil {
		json.Unmarshal(b, d)
		if d.R == nil {
			d.R = map[string]map[string][]*int{}
		}
	}
	return d
}

// Prune removes day files older than keep days.
func Prune(dir string, now time.Time, keep int) {
	cut := now.AddDate(0, 0, -keep).Format("2006-01-02")
	ents, _ := os.ReadDir(filepath.Join(dir, "days"))
	for _, e := range ents {
		if n, ok := strings.CutSuffix(e.Name(), ".json"); ok && len(n) == 10 && n < cut {
			os.Remove(filepath.Join(dir, "days", e.Name()))
		}
	}
}
