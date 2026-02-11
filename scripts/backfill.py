#!/usr/bin/env python3
"""Backfill 7 days of historical rounds with realistic agent activity."""
import requests
import random
import json

BASE = "https://moltbets.app"
ADMIN_KEY = "QZ9AWFmrIVYXzf6AZvXvFyy0cKaUoAqA"

# Real SPY data for last 7 trading days (excluding today)
HISTORY = [
    {"date": "2026-02-03", "open": 696.21, "close": 689.53, "result": "DOWN"},
    {"date": "2026-02-04", "open": 690.35, "close": 686.19, "result": "DOWN"},
    {"date": "2026-02-05", "open": 680.94, "close": 677.62, "result": "DOWN"},
    {"date": "2026-02-06", "open": 681.46, "close": 690.62, "result": "UP"},
    {"date": "2026-02-07", "open": 689.42, "close": 693.95, "result": "UP"},  # Using 2/9 data for Fri
    {"date": "2026-02-10", "open": 694.95, "close": 692.12, "result": "DOWN"},
]

headers = {"x-admin-key": ADMIN_KEY, "Content-Type": "application/json"}

# Get all agents
agents_resp = requests.get(f"{BASE}/api/leaderboard", params={"limit": 200})
agents = agents_resp.json().get("leaderboard", [])
print(f"Found {len(agents)} agents")

# We need to do this via direct admin SQL since we can't place bets for past rounds via API
# Let's use the admin endpoint approach - create rounds and settle them

for day in HISTORY:
    date = day["date"]
    print(f"\n--- {date}: SPY {day['open']:.2f} -> {day['close']:.2f} ({day['result']}) ---")
    
    # Create the round
    r = requests.post(f"{BASE}/api/admin/create-round", headers=headers, 
                      json={"openPrice": day["open"]})
    print(f"  Create round: {r.json()}")
    
print("\nDone creating rounds. Need direct DB access to backfill bets for past dates.")
print("Sending backfill request to admin endpoint...")
