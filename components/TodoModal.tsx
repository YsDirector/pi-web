"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionTodoItem } from "@/lib/session-reader";

interface TodoModalProps {
  sessionId: string;
  /** Active branch leaf id (from BranchNavigator); empty for the root branch. */
  leafId: string | null;
  onClose: () => void;
}

const POLL_MS = 3000;

/**
 * Modal showing the current session's todo list (pi-deck-todo extension).
 * Fetches from /api/sessions/[id]/todos and polls while open so progress stays
 * in sync while the agent is running.
 */
export function TodoModal({ sessionId, leafId, onClose }: TodoModalProps) {
  const { t } = useI18n();
  const [todos, setTodos] = useState<SessionTodoItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const query = leafId ? `?leafId=${encodeURIComponent(leafId)}` : "";
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/todos${query}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as { todos?: SessionTodoItem[] };
      setTodos(Array.isArray(data.todos) ? data.todos : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, leafId]);

  // Fetch immediately, then poll while the modal is open.
  useEffect(() => {
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Close on Escape (focused dialog — same pattern as ModelsConfig).
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const list = todos ?? [];
  const pending = list.filter((todo) => !todo.done);
  const done = list.filter((todo) => todo.done);

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.4)",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="todo-modal-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        style={{
          width: 420,
          maxWidth: "100%",
          maxHeight: "min(560px, 80dvh)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-panel)",
          boxShadow: "0 12px 36px rgba(0,0,0,0.24)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 16px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
            <rect x="9" y="3" width="6" height="4" rx="1" />
            <path d="m9 14 2 2 4-4" />
          </svg>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div id="todo-modal-title" style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              {t("todo.title")}
            </div>
            {!loading && list.length > 0 && (
              <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-dim)" }}>
                {t("todo.progress", { done: done.length, total: list.length })}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t("todo.close")}
            aria-label={t("todo.close")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, padding: 0,
              background: "none", border: "none", borderRadius: 5,
              color: "var(--text-dim)", cursor: "pointer", flexShrink: 0,
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--text)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-dim)";
              e.currentTarget.style.background = "none";
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 16px 14px" }}>
          {loading && list.length === 0 ? (
            <div style={{ padding: "18px 0", textAlign: "center", fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>
              {t("todo.loading")}
            </div>
          ) : list.length === 0 ? (
            <div style={{ padding: "18px 0", textAlign: "center" }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("todo.empty")}</div>
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)" }}>{t("todo.emptyHint")}</div>
            </div>
          ) : (
            <>
              {pending.length > 0 && (
                <div style={{ marginBottom: done.length > 0 ? 14 : 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
                    {t("todo.pending")}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {pending.map((todo) => (
                      <TodoRow key={todo.id} todo={todo} />
                    ))}
                  </div>
                </div>
              )}
              {done.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
                    {t("todo.done")}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {done.map((todo) => (
                      <TodoRow key={todo.id} todo={todo} done />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {error && (
            <div role="alert" style={{ marginTop: 10, fontSize: 11, color: "#ef4444" }}>
              {t("todo.loadError")}: {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TodoRow({ todo, done = false }: { todo: SessionTodoItem; done?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "6px 8px",
        borderRadius: 5,
        fontSize: 12.5,
        lineHeight: 1.45,
        color: done ? "var(--text-dim)" : "var(--text)",
        textDecoration: done ? "line-through" : "none",
        background: "var(--bg)",
        border: "1px solid var(--border)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flexShrink: 0,
          marginTop: 1,
          color: done ? "#22c55e" : "var(--text-dim)",
          fontSize: 12,
        }}
      >
        {done ? "☑" : "☐"}
      </span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{todo.text}</span>
    </div>
  );
}
