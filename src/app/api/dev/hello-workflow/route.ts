import { start } from "workflow/api";
import { helloWorkflow } from "@/workflows/hello";
import { NextResponse } from "next/server";

export async function GET() {
  const run = await start(helloWorkflow, ["world"]);
  const value = await run.returnValue;
  return NextResponse.json({ runId: run.runId, value });
}
