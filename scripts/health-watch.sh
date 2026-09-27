#!/usr/bin/env bash
# health-watch.sh — supervisor for 1ai-payment (+ PM2 fleet).
# Runs every 2 min via user crontab. No secrets inside: bot token is read
# from the repo .env at runtime; alert chat comes from ALERT_CHAT_ID env.
#
# What it does, in order:
#   1. Probes https://pay.berkahkarya.org/health.
#   2. If down: `pm2 resurrect`, wait, re-probe (self-heal).
#   3. If still down after heal: Telegram CRITICAL alert (if configured).
#   4. If a heal happened: Telegram RECOVERED notice (if configured).
#   5. If disk >95%: Telegram DISK warning (if configured). No alert config
#      still heals + logs — alerts are best-effort, healing is not.
#   6. If ~/.pm2/pm2.log > 100MB: truncate (daemon holds fd; sparse-safe).
#   7. Per-file trim of ~/.pm2/logs/*.log over 50MB (keep newest 50MB).
set -u

REPO="/home/openclaw/projects/1ai-payment"
PM2="$HOME/.nvm/versions/node/v22.22.3/bin/pm2"
[ -x "$PM2" ] || PM2="$(command -v pm2 || echo /usr/local/bin/pm2)"
BASE="https://pay.berkahkarya.org"
ALERT_CHAT_ID="${ALERT_CHAT_ID:-}"
LOG="$REPO/data/health-watch.log"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

bot_token() {
	grep -E '^NEXUS_TELEGRAM_BOT_TOKEN=' "$REPO/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r'
}

alert() {
	# alert <message> — best effort, never fails the script
	[ -n "$ALERT_CHAT_ID" ] || return 0
	local tok; tok="$(bot_token)"
	[ -n "$tok" ] || return 0
	curl -s --max-time 15 "https://api.telegram.org/bot${tok}/sendMessage" \
		-d "chat_id=${ALERT_CHAT_ID}" -d "text=$1" -o /dev/null || true
}

healthy() {
	curl -s --max-time 12 "$BASE/health" 2>/dev/null | grep -q '"status":"ok"'
}

# --- 1. probe ---
if healthy; then
	ST="up"
else
	ST="down"
fi

# --- 2. self-heal ---
if [ "$ST" = "down" ]; then
	log "DOWN detected — running pm2 resurrect"
	"$PM2" resurrect >> "$LOG" 2>&1 || true
	sleep 20
	if healthy; then
		log "RECOVERED after resurrect"
		alert "✅ 1ai-payment RECOVERED (pm2 resurrect at $(date '+%H:%M'))"
	else
		log "STILL DOWN after resurrect — CRITICAL"
		alert "🚨 1ai-payment DOWN and resurrect failed — manual action needed"
	fi
fi

# --- 3. disk guard ---
USEPCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "${USEPCT:-0}" -ge 95 ]; then
	log "DISK WARNING: ${USEPCT}% used"
	alert "⚠️ disk ${USEPCT}% full on 1ai box — payment at risk"
fi

# --- 4. daemon log guard ---
PM2LOG="$HOME/.pm2/pm2.log"
if [ -f "$PM2LOG" ]; then
	SZ=$(stat -c%s "$PM2LOG" 2>/dev/null || echo 0)
	if [ "$SZ" -gt 104857600 ]; then
		: > "$PM2LOG"
		log "truncated pm2.log (${SZ} bytes)"
	fi
fi

# --- 5. app log guard (per-file, keep newest 50MB) ---
for f in "$HOME"/.pm2/logs/*.log; do
	[ -f "$f" ] || continue
	SZ=$(stat -c%s "$f" 2>/dev/null || echo 0)
	if [ "$SZ" -gt 52428800 ]; then
		tail -c 52428800 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
		log "trimmed $(basename "$f") (${SZ} bytes)"
	fi
done

exit 0
