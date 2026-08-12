#!/usr/bin/env bash
#
# Prove the till keeps selling with the internet unplugged.
#
# ---------------------------------------------------------------------------
# WHY THIS IS A SCRIPT AND NOT A PARAGRAPH IN THE RUNBOOK.
#
# "The shop keeps working offline" is the single claim the whole local-first
# deployment exists to make, and it is the one claim nobody ever tests, because
# testing it means walking to the router and pulling a cable during a quiet
# hour. A checklist in a document gets read once. This gets run.
#
# It is deliberately operator-driven: the step that matters is physical, and no
# amount of software can pull the cable for you. What the script does is remove
# every excuse around that step — it records the before-state, rings a REAL cash
# sale in RM through the live API, and checks the four things that must be true
# afterwards, so the only work left for a human is unplugging and replugging.
#
#   scripts/shop/offline-acceptance.sh                       # the real thing
#   scripts/shop/offline-acceptance.sh --simulate            # no cable pulled
#
# `--simulate` runs every assertion except the physical ones and SAYS SO in the
# verdict. It is for checking the script itself, never for signing off a shop.
# ---------------------------------------------------------------------------
set -euo pipefail

API="${API:-http://localhost:8080/api}"
DB="${DATABASE_URL:-}"
EMAIL="${EMIL_EMAIL:-}"
PASSWORD="${EMIL_PASSWORD:-}"
ITEM_CODE="${ITEM_CODE:-}"
QTY="${QTY:-1}"
SIMULATE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --api) API="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --item) ITEM_CODE="$2"; shift 2 ;;
    --qty) QTY="$2"; shift 2 ;;
    --simulate) SIMULATE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for tool in curl jq psql; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 2; }
done
[ -n "$DB" ] || { echo "set DATABASE_URL or pass --db (needed to read stock and the outbox)" >&2; exit 2; }
[ -n "$EMAIL" ] && [ -n "$PASSWORD" ] || { echo "pass --email and --password for a user who can ring a sale" >&2; exit 2; }

# ---- reporting -------------------------------------------------------------

PASSES=0; FAILURES=0
RESULTS=()

record() { # name, verdict, detail
  RESULTS+=("$1|$2|$3")
  if [ "$2" = PASS ]; then PASSES=$((PASSES + 1)); else FAILURES=$((FAILURES + 1)); fi
}

check() { # name, expected, actual
  if [ "$2" = "$3" ]; then record "$1" PASS "$3"; else record "$1" FAIL "expected $2, got $3"; fi
}

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

q() { psql "$DB" -qAt -c "$1"; }   # one scalar out of PostgreSQL

pause() { # message
  if [ "$SIMULATE" = 1 ]; then
    printf '  [simulate] SKIPPED: %s\n' "$1"
    return
  fi
  printf '\n  \033[1;33m>>> %s\033[0m\n  Press Enter when done: ' "$1"
  read -r _
}

# ---- 1. preflight ----------------------------------------------------------

say '1. Preflight'

HEALTH="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$API/openapi.json" --max-time 5 || echo 000)"
check 'API answers' 200 "$HEALTH"

# The address printed on paper a customer keeps. localhost is a dead link in
# their hand, and paper outlives the deployment that printed it.
PUBLIC_BASE="$(q "SELECT current_setting('server_version_num', true)" >/dev/null 2>&1 && echo ok || echo unreachable)"
check 'database reachable' ok "$PUBLIC_BASE"

CLOCK_DRIFT_OK=$( [ "$(date +%Y)" -ge 2024 ] && echo ok || echo suspect )
check 'clock is sane' ok "$CLOCK_DRIFT_OK"

# Is anything actually draining the outbox? A PENDING event that has sat for two
# minutes without even one claim attempt means no worker is running — and
# without this check that surfaces at the very end, as a mysterious failure to
# drain, long after the operator has plugged the cable back in.
STALE="$(q "SELECT count(*) FROM outbox_event
             WHERE status='PENDING' AND attempts=0 AND created_at < now() - INTERVAL '2 minutes'")"
if [ "$STALE" = 0 ]; then
  record 'worker is draining the outbox' PASS 'no unclaimed backlog'
else
  record 'worker is draining the outbox' FAIL \
    "$STALE event(s) never claimed — start the worker (docker compose … up -d worker)"
