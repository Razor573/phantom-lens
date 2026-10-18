import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";

interface ThinkingIndicatorProps {
  size?: "sm" | "md" | "lg";
  thinking?: string;
  isThinking?: boolean;
  thinkingDuration?: number;
}

export default function ThinkingIndicator({
  size = "md",
  thinking = "",
  isThinking = true,
  thinkingDuration,
}: ThinkingIndicatorProps) {
  const [isExpanded, setIsExpanded] = useState<boolean>(Boolean(isThinking));
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const prevIsThinkingRef = useRef<boolean>(Boolean(isThinking));
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Track live elapsed seconds while actively thinking
  useEffect(() => {
    if (!isThinking) return;
    setElapsedSeconds(0);
    const interval = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isThinking]);

  // Automatically expand when thinking starts and collapse when final answer starts
  useEffect(() => {
    if (isThinking && !prevIsThinkingRef.current) {
      setIsExpanded(true);
    } else if (!isThinking && prevIsThinkingRef.current) {
      setIsExpanded(false);
    }
    prevIsThinkingRef.current = Boolean(isThinking);
  }, [isThinking]);

  // Auto-scroll thought content as new tokens stream in while expanded
  useEffect(() => {
    if (isExpanded && isThinking && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop =
        scrollContainerRef.current.scrollHeight;
    }
  }, [thinking, isExpanded, isThinking]);

  const hasThoughts = Boolean(thinking && thinking.trim().length > 0);
  const displayDuration =
    typeof thinkingDuration === "number" && thinkingDuration > 0
      ? thinkingDuration
      : elapsedSeconds > 0
        ? elapsedSeconds
        : 1;

  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
  };

  return (
    <div
      className="w-full rounded-xl transition-all duration-200 overflow-hidden"
      style={{
        background: isThinking
          ? "rgba(255, 255, 255, 0.04)"
          : "rgba(255, 255, 255, 0.03)",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        pointerEvents: "auto",
      }}
    >
      {/* Clickable Header */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-left select-none hover:bg-white/5 transition-colors"
        style={{ pointerEvents: "auto", cursor: "pointer" }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {isThinking ? (
            <div className={`${sizeClasses[size]} relative flex items-center justify-center flex-shrink-0`}>
              <div className="w-full h-full bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center shadow-sm animate-pulse">
                <Sparkles className="w-3 h-3 text-white/90" />
              </div>
              <div className="absolute inset-0 rounded-full border border-blue-400/50 animate-ping" />
            </div>
          ) : (
            <div className="w-4 h-4 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-2.5 h-2.5 text-blue-300/80" />
            </div>
          )}

          <span className="text-xs font-medium text-white/85 tracking-wide truncate">
            {isThinking
              ? elapsedSeconds > 0
                ? `Thinking... (${elapsedSeconds}s)`
                : "Thinking..."
              : `Thought for ${displayDuration}s`}
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-white/50 flex-shrink-0 ml-2">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </div>
      </button>

      {/* Collapsible Thought Steps Body */}
      {isExpanded && (
        <div
          ref={scrollContainerRef}
          className="px-3.5 pb-3 pt-1 max-h-48 overflow-y-auto text-xs leading-relaxed text-white/65 border-t border-white/5 font-normal whitespace-pre-wrap break-words"
          style={{
            overflowWrap: "break-word",
            wordBreak: "break-word",
          }}
        >
          {hasThoughts ? (
            <div className="pl-2.5 border-l-2 border-blue-400/30 space-y-1.5">
              {thinking.trim()}
            </div>
          ) : (
            <div className="flex items-center gap-2 py-1 text-white/50 italic">
              <span>Analyzing screen context and formulating solution...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
