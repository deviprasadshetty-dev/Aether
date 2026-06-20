import { CdpClient } from "./cdp-client";
import { LocatorCandidate, LocatorEngine } from "./locator-engine";

export interface CompactSnapshot {
    title: string;
    url: string;
    readyState: string;
    elementCount: number;
    elements: LocatorCandidate[];
    cache: {
        hit: boolean;
        version: number;
        ageMs: number;
    };
}

interface CachedSnapshot {
    version: number;
    createdAt: number;
    hasElements: boolean;
    title: string;
    url: string;
    readyState: string;
    elements: LocatorCandidate[];
}

const CACHE_TTL_MS = 5000; // 5s — safe because cache auto-invalidates on DOM mutations

export class PageSnapshotCache {
    private version = 0;
    private cached: CachedSnapshot | null = null;
    private lastUrl = "";

    constructor(
        private readonly client: CdpClient,
        private readonly locator: LocatorEngine
    ) {
        this.installInvalidationHooks();
    }

    invalidate(reason: string = "manual"): void {
        this.version++;
        this.cached = null;
    }

    /** Returns true if the cache is fresh enough to serve. */
    isFresh(): boolean {
        const c = this.cached;
        return !!(c && c.version === this.version && (Date.now() - c.createdAt) <= CACHE_TTL_MS);
    }

    /** Get cache metadata for debugging. */
    getCacheInfo(): { version: number; ageMs: number; fresh: boolean; url: string } {
        const c = this.cached;
        return {
            version: this.version,
            ageMs: c ? Date.now() - c.createdAt : Infinity,
            fresh: this.isFresh(),
            url: c?.url ?? "",
        };
    }

    async compact(params: { maxElements?: number; includeText?: boolean; withOverlay?: boolean } = {}): Promise<CompactSnapshot> {
        const maxElements = Math.max(0, Math.min(Number(params.maxElements ?? 30), 200));
        const now = Date.now();
        const cached = this.cached;

        if (cached && cached.version === this.version && now - cached.createdAt <= CACHE_TTL_MS && (maxElements === 0 || cached.hasElements)) {
            return {
                title: cached.title,
                url: cached.url,
                readyState: cached.readyState,
                elementCount: cached.elements.length,
                elements: cached.elements.slice(0, maxElements),
                cache: { hit: true, version: cached.version, ageMs: now - cached.createdAt },
            };
        }

        const [facts, elements] = await Promise.all([
            this.client.evaluate(`({
                title: document.title || "Unknown",
                url: window.location.href || "Unknown",
                readyState: document.readyState || "unknown"
            })`).catch(() => ({ title: "Unknown", url: "Unknown", readyState: "unknown" })),
            maxElements === 0
                ? Promise.resolve([])
                : this.locator.list(200, params.includeText !== false, !!params.withOverlay).catch(() => []),
        ]);

        this.cached = {
            version: this.version,
            createdAt: Date.now(),
            hasElements: maxElements > 0,
            title: String(facts?.title ?? "Unknown"),
            url: String(facts?.url ?? "Unknown"),
            readyState: String(facts?.readyState ?? "unknown"),
            elements,
        };

        return {
            title: this.cached.title,
            url: this.cached.url,
            readyState: this.cached.readyState,
            elementCount: elements.length,
            elements: elements.slice(0, maxElements),
            cache: { hit: false, version: this.cached.version, ageMs: 0 },
        };
    }

    private installInvalidationHooks(): void {
        const events = [
            "DOM.documentUpdated",
            "Page.frameNavigated",
            "Page.loadEventFired",
            "Runtime.executionContextDestroyed",
            "Runtime.executionContextsCleared",
        ];
        for (const event of events) {
            this.client.on(event, () => this.invalidate(event));
        }
    }
}
