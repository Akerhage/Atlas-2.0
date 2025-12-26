const { contextBridge, ipcRenderer } = require('electron');

// Preload.js - Version 2.0 - OBS: Vi tar bort 'socket.io-client' härifrån. 
// Renderer.js sköter nu uppkopplingen för att få med Auth-token korrekt!

contextBridge.exposeInMainWorld('electronAPI', {

    // === App Info ===
    getAppInfo: () => ipcRenderer.invoke('get-app-info'),

    // === System & Urklipp ===
    copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
    
    // Hämtar Windows-användarnamn
    getSystemUsername: () => ipcRenderer.invoke('get-system-username'),

    onProcessClipboard: (callback) => {
        const subscription = (_event, text, shouldClear) => callback(text, shouldClear);
        ipcRenderer.on('process-clipboard-text', subscription);
        return () => ipcRenderer.removeListener('process-clipboard-text', subscription);
    },

    // === Mallar (Databas) ===
    loadTemplates: () => ipcRenderer.invoke('load-templates'),
    saveTemplates: (templates) => ipcRenderer.invoke('save-templates', templates),
    deleteTemplate: (templateId) => ipcRenderer.invoke('delete-template', templateId),

    // === Inkorg / QA History (Databas) ===
    saveQA: (qaItem) => ipcRenderer.invoke('save-qa', qaItem),
    loadQAHistory: () => ipcRenderer.invoke('load-qa-history'),
    deleteQA: (qaId) => ipcRenderer.invoke('delete-qa', qaId),
    
    // NYTT: Denna rad krävs för att Arkivera-knappen ska fungera i appen!
    updateQAArchivedStatus: (id, status) => ipcRenderer.invoke('update-qa-archived-status', { id, status })
});

// === TEAM / LIVE KÖ ===
contextBridge.exposeInMainWorld('atlasTeam', {
    fetchInbox: () => ipcRenderer.invoke('team:fetch-inbox'),
    claimTicket: (id, agentName) => ipcRenderer.invoke('team:claim-ticket', id, agentName)
});

// NOTERA: 'socketAPI' är borttagen härifrån. 
// Den definieras nu direkt i renderer.js när scriptet laddas från servern.