// ── editor-core.js ────────────────────────────────────────────────────────────
// Shared file tree, tab management, and CRUD logic.
// Consumed by project.html (projects) and editor.html (notebook, ideas, …).
// ─────────────────────────────────────────────────────────────────────────────

// ── SVG icon constants ────────────────────────────────────────────────────────
const FILE_ICON   = `<svg class="nav-tree-icon nav-tree-icon--file" width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M1 2h6l2 2v7H1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M7 2v2h2" stroke="currentColor" stroke-width="1.2"/></svg>`;
const FOLDER_ICON = `<svg class="nav-tree-icon nav-tree-icon--folder" width="13" height="10" viewBox="0 0 13 10" fill="none"><path d="M0.5 2.5h4l1-1.5h7v8h-12z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="currentColor" fill-opacity="0.12"/></svg>`;

// ── Pure helpers ──────────────────────────────────────────────────────────────
export function humanize(str) {
  return str.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function labelForFile(relPath) {
  return humanize(relPath.split('/').pop().replace('.md', ''));
}

// ── Toast UI pane setup ───────────────────────────────────────────────────────
export function setupTuiPane(pane, tab, { markdown, root, savePath }) {
  pane.classList.add('editor-pane-editable');
  pane.innerHTML = '';

  const saveBar = document.createElement('div');
  saveBar.className = 'editor-save-bar';
  saveBar.innerHTML =
    `<span class="editor-save-status">All changes saved</span>` +
    `<button class="editor-save-btn" disabled>Save</button>`;

  const tuiWrap = document.createElement('div');
  tuiWrap.className = 'tui-wrap';

  pane.appendChild(saveBar);
  pane.appendChild(tuiWrap);

  /* global toastui */
  const editor = new toastui.Editor({
    el: tuiWrap,
    initialEditType: 'wysiwyg',
    height: '100%',
    initialValue: '',
    theme: 'dark',
    hideModeSwitch: true,
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['hr', 'quote'],
      ['ul', 'ol', 'task', 'indent', 'outdent'],
      ['table', 'link'],
      ['code', 'codeblock'],
    ],
  });

  editor.setMarkdown(markdown || '');
  pane._tuiEditor = editor;

  const statusEl = saveBar.querySelector('.editor-save-status');
  const saveBtn  = saveBar.querySelector('.editor-save-btn');
  let dirty = false;

  function markDirty() {
    if (dirty) return;
    dirty = true;
    statusEl.textContent = 'Unsaved changes';
    statusEl.classList.add('dirty');
    saveBtn.disabled = false;
    tab.classList.add('tab-dirty');
  }

  function save() {
    fetch('/api/project-file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: savePath, content: editor.getMarkdown() }),
    }).then(r => r.json()).then(d => {
      if (d.error) { alert(d.error); return; }
      dirty = false;
      statusEl.textContent = 'All changes saved';
      statusEl.classList.remove('dirty');
      saveBtn.disabled = true;
      tab.classList.remove('tab-dirty');
    });
  }

  setTimeout(() => editor.on('change', markDirty), 0);
  saveBtn.addEventListener('click', save);
  pane.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (dirty) save(); }
  });
}

// ── Tree builders (private) ───────────────────────────────────────────────────
function buildTree(files) {
  const tree = { dirs: {}, files: [] };
  for (const f of files) {
    if (f.endsWith('/')) {
      const parts = f.slice(0, -1).split('/');
      let node = tree;
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        const rp  = parts.slice(0, i + 1).join('/');
        if (!node.dirs[seg]) node.dirs[seg] = { dirs: {}, files: [], relPath: rp };
        node = node.dirs[seg];
      }
    } else {
      const parts = f.split('/');
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        const rp  = parts.slice(0, i + 1).join('/');
        if (!node.dirs[seg]) node.dirs[seg] = { dirs: {}, files: [], relPath: rp };
        node = node.dirs[seg];
      }
      node.files.push(f);
    }
  }
  return tree;
}

