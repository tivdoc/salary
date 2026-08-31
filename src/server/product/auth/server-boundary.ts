if (typeof window !== "undefined") {
  throw new Error("product_auth_server_module_imported_in_browser");
}

export const PRODUCT_AUTH_SERVER_BOUNDARY = true as const;
