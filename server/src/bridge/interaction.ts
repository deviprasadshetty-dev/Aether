/**
 * Browser interaction functions extracted from cdp-bridge.ts.
 *
 * Each function takes a CdpClient, LocatorEngine, PageSnapshotCache, params,
 * and Logger and returns a result. This module is designed to be consumed by
 * the bridge layer and can also be used directly by other parts of the server.
 */

import { CdpClient } from '../cdp-client';
import { LocatorEngine, LocatorCandidate } from '../locator-engine';
import { PageSnapshotCache } from '../page-snapshot-cache';
import { Logger } from '../logger';
import * as Eval from '../eval-scripts';

// ─── Action Facts Helpers ─────────────────────────────────────────────────

/**
 * Capture the current state of the active element (and optional target selector)
 * immediately before or after an action. Returns a facts object with URL, title,
 * focused element details, target element details, and any visible error messages.
 */
export async function captureActionFacts(
    client: CdpClient,
    selector?: string,
    _logger?: Logger
): Promise<any> {
    return await client.evaluate(Eval.makeActionFactsScript(selector)).catch(() => ({}));
}

/**
 * Diff before/after action facts to surface what changed.
 */
export function diffActionFacts(before: any, after: any): any {
    return {
        urlChanged: before?.url !== after?.url,
        titleChanged: before?.title !== after?.title,
        focused: after?.focused,
        target: after?.target,
        valueChanged: before?.target?.value !== after?.target?.value,
        checkedChanged: before?.target?.checked !== after?.target?.checked,
        selectedIndexChanged:
            before?.target?.selectedIndex !== after?.target?.selectedIndex,
        visibleErrors: after?.visibleErrors || [],
    };
}

// ─── Resolve Actionable Point ─────────────────────────────────────────────

// ─── Click Resolved Locator ───────────────────────────────────────────────

/**
 * Click a {@link LocatorCandidate} resolved by the locator engine.
 * Uses selector-based click for in-document elements; falls back to
 * coordinate click for frame/shadow elements.
 */
export async function clickResolvedLocator(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    candidate?: LocatorCandidate,
    logger?: Logger
): Promise<void> {
    if (!candidate)
        throw new Error('Resolved locator missing candidate details');
    if (
        candidate.scope === 'document' &&
        candidate.framePath.length === 0 &&
        candidate.shadowDepth === 0 &&
        candidate.selector
    ) {
        await clickElementBySelector(
            client,
            locator,
            snapshotCache,
            { selector: candidate.selector },
            logger!
        );
        return;
    }
    await locator.click(candidate);
}

// ─── click ────────────────────────────────────────────────────────────────

/**
 * Click at absolute coordinates.
 */
export async function click(
    client: CdpClient,
    _locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: { x?: number; y?: number; coordinate?: string },
    _logger: Logger
): Promise<string> {
    const x = params.x ?? (Number(params.coordinate?.split(',')[0]) || 100);
    const y = params.y ?? (Number(params.coordinate?.split(',')[1]) || 100);
    await client.click(x, y);
    snapshotCache.invalidate('click');
    return 'Clicked';
}

// ─── clickElement ─────────────────────────────────────────────────────────

/**
 * Click an element by its Set-of-Marks ID.
 * Falls back to selector, text, or coordinate click if ID resolution fails.
 */
export async function clickElement(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: {
        id?: string;
        selector?: string;
        text?: string;
        x?: number;
        y?: number;
        button?: 'left' | 'middle' | 'right';
    },
    logger: Logger
): Promise<string> {
    // Click by element ID (from SoM) — resolves ID to coordinates
    if (params.id !== undefined) {
        const result = await client.evaluate(
            Eval.makeClickByIdScript(String(params.id))
        );

        if (result) {
            await client.click(result.x, result.y, params.button, result.w);
            snapshotCache.invalidate('click_element');
            return `Clicked element @${params.id}`;
        }

        // Fallback: try to find element by selector or text
        if (params.selector) {
            return clickElementBySelector(
                client,
                locator,
                snapshotCache,
                { selector: params.selector },
                logger
            );
        }
        if (params.text) {
            return clickElementByText(
                client,
                locator,
                snapshotCache,
                { text: params.text },
                logger
            );
        }
    }

    // Fallback to coordinate click
    if (params.x !== undefined && params.y !== undefined) {
        await client.click(params.x, params.y);
        snapshotCache.invalidate('click_element');
        return 'Clicked at coordinates';
    }

    throw new Error(
        'Element not found: no valid id, selector, text, or coordinates provided'
    );
}

// ─── clickElementBySelector ───────────────────────────────────────────────

