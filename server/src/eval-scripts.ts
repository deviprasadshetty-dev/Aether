/**
 * Consolidated in-page JavaScript scripts.
 *
 * All Runtime.evaluate() scripts that were duplicated across cdp-bridge.ts,
 * cdp-client.ts, and locator-engine.ts now live here as single-source constants.
 *
 * Use these by injecting SHARED_DOM_HELPERS once via
 * Page.addScriptToEvaluateOnNewDocument, then calling individual action scripts
 * that reference the pre-injected helpers.
 */

// ─── Core DOM Helpers (injected once via Page.addScriptToEvaluateOnNewDocument) ──

export const SHARED_DOM_HELPERS = `
function aetherNorm(value) {
    return String(value == null ? '' : value).trim().replace(/\\s+/g, ' ');
}

function aetherVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0';
}

function aetherImplicitRole(el) {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
    if (explicit) return explicit.split(/\\s+/)[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    switch (tag) {
        case 'a': case 'area':
            return el.hasAttribute('href') ? 'link' : 'generic';
        case 'button': case 'summary': return 'button';
        case 'select':
            return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
        case 'textarea': return 'textbox';
        case 'progress': return 'progressbar';
        case 'input':
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
            if (type === 'range') return 'slider';
            if (type === 'search') return 'searchbox';
            return 'textbox';
        default: return 'generic';
    }
}

function aetherLabelFor(el) {
    if (!el) return '';
    if (el.id) {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label) return aetherNorm(label.innerText || label.textContent);
    }
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) return aetherNorm(wrappingLabel.innerText || wrappingLabel.textContent);
    const ariaLabelledby = el.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
        const ref = document.getElementById(ariaLabelledby.split(/\\s+/)[0]);
        if (ref) return aetherNorm(ref.innerText || ref.textContent);
    }
    return '';
}

function aetherAccessibleName(el) {
    if (!el) return '';
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return aetherNorm(ariaLabel);
    return aetherLabelFor(el) || aetherNorm(el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '');
}

function aetherStableSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const path = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body && node !== document.documentElement) {
        let seg = node.nodeName.toLowerCase();
        if (node.classList && node.classList.length) {
            seg += '.' + Array.from(node.classList).slice(0, 2).map(function(c) { return CSS.escape(c); }).join('.');
        }
        const parent = node.parentElement;
        if (parent) {
            const siblings = Array.from(parent.children).filter(function(c) { return c.nodeName === node.nodeName; });
            if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        path.unshift(seg);
        node = parent;
    }
    return path.length ? path.join(' > ') : node ? node.nodeName.toLowerCase() : '';
}

function aetherXpath(el) {
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
`;

// ─── Element Collection (for list_interactive_elements, snapshot_compact, get_state) ──

