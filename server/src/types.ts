/**
 * Aether MCP Server — Shared Types
 * 
 * All Zod-inferred types for end-to-end type safety across the bridge,
 * client, and MCP tool handlers. Generated from the schemas in mcp-server.ts.
 */
import { z } from "zod";

// ─── Browser Connection ───────────────────────────────────────────────

export const ConnectBrowserSchema = z.object({
    mode: z.enum(["connect", "launch", "auto", "ask"]).optional(),
    port: z.number().optional(),
    headless: z.boolean().optional(),
    browser: z.enum(["chrome", "edge", "brave", "firefox"]).optional(),
    profile: z.string().optional(),
    profileDirectory: z.string().optional(),
    userDataDir: z.string().optional(),
});
export type ConnectBrowserParams = z.infer<typeof ConnectBrowserSchema>;

// ─── State & Snapshot ─────────────────────────────────────────────────

export const GetStateSchema = z.object({
    screenshot: z.boolean().optional(),
    domSnapshot: z.boolean().optional(),
    elements: z.boolean().optional(),
    som: z.boolean().optional(),
    tabs: z.boolean().optional(),
});
export type GetStateParams = z.infer<typeof GetStateSchema>;

export const SnapshotCompactSchema = z.object({
    maxElements: z.number().optional(),
    includeText: z.boolean().optional(),
});
export type SnapshotCompactParams = z.infer<typeof SnapshotCompactSchema>;

export const ListInteractiveElementsSchema = z.object({
    maxElements: z.number().optional(),
    withOverlay: z.boolean().optional(),
});
export type ListInteractiveElementsParams = z.infer<typeof ListInteractiveElementsSchema>;

export const BrowserStatusSchema = z.object({
    includeTargets: z.boolean().optional(),
});
export type BrowserStatusParams = z.infer<typeof BrowserStatusSchema>;

// ─── Interaction ──────────────────────────────────────────────────────

export const ClickByRefSchema = z.object({
    ref: z.string(),
});
export type ClickByRefParams = z.infer<typeof ClickByRefSchema>;

export const ClickBySelectorSchema = z.object({
    selector: z.string(),
    timeout: z.number().optional(),
});
export type ClickBySelectorParams = z.infer<typeof ClickBySelectorSchema>;

export const FillBySelectorSchema = z.object({
    selector: z.string(),
    value: z.string(),
    timeout: z.number().optional(),
});
export type FillBySelectorParams = z.infer<typeof FillBySelectorSchema>;

export const WaitForSelectorSchema = z.object({
    selector: z.string(),
    timeout: z.number().optional(),
});
export type WaitForSelectorParams = z.infer<typeof WaitForSelectorSchema>;

export const WaitForTextSchema = z.object({
    text: z.string(),
    timeout: z.number().optional(),
});
export type WaitForTextParams = z.infer<typeof WaitForTextSchema>;

export const ClickTextSchema = z.object({
    text: z.string(),
    role: z.string().optional(),
    timeout: z.number().optional(),
});
export type ClickTextParams = z.infer<typeof ClickTextSchema>;

export const ClickRoleSchema = z.object({
    role: z.string(),
    name: z.string().optional(),
    timeout: z.number().optional(),
});
export type ClickRoleParams = z.infer<typeof ClickRoleSchema>;

export const FillLabelSchema = z.object({
    label: z.string(),
    value: z.string(),
    role: z.string().optional(),
    timeout: z.number().optional(),
});
export type FillLabelParams = z.infer<typeof FillLabelSchema>;

export const PressKeySchema = z.object({
    key: z.string(),
    modifiers: z.array(z.string()).optional(),
});
export type PressKeyParams = z.infer<typeof PressKeySchema>;

export const ElementAtPointSchema = z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    coordinate: z.string().optional(),
});
export type ElementAtPointParams = z.infer<typeof ElementAtPointSchema>;

// ─── Browser Intent ───────────────────────────────────────────────────

export const BrowserIntentSchema = z.object({
    intent: z.enum(["click", "fill", "select", "check", "wait_for", "inspect", "navigate"]),
    target: z.string().optional(),
    value: z.string().optional(),
    role: z.string().optional(),
    timeout: z.number().optional(),
    verify: z.string().optional(),
    includeCandidates: z.boolean().optional(),
});
export type BrowserIntentParams = z.infer<typeof BrowserIntentSchema>;

