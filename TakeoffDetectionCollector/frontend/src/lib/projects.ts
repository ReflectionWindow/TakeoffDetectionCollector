export type ProjectScope = "" | "root" | string;

/** Default upload destination is Root, independent of the inbox filter. */
export const ROOT_UPLOAD_DEST = "root";

export function uploadProjectId(dest: ProjectScope): string {
  if (!dest || dest === "root") return "";
  return dest;
}

export function uploadDestinationLabel(
  dest: ProjectScope,
  projects: { id: string; name: string }[],
): string {
  if (!dest || dest === "root") return "Root";
  return projects.find((p) => p.id === dest)?.name ?? "project";
}

export function uploadDestinations(
  projects: { id: string; name: string }[],
): { id: string; name: string }[] {
  return [{ id: ROOT_UPLOAD_DEST, name: "Root" }, ...projects];
}