export function makeElementCollectionScript(params: {
    maxElements: number;
    includeText: boolean;
    withOverlay: boolean;
    mode: "list" | "resolve";
    target?: string;
    role?: string;
    selector?: string;
}): string {
    const target = JSON.stringify(params.target ?? "");
    const role = JSON.stringify((params.role ?? "").toLowerCase());
    const selector = JSON.stringify(params.selector ?? "");
    const max = params.maxElements;
    const includeText = params.includeText;
    const withOverlay = params.withOverlay;
    const mode = params.mode;

    return `
(function() {
    ${SHARED_DOM_HELPERS}
    const _target = ${target};
    const _targetLower = _target.toLowerCase();
    const _roleHint = ${role};
    const _selectorHint = ${selector};
    const _maxCandidates = ${max};
    const _mode = ${JSON.stringify(mode)};

    const INTERACTIVE = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
        '[onclick]', '[role]', '[tabindex]:not([tabindex="-1"])', 'label', 'summary',
        '[contenteditable="true"]', '[aria-label]', '[placeholder]'
    ].join(', ');

    function scoreField(field, value, exact, includes) {
        const text = aetherNorm(value);
        const lower = text.toLowerCase();
        if (!_targetLower) return { score: 0, by: '' };
        if (lower === _targetLower) return { score: exact, by: field + ':exact' };
        if (lower.includes(_targetLower)) return { score: includes, by: field + ':contains' };
        if (_targetLower.includes(lower) && lower.length >= 3) return { score: Math.max(1, includes - 1), by: field + ':contained_by_target' };
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
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            var match = scoreField(f[0], f[1], f[2], f[3]);
            if (match.score > score) {
                score = match.score;
                matchedBy = match.by;
            }
        }
        if (_roleHint) {
            if (item.role === _roleHint) score += 5;
            else if (_roleHint === 'textbox' && ['input', 'textarea'].indexOf(item.tag) >= 0) score += 3;
            else score -= 3;
        }
        if (!_targetLower && _roleHint && item.role === _roleHint) {
            matchedBy = 'role';
            score = Math.max(score, 5);
        }
        if (item.scope !== 'document') score += 1;
        item.score = score;
        item.matchedBy = matchedBy || (_selectorHint ? 'selector' : '');
        return item;
    }

    // Remove old Set-of-Marks overlays
    var oldContainer = document.getElementById('aether-som-container');
    if (oldContainer) oldContainer.remove();
    var oldMarkers = document.querySelectorAll('.aether-som-marker');
    for (var om = 0; om < oldMarkers.length; om++) oldMarkers[om].remove();

    var container = null;
    if (${withOverlay}) {
        container = document.createElement('div');
        container.id = 'aether-som-container';
        container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;';
        document.documentElement.appendChild(container);
    }

    function collectFromRoot(root, framePath, frameOffset, shadowDepth, scope, out) {
        var nodes = [];
        try {
            nodes = _selectorHint
                ? Array.from(root.querySelectorAll(_selectorHint))
                : Array.from(root.querySelectorAll(INTERACTIVE));
        } catch(e) { nodes = []; }

        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (!aetherVisible(el)) continue;
            var rect = el.getBoundingClientRect();
            var sel = aetherStableSelector(el);
            var roleVal = aetherImplicitRole(el);
            var label = aetherLabelFor(el);
            var item = {
                ref: '',
                selector: sel,
                xpath: aetherXpath(el),
                scope: scope,
                framePath: framePath.slice(),
                shadowDepth: shadowDepth,
                tag: el.tagName.toLowerCase(),
                role: roleVal,
                type: el.getAttribute('type') || '',
                name: aetherNorm(el.getAttribute('aria-label') || label || aetherAccessibleName(el) || el.getAttribute('name')),
                text: ${includeText} ? aetherNorm(el.innerText || el.textContent).substring(0, 180) : '',
                label: label,
                placeholder: aetherNorm(el.getAttribute('placeholder')),
                title: aetherNorm(el.getAttribute('title')),
                value: aetherNorm(el.getAttribute('value')),
                score: 0,
                matchedBy: '',
                bounds: {
                    x: Math.round(frameOffset.x + rect.left),
                    y: Math.round(frameOffset.y + rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                }
            };
            item.ref = (item.scope === 'document' && item.framePath.length === 0 && item.shadowDepth === 0)
                ? 'css:' + item.selector
                : 'point:' + Math.round(item.bounds.x + item.bounds.width / 2) + ',' + Math.round(item.bounds.y + item.bounds.height / 2);
            out.push(scoreCandidate(item));

            // SoM overlay marker
            if (container) {
                var id = String(out.length);
                var w = Math.max(20, id.length * 8 + 14);
                var marker = document.createElement('div');
                marker.className = 'aether-som-marker';
                marker.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="20" style="display:block">'
                    + '<rect width="' + w + '" height="20" rx="10" fill="#1e40af"/>'
                    + '<text x="' + (w / 2) + '" y="10" dominant-baseline="central" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" font-weight="700" fill="white">' + id + '</text>'
                    + '</svg>';
                marker.style.cssText = 'position:absolute;left:' + rect.left + 'px;top:' + rect.top + 'px;pointer-events:none;filter:drop-shadow(0 1px 4px rgba(0,0,0,0.35));transform:translate(-4px,-4px);';
                container.appendChild(marker);
            }
        }

        // Shadow DOM and iframe traversal
        var all = [];
        try { all = Array.from(root.querySelectorAll('*')); } catch(e) {}
        for (var si = 0; si < all.length; si++) {
            var cel = all[si];
            if (cel.shadowRoot) {
                collectFromRoot(cel.shadowRoot, framePath, frameOffset, shadowDepth + 1, 'shadow', out);
            }
            if (cel.tagName && cel.tagName.toLowerCase() === 'iframe') {
                try {
                    var doc = cel.contentDocument;
                    if (doc) {
                        var frect = cel.getBoundingClientRect();
                        collectFromRoot(doc, framePath.concat([Array.from(cel.ownerDocument.querySelectorAll('iframe')).indexOf(cel)]),
                            { x: frameOffset.x + frect.left, y: frameOffset.y + frect.top }, shadowDepth, 'frame', out);
                    }
                } catch(e) {}
            }
        }
    }

    var candidates = [];
    collectFromRoot(document, [], { x: 0, y: 0 }, 0, 'document', candidates);
    candidates.sort(function(a, b) {
        if (_mode === 'list') return (a.bounds.y - b.bounds.y) || (a.bounds.x - b.bounds.x);
        return b.score - a.score || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x;
    });
    return { candidates: candidates.slice(0, _maxCandidates), somInjected: !!container };
})()
`;
}

