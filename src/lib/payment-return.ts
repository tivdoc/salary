export function paymentReturnDestination(requestUrl: string) {
  const destination = new URL("/check/received", requestUrl);
  destination.searchParams.set("returned", "1");
  return destination;
}
