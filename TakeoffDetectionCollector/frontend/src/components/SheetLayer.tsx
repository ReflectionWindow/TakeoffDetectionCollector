import { useEffect, useRef } from "react";

type Props = {
  canvas: HTMLCanvasElement | null;
  zoom: number;
};

/**
 * Mount the raster canvas as a live DOM node. Encoding it to a PNG data URL
 * on every React render was what made the sheet hitch under the pointer.
 */
export default function SheetLayer({ canvas, zoom }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!canvas) return;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);
    return () => {
      if (canvas.parentNode === host) host.removeChild(canvas);
    };
  }, [canvas]);

  useEffect(() => {
    if (!canvas) return;
    canvas.className = zoom >= 2 ? "sheet-image sheet-image--pixelated" : "sheet-image";
  }, [canvas, zoom]);

  return <div ref={hostRef} className="sheet-host" />;
}