// ─── Actionability Gate ───────────────────────────────────────────────

export function makeActionabilityCheckScript(selector: string): string {
    return `
(function() {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not_found' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width === 0 || rect.height === 0) {
        return { ok: false, reason: 'not_visible' };
    }
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true' || style.pointerEvents === 'none') {
        return { ok: false, reason: 'disabled' };
    }
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) {
        return { ok: false, reason: 'offscreen' };
    }
    var top = document.elementFromPoint(cx, cy);
    var reachable = top === el || (top && el.contains(top)) || (top && top.contains(el));
    return {
        ok: !!reachable,
        reason: reachable ? 'ok' : 'obscured',
        obscuredBy: !reachable && top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') : '',
        x: cx,
        y: cy,
        w: rect.width,
        boxKey: Math.round(rect.left) + ',' + Math.round(rect.top) + ',' + Math.round(rect.width) + ',' + Math.round(rect.height)
    };
})()
`;
}

// ─── Click Element by ID (Set-of-Marks) ──────────────────────────────

export function makeClickByIdScript(elementId: string): string {
    return `
(function() {
    ${SHARED_DOM_HELPERS}
    var targetId = Number(${JSON.stringify(String(elementId).replace(/@/g, ''))});
    var elements = Array.from(document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [onclick], [role="button"], [role="link"], [role="checkbox"], [tabindex]:not([tabindex="-1"]), label, summary'))
        .filter(function(el) { return aetherVisible(el); });
    var el = elements[targetId - 1];
    if (el) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        var rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width };
    }
    return null;
})()
`;
}

// ─── Action Facts (before/after snapshots) ────────────────────────────

export function makeActionFactsScript(selector?: string): string {
    return `
(function() {
    var sel = ${JSON.stringify(selector || "")};
    var active = document.activeElement;
    var target = sel ? document.querySelector(sel) : active;
    var visibleErrors = Array.from(document.querySelectorAll('[role="alert"], .error, .errors, [aria-invalid="true"]'))
        .filter(function(el) {
            var rect = el.getBoundingClientRect();
            var style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        })
        .map(function(el) { return String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' '); })
        .filter(Boolean)
        .slice(0, 5);

    function describe(el) {
        if (!el) return null;
        return {
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            name: el.getAttribute('name') || '',
            role: el.getAttribute('role') || '',
            type: el.getAttribute('type') || '',
            value: 'value' in el ? String(el.value || '') : '',
            checked: 'checked' in el ? !!el.checked : undefined,
            selectedIndex: 'selectedIndex' in el ? el.selectedIndex : undefined,
            text: String(el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 160)
        };
    }

    return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        focused: describe(active),
        target: describe(target),
        visibleErrors: visibleErrors
    };
})()
`;
}

// ─── Wait for Selector (compact boolean check) ────────────────────────

export function makeWaitForSelectorScript(selector: string, requireVisible: boolean): string {
    return `
(function() {
    ${SHARED_DOM_HELPERS}
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    if (${requireVisible} && !aetherVisible(el)) return { found: true, visible: false };
    var rect = el.getBoundingClientRect();
    return {
        found: true,
        visible: aetherVisible(el),
        box: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
})()
`;
}

// ─── Focus and Clear Input ────────────────────────────────────────────

export function makeFocusAndClearScript(selector: string): string {
    return `
(function() {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    if ('value' in el) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
})()
`;
}

// ─── Get Element Center Coordinates ───────────────────────────────────

