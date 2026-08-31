import "./server-boundary.ts";

export type StableProductRouteFlags = Readonly<{
  portalUi: boolean;
  portalApi: boolean;
  operationsUi: boolean;
  operationsApi: boolean;
}>;

export function readStableProductRouteFlags(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): StableProductRouteFlags {
  return Object.freeze({
    portalUi: enabled(environment.TIVDOC_PORTAL_UI_ENABLED),
    portalApi: enabled(environment.TIVDOC_PORTAL_API_ENABLED),
    operationsUi: enabled(environment.TIVDOC_OPERATIONS_UI_ENABLED),
    operationsApi: enabled(environment.TIVDOC_OPERATIONS_API_ENABLED),
  });
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