function fileRowHtml(f) {
  return `<div class="file-row" draggable="true" data-file="${f}">` +
    `<button class="checklist-nav-btn file-nav-btn" data-file="${f}">${FILE_ICON}${labelForFile(f)}</button>` +
    `<button class="file-row-delete" data-file="${f}" title="Delete">&#x2715;</button>` +
    `</div>`;
}

function folderHtml(name, node, collapsedFolders) {
  const fp        = node.relPath;
  const collapsed = collapsedFolders.has(fp);
  let h = `<div class="folder-item">`;
  h += `<div class="folder-header" data-folder="${fp}">`;
  h += `<span class="folder-chevron${collapsed ? ' collapsed' : ''}">&#x25BE;</span>`;
  h += FOLDER_ICON;
  h += `<span class="folder-name">${humanize(name)}</span>`;
  h += `<div class="folder-actions">`;
  h += `<button class="folder-action-btn" data-folder="${fp}" data-action="add" title="New file in folder">+</button>`;
  h += `<button class="folder-action-btn" data-folder="${fp}" data-action="delete" title="Delete folder">&#x2715;</button>`;
  h += `</div></div>`;
  h += `<div class="folder-children${collapsed ? ' collapsed' : ''}" data-folder="${fp}">`;
  for (const [n, child] of Object.entries(node.dirs).sort(([a], [b]) => a.localeCompare(b)))
    h += folderHtml(n, child, collapsedFolders);
  for (const f of node.files) h += fileRowHtml(f);
  h += `<div class="inline-new-row" data-new-in="${fp}" hidden>`;
  h += `<input class="proj-new-file-input inline-new-input" data-folder="${fp}" placeholder="filename" autocomplete="off" spellcheck="false" />`;
  h += `</div></div></div>`;
  return h;
}

function renderTreeHtml(tree, collapsedFolders) {
  let h = '';
  for (const [name, child] of Object.entries(tree.dirs).sort(([a], [b]) => a.localeCompare(b)))
    h += folderHtml(name, child, collapsedFolders);
  for (const f of tree.files) h += fileRowHtml(f);
  return h;
}