export function makeGetElementCenterScript(selector: string): string {
    return `
(function() {
    ${SHARED_DOM_HELPERS}
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el || !aetherVisible(el)) return false;
    var rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width };
})()
`;
}

// ─── CAPTCHA Detection ────────────────────────────────────────────────

export const CAPTCHA_DETECTION_SCRIPT = `
(function() {
    ${SHARED_DOM_HELPERS}
    var selectors = [
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="arkoselabs"]',
        'iframe[src*="funcaptcha"]',
        '[class*="g-recaptcha"]',
        '[class*="h-captcha"]',
        '[data-sitekey]',
        '[id*="captcha" i]',
        '[class*="captcha" i]',
        '[aria-label*="captcha" i]'
    ];
    var textPatterns = [
        /captcha/i,
        /i am not a robot/i,
        /verify you are human/i,
        /verify that you are human/i,
        /security check/i,
        /human verification/i,
        /cloudflare.*verify/i
    ];

    var selectorMatches = [];
    for (var s = 0; s < selectors.length; s++) {
        var els = document.querySelectorAll(selectors[s]);
        for (var e = 0; e < els.length && selectorMatches.length < 5; e++) {
            var el = els[e];
            if (!aetherVisible(el)) continue;
            var rect = el.getBoundingClientRect();
            selectorMatches.push({
                selector: selectors[s],
                tag: el.tagName.toLowerCase(),
                text: String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').substring(0, 160),
                src: el.getAttribute('src') || '',
                bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
            });
        }
    }

    var bodyText = String(document.body && document.body.innerText || '').replace(/\\s+/g, ' ').substring(0, 5000);
    var textMatches = [];
    for (var t = 0; t < textPatterns.length; t++) {
        if (textPatterns[t].test(bodyText)) {
            textMatches.push(textPatterns[t].toString());
        }
    }

    var detected = selectorMatches.length > 0 || textMatches.length > 0;
    return {
        detected: detected,
        captchaRequired: detected,
        message: detected ? 'CAPTCHA detected. Manual solve required before continuing.' : 'No CAPTCHA detected.',
        matches: selectorMatches,
        textMatches: textMatches,
        url: window.location.href,
        title: document.title
    };
})()
`;

// ─── Wait for Text ────────────────────────────────────────────────────

export function makeWaitForTextScript(text: string): string {
    return `
(document.body && document.body.innerText || '').includes(${JSON.stringify(text)})
`;
}

// ─── Dismiss Popups ───────────────────────────────────────────────────

export const DISMISS_POPUPS_SCRIPT = `
(function() {
    var selectors = [
        '[aria-label*="close" i]', '[aria-label*="dismiss" i]',
        '.close', '.dismiss', '.modal-close',
        'button[class*="close"]', '[data-dismiss="modal"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el && el.offsetParent !== null) {
            el.click();
            return true;
        }
    }
    return false;
})()
`;

// ─── Collect Forms ────────────────────────────────────────────────────

export const COLLECT_FORMS_SCRIPT = `
(function() {
    var forms = Array.from(document.querySelectorAll('form'));
    return forms.map(function(form, idx) {
        var inputs = Array.from(form.querySelectorAll('input, select, textarea'));
        return {
            id: 'form-' + idx,
            action: form.action,
            method: form.method,
            inputs: inputs.map(function(input) {
                return {
                    type: input.type || 'text',
                    name: input.name || '',
                    id: input.id || '',
                    required: input.required,
                    placeholder: input.placeholder || ''
                };
            })
        };
    });
})()
`;

// ─── Self-Healing Fuzzy Match ─────────────────────────────────────────

