/**
 * Logging / debugging and diagnostic functions extracted from CdpBridge.
 *
 * These standalone functions accept a CdpClient (and optionally a Logger)
 * and return results — no `this` state required.
 */

import { CdpClient } from '../cdp-client';
import { Logger } from '../logger';
import * as Eval from '../eval-scripts';

// ─── getLogs ──────────────────────────────────────────────────────────

export async function getLogs(
    client: CdpClient,
    params: any,
): Promise<{ count: number; logs: any[] }> {
    const limit = Math.max(1, Math.min(Number(params.limit ?? 50), 100));
    const logs = await client.getConsoleLogs(limit);
    return { count: logs.length, logs };
}

// ─── getNetworkErrors ─────────────────────────────────────────────────

export async function getNetworkErrors(
    client: CdpClient,
    params: any,
): Promise<{ count: number; errors: any[] }> {
    const limit = Math.max(1, Math.min(Number(params.limit ?? 20), 100));
    const errors = (await client.getNetworkTraffic())
        .filter((entry: any) => entry.type === 'error' || entry.status >= 400)
        .slice(-limit);

    return { count: errors.length, errors };
}

// ─── getNetworkTraffic ────────────────────────────────────────────────

export async function getNetworkTraffic(
    client: CdpClient,
    _params?: any,
): Promise<any[]> {
    return await client.getNetworkTraffic();
}

// ─── getNetworkResponse ───────────────────────────────────────────────

export async function getNetworkResponse(
    client: CdpClient,
    params: any,
): Promise<any> {
    const requestId = params.requestId;
    if (!requestId) throw new Error('requestId required');

    const result = await client.sendCommand('Network.getResponseBody', {
        requestId,
    });
    return result;
}

// ─── getPerformanceMetrics ────────────────────────────────────────────

export async function getPerformanceMetrics(
    client: CdpClient,
    _params?: any,
): Promise<any[]> {
    await client.sendCommand('Performance.enable', {});
    const result = await client.sendCommand('Performance.getMetrics', {});
    return result.metrics;
}

// ─── startTracing ─────────────────────────────────────────────────────

export async function startTracing(
    client: CdpClient,
    params: any,
): Promise<string> {
    await client.sendCommand('Tracing.start', {
        categories: params.categories || 'devtools.timeline',
    });
    return 'Started tracing';
}

// ─── stopTracing ──────────────────────────────────────────────────────

export async function stopTracing(client: CdpClient): Promise<string> {
    await client.sendCommand('Tracing.end', {});
    return 'Stopped tracing';
}

// ─── cdpCommand ───────────────────────────────────────────────────────

export async function cdpCommand(
    client: CdpClient,
    params: any,
): Promise<any> {
    return await client.sendCommand(params.command, params.args || {});
}

// ─── evaluate ─────────────────────────────────────────────────────────

export async function evaluate(
    client: CdpClient,
    params: any,
): Promise<any> {
    return await client.evaluate(params.script);
}

// ─── assertCondition ──────────────────────────────────────────────────
// Uses Eval.makeAssertionScript to build the evaluation script, then
// executes it in the page context and returns the result.

export async function assertCondition(
    client: CdpClient,
    params: any,
): Promise<any> {
    const assertionType = params.assertionType || 'element_exists';
    const selector = params.selector;
    const expectedText = params.expectedText || params.value || '';

    const script = Eval.makeAssertionScript(
        selector,
        assertionType,
        expectedText,
    );
    const result = await client.evaluate(script);
    return result || { success: false, message: 'Assertion failed' };
}

// ─── getDOMStorage ────────────────────────────────────────────────────

export async function getDOMStorage(
    client: CdpClient,
    params: any,
): Promise<any[]> {
    await client.sendCommand('DOMStorage.enable', {});
    const origin =
        params.origin ||
        (await client
            .evaluate('window.location.origin')
            .catch(() => ''));

    const result = await client.sendCommand(
        'DOMStorage.getDOMStorageItems',
        {
            storageId: {
                securityOrigin: origin,
                isLocalStorage: params.type !== 'session',
            },
        },
    );

    return result.entries || [];
}
