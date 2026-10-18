import { GoogleGenerativeAI } from "@google/generative-ai";
import { IProcessingHelperDeps } from "./main";
import { ScreenshotHelper } from "./ScreenshotHelper";
import { vertexAIService } from "./services/VertexAIService";
import fs from "node:fs";
import process from "process";

export class ProcessingHelper {
  private deps: IProcessingHelperDeps;
  private screenshotHelper: ScreenshotHelper;
  private isCurrentlyProcessing: boolean = false;
  private previousResponse: string | null = null; // Store previous response for context

  // ============================================================================
  // BUG FIX: Enhanced AbortController Management
  // ============================================================================
  private currentProcessingAbortController: AbortController | null = null;
  private currentExtraProcessingAbortController: AbortController | null = null;
  private processingTimeouts: Set<NodeJS.Timeout> = new Set(); // Track all timeouts

  constructor(deps: IProcessingHelperDeps) {
    this.deps = deps;
    this.screenshotHelper = deps.getScreenshotHelper();
  }

  // ============================================================================
  // BUG FIX: Safe AbortController Creation and Cleanup
  // ============================================================================
  private createAbortController(type: 'main' | 'extra'): AbortController {
    // Clean up existing controller first
    this.safeAbortController(type === 'main' ? this.currentProcessingAbortController : this.currentExtraProcessingAbortController);
    
    const controller = new AbortController();
    
    if (type === 'main') {
      this.currentProcessingAbortController = controller;
    } else {
      this.currentExtraProcessingAbortController = controller;
    }
    
    // Set up timeout protection to prevent hanging requests
    const timeoutId = setTimeout(() => {
      this.safeAbortController(controller);
    }, 120000); // 2 minute timeout
    
    this.processingTimeouts.add(timeoutId);
    
    return controller;
  }

  private safeAbortController(controller: AbortController | null): void {
    if (!controller) return;
    
    try {
      if (!controller.signal.aborted) {
        // Wrap abort in additional try-catch to prevent uncaught exceptions
        // from abort event listeners that might throw
        try {
          controller.abort();
        } catch (abortError: any) {
          // If abort throws (e.g., from event listeners), catch it here
          // This prevents uncaught exceptions when canceling requests
          if (abortError?.message !== "Request aborted" && abortError?.name !== "AbortError") {
            console.warn("Error during abort (non-fatal):", abortError);
          }
          // Silently ignore abort errors - they're expected when canceling
        }
      }
    } catch (error) {
      // Silently handle abort errors - they're expected when canceling
      console.warn("Error aborting request controller (this is usually safe to ignore):", error);
    }
  }

  private clearProcessingTimeouts(): void {
    this.processingTimeouts.forEach(timeout => {
      try {
        clearTimeout(timeout);
      } catch (error) {
        console.warn("Error clearing timeout:", error);
      }
    });
    this.processingTimeouts.clear();
  }

