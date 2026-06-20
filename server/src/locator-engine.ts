import { CdpClient } from "./cdp-client";

export interface LocatorCandidate {
    ref: string;
    selector: string;
    xpath: string;
    scope: "document" | "shadow" | "frame";
    framePath: number[];
    shadowDepth: number;
    tag: string;
    role: string;
    type: string;
    name: string;
    text: string;
    label: string;
    placeholder: string;
    title: string;
    value: string;
    score: number;
    matchedBy: string;
    bounds: { x: number; y: number; width: number; height: number };
}

export interface LocatorQuery {
    target?: string;
    text?: string;
    role?: string;
    selector?: string;
    timeout?: number;
    visible?: boolean;
    includeCandidates?: boolean;
    maxCandidates?: number;
}

export interface LocatorResult {
    success: boolean;
    target?: string;
    selector?: string;
    ref?: string;
    matchedBy?: string;
    confidence?: number;
    candidate?: LocatorCandidate;
    candidates?: LocatorCandidate[];
    message?: string;
}

const DEFAULT_TIMEOUT = 7000;

export class LocatorEngine {
    constructor(private readonly client: CdpClient) {}

    async list(maxElements: number = 50, includeText: boolean = true, withOverlay: boolean = false): Promise<LocatorCandidate[]> {
        const capped = Math.max(0, Math.min(Number(maxElements || 50), 200));
        const result = await this.client.evaluate(
            `window.__aetherLocate(${JSON.stringify(JSON.stringify({
                target: "", role: "", selector: "",
                maxCandidates: capped, includeText, mode: "list",
            }))})`
        );
        const parsed = safeJsonParse(result);
        const candidates = normalizeCandidates(parsed?.candidates).slice(0, capped);
        if (withOverlay && candidates.length > 0) {
            await this.client.getInteractiveElements(true).catch(() => ({ elements: [], somInjected: false }));
        }
        return candidates;
    }

    async resolve(query: LocatorQuery): Promise<LocatorResult> {
        const target = String(query.target ?? query.text ?? "").trim();
        const role = query.role ? String(query.role).toLowerCase() : "";
        const selector = query.selector ? String(query.selector).trim() : "";
        const timeout = query.timeout ?? DEFAULT_TIMEOUT;
        const maxCandidates = Math.max(1, Math.min(Number(query.maxCandidates ?? 20), 50));
        const started = Date.now();

        if (!target && !role && !selector) {
            return { success: false, message: "target, role, or selector required" };
        }

        while (Date.now() - started < timeout) {
            const resultJson = await this.client.evaluate(
                `window.__aetherLocate(${JSON.stringify(JSON.stringify({
                    target, role, selector: selector,
                    maxCandidates, includeText: true, mode: "resolve",
                }))})`
            ).catch((error: any) => ({ error: error.message }));
            const result = safeJsonParse(resultJson);

            const candidates = normalizeCandidates(result?.candidates);
            const best = candidates[0];
            if (best && (selector || best.score > 0 || role)) {
                return {
                    success: true,
                    target,
                    selector: best.selector,
                    ref: best.ref,
                    matchedBy: best.matchedBy,
                    confidence: Math.min(1, Math.max(0.1, best.score / 18)),
                    candidate: best,
                    candidates: query.includeCandidates ? candidates.slice(0, maxCandidates) : undefined,
                };
            }

            await sleep(150);
        }

        return { success: false, target, message: "No matching visible element found" };
    }

    async click(candidate: LocatorCandidate, button?: "left" | "middle" | "right"): Promise<void> {
        const x = candidate.bounds.x + candidate.bounds.width / 2;
        const y = candidate.bounds.y + candidate.bounds.height / 2;
        await this.client.click(x, y, button, candidate.bounds.width);
    }

    async focusAndClear(candidate: LocatorCandidate): Promise<boolean> {
        await this.click(candidate);
        await this.client.pressKey("a", ["Ctrl"]).catch(() => {});
        await this.client.pressKey("Backspace").catch(() => {});
        return true;
    }
}

function normalizeCandidates(value: unknown): LocatorCandidate[] {
    if (!Array.isArray(value)) return [];
    return value.filter(Boolean) as LocatorCandidate[];
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(value: unknown): any {
    if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return null; }
    }
    return value;
}
