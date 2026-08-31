import { randomBytes } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { SecretValue, type ApprovedPostgresTarget } from "../foundation/safety.mts";

export type DynamicRoleSecrets = Readonly<{
  anon: SecretValue;
  authenticated: SecretValue;
  service_role: SecretValue;
  tivdoc_policy_probe: SecretValue;
}>;

export type DynamicRoleReceipt = Readonly<{
  schema_version: "tivdoc-real-postgresql-role-sessions-v0.9.1";
  roles: readonly Readonly<{
    role: "anon" | "authenticated" | "service_role" | "tivdoc_policy_probe";
    login: true;
    superuser: false;
    bypass_rls: boolean;
  }>[];
  scram_passwords_configured: 4;
  credentials_emitted: 0;
  status: "PASS";
}>;

const ROLE_NAMES = Object.freeze(["anon", "authenticated", "service_role", "tivdoc_policy_probe"] as const);

export function generateDynamicRoleSecrets(): DynamicRoleSecrets {
  const secret = (): SecretValue => new SecretValue(randomBytes(36).toString("base64url"));
  return Object.freeze({
    anon: secret(),
    authenticated: secret(),
    service_role: secret(),
    tivdoc_policy_probe: secret(),
  });
}

/** Configures login-only test credentials without returning or logging them. */
export async function configureDynamicRoleSessions(input: Readonly<{
  admin_connection_url: string;
  secrets: DynamicRoleSecrets;
}>): Promise<DynamicRoleReceipt> {
  const pool = new Pool({
    connectionString: input.admin_connection_url,
    application_name: "tivdoc-v091-role-bootstrap",
    ssl: false,
    max: 1,
    allowExitOnIdle: true,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query("set password_encryption = 'scram-sha-256'");
      await client.query("alter role anon login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls");
      await client.query("alter role authenticated login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls");
      await client.query("alter role service_role login nosuperuser nocreatedb nocreaterole noinherit noreplication bypassrls");
      await client.query(`do $role$
        begin
          if not exists (select 1 from pg_roles where rolname = 'tivdoc_policy_probe') then
            create role tivdoc_policy_probe login nosuperuser nocreatedb nocreaterole inherit noreplication nobypassrls;
          end if;
        end
      $role$`);
      await client.query("alter role tivdoc_policy_probe login nosuperuser nocreatedb nocreaterole inherit noreplication nobypassrls");
      await client.query("grant service_role to tivdoc_policy_probe");
      for (const role of ROLE_NAMES) await setRolePassword(client, role, input.secrets[role]);
      const result = await client.query<{
        role: DynamicRoleReceipt["roles"][number]["role"];
        login: boolean;
        superuser: boolean;
        bypass_rls: boolean;
      }>(`
        select rolname as role, rolcanlogin as login, rolsuper as superuser, rolbypassrls as bypass_rls
        from pg_roles where rolname = any($1::text[]) order by rolname`, [ROLE_NAMES]);
      if (result.rows.length !== ROLE_NAMES.length
        || result.rows.some((row) => !row.login || row.superuser
          || (row.role === "service_role") !== row.bypass_rls)) {
        throw new Error("DYNAMIC_ROLE_CONFIGURATION_INVALID");
      }
      return Object.freeze({
        schema_version: "tivdoc-real-postgresql-role-sessions-v0.9.1",
        roles: Object.freeze(result.rows.map((row) => Object.freeze({ ...row }))),
        scram_passwords_configured: 4,
        credentials_emitted: 0,
        status: "PASS",
      });
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export function targetConnectionUrl(
  target: ApprovedPostgresTarget,
  database = target.descriptor.database,
  username = target.username.reveal(),
  password = target.password.reveal(),
): string {
  if (!/^tivdoc_v09_[a-z0-9_]{8,48}$/u.test(database) && database !== "postgres") {
    throw new Error("DYNAMIC_DATABASE_NAME_UNSAFE");
  }
  const url = new URL("postgresql://127.0.0.1");
  url.hostname = target.descriptor.host;
  url.port = String(target.descriptor.port);
  url.username = username;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

export function roleConnectionUrls(input: Readonly<{
  target: ApprovedPostgresTarget;
  database: string;
  secrets: DynamicRoleSecrets;
}>): Readonly<Record<keyof DynamicRoleSecrets, string>> {
  return Object.freeze(Object.fromEntries(ROLE_NAMES.map((role) => [
    role,
    targetConnectionUrl(input.target, input.database, role, input.secrets[role].reveal()),
  ])) as Record<keyof DynamicRoleSecrets, string>);
}

async function setRolePassword(client: PoolClient, role: typeof ROLE_NAMES[number], secret: SecretValue): Promise<void> {
  const formatted = await client.query<{ command: string }>(
    "select format('alter role %I password %L', $1::text, $2::text) as command",
    [role, secret.reveal()],
  );
  const command = formatted.rows[0]?.command;
  if (!command) throw new Error("DYNAMIC_ROLE_PASSWORD_COMMAND_MISSING");
  await client.query(command);
}
