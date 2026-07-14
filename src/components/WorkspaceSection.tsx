import type { ReactNode } from "react";
import type { LayoutSectionId } from "../services/layoutExperience";

interface Props {
  id: LayoutSectionId;
  title: string;
  collapsed: boolean;
  first: boolean;
  last: boolean;
  busy: boolean;
  children: ReactNode;
  onToggle: (id: LayoutSectionId, collapsed: boolean) => void;
  onMove: (id: LayoutSectionId, direction: -1 | 1) => void;
}

const WorkspaceSection = ({
  id,
  title,
  collapsed,
  first,
  last,
  busy,
  children,
  onToggle,
  onMove
}: Props) => {
  const contentId = `workspace-section-${id}`;
  return (
    <section
      className={first ? "workspace-section workspace-section--first" : "workspace-section"}
      data-layout-section={id}
      data-guide={id === "prompts" ? "section-prompts" : undefined}
    >
      <header className="workspace-section__header">
        <button
          type="button"
          className="workspace-section__toggle"
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={() => onToggle(id, !collapsed)}
          disabled={busy}
        >
          <span aria-hidden="true">{collapsed ? "+" : "-"}</span>
          <span>{title}</span>
        </button>
        <div className="workspace-section__order" aria-label={`${title}排序`}>
          <button
            type="button"
            className="icon-button"
            aria-label={`上移${title}`}
            title={`上移${title}`}
            disabled={busy || first}
            onClick={() => onMove(id, -1)}
          >
            <span aria-hidden="true">↑</span>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`下移${title}`}
            title={`下移${title}`}
            disabled={busy || last}
            onClick={() => onMove(id, 1)}
          >
            <span aria-hidden="true">↓</span>
          </button>
        </div>
      </header>
      <div id={contentId} className="workspace-section__body" hidden={collapsed}>
        {children}
      </div>
    </section>
  );
};

export default WorkspaceSection;
