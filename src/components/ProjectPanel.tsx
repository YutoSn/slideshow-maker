import type { ProjectSummary } from '../engine/projectStore';

interface Props {
  name: string;
  projects: ProjectSummary[];
  currentId: string | null;
  /** 保存待ち／保存済みの表示 */
  status: 'idle' | 'saving' | 'saved' | 'error';
  savedAt: number | null;
  canSave: boolean;
  usage: { usedMb: number; quotaMb: number } | null;
  onNameChange: (name: string) => void;
  onSave: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return 'たった今';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 時間前`;
  return `${Math.round(hours / 24)} 日前`;
}

const STATUS_LABEL: Record<Props['status'], string> = {
  idle: '',
  saving: '保存中…',
  saved: '保存しました',
  error: '保存できませんでした',
};

export default function ProjectPanel({
  name,
  projects,
  currentId,
  status,
  savedAt,
  canSave,
  usage,
  onNameChange,
  onSave,
  onOpen,
  onDelete,
  onNew,
}: Props) {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>プロジェクト</h2>
        <span className="muted">
          {status !== 'idle'
            ? STATUS_LABEL[status]
            : savedAt
              ? `${relativeTime(savedAt)}に保存`
              : '未保存'}
        </span>
      </div>

      <label className="field">
        <span>名前</span>
        <input
          type="text"
          value={name}
          placeholder="例：2026 夏休み"
          onChange={(e) => onNameChange(e.target.value)}
        />
      </label>

      <div className="row">
        <button type="button" className="primary" onClick={onSave} disabled={!canSave}>
          保存
        </button>
        <button type="button" onClick={onNew}>
          新しく始める
        </button>
      </div>

      {!canSave && (
        <p className="muted" style={{ marginTop: 8 }}>
          写真か音源を読み込むと保存できます
        </p>
      )}

      {projects.length > 0 && (
        <div className="projects">
          <h3>保存したプロジェクト</h3>
          <ul>
            {projects.map((project) => (
              <li key={project.id} className={project.id === currentId ? 'projects--current' : ''}>
                <button
                  type="button"
                  className="projects__open"
                  onClick={() => onOpen(project.id)}
                  title={`${project.name} を開く`}
                >
                  <span className="projects__name">{project.name}</span>
                  <span className="projects__meta">
                    写真 {project.photoCount} 枚
                    {project.audioName ? ` ／ ${project.audioName}` : ''} ／{' '}
                    {relativeTime(project.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="projects__delete"
                  onClick={() => onDelete(project.id)}
                  aria-label={`${project.name} を削除`}
                  title="削除"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {usage && usage.quotaMb > 0 && (
        <p className="muted" style={{ marginTop: 10 }}>
          保存領域 {usage.usedMb.toFixed(0)}MB / {usage.quotaMb.toFixed(0)}MB
        </p>
      )}
    </section>
  );
}