/**
 * Click an element by CSS selector — fast path. Gets element center via CDP
 * DOM.getBoxModel and clicks directly. No obscurity/polling/actionability gate.
 */
export async function clickElementBySelector(
    client: CdpClient,
    _locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: { selector: string; timeout?: number; button?: 'left' | 'middle' | 'right' },
    _logger: Logger
): Promise<string> {
    const selector = params.selector;
    if (!selector) throw new Error('Selector required');

    if (String(selector).startsWith('point:')) {
        const [x, y] = String(selector).slice(6).split(',').map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y))
            throw new Error(`Invalid point selector: ${selector}`);
        await client.click(x, y);
        snapshotCache.invalidate('click_element_by_selector');
        return 'Clicked element by point';
    }

    const center = await client.getElementCenter(selector);
    if (!center) throw new Error(`Element not found or not visible: ${selector}`);

    await client.click(center.x, center.y, params.button, center.width);
    snapshotCache.invalidate('click_element_by_selector');
    return 'Clicked element by selector';
}

// ─── clickElementByText ───────────────────────────────────────────────────

/**
 * Resolve an element by visible text and click it.
 */
export async function clickElementByText(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: { text: string; timeout?: number },
    logger: Logger
): Promise<string> {
    const result = await locator.resolve({
        target: params.text,
        timeout: params.timeout ?? 5000,
    });
    if (result.success && result.candidate) {
        await clickResolvedLocator(
            client,
            locator,
            snapshotCache,
            result.candidate,
            logger
        );
        snapshotCache.invalidate('click_element_by_text');
        return `Clicked element with text: ${params.text}`;
    }
    throw new Error(`Element with text not found: ${params.text}`);
}

// ─── type ─────────────────────────────────────────────────────────────────

/**
 * Type text at the current focus location.
 */
export async function type(
    client: CdpClient,
    _locator: LocatorEngine,
    _snapshotCache: PageSnapshotCache,
    params: { text?: string; value?: string },
    _logger: Logger
): Promise<string> {
    const text = params.text || params.value || '';
    await client.typeText(text);
    return 'Typed text';
}

// ─── fillInput ────────────────────────────────────────────────────────────

/**
 * Fill an input element identified by CSS selector. Waits for the element,
 * clears any existing content, then types the provided value.
 */
export async function fillInput(
    client: CdpClient,
    _locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: { selector?: string; value?: string; text?: string },
    logger: Logger
): Promise<string> {
    const selector = params.selector;
    const text = params.value || params.text || '';

    if (selector) {
        logger.debug('fillInput: waiting for selector', { selector });
        await client.waitForSelector(selector);
        await client.moveMouseToSelector(selector).catch(() => {});

        // Focus via native CDP
        const nodeId = await client.querySelectorNodeId(selector).catch(() => null);
        if (nodeId) {
            await client.focusNode(nodeId).catch(() => {});
        }
        // Clear value + dispatch events
        await client.evaluate(
            `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(el){el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}return false;})()`
        );
    }

    await client.typeText(text);
    snapshotCache.invalidate('fill');
    return `Filled with: ${text}`;
}

// ─── selectOption ─────────────────────────────────────────────────────────

/**
 * Select an option within a <select> element. Inspects the select to find
 * the target option, then uses keyboard navigation (for short option lists)
 * or a JavaScript fallback to set the value.
 */
export async function selectOption(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: { selector: string; value: string },
    logger: Logger
): Promise<string> {
    const selector = params.selector;
    const value = params.value || '';

    if (!selector) throw new Error('Selector required for select action');

    await client.waitForSelector(selector);

    const selectInfo = await client.evaluate(
        Eval.makeSelectInspectScript(selector, value)
    );

    if (!selectInfo?.success)
        throw new Error(selectInfo?.error || 'Failed to inspect select');

    // Already at the wanted value — nothing to do
    if (selectInfo.selectedValue === selectInfo.wantedValue) {
        return `Selected option: ${value}`;
    }

    // Try keyboard navigation for reasonable-size selects
    if (selectInfo.index >= 0 && selectInfo.index <= 40) {
        try {
            await clickElementBySelector(
                client,
                locator,
                snapshotCache,
                { selector },
                logger
            );
            await client.pressKey('Home');
            for (let i = 0; i < selectInfo.index; i++) {
                await client.pressKey('ArrowDown');
            }
            await client.pressKey('Enter');

            const verified = await client.evaluate(`
                (function() {
                    const select = document.querySelector(${JSON.stringify(selector)});
                    return select ? select.value : null;
                })()
            `);
            if (verified === selectInfo.wantedValue) {
                return `Selected option: ${value}`;
            }
        } catch {
            // Fall back to direct value setting below
            logger.debug('selectOption: keyboard nav failed, using JS fallback', {
                selector,
            });
        }
    }

    // JS fallback: set value and fire events
    const result = await client.evaluate(
        Eval.makeSetValueScript(selector, selectInfo.wantedValue)
    );

    if (result?.success) return `Selected option: ${value}`;
    throw new Error(result?.error || 'Failed to select option');
}

