import { collectUndoInfo, executeUndo } from "../../../../src/web/undo-service.ts"
import { requireProjectCwd } from "../../../../src/web/bridge-service.ts"
import { cloudModeLocalRouteGuard } from "../../../lib/cloud-mode.ts";

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  const cloudGuard = cloudModeLocalRouteGuard();
  if (cloudGuard) return cloudGuard;
  try {
    const projectCwd = requireProjectCwd(request);
    const payload = await collectUndoInfo(projectCwd)
    return Response.json(payload, {
      headers: {
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: message },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    )
  }
}

export async function POST(request: Request): Promise<Response> {
  const cloudGuard = cloudModeLocalRouteGuard();
  if (cloudGuard) return cloudGuard;
  try {
    const projectCwd = requireProjectCwd(request);
    const payload = await executeUndo(projectCwd)
    return Response.json(payload, {
      headers: {
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: message },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    )
  }
}
