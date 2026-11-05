import { useEffect, useRef } from "react";
import lottie, { type AnimationItem } from "lottie-web/build/player/lottie_light";
import { BriefcaseBusiness, Settings2 } from "lucide-react";
import { boardIconRows, navigationAnimations, type NavigationKind } from "./navigation-animations";

function SmartSearchIcon({ className, size }: { className?: string; size: number }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx={8.5} cy={12.5} r={6.5} /><path d="M13.1 17.1 18 22" />
    <path strokeWidth={1.5} d="m18.5 1.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z M21.5 9.6v2.8 M20.1 11h2.8" />
  </svg>;
}

function BoardsIcon({ className, size }: { className?: string; size: number }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x={3} y={3} width={18} height={18} rx={2} /><path d="M3 8h18" />
    {boardIconRows.map(({ y, endX }) => <path key={y} strokeWidth={1.8} d={`M7 ${y}h.01 M10.5 ${y}H${endX}`} />)}
  </svg>;
}

const icons = { plan: SmartSearchIcon, applications: BriefcaseBusiness, boards: BoardsIcon, settings: Settings2 };
export default function NavigationButton({ kind, label, selected, collapsed, onActivate, disabled = false }: {
  kind: NavigationKind; label: string; selected: boolean; collapsed: boolean; onActivate: () => boolean;
  disabled?: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null), player = useRef<HTMLSpanElement>(null);
  const animation = useRef<AnimationItem | null>(null);
  const Icon = icons[kind];
  useEffect(() => {
    const element = host.current, container = player.current;
    if (!element || !container) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const instance = lottie.loadAnimation({ container, renderer: "svg", loop: false, autoplay: false,
      animationData: structuredClone(navigationAnimations[kind]), rendererSettings: { focusable: false } });
    animation.current = instance;
    const rest = () => { instance.goToAndStop(24, true); element.dataset.playing = "false"; };
    const ready = () => { rest(); element.dataset.ready = "true"; };
    const failed = () => { element.dataset.ready = "false"; element.dataset.playing = "false"; };
    const reduce = () => { if (motion.matches) rest(); };
    const hidden = () => { if (document.hidden) rest(); };
    instance.addEventListener("DOMLoaded", ready); instance.addEventListener("complete", rest);
    instance.addEventListener("data_failed", failed); instance.addEventListener("error", failed);
    if (instance.isLoaded) ready();
    motion.addEventListener("change", reduce); document.addEventListener("visibilitychange", hidden);
    return () => { motion.removeEventListener("change", reduce); document.removeEventListener("visibilitychange", hidden);
      animation.current = null; instance.destroy(); element.dataset.ready = "false"; };
  }, [kind]);
  function activate() {
    if (!onActivate()) return;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && !document.hidden && animation.current?.isLoaded) {
      if (host.current) host.current.dataset.playing = "true";
      animation.current.goToAndPlay(0, true);
    }
  }
  return <button type="button" className={selected ? "active" : ""} onClick={activate} disabled={disabled}
    aria-label={label} title={collapsed ? label : undefined} aria-current={selected ? "page" : undefined}>
    <span className="navigation-icon" data-kind={kind} ref={host} aria-hidden="true">
      <Icon className="navigation-icon-fallback" size={24} /><span className="navigation-icon-player" ref={player} />
    </span><span className="nav-label">{label}{kind === "boards" && <span className="nav-private-tag">Private</span>}</span>
  </button>;
}