// ─── checkElement / setChecked ────────────────────────────────────────────

/**
 * Check a checkbox or radio input. Delegates to {@link setChecked}.
 */
export async function checkElement(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: { selector: string },
    logger: Logger
): Promise<string> {
    if (!params.selector) throw new Error('Selector required for check action');
    return setChecked(
        client,
        locator,
        snapshotCache,
        { selector: params.selector, checked: true },
        logger
    );
}

/**
 * Set the checked state of a checkbox or radio input.
 * Inspects current state first, then tries a real click; falls back to
 * direct property assignment with event dispatch.
 */
export async function setChecked(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: { selector: string; checked: boolean },
    logger: Logger
): Promise<string> {
    const selector = params.selector;
    if (!selector) throw new Error('Selector required for checked state');

    await client.waitForSelector(selector);

    const before = await client.evaluate(
        Eval.makeCheckedStateScript(selector)
    );
    if (!before?.success)
        throw new Error(before?.error || 'Failed to inspect checked state');

    const wanted = !!params.checked;
    if (before.checked === wanted)
        return `Checked state set to ${wanted}`;

    // Don't try clicking a radio to uncheck (radios can't be unchecked by click)
    if (!(before.type === 'radio' && !wanted)) {
        try {
            await clickElementBySelector(
                client,
                locator,
                snapshotCache,
                { selector },
                logger
            );

            const afterClick = await client.evaluate(`
                (function() {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    return el ? !!el.checked : null;
                })()
            `);
            if (afterClick === wanted)
                return `Checked state set to ${wanted}`;
        } catch {
            logger.debug('setChecked: click failed, using JS fallback', {
                selector,
            });
        }
    }

    // JS fallback
    const result = await client.evaluate(
        Eval.makeSetCheckedScript(selector, wanted)
    );
    if (result?.success) return `Checked state set to ${wanted}`;
    throw new Error(result?.error || 'Failed to set checked state');
}

// ─── hover ────────────────────────────────────────────────────────────────

/**
 * Move the mouse cursor to the given coordinates without clicking.
 */
export async function hover(
    client: CdpClient,
    _locator: LocatorEngine,
    _snapshotCache: PageSnapshotCache,
    params: { x?: number; y?: number; coordinate?: string },
    _logger: Logger
): Promise<string> {
    const x =
        params.x ??
        (params.coordinate ? Number(params.coordinate.split(',')[0]) : 100);
    const y =
        params.y ??
        (params.coordinate ? Number(params.coordinate.split(',')[1]) : 100);
    await client.moveMouse(x, y);
    return 'Hovered';
}

// ─── dragAndDrop ──────────────────────────────────────────────────────────

/**
 * Perform a drag-and-drop operation from (startX, startY) to (endX, endY).
 */
export async function dragAndDrop(
    client: CdpClient,
    _locator: LocatorEngine,
    _snapshotCache: PageSnapshotCache,
    params: { startX?: number; startY?: number; endX?: number; endY?: number },
    _logger: Logger
): Promise<string> {
    const startX = params.startX ?? 0;
    const startY = params.startY ?? 0;
    const endX = params.endX ?? 0;
    const endY = params.endY ?? 0;

    await client.moveMouse(startX, startY);
    await client.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: startX,
        y: startY,
        button: 'left',
        clickCount: 1,
    });
    await client.moveMouse(endX, endY);
    await client.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: endX,
        y: endY,
        button: 'left',
        clickCount: 1,
    });
    return 'Dragged and dropped';
}

// ─── pressKey ─────────────────────────────────────────────────────────────

/**
 * Press a single key with optional modifiers. Invalidates the snapshot cache
 * since key presses may change page state.
 */
export async function pressKey(
    client: CdpClient,
    _locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: { key?: string; value?: string; modifiers?: string[] },
    _logger: Logger
): Promise<any> {
    const key = String(params.key || params.value || '');
    if (!key) throw new Error('key required');
    const modifiers = Array.isArray(params.modifiers)
        ? params.modifiers.map(String)
        : [];

    await client.pressKey(key, modifiers);
    snapshotCache.invalidate('press_key');
    return { success: true, key, modifiers };
}

