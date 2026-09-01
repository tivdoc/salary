if (typeof window !== "undefined") {
  throw new Error("dependency_invalidation_server_module_imported_in_browser");
}

export const DEPENDENCY_INVALIDATION_SERVER_BOUNDARY = true as const;