// ── Main initializer ──────────────────────────────────────────────────────────
export function initEditor({
  root,
  projectPath   = '',
  initialFile   = null,
  // DOM refs
  sidebarEl,
  navEl,
  tabsEl,
  contentEl,
  emptyEl,
  tabsEmptyEl,
  fileAddBtn,
  newFileRow,
  newFileInput,
  folderAddBtn,
  newFolderRow,
  newFolderInput,
  // Optional resize refs
  vResizeHandle = null,
  hResizeHandle = null,
  hResizePanel  = null,
  // Behavior
  onOpenPane,
  autoOpenReadme = false,
}) {
  const filesUrl = projectPath
    ? `/api/project-files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(projectPath)}`
    : `/api/project-files?root=${encodeURIComponent(root)}`;

  const openTabs       = [];
  const collapsedKey   = `project-collapsed:${root}:${projectPath}`;
  const collapsedFolders = new Set(JSON.parse(localStorage.getItem(collapsedKey) || '[]'));

  function saveCollapsed() {
    localStorage.setItem(collapsedKey, JSON.stringify([...collapsedFolders]));
  }

  // ── Tab management ──────────────────────────────────────────────────────────
  function activateTab(relPath) {
    openTabs.forEach(t => {
      const on = t.relPath === relPath;
      t.tabEl.classList.toggle('active', on);
      t.paneEl.classList.toggle('active', on);
    });
    emptyEl.hidden = true;
    tabsEmptyEl.hidden = true;
    navEl.querySelectorAll('.file-nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.file === relPath)
    );
    const t = openTabs.find(t => t.relPath === relPath);
    if (t?.paneEl._tuiEditor) {
      requestAnimationFrame(() => t.paneEl._tuiEditor.setHeight('100%'));
    }
  }

  function closeTab(relPath) {
    const idx = openTabs.findIndex(t => t.relPath === relPath);
    if (idx === -1) return;
    const { tabEl, paneEl } = openTabs[idx];
    const wasActive = tabEl.classList.contains('active');
    tabEl.remove();
    paneEl.remove();
    openTabs.splice(idx, 1);

    if (openTabs.length === 0) {
      emptyEl.hidden = false;
      tabsEmptyEl.hidden = false;
      navEl.querySelectorAll('.file-nav-btn').forEach(b => b.classList.remove('active'));
    } else if (wasActive) {
      activateTab(openTabs[Math.min(idx, openTabs.length - 1)].relPath);
    }
  }

  function openFile(relPath, permanent = false) {
    const existing = openTabs.find(t => t.relPath === relPath);
    if (existing) { activateTab(relPath); return; }

    const tab = document.createElement('button');
    tab.className = 'editor-tab' + (permanent ? ' editor-tab-permanent' : '');
    tab.dataset.file = relPath;
    tab.innerHTML = permanent
      ? `<span class="editor-tab-label">${labelForFile(relPath)}</span>`
      : `<span class="editor-tab-label">${labelForFile(relPath)}</span>` +
        `<span class="editor-tab-close" title="Close">&#x2715;</span>`;

    if (!permanent) {
      tab.querySelector('.editor-tab-close').addEventListener('click', e => {
        e.stopPropagation();
        closeTab(relPath);
      });
    }
    tab.addEventListener('click', () => activateTab(relPath));

    const pane = document.createElement('div');
    pane.className = 'editor-pane';
    pane.innerHTML = '<p class="pane-loading">Loading…</p>';

    tabsEl.appendChild(tab);
    contentEl.appendChild(pane);
    openTabs.push({ relPath, tabEl: tab, paneEl: pane });
    activateTab(relPath);

    const mdPath = projectPath ? `${projectPath}/${relPath}` : relPath;
    fetch(`/api/md?root=${encodeURIComponent(root)}&path=${encodeURIComponent(mdPath)}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          pane.innerHTML = `<p style="color:var(--muted)">${data.error}</p>`;
          return;
        }
        onOpenPane(relPath, data, tab, pane, permanent);
      });
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────
  function deleteFile(relPath) {
    if (!confirm(`Delete "${labelForFile(relPath)}"?\n\nThis cannot be undone.`)) return;
    const fullPath = projectPath ? `${projectPath}/${relPath}` : relPath;
    fetch('/api/project-file', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: fullPath }),
    }).then(r => r.json()).then(data => {
      if (data.error) { alert(data.error); return; }
      closeTab(relPath);
      reloadNav();
    });
  }

  function deleteFolder(folderRelPath) {
    const label = humanize(folderRelPath.split('/').pop());
    if (!confirm(`Delete folder "${label}" and all its contents?\n\nThis cannot be undone.`)) return;
    const fullPath = projectPath ? `${projectPath}/${folderRelPath}` : folderRelPath;
    fetch('/api/project-folder', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: fullPath }),
    }).then(r => r.json()).then(data => {
      if (data.error) { alert(data.error); return; }
      [...openTabs].filter(t => t.relPath.startsWith(folderRelPath + '/')).forEach(t => closeTab(t.relPath));
      reloadNav();
    });
  }

  function moveFile(relPath, targetFolder) {
    const filename   = relPath.split('/').pop();
    const newRelPath = targetFolder ? `${targetFolder}/${filename}` : filename;
    if (relPath === newRelPath) return;
    const fromFull = projectPath ? `${projectPath}/${relPath}` : relPath;
    const toFull   = projectPath ? `${projectPath}/${newRelPath}` : newRelPath;
    const wasOpen  = !!openTabs.find(t => t.relPath === relPath);
    fetch('/api/project-file/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, from: fromFull, to: toFull }),
    }).then(r => r.json()).then(data => {
      if (data.error) { alert(data.error); return; }
      closeTab(relPath);
      reloadNav().then(() => { if (wasOpen) openFile(newRelPath); });
    });
  }

  // ── Nav events ──────────────────────────────────────────────────────────────
  function bindNavEvents(nav) {
    nav.querySelectorAll('.file-nav-btn').forEach(btn =>
      btn.addEventListener('click', () => openFile(btn.dataset.file))
    );
    nav.querySelectorAll('.file-row-delete').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); deleteFile(btn.dataset.file); })
    );

    nav.querySelectorAll('.folder-header').forEach(header => {
      header.addEventListener('click', e => {
        if (e.target.closest('.folder-actions')) return;
        const fp = header.dataset.folder;
        if (collapsedFolders.has(fp)) collapsedFolders.delete(fp); else collapsedFolders.add(fp);
        saveCollapsed();
        header.querySelector('.folder-chevron').classList.toggle('collapsed', collapsedFolders.has(fp));
        nav.querySelector(`.folder-children[data-folder="${CSS.escape(fp)}"]`).classList.toggle('collapsed', collapsedFolders.has(fp));
      });
    });

    nav.querySelectorAll('.folder-action-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const fp = btn.dataset.folder;
        if (btn.dataset.action === 'delete') { deleteFolder(fp); return; }
        if (collapsedFolders.has(fp)) {
          collapsedFolders.delete(fp); saveCollapsed();
          nav.querySelector(`.folder-header[data-folder="${CSS.escape(fp)}"] .folder-chevron`).classList.remove('collapsed');
          nav.querySelector(`.folder-children[data-folder="${CSS.escape(fp)}"]`).classList.remove('collapsed');
        }
        const row = nav.querySelector(`.inline-new-row[data-new-in="${CSS.escape(fp)}"]`);
        if (row) { row.hidden = false; row.querySelector('input').value = ''; row.querySelector('input').focus(); }
      });
    });

    nav.querySelectorAll('.inline-new-input').forEach(input => {
      input.addEventListener('keydown', e => {
        if (e.key === 'Escape') { input.closest('.inline-new-row').hidden = true; return; }
        if (e.key !== 'Enter') return;
        let name = input.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
        if (!name) return;
        if (!name.endsWith('.md')) name += '.md';
        const fp = input.dataset.folder;
        input.closest('.inline-new-row').hidden = true;
        const relPath  = `${fp}/${name}`;
        const fullPath = projectPath ? `${projectPath}/${relPath}` : relPath;
        fetch('/api/project-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root, path: fullPath }),
        }).then(r => r.json()).then(data => {
          if (data.error) { alert(data.error); return; }
          reloadNav().then(() => openFile(relPath));
        });
      });
      input.addEventListener('blur', () => { input.closest('.inline-new-row').hidden = true; });
    });

    // Drag and drop
    nav.querySelectorAll('.file-row').forEach(row => {
      row.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', row.dataset.file);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('drag-source');
        e.stopPropagation();
      });
      row.addEventListener('dragend', () => { row.classList.remove('drag-source'); clearDropHighlights(); });
    });

    nav.querySelectorAll('.folder-header').forEach(header => {
      header.addEventListener('dragover',  e => { e.preventDefault(); e.stopPropagation(); header.classList.add('drop-over'); nav.classList.remove('drop-root'); });
      header.addEventListener('dragleave', e => { if (!header.contains(e.relatedTarget)) header.classList.remove('drop-over'); });
      header.addEventListener('drop',      e => { e.preventDefault(); e.stopPropagation(); clearDropHighlights(); const src = e.dataTransfer.getData('text/plain'); if (src) moveFile(src, header.dataset.folder); });
    });

    nav.addEventListener('dragover',  e => { e.preventDefault(); nav.classList.add('drop-root'); });
    nav.addEventListener('dragleave', e => { if (!nav.contains(e.relatedTarget)) nav.classList.remove('drop-root'); });
    nav.addEventListener('drop',      e => { e.preventDefault(); clearDropHighlights(); const src = e.dataTransfer.getData('text/plain'); if (src) moveFile(src, ''); });

    function clearDropHighlights() {
      nav.classList.remove('drop-root');
      nav.querySelectorAll('.drop-over').forEach(el => el.classList.remove('drop-over'));
    }
  }

  function renderNav(files) {
    const navFiles = files.filter(f => f.toLowerCase() !== 'readme.md').sort((a, b) => a.localeCompare(b));
    navEl.innerHTML = renderTreeHtml(buildTree(navFiles), collapsedFolders);
    bindNavEvents(navEl);
  }

  function reloadNav() {
    return fetch(filesUrl).then(r => r.json()).then(renderNav);
  }

  // ── New file / folder inputs ────────────────────────────────────────────────
  fileAddBtn.addEventListener('click', () => {
    newFileRow.hidden = false;
    newFileInput.value = '';
    newFileInput.focus();
  });

  newFileInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { newFileRow.hidden = true; return; }
    if (e.key !== 'Enter') return;
    let name = newFileInput.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
    if (!name) return;
    if (!name.endsWith('.md')) name += '.md';
    newFileRow.hidden = true;
    const fullPath = projectPath ? `${projectPath}/${name}` : name;
    fetch('/api/project-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: fullPath }),
    }).then(r => r.json()).then(data => {
      if (data.error) { alert(data.error); return; }
      reloadNav().then(() => openFile(name));
    });
  });
  newFileInput.addEventListener('blur', () => { newFileRow.hidden = true; });

  folderAddBtn.addEventListener('click', () => {
    newFolderRow.hidden = false;
    newFolderInput.value = '';
    newFolderInput.focus();
  });

  newFolderInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { newFolderRow.hidden = true; return; }
    if (e.key !== 'Enter') return;
    let name = newFolderInput.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
    if (!name) return;
    newFolderRow.hidden = true;
    const fullPath = projectPath ? `${projectPath}/${name}` : name;
    fetch('/api/project-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: fullPath }),
    }).then(r => r.json()).then(data => {
      if (data.error) { alert(data.error); return; }
      reloadNav();
    });
  });
  newFolderInput.addEventListener('blur', () => { newFolderRow.hidden = true; });

  // ── Vertical resize: sidebar ↔ editor ──────────────────────────────────────
  if (vResizeHandle && sidebarEl) {
    const savedW = localStorage.getItem('project:sidebar-width');
    if (savedW) sidebarEl.style.width = savedW;

    let vDrag = false, vX0 = 0, vW0 = 0;
    vResizeHandle.addEventListener('mousedown', e => {
      vDrag = true; vX0 = e.clientX; vW0 = sidebarEl.getBoundingClientRect().width;
      vResizeHandle.classList.add('dragging'); e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!vDrag) return;
      sidebarEl.style.width = `${Math.max(160, Math.min(vW0 + (e.clientX - vX0), 480))}px`;
    });
    document.addEventListener('mouseup', () => {
      if (vDrag) {
        vDrag = false; vResizeHandle.classList.remove('dragging');
        localStorage.setItem('project:sidebar-width', sidebarEl.style.width);
      }
    });
  }

  // ── Horizontal resize: files panel ↕ tasks panel ───────────────────────────
  if (hResizeHandle && hResizePanel && sidebarEl) {
    const savedH = localStorage.getItem('project:files-panel-height');
    if (savedH) hResizePanel.style.flex = `0 0 ${savedH}`;

    let hDrag = false, hY0 = 0, hH0 = 0;
    hResizeHandle.addEventListener('mousedown', e => {
      hDrag = true; hY0 = e.clientY; hH0 = hResizePanel.getBoundingClientRect().height;
      hResizeHandle.classList.add('dragging'); e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!hDrag) return;
      const sH   = sidebarEl.getBoundingClientRect().height;
      const hH   = hResizeHandle.getBoundingClientRect().height;
      const minH = 60;
      hResizePanel.style.flex = `0 0 ${Math.max(minH, Math.min(hH0 + (e.clientY - hY0), sH - hH - minH))}px`;
    });
    document.addEventListener('mouseup', () => {
      if (hDrag) {
        hDrag = false; hResizeHandle.classList.remove('dragging');
        localStorage.setItem('project:files-panel-height', hResizePanel.getBoundingClientRect().height + 'px');
      }
    });
  }

  // ── Initial load ────────────────────────────────────────────────────────────
  fetch(filesUrl)
    .then(r => r.json())
    .then(files => {
      const readmeFile = files.find(f => f.toLowerCase() === 'readme.md');
      if (readmeFile && autoOpenReadme) openFile(readmeFile, true);
      renderNav(files);
      if (initialFile && initialFile.toLowerCase() !== 'readme.md') openFile(initialFile);
    });

  return { openFile, reloadNav, activateTab, closeTab };
}