export function makeFuzzyMatchScript(text: string): string {
    return `
(function() {
    ${SHARED_DOM_HELPERS}
    var searchText = ${JSON.stringify(text)};
    var searchLower = String(searchText || '').trim().toLowerCase();
    
    function textFor(el) {
        return String(
            el.innerText || el.textContent || el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') || el.getAttribute('name') || ''
        ).trim();
    }

    var elements = Array.from(document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [onclick]'))
        .filter(function(el) { return aetherVisible(el); });

    // Exact match
    var best = null;
    for (var i = 0; i < elements.length; i++) {
        if (textFor(elements[i]).toLowerCase() === searchLower) {
            best = elements[i];
            break;
        }
    }
    if (best) return { selector: aetherStableSelector(best), confidence: 1.0 };

    // Partial match
    for (var i = 0; i < elements.length; i++) {
        if (searchLower.length >= 3 && textFor(elements[i]).toLowerCase().indexOf(searchLower) >= 0) {
            best = elements[i];
            break;
        }
    }
    if (best) return { selector: aetherStableSelector(best), confidence: 0.8 };

    // Levenshtein fuzzy match
    function levenshtein(a, b) {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;
        var matrix = [];
        for (var i = 0; i <= b.length; i++) matrix[i] = [i];
        for (var j = 0; j <= a.length; j++) matrix[0][j] = j;
        for (var i = 1; i <= b.length; i++) {
            for (var j = 1; j <= a.length; j++) {
                matrix[i][j] = b.charAt(i-1) === a.charAt(j-1) ? matrix[i-1][j-1] :
                    Math.min(matrix[i-1][j-1] + 1, matrix[i][j-1] + 1, matrix[i-1][j] + 1);
            }
        }
        return matrix[b.length][a.length];
    }

    var minDist = Infinity;
    var bestEl = null;
    for (var i = 0; i < elements.length; i++) {
        var elText = textFor(elements[i]);
        if (!elText || Math.abs(elText.length - searchText.length) > 8) continue;
        var dist = levenshtein(searchText, elText);
        if (dist < minDist && dist <= 3) {
            minDist = dist;
            bestEl = elements[i];
        }
    }
    if (bestEl) return { selector: aetherStableSelector(bestEl), confidence: 0.6 };
    return null;
})()
`;
}

// ─── Element at Point ─────────────────────────────────────────────────

export function makeElementAtPointScript(x: number, y: number): string {
    return `
(function() {
    ${SHARED_DOM_HELPERS}
    var el = document.elementFromPoint(${x}, ${y});
    if (!el) return { found: false };
    var rect = el.getBoundingClientRect();
    return {
        found: true,
        selector: aetherStableSelector(el),
        tag: el.tagName.toLowerCase(),
        text: String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').substring(0, 160),
        role: el.getAttribute('role') || '',
        bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
})()
`;
}

// ─── Select Option Inspection ─────────────────────────────────────────

export function makeSelectInspectScript(selector: string, value: string): string {
    return `
(function() {
    var select = document.querySelector(${JSON.stringify(selector)});
    if (!select) return { success: false, error: "Element not found" };
    if (select.tagName.toLowerCase() !== 'select') return { success: false, error: "Element is not a select" };
    if (select.disabled) return { success: false, error: "Element is disabled" };
    var wanted = ${JSON.stringify(value)};
    var options = Array.from(select.options || []);
    var index = -1;
    for (var i = 0; i < options.length; i++) {
        if (options[i].value === wanted || options[i].text === wanted || options[i].label === wanted) {
            index = i;
            break;
        }
    }
    return {
        success: true,
        selectedValue: select.value,
        index: index,
        optionCount: options.length,
        wantedValue: index >= 0 ? options[index].value : wanted
    };
})()
`;
}

// ─── Checkbox/Radio State Inspection ──────────────────────────────────

export function makeCheckedStateScript(selector: string): string {
    return `
(function() {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { success: false, error: "Element not found" };
    if (el.type !== 'checkbox' && el.type !== 'radio') return { success: false, error: "Element is not a checkbox or radio" };
    if (el.disabled) return { success: false, error: "Element is disabled" };
    return { success: true, checked: !!el.checked, type: el.type };
})()
`;
}

// ─── Set Value via JS (fallback) ──────────────────────────────────────

export function makeSetValueScript(selector: string, value: string): string {
    return `
(function() {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { success: false, error: "Element not found" };
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, value: el.value };
})()
`;
}

// ─── Set Checked State via JS (fallback) ──────────────────────────────

export function makeSetCheckedScript(selector: string, checked: boolean): string {
    return `
(function() {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { success: false, error: "Element not found" };
    if (el.type !== 'checkbox' && el.type !== 'radio') return { success: false, error: "Element is not a checkbox or radio" };
    el.checked = ${checked};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, checked: el.checked };
})()
`;
}

// ─── Assert Conditions ────────────────────────────────────────────────

