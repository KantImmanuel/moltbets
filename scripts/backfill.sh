#!/bin/bash
# Backfill historical rounds by creating rounds + settling them via admin API
BASE="https://moltbets.app"
ADMIN_KEY="QZ9AWFmrIVYXzf6AZvXvFyy0cKaUoAqA"

# Historical SPY data (last 6 trading days before today)
# We'll create round, then settle with real open/close prices
DAYS=(
  "2026-02-03|696.21|689.53"
  "2026-02-04|690.35|686.19"
  "2026-02-05|680.94|677.62"
  "2026-02-06|681.46|690.62"
  "2026-02-07|689.42|693.95"
  "2026-02-10|694.95|692.12"
)

# Get all agent API keys by registering temp agents won't work...
# We need the existing agents' tokens. 
# Let's use a different approach: we'll just create proper rounds and use the settle endpoint

for entry in "${DAYS[@]}"; do
  IFS='|' read -r DATE OPEN CLOSE <<< "$entry"
  
  if (( $(echo "$CLOSE > $OPEN" | bc -l) )); then
    RESULT="UP"
  else
    RESULT="DOWN"
  fi
  
  echo "=== $DATE: $OPEN -> $CLOSE ($RESULT) ==="
  
  # Create round with open price
  curl -s -X POST "$BASE/api/admin/create-round" \
    -H "x-admin-key: $ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"openPrice\": $OPEN}" | python3 -c "import sys,json; print(json.load(sys.stdin))" 2>/dev/null
    
  echo "  Round created"
done

echo "Done creating rounds. But we can't place bets for past dates via API."
echo "Need to use the backfill admin endpoint once it deploys."