  /**
   * Consume a Gemini stream with an overall timeout. The SDK's async iterator
   * does not reject when our AbortSignal fires while it is still waiting for
   * the first chunk, so without this a stalled stream would spin forever in
   * the UI with no error. The timeout throws STREAM_TIMEOUT, which the
   * callers map to a user-facing message.
   */
  private async consumeStreamWithTimeout(
    stream: AsyncIterable<any>,
    onChunk: (chunkText: string) => void,
    signal: AbortSignal,
    timeoutMs: number = 100_000,
    onThought?: (thoughtText: string) => void
  ): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        (async () => {
          for await (const chunk of stream) {
            if (signal.aborted) throw new Error("Request aborted");
            if (
              chunk &&
              typeof chunk === "object" &&
              "type" in chunk &&
              "content" in chunk
            ) {
              if (chunk.type === "thought" && chunk.content) {
                onThought?.(chunk.content);
              } else if (chunk.type === "text" && chunk.content) {
                onChunk(chunk.content);
              }
              continue;
            }
            const parts: Array<{ text?: string; thought?: boolean }> | undefined =
              chunk?.candidates?.[0]?.content?.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (!part?.text) continue;
                if (part.thought) {
                  onThought?.(part.text);
                } else {
                  onChunk(part.text);
                }
              }
              continue;
            }
            const chunkText =
              typeof chunk === "string"
                ? chunk
                : typeof chunk?.text === "function"
                  ? chunk.text()
                  : "";
            if (chunkText) onChunk(chunkText);
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("STREAM_TIMEOUT")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Classify a Gemini failure as rate-limit / overload / timeout so the UI
   * can show an actionable message instead of a raw SDK error (or nothing).
   */
  private classifyModelError(error: any): "rate_limited" | "overloaded" | "timeout" | null {
    const text =
      `${error?.message || ""} ${error?.status || ""} ` +
      `${error?.response?.data ? JSON.stringify(error.response.data) : ""}`;
    if (error?.message === "STREAM_TIMEOUT") return "timeout";
    if (/429|resource[\s_-]*exhausted|too many requests|quota/i.test(text)) return "rate_limited";
    if (/503|overloaded|too many users|service unavailable/i.test(text)) return "overloaded";
    return null;
  }

  private providerLabel(): string {
    const p = process.env.API_PROVIDER || "gemini";
    return p === "groq" ? "Groq" : p === "vertex" ? "Vertex AI" : "Gemini";
  }

  /**
   * Readability rules appended to every prompt so answers come back as short
   * paragraphs that fit a narrow window - vertical scrolling only, never a
   * single long line that needs horizontal scrolling.
   */
  private addReadabilityRules(promptLines: string[]): void {
    promptLines.push(
      `---`,
      `READABILITY (must follow):`,
      `- Break the answer into short paragraphs separated by blank lines. Never emit one long unbroken block of text.`,
      `- Use bullet or numbered lists for steps, options, or multiple points.`,
      `- Keep lines reasonably short so the text fits a narrow window without any horizontal scrolling.`,
      `- MATH FORMATTING: write ALL math as plain Unicode text - use × ÷ → ⟹ ≤ ≥ ² ₀ ≠ ± − directly from the keyboard. NEVER type LaTeX backslash commands like \\times \\frac \\text \\sqrt \\% outside of $...$ delimiters. NEVER wrap plain values in dollar signs: write $18,000 and 52ms and 3.0% as plain text, never $$18,000$$ or $52\\text{ms}$ or $3.0\\%$. Only use $...$ for genuinely complex multi-step equations, and keep those simple too.`
    );
  }

  /**
   * Vertex AI streaming via Application Default Credentials
   * (`gcloud auth application-default login` on the user's machine).
   * Yields { type: "thought" | "text", content: string } chunks; project/location come from settings.
   */
  private async *streamVertexChatCompletion(
    signal: AbortSignal,
    model: string,
    prompt: string,
    base64Images: string[]
  ): AsyncGenerator<{ type: "thought" | "text"; content: string }> {
    const projectId = (
      process.env.VERTEX_PROJECT ||
      vertexAIService.getProjectIdFromKey() ||
      ""
    ).trim();
    const location = (process.env.VERTEX_LOCATION || "global").trim() || "global";
    if (!projectId) {
      throw new Error(
        "Vertex AI project not set. Open settings, choose the Vertex AI provider and enter your GCP project ID."
      );
    }
    const thinkingLevel =
      (await this.deps.getConfiguredThinkingLevel?.()) || "MEDIUM";
    const webSearch = (await this.deps.getWebSearchEnabled?.()) || false;
    for await (const chunk of vertexAIService.streamGenerateContent({
      projectId,
      location,
      model,
      prompt,
      base64Images,
      thinkingLevel,
      webSearch,
      signal,
    })) {
      yield chunk;
    }
  }

  /**
   * Groq chat-completions (OpenAI-compatible) streaming.
   * Yields { text() } chunks so consumeStreamWithTimeout can be reused as-is.
   */
  private async *streamGroqChatCompletion(
    signal: AbortSignal,
    apiKey: string,
    model: string,
    prompt: string,
    base64Images: string[]
  ): AsyncGenerator<{ text: () => string }> {
    const content: any[] = [{ type: "text", text: prompt }];
    for (const data of base64Images) {
      if (data && typeof data === "string" && data.length > 100) {
        content.push({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${data}` },
        });
      }
    }

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content }],
          stream: true,
        }),
        signal,
      }
    );

    if (!response.ok || !response.body) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {}
      if (response.status === 400 && /image/i.test(detail)) {
        throw new Error(
          "Groq rejected the request (400): this model may not support images. " +
            "Pick a vision-capable Groq model in settings. " +
            `Details: ${detail.slice(0, 300)}`
        );
      }
      throw new Error(
        `Groq API error ${response.status}: ${detail.slice(0, 300)}`
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw new Error("Request aborted");
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const json = JSON.parse(payload);
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              yield { text: () => delta };
            }
          } catch {
            // ignore partial JSON fragments
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  public async processScreenshots(): Promise<void> {
    if (this.isCurrentlyProcessing) {
      console.log("Processing already in progress. Skipping duplicate call.");
      return;
    }

    this.isCurrentlyProcessing = true;
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) {
      this.isCurrentlyProcessing = false;
      return;
    }

    try {
      const view = this.deps.getView();

      if (view === "initial") {
        // CRITICAL: Apply taskbar prevention IMMEDIATELY when initial processing starts
        // This prevents taskbar from appearing before setView("response") is called
        // Set it MANY times synchronously to prevent even millisecond flashes
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setSkipTaskbar(true);
          mainWindow.setSkipTaskbar(true);
          mainWindow.setSkipTaskbar(true);
          mainWindow.setSkipTaskbar(true);
          mainWindow.setSkipTaskbar(true);
          mainWindow.setFocusable(false);
          mainWindow.setFocusable(false);
          mainWindow.setFocusable(false);
          mainWindow.setFocusable(false);
          mainWindow.setIgnoreMouseEvents(true);
          if (mainWindow.isFocused()) {
            mainWindow.blur();
          }
          
          // Use process.nextTick to set it before event loop continues
          process.nextTick(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.setSkipTaskbar(true);
              mainWindow.setSkipTaskbar(true);
              mainWindow.setFocusable(false);
              mainWindow.setFocusable(false);
            }
          });
        }
        
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START);
        
        // CRITICAL: Set skipTaskbar again immediately after sending IPC message
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setSkipTaskbar(true);
          mainWindow.setSkipTaskbar(true);
          mainWindow.setSkipTaskbar(true);
          mainWindow.setFocusable(false);
          mainWindow.setFocusable(false);
        }
        const screenshotQueue = this.screenshotHelper.getScreenshotQueue();
        
        try {
          // Create abort controller with enhanced management
          const abortController = this.createAbortController('main');
          const { signal } = abortController;

          const screenshots = await Promise.all(
            screenshotQueue.map(async (path) => ({
              path,
              data: fs.readFileSync(path).toString("base64"),
            }))
          );

          // Validate base64 data before processing
          const validScreenshots = screenshots.filter((screenshot, index) => {
            const { data } = screenshot;
            if (!data || typeof data !== 'string') {
              console.warn(`[INITIAL] Invalid image data at index ${index}:`, typeof data);
              return false;
            }
            
            // Check if it's a valid base64 string
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
              console.warn(`[INITIAL] Invalid base64 format at index ${index}`);
              return false;
            }
            
            // Check minimum length (base64 should be reasonably long)
            if (data.length < 100) {
              console.warn(`[INITIAL] Base64 data too short at index ${index}: ${data.length} chars`);
              return false;
            }
            
            return true;
          });

          if (validScreenshots.length === 0) {
            throw new Error("No valid screenshot data available for processing");
          }

          const result = await this.processScreenshotsHelper(
            validScreenshots,
            signal
          );

          if (!result.success) {
            const errorMessage =
              result.error || "Failed to generate response. Please try again.";
            const normalizedError = errorMessage.toLowerCase();
            const isApiKeyError = normalizedError.includes("api key not found");
            const isRateLimitError =
              normalizedError.includes("429") ||
              normalizedError.includes("resource exhausted") ||
              normalizedError.includes("too many requests");

            console.log("Processing failed:", errorMessage);

            if (isApiKeyError) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.INITIAL_RESPONSE_ERROR,
                "API key not found. Please set your API key in settings."
              );
              console.log("Resetting view to queue due to API key error");
              this.deps.setView("initial");
            } else {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.INITIAL_RESPONSE_ERROR,
                errorMessage
              );

              if (isRateLimitError) {
                console.log(
                  "Rate limit encountered. Keeping response view active for retry."
                );
                this.deps.setView("response");
              } else {
                console.log("Resetting view to queue due to error");
                this.deps.setView("initial");
              }
            }
            return;
          }

          // Only set view to response if processing succeeded
          console.log("Setting view to response after successful processing");
          // Save to local history (main export)
          try {
            const main = require("./main");
            main.saveResponseToHistory?.(result.data);
          } catch {}
          mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.RESPONSE_SUCCESS, { response: result.data });
          this.deps.setView("response");
        } catch (error: any) {
          console.error("Processing error:", error);
          
          if (error.message === "Request aborted" || error.name === "AbortError") {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.INITIAL_RESPONSE_ERROR,
              "Processing was canceled by the user."
            );
          } else {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.INITIAL_RESPONSE_ERROR,
              error.message || "Server error. Please try again."
            );
          }
          // Reset view back to queue on error
          console.log("Resetting view to queue due to error");
          this.deps.setView("initial");
        } finally {
          this.currentProcessingAbortController = null;
        }
      } else {
        // view == 'response' - follow-up processing
        const extraScreenshotQueue =
          this.screenshotHelper.getExtraScreenshotQueue();
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.FOLLOW_UP_START
        );

        // Create abort controller with enhanced management
        const abortController = this.createAbortController('extra');
        const { signal } = abortController;

        try {
          const screenshots = await Promise.all(
            [
              ...this.screenshotHelper.getScreenshotQueue(),
              ...extraScreenshotQueue,
            ].map(async (path) => ({
              path,
              data: fs.readFileSync(path).toString("base64"),
            }))
          );

          const result = await this.processExtraScreenshotsHelper(
            screenshots,
            signal,
            "" // No user prompt for main processing
          );

          if (result.success) {
            this.deps.setHasFollowedUp(true);
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.FOLLOW_UP_SUCCESS,
              { response: result.data }
            );
          } else {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.FOLLOW_UP_ERROR,
              result.error
            );
          }
        } catch (error: any) {
          if (error.message === "Request aborted" || error.name === "AbortError") {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.FOLLOW_UP_ERROR,
              "Extra processing was canceled by the user."
            );
          } else {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.FOLLOW_UP_ERROR,
              error.message
            );
          }
        } finally {
          this.currentExtraProcessingAbortController = null;
        }
      }
    } finally {
      this.isCurrentlyProcessing = false; // Ensure flag is reset
      this.clearProcessingTimeouts(); // Clean up any timeouts
    }
  }

  private async processScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ) {
    const MAX_RETRIES = 0;
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      try {
        const imageDataList = screenshots.map((screenshot) => screenshot.data);
        const mainWindow = this.deps.getMainWindow();

        // Get configured provider and API key from environment
        const provider = process.env.API_PROVIDER || "gemini";
        const apiKey = process.env.API_KEY;

        // Get model directly from config store via deps
        const model = await this.deps.getConfiguredModel();

        // Vertex AI authenticates via gcloud ADC, not an API key.
        if (provider !== "vertex" && !apiKey) {
          throw new Error(
            "API key not found. Please configure it in settings."
          );
        }

        const base64Images = imageDataList.map(
          (data) => data // Keep the base64 string as is
        );

        if (mainWindow) {
          // Generate response directly using images
          const responseResult = await this.generateResponseWithImages(
            signal,
            base64Images,
            apiKey ?? "",
            model
          );

          if (responseResult.success) {
            this.screenshotHelper.clearExtraScreenshotQueue();
            // Store the response for follow-up context
            this.previousResponse = responseResult.data ?? null;
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.RESPONSE_SUCCESS,
              { response: responseResult.data }
            );
            return { success: true, data: responseResult.data };
          } else {
            throw new Error(
              responseResult.error || "Failed to generate response"
            );
          }
        }
      } catch (error: any) {
        console.error("Processing error details:", {
          message: error.message,
          code: error.code,
          response: error.response?.data,
          retryCount,
        });

        if (
          error.message === "Request aborted" ||
          error.name === "AbortError" ||
          retryCount >= MAX_RETRIES
        ) {
          return { success: false, error: error.message };
        }
        retryCount++;
      }
    }

    return {
      success: false,
      error: "Failed to process after multiple attempts. Please try again.",
    };
  }

  // ============================================================================
  // BUG FIX: Enhanced Error Handling and Resource Cleanup
  // ============================================================================
  private async generateResponseWithImages(
    signal: AbortSignal,
    base64Images: string[],
    apiKey: string,
    model: string
  ) {
    // Declare variables in function scope so catch block can access them
    let responseText = "";
    let chunksSent = false; // Track if any chunks were sent
    let accumulatedText = ""; // Accumulated text from chunks
    
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const geminiModelId = model.startsWith("gemini-")
        ? `models/${model}`
        : model;
      const thinkingLevel = (await this.deps.getConfiguredThinkingLevel?.()) || "MEDIUM";
      const generationConfig: any = {
        maxOutputTokens: 12288,
        temperature: 0.45,
        thinkingConfig: /^gemini-[34]/.test(model)
          ? { thinkingLevel, includeThoughts: true }
          : { includeThoughts: true },
      };
      // Google Search grounding: off by default (billed per search query).
      // Passed untyped like thinkingConfig - plain JSON at runtime.
      const webSearch = (await this.deps.getWebSearchEnabled?.()) || false;
      const geminiModel = genAI.getGenerativeModel({
        model: geminiModelId,
        generationConfig,
        ...(webSearch ? { tools: [{ googleSearch: {} }] as any } : {}),
      });

      const imageParts = base64Images.map((data) => ({
        inlineData: {
          mimeType: "image/png",
          data: data,
        },
      }));

      // Prepare content parts array starting with images
      const contentParts = [...imageParts];
      console.log(
        `[PROCESSING] Images added to contentParts: ${imageParts.length}`
      );

      const promptLines = [
        `You are an expert assistant tasked with solving the task shown in the images.`,
        ``,
      ];

      // Include optional user prompt (normal mode typing)
      try {
        const typed = this.deps.getUserPrompt?.();
        if (typed && typed.trim().length > 0) {
          promptLines.push(`## User Prompt`, "", typed.trim(), "");
          // Clear after consuming to avoid reuse
          this.deps.clearUserPrompt?.();
        }
      } catch {}

      // Include attached file context (natively-style file reading)
      try {
        const fileContext = this.deps.getAttachedFilesContext?.();
        if (fileContext && fileContext.trim().length > 0) {
          promptLines.push(
            `## Attached Files`,
            `The user attached the following file(s). Use their contents as context when answering.`,
            ``,
            fileContext.trim(),
            ``
          );
        }
      } catch {}

      promptLines.push(
        `---`,
        `DECISIVE REASONING & THINKING DIRECTIVES:`,
        `When formulating thoughts and reasoning through the problem, follow these efficiency rules:`,
        `1. Target Identification: Instantly locate the active question or focal task in the visual content. Disregard irrelevant background windows, browser tabs, or peripheral text.`,
        `2. Forward-Only Progression: Reason strictly forward in a clear, single-pass logic chain. Do NOT loop back to second-guess established deductions or debate yourself repeatedly.`,
        `3. One-Pass Verification: Validate facts, logic, and calculations decisively once. If an intermediate step or derivation is sound, accept it as fact and proceed immediately.`,
        `4. Decisive Elimination: For multiple-choice questions, eliminate distractor choices with a single direct reason. Do not cycle back through rejected options unless an explicit contradiction arises.`,
        `5. Calibrated Depth: Scale thinking depth directly to problem difficulty. Simple lookups, standard multiple choice, and familiar code patterns require fast, concise verification—never over-complicate or over-think straightforward questions.`,
        `6. Immediate Commitment: As soon as the answer is reached, end thinking and emit the response without lingering or adding speculative caveats.`,
        ``,
        `Your response MUST follow this structure, using Markdown headings:`,
        ``,
        `CORE DIRECTIVES & RESPONSE FLOW:`,
        `Unless the user explicitly requests a different format, structure every response in this exact 3-part flow:`,
        `1. **Question:** A single, concise 1-line restatement of the detected question or task so the user knows you read the right target.`,
        `2. **Answer:** Immediately provide the direct final answer, verdict, or solution (e.g., the exact multiple-choice option, final math value, direct conclusion, or complete code block).`,
        `3. **Explanation:** Provide a clear, structured breakdown explaining *why* the answer is correct, how the code/math works, or why other options are ruled out.`,
        ``,
        `STRICT READABILITY & FORMATTING RULES:`,
        `1. Break the answer into short paragraphs separated by blank lines—never write one long unbroken block of text.`,
        `2. Use bullet or numbered lists for steps, options, or multiple points.`,
        `3. Keep lines reasonably concise so text fits a narrow window without horizontal scrolling.`,
        `4. Write ALL math as plain Unicode text (×, ÷, →, ⟹, ≤, ≥, ², ₂, ≠, ±, −) typed directly. NEVER use LaTeX backslash commands (\\times, \\frac, \\text, \\sqrt, \\%) outside of $...$ equations.`,
        `5. Never wrap plain values in dollar signs. $18,000, 52ms, 3.0% must stay as plain text ($18,000, 52ms), NOT $$18,000$$ or $52\\text{ms}$.`,
        `6. Only use $...$ or $$...$$ for genuinely complex multi-step equations, and keep those simple.`,
        `7. Never use raw HTML tags (<p>, <br>, <b>) or wrap regular prose/LaTeX inside code blocks.`,
        `8. Use topic-specific \`##\` or \`###\` headings ONLY when a complex answer genuinely needs sections—never use generic labels like "# Analysis" or "# Summary".`,
        ``,
        `DOMAIN ADAPTATION:`,
        `- Coding: Complete code block under **Answer**, essential notes/complexity under **Explanation**.`,
        `- Math/Logic: Final bolded result under **Answer**, step-by-step derivation under **Explanation**.`,
        `- Law/Medicine/Sciences: Core conclusion/assessment under **Answer**, criteria/differentials under **Explanation**.`,
        `- Multiple Choice: Correct option letter/text in bold under **Answer**, justification under **Explanation**.`
      );
      const prompt = promptLines.join("\n");

      if (signal.aborted) throw new Error("Request aborted");
      
      // Enhanced abort handling - don't throw, just mark as aborted
      const abortHandler = () => {
        // Don't throw here - let the fetch request handle the abort naturally
        // The error will be caught in the catch block below
      };
      signal.addEventListener("abort", abortHandler);

      const mainWindow = this.deps.getMainWindow();

      // Vertex AI path - same prompt, streamed via ADC-authenticated SSE.
      if ((process.env.API_PROVIDER || "gemini") === "vertex") {
        try {
          accumulatedText = "";
          let accumulatedThinking = "";
          await this.consumeStreamWithTimeout(
            this.streamVertexChatCompletion(signal, model, prompt, base64Images),
            (chunkText) => {
              accumulatedText += chunkText;

              // Send chunk to UI for live markdown rendering
              if (mainWindow && !mainWindow.isDestroyed()) {
                chunksSent = true; // Mark that we've sent at least one chunk
                mainWindow.webContents.send(
                  this.deps.PROCESSING_EVENTS.RESPONSE_CHUNK,
                  { response: accumulatedText }
                );
              }
            },
            signal,
            100_000,
            (thoughtText) => {
              accumulatedThinking += thoughtText;
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                  this.deps.PROCESSING_EVENTS.RESPONSE_THINKING_CHUNK,
                  { thinking: accumulatedThinking }
                );
              }
            }
          );

          responseText = accumulatedText;

          // Send final success message
          if (mainWindow && !mainWindow.isDestroyed()) {
            try {
              const main = require("./main");
              main.saveResponseToHistory?.(responseText);
            } catch {}
            mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.RESPONSE_SUCCESS, { response: responseText });
          }

          return { success: true, data: responseText };
        } finally {
          try {
            signal.removeEventListener("abort", abortHandler);
          } catch (e) {
            // Ignore if removeEventListener fails - signal may already be cleaned up
          }
        }
      }

      // Groq (OpenAI-compatible) path - same prompt, streamed via SSE.
      if ((process.env.API_PROVIDER || "gemini") === "groq") {
        try {
          accumulatedText = "";
          await this.consumeStreamWithTimeout(
            this.streamGroqChatCompletion(signal, apiKey, model, prompt, base64Images),
            (chunkText) => {
              accumulatedText += chunkText;

              // Send chunk to UI for live markdown rendering
              if (mainWindow && !mainWindow.isDestroyed()) {
                chunksSent = true; // Mark that we've sent at least one chunk
                mainWindow.webContents.send(
                  this.deps.PROCESSING_EVENTS.RESPONSE_CHUNK,
                  { response: accumulatedText }
                );
              }
            },
            signal
          );

          responseText = accumulatedText;

          // Send final success message
          if (mainWindow && !mainWindow.isDestroyed()) {
            try {
              const main = require("./main");
              main.saveResponseToHistory?.(responseText);
            } catch {}
            mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.RESPONSE_SUCCESS, { response: responseText });
          }

          return { success: true, data: responseText };
        } finally {
          try {
            signal.removeEventListener("abort", abortHandler);
          } catch (e) {
            // Ignore if removeEventListener fails - signal may already be cleaned up
          }
        }
      }