export function makeAssertionScript(selector: string, assertionType: string, expectedText: string): string {
    return `
(function() {
    var el = ${JSON.stringify(selector)} ? document.querySelector(${JSON.stringify(selector)}) : null;
    switch(${JSON.stringify(assertionType)}) {
        case 'element_exists':
            return { success: !!el, message: el ? 'Element exists' : 'Element not found' };
        case 'element_not_exists':
            return { success: !el, message: !el ? 'Element does not exist' : 'Element found' };
        case 'element_contains_text':
            if (!el) return { success: false, message: 'Element not found' };
            var text = (el.innerText || el.textContent || '').trim();
            var matches = text.indexOf(${JSON.stringify(expectedText)}) >= 0;
            return { success: matches, message: matches ? 'Text matches' : 'Text does not match', actualText: text };
        case 'url_contains':
            var urlMatches = window.location.href.indexOf(${JSON.stringify(expectedText)}) >= 0;
            return { success: urlMatches, message: urlMatches ? 'URL contains text' : 'URL does not contain text' };
        default:
            return { success: false, message: 'Unknown assertion type' };
    }
})()
`;
}

// ─── Verify UI State ──────────────────────────────────────────────────

export function makeVerifyUIScript(selector: string): string {
    return `
(function() {
    ${SHARED_DOM_HELPERS}
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { exists: false, visible: false };
    var rect = el.getBoundingClientRect();
    var vis = aetherVisible(el);
    return {
        exists: true,
        visible: vis,
        text: (el.innerText || el.textContent || '').trim().substring(0, 200),
        bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    };
})()
`;
}

// ─── Get Computed Style ───────────────────────────────────────────────

export function makeComputedStyleScript(selector: string, property?: string): string {
    return `
(function() {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    var style = window.getComputedStyle(el);
    ${property ? `return style.getPropertyValue(${JSON.stringify(property)});` : `return JSON.parse(JSON.stringify(style));`}
})()
`;
}

// ─── Get Page Text (Markdown/Plain Text extraction) ───────────────────

export function makeGetPageTextScript(format: "markdown" | "text", selector: string, includeLinks: boolean): string {
    return `
(function() {
    var FORMAT = ${JSON.stringify(format)};
    var SELECTOR = ${JSON.stringify(selector)};
    var INCLUDE_LINKS = ${JSON.stringify(includeLinks)};
    var SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','CANVAS','TEMPLATE','IFRAME','OBJECT','EMBED','NAV','FOOTER','HEADER','ASIDE']);

    function pickRoot() {
        if (SELECTOR) {
            var el = document.querySelector(SELECTOR);
            if (el) return el;
        }
        return document.querySelector('main, article, [role="main"]') || document.body || document.documentElement;
    }

    function isHidden(el) {
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
        var rect = el.getBoundingClientRect();
        return rect.width === 0 && rect.height === 0 && el.tagName !== 'BR' && el.tagName !== 'HR';
    }

    function inline(node) {
        var out = '';
        node.childNodes.forEach(function(child) {
            if (child.nodeType === Node.TEXT_NODE) {
                out += child.textContent.replace(/\\s+/g, ' ');
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                if (SKIP.has(child.tagName) || isHidden(child)) return;
                var tag = child.tagName.toLowerCase();
                var inner = inline(child);
                if (FORMAT === 'markdown') {
                    if (tag === 'a' && INCLUDE_LINKS && child.getAttribute('href')) {
                        var href = child.getAttribute('href');
                        out += inner.trim() ? '[' + inner.trim() + '](' + href + ')' : '';
                    } else if (tag === 'strong' || tag === 'b') {
                        out += inner.trim() ? '**' + inner.trim() + '**' : '';
                    } else if (tag === 'em' || tag === 'i') {
                        out += inner.trim() ? '*' + inner.trim() + '*' : '';
                    } else if (tag === 'code') {
                        out += inner.trim() ? '\`' + inner.trim() + '\`' : '';
                    } else if (tag === 'br') {
                        out += '\\n';
                    } else {
                        out += inner;
                    }
                } else {
                    out += (tag === 'br') ? '\\n' : inner;
                }
            }
        });
        return out;
    }

    var BLOCK = new Set(['P','DIV','SECTION','ARTICLE','UL','OL','LI','TABLE','TR','BLOCKQUOTE','PRE','H1','H2','H3','H4','H5','H6','HR','FIGURE','FIGCAPTION']);
    var lines = [];

    function walk(node, depth) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (SKIP.has(node.tagName) || isHidden(node)) return;
        var tag = node.tagName.toLowerCase();

        if (/^h[1-6]$/.test(tag)) {
            var t = inline(node).trim();
            if (t) lines.push(FORMAT === 'markdown' ? '#'.repeat(Number(tag[1])) + ' ' + t : t);
            return;
        }
        if (tag === 'hr') { lines.push(FORMAT === 'markdown' ? '---' : ''); return; }
        if (tag === 'pre') {
            var t = (node.innerText || node.textContent || '').replace(/\\s+$/,'');
            if (t) lines.push(FORMAT === 'markdown' ? '\\n\`\`\`\\n' + t + '\\n\`\`\`\\n' : t);
            return;
        }
        if (tag === 'li') {
            var t = inline(node).trim();
            if (t) {
                var indent = '  '.repeat(Math.max(0, depth));
                lines.push(FORMAT === 'markdown' ? indent + '- ' + t : indent + '\u2022 ' + t);
            }
            return;
        }
        if (tag === 'blockquote') {
            var t = inline(node).trim();
            if (t) lines.push(FORMAT === 'markdown' ? '> ' + t : t);
            return;
        }
        if (tag === 'tr') {
            var cells = Array.from(node.children).map(function(c) { return inline(c).trim(); });
            if (cells.some(Boolean)) lines.push(FORMAT === 'markdown' ? '| ' + cells.join(' | ') + ' |' : cells.join('\\t'));
            return;
        }

        var hasBlockChild = Array.from(node.children).some(function(c) { return BLOCK.has(c.tagName); });
        if (!hasBlockChild && (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'figcaption' || tag === 'td' || tag === 'th')) {
            var t = inline(node).trim();
            if (t) lines.push(t);
            return;
        }

        var nextDepth = (tag === 'ul' || tag === 'ol') ? depth + 1 : depth;
        node.childNodes.forEach(function(child) { walk(child, nextDepth); });
    }

    var root = pickRoot();
    walk(root, 0);

    var text = lines.join('\\n\\n').replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]+\\n/g, '\\n').trim();
    return { title: document.title || '', url: location.href, text: text };
})()
`;
}

