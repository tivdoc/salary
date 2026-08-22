import { NextResponse } from "next/server";

export function paymentReturnDestination(requestUrl: string) {
  const destination = new URL("/check/received", requestUrl);
  destination.searchParams.set("returned", "1");
  return destination;
}

export function GET(request: Request) {
  return NextResponse.redirect(paymentReturnDestination(request.url));
}
