#!/usr/bin/env bash
#
# Is the till going to be able to find this machine tomorrow?
#
# ---------------------------------------------------------------------------
# THE GUIDE SAYS RESERVE AN ADDRESS. NOTHING CHECKED THAT ANYBODY DID.
#
# `docs/HYBRID-SHOP-DEPLOYMENT.md` §2 asks for a DHCP reservation so the shop
# server keeps one address forever, and for the cashier PC to reach it by IP or
# a hosts entry so no DNS server is on the path to a sale. Both are one-time
# setup steps done by a person, in a router UI, months before the day they
# matter — which is the exact shape of a step that silently does not happen.
#
# This reports what is actually true right now: which address the shop server
# has, whether that address came from DHCP (and so can move), whether the app
# answers on it rather than only on localhost, and what a browser will and will
# not do when it arrives over a bare LAN address.
#
#   scripts/shop/lan-check.sh [--port 8080]
# ---------------------------------------------------------------------------
set -euo pipefail

PORT="${WEB_PORT:-8080}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

warn() { printf '  \033[1;33m!\033[0m %s\n' "$1"; }
ok()   { printf '  \033[0;32m+\033[0m %s\n' "$1"; }
bad()  { printf '  \033[0;31mx\033[0m %s\n' "$1"; }

printf '\n\033[1mShop server addresses\033[0m\n'

# `ip` gives the interface AND whether the address came from DHCP, which is the
# question this script exists to answer. Where it is missing — a slim container,
# a BusyBox box — `hostname -I` still yields the addresses, so the reachability
# half of the check runs and only the DHCP warning is lost. Degrading beats
# refusing: an operator who ran this to find their address should get it.
ADDRS=""
HAVE_IP=0
if command -v ip >/dev/null; then
  HAVE_IP=1
  # Global-scope IPv4 only: loopback and link-local are not addresses a till can use.
  ADDRS="$(ip -4 -o addr show scope global 2>/dev/null || true)"
elif command -v hostname >/dev/null; then
  warn "'ip' is unavailable — falling back to hostname -I (no DHCP detection)"
  for a in $(hostname -I 2>/dev/null); do
    case "$a" in *:*) continue ;; esac          # skip IPv6
    ADDRS="${ADDRS}fallback ? ? ${a}/?"$'\n'
  done
fi

if [ -z "$ADDRS" ]; then
  bad 'no global IPv4 address found — this machine is not on a LAN'
  exit 1
fi

DYNAMIC_FOUND=0
PRIMARY=""

while IFS= read -r line; do
  [ -n "$line" ] || continue
  IFACE="$(echo "$line" | awk '{print $2}')"
  CIDR="$(echo "$line" | awk '{print $4}')"
  ADDR="${CIDR%%/*}"
  [ -n "$PRIMARY" ] || PRIMARY="$ADDR"

  # `dynamic` on the address means the kernel got it from DHCP and it carries a
  # lease. Without a reservation on the router, the lease can hand out a
  # different address after a power cut — and every till bookmark breaks at once.
  if [ "$HAVE_IP" = 0 ]; then
    ok "$ADDR — found, but whether it is DHCP or static could not be determined here"
  elif echo "$line" | grep -q ' dynamic '; then
    DYNAMIC_FOUND=1
    warn "$IFACE $ADDR — from DHCP. Reserve it against this NIC's MAC in the router, or it can move."
  else
    ok "$IFACE $ADDR — static or reserved"
  fi
done <<< "$ADDRS"

printf '\n\033[1mCan the till reach the app here?\033[0m\n'

REACHED=0
for candidate in $(echo "$ADDRS" | awk '{print $4}' | cut -d/ -f1); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' \
    "http://$candidate:$PORT/" --max-time 4 2>/dev/null || echo 000)"
  if [ "$CODE" != 000 ]; then
    ok "http://$candidate:$PORT answers ($CODE) — bookmark this on the cashier PC"
    REACHED=1
  else
    bad "http://$candidate:$PORT did not answer"
  fi
done

if [ "$REACHED" = 0 ]; then
  bad "nothing answered on port $PORT."
  warn 'Check the app is up, that compose publishes the port, and that the host firewall allows it.'
  warn 'Binding is NOT the likely cause: the API defaults to 0.0.0.0 (apps/api/src/config.ts).'
fi

printf '\n\033[1mWhat a browser will do at that address\033[0m\n'
warn 'A bare LAN address is NOT a secure context. Service workers and the'
warn 'install-as-an-app prompt are unavailable there; crypto.randomUUID is too,'
warn 'which is why this app uses src/lib/uuid.ts instead. None of that stops a'
warn 'sale. For a secure origin on phones, use Tailscale Serve — see'
warn 'docs/HYBRID-SHOP-DEPLOYMENT.md §3 and §4.3.'

printf '\n\033[1mThe till bookmark\033[0m\n'
printf '  Use the IP directly, or add this line to the cashier PC hosts file so\n'
printf '  no DNS server is ever on the path to a sale:\n\n'
printf '      %s    till\n\n' "${PRIMARY:-192.168.1.10}"
printf '  Windows: C:\\Windows\\System32\\drivers\\etc\\hosts (edit as Administrator)\n'
printf '  Linux/macOS: /etc/hosts\n\n'

if [ "$DYNAMIC_FOUND" = 1 ]; then
  printf '\033[1;33mAt least one address is from DHCP. Reserve it before you trust it.\033[0m\n\n'
fi
