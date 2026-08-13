import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FRONTEND_ROOT = join("src", "frontend");

export async function applicationStylesheetHrefs(): Promise<string[]> {
  const html = await readFile(join(FRONTEND_ROOT, "index.html"), "utf8");
  return [...html.matchAll(/<link\s+[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]
    .map(match => match[1]!)
    .filter(href => href.startsWith("/") && !href.startsWith("/vendor/"));
}

export async function readApplicationStyles(): Promise<string> {
  const sources = await Promise.all((await applicationStylesheetHrefs()).map(async href => {
    if (href.includes("?") || href.includes("#") || href.includes("..")) throw new Error(`unsupported stylesheet href: ${href}`);
    return await readFile(join(FRONTEND_ROOT, href.slice(1)), "utf8");
  }));
  return sources.join("\n");
}
