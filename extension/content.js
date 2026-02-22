// Aether — AI Browser Controller — Agent Visual Overlay
// Provides visual feedback when the AI agent is controlling the browser

(function () {
    if (window.__aether_agent_overlay_injected) return;
    window.__aether_agent_overlay_injected = true;

    let overlayActive = false;
    let borderEl = null;
    let badgeEl = null;
    let styleEl = null;

    function injectStyles() {
        if (styleEl) return;
        styleEl = document.createElement("style");
        styleEl.textContent = `
            @keyframes mcp-gradient-flow {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
            }

            @keyframes mcp-badge-slide-in {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }

            @keyframes mcp-badge-pulse {
                0%, 100% { box-shadow: 0 4px 24px rgba(37, 99, 235, 0.3); }
                50% { box-shadow: 0 4px 32px rgba(37, 99, 235, 0.6); }
            }

            @keyframes mcp-ripple {
                0% { transform: translate(-50%, -50%) scale(0); opacity: 1; }
                100% { transform: translate(-50%, -50%) scale(3); opacity: 0; }
            }

            @keyframes mcp-cursor-blink {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.3; }
            }

            #mcp-agent-border {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                pointer-events: none;
                z-index: 2147483646;
                border: 3px solid transparent;
                border-image: linear-gradient(135deg, #3b82f6, #8b5cf6, #06b6d4, #3b82f6) 1;
                background: linear-gradient(135deg, #3b82f6, #8b5cf6, #06b6d4, #3b82f6) border-box;
                background-size: 300% 300%;
                -webkit-mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
                -webkit-mask-composite: xor;
                mask-composite: exclude;
                animation: mcp-gradient-flow 3s ease infinite;
                opacity: 0;
                transition: opacity 0.3s ease;
            }

            #mcp-agent-border.active {
                opacity: 1;
            }

            #mcp-agent-badge {
                position: fixed;
                top: 12px;
                right: 12px;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 14px;
                border-radius: 8px;
                background: rgba(15, 23, 42, 0.9);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 1px solid rgba(59, 130, 246, 0.4);
                color: #93c5fd;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 12px;
                font-weight: 600;
                letter-spacing: 0.5px;
                pointer-events: none;
                animation: mcp-badge-slide-in 0.4s ease, mcp-badge-pulse 2s ease-in-out infinite;
                opacity: 0;
                transition: opacity 0.3s ease;
            }

            #mcp-agent-badge.active {
                opacity: 1;
            }

            #mcp-agent-badge .mcp-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #3b82f6;
                box-shadow: 0 0 8px #3b82f6;
                animation: mcp-cursor-blink 1.5s ease-in-out infinite;
            }

            #mcp-badge-text {
                transition: opacity 0.2s ease;
            }

            .mcp-click-ripple {
                position: fixed;
                width: 24px;
                height: 24px;
                border-radius: 50%;
                border: 2px solid #3b82f6;
                background: rgba(59, 130, 246, 0.2);
                pointer-events: none;
                z-index: 2147483646;
                animation: mcp-ripple 0.6s ease-out forwards;
            }

            .mcp-type-indicator {
                position: fixed;
                z-index: 2147483646;
                pointer-events: none;
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 4px 10px;
                border-radius: 12px;
                background: rgba(15, 23, 42, 0.85);
                backdrop-filter: blur(8px);
                border: 1px solid rgba(59, 130, 246, 0.3);
                color: #93c5fd;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 11px;
                font-weight: 500;
                animation: mcp-badge-slide-in 0.3s ease;
            }

            .mcp-type-indicator .mcp-cursor {
                display: inline-block;
                width: 2px;
                height: 14px;
                background: #3b82f6;
                animation: mcp-cursor-blink 0.8s ease-in-out infinite;
            }
        `;
        document.head.appendChild(styleEl);
    }

    function showOverlay() {
        if (overlayActive) return;
        overlayActive = true;
        injectStyles();

        if (!borderEl) {
            borderEl = document.getElementById("mcp-agent-border");
            if (!borderEl) {
                borderEl = document.createElement("div");
                borderEl.id = "mcp-agent-border";
                document.body.appendChild(borderEl);
            }
        }
        if (!badgeEl) {
            badgeEl = document.getElementById("mcp-agent-badge");
            if (!badgeEl) {
                badgeEl = document.createElement("div");
                badgeEl.id = "mcp-agent-badge";
                badgeEl.innerHTML = '<span class="mcp-dot"></span> <span id="mcp-badge-text">Agent Controlled</span>';
                document.body.appendChild(badgeEl);
            }
        }

        requestAnimationFrame(() => {
            borderEl.classList.add("active");
            badgeEl.classList.add("active");
        });
    }

    function hideOverlay() {
        overlayActive = false;
        if (borderEl) borderEl.classList.remove("active");
        if (badgeEl) badgeEl.classList.remove("active");
        // Reset badge text
        const textEl = document.getElementById("mcp-badge-text");
        if (textEl) textEl.textContent = "Agent Controlled";
    }

    function updateBadgeStatus(text) {
        showOverlay();
        const textEl = document.getElementById("mcp-badge-text");
        if (textEl) {
            textEl.style.opacity = "0";
            setTimeout(() => {
                textEl.textContent = text || "Agent Controlled";
                textEl.style.opacity = "1";
            }, 150);
        }
    }

    function showClickRipple(x, y) {
        injectStyles();
        const ripple = document.createElement("div");
        ripple.className = "mcp-click-ripple";
        ripple.style.left = x + "px";
        ripple.style.top = y + "px";
        document.body.appendChild(ripple);
        ripple.addEventListener("animationend", () => ripple.remove());
    }

    function showTypeIndicator(x, y) {
        injectStyles();
        const indicator = document.createElement("div");
        indicator.className = "mcp-type-indicator";
        indicator.style.left = (x + 10) + "px";
        indicator.style.top = (y - 30) + "px";
        indicator.innerHTML = '<span class="mcp-cursor"></span> Typing...';
        document.body.appendChild(indicator);
        setTimeout(() => {
            indicator.style.transition = "opacity 0.3s";
            indicator.style.opacity = "0";
            setTimeout(() => indicator.remove(), 300);
        }, 1500);
    }

    // Listen for messages from the background script
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        switch (msg.type) {
            case "agent_start":
                showOverlay();
                break;
            case "agent_stop":
                hideOverlay();
                break;
            case "show_click":
                showOverlay();
                showClickRipple(msg.x, msg.y);
                break;
            case "show_type":
                showOverlay();
                showTypeIndicator(msg.x || 400, msg.y || 300);
                break;
            case "update_status":
                updateBadgeStatus(msg.text);
                break;
        }
    });
})();
