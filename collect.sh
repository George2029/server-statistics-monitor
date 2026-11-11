#!/usr/bin/env bash
# collect.sh — print one JSON snapshot of this Linux server's resource usage.
#
# Runs ON THE SERVER as a normal user (no root needed).
# Uses only /proc, df, ps and top, which every Debian/Ubuntu has.
# Takes ~1 second: CPU % and network speed need two samples to compare.
#
# Run it from the Mac without copying it to the server:
#   ssh -p 2222 user@example.com 'bash -s' < collect.sh

set -uo pipefail
export LC_ALL=C          # predictable number formats and sorting

INTERVAL=1               # seconds between the two samples
TOP_N=3                  # how many processes to list

# ---------------------------------------------------------------- helpers

# The interface carrying the default route, i.e. the one facing the internet.
# In /proc/net/route the default route has Destination 00000000.
net_iface() {
  awk 'NR > 1 && $2 == "00000000" { print $1; exit }' /proc/net/route
}

# First line of /proc/stat: cumulative CPU time since boot, in ticks.
# Prints: user nice system idle iowait irq softirq steal
cpu_sample() {
  awk '$1 == "cpu" { print $2, $3, $4, $5, $6, $7, $8, $9; exit }' /proc/stat
}

# Cumulative bytes received / sent since boot on $IFACE.
# Prints: rx_bytes tx_bytes   (nothing if no internet-facing interface was found)
net_sample() {
  [ -n "$IFACE" ] || return 0
  awk -v want="$IFACE" '
    NR > 2 {
      sub(/:/, " ")                       # "eth0:123 ..." -> "eth0 123 ..."
      if ($1 == want) { print $2, $10; exit }
    }' /proc/net/dev
}

# Seconds since boot, with 1/100 s precision — used to measure the real interval.
uptime_now() { cut -d' ' -f1 /proc/uptime; }

# ---------------------------------------------------------------- sample 1

IFACE=$(net_iface)
CORES=$(nproc)

UP1=$(uptime_now); CPU1=$(cpu_sample); NET1=$(net_sample)

# ---------------------------------------------------------------- wait + per-process CPU
# `top` prints two frames INTERVAL apart. We use the second: its per-process
# CPU covers exactly the same ~1 s window as the CPU/network samples, so the
# numbers line up. (The first frame covers only a split second at startup.)
# This also provides the INTERVAL wait. We use top, not ps, because ps shows
# each process's lifetime-average CPU, not current usage.
# HOME/XDG overrides make top ignore any personal ~/.toprc layout.

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
if ! HOME=/nonexistent XDG_CONFIG_HOME=/nonexistent \
     top -b -n 2 -d "$INTERVAL" -w 512 > "$TMP" 2>/dev/null; then
  : > "$TMP"
  sleep "$INTERVAL"
fi

# ---------------------------------------------------------------- sample 2

UP2=$(uptime_now); CPU2=$(cpu_sample); NET2=$(net_sample)

