import type { IncomingMessage } from "node:http";

export interface CanonicalOrigin {
  origin: string;
  host: string;
  protocol: "http:" | "https:";
}

interface CanonicalAuthority {
  hostname: string;
  port?: number;
}

function invalid(name: string): never { throw new Error(`${name} 格式错误`); }

function canonicalAuthority(value: string, name: string): CanonicalAuthority {
  if (!value || value !== value.trim() || value.length > 261 || /[^\x21-\x7e]/.test(value) || /[*@/\\?#,%]/.test(value)) invalid(name);

  let hostnameText: string;
  let portText: string | undefined;
  if (value.startsWith("[")) {
    const match = /^\[([0-9a-f:.]+)\](?::([0-9]+))?$/i.exec(value);
    if (!match) invalid(name);
    hostnameText = `[${match[1]!.toLowerCase()}]`;
    portText = match[2];
  } else {
    const match = /^([^:]+)(?::([0-9]+))?$/.exec(value);
    if (!match) invalid(name);
    hostnameText = match[1]!.toLowerCase();
    portText = match[2];
    if (hostnameText.length > 253 || hostnameText.endsWith(".")) invalid(name);
    const labels = hostnameText.split(".");
    if (labels.some(label => !label || label.length > 63 || label.startsWith("xn--") || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) invalid(name);
  }

  let parsedHostname: string;
  try { parsedHostname = new URL(`http://${hostnameText}`).hostname.toLowerCase(); }
  catch { invalid(name); }
  // Reject alternate numeric-IP and IPv6 spellings instead of silently mapping
  // visually different configuration or request values to a trusted host.
  if (parsedHostname !== hostnameText) invalid(name);

  if (portText === undefined) return { hostname: parsedHostname };
  if (!/^[1-9][0-9]{0,4}$/.test(portText)) invalid(name);
  const port = Number(portText);
  if (port > 65_535) invalid(name);
  return { hostname: parsedHostname, port };
}

function authorityText(authority: CanonicalAuthority, defaultPort?: number): string {
  return authority.port === undefined || authority.port === defaultPort
    ? authority.hostname
    : `${authority.hostname}:${authority.port}`;
}

/** Parse one exact HTTP Host value. Schemes, paths, wildcards and IDNs are not accepted. */
export function canonicalHost(value: string, name = "Host"): string {
  return authorityText(canonicalAuthority(value, name));
}

/** Parse an origin with no userinfo, path, query or fragment. */
export function canonicalOrigin(value: string, name = "Origin"): CanonicalOrigin {
  if (!value || value !== value.trim()) invalid(name);
  const match = /^(https?):\/\/(.+)$/i.exec(value);
  if (!match) invalid(name);
  const protocol = `${match[1]!.toLowerCase()}:` as "http:" | "https:";
  const authority = canonicalAuthority(match[2]!, name);
  const host = authorityText(authority, protocol === "http:" ? 80 : 443);
  return { origin: `${protocol}//${host}`, host, protocol };
}

function singleHeader(req: IncomingMessage, name: "host" | "origin"): string | undefined {
  const values = req.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

export function requestHostAllowed(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const header = singleHeader(req, "host");
  if (!header) return false;
  try { return trustedHosts.includes(canonicalHost(header)); }
  catch { return false; }
}

export function requestOriginAllowed(req: IncomingMessage, allowedOrigins: readonly string[]): boolean {
  const header = singleHeader(req, "origin");
  if (!header) return false;
  try { return allowedOrigins.includes(canonicalOrigin(header).origin); }
  catch { return false; }
}
