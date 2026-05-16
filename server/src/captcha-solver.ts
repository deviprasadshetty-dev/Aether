/**
 * Captcha solver — tries human simulation first (no API key needed).
 * Falls back to third-party service only when explicitly requested.
 *
 * Human approach:
 *   1. Find the captcha widget's viewport coordinates via evaluate()
 *   2. Move the mouse along a cubic Bezier arc with per-step jitter + random delays
 *   3. Click the checkbox with a natural press/release gap
 *   4. Wait and check whether the captcha cleared
 *
 * This works for: Cloudflare Turnstile, reCAPTCHA v2 checkbox, hCaptcha checkbox.
 * Image-grid challenges require the paid service fallback.
 */

export type CaptchaType = "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "turnstile" | "unknown";

export interface CaptchaInfo {
    type: CaptchaType;
    sitekey: string;
    pageUrl: string;
    action?: string;
}

export interface SolveResult {
    success: boolean;
    type?: CaptchaType;
    method?: "human" | "service";
    token?: string;
    error?: string;
}

export interface SolverOptions {
    /** Force third-party service instead of human sim. Default: false */
    useService?: boolean;
    /** "2captcha" | "capsolver" — used when useService=true */
    service?: "2captcha" | "capsolver";
    /** API key — used when useService=true. Falls back to env CAPTCHA_API_KEY */
    apiKey?: string;
    /** Max wait for captcha to clear (human mode) in ms. Default 8 000 */
    waitAfterClick?: number;
    /** Max wait for service solution in ms. Default 120 000 */
    timeout?: number;
    pollInterval?: number;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function rng(min: number, max: number) { return min + Math.random() * (max - min); }
function rngInt(min: number, max: number) { return Math.round(rng(min, max)); }
function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Cubic Bezier human mouse movement
// ---------------------------------------------------------------------------

interface Point { x: number; y: number; }

/** Cubic Bezier interpolation at t∈[0,1] */
function bezier(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
    const u = 1 - t;
    return {
        x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
        y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
    };
}

/**
 * Move the mouse from `from` to `to` using a cubic Bezier arc.
 * Control points are randomised so each path looks unique.
 * `sendCommand` must be the CDP channel (Input.dispatchMouseEvent).
 */
async function humanMouseMove(
    from: Point,
    to: Point,
    sendCommand: (method: string, params: any) => Promise<any>
): Promise<void> {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    // ~1 step per 4px, 20-60 steps
    const steps = Math.max(20, Math.min(60, Math.round(dist / 4)));

    // Randomise control points (arc that curves left or right organically)
    const spread = dist * rng(0.3, 0.6);
    const angle = Math.atan2(to.y - from.y, to.x - from.x) + Math.PI / 2;
    const sign = Math.random() < 0.5 ? 1 : -1;

    const cp1: Point = {
        x: from.x + (to.x - from.x) * rng(0.1, 0.3) + Math.cos(angle) * spread * sign * rng(0.3, 1),
        y: from.y + (to.y - from.y) * rng(0.1, 0.3) + Math.sin(angle) * spread * sign * rng(0.3, 1),
    };
    const cp2: Point = {
        x: from.x + (to.x - from.x) * rng(0.7, 0.9) + Math.cos(angle) * spread * sign * rng(0.1, 0.5),
        y: from.y + (to.y - from.y) * rng(0.7, 0.9) + Math.sin(angle) * spread * sign * rng(0.1, 0.5),
    };

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        // Ease-in-out: slow start, fast middle, slow end
        const eased = t < 0.5 ? 2*t*t : -1 + (4-2*t)*t;
        const pt = bezier(eased, from, cp1, cp2, to);

        // Small per-step jitter simulates hand tremor
        const jx = rng(-0.8, 0.8);
        const jy = rng(-0.8, 0.8);

        await sendCommand("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: Math.round(pt.x + jx),
            y: Math.round(pt.y + jy),
            buttons: 0,
            pointerType: "mouse",
        });

        // Variable delay: faster in the middle, slower near target
        const nearEnd = i > steps * 0.85;
        await sleep(nearEnd ? rng(8, 20) : rng(2, 8));
    }
}

/** Human-like click: slight pre-click pause, natural press/release gap */
async function humanClick(
    pos: Point,
    sendCommand: (method: string, params: any) => Promise<any>
): Promise<void> {
    // Brief hover pause before pressing
    await sleep(rng(80, 180));

    const x = Math.round(pos.x + rng(-2, 2));
    const y = Math.round(pos.y + rng(-2, 2));

    await sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", clickCount: 1, pointerType: "mouse",
    });
    await sleep(rng(60, 140)); // human hold time
    await sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "left", clickCount: 1, pointerType: "mouse",
    });
}

