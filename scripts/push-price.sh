#!/bin/bash
# Push SPY price to MoltBets Railway backend
# Run via: nohup bash push-price.sh &

BASE="https://moltbets.app"
ADMIN_KEY="QZ9AWFmrIVYXzf6AZvXvFyy0cKaUoAqA"
FAIL_COUNT=0

while true; do
  # Rotate between Yahoo endpoints to avoid rate limits
  if (( FAIL_COUNT % 2 == 0 )); then
    URL="https://query2.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=1d"
  else
    URL="https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=1d"
  fi

  DATA=$(curl -s --max-time 10 "$URL" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")

  if [ $? -eq 0 ] && echo "$DATA" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    PRICE=$(echo "$DATA" | python3 -c "import sys,json; m=json.load(sys.stdin)['chart']['result'][0]['meta']; print(m['regularMarketPrice'])")
    OPEN=$(echo "$DATA" | python3 -c "import sys,json; m=json.load(sys.stdin)['chart']['result'][0]['meta']; print(m.get('regularMarketOpen', m.get('chartPreviousClose', 0)))")
    RAW_STATE=$(echo "$DATA" | python3 -c "import sys,json; m=json.load(sys.stdin)['chart']['result'][0]['meta']; print(m.get('marketState', 'UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")

    # Override market state based on actual ET hours
    # Market hours: 9:30 AM - 4:00 PM ET (Mon-Fri)
    ET_HOUR=$(TZ="America/New_York" date +%H)
    ET_MIN=$(TZ="America/New_York" date +%M)
    DOW=$(TZ="America/New_York" date +%u)  # 1=Mon, 7=Sun
    ET_MINS=$((10#$ET_HOUR * 60 + 10#$ET_MIN))

    if [ "$DOW" -le 5 ] && [ "$ET_MINS" -ge 570 ] && [ "$ET_MINS" -lt 960 ]; then
      STATE="REGULAR"
    elif [ "$DOW" -le 5 ] && [ "$ET_MINS" -ge 540 ] && [ "$ET_MINS" -lt 570 ]; then
      STATE="PRE"
    elif [ "$DOW" -le 5 ] && [ "$ET_MINS" -ge 960 ] && [ "$ET_MINS" -lt 1200 ]; then
      STATE="POST"
    else
      STATE="CLOSED"
    fi

    RESULT=$(curl -s -X POST "$BASE/api/admin/push-price" \
      -H "Content-Type: application/json" \
      -H "x-admin-key: $ADMIN_KEY" \
      -d "{\"price\": $PRICE, \"open\": $OPEN, \"marketState\": \"$STATE\"}")

    echo "[$(date)] Pushed: price=$PRICE open=$OPEN yahoo=$RAW_STATE computed=$STATE -> $RESULT"
    FAIL_COUNT=0
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "[$(date)] Failed to fetch SPY data (attempt $FAIL_COUNT)"
  fi

  sleep 30
done
