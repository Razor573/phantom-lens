import { getStoreValue, setStoreValue } from "./main";
import { initializeIpcHandlerDeps } from "./main";
import { ipcMain, screen, shell } from "electron";
import { app } from "electron";
import * as fs from "fs";
import { secureConfig } from "./config";
import { updateService } from "./UpdateService";
import { getAppOpenCount, resetAppOpenCount } from "./UsageCounter";
import { vertexAIService, VertexAIService } from "./services/VertexAIService";

// ============================================================================
// Enhanced Error Handling Wrapper
// ============================================================================
interface IpcResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

function createIpcHandler<T extends any[], R>(
  handler: (...args: T) => Promise<R> | R,
  handlerName: string
) {
  return async (...args: T): Promise<IpcResponse<R>> => {
    try {
      const result = await handler(...args);
      return { success: true, data: result };
    } catch (error: any) {
      console.error(`IPC Handler [${handlerName}] error:`, error);
      return { 
        success: false, 
        error: error.message || String(error) 
      };
    }
  };
}

function createSafeIpcHandler<T extends any[], R>(
  handler: (...args: T) => Promise<IpcResponse<R>> | IpcResponse<R>,
  handlerName: string
) {
  return async (...args: T): Promise<IpcResponse<R>> => {
    try {
      const result = await handler(...args);
      return result;
    } catch (error: any) {
      console.error(`Safe IPC Handler [${handlerName}] error:`, error);
      return { 
        success: false, 
        error: error.message || String(error) 
      };
    }
  };
}

// ============================================================================
// FIXED: NO MORE BATCHING - Direct dimension updates only
// ============================================================================

