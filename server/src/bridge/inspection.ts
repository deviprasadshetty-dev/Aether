/**
 * State/Inspection functions extracted from CdpBridge.
 *
 * These operate as standalone functions that accept their dependencies
 * (CdpClient, PageSnapshotCache, LocatorEngine) as explicit parameters
 * rather than relying on `this` state.
 */

import { CdpClient } from "../cdp-client";
import { PageSnapshotCache } from "../page-snapshot-cache";
import { LocatorEngine } from "../locator-engine";
import { Logger } from "../logger";
import * as Eval from "../eval-scripts";

// ─── browserStatus ────────────────────────────────────────────────────

export async function browserStatus(
    client: CdpClient,
    params: any,
): Promise<any> {
    const connected = client.isConnected();
    const activeTarget = client.getActiveTarget();
    let targets: any[] | undefined;

    if (connected && params.includeTargets) {
        targets = await client.getTabs().catch(() => []);
    }

    return {
        connected,
        activeTarget: activeTarget
            ? {
                  id: activeTarget.id,
                  type: activeTarget.type,
                  title: activeTarget.title,
                  url: activeTarget.url,
              }
            : null,
        targets,
    };
}

// ─── snapshotCompact ──────────────────────────────────────────────────

export async function snapshotCompact(
    client: CdpClient,
    snapshotCache: PageSnapshotCache,
    params: any,
): Promise<any> {
    return snapshotCache.compact({
        maxElements: params.maxElements ?? 30,
        includeText: params.includeText !== false,
    });
}

// ─── listInteractiveElements ──────────────────────────────────────────

export async function listInteractiveElements(
    client: CdpClient,
    snapshotCache: PageSnapshotCache,
    locator: LocatorEngine,
    params: any,
): Promise<any> {
    const maxElements = Math.max(
        0,
        Math.min(Number(params.maxElements ?? 50), 200),
    );
    const snapshot = await snapshotCache.compact({
        maxElements,
        includeText: true,
        withOverlay: !!params.withOverlay,
    });
    return {
        count: snapshot.elements.length,
        cache: snapshot.cache,
        elements: snapshot.elements,
    };
}

// ─── getState ─────────────────────────────────────────────────────────
// Comprehensive state: screenshot, domSnapshot, elements, SoM, tabs

export async function getState(
    client: CdpClient,
    snapshotCache: PageSnapshotCache,
    locator: LocatorEngine,
    params: any,
): Promise<any> {
    const includeScreenshot = params.screenshot === true;
    const includeDomSnapshot =
        params.domSnapshot === true || params.includeDOMSnapshot === true;
    const includeElements = params.elements !== false;
    const includeSoM = params.som === true || params.withOverlay === true;
    const includeTabs = params.tabs === true;
    const includeAccessibilityTree = params.accessibilityTree !== false;

    const compact = includeElements
        ? await snapshotCache.compact({
              maxElements: 200,
              includeText: true,
              withOverlay: includeSoM,
          })
        : await snapshotCache.compact({ maxElements: 0, includeText: false });

    const [screenshot, domSnapshot, tabs, accessibilityTree] = await Promise.all([
        includeScreenshot
            ? client
                  .screenshot(params.format, params.quality)
                  .catch(() => null)
            : Promise.resolve(null),
        includeDomSnapshot
            ? client.getDOMSnapshot().catch(() => null)
            : Promise.resolve(null),
        includeTabs
            ? client.getTabs().catch(() => [])
            : Promise.resolve([]),
        includeAccessibilityTree
            ? client.getRichAXTree().catch(() => null)
            : Promise.resolve(null),
    ]);

    if (includeSoM) {
        await client.removeSoMOverlay().catch(() => {});
    }

    return {
        title: compact.title,
        url: compact.url,
        screenshot,
        domSnapshot,
        elements: includeElements ? compact.elements : [],
        accessibilityTree,
        somInjected: includeSoM,
        cache: compact.cache,
        tabs,
    };
}

// ─── pageSnapshot ─────────────────────────────────────────────────────
// Full page capture: title, url, screenshot, elements, forms,
// cookies, accessibility tree

