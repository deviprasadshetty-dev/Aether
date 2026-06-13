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
        const result = await this.client.evaluate(locatorScript({
            target: "",
            role: "",
            selector: "",
            maxCandidates: capped,
            includeText,
            mode: "list",
        }));

        const candidates = normalizeCandidates(result?.candidates).slice(0, capped);
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
            const result = await this.client.evaluate(locatorScript({
                target,
                role,
                selector,
                maxCandidates,
                includeText: true,
                mode: "resolve",
            })).catch((error: any) => ({ error: error.message }));

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

function locatorScript(input: {
    target: string;
    role: string;
    selector: string;
    maxCandidates: number;
    includeText: boolean;
    mode: "list" | "resolve";
}): string {
    return `
        (function() {
            const target = ${JSON.stringify(input.target)};
            const targetLower = target.toLowerCase();
            const roleHint = ${JSON.stringify(input.role)};
            const selectorHint = ${JSON.stringify(input.selector)};
            const maxCandidates = ${JSON.stringify(input.maxCandidates)};
            const includeText = ${JSON.stringify(input.includeText)};
            const mode = ${JSON.stringify(input.mode)};
            const interactiveSelector = [
                'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
                '[onclick]', '[role]', '[tabindex]:not([tabindex="-1"])', 'label', 'summary',
                '[contenteditable="true"]', '[aria-label]', '[placeholder]'
            ].join(', ');

            function norm(value) {
                return String(value || '').trim().replace(/\\s+/g, ' ');
            }

            function visible(el) {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    style.opacity !== '0' &&
                    rect.width > 0 &&
                    rect.height > 0;
            }

            function cssPath(el) {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
                if (el.id) return '#' + CSS.escape(el.id);
                const path = [];
                let node = el;
                while (node && node.nodeType === Node.ELEMENT_NODE && node !== node.ownerDocument.body) {
                    let part = node.nodeName.toLowerCase();
                    if (node.classList && node.classList.length) {
                        part += '.' + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join('.');
                    }
                    const parent = node.parentElement;
                    if (parent) {
                        const same = Array.from(parent.children).filter((child) => child.nodeName === node.nodeName);
                        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
                    }
                    path.unshift(part);
                    node = parent;
                }
                return path.join(' > ');
            }

            function xpath(el) {
                const parts = [];
                let node = el;
                while (node && node.nodeType === Node.ELEMENT_NODE) {
                    let index = 1;
                    let sibling = node.previousElementSibling;
                    while (sibling) {
                        if (sibling.nodeName === node.nodeName) index++;
                        sibling = sibling.previousElementSibling;
                    }
                    parts.unshift(node.nodeName.toLowerCase() + '[' + index + ']');
                    node = node.parentElement;
                }
                return '/' + parts.join('/');
            }

            function inferRole(el) {
                const explicit = (el.getAttribute('role') || '').toLowerCase();
                if (explicit) return explicit;
                const tag = el.tagName.toLowerCase();
                const type = (el.getAttribute('type') || '').toLowerCase();
                if (tag === 'button' || type === 'button' || type === 'submit' || type === 'reset') return 'button';
                if (tag === 'a') return 'link';
                if (tag === 'textarea') return 'textbox';
                if (tag === 'select') return 'combobox';
                if (tag === 'input' && ['checkbox', 'radio'].includes(type)) return type;
                if (tag === 'input') return 'textbox';
                if (el.isContentEditable) return 'textbox';
                if (tag === 'summary') return 'button';
                return tag;
            }

            function byId(doc, id) {
                if (!id) return '';
                const el = doc.getElementById(id);
                return el ? norm(el.innerText || el.textContent) : '';
            }

            function labelFor(el) {
                const doc = el.ownerDocument;
                const labelledBy = norm((el.getAttribute('aria-labelledby') || '').split(/\\s+/).map((id) => byId(doc, id)).join(' '));
                if (labelledBy) return labelledBy;
                if (el.id) {
                    const direct = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                    if (direct) return norm(direct.innerText || direct.textContent);
                }
                const wrapping = el.closest && el.closest('label');
                return wrapping ? norm(wrapping.innerText || wrapping.textContent) : '';
            }

            function textFor(el) {
                return norm(
                    el.getAttribute('aria-label') ||
                    labelFor(el) ||
                    el.getAttribute('placeholder') ||
                    el.getAttribute('alt') ||
                    el.getAttribute('title') ||
                    el.innerText ||
                    el.textContent ||
                    el.getAttribute('value') ||
                    el.getAttribute('name') ||
                    ''
                );
            }

            function scoreField(field, value, exact, includes) {
                const text = norm(value);
                const lower = text.toLowerCase();
                if (!targetLower) return { score: 0, by: '' };
                if (lower === targetLower) return { score: exact, by: field + ':exact' };
                if (lower.includes(targetLower)) return { score: includes, by: field + ':contains' };
                if (targetLower.includes(lower) && lower.length >= 3) return { score: Math.max(1, includes - 1), by: field + ':contained_by_target' };
                return { score: 0, by: '' };
            }

            function scoreCandidate(item) {
                let score = 0;
                let matchedBy = '';
                const fields = [
                    ['selector', item.selector, 13, 10],
                    ['xpath', item.xpath, 11, 8],
                    ['name', item.name, 12, 10],
                    ['label', item.label, 12, 10],
                    ['placeholder', item.placeholder, 11, 9],
                    ['text', item.text, 10, 8],
                    ['title', item.title, 8, 6],
                    ['value', item.value, 7, 5]
                ];
                for (const field of fields) {
                    const match = scoreField(field[0], field[1], field[2], field[3]);
                    if (match.score > score) {
                        score = match.score;
                        matchedBy = match.by;
                    }
                }
                if (roleHint) {
                    if (item.role === roleHint) score += 5;
                    else if (roleHint === 'textbox' && ['input', 'textarea'].includes(item.tag)) score += 3;
                    else score -= 3;
                }
                if (!targetLower && roleHint && item.role === roleHint) {
                    matchedBy = 'role';
                    score = Math.max(score, 5);
                }
                if (item.scope !== 'document') score += 1;
                item.score = score;
                item.matchedBy = matchedBy || (selectorHint ? 'selector' : '');
                return item;
            }

            function collectFromRoot(root, framePath, frameOffset, shadowDepth, scope, out) {
                let nodes = [];
                try {
                    if (selectorHint) {
                        nodes = Array.from(root.querySelectorAll(selectorHint));
                    } else {
                        nodes = Array.from(root.querySelectorAll(interactiveSelector));
                    }
                } catch {
                    nodes = [];
                }

                for (const el of nodes) {
                    if (!visible(el)) continue;
                    const rect = el.getBoundingClientRect();
                    const selector = cssPath(el);
                    const role = inferRole(el);
                    const label = labelFor(el);
                    const item = {
                        ref: '',
                        selector,
                        xpath: xpath(el),
                        scope,
                        framePath: framePath.slice(),
                        shadowDepth,
                        tag: el.tagName.toLowerCase(),
                        role,
                        type: el.getAttribute('type') || '',
                        name: norm(el.getAttribute('aria-label') || label || textFor(el) || el.getAttribute('name')),
                        text: includeText ? norm(el.innerText || el.textContent).substring(0, 180) : '',
                        label,
                        placeholder: norm(el.getAttribute('placeholder')),
                        title: norm(el.getAttribute('title')),
                        value: norm(el.getAttribute('value')),
                        score: 0,
                        matchedBy: '',
                        bounds: {
                            x: Math.round(frameOffset.x + rect.left),
                            y: Math.round(frameOffset.y + rect.top),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height)
                        }
                    };
                    item.ref = item.scope === 'document' && item.framePath.length === 0 && item.shadowDepth === 0
                        ? 'css:' + item.selector
                        : 'point:' + Math.round(item.bounds.x + item.bounds.width / 2) + ',' + Math.round(item.bounds.y + item.bounds.height / 2);
                    out.push(scoreCandidate(item));
                }

                const all = [];
                try {
                    all.push(...Array.from(root.querySelectorAll('*')));
                } catch {}

                for (const el of all) {
                    if (el.shadowRoot) {
                        collectFromRoot(el.shadowRoot, framePath, frameOffset, shadowDepth + 1, 'shadow', out);
                    }
                    if (el.tagName && el.tagName.toLowerCase() === 'iframe') {
                        try {
                            const doc = el.contentDocument;
                            if (!doc) continue;
                            const rect = el.getBoundingClientRect();
                            collectFromRoot(doc, framePath.concat([Array.from(el.ownerDocument.querySelectorAll('iframe')).indexOf(el)]), {
                                x: frameOffset.x + rect.left,
                                y: frameOffset.y + rect.top
                            }, shadowDepth, 'frame', out);
                        } catch {}
                    }
                }
            }

            const candidates = [];
            collectFromRoot(document, [], { x: 0, y: 0 }, 0, 'document', candidates);
            candidates.sort((a, b) => {
                if (mode === 'list') return (a.bounds.y - b.bounds.y) || (a.bounds.x - b.bounds.x);
                return b.score - a.score || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x;
            });
            return { candidates: candidates.slice(0, maxCandidates) };
        })()
    `;
}