// ---------------------------------------------------------------------------
// Widget detection — finds the clickable captcha element in the viewport
// ---------------------------------------------------------------------------

/**
 * Widget geometry returned to the solver.
 * `checkboxOffset` is where the actual checkbox lives inside the widget frame.
 */
interface WidgetRect {
    type: CaptchaType;
    /** Top-left viewport X of the outer iframe/container */
    left: number;
    top: number;
    width: number;
    height: number;
    /** Approximate click target relative to left/top */
    checkboxX: number;
    checkboxY: number;
}

const FIND_WIDGET_SCRIPT = `(function() {
    function rect(el) {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    }
    // Cloudflare Turnstile
    let el = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (el) { const r = rect(el); return { ...r, type: 'turnstile',  checkboxX: 28, checkboxY: 28 }; }
    el = document.querySelector('.cf-turnstile iframe');
    if (el) { const r = rect(el); return { ...r, type: 'turnstile',  checkboxX: 28, checkboxY: 28 }; }

    // hCaptcha
    el = document.querySelector('iframe[src*="hcaptcha.com/captcha"]');
    if (!el) el = document.querySelector('.h-captcha iframe');
    if (el) { const r = rect(el); return { ...r, type: 'hcaptcha', checkboxX: 22, checkboxY: Math.round(r.height / 2) }; }

    // reCAPTCHA v2 checkbox iframe
    el = document.querySelector('iframe[title="reCAPTCHA"]');
    if (!el) el = document.querySelector('iframe[src*="recaptcha/api2/anchor"]');
    if (!el) el = document.querySelector('iframe[src*="google.com/recaptcha"][src*="anchor"]');
    if (el) { const r = rect(el); return { ...r, type: 'recaptcha_v2', checkboxX: 28, checkboxY: Math.round(r.height / 2) }; }

    // Generic: any [data-sitekey] container
    el = document.querySelector('[data-sitekey]');
    if (el) { const r = rect(el); return { ...r, type: 'unknown', checkboxX: Math.round(r.width / 2), checkboxY: Math.round(r.height / 2) }; }

    return null;
})()`;

/** Returns true if any captcha widget is still present after solving attempt */
const STILL_PRESENT_SCRIPT = `(function() {
    const sel = [
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="hcaptcha.com/captcha"]',
        'iframe[title="reCAPTCHA"]',
        'iframe[src*="recaptcha/api2/anchor"]',
        '.cf-turnstile,.h-captcha,.g-recaptcha',
    ];
    return sel.some(s => {
        const el = document.querySelector(s);
        if (!el) return false;
        // Consider "gone" if element exists but has zero dimensions (hidden after solve)
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    });
})()`;

// ---------------------------------------------------------------------------
// Human solver — primary strategy
// ---------------------------------------------------------------------------

export async function humanSolveCaptcha(
    evaluate: (script: string) => Promise<any>,
    sendCommand: (method: string, params: any) => Promise<any>,
    currentMouse: Point = { x: rngInt(200, 400), y: rngInt(200, 400) },
    opts: SolverOptions = {}
): Promise<SolveResult> {
    const widget: WidgetRect | null = await evaluate(FIND_WIDGET_SCRIPT).catch(() => null);
    if (!widget) return { success: false, error: "No clickable captcha widget found in viewport." };

    // Build the exact click target from widget geometry
    const target: Point = {
        x: widget.left + widget.checkboxX,
        y: widget.top  + widget.checkboxY,
    };

    // 1. Natural mouse arc from current position → just outside the widget → checkbox
    const approachX = target.x + rng(-40, 40);
    const approachY = target.y + rng(-60, -30);
    await humanMouseMove(currentMouse, { x: approachX, y: approachY }, sendCommand);
    await sleep(rng(60, 150)); // micro-pause before committing to click
    await humanMouseMove({ x: approachX, y: approachY }, target, sendCommand);

    // 2. Click
    await humanClick(target, sendCommand);

    // 3. Wait for the widget to process
    const waitMs = opts.waitAfterClick ?? 8_000;
    const checkInterval = 800;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        await sleep(checkInterval);
        const stillPresent = await evaluate(STILL_PRESENT_SCRIPT).catch(() => true);
        if (!stillPresent) {
            return { success: true, type: widget.type as CaptchaType, method: "human" };
        }
        // Move mouse slightly while waiting (humans don't freeze)
        await humanMouseMove(target, { x: target.x + rng(-15, 15), y: target.y + rng(-15, 15) }, sendCommand);
    }

    return {
        success: false,
        type: widget.type as CaptchaType,
        method: "human",
        error: "Captcha widget still present after click — may need image challenge or service fallback.",
    };
}

