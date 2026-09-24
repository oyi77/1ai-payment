/**
 * Content-Security-Policy for static HTML pages (Sweep165).
 *
 * The dashboard holds the merchant API key in localStorage with inline
 * handlers everywhere, so script-src cannot drop 'unsafe-inline' without a
 * full rewrite. What CSP still buys here is EXFILTRATION CONTAINMENT: even
 * a successful script injection cannot send the key out (connect-src/form-
 * action 'self') nor load a foreign kit (script-src allowlist) nor frame
 * the pages (frame-ancestors 'self', belt-and-braces over X-Frame-Options).
 *
 * Scope is static pages ONLY (/, /dashboard, /payment/*): /reference serves
 * Swagger UI off jsdelivr + inline boot, and API/JSON routes gain nothing
 * from CSP. The middleware no-ops elsewhere so application routes stay
 * untouched.
 */
import type { Context, Next } from "hono";

const CSP_POLICY = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' https://fonts.gstatic.com",
	"img-src 'self' data:",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"frame-ancestors 'self'",
	"form-action 'self'",
].join("; ");

const CSP_PATHS = ["/", "/dashboard", "/dashboard/"];

export function cspMiddleware(c: Context, next: Next) {
	const path = c.req.path;
	const scoped = CSP_PATHS.includes(path) || path.startsWith("/payment/");
	if (scoped) {
		c.header("Content-Security-Policy", CSP_POLICY);
	}
	return next();
}
