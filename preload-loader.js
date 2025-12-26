const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {  // ✅ ÄNDRAT: electron → electronAPI

    // Din befintliga funktion
    onServerStatus: (callback) => {
        ipcRenderer.on('server-status', (event, status) => {
            callback(status);
        });
    },

    // 👉 Detta är det ENDA som behövs för att starta Atlas omedelbart vid GRÖNT
    loaderDone: () => ipcRenderer.send('loader:done')
});
