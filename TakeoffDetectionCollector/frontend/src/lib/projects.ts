export type ProjectScope = "" | "root" | string;

export function uploadProjectId(scope: ProjectScope): string {
  if (!scope || scope === "root") return "";
  return scope;
}

export function uploadDestinationLabel(
  scope: ProjectScope,
  projects: { id: string; name: string }[],
): string {
  if (!scope || scope === "root") return "Root";
  return projects.find((p) => p.id === scope)?.name ?? "project";
}
