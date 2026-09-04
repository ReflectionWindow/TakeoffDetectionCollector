export const CLASSES = [
  { id: 1, name: "PW", color: "#8b5cf6" },
  { id: 2, name: "SF", color: "#06b6d4" },
  { id: 3, name: "WW", color: "#3ecf8e" },
  { id: 4, name: "CW", color: "#f59e0b" },
  { id: 5, name: "SF/CW", color: "#14b8a6" },
  { id: 6, name: "LOUVER", color: "#f5a623" },
  { id: 7, name: "METAL_PANEL", color: "#7c9cff" },
  { id: 8, name: "LOUVER_SOFT", color: "#fcd34d" },
  { id: 9, name: "METAL_PANEL_SOFT", color: "#c4b5fd" },
] as const;

export type ClassName = (typeof CLASSES)[number]["name"];

export function classByName(name: string) {
  return CLASSES.find((c) => c.name === name) ?? CLASSES[2];
}

export function classById(id: number) {
  return CLASSES.find((c) => c.id === id) ?? CLASSES[2];
}

export function classColor(name: string): string {
  return classByName(name).color;
}