// ─── Act (Primary Action Tool) ────────────────────────────────────────

export const ActSchema = z.object({
    action: z.enum([
        "navigate", "click", "type", "fill", "select", "check",
        "hover", "scroll", "wait", "screenshot",
        "new_tab", "switch_tab", "close_tab", "drag_and_drop", "upload_file",
        "get_tree", "get_dom_tree", "configure", "print_pdf", "emulate_network",
        "get_cookies", "set_cookie", "clear_cache", "set_geolocation", "set_timezone",
        "get_performance_metrics",
        "start_screencast", "stop_screencast", "record_session", "sample_visual_frames",
        "mock_network_request", "highlight_elements",
        "assert", "start_tracing", "stop_tracing",
        "screenshot_region", "verify_ui_state", "get_dom_snapshot", "get_event_listeners",
        "get_computed_style", "get_network_traffic", "get_network_response",
        "get_screencast_frames", "get_dom_storage", "get_logs", "press_key", "key_combo",
        "click_text", "click_role", "fill_label", "element_at_point", "detect_captcha",
    ]),
    selector: z.string().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    elementId: z.string().optional(),
    value: z.string().optional(),
    assertionType: z.string().optional(),
    options: z.record(z.any()).optional(),
    domain: z.string().optional(),
    coordinate: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    visible: z.boolean().optional(),
    stable: z.boolean().optional(),
    parentId: z.string().optional(),
    projectRoot: z.string().optional(),
    tabId: z.number().optional(),
    files: z.array(z.string()).optional(),
    modifiers: z.array(z.string()).optional(),
    format: z.string().optional(),
    quality: z.number().optional(),
    maxWidth: z.number().optional(),
    maxHeight: z.number().optional(),
    everyNthFrame: z.number().optional(),
    maxFrames: z.number().optional(),
    duration: z.number().optional(),
    cookieName: z.string().optional(),
    cookieValue: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    timezoneId: z.string().optional(),
    urlPattern: z.string().optional(),
    mockResponse: z.string().optional(),
    markdownSummary: z.string().optional(),
    requestId: z.string().optional(),
    offline: z.boolean().optional(),
    latency: z.number().optional(),
    downloadThroughput: z.number().optional(),
    uploadThroughput: z.number().optional(),
    landscape: z.boolean().optional(),
    printBackground: z.boolean().optional(),
    network: z.object({
        blockImages: z.boolean().optional(),
        blockAds: z.boolean().optional(),
        blockCSS: z.boolean().optional(),
    }).optional(),
    emulation: z.object({
        width: z.number().optional(),
        height: z.number().optional(),
        mobile: z.boolean().optional(),
        userAgent: z.string().optional(),
    }).optional(),
    script: z.object({
        onLoad: z.string().optional(),
    }).optional(),
});
export type ActParams = z.infer<typeof ActSchema>;

// ─── Debugging ────────────────────────────────────────────────────────

export const GetLogsSchema = z.object({
    limit: z.number().optional(),
});
export type GetLogsParams = z.infer<typeof GetLogsSchema>;

export const GetNetworkErrorsSchema = z.object({
    limit: z.number().optional(),
});
export type GetNetworkErrorsParams = z.infer<typeof GetNetworkErrorsSchema>;

export const ExecuteScriptSchema = z.object({
    script: z.string(),
});
export type ExecuteScriptParams = z.infer<typeof ExecuteScriptSchema>;

export const CdpCommandSchema = z.object({
    command: z.string(),
    args: z.record(z.any()).optional(),
});
export type CdpCommandParams = z.infer<typeof CdpCommandSchema>;

// ─── CAPTCHA ──────────────────────────────────────────────────────────

export const DetectCaptchaSchema = z.object({});
export type DetectCaptchaParams = z.infer<typeof DetectCaptchaSchema>;

export const SolveCaptchaSchema = z.object({
    useService: z.boolean().optional(),
    service: z.enum(["2captcha", "capsolver"]).optional(),
    apiKey: z.string().optional(),
    pageUrl: z.string().optional(),
    waitAfterClick: z.number().optional(),
    timeout: z.number().optional(),
    pollInterval: z.number().optional(),
});
export type SolveCaptchaParams = z.infer<typeof SolveCaptchaSchema>;

