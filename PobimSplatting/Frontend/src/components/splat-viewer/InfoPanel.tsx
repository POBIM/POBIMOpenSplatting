interface InfoPanelProps {
  projectId: string | null;
  fileLabel: string | null;
}

export function InfoPanel({ projectId, fileLabel }: InfoPanelProps) {
  return (
    <div
      className="absolute bottom-5 left-5 z-40 w-72 max-w-sm rounded-2xl border border-white/10 bg-slate-950/85 p-4 text-white shadow-xl backdrop-blur"
      data-orbit-block="true"
    >
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/60">Shortcuts</h3>
      <ul className="space-y-1.5 text-xs text-white/70">
        <li><strong className="text-white">Left drag</strong> orbit • <strong className="text-white">Right drag</strong> pan • <strong className="text-white">Scroll</strong> zoom</li>
        <li><strong className="text-white">C</strong> transform panel • <strong className="text-white">I</strong> info</li>
        <li><strong className="text-white">↑↓</strong> rotate X • <strong className="text-white">←→</strong> rotate Y • <strong className="text-white">Q/E</strong> rotate Z</li>
        <li><strong className="text-white">F</strong> fullscreen • <strong className="text-white">R</strong> reset • <strong className="text-white">ESC</strong> back / exit fullscreen</li>
      </ul>
      {(fileLabel || projectId) && (
        <div className="mt-4 space-y-1 border-t border-white/10 pt-3 text-[11px] text-white/50">
          {projectId && (
            <p>
              <span className="font-semibold text-white/70">Project</span> {projectId}
            </p>
          )}
          {fileLabel && (
            <p className="break-all">
              <span className="font-semibold text-white/70">File</span> {fileLabel}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