// ---------------------------------------------------------------------------
// Third-party service fallback (opt-in via useService: true)
// ---------------------------------------------------------------------------

import https from "https";

function httpsPost(url: string, body: string, ct = "application/json"): Promise<string> {
    return new Promise((res, rej) => {
        const u = new URL(url);
        const req = https.request(
            { hostname: u.hostname, path: u.pathname + u.search, method: "POST",
              headers: { "Content-Type": ct, "Content-Length": Buffer.byteLength(body) } },
            (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => res(d)); }
        );
        req.on("error", rej); req.write(body); req.end();
    });
}
function httpsGet(url: string): Promise<string> {
    return new Promise((res, rej) => {
        https.get(url, (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => res(d)); }).on("error", rej);
    });
}

const EXTRACT_SCRIPT = `(function(){
    const checks=[
        ()=>{const e=document.querySelector('iframe[src*="challenges.cloudflare.com"],.cf-turnstile [data-sitekey],.cf-turnstile');if(e){const sk=e.getAttribute('data-sitekey')||(e.src&&new URLSearchParams(e.src.split('?')[1]||'').get('sitekey'));if(sk)return{type:'turnstile',sitekey:sk};}},
        ()=>{const e=document.querySelector('iframe[src*="hcaptcha"],.h-captcha[data-sitekey]');if(e){const sk=e.getAttribute('data-sitekey')||(e.src&&new URLSearchParams(e.src.split('?')[1]||'').get('sitekey'));if(sk)return{type:'hcaptcha',sitekey:sk};}},
        ()=>{const s=document.querySelector('script[src*="recaptcha/api.js"]');if(s){const r=new URLSearchParams((s.src||'').split('?')[1]||'').get('render');if(r&&r!=='explicit')return{type:'recaptcha_v3',sitekey:r};}},
        ()=>{const e=document.querySelector('.g-recaptcha,[data-sitekey],iframe[src*="recaptcha"]');if(e){const sk=e.getAttribute('data-sitekey')||(e.src&&(e.src.match(/[?&]k=([^&]+)/)||[])[1]);if(sk)return{type:'recaptcha_v2',sitekey:sk};}},
    ];
    for(const c of checks){try{const r=c();if(r?.sitekey)return r;}catch(e){}}
    return null;
})()`;

