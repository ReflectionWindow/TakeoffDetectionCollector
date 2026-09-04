export function isBlackoutBox(box: { blackout?: boolean | null } | null | undefined): boolean {
  return box?.blackout === true;
}

export function openingBoxes<T extends { blackout?: boolean | null }>(boxes: T[]): T[] {
  return boxes.filter((b) => !isBlackoutBox(b));
}
