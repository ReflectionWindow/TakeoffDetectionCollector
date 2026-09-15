import { useId, useState, type ReactNode } from "react";
import type { CanvasTool } from "./BoxCanvas";

type ActionId = "delete" | "duplicate" | "undo" | "redo";
type ToolId = CanvasTool | ActionId;

type ToolDef = {
  id: ToolId;
  name: string;
  description: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

type Props = {
  tool: CanvasTool;
  step: "blackout" | "boxes" | "labels";
  readOnly: boolean;
  geometryLocked: boolean;
  canDelete: boolean;
  canDuplicate: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onToolChange: (tool: CanvasTool) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onUndo: () => void;
  onRedo: () => void;
};

function Icon({ path, filled = false }: { path: string; filled?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  );
}

function ToolButton({
  def,
  hovered,
  onHover,
  tooltipIdPrefix,
}: {
  def: ToolDef;
  hovered: boolean;
  onHover: (id: ToolId | null) => void;
  tooltipIdPrefix: string;
}) {
  const tooltipId = `${tooltipIdPrefix}-${def.id}`;
  return (
    <div
      className="tool-slot"
      onMouseEnter={() => onHover(def.id)}
      onMouseLeave={() => onHover(null)}
    >
      <button
        type="button"
        aria-label={def.name}
        aria-describedby={tooltipId}
        aria-pressed={def.active}
        className={def.active ? "btn-tool btn-tool-active" : "btn-tool"}
        disabled={def.disabled}
        onClick={def.onClick}
        onFocus={() => onHover(def.id)}
        onBlur={() => onHover(null)}
      >
        {def.icon}
      </button>
      <span id={tooltipId} className="sr-only">
        {def.description}
      </span>
      {hovered ? (
        <div role="tooltip" className="tool-tip">
          <div className="tool-tip-name">{def.name}</div>
          <div className="tool-tip-desc">{def.description}</div>
        </div>
      ) : null}
    </div>
  );
}

export default function ToolPalette({
  tool,
  step,
  readOnly,
  geometryLocked,
  canDelete,
  canDuplicate,
  canUndo,
  canRedo,
  onToolChange,
  onDelete,
  onDuplicate,
  onUndo,
  onRedo,
}: Props) {
  const tooltipIdPrefix = useId();
  const [hovered, setHovered] = useState<ToolId | null>(null);
  const geometryDisabled = readOnly || geometryLocked;
  const drawName = step === "blackout" ? "Black out" : "Draw Box";
  const drawDesc =
    step === "blackout"
      ? "Drag a rectangle to cover leftover markups. These save as you draw."
      : geometryLocked
        ? "Box geometry editing is disabled."
        : "Drag a rectangle to add a new opening. Click to add polygon vertices.";

  const tools: ToolDef[] = [
    {
      id: "select",
      name: "Select",
      description: geometryLocked && step !== "blackout"
        ? "Click a shape, or drag across several to select a group. Shift-click or ⌘-click adds."
        : step === "blackout"
          ? "Click a blackout to select it, then drag to move or Delete to remove it."
          : "Click a shape to select. Drag to move; handles reshape. Drag empty space or Shift-click to select a group.",
      icon: <Icon path="M4 4l7 16 2.5-7L21 11z" />,
      active: tool === "select",
      disabled: false,
      onClick: () => onToolChange("select"),
    },
    {
      id: "pan",
      name: "Pan",
      description: "Scroll or drag to move the sheet. Space+drag also pans.",
      icon: <Icon path="M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8l-1.3 1.7a2 2 0 0 0 3 2.6L10 16m4-6v2a2 2 0 0 0 4 0v-1.5" />,
      active: tool === "pan",
      onClick: () => onToolChange("pan"),
    },
    {
      id: "draw",
      name: drawName,
      description: drawDesc,
      icon: <Icon path="M4 4h16v16H4z M9 12h6" filled={step === "blackout"} />,
      active: tool === "draw" || tool === "blackout",
      disabled: readOnly || (step !== "blackout" && geometryDisabled),
      onClick: () => onToolChange(step === "blackout" ? "blackout" : "draw"),
    },
  ];

  const actions: ToolDef[] = [
    {
      id: "duplicate",
      name: "Duplicate",
      description: "Copy the selected shape with a small offset (⌘D). ⌘C copies, ⌘V pastes. Alt-drag also stamps a copy.",
      icon: <Icon path="M8 8h12v12H8z M4 16V4h12" />,
      disabled: readOnly || !canDuplicate,
      onClick: onDuplicate,
    },
    {
      id: "delete",
      name: "Delete",
      description: "Remove the selected shape or blackout.",
      icon: <Icon path="M4 7h16M9 7V4h6v3M8 7l1 13h6l1-13" />,
      disabled: readOnly || !canDelete,
      onClick: onDelete,
    },
    {
      id: "undo",
      name: "Undo",
      description: "Undo the last edit (⌘Z / Ctrl+Z). Redo with ⇧⌘Z / Ctrl+Y.",
      icon: <Icon path="M9 14l-4-4 4-4M5 10h9a5 5 0 1 1 0 10H12" />,
      disabled: readOnly || !canUndo,
      onClick: onUndo,
    },
    {
      id: "redo",
      name: "Redo",
      description: "Redo the last undone edit (⇧⌘Z / Ctrl+Y).",
      icon: <Icon path="M15 14l4-4-4-4M19 10H10a5 5 0 1 0 0 10h2" />,
      disabled: readOnly || !canRedo,
      onClick: onRedo,
    },
  ];

  return (
    <div className="tool-palette instrument-chrome">
      {tools.map((def) => (
        <ToolButton
          key={def.id}
          def={def}
          hovered={hovered === def.id}
          onHover={setHovered}
          tooltipIdPrefix={tooltipIdPrefix}
        />
      ))}
      <div className="tool-palette-rule" />
      {actions.map((def) => (
        <ToolButton
          key={def.id}
          def={def}
          hovered={hovered === def.id}
          onHover={setHovered}
          tooltipIdPrefix={tooltipIdPrefix}
        />
      ))}
    </div>
  );
}