// ─── scroll ───────────────────────────────────────────────────────────────

/**
 * Scroll the page by the given delta amounts. Optionally at a specific origin.
 */
export async function scroll(
    client: CdpClient,
    _locator: LocatorEngine,
    _snapshotCache: PageSnapshotCache,
    params: {
        x?: number;
        y?: number;
        originX?: number;
        originY?: number;
        mouseX?: number;
        mouseY?: number;
        options?: { originX?: number; originY?: number };
    },
    _logger: Logger
): Promise<string> {
    const deltaX = params.x ?? 0;
    const deltaY = params.y ?? 0;
    const originX =
        params.originX ?? params.mouseX ?? params.options?.originX;
    const originY =
        params.originY ?? params.mouseY ?? params.options?.originY;
    await client.wheel(deltaX, deltaY, originX, originY);
    return 'Scrolled';
}

// ─── wait ─────────────────────────────────────────────────────────────────

/**
 * Pause execution for a specified number of milliseconds.
 */
export async function wait(
    _client: CdpClient,
    _locator: LocatorEngine,
    _snapshotCache: PageSnapshotCache,
    params: { ms?: number; timeout?: number },
    _logger: Logger
): Promise<string> {
    const ms = params.ms ?? params.timeout ?? 1000;
    await new Promise((r) => setTimeout(r, ms));
    return 'Waited';
}

// ─── elementAtPoint ───────────────────────────────────────────────────────

/**
 * Inspect the DOM element at absolute viewport coordinates (x, y).
 */
export async function elementAtPoint(
    client: CdpClient,
    _locator: LocatorEngine,
    _snapshotCache: PageSnapshotCache,
    params: { x?: number; y?: number; coordinate?: string },
    _logger: Logger
): Promise<any> {
    const x =
        params.x ?? Number(String(params.coordinate || '').split(',')[0]);
    const y =
        params.y ?? Number(String(params.coordinate || '').split(',')[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y))
        throw new Error('x/y or coordinate required');

    return await client.evaluate(Eval.makeElementAtPointScript(x, y));
}

// ─── clickByRef ───────────────────────────────────────────────────────────

/**
 * Click an element by its canonical ref string (css:, point:, or @id).
 */
export async function clickByRef(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: { ref: string; timeout?: number },
    logger: Logger
): Promise<any> {
    const ref = String(params.ref || '');
    if (!ref) throw new Error('ref required');

    if (ref.startsWith('css:')) {
        return clickBySelector(
            client,
            locator,
            snapshotCache,
            { selector: ref.slice(4), timeout: params.timeout },
            logger
        );
    }

    if (ref.startsWith('point:')) {
        const [x, y] = ref
            .slice(6)
            .split(',')
            .map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y))
            throw new Error(`Invalid point ref: ${ref}`);

        await client.click(x, y);
        snapshotCache.invalidate('click_by_ref');
        return { success: true, ref };
    }

    if (ref.startsWith('@') || ref.startsWith('som:')) {
        const id = ref.replace(/^som:/, '').replace(/^@/, '');
        await clickElement(
            client,
            locator,
            snapshotCache,
            { id },
            logger
        );
        return { success: true, ref };
    }

    throw new Error(`Unsupported element ref: ${ref}`);
}

// ─── clickBySelector ──────────────────────────────────────────────────────

/**
 * Wait for a CSS selector, then click it. Wraps {@link clickElementBySelector}
 * with a wait-for-selector step and before/after action facts.
 */
export async function clickBySelector(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: { selector: string; timeout?: number; visible?: boolean; stable?: boolean },
    logger: Logger
): Promise<any> {
    const selector = params.selector;
    if (!selector) throw new Error('selector required');

    const found = await client.waitForSelector(
        selector,
        params.timeout ?? 5000,
        {
            visible: params.visible !== false,
            stable: params.stable === true,
        }
    );
    if (!found)
        return {
            success: false,
            selector,
            message: 'Selector not found before timeout',
        };

    await clickElementBySelector(
        client,
        locator,
        snapshotCache,
        { selector },
        logger
    );
    snapshotCache.invalidate('click_by_selector');
    return { success: true, selector };
}

// ─── fillBySelector ───────────────────────────────────────────────────────

/**
 * Wait for a CSS selector targeting a form input, clear any existing
 * content, and type the provided value. Invalidates the snapshot cache.
 */
