import type { BoardIdentity } from "../shared/boards.ts";

export function boardUrl(value: string): URL {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.includes(".") ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|onion|lan)$/.test(url.hostname)) {
    throw new Error("Use a public HTTPS board link.");
  }
  return url;
}

// Board filters can live in the query or fragment. Never use the job-import
// normalizer here: it deliberately removes fields that a saved search may need.
export function boardSearchKey(value: string): string {
  const url = boardUrl(value);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url.href;
}

export function boardJobIdentity(value: string): BoardIdentity {
  const url = boardUrl(value), parts = url.pathname.split("/").filter(Boolean);
  let identity = "";
  if (url.hostname === "jobs.uber.com") identity = url.pathname.match(/\/jobs\/(\d+)\/?$/)?.[1] || "";
  if (url.hostname === "www.metacareers.com" || url.hostname === "metacareers.com") {
    identity = url.pathname.match(/\/job_details\/(\d+)\/?$/)?.[1] || "";
    if (identity) return { key: `metacareers.com:${identity}`, url: url.href };
  }
  if (url.hostname.endsWith(".myworkdayjobs.com")) {
    identity = url.pathname.match(/_(JR[\w-]+|R[-\w]+)\/?$/i)?.[1] || "";
    if (identity) return { key: `${url.hostname}:${parts[0] === "en-US" ? parts[1] : parts[0]}:${identity}`, url: url.href };
  }
  if (["job-boards.greenhouse.io", "boards.greenhouse.io"].includes(url.hostname)) {
    const id = url.pathname.match(/\/jobs\/(\d+)\/?$/)?.[1];
    if (id) return { key: `greenhouse:${parts[0]}:${id}`, url: url.href };
  }
  if (["jobs.lever.co", "jobs.eu.lever.co", "jobs.ashbyhq.com"].includes(url.hostname) && parts.length >= 2) {
    return { key: `${url.hostname}:${parts[0]}:${parts[1]}`, url: url.href };
  }
  if (identity) return { key: `${url.hostname}:${identity}`, url: url.href };
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return { key: url.href, url: url.href };
}
