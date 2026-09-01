if (typeof window !== "undefined") {
  throw new Error("platform_auth_server_module_imported_in_browser");
}

export const PLATFORM_AUTH_SERVER_BOUNDARY = true as const;