export function initializeIpcHandlers(deps: initializeIpcHandlerDeps): void {
  console.log("FIXED: Initializing IPC handlers with DIRECT dimension updates (NO BATCHING)");

  // ============================================================================
  // API Configuration Handlers
  // ============================================================================

  // Make sure the Vertex AI singleton uses the stored service-account key
  // (if the user pasted one) rather than gcloud ADC.
  async function ensureVertexCredentials(): Promise<void> {
    try {
      const stored = (await getStoreValue("vertex-service-account")) || "";
      vertexAIService.setServiceAccountJson(stored || null);
    } catch (e) {
      console.warn("Could not apply stored Vertex AI credentials:", e);
    }
  }

  ipcMain.handle("get-api-config", createSafeIpcHandler(async () => {
    try {
      await ensureVertexCredentials();
      const provider = (await getStoreValue("api-provider")) || "gemini";
      const model = (await getStoreValue("api-model")) || "gemini-3-flash-preview";
      const thinkingLevel = (await getStoreValue("gemini-thinking-level")) || "MEDIUM";
      const vertexProject =
        (await getStoreValue("vertex-project")) ||
        process.env.VERTEX_PROJECT ||
        vertexAIService.getProjectIdFromKey() ||
        "";
      const vertexLocation =
        (await getStoreValue("vertex-location")) ||
        process.env.VERTEX_LOCATION ||
        "global";
      const webSearch = (await getStoreValue("web-search")) === true;

      const geminiApiKey = ((await getStoreValue("api-key")) as string) || "";
      const groqApiKey = ((await getStoreValue("groq-api-key")) as string) || "";
      const vertexServiceAccount = ((await getStoreValue("vertex-service-account")) as string) || "";
      const geminiKeySaved = !!geminiApiKey;
      const groqKeySaved = !!groqApiKey;
      const vertexKeySaved = !!vertexServiceAccount;

      const apiKey = provider === "groq" ? groqApiKey : provider === "vertex" ? "" : geminiApiKey;

      return {
        success: true,
        data: {
          apiKey,
          geminiApiKey,
          groqApiKey,
          geminiKeySaved,
          groqKeySaved,
          vertexKeySaved,
          model,
          provider,
          thinkingLevel,
          vertexProject,
          vertexLocation,
          webSearch
        }
      };
    } catch (error: any) {
      console.error("Error getting API config:", error);
      return { success: false, error: "Failed to retrieve API config" };
    }
  }, "get-api-config"));

  ipcMain.handle("set-api-config", createSafeIpcHandler(async (
    _event: any,
    config: { apiKey?: string; model: string; provider?: string; thinkingLevel?: string; vertexProject?: string; vertexLocation?: string; vertexServiceAccount?: string; webSearch?: boolean }
  ) => {
    try {
      const { apiKey, model } = config;
      const provider = config.provider === "groq" ? "groq" : config.provider === "vertex" ? "vertex" : "gemini";

      // Vertex AI: no API key - needs a GCP project ID (+ region).
      // Keys are kept per-provider so switching providers never loses
      // the other provider's key.
      if (provider === "vertex") {
        // Pasted service-account key is optional (ADC fallback); validate
        // when provided and apply first so project_id can be inferred from it.
        const pastedKey = (config.vertexServiceAccount || "").trim();
        if (pastedKey) {
          try {
            VertexAIService.validateServiceAccountJson(pastedKey);
            vertexAIService.setServiceAccountJson(pastedKey);
          } catch (e: any) {
            return { success: false, error: e.message || "Invalid service account key" };
          }
        } else {
          await ensureVertexCredentials();
        }
        const storedProject = ((await getStoreValue("vertex-project")) as string) || "";
        const vertexProject = (
          config.vertexProject ||
          vertexAIService.getProjectIdFromKey() ||
          storedProject ||
          ""
        ).trim();
        const vertexLocation = (config.vertexLocation || "global").trim() || "global";
        if (!vertexProject) {
          return { success: false, error: "Vertex AI needs a GCP project ID" };
        }
        if (!model || typeof model !== "string" || !model.trim()) {
          return { success: false, error: "Invalid model selection" };
        }
        const thinkingLevel = ["LOW", "MEDIUM", "HIGH"].includes(config.thinkingLevel || "")
          ? config.thinkingLevel!
          : "MEDIUM";
        const webSearch = config.webSearch === true;
        const saves: Promise<boolean>[] = [
          setStoreValue("vertex-project", vertexProject),
          setStoreValue("vertex-location", vertexLocation),
          setStoreValue("api-model", model.trim()),
          setStoreValue("api-provider", provider),
          setStoreValue("gemini-thinking-level", thinkingLevel),
          setStoreValue("web-search", webSearch)
        ];
        if (pastedKey) saves.push(setStoreValue("vertex-service-account", pastedKey));
        const results = await Promise.all(saves);
        if (results.some((r) => !r)) {
          return { success: false, error: "Failed to save configuration to storage" };
        }
        await ensureVertexCredentials();
        process.env.API_PROVIDER = provider;
        process.env.VERTEX_PROJECT = vertexProject;
        process.env.VERTEX_LOCATION = vertexLocation;
        process.env.API_MODEL = model.trim();
        const mainWindow = deps.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("api-key-updated");
        }
        const vertexKeySaved = pastedKey ? true : !!((await getStoreValue("vertex-service-account")) || "");
        const geminiApiKey = ((await getStoreValue("api-key")) as string) || "";
        const groqApiKey = ((await getStoreValue("groq-api-key")) as string) || "";
        const geminiKeySaved = !!geminiApiKey;
        const groqKeySaved = !!groqApiKey;

        console.log(`API configuration saved: Provider=vertex, Model=${model.trim()}, Project=${vertexProject}`);
        return {
          success: true,
          data: {
            apiKey: "***",
            geminiApiKey,
            groqApiKey,
            geminiKeySaved,
            groqKeySaved,
            model: model.trim(),
            provider,
            thinkingLevel,
            vertexProject,
            vertexLocation,
            vertexKeySaved,
            webSearch
          }
        };
      }

      const keyName = provider === "groq" ? "groq-api-key" : "api-key";
      const existingStoredKey = ((await getStoreValue(keyName)) as string) || "";
      const newKey = typeof apiKey === "string" ? apiKey.trim() : "";
      const effectiveApiKey = (newKey && newKey !== "***") ? newKey : existingStoredKey;

      if (!effectiveApiKey) {
        return {
          success: false,
          error: `Invalid ${provider === "groq" ? "Groq" : "Gemini"} API key provided`
        };
      }

      if (!model || typeof model !== "string" || !model.trim()) {
        return { success: false, error: "Invalid model selection" };
      }

      // Thinking level only applies to the Gemini provider (Gemini 3 models).
      const thinkingLevel = ["LOW", "MEDIUM", "HIGH"].includes(config.thinkingLevel || "")
        ? config.thinkingLevel!
        : "MEDIUM";

      // Store the configuration (keys are kept per-provider so switching
      // providers never loses the other provider's key)
      const webSearch = config.webSearch === true;
      const saves: Promise<boolean>[] = [
        setStoreValue("api-model", model.trim()),
        setStoreValue("api-provider", provider),
        setStoreValue("gemini-thinking-level", thinkingLevel),
        setStoreValue("web-search", webSearch)
      ];
      if (newKey && newKey !== "***") {
        saves.push(setStoreValue(keyName, effectiveApiKey));
      }

      const results = await Promise.all(saves);
      if (results.some((r) => !r)) {
        console.error("Failed to save one or more API config values to store.");
        return {
          success: false,
          error: "Failed to save configuration to storage"
        };
      }

      // Set environment variables
      process.env.API_KEY = effectiveApiKey;
      process.env.API_MODEL = model.trim();
      process.env.API_PROVIDER = provider;

      // Notify that the config has been updated
      const mainWindow = deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("api-key-updated");
      }

      const geminiApiKey = provider === "gemini" ? effectiveApiKey : (((await getStoreValue("api-key")) as string) || "");
      const groqApiKey = provider === "groq" ? effectiveApiKey : (((await getStoreValue("groq-api-key")) as string) || "");
      const geminiKeySaved = !!geminiApiKey;
      const groqKeySaved = !!groqApiKey;
      const vertexKeySaved = !!((await getStoreValue("vertex-service-account")) || "");

      console.log(`API configuration saved: Model=${model.trim()}`);
      return {
        success: true,
        data: {
          apiKey: "***",
          geminiApiKey,
          groqApiKey,
          geminiKeySaved,
          groqKeySaved,
          model: model.trim(),
          provider,
          thinkingLevel,
          vertexProject: "",
          vertexLocation: "",
          vertexKeySaved,
          webSearch
        }
      };
      
    } catch (error: any) {
      console.error("Error setting API configuration:", error);
      return { success: false, error: "Failed to save configuration" };
    }
  }, "set-api-config"));

  ipcMain.handle("list-gemini-models", createSafeIpcHandler(async () => {
    try {
      const apiKey = await getStoreValue("api-key");
      if (!apiKey) {
        return { success: false, error: "No API key configured" };
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
      );
      if (!response.ok) {
        return { success: false, error: `Gemini API returned status ${response.status}` };
      }

      const data: any = await response.json();
      const models = (data.models || [])
        .filter((m: any) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes("generateContent")
        )
        .map((m: any) => ({
          id: String(m.name || "").replace(/^models\//, ""),
          name: m.displayName || String(m.name || "").replace(/^models\//, ""),
        }))
        .filter((m: any) => m.id);

      return { success: true, data: { models } };
    } catch (error: any) {
      console.error("Error listing Gemini models:", error);
      return { success: false, error: "Failed to fetch model list" };
    }
  }, "list-gemini-models"));

  // Vertex AI: dynamic catalogue from the publisher models API, authenticated
  // with the user's gcloud ADC (same pattern as listGeminiModels).
  // Accepts optional test params to validate a pasted-but-unsaved key.
  ipcMain.handle("list-vertex-models", createSafeIpcHandler(async (_event: any, testParams?: { key?: string; projectId?: string; location?: string }) => {
    try {
      let service = vertexAIService;
      let projectId: string;
      let location: string;
      if (testParams && (testParams.key || testParams.projectId || testParams.location)) {
        // Test mode: use the provided key/project without saving anything.
        const testKey = (testParams.key || "").trim();
        if (testKey) {
          VertexAIService.validateServiceAccountJson(testKey);
          service = new VertexAIService();
          service.setServiceAccountJson(testKey);
        } else {
          await ensureVertexCredentials();
        }
        const storedProject = (await getStoreValue("vertex-project")) || "";
        const storedLocation = (await getStoreValue("vertex-location")) || "";
        projectId = (
          testParams.projectId ||
          service.getProjectIdFromKey() ||
          storedProject ||
          process.env.VERTEX_PROJECT ||
          vertexAIService.getProjectIdFromKey() ||
          ""
        ).trim();
        location = (testParams.location || storedLocation || process.env.VERTEX_LOCATION || "global").trim() || "global";
      } else {
        await ensureVertexCredentials();
        projectId = (
          (await getStoreValue("vertex-project")) ||
          process.env.VERTEX_PROJECT ||
          vertexAIService.getProjectIdFromKey() ||
          ""
        ).trim();
        location = ((await getStoreValue("vertex-location")) || process.env.VERTEX_LOCATION || "global").trim() || "global";
      }
      if (!projectId) {
        return { success: false, error: "Set your GCP project ID first" };
      }
      const models = await service.listModels(projectId, location);
      return { success: true, data: { models } };
    } catch (error: any) {
      console.error("Error listing Vertex AI models:", error);
      return { success: false, error: error.message || "Failed to fetch Vertex AI model list" };
    }
  }, "list-vertex-models"));

  // Vertex AI: minimal prediction test against a specific model. Sends a tiny
  // prompt and returns the first text chunk, proving the model actually
  // answers (the list endpoint alone doesn't guarantee that).
  ipcMain.handle("test-vertex-prediction", createSafeIpcHandler(async (_event: any, params?: { key?: string; projectId?: string; location?: string; model?: string }) => {
    try {
      let service = vertexAIService;
      const testKey = (params?.key || "").trim();
      if (testKey) {
        VertexAIService.validateServiceAccountJson(testKey);
        service = new VertexAIService();
        service.setServiceAccountJson(testKey);
      } else {
        await ensureVertexCredentials();
      }
      const storedProject = (await getStoreValue("vertex-project")) || "";
      const storedLocation = (await getStoreValue("vertex-location")) || "";
      const projectId = (
        params?.projectId ||
        service.getProjectIdFromKey() ||
        storedProject ||
        process.env.VERTEX_PROJECT ||
        vertexAIService.getProjectIdFromKey() ||
        ""
      ).trim();
      const location = (params?.location || storedLocation || process.env.VERTEX_LOCATION || "global").trim() || "global";
      const model = (params?.model || "").trim();
      if (!projectId) return { success: false, error: "Set your GCP project ID first" };
      if (!model) return { success: false, error: "Pick a model first" };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let text = "";
      try {
        for await (const chunk of service.streamGenerateContent({
          projectId,
          location,
          model,
          prompt: "Reply with exactly: OK",
          base64Images: [],
          signal: controller.signal,
        })) {
          text += chunk;
          if (text.trim().length >= 2) break; // enough to prove it works
        }
      } finally {
        clearTimeout(timeout);
      }
      if (!text.trim()) {
        return { success: false, error: "Model returned an empty response" };
      }
      return { success: true, data: { reply: text.trim().slice(0, 100) } };
    } catch (error: any) {
      console.error("Error testing Vertex AI prediction:", error);
      const msg = error?.name === "AbortError" ? "Request timed out after 30s" : (error.message || "Prediction test failed");
      return { success: false, error: msg };
    }
  }, "test-vertex-prediction"));

  // Groq uses an OpenAI-compatible API: GET /openai/v1/models with a Bearer key.
  ipcMain.handle("list-groq-models", createSafeIpcHandler(async () => {
    try {
      const apiKey = await getStoreValue("groq-api-key");
      if (!apiKey) {
        return { success: false, error: "No Groq API key configured" };
      }

      const response = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        return { success: false, error: `Groq API returned status ${response.status}` };
      }

      const data: any = await response.json();
      const models = (data.data || [])
        .map((m: any) => ({
          id: String(m.id || ""),
          name: String(m.id || ""),
        }))
        .filter((m: any) => m.id)
        .sort((a: any, b: any) => a.id.localeCompare(b.id));

      return { success: true, data: { models } };
    } catch (error: any) {
      console.error("Error listing Groq models:", error);
      return { success: false, error: "Failed to fetch model list" };
    }
  }, "list-groq-models"));

  // ============================================================================
  // Usage Counter Handlers
  // ============================================================================
  ipcMain.handle("get-app-open-count", createSafeIpcHandler(async () => {
    try {
      const count = await getAppOpenCount();
      return { success: true, data: { count } };
    } catch (error: any) {
      console.error("Error getting app open count:", error);
      return { success: false, error: "Failed to get app open count" };
    }
  }, "get-app-open-count"));

  ipcMain.handle("set-stats-server-endpoint", createSafeIpcHandler(async (
    _event: any,
    endpoint: string
  ) => {
    try {
      if (!endpoint || typeof endpoint !== "string") {
        return { success: false, error: "Invalid endpoint provided" };
      }

      // Basic URL validation
      try {
        new URL(endpoint.trim());
      } catch {
        return { success: false, error: "Invalid URL format" };
      }

      await setStoreValue("stats-server-endpoint", endpoint.trim());
      console.log(`Stats server endpoint set to: ${endpoint.trim()}`);
      return { success: true };
    } catch (error: any) {
      console.error("Error setting stats server endpoint:", error);
      return { success: false, error: "Failed to set stats server endpoint" };
    }
  }, "set-stats-server-endpoint"));

  ipcMain.handle("get-stats-server-endpoint", createSafeIpcHandler(async () => {
    try {
      const endpoint = await getStoreValue("stats-server-endpoint");
      return { success: true, data: { endpoint: endpoint || null } };
    } catch (error: any) {
      console.error("Error getting stats server endpoint:", error);
      return { success: false, error: "Failed to get stats server endpoint" };
    }
  }, "get-stats-server-endpoint"));

  ipcMain.handle("reset-app-open-count", createSafeIpcHandler(async () => {
    try {
      const success = await resetAppOpenCount();
      return { success };
    } catch (error: any) {
      console.error("Error resetting app open count:", error);
      return { success: false, error: "Failed to reset app open count" };
    }
  }, "reset-app-open-count"));

  // ============================================================================
  // GitHub Release Update Check Handler
  // ============================================================================
  
  ipcMain.handle("check-github-update", createSafeIpcHandler(async () => {
    try {
      const result = await updateService.checkForUpdates();
      
      return {
        success: true,
        data: {
          updateAvailable: result.hasUpdate,
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          releaseUrl: result.releaseInfo?.releaseUrl || 'https://ph.inulute.com/dl',
          releaseName: result.releaseInfo?.version || '',
          publishedAt: result.releaseInfo?.publishedAt || '',
          releaseNotes: result.releaseInfo?.releaseNotes || '',
          error: result.error || ''
        }
      };
    } catch (error: any) {
      console.error("Error checking GitHub update:", error);
      // Don't fail silently - return current version info
      return { 
        success: true, 
        data: { 
          updateAvailable: false,
          currentVersion: app.getVersion(),
          latestVersion: app.getVersion(),
          releaseUrl: 'https://ph.inulute.com/dl',
          releaseName: '',
          publishedAt: '',
          releaseNotes: '',
          error: error.message || ''
        } 
      };
    }
  }, "check-github-update"));

  // Open update download URL
  ipcMain.handle("open-update-download", createSafeIpcHandler(async (
    _event: any,
    url?: string
  ) => {
    try {
      await updateService.openReleasesPage(url);
      const downloadUrl = url || 'https://phantom.inulute.com';
      console.log(`[IPC] Opened update download URL: ${downloadUrl}`);
      return { success: true, data: `Opened ${downloadUrl}` };
    } catch (error: any) {
      console.error("Error opening update download URL:", error);
      return { 
        success: false, 
        error: `Failed to open download URL: ${error.message}` 
      };
    }
  }, "open-update-download"));

  // ============================================================================
  // Screenshot Management Handlers
  // ============================================================================
  ipcMain.handle("get-screenshot-queue", createIpcHandler(() => {
    const queue = deps.getScreenshotQueue();
    console.log(`Retrieved screenshot queue: ${queue.length} items`);
    return queue;
  }, "get-screenshot-queue"));

  ipcMain.handle("get-extra-screenshot-queue", createIpcHandler(() => {
    const queue = deps.getExtraScreenshotQueue();
    console.log(`Retrieved extra screenshot queue: ${queue.length} items`);
    return queue;
  }, "get-extra-screenshot-queue"));

  ipcMain.handle("get-screenshots", createSafeIpcHandler(async () => {
    try {
      const currentView = deps.getView();
      let queue: string[];

      if (currentView === "initial") {
        queue = deps.getScreenshotQueue();
      } else {
        queue = deps.getExtraScreenshotQueue();
      }

      const previews = queue.map(path => ({ path }));

      console.log(`Retrieved ${previews.length} screenshots for view: ${currentView}`);
      return { 
        success: true, 
        data: { previews, view: currentView } 
      };
    } catch (error: any) {
      console.error("Error getting screenshots:", error);
      return { 
        success: false, 
        error: "Failed to retrieve screenshots" 
      };
    }
  }, "get-screenshots"));

  // ============================================================================
  // Screenshot Capture Handlers
  // ============================================================================
  ipcMain.handle("trigger-screenshot", createSafeIpcHandler(async () => {
    const mainWindow = deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { success: false, error: "Main window not available" };
    }

    try {
      const screenshotPath = await deps.takeScreenshot();
      
      // Notify UI immediately
      mainWindow.webContents.send("screenshot-taken", {
        path: screenshotPath,
      });

      console.log(`Screenshot captured and sent to UI: ${screenshotPath}`);
      return { success: true, data: { path: screenshotPath } };
    } catch (error: any) {
      console.error("Error triggering screenshot:", error);
      return { 
        success: false, 
        error: `Failed to capture screenshot: ${error.message}` 
      };
    }
  }, "trigger-screenshot"));

  ipcMain.handle("take-screenshot", createSafeIpcHandler(async () => {
    try {
      const screenshotPath = await deps.takeScreenshot();
      console.log(`Screenshot taken via direct call: ${screenshotPath}`);
      return { success: true, data: { path: screenshotPath } };
    } catch (error: any) {
      console.error("Error taking screenshot:", error);
      return { 
        success: false, 
        error: `Screenshot capture failed: ${error.message}` 
      };
    }
  }, "take-screenshot"));

  // ============================================================================
  // Processing Handlers
  // ============================================================================
  ipcMain.handle("process-screenshots", createSafeIpcHandler(async () => {
    if (!deps.processingHelper) {
      return { success: false, error: "Processing helper not available" };
    }

    try {
      await deps.processingHelper.processScreenshots();
      console.log("Screenshot processing initiated successfully");
      return { success: true, data: "Processing started" };
    } catch (error: any) {
      console.error("Error processing screenshots:", error);
      return { 
        success: false, 
        error: `Processing failed: ${error.message}` 
      };
    }
  }, "process-screenshots"));

  ipcMain.handle("trigger-process-screenshots", createSafeIpcHandler(async () => {
    if (!deps.processingHelper) {
      return { success: false, error: "Processing helper not available" };
    }

    try {
      await deps.processingHelper.processScreenshots();
      console.log("Screenshot processing triggered successfully");
      return { success: true, data: "Processing initiated" };
    } catch (error: any) {
      console.error("Error triggering screenshot processing:", error);
      return { 
        success: false, 
        error: `Failed to start processing: ${error.message}` 
      };
    }
  }, "trigger-process-screenshots"));

  // ===================== Follow-up Processing IPC =====================
  ipcMain.handle("process-follow-up", createSafeIpcHandler(async () => {
    try {
      if (!deps.processingHelper) {
        return { success: false, error: "Processing helper not available" };
      }

      // Trigger follow-up processing
      await deps.processingHelper.processFollowUp();
      return { success: true };
    } catch (error: any) {
      console.error("Error processing follow-up:", error);
      return { success: false, error: error.message || String(error) };
    }
  }, "process-follow-up"));

  // ===================== Processing Control IPC =====================
  ipcMain.handle("cancel-processing", createSafeIpcHandler(() => {
    try {
      if (deps.processingHelper) {
        deps.processingHelper.cancelOngoingRequests();
        console.log("Processing cancellation requested");
        return { success: true, data: "Processing canceled" };
      } else {
        return { success: false, error: "Processing helper not available" };
      }
    } catch (error: any) {
      console.error("Error canceling processing:", error);
      return { 
        success: false, 
        error: `Failed to cancel processing: ${error.message}` 
      };
    }
  }, "cancel-processing"));

  // ============================================================================
  // FIXED: Direct Dimension Updates - NO MORE BATCHING!
  // ============================================================================
  
  // Handler to set fixed width for response mode
  ipcMain.handle("set-fixed-response-width", createSafeIpcHandler(async () => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "Main window not available" };
      }

      // Get current window width and use it as the fixed width
      const currentBounds = mainWindow.getBounds();
      const fixedWidth = Math.max(currentBounds.width, 850);
      
      console.log(`[IPC-FIXED] Fixed response width would be: ${fixedWidth}px (current: ${currentBounds.width}px)`);
      // Don't actually store it here - let main process handle it
      return { success: true, data: { fixedWidth } };
    } catch (error: any) {
      console.error("Error setting fixed response width:", error);
      return { 
        success: false, 
        error: `Failed to set fixed width: ${error.message}` 
      };
    }
  }, "set-fixed-response-width"));

  // Handler to clear fixed width when returning to initial view
  ipcMain.handle("clear-fixed-response-width", createSafeIpcHandler(async () => {
    try {
      // Clear the locked width in main process
      deps.clearLockedResponseWidth();
      console.log("[IPC-FIXED] Fixed response width cleared");
      return { success: true };
    } catch (error: any) {
      console.error("Error clearing fixed response width:", error);
      return { 
        success: false, 
        error: `Failed to clear fixed width: ${error.message}` 
      };
    }
  }, "clear-fixed-response-width"));

  // FIXED: Direct dimension update handler - NO BATCHING
  ipcMain.handle("update-content-dimensions", createSafeIpcHandler(async (
    _event: any,
    dimensions: { width?: number | string; height: number }
  ) => {
    try {
      if (!dimensions || typeof dimensions.height !== 'number') {
        return { success: false, error: "Invalid dimensions provided" };
      }

      if (dimensions.height < 50) {
        console.warn("[IPC-FIXED] Suspiciously small dimensions received:", dimensions);
        return { success: false, error: "Dimensions too small" };
      }

      if (dimensions.height > 3000) {
        console.warn("[IPC-FIXED] Suspiciously large dimensions received:", dimensions);
        return { success: false, error: "Dimensions too large" };
      }

      const width = dimensions.width !== undefined ? dimensions.width : "fixed";
      const height = dimensions.height;

      console.log(`[IPC-FIXED] Direct dimension request: ${width} x ${height}`);
      
      // FIXED: Call the single dimension function directly - NO BATCHING
      deps.setWindowDimensions(width, height);

      return { success: true, data: { width, height } };
    } catch (error: any) {
      console.error("[IPC-FIXED] Dimension update error:", error);
      
      // EMERGENCY: Ensure safe state on error
      const mainWindow = deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFocusable(false);
        mainWindow.setIgnoreMouseEvents(true);
      }
      
      return { 
        success: false, 
        error: `Failed to update dimensions: ${error.message}` 
      };
    }
  }, "update-content-dimensions"));

  ipcMain.handle("toggle-window", createSafeIpcHandler(() => {
    try {
      deps.toggleMainWindow();
      console.log("[IPC-FIXED] Window toggle requested");
      return { success: true, data: "Window toggled" };
    } catch (error: any) {
      console.error("Error toggling window:", error);
      return { 
        success: false, 
        error: `Failed to toggle window: ${error.message}` 
      };
    }
  }, "toggle-window"));

  // ============================================================================
  // Reset and Queue Management Handlers
  // ============================================================================
  ipcMain.handle("reset-queues", createSafeIpcHandler(async () => {
    try {
      await deps.clearQueues();
      console.log("[IPC-FIXED] Queues reset successfully");
      return { success: true, data: "Queues cleared" };
    } catch (error: any) {
      console.error("Error resetting queues:", error);
      return { 
        success: false, 
        error: `Failed to reset queues: ${error.message}` 
      };
    }
  }, "reset-queues"));

  ipcMain.handle("trigger-reset", createSafeIpcHandler(() => {
    try {
      // Cancel ongoing processing first
      if (deps.processingHelper) {
        deps.processingHelper.cancelOngoingRequests();
      }

      // Clear locked width
      deps.clearLockedResponseWidth();

      // Clear queues
      deps.clearQueues();
      
      // Reset view
      deps.setView("initial");

      const mainWindow = deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Send reset events in sequence
        mainWindow.webContents.send("reset-view");
        mainWindow.webContents.send("reset");
      }

      console.log("[IPC-FIXED] Application reset completed successfully");
      return { success: true, data: "Application reset" };
    } catch (error: any) {
      console.error("Error triggering reset:", error);
      return { 
        success: false, 
        error: `Failed to reset application: ${error.message}` 
      };
    }
  }, "trigger-reset"));

  // ============================================================================
  // Window Movement Handlers
  // ============================================================================
  const createMovementHandler = (direction: string, moveFn: () => void) => 
    createSafeIpcHandler(() => {
      try {
        moveFn();
        console.log(`[IPC-FIXED] Window moved ${direction}`);
        return { success: true, data: `Moved ${direction}` };
      } catch (error: any) {
        console.error(`Error moving window ${direction}:`, error);
        return { 
          success: false, 
          error: `Failed to move window ${direction}: ${error.message}` 
        };
      }
    }, `trigger-move-${direction}`);

  ipcMain.handle("trigger-move-left", createMovementHandler("left", deps.moveWindowLeft));
  ipcMain.handle("trigger-move-right", createMovementHandler("right", deps.moveWindowRight));
  ipcMain.handle("trigger-move-up", createMovementHandler("up", deps.moveWindowUp));
  ipcMain.handle("trigger-move-down", createMovementHandler("down", deps.moveWindowDown));

  // ===================== Mode & History IPC =====================
  ipcMain.handle("get-mode", createSafeIpcHandler(async () => {
    try {
      const main = require("./main");
      const mode = main.getCurrentMode?.() || "normal";
      return { success: true, data: { mode } };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }, "get-mode"));

  ipcMain.handle("set-mode", createSafeIpcHandler(async (_e: any, mode: "normal" | "stealth") => {
    try {
      const main = require("./main");
      await main.setMode?.(mode);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }, "set-mode"));

  // ===================== Prompt IPC =====================
  ipcMain.handle("set-user-prompt", createSafeIpcHandler(async (_e: any, prompt: string) => {
    try {
      const main = require("./main");
      const text = (prompt || "").toString();
      main.setUserPrompt?.(text.slice(0, 4000));
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }, "set-user-prompt"));

  ipcMain.handle("get-user-prompt", createSafeIpcHandler(async () => {
    try {
      const main = require("./main");
      const value = main.getUserPromptValue?.() || "";
      return { success: true, data: { prompt: value } };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }, "get-user-prompt"));

  ipcMain.handle("focus-window", createSafeIpcHandler(async () => {
    try {
      const main = require("./main");
      main.focusMainWindow?.();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }, "focus-window"));

  // ===================== Stealth keyboard (natively-style typing) =====================
  // Begins a stealth typing session: the native hook swallows keystrokes and
  // forwards them as "stealth-key" events, so the window never takes focus.
  // Returns { stealth: true } when the hook is live, otherwise
  // { stealth: false, error } explaining why - the renderer shows the error
  // and does NOT fall back to focus-based typing.
  ipcMain.handle("start-stealth-typing", createSafeIpcHandler(async () => {
    try {
      const started = deps.stealthKeyboard?.start() ?? false;
      const error = started ? undefined : (deps.stealthKeyboard?.getLastError() || "Stealth typing is unavailable on this machine.");
      return { success: true, data: { stealth: started, error } };
    } catch (error: any) {
      console.error("[IPC] start-stealth-typing failed:", error);
      return { success: false, data: { stealth: false, error: error.message || String(error) }, error: error.message || String(error) };
    }
  }, "start-stealth-typing"));

  ipcMain.handle("stop-stealth-typing", createSafeIpcHandler(async () => {
    try {
      deps.stealthKeyboard?.stop();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }, "stop-stealth-typing"));

  // ===================== Attached files IPC =====================
  ipcMain.handle("select-and-attach-files", createSafeIpcHandler(async () => {
    try {
      const main = require("./main");
      const files = await main.openAttachFileDialog();
      return { success: true, data: { files } };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }, "select-and-attach-files"));

  ipcMain.handle("get-attached-files", createSafeIpcHandler(async () => {
    try {
      const main = require("./main");
      const files = main.getAttachedFilesMeta();
      return { success: true, data: { files } };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }, "get-attached-files"));

  ipcMain.handle("remove-attached-file", createSafeIpcHandler(async (_e: any, id: string) => {
    try {
      const main = require("./main");
      const files = main.removeAttachedFile(id);
      return { success: true, data: { files } };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }, "remove-attached-file"));

  ipcMain.handle("clear-attached-files", createSafeIpcHandler(async () => {
    try {
      const main = require("./main");
      const files = main.clearAttachedFiles();
      return { success: true, data: { files } };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }, "clear-attached-files"));

  // ===================== Emergency Recovery Handler =====================
  ipcMain.handle("emergency-visibility-recovery", createSafeIpcHandler(async () => {
    try {
      console.log("[IPC-FIXED] Emergency visibility recovery requested via IPC");
      
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "No main window available for recovery" };
      }

      // Force show window
      mainWindow.show();
      
      // Force opacity to full
      mainWindow.setOpacity(1);
      
      // Force always on top
      mainWindow.setAlwaysOnTop(true, "floating");
      
      // Check current bounds and fix if needed
      const bounds = mainWindow.getBounds();
      console.log("[IPC-FIXED] Current window bounds during recovery:", bounds);
      
      if (bounds.width < 100 || bounds.height < 100 || bounds.x < -1000 || bounds.y < -1000) {
        console.log("[IPC-FIXED] Window has invalid bounds, resetting");
        
        const primaryDisplay = screen.getPrimaryDisplay();
        const workArea = primaryDisplay.workAreaSize;
        
        const safeBounds = {
          x: Math.max(0, Math.floor(workArea.width * 0.1)),
          y: Math.max(0, Math.floor(workArea.height * 0.1)),
          width: Math.min(800, Math.floor(workArea.width * 0.6)),
          height: Math.min(600, Math.floor(workArea.height * 0.7))
        };
        
        mainWindow.setBounds(safeBounds, false);
        console.log("[IPC-FIXED] Window bounds reset to:", safeBounds);
      }
      
      // CRITICAL: Remove dangerous forward option
      mainWindow.setIgnoreMouseEvents(true);
      
      console.log("[IPC-FIXED] Emergency recovery completed successfully");
      return { 
        success: true, 
        data: "Emergency recovery completed" 
      };
      
    } catch (error: any) {
      console.error("Emergency recovery failed:", error);
      return { 
        success: false, 
        error: `Emergency recovery failed: ${error.message}` 
      };
    }
  }, "emergency-visibility-recovery"));

  // ============================================================================
  // Application Control Handlers
  // ============================================================================
  ipcMain.handle("quit-application", createSafeIpcHandler(async () => {
    try {
      console.log("[IPC-FIXED] Quit application requested via IPC");
      
      // Give time for IPC response to be sent
      setTimeout(() => {
        deps.quitApplication();
      }, 100);
      
      return { success: true, data: "Application quit initiated" };
    } catch (error: any) {
      console.error("Error quitting application:", error);
      return { 
        success: false, 
        error: `Failed to quit application: ${error.message}` 
      };
    }
  }, "quit-application"));

  // ============================================================================
  // Store Management Handlers
  // ============================================================================
  ipcMain.handle("get-store-value", createSafeIpcHandler(async (
    _event: any,
    key: string
  ) => {
    try {
      if (!key || typeof key !== 'string') {
        return { success: false, error: "Invalid key provided" };
      }

      const value = await getStoreValue(key);
      console.log(`[IPC-FIXED] Retrieved store value for key: ${key}`);
      return { success: true, data: value };
    } catch (error: any) {
      console.error(`Error getting store value for key ${key}:`, error);
      return { 
        success: false, 
        error: `Failed to get store value: ${error.message}` 
      };
    }
  }, "get-store-value"));

  ipcMain.handle("set-store-value", createSafeIpcHandler(async (
    _event: any,
    key: string,
    value: any
  ) => {
    try {
      if (!key || typeof key !== 'string') {
        return { success: false, error: "Invalid key provided" };
      }

      const success = await setStoreValue(key, value);
      if (!success) {
        return { success: false, error: "Failed to set store value" };
      }

      console.log(`[IPC-FIXED] Set store value for key: ${key}`);
      return { success: true, data: value };
    } catch (error: any) {
      console.error(`Error setting store value for key ${key}:`, error);
      return { 
        success: false, 
        error: `Failed to set store value: ${error.message}` 
      };
    }
  }, "set-store-value"));

  // ============================================================================
  // CRITICAL FIX: Safe Mouse Event Handlers (NO FORWARDING)
  // ============================================================================
  
  ipcMain.handle("set-ignore-mouse-events", createSafeIpcHandler(() => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "Main window not available" };
      }

      // CRITICAL: Remove { forward: true } option to prevent system freezing
      mainWindow.setIgnoreMouseEvents(true);
      console.log("[IPC-FIXED] Mouse events set to ignore (click-through) - NO FORWARDING");
      deps.disableInteractiveOverride();
      return { success: true, data: "Mouse events set to ignore" };
    } catch (error: any) {
      console.error("Error setting ignore mouse events:", error);
      return { 
        success: false, 
        error: `Failed to set ignore mouse events: ${error.message}` 
      };
    }
  }, "set-ignore-mouse-events"));

  ipcMain.handle("set-interactive-mouse-events", createSafeIpcHandler(() => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "Main window not available" };
      }

      mainWindow.setIgnoreMouseEvents(false);
      console.log("[IPC-FIXED] Mouse events set to interactive");
      deps.enableInteractiveOverride();
      return { success: true, data: "Mouse events set to interactive" };
    } catch (error: any) {
      console.error("Error setting interactive mouse events:", error);
      return { 
        success: false, 
        error: `Failed to set interactive mouse events: ${error.message}` 
      };
    }
  }, "set-interactive-mouse-events"));

  // Safe alternative mouse event handlers
  ipcMain.handle("enable-safe-click-through", createSafeIpcHandler(() => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "Main window not available" };
      }
      mainWindow.setIgnoreMouseEvents(true);
      console.log("[IPC-FIXED] Safe click-through mode enabled");
      deps.disableInteractiveOverride();
      return { success: true, data: "Safe click-through enabled" };
    } catch (error: any) {
      console.error("Error enabling safe click-through:", error);
      return { 
        success: false, 
        error: `Failed to enable click-through: ${error.message}` 
      };
    }
  }, "enable-safe-click-through"));

  ipcMain.handle("restore-interactive-mode", createSafeIpcHandler(() => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "Main window not available" };
      }
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.setFocusable(true);
      console.log("[IPC-FIXED] Interactive mode restored");
      deps.enableInteractiveOverride();
      return { success: true, data: "Interactive mode restored" };
    } catch (error: any) {
      console.error("Error restoring interactive mode:", error);
      return { 
        success: false, 
        error: `Failed to restore interactive mode: ${error.message}` 
      };
    }
  }, "restore-interactive-mode"));

  ipcMain.handle("emergency-mouse-recovery", createSafeIpcHandler(() => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "Main window not available" };
      }

      // Force restore all mouse functionality
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.setFocusable(true);
      mainWindow.show();
      mainWindow.focus();
      
      console.log("[IPC-FIXED] Emergency mouse recovery completed");
      return { success: true, data: "Mouse events recovered" };
    } catch (error: any) {
      console.error("Emergency mouse recovery failed:", error);
      return { 
        success: false, 
        error: `Emergency recovery failed: ${error.message}`
      };
    }
  }, "emergency-mouse-recovery"));

  // ============================================================================
  // Settings Window Handler
  // ============================================================================
  ipcMain.handle("open-settings", createSafeIpcHandler(async () => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "Main window not available" };
      }
      
      // Send event to renderer to open settings
      mainWindow.webContents.send("open-settings");
      return { success: true };
    } catch (error: any) {
      console.error("Error opening settings:", error);
      return { success: false, error: error.message || String(error) };
    }
  }, "open-settings"));

  // ============================================================================
  // Window Opacity Control Handlers
  // ============================================================================
  ipcMain.handle("increase-opacity", createSafeIpcHandler(() => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "Main window not available" };
      }

      const currentOpacity = mainWindow.getOpacity();
      const newOpacity = Math.min(1.0, currentOpacity + 0.1);
      mainWindow.setOpacity(newOpacity);
      
      console.log(`[Opacity] Increased to ${newOpacity.toFixed(2)}`);
      return { success: true, data: { opacity: newOpacity } };
    } catch (error: any) {
      console.error("Error increasing opacity:", error);
      return { success: false, error: error.message || String(error) };
    }
  }, "increase-opacity"));

  ipcMain.handle("decrease-opacity", createSafeIpcHandler(() => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "Main window not available" };
      }

      const currentOpacity = mainWindow.getOpacity();
      const newOpacity = Math.max(0.1, currentOpacity - 0.1);
      mainWindow.setOpacity(newOpacity);
      
      console.log(`[Opacity] Decreased to ${newOpacity.toFixed(2)}`);
      return { success: true, data: { opacity: newOpacity } };
    } catch (error: any) {
      console.error("Error decreasing opacity:", error);
      return { success: false, error: error.message || String(error) };
    }
  }, "decrease-opacity"));

  ipcMain.handle("get-opacity", createSafeIpcHandler(() => {
    try {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: "Main window not available" };
      }

      const opacity = mainWindow.getOpacity();
      return { success: true, data: { opacity } };
    } catch (error: any) {
      console.error("Error getting opacity:", error);
      return { success: false, error: error.message || String(error) };
    }
  }, "get-opacity"));

  console.log("FIXED: All IPC handlers initialized successfully with DIRECT dimension updates (NO BATCHING)");
}