// ─── Auth State - Export Storage ──────────────────────────────────────

export const EXPORT_STORAGE_SCRIPT = `
(function() {
    var ls = {}, ss = {};
    try {
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            ls[k] = localStorage.getItem(k);
        }
    } catch(e) {}
    try {
        for (var i = 0; i < sessionStorage.length; i++) {
            var k = sessionStorage.key(i);
            ss[k] = sessionStorage.getItem(k);
        }
    } catch(e) {}
    return { origin: location.origin, localStorage: ls, sessionStorage: ss };
})()
`;

// ─── Locator Bootstrap (pre-injected once on connect, then called by name) ──

/**
 * The full locator engine injected once via Page.addScriptToEvaluateOnNewDocument.
 * Registers window.__aetherLocate(paramsJson) which accepts a JSON string of
 * {target, role, selector, maxCandidates, includeText, mode} and returns
 * JSON string {candidates: [...]}.
 *
 * This eliminates re-injecting the ~300-line script on every locator call.
 */
export const LOCATOR_BOOTSTRAP_SCRIPT = `
window.__aetherLocate = function(paramsJson) {
    try {
        var p = JSON.parse(paramsJson);
    } catch(e) {
        return JSON.stringify({ candidates: [], error: 'invalid params' });
    }
    var target = p.target || '';
    var targetLower = target.toLowerCase();
    var roleHint = p.role || '';
    var selectorHint = p.selector || '';
    var maxCandidates = p.maxCandidates || 20;
    var includeText = p.includeText !== false;
    var mode = p.mode || 'resolve';

    ` + SHARED_DOM_HELPERS + `

    var INTERACTIVE = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
        '[onclick]', '[role]', '[tabindex]:not([tabindex="-1"])', 'label', 'summary',
        '[contenteditable="true"]', '[aria-label]', '[placeholder]'
    ].join(', ');

    function scoreField(field, value, exact, includes) {
        var text = aetherNorm(value);
        var lower = text.toLowerCase();
        if (!targetLower) return { score: 0, by: '' };
        if (lower === targetLower) return { score: exact, by: field + ':exact' };
        if (lower.indexOf(targetLower) >= 0) return { score: includes, by: field + ':contains' };
        if (targetLower.indexOf(lower) >= 0 && lower.length >= 3) return { score: Math.max(1, includes - 1), by: field + ':contained_by_target' };
        return { score: 0, by: '' };
    }

    function scoreCandidate(item) {
        var score = 0, matchedBy = '';
        var fields = [
            ['selector', item.selector, 13, 10], ['xpath', item.xpath, 11, 8],
            ['name', item.name, 12, 10], ['label', item.label, 12, 10],
            ['placeholder', item.placeholder, 11, 9], ['text', item.text, 10, 8],
            ['title', item.title, 8, 6], ['value', item.value, 7, 5]
        ];
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            var match = scoreField(f[0], f[1], f[2], f[3]);
            if (match.score > score) { score = match.score; matchedBy = match.by; }
        }
        if (roleHint) {
            if (item.role === roleHint) score += 5;
            else if (roleHint === 'textbox' && (item.tag === 'input' || item.tag === 'textarea')) score += 3;
            else score -= 3;
        }
        if (!targetLower && roleHint && item.role === roleHint) { matchedBy = 'role'; score = Math.max(score, 5); }
        if (item.scope !== 'document') score += 1;
        item.score = score;
        item.matchedBy = matchedBy || (selectorHint ? 'selector' : '');
        return item;
    }

    function collectFromRoot(root, framePath, frameOffset, shadowDepth, scope, out) {
        var nodes = [];
        try { nodes = selectorHint ? Array.from(root.querySelectorAll(selectorHint)) : Array.from(root.querySelectorAll(INTERACTIVE)); } catch(e) { nodes = []; }

        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (!aetherVisible(el)) continue;
            var rect = el.getBoundingClientRect();
            var sel = aetherStableSelector(el), roleVal = aetherImplicitRole(el), label = aetherLabelFor(el);
            var item = {
                ref: '', selector: sel, xpath: aetherXpath(el), scope: scope,
                framePath: framePath.slice(), shadowDepth: shadowDepth,
                tag: el.tagName.toLowerCase(), role: roleVal,
                type: el.getAttribute('type') || '',
                name: aetherNorm(el.getAttribute('aria-label') || label || aetherAccessibleName(el) || el.getAttribute('name')),
                text: includeText ? aetherNorm(el.innerText || el.textContent).substring(0, 180) : '',
                label: label, placeholder: aetherNorm(el.getAttribute('placeholder')),
                title: aetherNorm(el.getAttribute('title')), value: aetherNorm(el.getAttribute('value')),
                score: 0, matchedBy: '',
                bounds: { x: Math.round(frameOffset.x + rect.left), y: Math.round(frameOffset.y + rect.top),
                    width: Math.round(rect.width), height: Math.round(rect.height) }
            };
            item.ref = (item.scope === 'document' && item.framePath.length === 0 && item.shadowDepth === 0)
                ? 'css:' + item.selector
                : 'point:' + Math.round(item.bounds.x + item.bounds.width / 2) + ',' + Math.round(item.bounds.y + item.bounds.height / 2);
            out.push(scoreCandidate(item));
        }

        var all = [];
        try { all = Array.from(root.querySelectorAll('*')); } catch(e) {}
        for (var si = 0; si < all.length; si++) {
            var cel = all[si];
            if (cel.shadowRoot) { collectFromRoot(cel.shadowRoot, framePath, frameOffset, shadowDepth + 1, 'shadow', out); }
            if (cel.tagName && cel.tagName.toLowerCase() === 'iframe') {
                try {
                    var doc = cel.contentDocument;
                    if (doc) {
                        var frect = cel.getBoundingClientRect();
                        collectFromRoot(doc,
                            framePath.concat([Array.from(cel.ownerDocument.querySelectorAll('iframe')).indexOf(cel)]),
                            { x: frameOffset.x + frect.left, y: frameOffset.y + frect.top },
                            shadowDepth, 'frame', out);
                    }
                } catch(e) {}
            }
        }
    }

    var candidates = [];
    collectFromRoot(document, [], { x: 0, y: 0 }, 0, 'document', candidates);
    candidates.sort(function(a, b) {
        if (mode === 'list') return (a.bounds.y - b.bounds.y) || (a.bounds.x - b.bounds.x);
        return b.score - a.score || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x;
    });
    return JSON.stringify({ candidates: candidates.slice(0, maxCandidates) });
};
`;