fi

# ---- 2. sign in and pick the item -----------------------------------------

say '2. Sign in'

LOGIN="$(curl -s --noproxy '*' -X POST "$API/v1/auth/login" \
  -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo "acc-$RANDOM$RANDOM")" \
  -d "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')" || echo '{}')"

REFRESH="$(echo "$LOGIN" | jq -r '.refreshToken // empty')"
TENANT="$(echo "$LOGIN" | jq -r '.organisations[0].tenantId // empty')"
[ -n "$REFRESH" ] && [ -n "$TENANT" ] || { echo "sign-in failed: $LOGIN" >&2; exit 1; }

SWITCH="$(curl -s --noproxy '*' -X POST "$API/v1/auth/switch" \
  -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo "acc-$RANDOM$RANDOM")" \
  -d "$(jq -nc --arg t "$TENANT" --arg r "$REFRESH" '{tenantId:$t,refreshToken:$r}')")"
TOKEN="$(echo "$SWITCH" | jq -r '.accessToken // empty')"
[ -n "$TOKEN" ] || { echo "could not mint an access token: $SWITCH" >&2; exit 1; }
record 'signed in' PASS "tenant ${TENANT:0:8}…"

auth=(-H "Authorization: Bearer $TOKEN" -H "X-Tenant-Id: $TENANT")

# A tracked item with stock on hand, so the decrement below is observable.
if [ -z "$ITEM_CODE" ]; then
  ITEM_CODE="$(q "SELECT i.code FROM item i JOIN item_stock s ON s.tenant_id=i.tenant_id AND s.item_id=i.id
                   WHERE i.tenant_id='$TENANT' AND i.is_tracked AND s.quantity_on_hand >= $QTY
                   ORDER BY s.quantity_on_hand DESC LIMIT 1")"
fi
[ -n "$ITEM_CODE" ] || { echo "no tracked item with stock >= $QTY; pass --item" >&2; exit 1; }

ITEM_ID="$(q "SELECT id FROM item WHERE tenant_id='$TENANT' AND code='$ITEM_CODE'")"
DEPOSIT="$(q "SELECT id FROM account WHERE tenant_id='$TENANT' AND code='1000'")"
record 'item chosen' PASS "$ITEM_CODE"

# ---- 3. before-state -------------------------------------------------------

say '3. Before-state'

STOCK_BEFORE="$(q "SELECT quantity_on_hand FROM item_stock WHERE tenant_id='$TENANT' AND item_id='$ITEM_ID'")"
ENTRIES_BEFORE="$(q "SELECT count(*) FROM journal_entry WHERE tenant_id='$TENANT'")"
OUTBOX_BEFORE="$(q "SELECT count(*) FROM outbox_event WHERE tenant_id='$TENANT' AND status <> 'DISPATCHED'")"
printf '  stock on hand=%s  journal entries=%s  undispatched outbox=%s\n' \
  "$STOCK_BEFORE" "$ENTRIES_BEFORE" "$OUTBOX_BEFORE"

# ---- 4. go offline and sell ------------------------------------------------

say '4. The sale, with the WAN down'

pause 'UNPLUG the WAN cable from the router (leave the LAN switch powered), then confirm'

# Everything the drain check looks at is scoped to events created after this
# mark. A backlog from earlier testing is a real problem, but it is the
# preflight's problem — failing THIS run for it would blame the sale we are
# about to ring for something that predates it.
SINCE="$(q "SELECT now()")"

SALE_BODY="$(jq -nc --arg d "$(date +%F)" --arg i "$ITEM_ID" --arg q "$QTY" --arg a "$DEPOSIT" \
  '{saleDate:$d, lines:[{itemId:$i, quantity:$q}], method:"CASH", depositAccountId:$a}')"

SALE_HTTP="$(curl -s -o /tmp/emil-sale.json -w '%{http_code}' --noproxy '*' -X POST "$API/v1/pos/sales" \
  "${auth[@]}" -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo "sale-$RANDOM$RANDOM")" \
  -d "$SALE_BODY" --max-time 20 || echo 000)"

check 'sale completes with the WAN down' 201 "$SALE_HTTP"

