/**
 * Session, auth, and browser management functions extracted from cdp-bridge.ts.
 *
 * Each function takes a CdpClient (and optional dependencies like PageSnapshotCache)
 * and returns a result. This module is designed to be consumed by the bridge layer
 * and can also be used directly by other parts of the server.
 */

import { CdpClient } from "../cdp-client";
import { Logger } from "../logger";
import { EXPORT_STORAGE_SCRIPT } from "../eval-scripts";
import * as fs from "fs/promises";
import * as path from "path";
import { PageSnapshotCache } from "../page-snapshot-cache";

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Resolve the default path for the auth-state JSON file.
 * Defaults to <cwd>/.aether/auth-state.json unless a custom path is provided.
 */
export function defaultAuthStatePath(custom?: string): string {
    if (custom) return path.resolve(String(custom));
    return path.resolve(process.cwd(), ".aether", "auth-state.json");
}

/**
 * Strip read-only fields from CDP Cookie objects so they can be passed
 * to Network.setCookies as CookieParam objects.
 *
 * CDP Network.getAllCookies returns Cookie objects with extra fields
 * (size, session, etc.) that Network.setCookies rejects.
 * Keep only the writable CookieParam fields.
 */
export function toCookieParam(c: any): any {
    const param: any = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
    };
    if (typeof c.expires === "number" && c.expires > 0) param.expires = c.expires;
    if (c.sameSite) param.sameSite = c.sameSite;
    if (c.priority) param.priority = c.priority;
    if (c.sourceScheme) param.sourceScheme = c.sourceScheme;
    if (typeof c.sourcePort === "number") param.sourcePort = c.sourcePort;
    if (c.partitionKey) param.partitionKey = c.partitionKey;
    return param;
}

// ─── Auth State Persistence ────────────────────────────────────────────

export interface SaveAuthStateParams {
    /** Custom path for the auth state file (overrides default). */
    path?: string;
}

export interface SaveAuthStateResult {
    success: boolean;
    path: string;
    cookies: number;
    origins: number;
    storageKeys: number;
}

/**
 * Export the current session (cookies + localStorage + sessionStorage of the
 * active origin) to a JSON file so a logged-in state can be reused later.
 */
export async function saveAuthState(
    client: CdpClient,
    params: SaveAuthStateParams,
    snapshotCache: PageSnapshotCache,
): Promise<SaveAuthStateResult> {
    const filePath = defaultAuthStatePath(params.path);

    // Collect cookies (try Network API first, fall back to Storage API)
    const cookiesRes = await client
        .sendCommand("Network.getAllCookies", {})
        .catch(() =>
            client.sendCommand("Storage.getCookies", {}).catch(() => ({ cookies: [] })),
        );
    const cookies = (cookiesRes?.cookies || []).map((c: any) => toCookieParam(c));

    // Collect localStorage and sessionStorage for the active origin
    const storage = await client.evaluate(EXPORT_STORAGE_SCRIPT).catch(() => null);

    const state = {
        version: 1,
        savedAt: new Date().toISOString(),
        cookies,
        origins: storage ? [storage] : [],
    };

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");

    return {
        success: true,
        path: filePath,
        cookies: cookies.length,
        origins: state.origins.length,
        storageKeys: storage
            ? Object.keys(storage.localStorage).length +
              Object.keys(storage.sessionStorage).length
            : 0,
    };
}

// ─── Auth State Restoration ────────────────────────────────────────────

export interface LoadAuthStateParams {
    /** Custom path for the auth state file (overrides default). */
    path?: string;
    /** Whether to reload the page after restoring state. Defaults to true. */
    reload?: boolean;
}

export interface LoadAuthStateResult {
    success: boolean;
    path: string;
    message?: string;
    cookiesSet?: number;
    storageRestored?: number;
    storageSkipped?: number;
    note?: string;
}

/**
 * Restore a session saved by saveAuthState. Cookies are set globally; storage
 * is restored for the active origin (navigate to the site first), then the tab
 * is reloaded so the session takes effect.
 */
