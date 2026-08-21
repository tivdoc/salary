import { NextResponse } from "next/server";

export function GET(request: Request) {
  const destination = new URL("/check/received", request.url);
  destination.searchParams.set("returned", "1");
  return NextResponse.redirect(destination);
}
