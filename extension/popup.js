document.addEventListener("DOMContentLoaded", () => {
    const statusCard = document.getElementById("status");
    const statusText = statusCard.querySelector(".status-text");
    const reconnectBtn = document.getElementById("reconnect");

    function checkStatus() {
        chrome.runtime.sendMessage({ type: "status" }, (response) => {
            if (chrome.runtime.lastError || !response) {
                statusCard.className = "status-card disconnected";
                statusText.textContent = "Service Worker Inactive";
                return;
            }
            if (response.connected) {
                statusCard.className = "status-card connected";
                statusText.textContent = "Connected to Server";
            } else {
                statusCard.className = "status-card disconnected";
                statusText.textContent = "Disconnected";
            }
        });
    }

    reconnectBtn.addEventListener("click", () => {
        reconnectBtn.textContent = "Reconnecting...";
        reconnectBtn.disabled = true;
        chrome.runtime.sendMessage({ type: "reconnect" });
        setTimeout(() => {
            reconnectBtn.textContent = "⟳ Reconnect";
            reconnectBtn.disabled = false;
            checkStatus();
        }, 2000);
    });

    checkStatus();
    setInterval(checkStatus, 3000);
});