export async function loadAuthState(
    client: CdpClient,
    params: LoadAuthStateParams,
    snapshotCache: PageSnapshotCache,
): Promise<LoadAuthStateResult> {
    const filePath = defaultAuthStatePath(params.path);

    let raw: string;
    try {
        raw = await fs.readFile(filePath, "utf8");
    } catch (e: any) {
        return {
            success: false,
            path: filePath,
            message: `Could not read auth state: ${e?.message}`,
        };
    }

    let state: any;
    try {
        state = JSON.parse(raw);
    } catch (e: any) {
        return {
            success: false,
            path: filePath,
            message: `Invalid auth state JSON: ${e?.message}`,
        };
    }

    let cookiesSet = 0;
    if (Array.isArray(state.cookies) && state.cookies.length) {
        const cookieParams = state.cookies.map((c: any) => toCookieParam(c));
        await client.setCookies(cookieParams).catch((err: any) => {
            console.error(
                "[Aether] setCookies failed during loadAuthState:",
                err?.message,
            );
        });
        cookiesSet = cookieParams.length;
    }

    let storageRestored = 0;
    let storageSkipped = 0;
    const currentOrigin = await client
        .evaluate("location.origin")
        .catch(() => "");
    for (const entry of state.origins || []) {
        if (entry.origin && currentOrigin && entry.origin !== currentOrigin) {
            storageSkipped++;
            continue;
        }
        const data = JSON.stringify({
            localStorage: entry.localStorage || {},
            sessionStorage: entry.sessionStorage || {},
        });
        const ok = await client
            .evaluate(
                `
                (function() {
                    try {
                        const data = ${data};
                        for (const k in data.localStorage) localStorage.setItem(k, data.localStorage[k]);
                        for (const k in data.sessionStorage) sessionStorage.setItem(k, data.sessionStorage[k]);
                        return true;
                    } catch (e) { return false; }
                })()
            `,
            )
            .catch(() => false);
        if (ok) storageRestored++;
    }

    if (params.reload !== false) {
        await client.reload(false).catch(() => {});
    }
    snapshotCache.invalidate("load_auth_state");

    return {
        success: true,
        path: filePath,
        cookiesSet,
        storageRestored,
        storageSkipped,
        note:
            storageSkipped > 0
                ? "Some storage origins were skipped; navigate to that origin before loading to restore them."
                : undefined,
    };
}

// ─── Browser Lifecycle ─────────────────────────────────────────────────

export interface LaunchBrowserOptions {
    browser?: "chrome" | "edge" | "brave" | "firefox";
    headless?: boolean;
    port?: number;
    profile?: string;
    profileDirectory?: string;
    userDataDir?: string;
}

/**
 * Launch a new browser instance using automatic detection.
 * If no browser is specified, the client will auto-detect available browsers.
 */
export async function launchBrowser(
    client: CdpClient,
    options?: LaunchBrowserOptions,
): Promise<string> {
    await client.launchAuto({
        browser: options?.browser,
        headless: options?.headless,
        port: options?.port,
        profile: options?.profile,
        profileDirectory: options?.profileDirectory,
        userDataDir: options?.userDataDir,
    });
    const profileLabel = options?.profile || options?.profileDirectory;
    return profileLabel
        ? `Browser launched successfully with profile "${profileLabel}"`
        : "Browser launched successfully";
}

/**
 * Kill the currently managed browser process.
 */
export async function killBrowser(client: CdpClient): Promise<string> {
    await client.killBrowser();
    return "Browser killed";
}

/**
 * List all available (installed) browsers on the system.
 */
export async function listBrowsers(client: CdpClient): Promise<any> {
    return await client.listAvailableBrowsers();
}

/**
 * List browser profiles for a given browser (defaults to Brave).
 */
export async function listBrowserProfiles(
    client: CdpClient,
    browser?: "chrome" | "edge" | "brave",
): Promise<any> {
    return await client.listBrowserProfiles(browser || "brave");
}

// ─── Cookie & Cache Management ─────────────────────────────────────────

/**
 * Get all cookies for the current page URL.
 */
export async function getCookies(client: CdpClient): Promise<any[]> {
    const result = await client.sendCommand("Network.getCookies", {
        urls: [
            (await client.evaluate("window.location.href").catch(() => "*")) ||
            "*",
        ],
    });
    return result.cookies || [];
}

export interface SetCookieParams {
    cookieName?: string;
    name?: string;
    cookieValue?: string;
    value?: string;
    url?: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
}

/**
 * Set a single cookie on the current page.
 */
export async function setCookie(
    client: CdpClient,
    params: SetCookieParams,
): Promise<string> {
    const cookies = [
        {
            name: params.cookieName || params.name,
            value: params.cookieValue || params.value,
            url:
                params.url ||
                (await client.evaluate("window.location.href").catch(() => undefined)),
            domain: params.domain,
            path: params.path || "/",
            secure: params.secure || false,
            httpOnly: params.httpOnly || false,
        },
    ];

    await client.sendCommand("Network.setCookies", { cookies });
    return "Cookie set";
}

/**
 * Clear the browser cache and all cookies.
 */
export async function clearCache(client: CdpClient): Promise<string> {
    await client.sendCommand("Network.clearBrowserCache", {});
    await client.sendCommand("Network.clearBrowserCookies", {});
    return "Cache cleared";
}
