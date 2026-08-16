// Shared Kanban board renderer, used by both index.html (global board) and
// project.html (per-project board, filtered task list passed in by the caller).

export const KANBAN_STATUSES = ['Today', 'In progress', 'This Week', 'Plan soon', 'Backlog', 'On Hold'];

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function cardHtml(t, projectNameFor) {
  const projLabel = t.project ? (projectNameFor ? projectNameFor(t.project) : t.project) : '';
  const activityBadges = (t.activity || [])
    .map(a => `<span class="task-badge task-badge-activity" title="${esc(a)}">${esc(a)}</span>`)
    .join('');
  return `
    <div class="kanban-card" draggable="true" data-id="${esc(t.id)}">
      <span class="kanban-card-title">${esc(t.title)}</span>
      <div class="task-badges">
        ${projLabel ? `<span class="task-badge" title="${esc(projLabel)}">${esc(projLabel)}</span>` : ''}
        ${activityBadges}
        <button class="task-edit-btn" data-id="${esc(t.id)}" title="Edit">&#9998;</button>
      </div>
    </div>
  `;
}

/**
 * Renders a Kanban board of tasks into containerEl. One column per KANBAN_STATUSES entry.
 * Dragging a card into a column calls onDrop(taskId, newStatus); the caller is responsible
 * for the PUT /api/tasks/:id call and re-rendering (or optimistically patching) the board.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.containerEl
 * @param {Array} opts.tasks
 * @param {(projectPath: string) => string} [opts.projectNameFor]
 * @param {(taskId: string, newStatus: string) => void} opts.onDrop
 * @param {(taskId: string) => void} opts.onEdit
 */
export function renderKanbanBoard({ containerEl, tasks, projectNameFor, onDrop, onEdit }) {
  const grouped = {};
  for (const s of KANBAN_STATUSES) grouped[s] = [];
  for (const t of tasks) {
    if (!grouped[t.status]) grouped[t.status] = [];
    grouped[t.status].push(t);
  }

  containerEl.innerHTML = `<div class="kanban-board">${KANBAN_STATUSES.map(status => `
    <div class="kanban-column" data-status="${esc(status)}">
      <div class="kanban-column-header">
        <span>${esc(status)}</span>
        <span class="kanban-column-count">${grouped[status].length}</span>
      </div>
      <div class="kanban-column-body">${grouped[status].map(t => cardHtml(t, projectNameFor)).join('')}</div>
    </div>
  `).join('')}</div>`;

  containerEl.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  containerEl.querySelectorAll('.kanban-column').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (id) onDrop(id, col.dataset.status);
    });
  });

  containerEl.addEventListener('click', e => {
    const btn = e.target.closest('.task-edit-btn');
    if (btn) onEdit(btn.dataset.id);
  });
}
