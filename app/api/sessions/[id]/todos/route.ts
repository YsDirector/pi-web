import { NextResponse } from "next/server";
import { resolveSessionPath, getSessionTodos } from "@/lib/session-reader";

/**
 * GET /api/sessions/[id]/todos?leafId=<optional>
 *
 * Returns the branch-scoped todo list for a session. The todo state is stored
 * by the pi-deck-todo extension as a custom `pi-deck-todo` session entry, so we
 * read the last snapshot on the active branch from the session file.
 *
 * Response: { todos: [{ id, text, done }], nextId }
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const todos = getSessionTodos(filePath, leafId);
    return NextResponse.json(todos);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
