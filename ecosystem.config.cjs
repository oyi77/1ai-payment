/**
 * PM2 process config for 1ai-payment (Sweep143).
 *
 * The live process was started by hand (`pm2 start bun ...`), so nothing
 * pinned its kill_timeout — the daemon default applied (5000ms at last
 * check). The shutdown drain budget in src/index.ts MUST fit inside
 * kill_timeout or PM2 SIGKILLs mid-drain. Keep the two in sync: if you
 * raise kill_timeout here, you may raise the drain budget there (and the
 * drainForwards default in forwarder.service.ts) by the same margin.
 *
 * No env values are set here on purpose: runtime config comes from the
 * repo .env (PORT, DATABASE_PATH, NODE_ENV, gateway creds) as today.
 * This file pins process behaviour only, never secrets.
 */
module.exports = {
	apps: [
		{
			name: "1ai-payment-prod",
			cwd: "/home/openclaw/projects/1ai-payment",
			script: "/home/openclaw/.bun/bin/bun",
			args: "run src/index.ts",
			exec_mode: "fork",
			instances: 1,
			autorestart: true,
			watch: false,
			// Shutdown budget: SIGTERM -> 5000ms to exit, then SIGKILL.
			// src/index.ts drains forwards (3000ms) + forces exit (4500ms).
			kill_timeout: 5000,
			wait_ready: false,
			max_restarts: 10,
			min_uptime: "10s",
		},
	],
};
