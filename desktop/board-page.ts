import type { BoardCandidate, BoardControl } from "../shared/boards";
import { isNetflixPosition, isNetflixSearch } from "./netflix-board";

export type BoardPage = { url: string; title: string; summary: string; candidates: BoardCandidate[]; controls: BoardControl[];
  expectedTotal: number | null; pageNumber: number | null; pageCount: number | null;
  empty: boolean; loading: boolean; blocked: boolean; atBottom: boolean; scrollY: number; height: number };

// Serialized into an isolated webContents. Keep this function self-contained.
export function captureBoardPage(sectionId?: string): BoardPage {
  const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const clean = (text: string | null, limit: number) => (text || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const root = sectionId ? document.getElementById(sectionId) : document.body;
  const text = root?.innerText || "";
  function departmentFor(link: HTMLAnchorElement, row: HTMLElement, title: string) {
    const explicit = link.closest("[data-department]")?.getAttribute("data-department") ||
      row.querySelector<HTMLElement>('[itemprop="occupationalCategory"], [data-testid="job-department"]')?.innerText;
    if (explicit) return clean(explicit, 200);
    const headings = 'h2,h3,h4,h5,h6,[role="heading"]';
    for (let branch: Element | null = link; branch && branch !== root && !branch.matches("main,body"); branch = branch.parentElement) {
      // A heading immediately before the job list owns its links. An adjacent
      // job card or a heading inside another link belongs to a different role.
      const previous = branch.previousElementSibling;
      const heading = previous?.matches(headings) ? previous : previous?.matches("header") ? previous.querySelector(headings) : null;
      if (heading && visible(heading) && !heading.querySelector("a[href]")) {
        const label = clean(heading.textContent, 200);
        if (label && label !== title) return label;
      }
    }
    return "";
  }
  const candidates: BoardCandidate[] = [];
  const urls = new Set<string>();
  for (const element of root?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []) {
    if (!visible(element)) continue;
    try {
      const url = new URL(element.href);
      if (url.protocol !== "https:" || url.username || url.password || urls.has(url.href)) continue;
      urls.add(url.href);
      const title = clean(element.innerText || element.getAttribute("aria-label"), 300);
      const row = element.closest<HTMLElement>('li,tr,article,[role="listitem"]') || element.parentElement || element;
      const rowText = row.querySelectorAll("a[href]").length <= 1 ? row.innerText : element.innerText;
      candidates.push({ id: `l${candidates.length}`, url: url.href, title, department: departmentFor(element, row, title),
        text: clean(`${element.getAttribute("aria-label") || ""} ${rowText}`, 600) });
    } catch { /* Invalid links cannot be listing candidates. */ }
  }
  const controls: BoardControl[] = [];
  for (const element of root?.querySelectorAll<HTMLElement>("button, [role=button], a[href]") ?? []) {
    if (!visible(element)) continue;
    const label = clean(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.innerText}`, 300);
    const parentText = element.parentElement?.innerText || "";
    const surroundingText = element.parentElement?.parentElement?.innerText || "";
    const context = clean(/page\s+\d+\s+(?:of|\/)\s*\d+/i.test(surroundingText) ? surroundingText : parentText, 700);
    if (!/\b(?:next|more|load)\b|^forward$|^\d+$/i.test(label) && !/page\s+\d+\s+(?:of|\/)\s*\d+/i.test(context)) continue;
    const id = `c${controls.length}`;
    element.setAttribute("data-zebby-board-control", id);
    controls.push({ id, text: label, context,
      disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" });
  }
  const page = text.match(/page\s+(\d+)\s+(?:of|\/)\s*(\d+)/i);
  const total = text.match(/\b(\d[\d,]*)\s+(?:open (?:jobs|positions|roles)|items|jobs found|jobs available|results found|results|jobs)\b/i);
  const pageLinks = [...(root?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])].filter(visible).map(link => {
    try { const url = new URL(link.href); return url.origin === location.origin && url.pathname === location.pathname ? Number(url.searchParams.get("page")) : 0; }
    catch { return 0; }
  }).filter(value => Number.isSafeInteger(value) && value > 0);
  const empty = /\b(no (?:open |matching |available )?(?:jobs|positions|results)|0 (?:open (?:jobs|positions|roles)|items|jobs|results))\b/i.test(text);
  const height = document.documentElement.scrollHeight;
  return { url: location.href, title: document.title.slice(0, 300),
    summary: (text.slice(0, 1500) + "\n" + text.slice(-2500)).slice(0, 4000), candidates, controls,
    expectedTotal: total ? Number(total[1].replace(/,/g, "")) : empty ? 0 : null,
    pageNumber: page ? Number(page[1]) : pageLinks.length ? Number(new URL(location.href).searchParams.get("page")) || 1 : null,
    pageCount: page ? Number(page[2]) : pageLinks.length ? Math.max(...pageLinks) : null,
    empty, loading: /\bloading (?:jobs|results|opportunities)/i.test(text),
    blocked: /\b(verify (?:that )?you are human|unusual traffic|access denied|checking your browser|complete the captcha)\b/i.test(document.body?.innerText || ""),
    atBottom: window.scrollY + window.innerHeight >= height - 8, scrollY: window.scrollY, height };
}

export function isFigmaCareers(url: URL) {
  return ["www.figma.com", "figma.com"].includes(url.hostname) && /^\/careers\/?$/.test(url.pathname);
}

export function knownListing(url: string, board: string): boolean | null {
  const source = new URL(board), link = new URL(url);
  if (isNetflixSearch(source)) return isNetflixPosition(link);
  if (isFigmaCareers(source) && ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(link.hostname) &&
      /^\/figma\/jobs\/\d+\/?$/.test(link.pathname)) return true;
  if (source.hostname === "slack.com") return link.hostname.endsWith(".myworkdayjobs.com") && /\/Slack\/job\//.test(link.pathname);
  if (source.hostname === "jobs.uber.com") return link.hostname === source.hostname && /\/jobs\/\d+\/?$/.test(link.pathname);
  if (["www.metacareers.com", "metacareers.com"].includes(source.hostname)) {
    return /^(www\.)?metacareers\.com$/.test(link.hostname) && /\/job_details\/\d+\/?$/.test(link.pathname);
  }
  return null;
}

export function knownNext(page: BoardPage): string | null {
  const source = new URL(page.url), host = source.hostname;
  if (isNetflixSearch(source)) return page.controls[0]?.id || "";
  if (isFigmaCareers(new URL(page.url)) && !page.controls.length && !(page.pageCount && (page.pageNumber || 1) < page.pageCount)) return "";
  if (host === "slack.com") return "";
  if (host === "jobs.uber.com") {
    const next = page.controls.find(control => /next page/i.test(control.text) && !control.disabled)?.id || "";
    if (!next && page.pageNumber && page.pageCount && page.pageNumber < page.pageCount) throw new Error("The next page of Uber jobs could not be found.");
    return next;
  }
  if (["www.metacareers.com", "metacareers.com"].includes(host)) {
    if (!page.pageNumber || !page.pageCount) throw new Error("Meta's results did not finish loading. Try the check again.");
    if (page.pageNumber >= page.pageCount) return "";
    const controls = page.controls.filter(control => /page\s+\d+\s+of\s+\d+/i.test(control.context) && !control.disabled);
    const next = controls.at(-1);
    if (!next) throw new Error("The next page of Meta jobs could not be found.");
    return next.id;
  }
  return null;
}