SALE_TOTAL="$(jq -r '.total // "?"' /tmp/emil-sale.json 2>/dev/null || echo '?')"
INVOICE_NO="$(jq -r '.invoiceNo // "?"' /tmp/emil-sale.json 2>/dev/null || echo '?')"
printf '  rang %s for RM %s\n' "$INVOICE_NO" "$(printf '%.2f' "$SALE_TOTAL" 2>/dev/null || echo "$SALE_TOTAL")"

# ---- 5. the four things that must be true ---------------------------------

say '5. What the sale must have done, locally'

STOCK_AFTER="$(q "SELECT quantity_on_hand FROM item_stock WHERE tenant_id='$TENANT' AND item_id='$ITEM_ID'")"
EXPECTED_STOCK="$(q "SELECT ($STOCK_BEFORE)::numeric - ($QTY)::numeric")"
check 'stock decremented' "$EXPECTED_STOCK" "$STOCK_AFTER"

ENTRIES_AFTER="$(q "SELECT count(*) FROM journal_entry WHERE tenant_id='$TENANT'")"
[ "$ENTRIES_AFTER" -gt "$ENTRIES_BEFORE" ] \
  && record 'journal entry posted' PASS "$ENTRIES_BEFORE → $ENTRIES_AFTER" \
  || record 'journal entry posted' FAIL "still $ENTRIES_AFTER"

# The ledger's own invariant, checked on the entry this sale just posted.
UNBALANCED="$(q "SELECT count(*) FROM (
    SELECT e.id FROM journal_entry e JOIN journal_line l
      ON l.tenant_id=e.tenant_id AND l.journal_entry_id=e.id
     WHERE e.tenant_id='$TENANT'
     GROUP BY e.id HAVING sum(l.base_debit) <> sum(l.base_credit)) x")"
check 'every journal entry balances' 0 "$UNBALANCED"

# The outbound work is QUEUED, not lost. This is the property that makes an ISP
# outage a delay rather than a hole in the books.
OUTBOX_ROW="$(q "SELECT count(*) FROM outbox_event WHERE tenant_id='$TENANT' AND created_at >= '$SINCE'")"
[ "$OUTBOX_ROW" -gt 0 ] \
  && record 'outbound work queued in outbox_event' PASS "$OUTBOX_ROW new event(s)" \
  || record 'outbound work queued in outbox_event' FAIL 'no event written'

# ---- 6. reconnect and watch it drain --------------------------------------

say '6. Reconnect'

pause 'PLUG the WAN cable back in, then confirm'

DRAINED=no
for _ in $(seq 1 30); do
  STUCK="$(q "SELECT count(*) FROM outbox_event
                WHERE tenant_id='$TENANT' AND created_at >= '$SINCE' AND status <> 'DISPATCHED'")"
  if [ "$STUCK" = 0 ]; then DRAINED=yes; break; fi
  sleep 2
done

if [ "$DRAINED" = yes ]; then
  record 'queue drains after reconnect' PASS 'nothing left due'
else
  DETAIL="$(q "SELECT string_agg(event_type||' attempts='||attempts||' '||coalesce(left(last_error,60),''), '; ')
                 FROM (SELECT * FROM outbox_event
                        WHERE tenant_id='$TENANT' AND created_at >= '$SINCE' AND status <> 'DISPATCHED'
                        LIMIT 5) stuck")"
  record 'queue drains after reconnect' FAIL "${DETAIL:-still pending}"
fi

# ---- verdict ---------------------------------------------------------------

say 'Verdict'
printf '  %-46s %-6s %s\n' 'CHECK' 'RESULT' 'DETAIL'
printf '  %s\n' '---------------------------------------------------------------------------'
for row in "${RESULTS[@]}"; do
  IFS='|' read -r name verdict detail <<< "$row"
  colour=$([ "$verdict" = PASS ] && echo '\033[0;32m' || echo '\033[0;31m')
  printf '  %-46s '"$colour"'%-6s\033[0m %s\n' "$name" "$verdict" "$detail"
done
printf '\n  %d passed, %d failed\n' "$PASSES" "$FAILURES"

if [ "$SIMULATE" = 1 ]; then
  printf '\n  \033[1;33mSIMULATED RUN — no cable was pulled. This does NOT sign off a shop.\033[0m\n'
fi

[ "$FAILURES" -eq 0 ] || exit 1
