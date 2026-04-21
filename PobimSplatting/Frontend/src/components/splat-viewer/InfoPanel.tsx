interface InfoPanelProps {
  projectId: string | null;
  fileLabel: string | null;
}

export function InfoPanel({ projectId, fileLabel }: InfoPanelProps) {
  return (
    <div
      className="brutal-card absolute bottom-5 left-5 z-40 w-72 max-w-sm p-3 text-[var(--text-primary)]"
      data-orbit-block="true"
    >
      <p className="brutal-eyebrow mb-3">Viewer Shortcuts</p>
      <ul className="space-y-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
        <li><strong className="text-[var(--ink)]">Left Drag</strong> Orbit • <strong className="text-[var(--ink)]">Right Drag</strong> Pan • <strong className="text-[var(--ink)]">Scroll</strong> Zoom</li>
        <li><strong className="text-[var(--ink)]">C</strong> Transform Panel • <strong className="text-[var(--ink)]">I</strong> Info</li>
        <li><strong className="text-[var(--ink)]">↑↓</strong> Rotate X • <strong className="text-[var(--ink)]">←→</strong> Rotate Y • <strong className="text-[var(--ink)]">Q/E</strong> Rotate Z</li>
        <li><strong className="text-[var(--ink)]">F</strong> Fullscreen • <strong className="text-[var(--ink)]">R</strong> Reset • <strong className="text-[var(--ink)]">ESC</strong> Back / Exit Fullscreen</li>
      </ul>
      {(fileLabel || projectId) && (
        <div className="mt-4 space-y-2 border-t-[var(--border-w)] border-[var(--ink)] pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
          {projectId && (
            <p>
              <span className="mr-1 font-bold text-[var(--ink)]">Project</span> {projectId}
            </p>
          )}
          {fileLabel && (
            <p className="break-all">
              <span className="mr-1 font-bold text-[var(--ink)]">File</span> {fileLabel}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
