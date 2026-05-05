document.addEventListener('DOMContentLoaded', () => {
    const statusBadge = document.getElementById('statusBadge');
    const statusText = statusBadge.querySelector('.status-text');
    const qrCard = document.getElementById('qrCard');
    const qrContainer = document.getElementById('qrContainer');
    const qrStatus = document.getElementById('qrStatus');
    const logsContainer = document.getElementById('logsContainer');
    const clearLogsBtn = document.getElementById('clearLogs');
    const autoScrollCheck = document.getElementById('autoScroll');

    let isReady = false;

    // --- Status Polling ---
    async function checkStatus() {
        try {
            const response = await fetch('/api/status');
            const data = await response.json();
            
            isReady = data.ready;
            
            if (isReady) {
                statusBadge.classList.add('ready');
                statusText.textContent = `Connected as ${data.info?.pushname || 'Assistant'}`;
                qrCard.style.display = 'none';
            } else {
                statusBadge.classList.remove('ready');
                statusText.textContent = 'Awaiting Authentication';
                fetchQR(); // Try to fetch QR if not ready
            }
        } catch (error) {
            console.error('Status check failed:', error);
            statusText.textContent = 'Server Offline';
            statusBadge.classList.remove('ready');
        }
    }

    // --- QR Code Fetching ---
    async function fetchQR() {
        if (isReady) return;

        try {
            const response = await fetch('/api/admin/qr');
            const data = await response.json();

            if (data.success && data.qrImage) {
                qrCard.style.display = 'block';
                qrContainer.innerHTML = `<img src="${data.qrImage}" alt="WhatsApp QR Code">`;
                qrStatus.textContent = 'Scan with WhatsApp to link';
            } else {
                qrStatus.textContent = 'Generating QR code...';
            }
        } catch (error) {
            console.error('QR fetch failed:', error);
        }
    }

    // --- SSE Logging ---
    function setupLogStream() {
        const eventSource = new EventSource('/api/logs/stream');

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'initial') {
                logsContainer.innerHTML = '';
                data.logs.forEach(addLogEntry);
            } else if (data.type === 'qr') {
                handleQRUpdate(data);
            } else if (data.type === 'clear') {
                logsContainer.innerHTML = '';
            } else {
                addLogEntry(data);
            }
        };

        eventSource.onerror = (error) => {
            console.error('SSE Error:', error);
            eventSource.close();
            // Reconnect after 3 seconds
            setTimeout(setupLogStream, 3000);
        };
    }

    function addLogEntry(log) {
        const entry = document.createElement('div');
        entry.className = `log-entry ${log.level || 'info'}`;
        
        const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '--:--:--';
        
        entry.innerHTML = `
            <span class="log-time">[${time}]</span>
            <span class="log-msg">${escapeHTML(log.message)}</span>
        `;

        logsContainer.appendChild(entry);

        if (autoScrollCheck.checked) {
            logsContainer.scrollTop = logsContainer.scrollHeight;
        }

        // Limit visible logs for performance
        if (logsContainer.children.length > 200) {
            logsContainer.removeChild(logsContainer.firstChild);
        }
    }

    function handleQRUpdate(data) {
        if (data.qrImage) {
            qrCard.style.display = 'block';
            qrContainer.innerHTML = `<img src="${data.qrImage}" alt="WhatsApp QR Code">`;
            qrStatus.textContent = 'Scan with WhatsApp to link';
        } else {
            qrCard.style.display = 'none';
        }
    }

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // --- Event Listeners ---
    clearLogsBtn.addEventListener('click', () => {
        logsContainer.innerHTML = '';
    });

    // Start everything
    setupLogStream();
    checkStatus();
    setInterval(checkStatus, 5000); // Poll status every 5s
});