export async function fillBySelector(
    client: CdpClient,
    _locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: {
        selector: string;
        value?: string;
        timeout?: number;
        visible?: boolean;
        stable?: boolean;
    },
    logger: Logger
): Promise<any> {
    const selector = params.selector;
    const value = params.value ?? '';
    if (!selector) throw new Error('selector required');

    const found = await client.waitForSelector(
        selector,
        params.timeout ?? 5000,
        {
            visible: params.visible !== false,
            stable: params.stable === true,
        }
    );
    if (!found)
        return {
            success: false,
            selector,
            message: 'Selector not found before timeout',
        };

    await client.moveMouseToSelector(selector).catch(() => {});

    // Focus via native CDP (much faster than JS injection)
    const nodeId = await client.querySelectorNodeId(selector).catch(() => null);
    if (nodeId) {
        await client.focusNode(nodeId).catch(() => {});
    }

    // Clear value + dispatch events (still requires page context for React/SPA compatibility)
    const focused = await client.evaluate(
        `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;if('value'in el){el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}return true;})()`
    );

    if (!focused)
        return {
            success: false,
            selector,
            message: 'Selector could not be focused',
        };

    await client.typeText(String(value));
    snapshotCache.invalidate('fill_by_selector');
    return { success: true, selector, length: String(value).length };
}

// ─── clickText ────────────────────────────────────────────────────────────

/**
 * Resolve an element by visible text content and click it.
 * Uses the locator engine for fuzzy text matching.
 */
export async function clickText(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: {
        text?: string;
        value?: string;
        target?: string;
        role?: string;
        timeout?: number;
        includeCandidates?: boolean;
    },
    logger: Logger
): Promise<any> {
    const resolved = await locator.resolve({
        target: params.text || params.value || params.target,
        role: params.role,
        timeout: params.timeout ?? 5000,
        includeCandidates: params.includeCandidates,
    });

    if (!resolved.success) return resolved;

    await clickResolvedLocator(
        client,
        locator,
        snapshotCache,
        resolved.candidate,
        logger
    );
    snapshotCache.invalidate('click_text');
    return {
        success: true,
        selector: resolved.selector,
        ref: resolved.ref,
        matchedBy: resolved.matchedBy,
        confidence: resolved.confidence,
    };
}

// ─── clickRole ────────────────────────────────────────────────────────────

/**
 * Resolve an element by ARIA role (and optional name) and click it.
 */
export async function clickRole(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: {
        name?: string;
        text?: string;
        target?: string;
        role?: string;
        timeout?: number;
        includeCandidates?: boolean;
    },
    logger: Logger
): Promise<any> {
    const resolved = await locator.resolve({
        target: params.name || params.text || params.target || '',
        role: params.role,
        timeout: params.timeout ?? 5000,
        includeCandidates: params.includeCandidates,
    });

    if (!resolved.success) return resolved;

    await clickResolvedLocator(
        client,
        locator,
        snapshotCache,
        resolved.candidate,
        logger
    );
    snapshotCache.invalidate('click_role');
    return {
        success: true,
        selector: resolved.selector,
        ref: resolved.ref,
        matchedBy: resolved.matchedBy,
        confidence: resolved.confidence,
    };
}

// ─── fillLabel ────────────────────────────────────────────────────────────

/**
 * Resolve a form field by its associated label text (defaults to role='textbox')
 * and fill it with the given value.
 */
export async function fillLabel(
    client: CdpClient,
    locator: LocatorEngine,
    snapshotCache: PageSnapshotCache,
    params: {
        label?: string;
        target?: string;
        role?: string;
        value?: string;
        timeout?: number;
        includeCandidates?: boolean;
    },
    logger: Logger
): Promise<any> {
    const resolved = await locator.resolve({
        target: params.label || params.target,
        role: params.role || 'textbox',
        timeout: params.timeout ?? 5000,
        includeCandidates: params.includeCandidates,
    });

    if (!resolved.success) return resolved;

    // In-document elements can use the fast fillBySelector path
    if (
        resolved.candidate?.scope === 'document' &&
        resolved.candidate.framePath.length === 0 &&
        resolved.candidate.shadowDepth === 0
    ) {
        return fillBySelector(
            client,
            locator,
            snapshotCache,
            {
                selector: resolved.selector!,
                value: params.value ?? '',
                timeout: params.timeout ?? 5000,
            },
            logger
        );
    }

    // Frame/shadow elements use coordinate focus + clear + type
    await locator.focusAndClear(resolved.candidate!);
    await client.typeText(String(params.value ?? ''));
    snapshotCache.invalidate('fill_label');
    return {
        success: true,
        selector: resolved.selector,
        ref: resolved.ref,
        matchedBy: resolved.matchedBy,
        confidence: resolved.confidence,
        length: String(params.value ?? '').length,
    };
}
