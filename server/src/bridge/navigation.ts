/**
 * Browser navigation and tab management functions extracted from cdp-bridge.ts.
 *
 * Each function takes a CdpClient, params, and optional dependencies (snapshotCache,
 * logger) and returns a result. This module is designed to be consumed by the bridge
 * layer and can also be used directly by other parts of the server.
 */

import { CdpClient } from '../cdp-client';
import { PageSnapshotCache } from '../page-snapshot-cache';
import { Logger } from '../logger';
import { DISMISS_POPUPS_SCRIPT } from '../eval-scripts';

// ─── Connect ────────────────────────────────────────────────────────────

/**
 * Connect to an existing Chrome instance on the given debugging port.
 */
export async function connect(
    client: CdpClient,
    params: { port?: number }
): Promise<string> {
    const port = params.port ?? 9222;
    await client.connect(port);
    return 'Connected to browser';
}

// ─── Navigate ────────────────────────────────────────────────────────────

/**
 * Navigate the active tab to a URL and wait for the page to settle.
 * Invalidates the snapshot cache after navigation.
 */
export async function navigate(
    client: CdpClient,
    params: { url: string; timeout?: number },
    snapshotCache: PageSnapshotCache
): Promise<string> {
    await client.navigateAndWait(params.url, params.timeout ?? 10000);
    snapshotCache.invalidate('navigate');
    return 'Navigated';
}

// ─── Tab Management ─────────────────────────────────────────────────────

/**
 * Get all open browser tabs (targets).
 */
export async function getTabs(
    client: CdpClient,
    _params: Record<string, unknown>
): Promise<any[]> {
    const result = await client.sendCommand('Target.getTargets', {});
    return result.targetInfos ?? [];
}

/**
 * Open a new tab with an optional URL.
 */
export async function newTab(
    client: CdpClient,
    params: { url?: string }
): Promise<string> {
    const result = await client.sendCommand('Target.createTarget', {
        url: params.url ?? 'about:blank',
    });
    return result.targetId
        ? `Created new tab: ${result.targetId}`
        : 'Created new tab';
}

/**
 * Switch the active debugging session to a different tab.
 * Requires the targetId of the tab to switch to.
 */
export async function switchTab(
    client: CdpClient,
    params: { targetId: string; port?: number }
): Promise<string> {
    if (!params.targetId) {
        throw new Error('targetId required to switch tabs');
    }
    await client.sendCommand('Target.activateTarget', {
        targetId: params.targetId,
    });
    await client.switchToTarget(params.targetId, params.port ?? 9222);
    return `Switched to tab ${params.targetId}`;
}

/**
 * Close a tab by its targetId.
 */
export async function closeTab(
    client: CdpClient,
    params: { targetId: string }
): Promise<string> {
    await client.sendCommand('Target.closeTarget', {
        targetId: params.targetId,
    });
    return 'Closed tab';
}

// ─── Smart Navigate ──────────────────────────────────────────────────────

export interface SmartNavigateParams {
    url: string;
    waitFor?: {
        type: 'network_idle' | 'element';
        selector?: string;
        timeout?: number;
    };
    dismissPopups?: boolean;
    screenshot?: boolean;
    timeout?: number;
}

export interface SmartNavigateResult {
    success: boolean;
    url: string;
    title: string;
    screenshot?: string | null;
    error?: string;
}

/**
 * Navigate to a URL with optional popup dismissal, condition waiting, and
 * screenshot capture. This is a higher-level wrapper around navigate().
 */
export async function smartNavigate(
    client: CdpClient,
    params: SmartNavigateParams,
    snapshotCache: PageSnapshotCache,
    logger: Logger
): Promise<SmartNavigateResult> {
    const { url, waitFor, dismissPopups, screenshot, timeout } = params;
    const timeoutMs = timeout ?? 30000;

    try {
        logger.info(`smartNavigate: Navigating to ${url}`, { timeout: timeoutMs });

        await client.navigateAndWait(url, timeoutMs);
        snapshotCache.invalidate('smartNavigate');

        // Dismiss popups if requested (default: true)
        if (dismissPopups !== false) {
            logger.debug('smartNavigate: Dismissing popups');
            await client.evaluate(DISMISS_POPUPS_SCRIPT).catch((err: Error) => {
                logger.warn('smartNavigate: Popup dismissal failed', {
                    error: err.message,
                });
            });
        }

        // Wait for a specific condition after navigation
        if (waitFor) {
            if (waitFor.type === 'network_idle') {
                logger.debug('smartNavigate: Waiting for network idle', {
                    timeout: waitFor.timeout ?? 3000,
                });
                await client
                    .waitForNetworkIdle(500, waitFor.timeout ?? 3000)
                    .catch(() => {});
            } else if (waitFor.type === 'element' && waitFor.selector) {
                logger.debug('smartNavigate: Waiting for selector', {
                    selector: waitFor.selector,
                    timeout: waitFor.timeout ?? 5000,
                });
                await client
                    .waitForSelector(waitFor.selector, waitFor.timeout ?? 5000)
                    .catch(() => {});
            }
        }

        // Collect current page info
        const currentUrl = await client
            .evaluate('window.location.href')
            .catch(() => url);
        const title = await client
            .evaluate('document.title')
            .catch(() => 'Unknown');

        // Optionally take a screenshot
        const screenshotData =
            screenshot === true
                ? await client.screenshot('jpeg', 70).catch(() => null)
                : null;

        logger.info('smartNavigate: Complete', {
            finalUrl: currentUrl,
            title,
            hasScreenshot: screenshotData !== null,
        });

        return {
            success: true,
            url: currentUrl,
            title,
            screenshot: screenshotData,
        };
    } catch (e: any) {
        logger.error('smartNavigate: Failed', { error: e.message, url });
        return { success: false, url, title: 'Unknown', error: e.message };
    }
}
