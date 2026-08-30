if (typeof window !== "undefined") {
  throw new Error("internal_ops_server_module_imported_in_browser");
}

export const INTERNAL_OPS_SERVER_BOUNDARY = true as const;
