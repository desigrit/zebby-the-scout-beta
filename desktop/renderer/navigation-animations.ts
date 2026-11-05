// Smart search plus Lucide's briefcase and sliders, authored as offline Lottie shapes.
export type NavigationKind = "plan" | "applications" | "boards" | "settings";
type Point = [number, number];
const fixed = (k: unknown) => ({ a: 0, k });
const curve = (v: Point[], c = false, i = v.map(() => [0, 0]), o = v.map(() => [0, 0])) => ({ v, c, i, o });
const shape = (name: string, k: unknown) => ({ ty: "sh", nm: name, ks: fixed(k) });
const line = (name: string, a: Point, b: Point) => shape(name, curve([a, b]));
function rounded(x: number, y: number, w: number, h: number, r: number) {
  const d = r * .5522848;
  return curve([[x + r, y], [x + w - r, y], [x + w, y + r], [x + w, y + h - r],
    [x + w - r, y + h], [x + r, y + h], [x, y + h - r], [x, y + r]], true,
    [[-d, 0], [0, 0], [0, -d], [0, 0], [d, 0], [0, 0], [0, d], [0, 0]],
    [[0, 0], [d, 0], [0, 0], [0, d], [0, 0], [-d, 0], [0, 0], [0, -d]]);
}
function circle(x: number, y: number, r: number) {
  const d = r * .5522848;
  return curve([[x, y - r], [x + r, y], [x, y + r], [x - r, y]], true,
    [[-d, 0], [0, -d], [d, 0], [0, d]], [[d, 0], [0, d], [-d, 0], [0, -d]]);
}
function animated(values: { t: number; value: number[] }[]) {
  return { a: 1, k: values.map(({ t, value }, index) => ({ t, s: value,
    ...(index < values.length - 1 ? { e: values[index + 1].value, i: { x: [.18], y: [1] }, o: { x: [.12], y: [0] } } : {}) })) };
}
function group(name: string, shapes: unknown[], position: unknown = fixed([0, 0]), transform: Record<string, unknown> = {}, strokeWidth = 2) {
  return { ty: "gr", nm: name, it: [...shapes,
    { ty: "st", c: fixed([0, 0, 0, 1]), o: fixed(100), w: fixed(strokeWidth), lc: 2, lj: 2 },
    { ty: "tr", p: position, a: fixed([0, 0]), s: fixed([100, 100]), r: fixed(0), o: fixed(100), sk: fixed(0), sa: fixed(0), ...transform }] };
}
function composition(name: string, shapes: unknown[]) {
  return { v: "5.13.0", fr: 60, ip: 0, op: 25, w: 24, h: 24, nm: name, ddd: 0, assets: [],
    layers: [{ ddd: 0, ind: 1, ty: 4, nm: name, sr: 1, ip: 0, op: 25, st: 0, bm: 0,
      ks: { o: fixed(100), r: fixed(0), p: fixed([0, 0, 0]), a: fixed([0, 0, 0]), s: fixed([100, 100, 100]) }, shapes }] };
}
function sparkle(name: string, shapes: unknown[], center: Point, start: number) {
  return group(name, shapes, fixed(center), { a: fixed(center),
    s: animated([{ t: 0, value: [100, 100] }, { t: start, value: [70, 70] },
      { t: start + 5, value: [115, 115] }, { t: 24, value: [100, 100] }]),
    o: animated([{ t: 0, value: [100] }, { t: start, value: [45] },
      { t: start + 5, value: [100] }, { t: 24, value: [100] }]) }, 1.5);
}
const sliderMotion = (x: number) => animated([{ t: 0, value: [0, 0] }, { t: 9, value: [x, 0] }, { t: 24, value: [0, 0] }]);
export const navigationAnimations: Record<NavigationKind, ReturnType<typeof composition>> = {
  boards: composition("Boards", [group("Panels", [shape("Frame", rounded(3, 3, 18, 18, 2)),
    line("Header", [3, 8], [21, 8]), line("Column", [9, 8], [9, 21])])]),
  plan: composition("Plan", [group("Magnifying glass", [shape("Lens", circle(8.5, 12.5, 6.5)),
    line("Handle", [13.1, 17.1], [18, 22])], fixed([8.5, 12.5]), { a: fixed([8.5, 12.5]),
    r: animated([{ t: 0, value: [0] }, { t: 5, value: [-7] }, { t: 11, value: [4] },
      { t: 17, value: [-2] }, { t: 24, value: [0] }]) }),
    sparkle("Star", [shape("Sparkle", curve([[18.5, 1.5], [19.3, 3.7], [21.5, 4.5], [19.3, 5.3],
      [18.5, 7.5], [17.7, 5.3], [15.5, 4.5], [17.7, 3.7]], true))], [18.5, 4.5], 4),
    sparkle("Sprinkle", [line("Vertical", [21.5, 9.6], [21.5, 12.4]),
      line("Horizontal", [20.1, 11], [22.9, 11])], [21.5, 11], 10)]),
  applications: composition("Applications", [group("Case", [shape("Body", rounded(2, 6, 20, 14, 2)),
    shape("Handle", curve([[8, 6], [8, 4], [10, 2], [14, 2], [16, 4], [16, 6]], false,
      [[0, 0], [0, 0], [-1.10457, 0], [0, 0], [0, -1.10457], [0, 0]],
      [[0, 0], [0, -1.10457], [0, 0], [1.10457, 0], [0, 0], [0, 0]]))]),
    group("Flap", [shape("Seam", curve([[2, 13], [12, 16], [22, 13]], false,
      [[0, 0], [-3.6, 0], [-2.9, 2]], [[2.9, 2], [3.6, 0], [0, 0]])), line("Clasp", [12, 12], [12.01, 12])],
      animated([{ t: 0, value: [0, 0] }, { t: 8, value: [0, -1.7] }, { t: 24, value: [0, 0] }]))]),
  settings: composition("Settings", [group("Top slider", [shape("Knob", circle(7, 7, 3)), line("Track", [10, 7], [19, 7])], sliderMotion(1.6)),
    group("Bottom slider", [shape("Knob", circle(17, 17, 3)), line("Track", [5, 17], [14, 17])], sliderMotion(-1.6))]),
};