export async function pageSnapshot(
    client: CdpClient,
    params: any,
): Promise<any> {
    try {
        const includeScreenshot = params.screenshot === true;
        const includeCookies = params.cookies === true;
        const includeAccessibilityTree = params.accessibilityTree === true;

        const [
            title,
            url,
            screenshot,
            domSnapshot,
            elements,
            forms,
            cookies,
            axTree,
        ] = await Promise.all([
            client.evaluate("document.title").catch(() => "Unknown"),
            client
                .evaluate("window.location.href")
                .catch(() => "Unknown"),
            includeScreenshot
                ? client
                      .screenshot(
                          params.fullPage ? "jpeg" : "jpeg",
                          70,
                      )
                      .catch(() => null)
                : Promise.resolve(null),
            params.includeDOMSnapshot
                ? client.getDOMSnapshot().catch(() => null)
                : Promise.resolve(undefined),
            client
                .getInteractiveElements(false)
                .catch(() => ({ elements: [] })),
            client
                .evaluate(Eval.COLLECT_FORMS_SCRIPT)
                .catch(() => []),
            includeCookies
                ? client
                      .sendCommand("Network.getCookies", {})
                      .catch(() => ({ cookies: [] }))
                : Promise.resolve({ cookies: [] }),
            includeAccessibilityTree
                ? client
                      .getRichAXTree()
                      .catch(() => null)
                : Promise.resolve(null),
        ]);

        return {
            title,
            url,
            screenshot,
            elements: elements.elements,
            accessibilityTree: axTree,
            forms: forms || [],
            cookies: cookies.cookies || [],
            domSnapshot: params.includeDOMSnapshot ? domSnapshot : undefined,
            metadata: {
                timestamp: Date.now(),
                elementCount: elements.elements.length,
            },
        };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

// ─── getPageText ──────────────────────────────────────────────────────
// Eval.makeGetPageTextScript(format, selector, includeLinks)
// with maxLength truncation

export async function getPageText(
    client: CdpClient,
    params: any,
): Promise<any> {
    const format = params.format === "text" ? "text" : "markdown";
    const selector = params.selector ? String(params.selector) : "";
    const maxLength = Math.max(
        500,
        Math.min(Number(params.maxLength ?? 20000), 200000),
    );
    const includeLinks = params.includeLinks !== false;

    const extracted = await client
        .evaluate(
            Eval.makeGetPageTextScript(
                format as "markdown" | "text",
                selector,
                includeLinks,
            ),
        )
        .catch((e: any) => ({
            title: "",
            url: "",
            text: "",
            error: e?.message,
        }));

    const text = String(extracted?.text ?? "");
    const truncated = text.length > maxLength;
    return {
        title: extracted?.title ?? "",
        url: extracted?.url ?? "",
        format,
        length: text.length,
        truncated,
        text: truncated
            ? text.slice(0, maxLength) + "\n\n…[truncated]"
            : text,
    };
}

// ─── getAccessibilityTree ─────────────────────────────────────────────
// client.getRichAXTree()

export async function getAccessibilityTree(
    client: CdpClient,
): Promise<any> {
    return await client.getRichAXTree();
}

// ─── getDOMTree ───────────────────────────────────────────────────────
// client.getDOMSnapshot()

export async function getDOMTree(client: CdpClient): Promise<any> {
    const result = await client.getDOMSnapshot();
    return result;
}

// ─── getDomSnapshot ───────────────────────────────────────────────────
// Same as getDOMTree — kept for backward compatibility

export async function getDomSnapshot(
    client: CdpClient,
    params?: any,
): Promise<any> {
    return await client.getDOMSnapshot();
}

// ─── highlightElements ────────────────────────────────────────────────
// client.getInteractiveElements(true)

export async function highlightElements(
    client: CdpClient,
): Promise<any> {
    const result = await client.getInteractiveElements(true);
    return {
        success: true,
        elements: result.elements,
        message: `Highlighted ${result.elements.length} elements`,
    };
}

// ─── verifyUIState ────────────────────────────────────────────────────
// Eval.makeVerifyUIScript(selector)

export async function verifyUIState(
    client: CdpClient,
    params: any,
): Promise<any> {
    const selector = params.selector;
    const result = await client.evaluate(
        Eval.makeVerifyUIScript(selector),
    );
    return result || { exists: false, visible: false };
}

// ─── getComputedStyle ─────────────────────────────────────────────────
// Eval.makeComputedStyleScript(selector, property)

export async function getComputedStyle(
    client: CdpClient,
    params: any,
): Promise<any> {
    const selector = params.selector;
    const property = params.property;

    if (!selector) throw new Error("Selector required");

    const result = await client.evaluate(
        Eval.makeComputedStyleScript(selector, property),
    );
    return result;
}

// ─── getEventListeners ────────────────────────────────────────────────
// Evaluate for DevTools protocol (note: getEventListeners is CDP-specific
// and not available in page context without the DevTools API)

export async function getEventListeners(
    client: CdpClient,
    params: any,
): Promise<any> {
    const selector = params.selector;
    if (!selector) throw new Error("Selector required");

    // Attempt to use DOM.getEventListeners via CDP if available,
    // otherwise fall back to a page-context message.
    try {
        const objectResult = await client.sendCommand(
            "DOM.resolveNode",
            { selector },
        ).catch(() => null);

        if (objectResult?.object?.objectId) {
            const listeners = await client.sendCommand(
                "DOMDebugger.getEventListeners",
                { objectId: objectResult.object.objectId },
            ).catch(() => null);
            return listeners;
        }
    } catch {
        // Fallback to page-context message
    }

    const result = await client.evaluate(`
        (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            return { message: "getEventListeners requires DevTools protocol, not available in page context" };
        })()
    `);
    return result;
}
