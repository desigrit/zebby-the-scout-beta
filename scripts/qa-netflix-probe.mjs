import { app } from "electron";
import { BoardBrowser } from "../desktop/board-browser";
import { scanBoard } from "../desktop/boards-scan";

function publicResult(data) {
  const root = data?.data || data;
  const positions = root?.positions || root?.jobs;
  return { keys: Object.keys(root || {}).slice(0, 22), count: root?.count ?? root?.totalCount,
    applied: root?.query, batch: positions?.length, ids: positions?.slice(0, 2).map(row => row.id),
    fields: positions?.length ? Object.keys(positions[0]) : undefined };
}
async function inspectRequests() {
  const site = new URL(process.env.NETFLIX_BOARD);
  const probes = [site.href];
  for (const endpoint of ["/api/pcsx/search", "/api/apply/v2/jobs"]) {
    for (const prefix of ["", "filter_"]) {
      const url = new URL(endpoint, site);
      url.searchParams.set("domain", "netflix.com"); url.searchParams.set("start", "0"); url.searchParams.set("num", "10");
      url.searchParams.set(prefix+"Teams", "Product Management"); url.searchParams.set(prefix+"Region", "ucan"); url.searchParams.set("sort_by", "relevance");
      probes.push(url.href);
    }
  }
  for (const offset of [10, 20]) {
    const batch = new URL("/api/apply/v2/jobs", site); batch.search = site.search; batch.searchParams.set("start", String(offset)); batch.searchParams.set("num", "10"); probes.push(batch.href);
  }
  await Promise.all(probes.map(async url => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const body = await response.text();
      let sample;
      try { sample = publicResult(JSON.parse(body)); } catch {
        const n = body.indexOf('"positions"');
        const nodeNames = [...body.matchAll(/<(?:script|input|code|pre|textarea|div)\b[^>]{0,300}?(?:id|name)=["']([^"']*)["'][^>]{0,200}>/gi)]
          .map(x => x[1]).filter(x => /data|config|pcs|search|position/i.test(x)).slice(0,35);
        sample = { title: body.match(/<title[^>]*>([^<]*)/i)?.[1], positionOffset: n, nodeNames };
      }
      console.log("HTTP", url, response.status, response.url, JSON.stringify(sample));
    } catch (error) { console.log("HTTP error",url,error.message); }
  }));
}
function domFacts() {
  const nodes = [...document.querySelectorAll("script:not([src]),input[type=hidden],pre,code,textarea")].map(el => {
    const value = (el.value || el.textContent || "").trim();
    if (!value.includes('"positions"')) return null;
    let decoded; try { decoded = JSON.parse(value); } catch {}
    return { tag: el.tagName, id: el.id, cls: el.className, length: value.length, positions: decoded?.positions?.length,
      total: decoded?.count, applied: decoded?.query, fields: decoded?.positions?.[0] && Object.keys(decoded.positions[0]) };
  }).filter(Boolean);
  const scroll = [...document.querySelectorAll("div,main,ul,section")].filter(el=>el.clientHeight>100 &&
    el.scrollHeight > el.clientHeight+5 && /auto|scroll/.test(getComputedStyle(el).overflowY)).slice(0,8).map(el=>({cls:el.className,id:el.id, height:el.clientHeight,scroll:el.scrollHeight}));
  return { title: document.title, url: location.href, ready: document.readyState, text: document.body.innerText.slice(0,450),
    knownLinks: [...document.querySelectorAll('a[href]')].filter(a=>/\/careers\/job\/|[?&]pid=/.test(a.href)).length,
    links: document.querySelectorAll("a[href]").length, nodes, scroll };
}
app.setPath("userData", process.env.NETFLIX_PROFILE);
app.on("window-all-closed",()=>{});
app.whenReady().then(async () => {
  console.log("Opening exact target:",process.env.NETFLIX_BOARD);
  const http = inspectRequests();
  const controller = new AbortController(), reader = new BoardBrowser(controller.signal);
  const wc = reader.window.webContents;
  const seen = new Set();
  wc.session.webRequest.onCompleted(details=>{
    if(details.url.startsWith("https://explore.jobs.netflix.net/api/") && !seen.has(details.url)){
      seen.add(details.url); console.log("BROWSER request",details.statusCode,details.url.slice(0,650));}
  });
  wc.on("did-fail-load",(_e,code,reason,url,main)=>{if(main)console.log("NAVIGATION failure",code,reason,url);});
  const oldRead=reader.read.bind(reader), snap=reader.snapshot.bind(reader);
  let readNumber=0,samples=0,nav=0;
  reader.snapshot=async()=>{const page=await snap();samples++;
    if(samples===1 || samples%18===0){console.log("READ sample",readNumber,samples,JSON.stringify({loading:page.loading,empty:page.empty,count:page.expectedTotal,links:page.candidates.length,
        page:page.pageNumber, controls:page.controls.slice(-6).map(c=>[c.text.slice(0,45),c.disabled]),bottom:page.atBottom}));
      console.log("DOM",JSON.stringify(await wc.executeJavaScript("("+domFacts.toString()+")()"))); }
    return page;};
  reader.read=async()=>{readNumber++; console.log("BEGIN batch",readNumber); const page=await oldRead(); console.log("READY batch", readNumber,page.candidates.length);return page;};
  try {
    const result=await scanBoard({url:process.env.NETFLIX_BOARD,reader,signal:controller.signal,provider:"coverage-test",model:"observed-ids",
      progress:message=>console.log("SCAN",message),extract:async input=>{
        if(input.task==="navigation"){const next=input.controls.find(c=>!c.disabled && /next page|(?:load|show) more (?:jobs|results|positions)/i.test(c.text));
          console.log("PAGINATION",++nav,next?.text,JSON.stringify(input.controls.map(c=>c.text.slice(0,90)).slice(-12)));return {listingIds:[],nextControlId:next?.id || ""};}
        return {listingIds:input.candidates.filter(c=>/\/careers\/job\/\d+|[?&]pid=\d+/.test(c.url)).map(c=>c.id), nextControlId:""};
      }});
    console.log("Current reader completed",result.pages,result.jobs.length);
  }catch(error){console.log("CURRENT READER ERROR",readNumber,samples,error.message);}
  finally {await http; reader.close();app.exit(0);}
}).catch(error=>{console.error(error);app.exit(1);});
