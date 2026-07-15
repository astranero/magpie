import React from 'react';
import { Edit2, Trash2, PanelRightClose } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Project, View } from '../../types';

interface HeaderProps {
  view: View;
  editingProjectId: string;
  activeProjectId: string;
  projects: Project[];
  confirmDeleteProjectId: string | null;
  setEditingProjectId: (val: string) => void;
  setActiveProjectId: (val: string) => void;
  handleProjectRenameSubmit: (val: string) => void;
  createNewProject: () => void;
  deleteProject: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  view,
  editingProjectId,
  activeProjectId,
  projects,
  confirmDeleteProjectId,
  setEditingProjectId,
  setActiveProjectId,
  handleProjectRenameSubmit,
  createNewProject,
  deleteProject
}) => {
  if (view === 'settings') return null;

  return (
    <header className="card-rule flex items-center px-3.5 py-2.5 bg-card gap-2 shrink-0">
      {editingProjectId ? (
        <input
          autoFocus
          type="text"
          className="flex h-8 w-full rounded-lg border border-primary/50 bg-background px-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15"
          defaultValue={projects.find(p => p.id === activeProjectId)?.title || ''}
          onBlur={(e) => handleProjectRenameSubmit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleProjectRenameSubmit(e.currentTarget.value);
            if (e.key === 'Escape') setEditingProjectId('');
          }}
        />
      ) : (
        <div className="flex items-center flex-1 min-w-0 gap-0.5 rounded-lg hover:bg-accent/70 transition-colors">
          <Select
            value={activeProjectId || ''}
            onValueChange={(val) => {
              if (!val) return;
              if (val === 'new') createNewProject();
              else setActiveProjectId(val as string);
            }}
          >
            <SelectTrigger className="h-8 border-none shadow-none bg-transparent hover:bg-transparent focus:ring-0 p-0 px-2 truncate w-full text-sm font-semibold">
              <SelectValue placeholder="Select a workspace…">
                {projects.find(p => p.id === activeProjectId)?.title || 'Select a workspace…'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="border border-border rounded-lg shadow-card">
              {projects.map(p => (
                <SelectItem key={p.id} value={p.id} className="rounded-md text-sm">{p.title}</SelectItem>
              ))}
              <SelectSeparator className="bg-border" />
              <SelectItem value="new" className="text-primary font-medium rounded-md text-sm">+ New workspace</SelectItem>
            </SelectContent>
          </Select>
          {activeProjectId && (
            <button className="text-muted-foreground hover:text-primary shrink-0 p-2" onClick={() => setEditingProjectId(activeProjectId)} title="Rename Workspace">
              <Edit2 size={14} />
            </button>
          )}
          {activeProjectId && projects.length > 1 && (
            <button
              className={`shrink-0 px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                confirmDeleteProjectId === activeProjectId
                  ? 'text-destructive bg-destructive/10 hover:bg-destructive hover:text-destructive-foreground'
                  : 'text-muted-foreground hover:text-destructive'
              }`}
              onClick={deleteProject}
              title={confirmDeleteProjectId === activeProjectId ? 'Click again to confirm delete' : 'Delete workspace'}
              aria-label={confirmDeleteProjectId === activeProjectId ? 'Confirm workspace deletion' : 'Delete workspace'}
            >
              {confirmDeleteProjectId === activeProjectId ? 'Delete?' : <Trash2 size={14} />}
            </button>
          )}
        </div>
      )}
      {!editingProjectId && (
        <button
          onClick={() => window.close()}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors shrink-0"
          title="Collapse side panel"
          aria-label="Collapse side panel"
        >
          <PanelRightClose size={15} />
        </button>
      )}
    </header>
  );
};