async function serviceSolve(info: CaptchaInfo, opts: SolverOptions): Promise<string> {
    const svc    = opts.service  ?? (process.env.CAPTCHA_SERVICE as any) ?? "2captcha";
    const apiKey = opts.apiKey   ?? process.env.CAPTCHA_API_KEY ?? "";
    const timeout    = opts.timeout      ?? 120_000;
    const pollInt    = opts.pollInterval ?? 5_000;
    if (!apiKey) throw new Error("CAPTCHA_API_KEY env var not set. Set it or use human mode (default).");

    if (svc === "capsolver") {
        const typeMap: Record<string, string> = {
            recaptcha_v2: "ReCaptchaV2TaskProxyLess", recaptcha_v3: "ReCaptchaV3TaskProxyLess",
            hcaptcha: "HCaptchaTaskProxyLess", turnstile: "AntiTurnstileTaskProxyLess",
        };
        const task: any = { type: typeMap[info.type] || "ReCaptchaV2TaskProxyLess", websiteURL: info.pageUrl, websiteKey: info.sitekey };
        if (info.type === "recaptcha_v3") task.pageAction = info.action || "verify";
        const sub = JSON.parse(await httpsPost("https://api.capsolver.com/createTask", JSON.stringify({ clientKey: apiKey, task })));
        if (sub.errorId) throw new Error(`CapSolver: ${sub.errorDescription}`);
        const tid = String(sub.taskId);
        const dl = Date.now() + timeout;
        while (Date.now() < dl) {
            await sleep(pollInt);
            const r = JSON.parse(await httpsPost("https://api.capsolver.com/getTaskResult", JSON.stringify({ clientKey: apiKey, taskId: tid })));
            if (r.errorId) throw new Error(`CapSolver: ${r.errorDescription}`);
            if (r.status === "ready") return String(r.solution?.gRecaptchaResponse || r.solution?.token || "");
        }
    } else {
        // 2captcha
        const methodMap: Record<string, string> = { recaptcha_v2: "userrecaptcha", recaptcha_v3: "userrecaptcha", hcaptcha: "hcaptcha", turnstile: "turnstile" };
        const params: Record<string, string> = { key: apiKey, pageurl: info.pageUrl, json: "1", method: methodMap[info.type] || "userrecaptcha" };
        if (info.type === "recaptcha_v2" || info.type === "recaptcha_v3") params.googlekey = info.sitekey;
        else params.sitekey = info.sitekey;
        if (info.type === "recaptcha_v3") { params.version = "v3"; params.action = info.action || "verify"; params.min_score = "0.3"; }
        const sub = JSON.parse(await httpsPost("https://2captcha.com/in.php", new URLSearchParams(params).toString(), "application/x-www-form-urlencoded"));
        if (sub.status !== 1) throw new Error(`2captcha: ${sub.request}`);
        const tid = String(sub.request);
        const dl = Date.now() + timeout;
        while (Date.now() < dl) {
            await sleep(pollInt);
            const r = JSON.parse(await httpsGet(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${tid}&json=1`));
            if (r.status === 1) return String(r.request);
            if (r.request !== "CAPCHA_NOT_READY") throw new Error(`2captcha: ${r.request}`);
        }
    }
    throw new Error("Service timed out waiting for captcha solution.");
}

function buildInjectScript(type: CaptchaType, token: string): string {
    const t = JSON.stringify(token);
    if (type === "recaptcha_v2" || type === "recaptcha_v3") return `(function(tk){
        document.querySelectorAll('textarea[name="g-recaptcha-response"],#g-recaptcha-response').forEach(e=>{e.value=tk;e.innerHTML=tk;});
        const cfg=window.___grecaptcha_cfg;
        if(cfg?.clients)Object.values(cfg.clients).forEach(c=>{(function w(o,d){if(d>6||!o||typeof o!=='object')return;Object.values(o).forEach(v=>{if(typeof v==='function'){try{v(tk);}catch(e){}}else w(v,d+1);});})(c,0);});
    })(${t})`;
    if (type === "hcaptcha") return `(function(tk){
        document.querySelectorAll('[name="h-captcha-response"]').forEach(e=>{e.value=tk;});
        document.querySelectorAll('.h-captcha,[data-hcaptcha-sitekey]').forEach(w=>{const cb=w.getAttribute('data-callback');if(cb&&typeof window[cb]==='function')try{window[cb](tk);}catch(e){}});
    })(${t})`;
    if (type === "turnstile") return `(function(tk){
        document.querySelectorAll('[name="cf-turnstile-response"]').forEach(e=>{e.value=tk;});
        document.querySelectorAll('.cf-turnstile').forEach(w=>{const cb=w.getAttribute('data-callback');if(cb&&typeof window[cb]==='function')try{window[cb](tk);}catch(e){}});
    })(${t})`;
    return `(function(tk){['g-recaptcha-response','h-captcha-response','cf-turnstile-response'].forEach(n=>{document.querySelectorAll('[name="'+n+'"]').forEach(e=>{e.value=tk;});});})(${t})`;
}

// ---------------------------------------------------------------------------
// Main entry point used by cdp-bridge
// ---------------------------------------------------------------------------

export async function detectAndSolve(
    evaluate: (script: string) => Promise<any>,
    sendCommand: (method: string, params: any) => Promise<any>,
    pageUrl: string,
    currentMouse: Point,
    opts: SolverOptions = {}
): Promise<SolveResult> {
    // Default: human simulation — no API key required
    if (!opts.useService) {
        return humanSolveCaptcha(evaluate, sendCommand, currentMouse, opts);
    }

    // Explicit service mode
    const raw = await evaluate(EXTRACT_SCRIPT).catch(() => null);
    if (!raw?.sitekey) return { success: false, error: "No solvable captcha found for service mode." };
    const info: CaptchaInfo = { type: raw.type as CaptchaType, sitekey: raw.sitekey, pageUrl, action: raw.action };
    try {
        const token = await serviceSolve(info, opts);
        await evaluate(buildInjectScript(info.type, token)).catch(() => {});
        return { success: true, type: info.type, method: "service", token };
    } catch (err: any) {
        return { success: false, type: info.type, method: "service", error: err.message };
    }
}