      try {
        // Stream the response with controlled pace
        const result = await geminiModel.generateContentStream([
          prompt,
          ...contentParts,
        ]);

        accumulatedText = "";
        let accumulatedThinking = "";
        await this.consumeStreamWithTimeout(
          result.stream,
          (chunkText) => {
            accumulatedText += chunkText;

            // Send chunk to UI for live markdown rendering
            if (mainWindow && !mainWindow.isDestroyed()) {
              chunksSent = true; // Mark that we've sent at least one chunk
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.RESPONSE_CHUNK,
                { response: accumulatedText }
              );
            }
          },
          signal,
          100_000,
          (thoughtText) => {
            accumulatedThinking += thoughtText;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.RESPONSE_THINKING_CHUNK,
                { thinking: accumulatedThinking }
              );
            }
          }
        );

        responseText = accumulatedText;

        // Send final success message
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            const main = require("./main");
            main.saveResponseToHistory?.(responseText);
          } catch {}
          mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.RESPONSE_SUCCESS, { response: responseText });
        }

        return { success: true, data: responseText };
      } finally {
        try {
          signal.removeEventListener("abort", abortHandler);
        } catch (e) {
          // Ignore if removeEventListener fails - signal may already be cleaned up
        }
      }
      
    } catch (error: any) {
      const mainWindow = this.deps.getMainWindow();
      console.error("Response generation error:", {
        message: error.message,
        code: error.code,
        response: error.response?.data,
        chunksSent,
      });

      // If we already sent chunks, don't reset the view - the UI already has partial content
      if (chunksSent) {
        console.log("Chunks were already sent - not resetting view, allowing partial response to display");
        // Send final chunk with whatever we have
        if (mainWindow && !mainWindow.isDestroyed() && accumulatedText) {
          mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.RESPONSE_SUCCESS, { response: accumulatedText });
        }
        return { success: true, data: accumulatedText || "" };
      }

      if (error.message === "Request aborted" || error.name === "AbortError") {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_RESPONSE_ERROR,
            "Response generation canceled."
          );
        }
        return { success: false, error: "Response generation canceled." };
      }

      // Rate-limit / overload / stall: surface an actionable message instead
      // of spinning forever or dumping a raw SDK error.
      const modelFailure = this.classifyModelError(error);
      if (modelFailure) {
        const friendly =
          modelFailure === "rate_limited"
            ? `${this.providerLabel()} rate limit reached (429) - too many requests right now. Wait a few seconds and try again, or switch to a different model in settings.`
            : modelFailure === "overloaded"
              ? "The selected model is overloaded right now. Try again in a bit, or switch to a different model in settings."
              : "The request timed out waiting for the model. Please try again.";
        this.cancelOngoingRequests();
        this.deps.clearQueues();
        this.deps.setView("initial");
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("reset-view");
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_RESPONSE_ERROR,
            friendly
          );
        }
        return { success: false, error: friendly };
      }

      if (error.code === "ETIMEDOUT" || error.response?.status === 504) {
        this.cancelOngoingRequests();
        this.deps.clearQueues();
        this.deps.setView("initial");
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("reset-view");
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_RESPONSE_ERROR,
            "Request timed out. The server took too long to respond. Please try again."
          );
        }
        return {
          success: false,
          error: "Request timed out. Please try again.",
        };
      }

      if (
        error.response?.data?.error?.includes(
          "Please close this window and re-enter a valid Open AI API key."
        ) ||
        error.response?.data?.error?.includes("API key not found")
      ) {
        if (mainWindow) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.API_KEY_INVALID
          );
        }
        return { success: false, error: error.response.data.error };
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_RESPONSE_ERROR,
          error.message ||
            "Server error during response generation. Please try again."
        );
      }
      console.log("Resetting view to queue due to response generation error (no chunks sent)");
      this.deps.setView("initial");
      return {
        success: false,
        error: error.message || "Unknown error during response generation",
      };
    }
  }

  private async processExtraScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal,
    userPrompt?: string
  ) {
    try {
      const imageDataList = screenshots.map((screenshot) => screenshot.data);
      const mainWindow = this.deps.getMainWindow();

      // Get configured provider and API key from environment
      const provider = process.env.API_PROVIDER || "gemini";
      const apiKey = process.env.API_KEY;

      // Get model directly from config store via deps
      const model = await this.deps.getConfiguredModel();

      // Vertex AI authenticates via gcloud ADC, not an API key.
      if (provider !== "vertex" && !apiKey) {
        throw new Error("API key not found. Please configure it in settings.");
      }

      const base64Images = imageDataList.map(
        (data) => data // Keep the base64 string as is
      );

      // Validate base64 data before sending to Gemini
      const validBase64Images = base64Images.filter((data, index) => {
        if (!data || typeof data !== 'string') {
          return false;
        }
        
        // Check if it's a valid base64 string
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
          return false;
        }
        
        // Check minimum length (base64 should be reasonably long)
        if (data.length < 100) {
          return false;
        }
        
        return true;
      });

      if (validBase64Images.length === 0) {
        throw new Error("No valid screenshot data available for follow-up processing. Please try taking a new screenshot.");
      }

      // For follow-up, use the same approach as the initial response, including analysis/summary
      // (vertex carries no API key - its branch returns before this client is used)
      const genAI = new GoogleGenerativeAI(apiKey ?? "");
      const geminiModelId = model.startsWith("gemini-")
        ? `models/${model}`
        : model;
      const thinkingLevel = (await this.deps.getConfiguredThinkingLevel?.()) || "MEDIUM";
      const generationConfig: any = {
        maxOutputTokens: 12288,
        temperature: 0.45,
        thinkingConfig: /^gemini-[34]/.test(model)
          ? { thinkingLevel, includeThoughts: true }
          : { includeThoughts: true },
      };
      // Google Search grounding: off by default (billed per search query).
      const webSearch = (await this.deps.getWebSearchEnabled?.()) || false;
      const geminiModel = genAI.getGenerativeModel({
        model: geminiModelId,
        generationConfig,
        ...(webSearch ? { tools: [{ googleSearch: {} }] as any } : {}),
      });

      const imageParts = validBase64Images.map((data) => ({
        inlineData: {
          mimeType: "image/png",
          data: data,
        },
      }));

      // Prepare content parts array starting with images
      const contentParts = [...imageParts];

      const promptLines = [
        `You are an expert assistant tasked with solving the follow-up issue shown in the images.`,
        ``,
        `## Previous Response Context`,
        `This is a follow-up to a previous response. Please consider the context and build upon it appropriately.`,
        ``,
      ];

      // Include user's typed follow-up text if available
      if (userPrompt && userPrompt.trim().length > 0) {
        promptLines.push(`## Additional User Question`, "", userPrompt.trim(), "");
      }

      // Include attached file context (natively-style file reading)
      try {
        const fileContext = this.deps.getAttachedFilesContext?.();
        if (fileContext && fileContext.trim().length > 0) {
          promptLines.push(
            `## Attached Files`,
            `The user attached the following file(s). Use their contents as context when answering.`,
            ``,
            fileContext.trim(),
            ``
          );
        }
      } catch {}

      // Add context about the previous response if available
      try {
        const previousResponse = this.deps.getPreviousResponse?.();
        if (previousResponse && previousResponse.trim().length > 0) {
          promptLines.push(`## Previous Response`, "", previousResponse.trim(), "");
        }
      } catch {}

      promptLines.push(
        `---`,
        `DECISIVE REASONING & THINKING DIRECTIVES:`,
        `When formulating thoughts and reasoning through the problem, follow these efficiency rules:`,
        `1. Target Identification: Instantly locate the active question or focal task in the visual content. Disregard irrelevant background windows, browser tabs, or peripheral text.`,
        `2. Forward-Only Progression: Reason strictly forward in a clear, single-pass logic chain. Do NOT loop back to second-guess established deductions or debate yourself repeatedly.`,
        `3. One-Pass Verification: Validate facts, logic, and calculations decisively once. If an intermediate step or derivation is sound, accept it as fact and proceed immediately.`,
        `4. Decisive Elimination: For multiple-choice questions, eliminate distractor choices with a single direct reason. Do not cycle back through rejected options unless an explicit contradiction arises.`,
        `5. Calibrated Depth: Scale thinking depth directly to problem difficulty. Simple lookups, standard multiple choice, and familiar code patterns require fast, concise verification—never over-complicate or over-think straightforward questions.`,
        `6. Immediate Commitment: As soon as the answer is reached, end thinking and emit the response without lingering or adding speculative caveats.`,
        ``,
        `Your response MUST follow this structure, using Markdown headings:`,
        ``,
        `CORE DIRECTIVES & RESPONSE FLOW:`,
        `Unless the user explicitly requests a different format, structure every response in this exact 3-part flow:`,
        `1. **Question:** A single, concise 1-line restatement of the detected question or task so the user knows you read the right target.`,
        `2. **Answer:** Immediately provide the direct final answer, verdict, or solution (e.g., the exact multiple-choice option, final math value, direct conclusion, or complete code block).`,
        `3. **Explanation:** Provide a clear, structured breakdown explaining *why* the answer is correct, how the code/math works, or why other options are ruled out.`,
        ``,
        `STRICT READABILITY & FORMATTING RULES:`,
        `1. Break the answer into short paragraphs separated by blank lines—never write one long unbroken block of text.`,
        `2. Use bullet or numbered lists for steps, options, or multiple points.`,
        `3. Keep lines reasonably concise so text fits a narrow window without horizontal scrolling.`,
        `4. Write ALL math as plain Unicode text (×, ÷, →, ⟹, ≤, ≥, ², ₂, ≠, ±, −) typed directly. NEVER use LaTeX backslash commands (\\times, \\frac, \\text, \\sqrt, \\%) outside of $...$ equations.`,
        `5. Never wrap plain values in dollar signs. $18,000, 52ms, 3.0% must stay as plain text ($18,000, 52ms), NOT $$18,000$$ or $52\\text{ms}$.`,
        `6. Only use $...$ or $$...$$ for genuinely complex multi-step equations, and keep those simple.`,
        `7. Never use raw HTML tags (<p>, <br>, <b>) or wrap regular prose/LaTeX inside code blocks.`,
        `8. Use topic-specific \`##\` or \`###\` headings ONLY when a complex answer genuinely needs sections—never use generic labels like "# Analysis" or "# Summary".`,
        ``,
        `DOMAIN ADAPTATION:`,
        `- Coding: Complete code block under **Answer**, essential notes/complexity under **Explanation**.`,
        `- Math/Logic: Final bolded result under **Answer**, step-by-step derivation under **Explanation**.`,
        `- Law/Medicine/Sciences: Core conclusion/assessment under **Answer**, criteria/differentials under **Explanation**.`,
        `- Multiple Choice: Correct option letter/text in bold under **Answer**, justification under **Explanation**.`,
        ``,
        `Build directly upon the previous conversation context without repeating prior explanations.`
      );
      const prompt = promptLines.join("\n");

      if (signal.aborted) throw new Error("Request aborted");
      
      // Enhanced abort handling - don't throw, just mark as aborted
      const abortHandler = () => {
        // Don't throw here - let the fetch request handle the abort naturally
        // The error will be caught in the catch block below
      };
      signal.addEventListener("abort", abortHandler);

      let followUpResponse = "";

      // Vertex AI path - same prompt, streamed via ADC-authenticated SSE.
      if ((process.env.API_PROVIDER || "gemini") === "vertex") {
        try {
          let accumulatedText = "";
          let accumulatedThinking = "";
          await this.consumeStreamWithTimeout(
            this.streamVertexChatCompletion(signal, model, prompt, validBase64Images),
            (chunkText) => {
              accumulatedText += chunkText;

              // Send chunk to UI for live markdown rendering
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                  this.deps.PROCESSING_EVENTS.FOLLOW_UP_CHUNK,
                  { response: accumulatedText }
                );
              }
            },
            signal,
            100_000,
            (thoughtText) => {
              accumulatedThinking += thoughtText;
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                  this.deps.PROCESSING_EVENTS.RESPONSE_THINKING_CHUNK,
                  { thinking: accumulatedThinking }
                );
              }
            }
          );

          followUpResponse = accumulatedText;

          // Send final success message
          if (mainWindow && !mainWindow.isDestroyed()) {
            try {
              const main = require("./main");
              main.saveResponseToHistory?.(followUpResponse);
            } catch {}
            mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.FOLLOW_UP_SUCCESS, { response: followUpResponse });
          }
        } finally {
          try {
            signal.removeEventListener("abort", abortHandler);
          } catch (e) {
            // Ignore if removeEventListener fails - signal may already be cleaned up
          }
        }

        return { success: true, data: followUpResponse };
      }

      // Groq (OpenAI-compatible) path - same prompt, streamed via SSE.
      if ((process.env.API_PROVIDER || "gemini") === "groq") {
        try {
          let accumulatedText = "";
          await this.consumeStreamWithTimeout(
            this.streamGroqChatCompletion(signal, apiKey ?? "", model, prompt, validBase64Images),
            (chunkText) => {
              accumulatedText += chunkText;

              // Send chunk to UI for live markdown rendering
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                  this.deps.PROCESSING_EVENTS.FOLLOW_UP_CHUNK,
                  { response: accumulatedText }
                );
              }
            },
            signal
          );

          followUpResponse = accumulatedText;

          // Send final success message
          if (mainWindow && !mainWindow.isDestroyed()) {
            try {
              const main = require("./main");
              main.saveResponseToHistory?.(followUpResponse);
            } catch {}
            mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.FOLLOW_UP_SUCCESS, { response: followUpResponse });
          }
        } finally {
          try {
            signal.removeEventListener("abort", abortHandler);
          } catch (e) {
            // Ignore if removeEventListener fails - signal may already be cleaned up
          }
        }

        return { success: true, data: followUpResponse };
      }

      try {
        // Stream the follow-up response with controlled pace
        const result = await geminiModel.generateContentStream([
          prompt,
          ...contentParts,
        ]);

        let accumulatedText = "";
        let accumulatedThinking = "";
        await this.consumeStreamWithTimeout(
          result.stream,
          (chunkText) => {
            accumulatedText += chunkText;

            // Send chunk to UI for live markdown rendering
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.FOLLOW_UP_CHUNK,
                { response: accumulatedText }
              );
            }
          },
          signal,
          100_000,
          (thoughtText) => {
            accumulatedThinking += thoughtText;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(
                this.deps.PROCESSING_EVENTS.RESPONSE_THINKING_CHUNK,
                { thinking: accumulatedThinking }
              );
            }
          }
        );

        followUpResponse = accumulatedText;

        // Send final success message
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            const main = require("./main");
            main.saveResponseToHistory?.(followUpResponse);
          } catch {}
          mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.FOLLOW_UP_SUCCESS, { response: followUpResponse });
        }

      } finally {
        try {
          signal.removeEventListener("abort", abortHandler);
        } catch (e) {
          // Ignore if removeEventListener fails - signal may already be cleaned up
        }
      }

      return { success: true, data: followUpResponse };
      
    } catch (error: any) {
      console.error("Follow-up processing error details:", {
        message: error.message,
        code: error.code,
        response: error.response?.data,
      });

      if (error.message === "Request aborted" || error.name === "AbortError") {
        return { success: false, error: "Follow-up processing canceled." };
      }

      // Rate-limit / overload / stall: return an actionable message instead
      // of a raw SDK error (surfaced via FOLLOW_UP_ERROR by the caller).
      const modelFailure = this.classifyModelError(error);
      if (modelFailure) {
        const friendly =
          modelFailure === "rate_limited"
            ? `${this.providerLabel()} rate limit reached (429) - too many requests right now. Wait a few seconds and try again, or switch to a different model in settings.`
            : modelFailure === "overloaded"
              ? "The selected model is overloaded right now. Try again in a bit, or switch to a different model in settings."
              : "The request timed out waiting for the model. Please try again.";
        return { success: false, error: friendly };
      }

      // Special handling for image validation errors
      if (error.message.includes("No valid screenshot data") || 
          error.message.includes("Provided image is not valid")) {
        return {
          success: false,
          error: "Screenshot data is invalid. Please try pressing Ctrl+Enter again to take a fresh screenshot.",
        };
      }

      if (error.code === "ETIMEDOUT" || error.response?.status === 504) {
        this.cancelOngoingRequests();
        this.deps.clearQueues();
        return {
          success: false,
          error: "Request timed out. Please try again.",
        };
      }

      return {
        success: false,
        error: error.message || "Unknown error during follow-up processing",
      };
    }
  }

  // ============================================================================
  // BUG FIX: Enhanced Request Cancellation with Comprehensive Cleanup
  // ============================================================================
  public cancelOngoingRequests(): void {
    let wasCancelled = false;

    // Safely abort all controllers with better error handling
    [this.currentProcessingAbortController, this.currentExtraProcessingAbortController]
      .filter(Boolean)
      .forEach(controller => {
        try {
          if (controller && !controller.signal.aborted) {
            // Use the safe abort method which handles errors better
            this.safeAbortController(controller);
            wasCancelled = true;
          }
        } catch (error) {
          // Silently handle abort errors - they're expected when canceling
          console.warn("Error aborting request controller (this is usually safe to ignore):", error);
        }
      });

    // Clear controller references
    this.currentProcessingAbortController = null;
    this.currentExtraProcessingAbortController = null;

    // Clear all timeouts
    this.clearProcessingTimeouts();

    // Reset processing state
    this.isCurrentlyProcessing = false;
    this.deps.setHasFollowedUp(false);

    const mainWindow = this.deps.getMainWindow();

    if (wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.RESET);
    }
  }

  public cancelProcessing(): void {
    console.log("Canceling processing...");
    this.cancelOngoingRequests();
  }

  public isProcessing(): boolean {
    return this.isCurrentlyProcessing;
  }

  public getPreviousResponse(): string | null {
    return this.previousResponse;
  }

  // ============================================================================
  // NEW: Follow-up Processing Method
  // ============================================================================
  public async processFollowUp(): Promise<void> {
    if (this.isCurrentlyProcessing) {
      console.log("Processing already in progress. Skipping follow-up call.");
      return;
    }

    this.isCurrentlyProcessing = true;
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) {
      this.isCurrentlyProcessing = false;
      return;
    }

    try {
      // Set view to follow-up
      this.deps.setView("followup");
      
      // Notify that follow-up processing has started
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.FOLLOW_UP_START);
      
      // Get current screenshots for context
      const screenshotQueue = this.screenshotHelper.getScreenshotQueue();
      const extraScreenshotQueue = this.screenshotHelper.getExtraScreenshotQueue();
      
      if (screenshotQueue.length === 0 && extraScreenshotQueue.length === 0) {
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.FOLLOW_UP_ERROR, "No screenshots available");
        this.isCurrentlyProcessing = false;
        return;
      }

      // Capture user prompt before processing
      const userPrompt = this.deps.getUserPrompt?.() || "";

      // Clear the user prompt immediately to prevent reuse
      if (userPrompt) {
        this.deps.clearUserPrompt?.();
      }

      // Process follow-up with existing screenshots and user prompt
      const result = await this.processExtraScreenshotsHelper(
        await Promise.all(
          [...screenshotQueue, ...extraScreenshotQueue].map(async (path) => ({
            path,
            data: fs.readFileSync(path).toString("base64"),
          }))
        ),
        new AbortController().signal,
        userPrompt // Pass user prompt to follow-up processing
      );

      if (result.success && result.data) {
        // Send follow-up response
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.FOLLOW_UP_SUCCESS, {
          response: result.data,
          isFollowUp: true
        });
        
        // Update the main response with follow-up content
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.RESPONSE_SUCCESS, {
          response: result.data,
          isFollowUp: true
        });
        
        // Store the follow-up response for future context
        this.previousResponse = result.data;
        
        // Mark that we've followed up
        this.deps.setHasFollowedUp(true);
      } else {
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.FOLLOW_UP_ERROR, result.error || "Follow-up processing failed");
      }
      
    } catch (error: any) {
      console.error("Error in processFollowUp:", error);
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.FOLLOW_UP_ERROR, error.message || "Unknown error");
    } finally {
      this.isCurrentlyProcessing = false;
    }
  }

  // ============================================================================
  // BUG FIX: Cleanup on Destruction
  // ============================================================================
  public cleanup(): void {
    this.cancelOngoingRequests();
    this.clearProcessingTimeouts();
    this.isCurrentlyProcessing = false;
  }
}