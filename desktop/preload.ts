import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  boardsState: () => ipcRenderer.invoke("boards:state"),
  chooseBoardsDatabase: (kind: string) => ipcRenderer.invoke("boards:choose-database", kind),
  retryBoardsSave: () => ipcRenderer.invoke("boards:retry-save"),
  saveBoardsRecovery: () => ipcRenderer.invoke("boards:save-recovery"),
  addBoards: (inputs: unknown) => ipcRenderer.invoke("boards:add", inputs),
  updateBoard: (id: string, input: unknown) => ipcRenderer.invoke("boards:update", id, input),
  removeBoard: (id: string) => ipcRenderer.invoke("boards:remove", id),
  checkBoards: (ids?: string[]) => ipcRenderer.invoke("boards:check", ids),
  cancelBoardCheck: (id: string) => ipcRenderer.invoke("boards:cancel", id),
  markBoardReviewed: (id: string, through: number) => ipcRenderer.invoke("boards:reviewed", id, through),
  onBoardsChanged: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on("boards:changed", listener);
    return () => ipcRenderer.removeListener("boards:changed", listener);
  },
  cancelAnalysis: (id: string) => ipcRenderer.invoke("desktop:cancel-analysis", id),
  onAnalysisProgress: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on("desktop:analysis-progress", listener);
    return () => ipcRenderer.removeListener("desktop:analysis-progress", listener);
  },
  state: () => ipcRenderer.invoke("desktop:state"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:check-updates"),
  openStoreUpdates: () => ipcRenderer.invoke("desktop:open-store-updates"),
  downloadUpdate: () => ipcRenderer.invoke("desktop:download-update"),
  installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
  confirmUpdateLoaded: () => ipcRenderer.invoke("desktop:confirm-update-loaded"),
  onUpdatesChanged: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on("desktop:updates-changed", listener);
    return () => ipcRenderer.removeListener("desktop:updates-changed", listener);
  },
  chooseDatabase: (kind: "open" | "create") => ipcRenderer.invoke("desktop:choose-database", kind),
  retrySync: () => ipcRenderer.invoke("desktop:retry-sync"),
  setApiKey: (value: string) => ipcRenderer.invoke("desktop:set-api-key", value),
  setAnthropicKey: (value: string) => ipcRenderer.invoke("desktop:set-anthropic-key", value),
  setOnlineModel: (provider: string, model: string) => ipcRenderer.invoke("desktop:set-online-model", provider, model),
  setThinkingLevel: (value: unknown) => ipcRenderer.invoke("desktop:set-thinking-level", value),
  refreshCredits: () => ipcRenderer.invoke("desktop:refresh-credits"),
  refreshCreditAccess: () => ipcRenderer.invoke("desktop:refresh-credit-access"),
  saveCreditRecoveryCode: (rotate = false) => ipcRenderer.invoke("desktop:save-credit-recovery", rotate),
  connectCreditWallet: (kind: string, code: string) => ipcRenderer.invoke("desktop:connect-credit-wallet", kind, code),
  createCreditPairing: () => ipcRenderer.invoke("desktop:create-credit-pairing"),
  cancelCreditPairing: () => ipcRenderer.invoke("desktop:cancel-credit-pairing"),
  removeCreditDevice: (id: string) => ipcRenderer.invoke("desktop:remove-credit-device", id),
  warmCreditsService: () => ipcRenderer.invoke("desktop:warm-credits-service"),
  startCreditCheckout: (pack: string) => ipcRenderer.invoke("desktop:start-credit-checkout", pack),
  creditCheckoutStatus: (id: string) => ipcRenderer.invoke("desktop:credit-checkout-status", id),
  quoteCreditAnalysis: (source: unknown) => ipcRenderer.invoke("desktop:quote-credit-analysis", source),
  onCreditsChanged: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("desktop:credits-changed", listener);
    return () => ipcRenderer.removeListener("desktop:credits-changed", listener);
  },
  setAnalysisProvider: (value: string) => ipcRenderer.invoke("desktop:set-analysis-provider", value),
  setOllamaConfig: (value: { url: string; model: string }) => ipcRenderer.invoke("desktop:set-ollama-config", value),
  listOllamaModels: (url: string) => ipcRenderer.invoke("desktop:list-ollama-models", url),
  ollamaThinkingCapability: (url: string, model: string) => ipcRenderer.invoke("desktop:ollama-thinking-capability", url, model),
  selectLocalModel: (id: string) => ipcRenderer.invoke("desktop:select-local-model", id),
  pauseModelDownload: () => ipcRenderer.invoke("desktop:pause-model-download"),
  stopModelDownload: (id: string) => ipcRenderer.invoke("desktop:stop-model-download", id),
  resumeModelDownload: (id: string, termsVersion?: string) => ipcRenderer.invoke("desktop:resume-model-download", id, termsVersion),
  deleteLocalModel: (id: string) => ipcRenderer.invoke("desktop:delete-local-model", id),
  openModelFolder: () => ipcRenderer.invoke("desktop:open-model-folder"),
  setAppearance: (value: "auto" | "dark" | "light") => ipcRenderer.invoke("desktop:set-appearance", value),
  setSidebarCollapsed: (value: boolean) => ipcRenderer.invoke("desktop:set-sidebar-collapsed", value),
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  downloadResume: (id: string) => ipcRenderer.invoke("desktop:download-resume", id),
  revealTailoredResume: (id: string, format: "docx" | "pdf") => ipcRenderer.invoke("desktop:reveal-tailored-resume", id, format),
  onDatabaseChanged: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("desktop:database-changed", listener);
    return () => ipcRenderer.removeListener("desktop:database-changed", listener);
  },
  onNavigate: (callback: (target: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, target: string) => callback(target);
    ipcRenderer.on("desktop:navigate", listener);
    return () => ipcRenderer.removeListener("desktop:navigate", listener);
  },
  onLocalModelsChanged: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on("desktop:local-models-changed", listener);
    return () => ipcRenderer.removeListener("desktop:local-models-changed", listener);
  },
});

window.addEventListener("error", (event) => {
  ipcRenderer.send("desktop:renderer-error", event.error?.stack || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  ipcRenderer.send("desktop:renderer-error", reason instanceof Error ? reason.stack || reason.message : String(reason));
});