// ─── Agent-Centric APIs ───────────────────────────────────────────────

export const AgentActionSchema = z.object({
    action: z.string(),
    target: z.record(z.any()).optional(),
    verify: z.record(z.any()).optional(),
    waitFor: z.record(z.any()).optional(),
    timeout: z.number().optional(),
    screenshot: z.boolean().optional(),
});
export type AgentActionParams = z.infer<typeof AgentActionSchema>;

export const SmartNavigateSchema = z.object({
    url: z.string(),
    waitFor: z.record(z.any()).optional(),
    dismissPopups: z.boolean().optional(),
    screenshot: z.boolean().optional(),
    timeout: z.number().optional(),
});
export type SmartNavigateParams = z.infer<typeof SmartNavigateSchema>;

export const ObserveAndActSchema = z.object({
    action: z.record(z.any()),
    observe: z.record(z.any()).optional(),
    returnScreenshot: z.boolean().optional(),
});
export type ObserveAndActParams = z.infer<typeof ObserveAndActSchema>;

export const AgentFormFillSchema = z.object({
    fields: z.array(z.record(z.any())),
    submitAfterFill: z.boolean().optional(),
    submitSelector: z.string().optional(),
});
export type AgentFormFillParams = z.infer<typeof AgentFormFillSchema>;

export const PageSnapshotSchema = z.object({
    fullPage: z.boolean().optional(),
    includeDOMSnapshot: z.boolean().optional(),
    screenshot: z.boolean().optional(),
    cookies: z.boolean().optional(),
    accessibilityTree: z.boolean().optional(),
});
export type PageSnapshotParams = z.infer<typeof PageSnapshotSchema>;

// ─── Page Text ────────────────────────────────────────────────────────

export const GetPageTextSchema = z.object({
    format: z.enum(["markdown", "text"]).optional(),
    selector: z.string().optional(),
    includeLinks: z.boolean().optional(),
    maxLength: z.number().optional(),
});
export type GetPageTextParams = z.infer<typeof GetPageTextSchema>;

// ─── Auth State ───────────────────────────────────────────────────────

export const SaveAuthStateSchema = z.object({
    path: z.string().optional(),
    origins: z.array(z.any()).optional(),
});
export type SaveAuthStateParams = z.infer<typeof SaveAuthStateSchema>;

export const LoadAuthStateSchema = z.object({
    path: z.string().optional(),
    reload: z.boolean().optional(),
});
export type LoadAuthStateParams = z.infer<typeof LoadAuthStateSchema>;

// ─── Aether Memory ────────────────────────────────────────────────────

export const ConfigureAetherMemorySchema = z.object({
    projectRoot: z.string().optional(),
});
export type ConfigureAetherMemoryParams = z.infer<typeof ConfigureAetherMemorySchema>;

export const RememberAetherLessonSchema = z.object({
    projectRoot: z.string().optional(),
    title: z.string(),
    trigger: z.string(),
    problemPattern: z.string(),
    symptoms: z.array(z.string()).optional(),
    failedApproach: z.string().optional(),
    betterApproach: z.string(),
    createdBecause: z.enum([
        "complex_task_succeeded",
        "errors_overcome",
        "user_corrected_approach_worked",
        "non_trivial_workflow_discovered",
        "user_asked_to_remember",
    ]),
    evidence: z.string().optional(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().optional(),
});
export type RememberAetherLessonParams = z.infer<typeof RememberAetherLessonSchema>;

// ─── Speed Control ────────────────────────────────────────────────────

export type SpeedLevel = number; // 0.0 = instant, 1.0 = human, 2.0 = slow

// ─── Shared Result Types ──────────────────────────────────────────────

export interface ActionResult {
    success: boolean;
    message?: string;
    [key: string]: any;
}

export interface PageFacts {
    url: string;
    title: string;
    readyState: string;
    focused: any;
    target: any;
    visibleErrors: string[];
}

export interface FactsDiff {
    urlChanged: boolean;
    titleChanged: boolean;
    focused: any;
    target: any;
    valueChanged: boolean;
    checkedChanged: boolean;
    selectedIndexChanged: boolean;
    visibleErrors: string[];
}

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
