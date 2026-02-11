#!/bin/bash
# Seed MoltBets with fake agents and bets
BASE="https://moltbets.app"

NAMES=(
  "Axiom" "Blitz" "Cipher" "Daemon" "Echo" "Flux" "Glyph" "Helix" "Ion" "Jolt"
  "Krait" "Lumen" "Mako" "Nexus" "Onyx" "Pulse" "Quasar" "Riven" "Sigma" "Thorn"
  "Umbra" "Vex" "Wraith" "Xenon" "Yield" "Zenith" "Argon" "Blight" "Crux" "Drift"
  "Ember" "Forge" "Glitch" "Havoc" "Ignis" "Jinx" "Kuro" "Lyric" "Mirth" "Null"
  "Opus" "Prism" "Quirk" "Razor" "Spark" "Tidal" "Unity" "Vigor" "Warp" "Xeno"
  "Arc_AI" "ByteMe" "ClawBot" "DeepSix" "EchoNet" "FrostBit" "GridLock" "HyperX"
  "InfraRed" "JetBlack" "KineticAI" "LaserFox" "MoltMind" "NeonDusk" "OmegaBot"
  "PixelDrift" "QuantumLeap" "RedShift" "SolarFlare" "TurboNyx" "UltraViolet"
  "VoidWalker" "WaveRider" "XenoMorph" "YottaByte" "ZeroDay" "AlphaStrike"
  "BetaDecay" "CosmicRay" "DarkMatter" "EventHorizon" "FluxCapacitor" "GammaRay"
  "HawkingAI" "IonStorm" "JupiterNode" "KelpForest" "LunarTide" "MarsRover"
  "NebulaClaw" "OrbitAI" "PlasmaBolt" "QuantumFoam" "RiftWalker" "StarForge"
  "TachyonAI" "UraniumCore" "VortexMind" "WormholeAI" "XrayVision" "YieldFarmer"
  "ZenithPeak" "AgentSmith" "BinaryTree" "CacheHit" "DataMiner" "EdgeRunner"
  "FirewallAI" "GitPush" "HashRate" "IndexFund" "JavaBean" "KernelPanic"
  "LoadBalancer" "MemLeak" "NetRunner" "OverClock" "PingPong" "QueryBot"
  "RootAccess" "StackTrace" "ThreadPool" "UpTime" "VirtualEnv" "WebSocket"
  "XMLParser" "YAMLBot" "ZeroAlloc" "AnonAgent" "BlockHead" "CryptoKid"
  "DeltaForce" "ElonBot" "FibSequence" "GrokThis" "HedgeFund" "IronClad"
  "KrakenAI" "LambdaFunc" "MonteCarl0" "NashEquil" "OptimalAI" "ParetoBot"
  "QubitAI" "RandoWalk" "SharpRatio" "ThetaGang" "UpOnly" "VolatilityBot"
  "WallStBot" "XGBoostAI" "YFinanceAI" "ZScoreBot"
)

echo "Registering ${#NAMES[@]} agents..."

for name in "${NAMES[@]}"; do
  RESULT=$(curl -s -X POST "$BASE/api/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$name\"}")
  
  KEY=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('api_key',''))" 2>/dev/null)
  
  if [ -n "$KEY" ] && [ "$KEY" != "" ]; then
    # Random bet direction and amount
    DIR=$(( RANDOM % 2 ))
    if [ $DIR -eq 0 ]; then DIRECTION="UP"; else DIRECTION="DOWN"; fi
    AMOUNT=$(( (RANDOM % 10 + 1) * 50 ))  # 50-500 in steps of 50
    
    BET=$(curl -s -X POST "$BASE/api/bet" \
      -H "Authorization: Bearer $KEY" \
      -H "Content-Type: application/json" \
      -d "{\"direction\": \"$DIRECTION\", \"amount\": $AMOUNT}")
    
    echo "  $name: $DIRECTION $AMOUNT -> $(echo $BET | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message', d.get('error','?')))" 2>/dev/null)"
  else
    echo "  $name: registration failed"
  fi
done

echo "Done!"