# "pid cpu%" from top's second frame (finds the %CPU column by its header)
TOPCPU=$(awk '
  /^top - /       { frame++; hdr = 0; next }
  frame == 2 && $1 == "PID" {
    for (i = 1; i <= NF; i++) if ($i == "%CPU") col = i
    hdr = 1; next
  }
  frame == 2 && hdr && col { print $1, $col }' "$TMP")

# One row per process: pid <TAB> cpu% of whole machine <TAB> RAM bytes <TAB> name
TAB=$(printf '\t')
PROCS=$( { printf '%s\n' "$TOPCPU"; echo "--"; ps -eo pid=,rss=,comm=; } | awk -v cores="$CORES" '
  $0 == "--" { in_ps = 1; next }
  !in_ps     { cpu[$1] = $2; next }
  {
    name = $3; for (i = 4; i <= NF; i++) name = name " " $i
    printf "%s\t%.1f\t%.0f\t%s\n", $1, cpu[$1] / cores, $2 * 1024, name
  }')
TOP_BY_CPU=$(printf '%s\n' "$PROCS" | sort -t "$TAB" -k2,2nr | head -n "$TOP_N")
TOP_BY_MEM=$(printf '%s\n' "$PROCS" | sort -t "$TAB" -k3,3nr | head -n "$TOP_N")

# Real filesystems only (skip RAM-backed and container ones), one row per device.
# Prints: mount <TAB> size <TAB> used <TAB> available   (bytes)
DISKS=$(df -B1 -P -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null | awk '
  NR > 1 && !seen[$1]++ {
    m = $6; for (i = 7; i <= NF; i++) m = m " " $i
    printf "%s\t%.0f\t%.0f\t%.0f\n", m, $2, $3, $4
  }')

BTIME=$(awk '$1 == "btime" { print $2 }' /proc/stat)

# ---------------------------------------------------------------- assemble JSON
# Everything is fed to one awk as "key<TAB>values" lines, which does the math.

{
  printf 'host\t%s\n'   "$(cat /proc/sys/kernel/hostname)"
  printf 'time\t%s\n'   "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'boot\t%s\n'   "$(date -u -d "@$BTIME" +%Y-%m-%dT%H:%M:%SZ)"
  printf 'cores\t%s\n'  "$CORES"
  printf 'up\t%s\t%s\n' "$UP1" "$UP2"
  printf 'cpu\t%s\t%s\n' "$CPU1" "$CPU2"
  printf 'net\t%s\t%s\t%s\n' "$NET1" "$NET2" "$IFACE"
  printf 'load\t%s\n'   "$(cat /proc/loadavg)"
  awk '$1 == "procs_running" || $1 == "procs_blocked" { printf "%s\t%s\n", $1, $2 }' /proc/stat
  awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ { sub(/:/, "", $1); printf "%s\t%s\n", $1, $2 }' /proc/meminfo
  [ -n "$DISKS" ]      && printf '%s\n' "$DISKS"      | sed "s/^/disk$TAB/"
  [ -n "$TOP_BY_CPU" ] && printf '%s\n' "$TOP_BY_CPU" | sed "s/^/pcpu$TAB/"
  [ -n "$TOP_BY_MEM" ] && printf '%s\n' "$TOP_BY_MEM" | sed "s/^/pmem$TAB/"
} | awk -F '\t' '
  # JSON-escape a string (char by char, works in mawk and gawk)
  function esc(s,   i, c, o) {
    o = ""
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1)
      if (c == "\\" || c == "\"") o = o "\\" c
      else if (c < " ")           o = o " "
      else                        o = o c
    }
    return o
  }
  function pct(part, whole) { return whole > 0 ? part / whole * 100 : 0 }
  function proc_list(n, pid, cpu, mem, name,   i, s) {
    s = ""
    for (i = 1; i <= n; i++)
      s = s sprintf("%s\n    { \"pid\": %s, \"name\": \"%s\", \"cpu_pct\": %.1f, \"mem_bytes\": %.0f }",
                    (i > 1 ? "," : ""), pid[i], esc(name[i]), cpu[i], mem[i])
    return "[" s (n ? "\n  " : "") "]"
  }

  $1 == "host"  { host = $2 }
  $1 == "time"  { ts = $2 }
  $1 == "boot"  { boot = $2 }
  $1 == "cores" { cores = $2 }
  $1 == "up"    { up1 = $2; up2 = $3 }
  $1 == "cpu"   { split($2, a, " "); split($3, b, " ") }
  $1 == "net"   { split($2, n1, " "); split($3, n2, " "); iface = $4 }
  $1 == "load"  { split($2, l, " ") }
  $1 == "procs_running" { running = $2 }
  $1 == "procs_blocked" { blocked = $2 }
  $1 == "MemTotal"      { mem_total = $2 * 1024 }
  $1 == "MemAvailable"  { mem_avail = $2 * 1024 }
  $1 == "SwapTotal"     { swap_total = $2 * 1024 }
  $1 == "SwapFree"      { swap_free = $2 * 1024 }
  $1 == "disk" { nd++; dm[nd] = $2; ds[nd] = $3; du[nd] = $4; da[nd] = $5 }
  $1 == "pcpu" { nc++; cp[nc] = $2; cc[nc] = $3; cm[nc] = $4; cn[nc] = $5 }
  $1 == "pmem" { nm++; mp[nm] = $2; mc[nm] = $3; mm[nm] = $4; mn[nm] = $5 }

  END {
    # CPU: difference between the two /proc/stat samples
    # fields: 1 user 2 nice 3 system 4 idle 5 iowait 6 irq 7 softirq 8 steal
    total = 0
    for (i = 1; i <= 8; i++) { d[i] = b[i] - a[i]; total += d[i] }
    busy = d[1] + d[2] + d[3] + d[6] + d[7]

    dt = up2 - up1; if (dt <= 0) dt = 1

    disks = ""
    for (i = 1; i <= nd; i++)
      disks = disks sprintf("%s\n    { \"mount\": \"%s\", \"total_bytes\": %.0f, \"used_bytes\": %.0f, \"free_bytes\": %.0f, \"used_pct\": %.1f }",
                            (i > 1 ? "," : ""), esc(dm[i]), ds[i], du[i], da[i], pct(du[i], du[i] + da[i]))

    printf "{\n"
    printf "  \"host\": \"%s\",\n", esc(host)
    printf "  \"timestamp\": \"%s\",\n", ts
    printf "  \"boot_time\": \"%s\",\n", boot
    printf "  \"uptime_seconds\": %d,\n", up2
    printf "  \"cpu\": {\n"
    printf "    \"cores\": %d,\n", cores
    printf "    \"usage_pct\": %.1f,\n", pct(busy, total)
    printf "    \"iowait_pct\": %.1f,\n", pct(d[5], total)
    printf "    \"steal_pct\": %.1f,\n", pct(d[8], total)
    printf "    \"load\": [%s, %s, %s],\n", l[1], l[2], l[3]
    printf "    \"procs_running\": %d,\n", running
    printf "    \"procs_blocked\": %d\n", blocked
    printf "  },\n"
    printf "  \"ram\": {\n"
    printf "    \"total_bytes\": %.0f,\n", mem_total
    printf "    \"used_bytes\": %.0f,\n", mem_total - mem_avail
    printf "    \"available_bytes\": %.0f,\n", mem_avail
    printf "    \"used_pct\": %.1f,\n", pct(mem_total - mem_avail, mem_total)
    printf "    \"swap_total_bytes\": %.0f,\n", swap_total
    printf "    \"swap_used_bytes\": %.0f\n", swap_total - swap_free
    printf "  },\n"
    printf "  \"disks\": [%s%s],\n", disks, (nd ? "\n  " : "")
    printf "  \"net\": {\n"
    if (iface != "" && n1[1] != "" && n2[1] != "") {
      printf "    \"interface\": \"%s\",\n", esc(iface)
      printf "    \"rx_bytes_per_s\": %.0f,\n", (n2[1] - n1[1]) / dt
      printf "    \"tx_bytes_per_s\": %.0f,\n", (n2[2] - n1[2]) / dt
      printf "    \"rx_total_bytes\": %.0f,\n", n2[1]
      printf "    \"tx_total_bytes\": %.0f\n", n2[2]
    } else {
      # no internet-facing interface found: say so instead of guessing
      printf "    \"interface\": null,\n"
      printf "    \"rx_bytes_per_s\": null,\n"
      printf "    \"tx_bytes_per_s\": null,\n"
      printf "    \"rx_total_bytes\": null,\n"
      printf "    \"tx_total_bytes\": null\n"
    }
    printf "  },\n"
    printf "  \"top_cpu\": %s,\n", proc_list(nc, cp, cc, cm, cn)
    printf "  \"top_mem\": %s\n",  proc_list(nm, mp, mc, mm, mn)
    printf "}\n"
  }'
